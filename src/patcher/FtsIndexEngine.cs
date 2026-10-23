using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Data.Common;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations;
using MediaBrowser.Controller.Library;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Plus.Patcher
{
    /// <summary>
    /// A SQLite FTS5 trigram index over item names and tag values, in two plugin-owned virtual tables inside
    /// Jellyfin's own database (created with CREATE ... IF NOT EXISTS; Jellyfin's EF model is never touched):
    ///   JellyfinPlus_FtsNames(ItemId UNINDEXED, CleanName, OriginalTitle, SortName)  one row per BaseItems row
    ///     (SortName because Jellyfin 12.3's name match also tests it; an index built before has no such column
    ///     and is dropped and rebuilt whole - see EnsureSchema)
    ///   JellyfinPlus_FtsTags(ValueId UNINDEXED, CleanValue)                one row per distinct TAG VALUE
    ///   JellyfinPlus_FtsMeta(Key, Value)                                   the signature the index was built at
    ///
    /// TAGS ARE PER VALUE, NOT PER ITEM. ~15k distinct values against 2.3M item-to-value map rows: indexing per
    /// item would repeat each value for every item carrying it (and every tag edit would rewrite many rows).
    /// The index answers "which tag VALUES contain this text"; the item join stays where it already is, on the
    /// ItemValuesMap primary key (SearchPatches.MatchingTagItemIds).
    ///
    /// AN INDEX THAT IS ONLY EVER A PREFILTER. A trigram MATCH yields a SUPERSET of the rows that contain the
    /// text (it folds case more widely than the stock predicates do); every caller still applies the stock
    /// predicate on the real columns afterwards, so the answer is exactly the stock answer, only computed from
    /// far fewer rows. The terms it cannot answer (under 3 characters, or containing the LIKE wildcards % and _)
    /// are refused (null) and the caller runs the unchanged stock path.
    ///
    /// FRESHNESS IS CHECKED, NOT ASSUMED. <see cref="Usable"/> is true only when all of these hold; otherwise
    /// every caller falls back to the stock path, so a lagging index can never make a search miss an item:
    ///   - the index was built and its recorded signature was verified against the database within the last
    ///     <see cref="VerifyTtl"/> (a background timer re-reads the signature every <see cref="VerifyEvery"/>:
    ///     BaseItems row count + newest DateLastSaved, and the distinct tag-value count);
    ///   - no library change is waiting to be applied (ItemAdded/Updated/Removed mark the item pending at once;
    ///     the index is then not used until a debounced flush has re-read those rows and re-synced the tags);
    ///   - no build or flush is running.
    /// A signature mismatch while idle (a missed event, a change made behind Jellyfin's back) triggers a full
    /// rebuild. Events only decide WHEN to refresh; correctness never depends on having seen one.
    /// </summary>
    internal static class FtsIndexEngine
    {
        internal const string NamesTable = "JellyfinPlus_FtsNames";
        internal const string TagsTable = "JellyfinPlus_FtsTags";
        internal const string MetaTable = "JellyfinPlus_FtsMeta";

        /// <summary>The most candidate ids a lookup returns; beyond it the term is too broad for the index to help.</summary>
        internal const int MaxCandidates = 5000;

        internal static readonly TimeSpan FlushDelay = TimeSpan.FromSeconds(2);
        internal static readonly TimeSpan FlushMaxWait = TimeSpan.FromSeconds(15);
        internal static readonly TimeSpan VerifyEvery = TimeSpan.FromSeconds(30);
        internal static readonly TimeSpan VerifyTtl = TimeSpan.FromSeconds(100);

        // More pending items than this are cheaper to handle as one full rebuild than as a delete/insert by id.
        private const int MaxIncremental = 2000;

        private static readonly object _gate = new object();
        private static readonly SemaphoreSlim _writeLock = new SemaphoreSlim(1, 1);
        private static readonly ConcurrentDictionary<string, long> _outcomes = new ConcurrentDictionary<string, long>();
        private static readonly HashSet<Guid> _pending = new HashSet<Guid>();

        private static ILogger _log;
        private static ILibraryManager _libs;
        private static IDbContextFactory<JellyfinDbContext> _factory;
        private static Timer _flushTimer;
        private static Timer _verifyTimer;
        private static bool _subscribed;

        // All guarded by _gate, except the volatile ones, which the request path reads.
        private static bool _fullDirty = true;
        private static long _firstPendingTicks;
        private static volatile bool _schemaReady;
        private static volatile bool _busy;
        private static volatile bool _dirty = true;
        private static volatile bool _verified;
        private static long _verifiedAtTicks;
        private static string _recordedSig;

        private static volatile string _runState = "idle";
        private static string _lastError;
        private static string _unsupported;
        private static DateTime? _builtAtUtc;
        private static DateTime? _lastFinishedUtc;
        private static long _lastBuildMs;
        private static int _nameRows;
        private static int _tagRows;
        private static string _lastKind = "none";

        /// <summary>Turns the index off without unpatching (the harness uses it to run stock for comparison).</summary>
        internal static bool Disabled { get; set; }

        /// <summary>True when a query may use the index (see the class remarks).</summary>
        internal static bool Usable => !Disabled && _schemaReady && _unsupported == null && _factory != null
            && !_dirty && !_busy && _verified && Environment.TickCount64 - Interlocked.Read(ref _verifiedAtTicks) < (long)VerifyTtl.TotalMilliseconds;

        internal static void Count(string outcome) => _outcomes.AddOrUpdate(outcome, 1, (_, n) => n + 1);

        // ---------------------------------------------------------------- lifecycle

        /// <summary>Resolves the server services, creates the tables, watches the library. Idempotent; never throws.</summary>
        public static void Start(IServiceProvider services, ILogger logger)
        {
            try
            {
                lock (_gate)
                {
                    _log = logger ?? _log;
                    _factory ??= services.GetRequiredService<IDbContextFactory<JellyfinDbContext>>();
                    if (!_subscribed)
                    {
                        _libs = services.GetRequiredService<ILibraryManager>();
                        _flushTimer = new Timer(_ => RunBackground(false), null, Timeout.Infinite, Timeout.Infinite);
                        _verifyTimer = new Timer(_ => Verify(), null, VerifyEvery, VerifyEvery);
                        _libs.ItemAdded += OnChanged;
                        _libs.ItemUpdated += OnChanged;
                        _libs.ItemRemoved += OnChanged;
                        _subscribed = true;
                    }
                }

                if (!EnsureSchema())
                {
                    return;
                }

                _log?.LogInformation("JellyfinPlus: FTS5 trigram search index ready (tables {Names}, {Tags}); building it in the background when stale", NamesTable, TagsTable);

                // The first look at the signature decides whether the stored index is still true; a stale or
                // missing one is rebuilt shortly after start-up, off the start-up path.
                lock (_gate)
                {
                    _flushTimer?.Change(TimeSpan.FromSeconds(10), Timeout.InfiniteTimeSpan);
                }
            }
            catch (Exception ex)
            {
                _schemaReady = false;
                _log?.LogWarning(ex, "JellyfinPlus: the FTS search index could not start; search runs on the stock path.");
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
                _flushTimer?.Dispose();
                _verifyTimer?.Dispose();
                _flushTimer = null;
                _verifyTimer = null;
            }
        }

        /// <summary>Harness entry: wires the engine to a database, bypassing DI and library events.</summary>
        internal static void InitForTest(IDbContextFactory<JellyfinDbContext> factory)
        {
            _factory = factory;
            EnsureSchema();
        }

        private static void OnChanged(object sender, ItemChangeEventArgs e)
        {
            // Dirty first, synchronously, so a search that starts after the event is never answered from the index.
            lock (_gate)
            {
                if (e?.Item != null)
                {
                    _pending.Add(e.Item.Id);
                }
                else
                {
                    _fullDirty = true;
                }

                _dirty = true;
                var now = Environment.TickCount64;
                if (_firstPendingTicks == 0)
                {
                    _firstPendingTicks = now;
                }

                var untilMax = _firstPendingTicks + (long)FlushMaxWait.TotalMilliseconds - now;
                var delay = Math.Max(0, Math.Min((long)FlushDelay.TotalMilliseconds, untilMax));
                try
                {
                    _flushTimer?.Change(TimeSpan.FromMilliseconds(delay), Timeout.InfiniteTimeSpan);
                }
                catch (ObjectDisposedException)
                {
                }
            }
        }

        private static void RunBackground(bool force)
        {
            _ = Task.Run(() =>
            {
                try
                {
                    if (!Sync(force, null, CancellationToken.None, waitForLock: false))
                    {
                        lock (_gate)
                        {
                            _flushTimer?.Change(FlushDelay, Timeout.InfiniteTimeSpan);
                        }
                    }
                }
                catch (Exception ex)
                {
                    _log?.LogWarning(ex, "JellyfinPlus: background FTS index refresh failed; retrying in a minute.");
                    lock (_gate)
                    {
                        _flushTimer?.Change(TimeSpan.FromMinutes(1), Timeout.InfiniteTimeSpan);
                    }
                }
            });
        }

        /// <summary>Starts a full rebuild without waiting. False when the index is off or a run is in flight.</summary>
        public static bool StartBackground(bool force)
        {
            if (_factory == null || !_schemaReady || _writeLock.CurrentCount == 0)
            {
                return false;
            }

            RunBackground(force);
            return true;
        }

        public static Task RebuildAsync(bool force, IProgress<double> progress, CancellationToken ct)
            => Task.Run(() => Sync(force, progress, ct, waitForLock: true), ct);

        // ---------------------------------------------------------------- schema

        private static bool EnsureSchema()
        {
            try
            {
                using var db = _factory.CreateDbContext();
                db.Database.OpenConnection();
                var conn = db.Database.GetDbConnection();
                Exec(conn, null, "CREATE TABLE IF NOT EXISTS " + MetaTable + " (Key TEXT NOT NULL PRIMARY KEY, Value TEXT NOT NULL) WITHOUT ROWID");

                // A names table from before SortName was indexed (Jellyfin 12.1) cannot answer 12.3's name match:
                // drop it and forget its signature, so the next sync rebuilds it whole with the column.
                string namesSql;
                using (var c = conn.CreateCommand())
                {
                    c.CommandText = "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = @n";
                    AddParam(c, "@n", NamesTable);
                    namesSql = c.ExecuteScalar() as string;
                }

                if (namesSql != null && namesSql.IndexOf("SortName", StringComparison.Ordinal) < 0)
                {
                    Exec(conn, null, "DROP TABLE " + NamesTable);
                    Exec(conn, null, "DELETE FROM " + MetaTable + " WHERE Key = 'signature'");
                    _log?.LogInformation("JellyfinPlus: search index predates the SortName column; rebuilding it.");
                }

                Exec(conn, null, "CREATE VIRTUAL TABLE IF NOT EXISTS " + NamesTable
                    + " USING fts5(ItemId UNINDEXED, CleanName, OriginalTitle, SortName, tokenize='trigram')");
                Exec(conn, null, "CREATE VIRTUAL TABLE IF NOT EXISTS " + TagsTable
                    + " USING fts5(ValueId UNINDEXED, CleanValue, tokenize='trigram')");
                _unsupported = null;
                _schemaReady = true;
                return true;
            }
            catch (DbException ex) when (ex.Message.Contains("fts5", StringComparison.OrdinalIgnoreCase)
                || ex.Message.Contains("tokenizer", StringComparison.OrdinalIgnoreCase)
                || ex.Message.Contains("no such module", StringComparison.OrdinalIgnoreCase))
            {
                _schemaReady = false;
                _unsupported = ex.Message;
                _log?.LogWarning("JellyfinPlus: this SQLite build has no FTS5 trigram support ({Reason}); search runs on the stock path.", ex.Message);
                return false;
            }
            catch (Exception ex)
            {
                _schemaReady = false;
                _lastError = ex.Message;
                _log?.LogWarning(ex, "JellyfinPlus: the FTS search index tables could not be created; search runs on the stock path.");
                return false;
            }
        }

        // ---------------------------------------------------------------- signature

        /// <summary>"BaseItems rows|newest DateLastSaved|distinct tag values". DateLastSaved is stamped on every library save.</summary>
        internal static string Signature(DbConnection conn)
        {
            string items;
            using (var c = conn.CreateCommand())
            {
                c.CommandText = "SELECT COUNT(*), MAX(DateLastSaved) FROM BaseItems";
                using var r = c.ExecuteReader();
                r.Read();
                items = r.GetInt64(0).ToString(CultureInfo.InvariantCulture) + "|" + (r.IsDBNull(1) ? string.Empty : r.GetString(1));
            }

            using var c2 = conn.CreateCommand();
            c2.CommandText = "SELECT COUNT(*) FROM ItemValues WHERE Type = 4";
            return items + "|" + Convert.ToInt64(c2.ExecuteScalar(), CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture);
        }

        /// <summary>Background check that the recorded signature still equals the database's. Skipped while changes are in flight.</summary>
        private static void Verify()
        {
            try
            {
                if (_factory == null || !_schemaReady || _busy || _dirty || _recordedSig == null)
                {
                    return;
                }

                using var db = _factory.CreateDbContext();
                db.Database.OpenConnection();
                var sig = Signature(db.Database.GetDbConnection());
                lock (_gate)
                {
                    if (_busy || _dirty)
                    {
                        return;
                    }

                    if (sig == _recordedSig)
                    {
                        Interlocked.Exchange(ref _verifiedAtTicks, Environment.TickCount64);
                        _verified = true;
                        return;
                    }

                    // Unknown change (no event for it): not usable until a full rebuild has run.
                    _verified = false;
                    _fullDirty = true;
                    _dirty = true;
                    Count("verify:mismatch");
                    _flushTimer?.Change(FlushDelay, Timeout.InfiniteTimeSpan);
                }
            }
            catch (Exception ex)
            {
                _verified = false;
                _log?.LogDebug(ex, "JellyfinPlus: FTS index signature check failed.");
            }
        }

        // ---------------------------------------------------------------- build and flush

        /// <summary>
        /// Brings the index up to date: a full rebuild when forced, never built, or the changes are many or unknown;
        /// otherwise a delete/insert of just the pending items plus a re-sync of the (small) tag table.
        /// One transaction, so readers see the old rows or the new ones, never a mixture. True when it ran.
        /// </summary>
        internal static bool Sync(bool force, IProgress<double> progress, CancellationToken ct, bool waitForLock)
        {
            if (waitForLock)
            {
                _writeLock.Wait(ct);
            }
            else if (!_writeLock.Wait(0, ct))
            {
                return false;
            }

            try
            {
                if (_factory == null)
                {
                    throw new InvalidOperationException("the FTS index was not started");
                }

                if (!EnsureSchema())
                {
                    return true;
                }

                _busy = true;
                _runState = "running";
                _lastError = null;
                var started = DateTime.UtcNow;
                using var db = _factory.CreateDbContext();
                db.Database.OpenConnection();
                var conn = db.Database.GetDbConnection();

                // The signature is read BEFORE the rows: a change racing the run leaves the recorded signature older
                // than the data, so the next check calls it stale and rebuilds. The safe direction.
                var sig = Signature(conn);
                string stored = null;
                using (var c = conn.CreateCommand())
                {
                    c.CommandText = "SELECT Value FROM " + MetaTable + " WHERE Key = 'signature'";
                    stored = c.ExecuteScalar() as string;
                }

                Guid[] ids;
                bool full;
                lock (_gate)
                {
                    // An index nobody has verified yet is judged on first sight: the stored signature is true only
                    // if it equals the database's right now.
                    var unknown = _recordedSig == null && stored != sig;
                    full = force || _fullDirty || unknown || _pending.Count > MaxIncremental || stored == null;
                    ids = full ? Array.Empty<Guid>() : _pending.ToArray();
                    _pending.Clear();
                    _fullDirty = false;
                    _firstPendingTicks = 0;
                }

                if (!full && ids.Length == 0 && stored == sig && _recordedSig == null)
                {
                    // Start-up and the stored index is already true.
                    FinishOk(sig, "none", started);
                    return true;
                }

                if (!full && ids.Length == 0 && _recordedSig != null && sig == _recordedSig)
                {
                    FinishOk(sig, "none", started);
                    return true;
                }

                try
                {
                    progress?.Report(10);
                    WriteIndex(conn, full, ids, sig);
                    progress?.Report(100);
                }
                catch
                {
                    lock (_gate)
                    {
                        _fullDirty = true;
                    }

                    throw;
                }

                FinishOk(sig, full ? "full" : "incremental(" + ids.Length.ToString(CultureInfo.InvariantCulture) + ")", started);
                _log?.LogInformation(
                    "JellyfinPlus: FTS index {Kind} refresh took {Ms} ms ({Names} name rows, {Tags} tag values)",
                    _lastKind,
                    _lastBuildMs,
                    _nameRows,
                    _tagRows);
                return true;
            }
            catch (OperationCanceledException)
            {
                _lastError = "cancelled";
                lock (_gate)
                {
                    _fullDirty = true;
                }

                throw;
            }
            catch (Exception ex)
            {
                _lastError = ex.Message;
                _verified = false;
                lock (_gate)
                {
                    _fullDirty = true;
                }

                _log?.LogWarning(ex, "JellyfinPlus: FTS index refresh failed; search runs on the stock path until it succeeds.");
                throw;
            }
            finally
            {
                _busy = false;
                _runState = "idle";
                _lastFinishedUtc = DateTime.UtcNow;
                _writeLock.Release();
                lock (_gate)
                {
                    _dirty = _fullDirty || _pending.Count > 0 || !_verified;
                }
            }
        }

        private static void FinishOk(string sig, string kind, DateTime started)
        {
            _recordedSig = sig;
            _lastKind = kind;
            _lastBuildMs = (long)(DateTime.UtcNow - started).TotalMilliseconds;
            _builtAtUtc = kind == "none" ? _builtAtUtc ?? DateTime.UtcNow : DateTime.UtcNow;
            Interlocked.Exchange(ref _verifiedAtTicks, Environment.TickCount64);
            _verified = true;
        }

        private static void WriteIndex(DbConnection conn, bool full, Guid[] ids, string sig)
        {
            // Raw ADO bypasses Jellyfin's own write-retry policy, so a busy database is retried here.
            for (var attempt = 0; ; attempt++)
            {
                try
                {
                    using var tx = conn.BeginTransaction();
                    if (full)
                    {
                        Exec(conn, tx, "DELETE FROM " + NamesTable);
                        Exec(conn, tx, "INSERT INTO " + NamesTable + " (ItemId, CleanName, OriginalTitle, SortName) "
                            + "SELECT Id, COALESCE(CleanName, ''), COALESCE(OriginalTitle, ''), COALESCE(SortName, '') FROM BaseItems");
                    }
                    else if (ids.Length > 0)
                    {
                        var json = JsonSerializer.Serialize(ids.Select(g => g.ToString("D", CultureInfo.InvariantCulture).ToUpperInvariant()));
                        Exec(conn, tx, "DELETE FROM " + NamesTable + " WHERE ItemId IN (SELECT value FROM json_each(@ids))", ("@ids", json));
                        Exec(conn, tx, "INSERT INTO " + NamesTable + " (ItemId, CleanName, OriginalTitle, SortName) "
                            + "SELECT Id, COALESCE(CleanName, ''), COALESCE(OriginalTitle, ''), COALESCE(SortName, '') FROM BaseItems WHERE Id IN (SELECT value FROM json_each(@ids))", ("@ids", json));
                    }

                    // The tag table is small, so any refresh rewrites it whole: exact, and no diffing to get wrong.
                    Exec(conn, tx, "DELETE FROM " + TagsTable);
                    Exec(conn, tx, "INSERT INTO " + TagsTable + " (ValueId, CleanValue) SELECT ItemValueId, COALESCE(CleanValue, '') FROM ItemValues WHERE Type = 4");
                    Exec(conn, tx, "INSERT OR REPLACE INTO " + MetaTable + " (Key, Value) VALUES ('signature', @s)", ("@s", sig));
                    Exec(conn, tx, "INSERT OR REPLACE INTO " + MetaTable + " (Key, Value) VALUES ('builtAtUtc', @s)", ("@s", DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)));
                    tx.Commit();
                    CountRows(conn);
                    return;
                }
                catch (DbException ex) when (attempt < 6 && IsBusy(ex))
                {
                    Thread.Sleep(250 * (attempt + 1));
                }
            }
        }

        private static void CountRows(DbConnection conn)
        {
            _nameRows = (int)Scalar(conn, "SELECT COUNT(*) FROM " + NamesTable);
            _tagRows = (int)Scalar(conn, "SELECT COUNT(*) FROM " + TagsTable);
        }

        private static long Scalar(DbConnection conn, string sql)
        {
            using var c = conn.CreateCommand();
            c.CommandText = sql;
            return Convert.ToInt64(c.ExecuteScalar(), CultureInfo.InvariantCulture);
        }

        private static bool IsBusy(DbException ex)
            => ex.Message.Contains("locked", StringComparison.OrdinalIgnoreCase) || ex.Message.Contains("busy", StringComparison.OrdinalIgnoreCase);

        // ---------------------------------------------------------------- queries

        /// <summary>Number of Unicode characters (what a trigram counts), not UTF-16 units.</summary>
        private static int Chars(string s) => s.EnumerateRunes().Count();

        /// <summary>
        /// Whether a name search for these terms can be answered by a trigram index at all: the cleaned and the
        /// raw term, and the sort-name shape when there is one, need 3 or more characters, and the two LIKE
        /// operands (raw for OriginalTitle, sortShape for SortName) must not hold the LIKE wildcards % or _ (in a
        /// LIKE they match other characters; a trigram match does not). sortShape is null when stock adds no
        /// SortName test (Jellyfin 12.3 SqlSearchProvider: a blank BaseItem.GetSortName of the term).
        /// </summary>
        internal static bool CanAnswer(string clean, string raw, string sortShape)
            => Chars(clean) >= 3 && LikeOperandOk(raw) && (sortShape == null || LikeOperandOk(sortShape));

        private static bool LikeOperandOk(string s)
            => Chars(s) >= 3 && !s.Contains('%', StringComparison.Ordinal) && !s.Contains('_', StringComparison.Ordinal);

        /// <summary>An FTS5 phrase for the text: double-quoted, inner quotes doubled.</summary>
        private static string Phrase(string s) => "\"" + s.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"";

        /// <summary>
        /// A superset of the BaseItems ids whose CleanName contains <paramref name="clean"/>, whose OriginalTitle
        /// is LIKE %<paramref name="raw"/>% or (when <paramref name="sortShape"/> is not null) whose SortName is LIKE
        /// %<paramref name="sortShape"/>%. Null when the index cannot answer (unusable, a term under 3 characters,
        /// a LIKE wildcard in the term, more than <see cref="MaxCandidates"/> candidates, or any error).
        /// </summary>
        internal static async Task<Guid[]> NameCandidatesAsync(DbConnection conn, string clean, string raw, string sortShape, CancellationToken ct)
        {
            if (!Usable || !CanAnswer(clean, raw, sortShape))
            {
                return null;
            }

            var q = "{CleanName}: " + Phrase(clean) + " OR {OriginalTitle}: " + Phrase(raw)
                + (sortShape == null ? string.Empty : " OR {SortName}: " + Phrase(sortShape));
            return await QueryIdsAsync(conn, "SELECT ItemId FROM " + NamesTable + " WHERE " + NamesTable + " MATCH @q LIMIT " + (MaxCandidates + 1).ToString(CultureInfo.InvariantCulture), q, ct).ConfigureAwait(false);
        }

        /// <summary>The FTS5 expression "every one of these segments (3+ characters) occurs in the column"; null when none is long enough.</summary>
        private static string AllOf(string column, IEnumerable<string> segments)
        {
            var parts = segments.Where(s => Chars(s) >= 3).Distinct(StringComparer.Ordinal).Select(s => column + " : " + Phrase(s)).ToArray();
            return parts.Length == 0 ? null : string.Join(" AND ", parts);
        }

        /// <summary>
        /// A superset of the BaseItems ids a wildcard pattern can match: every long-enough literal segment must occur
        /// in CleanName (cleaned segments) or in OriginalTitle (raw segments). Short segments are left out of the
        /// condition (it is only a necessary one; the LIKE decides). Null when either column has no segment of 3+
        /// characters, or as for <see cref="NameCandidatesAsync"/>.
        /// </summary>
        internal static async Task<Guid[]> WildNameCandidatesAsync(DbConnection conn, WildPattern pattern, CancellationToken ct)
        {
            if (!Usable)
            {
                return null;
            }

            var clean = AllOf("CleanName", pattern.CleanSegments);
            var raw = AllOf("OriginalTitle", pattern.RawSegments);
            if (clean == null || raw == null)
            {
                return null;
            }

            return await QueryIdsAsync(conn, "SELECT ItemId FROM " + NamesTable + " WHERE " + NamesTable + " MATCH @q LIMIT " + (MaxCandidates + 1).ToString(CultureInfo.InvariantCulture), "(" + clean + ") OR (" + raw + ")", ct).ConfigureAwait(false);
        }

        /// <summary>Tag-value counterpart of <see cref="WildNameCandidatesAsync"/>.</summary>
        internal static async Task<Guid[]> WildTagValueCandidatesAsync(DbConnection conn, WildPattern pattern, CancellationToken ct)
        {
            var q = Usable ? AllOf("CleanValue", pattern.CleanSegments) : null;
            if (q == null)
            {
                return null;
            }

            return await QueryIdsAsync(conn, "SELECT ValueId FROM " + TagsTable + " WHERE " + TagsTable + " MATCH @q LIMIT " + (MaxCandidates + 1).ToString(CultureInfo.InvariantCulture), q, ct).ConfigureAwait(false);
        }

        /// <summary>A superset of the ItemValueIds of the TAG values whose CleanValue contains <paramref name="clean"/>; null as above.</summary>
        internal static async Task<Guid[]> TagValueCandidatesAsync(DbConnection conn, string clean, CancellationToken ct)
        {
            if (!Usable || Chars(clean) < 3)
            {
                return null;
            }

            return await QueryIdsAsync(conn, "SELECT ValueId FROM " + TagsTable + " WHERE " + TagsTable + " MATCH @q LIMIT " + (MaxCandidates + 1).ToString(CultureInfo.InvariantCulture), Phrase(clean), ct).ConfigureAwait(false);
        }

        private static async Task<Guid[]> QueryIdsAsync(DbConnection conn, string sql, string match, CancellationToken ct)
        {
            try
            {
                using var c = conn.CreateCommand();
                c.CommandText = sql;
                AddParam(c, "@q", match);
                var list = new List<Guid>();
                using var r = await c.ExecuteReaderAsync(ct).ConfigureAwait(false);
                while (await r.ReadAsync(ct).ConfigureAwait(false))
                {
                    list.Add(Guid.Parse(r.GetString(0)));
                    if (list.Count > MaxCandidates)
                    {
                        Count("query:too-broad");
                        return null;
                    }
                }

                return list.ToArray();
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                // The index is not trusted again until the next successful refresh.
                _verified = false;
                Count("query:error");
                _log?.LogWarning(ex, "JellyfinPlus: FTS index query failed; using the stock path.");
                return null;
            }
        }

        // ---------------------------------------------------------------- status

        public static string StatusJson()
        {
            long nameRows = _nameRows, tagRows = _tagRows;
            string dbSize = null;
            try
            {
                if (_factory != null && _schemaReady)
                {
                    using var db = _factory.CreateDbContext();
                    db.Database.OpenConnection();
                    var conn = db.Database.GetDbConnection();
                    nameRows = Scalar(conn, "SELECT COUNT(*) FROM " + NamesTable);
                    tagRows = Scalar(conn, "SELECT COUNT(*) FROM " + TagsTable);
                    try
                    {
                        var bytes = Scalar(conn, "SELECT COALESCE(SUM(pgsize), 0) FROM dbstat WHERE name LIKE 'JellyfinPlus_Fts%'");
                        dbSize = bytes.ToString(CultureInfo.InvariantCulture);
                    }
                    catch (DbException)
                    {
                        // dbstat is a compile-time option; the size is simply not reported without it.
                    }
                }
            }
            catch (Exception ex)
            {
                _lastError ??= ex.Message;
            }

            int pending;
            bool fullDirty;
            lock (_gate)
            {
                pending = _pending.Count;
                fullDirty = _fullDirty;
            }

            return JsonSerializer.Serialize(new Dictionary<string, object>
            {
                ["Ready"] = _factory != null && _schemaReady,
                ["Usable"] = Usable,
                ["Supported"] = _unsupported == null,
                ["Unsupported"] = _unsupported,
                ["State"] = _runState,
                ["Dirty"] = _dirty,
                ["PendingItems"] = pending,
                ["FullRebuildQueued"] = fullDirty,
                ["Verified"] = _verified,
                ["Signature"] = _recordedSig,
                ["NameRows"] = nameRows,
                ["TagValueRows"] = tagRows,
                ["IndexBytes"] = dbSize,
                ["BuiltAtUtc"] = _builtAtUtc,
                ["LastRefreshKind"] = _lastKind,
                ["LastRefreshMs"] = _lastBuildMs,
                ["LastFinishedUtc"] = _lastFinishedUtc,
                ["LastError"] = _lastError,
                ["Outcomes"] = _outcomes.OrderBy(o => o.Key).ToDictionary(o => o.Key, o => o.Value),
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
