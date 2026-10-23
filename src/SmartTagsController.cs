using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using DbUser = Jellyfin.Database.Implementations.Entities.User;

namespace Jellyfin.Plugin.Plus
{
    /// <summary>
    /// "Smart filter": tag categories derived from the tag vocabulary of the items the requesting user can see.
    ///
    ///   GET /JellyfinPlus/Tags/Categories[?parentId=..][&amp;userId=..]
    ///
    /// Answers <c>[{ id, label, kind: prefix|exclusive|popular, prefix?, primary, coverage, tags: [{ name, label, count }] }]</c>
    /// (algorithm: <see cref="SmartTagCategories"/>). Any authenticated user.
    ///
    /// ACCESS. The items are the ids ILibraryManager.GetItemIds returns for an InternalItemsQuery(user) under the
    /// parent - stock user-access filtering (folders, BlockedTags, AllowedTags, parental rating, unrated blocks) - and
    /// only their tags are counted, so no category, chip or count is built from an item the user cannot see.
    ///
    /// CACHE. Per user + access digest + parent, dropped on any library item event (and after 30 minutes); the
    /// generation is read before computing so a change racing the computation is never stored. One computation per
    /// key at a time.
    /// </summary>
    [ApiController]
    [Authorize]
    [Route("JellyfinPlus/Tags")]
    public class SmartTagsController : ControllerBase
    {
        private static readonly BaseItemKind[] Types =
        {
            BaseItemKind.Movie, BaseItemKind.Series, BaseItemKind.Episode, BaseItemKind.Video, BaseItemKind.MusicVideo,
        };

        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly IDbContextFactory<JellyfinDbContext> _dbFactory;

        /// <summary>Initializes a new instance of the <see cref="SmartTagsController"/> class.</summary>
        public SmartTagsController(ILibraryManager libraryManager, IUserManager userManager, IDbContextFactory<JellyfinDbContext> dbFactory)
        {
            _libraryManager = libraryManager;
            _userManager = userManager;
            _dbFactory = dbFactory;
        }

