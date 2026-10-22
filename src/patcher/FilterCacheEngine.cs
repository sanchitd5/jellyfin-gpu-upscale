using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Data;
using System.Data.Common;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Plus.Patcher
{
    /// <summary>
    /// A cache of the library filter keys (tags, genres, production years, official ratings) in two
    /// plugin-owned tables inside Jellyfin's own SQLite database, so that GET /Items/Filters and
    /// /Items/Filters2 stop recomputing them per request.
    ///
    /// WHY. Stock recomputes, on every request, the access-filtered matching-item subquery joined to
    /// ItemValuesMap and grouped (BaseItemRepository.GetQueryFiltersLegacy / GetTagNames): 4-7 s on a
    /// library of ~47k items with ~12k distinct tags.
    ///
    /// THE TABLES (raw SQL, created with CREATE TABLE IF NOT EXISTS; Jellyfin's EF model, migrations
    /// and own tables are never touched):
    ///   JellyfinPlus_FilterKeys(LibraryId, Kind, ItemType, CleanValue, Value, ItemCount, RefId)
    ///     one row per distinct key per library per item type. LibraryId is the item TopParentId (the
    ///     physical library folder), the value the stock query scopes on. ItemType is part of the key
    ///     so a request with includeItemTypes is answered by a union over the requested types, instead of
    ///     caching one answer per type combination.
    ///   JellyfinPlus_FilterKeysMeta(LibraryId, Kind, BuiltAtUtc, SourceItemCount, KeyCount, Fingerprint)
    ///
    /// FRESHNESS IS CHECKED, NOT ASSUMED. A library's fingerprint is its row count plus the newest
    /// DateLastSaved of its items (LibraryManager.UpdateItemsAsync stamps it on every save, which is also
    /// how the bulk tag editor writes). It is compared on every request that would be served from the
    /// cache; any difference means "stale" and the request falls through to stock. Events and the scan
    /// only decide WHEN to rebuild; correctness never depends on having seen an event. (Cost: one
    /// count/max over the library's rows, measured in the harness.)
    ///
    /// WHAT IS CACHED. The same set of items stock aggregates: Jellyfin's own TranslateQuery is called
    /// with TopParentIds = [library] and nothing else, so the "countable item" rules (alternate versions
    /// hidden behind their primary, owned non-extras excluded) are stock's own, not a copy.
    /// </summary>
    internal static class FilterCacheEngine
    {
        internal const string KeysTable = "JellyfinPlus_FilterKeys";
        internal const string MetaTable = "JellyfinPlus_FilterKeysMeta";

        /// <summary>Quiet period after the last library change before stale libraries are rebuilt.</summary>
        internal static readonly TimeSpan DebounceDelay = TimeSpan.FromSeconds(30);

        /// <summary>Shorter delay used when a request found the cache stale or missing (heals the next ones).</summary>
        internal static readonly TimeSpan HealDelay = TimeSpan.FromSeconds(3);

        /// <summary>The longest a continuously changing library waits for a rebuild (the debounce is capped by it).</summary>
        internal static readonly TimeSpan MaxWait = TimeSpan.FromMinutes(5);

        /// <summary>
        /// A stale cache (the library changed since it was built) is still served while it is younger than this
        /// (stale-while-revalidate), and a rebuild is scheduled. Staleness only ever means a just-added value can
        /// be missing for a while; every permission check stays live per request.
        /// </summary>
        internal static readonly TimeSpan MaxStaleAge = TimeSpan.FromMinutes(30);

        internal enum Kind
        {
            Tag = 1,
            Genre = 2,
            Year = 3,
            Rating = 4,

            /// <summary>The Genre entity behind a genre value (Id and display name), for /Items/Filters2.</summary>
            GenreEntity = 5,
        }

        private static readonly Kind[] _allKinds = { Kind.Tag, Kind.Genre, Kind.Year, Kind.Rating, Kind.GenreEntity };

        private static readonly object _gate = new object();
        private static readonly SemaphoreSlim _buildLock = new SemaphoreSlim(1, 1);
        private static readonly ConcurrentDictionary<string, long> _outcomes = new ConcurrentDictionary<string, long>();

        private static ILogger _log;
        private static ILibraryManager _libs;
        private static IDbContextFactory<JellyfinDbContext> _factory;
        private static IItemTypeLookup _lookup;
        private static Func<IQueryable<BaseItemEntity>, JellyfinDbContext, InternalItemsQuery, IQueryable<BaseItemEntity>> _translate;
        private static Timer _debounce;
        private static bool _subscribed;
        private static volatile bool _schemaReady;
        private static long _lastHealTicks;

        // Progress of the run in flight (or the last one), for the status endpoint.
        private static volatile string _runState = "idle";
        private static string _currentLibrary = string.Empty;
        private static int _libraryIndex;
        private static int _libraryTotal;
        private static string _lastError;
        private static DateTime? _lastStartedUtc;
        private static DateTime? _lastFinishedUtc;

        /// <summary>True once the services were resolved and the tables exist.</summary>
        internal static bool Ready => !Disabled && _schemaReady && _factory != null && _translate != null && _lookup != null
            && (_libs != null || _libraryOverride != null);

        /// <summary>Turns the cache off without unpatching (the harness uses it to run stock for comparison).</summary>
        internal static bool Disabled { get; set; }

        // Library questions the harness answers itself (a real LibraryManager needs a whole server).
        private static Func<List<(Guid Id, string Name)>> _libraryOverride;
        private static Func<Jellyfin.Database.Implementations.Entities.User, HashSet<Guid>> _accessOverride;
        private static Func<Guid> _rootOverride;

        /// <summary>The physical library folders the user can open (CollectionFolder.IsVisible), as TopParentIds.</summary>
        internal static HashSet<Guid> AccessibleFolders(Jellyfin.Database.Implementations.Entities.User user)
            => _accessOverride != null
                ? _accessOverride(user)
                : _libs.GetUserRootFolder().Children
                    .OfType<CollectionFolder>()
                    .Where(c => c.IsVisible(user))
                    .SelectMany(c => c.PhysicalFolderIds)
                    .ToHashSet();

        /// <summary>The id of the user root folder, which an unscoped /Items/Filters query uses as its only ancestor.</summary>
        internal static Guid UserRootId() => _rootOverride != null ? _rootOverride() : _libs.GetUserRootFolder().Id;

        /// <summary>Harness entry: wires the engine to a database and fake library answers, bypassing DI.</summary>
        internal static void InitForTest(
            IDbContextFactory<JellyfinDbContext> factory,
            IItemTypeLookup lookup,
            Func<IQueryable<BaseItemEntity>, JellyfinDbContext, InternalItemsQuery, IQueryable<BaseItemEntity>> translate,
            Func<List<(Guid Id, string Name)>> libraries,
            Func<Jellyfin.Database.Implementations.Entities.User, HashSet<Guid>> access,
            Func<Guid> rootId)
        {
            _factory = factory;
            _lookup = lookup;
            _translate = translate;
            _libraryOverride = libraries;
            _accessOverride = access;
            _rootOverride = rootId;
            EnsureSchema();
        }

        internal static ILogger Log => _log;

        // ---------------------------------------------------------------- lifecycle

        /// <summary>
        /// Resolves everything the cache needs from the server's service provider, creates the tables and
        /// subscribes to library changes. Idempotent; never throws (a failure leaves the cache off).
        /// </summary>
        public static void Start(IServiceProvider services, ILogger logger)
        {
            try
            {
                lock (_gate)
                {
                    _log = logger ?? _log;
                    if (_factory == null)
                    {
                        _libs = services.GetRequiredService<ILibraryManager>();
                        _factory = services.GetRequiredService<IDbContextFactory<JellyfinDbContext>>();
                        _lookup = services.GetRequiredService<IItemTypeLookup>();
                        var repo = services.GetRequiredService<IItemRepository>();
                        var m = repo.GetType().GetMethod(
                            "TranslateQuery",
                            new[] { typeof(IQueryable<BaseItemEntity>), typeof(JellyfinDbContext), typeof(InternalItemsQuery) });
                        if (m == null)
                        {
                            throw new MissingMethodException("BaseItemRepository.TranslateQuery(IQueryable<BaseItemEntity>, JellyfinDbContext, InternalItemsQuery)");
                        }

                        _translate = (Func<IQueryable<BaseItemEntity>, JellyfinDbContext, InternalItemsQuery, IQueryable<BaseItemEntity>>)
                            Delegate.CreateDelegate(typeof(Func<IQueryable<BaseItemEntity>, JellyfinDbContext, InternalItemsQuery, IQueryable<BaseItemEntity>>), repo, m);
                    }

                    if (!_subscribed)
                    {
                        _debounce = new Timer(_ => RunBackground(false), null, Timeout.Infinite, Timeout.Infinite);
                        _libs.ItemAdded += OnChanged;
                        _libs.ItemUpdated += OnChanged;
                        _libs.ItemRemoved += OnChanged;
                        _subscribed = true;
                    }
                }

                EnsureSchema();
                _log?.LogInformation("JellyfinPlus: filter key cache ready (tables {Keys}, {Meta})", KeysTable, MetaTable);
            }
            catch (Exception ex)
            {
                _schemaReady = false;
                _log?.LogWarning(ex, "JellyfinPlus: the filter key cache could not start; /Items/Filters is served by stock.");
            }
        }

        public static void Stop()
        {
            lock (_gate)
            {
                if (_subscribed && _libs != null)
                {
                    _libs.ItemAdded -= OnChanged;
                    _libs.ItemUpdated -= OnChanged;
                    _libs.ItemRemoved -= OnChanged;
                }

                _subscribed = false;
                _debounce?.Dispose();
                _debounce = null;
            }
        }

        // TickCount64 of the first change not yet handed to a rebuild; 0 when none is waiting.
        private static long _pendingSinceTicks;

        /// <summary>
        /// A library change: rebuild after a quiet period, but never later than <see cref="MaxWait"/> after the
        /// first unhandled change. Without the cap a library that is scanned continuously (an item every few
        /// seconds) would keep resetting the debounce and never rebuild.
        /// </summary>
        private static void OnChanged(object sender, ItemChangeEventArgs e) => ScheduleDebounced();

        private static void ScheduleDebounced()
        {
            var now = Environment.TickCount64;
            var since = Interlocked.CompareExchange(ref _pendingSinceTicks, now, 0);
            if (since == 0)
            {
                since = now;
            }

            Schedule(NextDelay(since, now));
        }

        /// <summary>Debounce delay for a change when the first unhandled one was at <paramref name="sinceMs"/> (TickCount64 ms).</summary>
        internal static TimeSpan NextDelay(long sinceMs, long nowMs)
        {
            var untilMax = sinceMs + (long)MaxWait.TotalMilliseconds - nowMs;
            return TimeSpan.FromMilliseconds(Math.Max(0, Math.Min((long)DebounceDelay.TotalMilliseconds, untilMax)));
        }

        private static void Schedule(TimeSpan delay)
        {
            try
            {
                _debounce?.Change(delay, Timeout.InfiniteTimeSpan);
            }
            catch (ObjectDisposedException)
            {
            }
        }

        /// <summary>Called when a request found the cache stale or unbuilt: rebuild soon, at most once a minute.</summary>
        internal static void RequestHeal()
        {
            var now = Environment.TickCount64;
            var last = Interlocked.Read(ref _lastHealTicks);
            if (_runState == "running" || (last != 0 && now - last < 60_000))
            {
                return;
            }

            Interlocked.Exchange(ref _lastHealTicks, now);
            Schedule(HealDelay);
        }

        private static void RunBackground(bool force)
        {
            Interlocked.Exchange(ref _pendingSinceTicks, 0);
            _ = Task.Run(() =>
            {
                try
                {
                    // A run already in flight started from an older state of the library; look again afterwards
                    // rather than dropping this request.
                    if (!Rebuild(force, null, CancellationToken.None, waitForLock: false))
                    {
                        ScheduleDebounced();
                    }
                }
                catch (Exception ex)
                {
                    _log?.LogWarning(ex, "JellyfinPlus: background filter cache rebuild failed.");
                }
            });
        }

        /// <summary>Starts a rebuild without waiting for it. False when one is already running.</summary>
        public static bool StartBackground(bool force)
        {
            if (!Ready || _buildLock.CurrentCount == 0)
            {
                return false;
            }

            RunBackground(force);
            return true;
        }

        public static Task RebuildAsync(bool force, IProgress<double> progress, CancellationToken ct)
            => Task.Run(() => Rebuild(force, progress, ct, waitForLock: true), ct);

        // ---------------------------------------------------------------- schema

        private static void EnsureSchema()
        {
            using var db = _factory.CreateDbContext();
            db.Database.OpenConnection();
            var conn = db.Database.GetDbConnection();
            Exec(conn, null, "CREATE TABLE IF NOT EXISTS " + KeysTable + " ("
                + "LibraryId TEXT NOT NULL, Kind INTEGER NOT NULL, ItemType TEXT NOT NULL, CleanValue TEXT NOT NULL, "
                + "Value TEXT NOT NULL, ItemCount INTEGER NOT NULL, RefId TEXT NULL, "
                + "PRIMARY KEY (LibraryId, Kind, ItemType, CleanValue)) WITHOUT ROWID");
            Exec(conn, null, "CREATE TABLE IF NOT EXISTS " + MetaTable + " ("
                + "LibraryId TEXT NOT NULL, Kind INTEGER NOT NULL, BuiltAtUtc TEXT NOT NULL, SourceItemCount INTEGER NOT NULL, "
                + "KeyCount INTEGER NOT NULL, Fingerprint TEXT NOT NULL, PRIMARY KEY (LibraryId, Kind)) WITHOUT ROWID");
            _schemaReady = true;
        }

        // ---------------------------------------------------------------- libraries and fingerprints

        /// <summary>The physical library folders (the items' TopParentId) with the name of their library.</summary>
        internal static List<(Guid Id, string Name)> PhysicalLibraries()
        {
            if (_libraryOverride != null)
            {
                return _libraryOverride();
            }

            var list = new List<(Guid, string)>();
            foreach (var cf in _libs.GetUserRootFolder().Children.OfType<CollectionFolder>())
            {
                foreach (var id in cf.PhysicalFolderIds)
                {
                    if (!list.Any(x => x.Item1 == id))
                    {
                        list.Add((id, cf.Name));
                    }
                }
            }

            return list;
        }

        private static string Id(Guid g) => g.ToString("D", CultureInfo.InvariantCulture);

        /// <summary>"count|newest DateLastSaved ticks" of each library's rows, "0|0" for an empty one.</summary>
        internal static Dictionary<Guid, string> Fingerprints(JellyfinDbContext db, Guid[] libs)
        {
            var map = libs.ToDictionary(l => l, _ => "0|0");
            if (libs.Length == 0)
            {
                return map;
            }

            // Raw SQL, same meaning as the EF GroupBy/Count/Max it replaces, but ~40% cheaper (no EF
            // translation or materialisation) and it uses IX_BaseItems_TopParentId_Id. EF stores Guids as
            // UPPERCASE text and DateTime as "yyyy-MM-dd HH:mm:ss.fffffff" text, so MAX is a text max.
            var conn = db.Database.GetDbConnection();
            using var c = conn.CreateCommand();
            var names = new List<string>();
            for (var i = 0; i < libs.Length; i++)
            {
                names.Add("@l" + i);
                AddParam(c, "@l" + i, libs[i].ToString("D", CultureInfo.InvariantCulture).ToUpperInvariant());
            }

            c.CommandText = "SELECT TopParentId, COUNT(*), MAX(DateLastSaved) FROM BaseItems WHERE TopParentId IN ("
                + string.Join(",", names) + ") GROUP BY TopParentId";
            using var r = c.ExecuteReader();
            while (r.Read())
            {
                var max = r.IsDBNull(2)
                    ? 0L
                    : DateTime.Parse(r.GetString(2), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind).Ticks;
                map[Guid.Parse(r.GetString(0))] = r.GetInt32(1).ToString(CultureInfo.InvariantCulture) + "|" + max.ToString(CultureInfo.InvariantCulture);
            }

            return map;
        }

        /// <summary>The Genre entities' own fingerprint (they are not in any library, but /Items/Filters2 returns them).</summary>
        private static string GenreFingerprint(JellyfinDbContext db)
        {
            var genreType = _lookup.BaseItemKindNames[BaseItemKind.Genre];
            var r = db.BaseItems
                .AsNoTracking()
                .Where(e => e.Type == genreType)
                .GroupBy(e => 1)
                .Select(g => new { N = g.Count(), Max = g.Max(e => e.DateLastSaved) })
                .FirstOrDefault();
            return r == null ? "0|0" : r.N.ToString(CultureInfo.InvariantCulture) + "|" + (r.Max?.Ticks ?? 0).ToString(CultureInfo.InvariantCulture);
        }

        private static string FingerprintFor(Kind kind, string library, string genres)
            => kind == Kind.GenreEntity ? library + "|g" + genres : library;

        // ---------------------------------------------------------------- rebuild

        private readonly record struct KeyRow(Kind Kind, string ItemType, string Clean, string Value, int Count, string RefId);

        /// <summary>
        /// Rebuilds the libraries whose fingerprint no longer matches what was cached (all of them when
        /// <paramref name="force"/>). One transaction per library, so readers see the old rows or the new
        /// ones, never a mixture.
        /// </summary>
        internal static bool Rebuild(bool force, IProgress<double> progress, CancellationToken ct, bool waitForLock)
        {
            if (waitForLock)
            {
                _buildLock.Wait(ct);
            }
            else if (!_buildLock.Wait(0, ct))
            {
                return false;
            }

            try
            {
                _runState = "running";
                _lastStartedUtc = DateTime.UtcNow;
                _lastError = null;
                if (_factory == null || (_libs == null && _libraryOverride == null))
                {
                    throw new InvalidOperationException("the filter key cache was not started");
                }

                // Every run, not only the first: the statement is a no-op when the tables exist, and it
                // heals them if they were ever dropped (a restore, a hand-edited database).
                EnsureSchema();

                var libraries = PhysicalLibraries();
                _libraryTotal = libraries.Count;
                var built = 0;
                for (var i = 0; i < libraries.Count; i++)
                {
                    ct.ThrowIfCancellationRequested();
                    _libraryIndex = i + 1;
                    _currentLibrary = libraries[i].Name;
                    progress?.Report(100.0 * i / Math.Max(1, libraries.Count));
                    if (BuildLibrary(libraries[i].Id, libraries[i].Name, force))
                    {
                        built++;
                    }
                }

                // Rows of libraries that no longer exist.
                PurgeUnknown(libraries.Select(l => l.Id).ToArray());
                progress?.Report(100);
                _log?.LogInformation("JellyfinPlus: filter key cache: {Built} of {Total} libraries rebuilt{Forced}", built, libraries.Count, force ? " (forced)" : string.Empty);
                return true;
            }
            catch (OperationCanceledException)
            {
                _lastError = "cancelled";
                throw;
            }
            catch (Exception ex)
            {
                _lastError = ex.Message;
                _log?.LogWarning(ex, "JellyfinPlus: filter key cache rebuild failed; stock serves /Items/Filters until it succeeds.");
                throw;
            }
            finally
            {
                _currentLibrary = string.Empty;
                _lastFinishedUtc = DateTime.UtcNow;
                _runState = "idle";
                _buildLock.Release();
            }
        }

        /// <summary>Rebuilds one library when stale (or forced). True when it was rebuilt.</summary>
        private static bool BuildLibrary(Guid lib, string name, bool force)
        {
            using var db = _factory.CreateDbContext();
            db.Database.OpenConnection();
            var conn = db.Database.GetDbConnection();

            // The fingerprint is taken BEFORE the aggregates: a change racing the build leaves the stored
            // fingerprint older than the data, so the next check calls it stale and rebuilds. Safe direction.
            var libFp = Fingerprints(db, new[] { lib })[lib];
            var genreFp = GenreFingerprint(db);
            var stored = ReadMeta(conn, new[] { lib });
            var upToDate = !force && _allKinds.All(k =>
                stored.TryGetValue((lib, k), out var m) && m.Fingerprint == FingerprintFor(k, libFp, genreFp));
            if (upToDate)
            {
                return false;
            }

            var started = DateTime.UtcNow;
            var items = _translate(db.BaseItems.AsNoTracking(), db, new InternalItemsQuery { TopParentIds = new[] { lib } });
            var rows = new List<KeyRow>();

            // One set-based aggregate per kind. Projected before grouping (see GetTagNames in stock: grouping
            // over the ItemValue navigation makes EF resolve the aggregate per group, orders of magnitude slower).
            ItemValuesRows(db, items, ItemValueType.Tags, Kind.Tag, rows);
            var genreStart = rows.Count;
            ItemValuesRows(db, items, ItemValueType.Genre, Kind.Genre, rows);

            foreach (var g in items
                .Where(e => e.ProductionYear != null && e.ProductionYear > 0)
                .GroupBy(e => new { e.Type, e.ProductionYear })
                .Select(g => new { g.Key.Type, g.Key.ProductionYear, N = g.Count() })
                .ToList())
            {
                var y = g.ProductionYear.Value.ToString(CultureInfo.InvariantCulture);
                rows.Add(new KeyRow(Kind.Year, g.Type, y, y, g.N, null));
            }

            foreach (var g in items
                .Where(e => e.OfficialRating != null && e.OfficialRating != string.Empty)
                .GroupBy(e => new { e.Type, e.OfficialRating })
                .Select(g => new { g.Key.Type, g.Key.OfficialRating, N = g.Count() })
                .ToList())
            {
                rows.Add(new KeyRow(Kind.Rating, g.Type, g.OfficialRating, g.OfficialRating, g.N, null));
            }

            // The Genre entity behind each genre value (Id + name), which /Items/Filters2 returns. Only values
            // with an entity are listed, as stock does (it lists Genre items that have an item behind them).
            var genreType = _lookup.BaseItemKindNames[BaseItemKind.Genre];
            var entities = db.BaseItems
                .AsNoTracking()
                .Where(e => e.Type == genreType && e.CleanName != null)
                .Select(e => new { e.Id, e.CleanName, e.Name })
                .ToList()
                .GroupBy(e => e.CleanName)
                .ToDictionary(g => g.Key, g => g.OrderBy(x => x.Id).First());
            for (var i = genreStart; i < rows.Count && rows[i].Kind == Kind.Genre; i++)
            {
                if (entities.TryGetValue(rows[i].Clean, out var ent))
                {
                    rows.Add(new KeyRow(Kind.GenreEntity, rows[i].ItemType, rows[i].Clean, ent.Name ?? rows[i].Value, rows[i].Count, Id(ent.Id)));
                }
            }

            var sourceCount = int.Parse(libFp.Split('|')[0], CultureInfo.InvariantCulture);
            WriteLibrary(conn, lib, rows, sourceCount, libFp, genreFp);
            _log?.LogInformation(
                "JellyfinPlus: filter key cache: library '{Library}' rebuilt in {Ms} ms ({Keys} keys from {Items} items)",
                name,
                (int)(DateTime.UtcNow - started).TotalMilliseconds,
                rows.Count,
                sourceCount);
            return true;
        }

        private static void ItemValuesRows(JellyfinDbContext db, IQueryable<BaseItemEntity> items, ItemValueType type, Kind kind, List<KeyRow> rows)
        {
            var values = db.ItemValues.Where(v => v.Type == type);
            var grouped = db.ItemValuesMap
                .AsNoTracking()
                .Join(items, m => m.ItemId, e => e.Id, (m, e) => new { m.ItemValueId, e.Type, ItemId = e.Id })
                .Join(values, x => x.ItemValueId, v => v.ItemValueId, (x, v) => new { x.Type, v.CleanValue, v.Value, x.ItemId })
                .GroupBy(r => new { r.Type, r.CleanValue })
                .Select(g => new { g.Key.Type, g.Key.CleanValue, Value = g.Min(r => r.Value), N = g.Select(r => r.ItemId).Distinct().Count() })
                .ToList();
            foreach (var g in grouped)
            {
                rows.Add(new KeyRow(kind, g.Type, g.CleanValue, g.Value, g.N, null));
            }
        }

        private static void WriteLibrary(DbConnection conn, Guid lib, List<KeyRow> rows, int sourceCount, string libFp, string genreFp)
        {
            // Raw ADO bypasses Jellyfin's own write-retry policy, so a busy database is retried here.
            for (var attempt = 0; ; attempt++)
            {
                try
                {
                    using var tx = conn.BeginTransaction();
                    var lid = Id(lib);
                    Exec(conn, tx, "DELETE FROM " + KeysTable + " WHERE LibraryId = @l", ("@l", lid));
                    Exec(conn, tx, "DELETE FROM " + MetaTable + " WHERE LibraryId = @l", ("@l", lid));

                    using (var ins = conn.CreateCommand())
                    {
                        ins.Transaction = tx;
                        ins.CommandText = "INSERT OR REPLACE INTO " + KeysTable
                            + " (LibraryId, Kind, ItemType, CleanValue, Value, ItemCount, RefId) VALUES (@l, @k, @t, @c, @v, @n, @r)";
                        var p = new Dictionary<string, DbParameter>();
                        foreach (var name in new[] { "@l", "@k", "@t", "@c", "@v", "@n", "@r" })
                        {
                            var prm = ins.CreateParameter();
                            prm.ParameterName = name;
                            ins.Parameters.Add(prm);
                            p[name] = prm;
                        }

                        p["@l"].Value = lid;
                        foreach (var r in rows)
                        {
                            p["@k"].Value = (int)r.Kind;
                            p["@t"].Value = r.ItemType ?? string.Empty;
                            p["@c"].Value = r.Clean ?? string.Empty;
                            p["@v"].Value = r.Value ?? string.Empty;
                            p["@n"].Value = r.Count;
                            p["@r"].Value = (object)r.RefId ?? DBNull.Value;
                            ins.ExecuteNonQuery();
                        }
                    }

                    var now = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
                    foreach (var k in _allKinds)
                    {
                        Exec(
                            conn,
                            tx,
                            "INSERT INTO " + MetaTable + " (LibraryId, Kind, BuiltAtUtc, SourceItemCount, KeyCount, Fingerprint) VALUES (@l, @k, @b, @s, @n, @f)",
                            ("@l", lid),
                            ("@k", (int)k),
                            ("@b", now),
                            ("@s", sourceCount),
                            ("@n", rows.Count(r => r.Kind == k)),
                            ("@f", FingerprintFor(k, libFp, genreFp)));
                    }

                    tx.Commit();
                    return;
                }
                catch (DbException ex) when (attempt < 6 && IsBusy(ex))
                {
                    Thread.Sleep(250 * (attempt + 1));
                }
            }
        }

        private static bool IsBusy(DbException ex)
            => ex.Message.Contains("locked", StringComparison.OrdinalIgnoreCase) || ex.Message.Contains("busy", StringComparison.OrdinalIgnoreCase);

        private static void PurgeUnknown(Guid[] known)
        {
            using var db = _factory.CreateDbContext();
            db.Database.OpenConnection();
            var conn = db.Database.GetDbConnection();
            var have = new List<string>();
            using (var c = conn.CreateCommand())
            {
                c.CommandText = "SELECT DISTINCT LibraryId FROM " + MetaTable;
                using var r = c.ExecuteReader();
                while (r.Read())
                {
                    have.Add(r.GetString(0));
                }
            }

            var keep = known.Select(Id).ToHashSet(StringComparer.OrdinalIgnoreCase);
            foreach (var gone in have.Where(h => !keep.Contains(h)))
            {
                Exec(conn, null, "DELETE FROM " + KeysTable + " WHERE LibraryId = @l", ("@l", gone));
                Exec(conn, null, "DELETE FROM " + MetaTable + " WHERE LibraryId = @l", ("@l", gone));
            }
        }

        // ---------------------------------------------------------------- reading

        internal readonly record struct Meta(DateTime BuiltAtUtc, int SourceItemCount, int KeyCount, string Fingerprint);

        private static Dictionary<(Guid, Kind), Meta> ReadMeta(DbConnection conn, Guid[] libs)
        {
            var map = new Dictionary<(Guid, Kind), Meta>();
            using var c = conn.CreateCommand();
            var names = new List<string>();
            for (var i = 0; i < libs.Length; i++)
            {
                names.Add("@l" + i);
                AddParam(c, "@l" + i, Id(libs[i]));
            }

            c.CommandText = "SELECT LibraryId, Kind, BuiltAtUtc, SourceItemCount, KeyCount, Fingerprint FROM " + MetaTable
                + " WHERE LibraryId IN (" + string.Join(",", names) + ")";
            using var r = c.ExecuteReader();
            while (r.Read())
            {
                map[(Guid.Parse(r.GetString(0)), (Kind)r.GetInt32(1))] = new Meta(
                    DateTime.Parse(r.GetString(2), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind),
                    r.GetInt32(3),
                    r.GetInt32(4),
                    r.GetString(5));
            }

            return map;
        }

        internal enum Freshness
        {
            /// <summary>Built, and the libraries have not changed since.</summary>
            Fresh,

            /// <summary>Built, the libraries changed since, but it is younger than <see cref="MaxStaleAge"/>: serve it, rebuild soon.</summary>
            Stale,

            /// <summary>Not built, or stale and too old to serve.</summary>
            Unusable,
        }

        /// <summary>
        /// How usable the cached <paramref name="kind"/> is for every library in <paramref name="libs"/>.
        /// Only about content: permissions are decided separately and live, per request.
        /// </summary>
        internal static Freshness Check(JellyfinDbContext db, DbConnection conn, Guid[] libs, Kind kind, out string why)
            => Check(db, conn, libs, new[] { kind }, out why);

        /// <summary>
        /// The worst state over several kinds. The library fingerprint is computed ONCE for all of them (it is
        /// a count/max over the library's rows, the dominant cost of a served request).
        /// </summary>
        internal static Freshness Check(JellyfinDbContext db, DbConnection conn, Guid[] libs, Kind[] kinds, out string why)
        {
            var meta = ReadMeta(conn, libs);
            if (kinds.Any(k => libs.Any(l => !meta.ContainsKey((l, k)))))
            {
                why = "not-built";
                return Freshness.Unusable;
            }

            var fps = Fingerprints(db, libs);
            var genreFp = kinds.Contains(Kind.GenreEntity) ? GenreFingerprint(db) : null;
            var result = Freshness.Fresh;
            why = null;
            foreach (var kind in kinds)
            {
                var one = CheckOne(meta, fps, genreFp, libs, kind, out var w);
                if (one == Freshness.Unusable)
                {
                    why = w;
                    return one;
                }

                if (one == Freshness.Stale)
                {
                    result = Freshness.Stale;
                }
            }

            return result;
        }

        private static Freshness CheckOne(
            Dictionary<(Guid, Kind), Meta> meta,
            Dictionary<Guid, string> fps,
            string genreFp,
            Guid[] libs,
            Kind kind,
            out string why)
        {
            var stale = libs.Any(l => meta[(l, kind)].Fingerprint != FingerprintFor(kind, fps[l], genreFp));
            if (!stale)
            {
                why = null;
                return Freshness.Fresh;
            }

            var oldest = libs.Min(l => meta[(l, kind)].BuiltAtUtc);
            if (DateTime.UtcNow - oldest > MaxStaleAge)
            {
                why = "stale";
                return Freshness.Unusable;
            }

            why = null;
            return Freshness.Stale;
        }

        /// <summary>
        /// The cached keys of <paramref name="kind"/> for the libraries, restricted to <paramref name="types"/>
        /// (null = every item type): (CleanValue, display value, RefId) with the display value being the
        /// smallest across rows, which is what stock's Min(Value) per clean value gives.
        /// </summary>
        internal static List<(string Clean, string Value, string RefId)> ReadKeys(DbConnection conn, Guid[] libs, Kind kind, string[] types)
        {
            using var c = conn.CreateCommand();
            var ls = new List<string>();
            for (var i = 0; i < libs.Length; i++)
            {
                ls.Add("@l" + i);
                AddParam(c, "@l" + i, Id(libs[i]));
            }

            AddParam(c, "@k", (int)kind);
            var sql = "SELECT CleanValue, MIN(Value), MIN(RefId) FROM " + KeysTable
                + " WHERE Kind = @k AND LibraryId IN (" + string.Join(",", ls) + ")";
            if (types != null)
            {
                var ts = new List<string>();
                for (var i = 0; i < types.Length; i++)
                {
                    ts.Add("@t" + i);
                    AddParam(c, "@t" + i, types[i]);
                }

                sql += " AND ItemType IN (" + string.Join(",", ts) + ")";
            }

            c.CommandText = sql + " GROUP BY CleanValue";
            var list = new List<(string, string, string)>();
            using var r = c.ExecuteReader();
            while (r.Read())
            {
                list.Add((r.GetString(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2)));
            }

            return list;
        }

        /// <summary>Opens a short-lived context on the server's database for the serving side.</summary>
        internal static JellyfinDbContext OpenDb(out DbConnection conn)
        {
            var db = _factory.CreateDbContext();
            db.Database.OpenConnection();
            conn = db.Database.GetDbConnection();
            return db;
        }

        internal static string TypeName(BaseItemKind kind) => _lookup.BaseItemKindNames.TryGetValue(kind, out var n) ? n : null;

        /// <summary>Counts one outcome (served / why it fell through), for the status endpoint.</summary>
        internal static void Count(string outcome) => _outcomes.AddOrUpdate(outcome, 1, (_, v) => v + 1);

        internal static long OutcomeCount(string outcome) => _outcomes.TryGetValue(outcome, out var v) ? v : 0;

        // ---------------------------------------------------------------- status

        private sealed record KindStatus(string Kind, bool Built, DateTime? BuiltAtUtc, int Keys, int SourceItems, bool Dirty);

        public static string StatusJson()
        {
            var libraries = new List<object>();
            string error = null;
            try
            {
                if (_factory != null && (_libs != null || _libraryOverride != null))
                {
                    var libs = PhysicalLibraries();
                    using var db = OpenDb(out var conn);
                    var ids = libs.Select(l => l.Id).ToArray();
                    var meta = _schemaReady && ids.Length > 0 ? ReadMeta(conn, ids) : new Dictionary<(Guid, Kind), Meta>();
                    var fps = ids.Length > 0 ? Fingerprints(db, ids) : new Dictionary<Guid, string>();
                    var genreFp = ids.Length > 0 ? GenreFingerprint(db) : "0|0";
                    foreach (var (id, name) in libs)
                    {
                        var kinds = _allKinds.Select(k =>
                        {
                            var has = meta.TryGetValue((id, k), out var m);
                            return new KindStatus(
                                k.ToString(),
                                has,
                                has ? m.BuiltAtUtc : (DateTime?)null,
                                has ? m.KeyCount : 0,
                                has ? m.SourceItemCount : 0,
                                !has || m.Fingerprint != FingerprintFor(k, fps[id], genreFp));
                        }).ToList();
                        libraries.Add(new
                        {
                            LibraryId = id,
                            Name = name,
                            Items = int.Parse(fps[id].Split('|')[0], CultureInfo.InvariantCulture),
                            Dirty = kinds.Any(k => k.Dirty),
                            Kinds = kinds,
                        });
                    }
                }
            }
            catch (Exception ex)
            {
                error = ex.Message;
            }

            return JsonSerializer.Serialize(new Dictionary<string, object>
            {
                ["Ready"] = Ready,
                ["State"] = _runState,
                ["CurrentLibrary"] = _currentLibrary,
                ["LibraryIndex"] = _libraryIndex,
                ["LibraryCount"] = _libraryTotal,
                ["LastStartedUtc"] = _lastStartedUtc,
                ["LastFinishedUtc"] = _lastFinishedUtc,
                ["LastError"] = _lastError ?? error,
                ["Outcomes"] = _outcomes.OrderBy(o => o.Key).ToDictionary(o => o.Key, o => o.Value),
                ["Libraries"] = libraries,
            });
        }

        // ---------------------------------------------------------------- ADO helpers

        private static void AddParam(DbCommand c, string name, object value)
        {
            var p = c.CreateParameter();
            p.ParameterName = name;
            p.Value = value;
            c.Parameters.Add(p);
        }

        private static void Exec(DbConnection conn, DbTransaction tx, string sql, params (string, object)[] ps)
        {
            using var c = conn.CreateCommand();
            c.Transaction = tx;
            c.CommandText = sql;
            foreach (var (n, v) in ps)
            {
                AddParam(c, n, v);
            }

            c.ExecuteNonQuery();
        }
    }
}