        /// <summary>Gets the smart tag categories for the user's visible items under a parent (or everywhere).</summary>
        [HttpGet("Categories")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public async Task<ActionResult<IReadOnlyList<SmartTagCategory>>> GetCategories(
            [FromQuery] Guid? parentId,
            [FromQuery] Guid? userId,
            CancellationToken cancellationToken)
        {
            var clock = Stopwatch.StartNew();
            SmartTagCache.EnsureSubscribed(_libraryManager);

            var user = ResolveUser(userId, out var error);
            if (user == null)
            {
                return error;
            }

            BaseItem parent = null;
            if (parentId.HasValue && parentId.Value != Guid.Empty)
            {
                parent = _libraryManager.GetItemById<BaseItem>(parentId.Value, user);
                if (parent == null || (parent is CollectionFolder cf && !cf.IsVisible(user)))
                {
                    return NotFound(); // not found or not visible: the same answer, so existence does not leak
                }
            }

            var key = user.Id.ToString("N", CultureInfo.InvariantCulture) + "|" + SmartTagCache.AccessDigest(user) + "|"
                + (parentId ?? Guid.Empty).ToString("N", CultureInfo.InvariantCulture);
            var gen = SmartTagCache.Generation;
            if (SmartTagCache.TryGet(key, gen, out var cached))
            {
                Response.Headers["Server-Timing"] = "tagcats;dur=" + clock.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture) + ", tagcats-cache;dur=0";
                return Ok(cached);
            }

            var gate = SmartTagCache.GateFor(key);
            await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                // Another request may have finished the same key while this one waited.
                gen = SmartTagCache.Generation;
                if (SmartTagCache.TryGet(key, gen, out cached))
                {
                    return Ok(cached);
                }

                var query = new InternalItemsQuery(user)
                {
                    IncludeItemTypes = Types,
                    Recursive = true,
                    EnableTotalRecordCount = false,
                    CollapseBoxSetItems = false,
                };
                // Recursive scope under the parent. A library (CollectionFolder) is its physical folders as
                // TopParentIds, as the stock library views and FilterCacheEngine scope it; any other folder is an
                // ancestor. ParentId alone would match direct children only. Without a parent the library manager
                // scopes the query to the user's own libraries (AddUserToQuery).
                if (parent is CollectionFolder library)
                {
                    query.TopParentIds = library.PhysicalFolderIds.ToArray();
                    if (query.TopParentIds.Length == 0)
                    {
                        return Ok(new List<SmartTagCategory>());
                    }
                }
                else if (parent != null)
                {
                    query.AncestorIds = new[] { parent.Id };
                }

                var blockedUnrated = user.GetPreferenceValues<UnratedItem>(PreferenceKind.BlockUnratedItems);
                if (blockedUnrated != null)
                {
                    query.BlockUnratedItems = blockedUnrated;
                }

                if (!user.DisplayMissingEpisodes)
                {
                    query.IsMissing = false;
                }

                var ids = _libraryManager.GetItemIds(query);
                var idsMs = clock.ElapsedMilliseconds;
                List<SmartTagCategory> cats;
                var db = await _dbFactory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
                await using (db.ConfigureAwait(false))
                {
                    var rows = await SmartTagsCore.LoadAsync(db, ids, SmartTagOptions.Default, cancellationToken).ConfigureAwait(false);
                    cats = SmartTagCategories.Build(rows.ItemCount, rows.Rows);
                }

                SmartTagCache.Put(key, gen, cats);
                Response.Headers["Server-Timing"] = "tagcats;dur=" + clock.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture)
                    + ", tagcats-ids;dur=" + idsMs.ToString(CultureInfo.InvariantCulture);
                return Ok(cats);
            }
            finally
            {
                gate.Release();
            }
        }

        private DbUser ResolveUser(Guid? requested, out ActionResult error)
        {
            error = null;
            Guid? authenticated = Guid.TryParse(User.FindFirst("Jellyfin-UserId")?.Value, out var a) && a != Guid.Empty ? a : null;
            var admin = User.IsInRole("Administrator");

            Guid id;
            if (!requested.HasValue || requested.Value == Guid.Empty)
            {
                if (!authenticated.HasValue)
                {
                    error = BadRequest("userId is required for this credential.");
                    return null;
                }

                id = authenticated.Value;
            }
            else
            {
                // Same rule as the stock controllers: another user's view is for administrators only.
                if (requested.Value != authenticated && !admin)
                {
                    error = Forbid();
                    return null;
                }

                id = requested.Value;
            }

            var user = _userManager.GetUserById(id);
            if (user == null)
            {
                error = NotFound();
            }

            return user;
        }
    }

    /// <summary>The database half: no HTTP, no library manager, so it runs on a bare DbContext in the harness.</summary>
    internal static class SmartTagsCore
    {
        /// <summary>
        /// The tag rows of exactly <paramref name="visibleIds"/>: map rows of any other item are dropped here, before
        /// anything is counted. Tags that differ only in case/diacritics (one clean value) are merged under the most used
        /// spelling. Name-likeness is decided for the pool tags only, from a sample of their items' paths and names.
        /// </summary>
        internal static async Task<(int ItemCount, List<SmartTagRow> Rows)> LoadAsync(
            JellyfinDbContext db, IEnumerable<Guid> visibleIds, SmartTagOptions o, CancellationToken ct)
        {
            var ids = visibleIds.Distinct().OrderBy(g => g).ToArray();
            var index = new Dictionary<Guid, int>(ids.Length);
            for (var i = 0; i < ids.Length; i++)
            {
                index[ids[i]] = i;
            }

            var rows = new List<SmartTagRow>();
            if (ids.Length == 0)
            {
                return (0, rows);
            }

            var values = await db.ItemValues.AsNoTracking()
                .Where(v => v.Type == ItemValueType.Tags)
                .Select(v => new { v.ItemValueId, v.Value, v.CleanValue })
                .ToListAsync(ct).ConfigureAwait(false);
            var group = new Dictionary<string, int>(StringComparer.Ordinal);
            var valueGroup = new Dictionary<Guid, int>(values.Count);
            var spellings = new List<List<(string Value, Guid Id)>>();
            foreach (var v in values)
            {
                var clean = string.IsNullOrEmpty(v.CleanValue) ? (v.Value ?? string.Empty).ToLowerInvariant() : v.CleanValue;
                if (!group.TryGetValue(clean, out var g))
                {
                    group[clean] = g = spellings.Count;
                    spellings.Add(new List<(string, Guid)>());
                }

                spellings[g].Add((v.Value, v.ItemValueId));
                valueGroup[v.ItemValueId] = g;
            }

            var items = new List<int>[spellings.Count];
            var perValue = new Dictionary<Guid, int>();
            var pairs = db.ItemValuesMap.AsNoTracking()
                .Join(db.ItemValues.AsNoTracking().Where(v => v.Type == ItemValueType.Tags), m => m.ItemValueId, v => v.ItemValueId, (m, v) => new { m.ItemId, m.ItemValueId })
                .AsAsyncEnumerable();
            await foreach (var p in pairs.WithCancellation(ct).ConfigureAwait(false))
            {
                if (!index.TryGetValue(p.ItemId, out var i) || !valueGroup.TryGetValue(p.ItemValueId, out var g))
                {
                    continue; // not visible to this user (or not a tag): never counted
                }

                (items[g] ??= new List<int>()).Add(i);
                perValue[p.ItemValueId] = perValue.TryGetValue(p.ItemValueId, out var c) ? c + 1 : 1;
            }

            for (var g = 0; g < items.Length; g++)
            {
                if (items[g] == null)
                {
                    continue;
                }

                var name = spellings[g]
                    .OrderByDescending(s => perValue.TryGetValue(s.Id, out var c) ? c : 0)
                    .ThenBy(s => s.Value, StringComparer.Ordinal)
                    .First().Value;
                if (string.IsNullOrWhiteSpace(name))
                {
                    continue;
                }

                rows.Add(new SmartTagRow(name, items[g].Distinct().OrderBy(x => x).ToArray()));
            }

            // Name-likeness for the pool only (the rest never takes part), from up to NameLikeSample items each.
            var minSupport = SmartTagCategories.MinSupport(ids.Length, o);
            var pool = rows.Where(r => r.Items.Length >= minSupport).OrderByDescending(r => r.Items.Length).Take(o.MaxPool).ToList();
            var sampleIdx = pool.SelectMany(r => r.Items.Take(o.NameLikeSample)).Distinct().ToArray();
            var text = new Dictionary<int, (string Path, string Name)>(sampleIdx.Length);
            foreach (var chunk in sampleIdx.Chunk(500))
            {
                var chunkIds = chunk.Select(i => ids[i]).ToArray();
                var found = await db.BaseItems.AsNoTracking()
                    .Where(b => EF.Parameter(chunkIds).Contains(b.Id))
                    .Select(b => new { b.Id, b.Path, b.Name })
                    .ToListAsync(ct).ConfigureAwait(false);
                foreach (var b in found)
                {
                    text[index[b.Id]] = (b.Path ?? string.Empty, b.Name ?? string.Empty);
                }
            }

            foreach (var r in pool)
            {
                var sample = r.Items.Take(o.NameLikeSample).Where(text.ContainsKey).Select(i => text[i]).ToList();
                r.NameDepth = SmartTagCategories.NameLikeDepth(r.Name, sample, o);
            }

            return (ids.Length, rows);
        }
    }

    /// <summary>Memory cache of finished category answers (see <see cref="SmartTagsController"/>).</summary>
    internal static class SmartTagCache
    {
        internal const int MaxEntries = 100;
        internal static readonly TimeSpan Ttl = TimeSpan.FromMinutes(30);
        internal static readonly TimeSpan MinFresh = TimeSpan.FromMinutes(10);

        private static readonly object Gate = new object();
        private static readonly Dictionary<string, (long Gen, long Ticks, List<SmartTagCategory> Rows)> Map = new Dictionary<string, (long, long, List<SmartTagCategory>)>(StringComparer.Ordinal);
        private static readonly Dictionary<string, SemaphoreSlim> Gates = new Dictionary<string, SemaphoreSlim>(StringComparer.Ordinal);
        private static long generation;
        private static int subscribed;

        internal static long Generation => Interlocked.Read(ref generation);

        internal static void Invalidate() => Interlocked.Increment(ref generation);

        internal static void EnsureSubscribed(ILibraryManager libs)
        {
            if (Interlocked.Exchange(ref subscribed, 1) == 1)
            {
                return;
            }

            libs.ItemAdded += (_, _) => Invalidate();
            libs.ItemUpdated += (_, _) => Invalidate();
            libs.ItemRemoved += (_, _) => Invalidate();
        }

        // The settings that decide which items a user sees and that change without a library event.
        internal static string AccessDigest(DbUser user)
        {
            string Join<T>(PreferenceKind k) => string.Join(",", (user.GetPreferenceValues<T>(k) ?? Array.Empty<T>()).Select(x => x?.ToString()).OrderBy(x => x, StringComparer.Ordinal));
            return string.Join(
                ";",
                user.HasPermission(PermissionKind.EnableAllFolders) ? "all" : "sel",
                Join<Guid>(PreferenceKind.EnabledFolders),
                Join<string>(PreferenceKind.BlockedTags),
                Join<string>(PreferenceKind.AllowedTags),
                Join<UnratedItem>(PreferenceKind.BlockUnratedItems),
                user.MaxParentalRatingScore?.ToString(CultureInfo.InvariantCulture) ?? "-",
                user.DisplayMissingEpisodes ? "m" : "-");
        }

        internal static SemaphoreSlim GateFor(string key)
        {
            lock (Gate)
            {
                if (!Gates.TryGetValue(key, out var s))
                {
                    if (Gates.Count > MaxEntries * 2)
                    {
                        Gates.Clear(); // waiters keep their own reference; a fresh gate only loses de-duplication
                    }

                    Gates[key] = s = new SemaphoreSlim(1, 1);
                }

                return s;
            }
        }

        internal static bool TryGet(string key, long gen, out List<SmartTagCategory> rows)
        {
            rows = null;
            lock (Gate)
            {
                if (!Map.TryGetValue(key, out var e))
                {
                    return false;
                }

                // Item events arrive continuously while a recorder ingests, so a generation bump alone does
                // not expire an answer younger than MinFresh: categories follow the tag distribution, which a
                // handful of new items barely moves. Past MinFresh a change expires it; past Ttl, always.
                var age = Environment.TickCount64 - e.Ticks;
                if (age > (long)Ttl.TotalMilliseconds || (e.Gen != gen && age > (long)MinFresh.TotalMilliseconds))
                {
                    Map.Remove(key);
                    return false;
                }

                rows = e.Rows;
                return true;
            }
        }

        internal static void Put(string key, long gen, List<SmartTagCategory> rows)
        {
            // A change racing the computation still stores the answer, stamped with the generation read
            // before computing: under constant ingest a race is the norm, and refusing to store would
            // recompute (about a second) on every request. The stale stamp expires it after MinFresh.
            lock (Gate)
            {
                if (Map.Count >= MaxEntries && !Map.ContainsKey(key))
                {
                    var oldest = Map.OrderBy(kv => kv.Value.Ticks).First().Key;
                    Map.Remove(oldest);
                }

                Map[key] = (gen, Environment.TickCount64, rows);
            }
        }
    }
}
