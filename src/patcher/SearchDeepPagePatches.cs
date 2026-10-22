using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Reflection;
using Jellyfin.Database.Implementations;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Persistence;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using HarmonyLib;

namespace Jellyfin.Plugin.Plus.Patcher
{
    /// <summary>
    /// Deep paging that loads only the page. Stock ItemsController, for a search, hands the candidate
    /// ids to folder.GetItems, which materialises EVERY candidate as a full BaseItem (JSON data, images,
    /// user data, ... for up to <see cref="SearchSortPatches.MaxPagedCandidates"/> = 5000 ids), only for the
    /// controller to order them by relevance score, skip startIndex, take limit and build DTOs for those
    /// few. Measured on the real library that load is the bulk of a deep page (page 4 of a 5000 pool).
    ///
    /// THE SEAM. BaseItemRepository.GetItemList(InternalItemsQuery): the one method every
    /// folder.GetItems / GetItemsResult / GetItems(filter without limit) ends in for such a query (the
    /// controller sets Limit and StartIndex to null when it searches, and the repository's GetItems
    /// forwards to GetItemList in that case). Everything above it (Folder.SortItemsByRequest, the
    /// controller's order / skip / take / total) keeps running unchanged on what we return.
    ///
    /// WHAT WE RETURN. For a request that SearchSortPatches has recorded a candidate pool for (same ids,
    /// same order as the query's ItemIds, no limit / start / adjacency / search term on the query):
    ///
    /// 1. the filtered ids: <c>GetItemIdsList(filter)</c>, the SAME query with every filter, user-access
    ///    rule and this plugin's TranslateQuery postfix applied, but no entity materialised;
    /// 2. a (Id, SortName, Type) projection of just those ids: SortName because the controller's order is
    ///    "score descending, then SortName", Type to prove that stock would have materialised every one;
    /// 3. the page: the controller's own LINQ (score desc, SortName) over those, preceded by the
    ///    Folder's own step (ordered by position in the query's ItemIds when the query has no OrderBy),
    ///    then Skip(startIndex).Take(limit);
    /// 4. only the page's ids loaded for real, by the stock GetItemList with ItemIds narrowed to them;
    /// 5. a result list of the stock length and in the stock (database) order, where the page positions
    ///    hold the real entities and every other position holds a stub carrying just Id and SortName.
    ///
    /// The controller counts the list (the true total, unchanged), orders it by the same keys, skips and
    /// takes, and so reaches exactly the page entities; the stubs are all before or after the page and
    /// are never converted to DTOs.
    ///
    /// FAIL TO STOCK, never to something different. Any of these returns the untouched stock path
    /// instead (the prefix returns true): no recorded pool or a pool that does not match the query; a
    /// page that covers the pool anyway; a row missing, a null SortName or an unresolvable Type among the
    /// filtered ids (stock would have dropped or recomputed those); the page load returning a different
    /// number of entities than ids; any exception. Turn the whole patch off with the environment
    /// variable JELLYFINPLUS_NO_DEEP_PAGE=1.
    /// </summary>
    internal static class SearchDeepPagePatches
    {
        internal const string PoolKey = "JellyfinPlus.SearchPool";

        // Below this pool size the stock load is cheap and a stub list buys nothing.
        internal const int MinPool = 200;

        private static readonly HttpContextAccessor _http = new HttpContextAccessor();

        private static ILogger _logger;
        private static FieldInfo _dbProvider;
        private static Func<string, Type> _resolveType;
        private static bool _warned;

        public static bool Available { get; private set; }

        /// <summary>The candidates a search request produced and the page that request will show.</summary>
        internal sealed class Pool
        {
            public Guid[] Ids { get; set; }

            public float[] Scores { get; set; }

            public int Start { get; set; }

            public int Limit { get; set; }

            /// <summary>True while our own page load re-enters GetItemList, so it is not intercepted again.</summary>
            public bool Busy { get; set; }
        }

        public static void Apply(Harmony harmony, ILogger logger)
        {
            _logger = logger;
            if (string.Equals(Environment.GetEnvironmentVariable("JELLYFINPLUS_NO_DEEP_PAGE"), "1", StringComparison.Ordinal))
            {
                logger?.LogInformation("JellyfinPlus: deep search paging is disabled by JELLYFINPLUS_NO_DEEP_PAGE=1.");
                return;
            }

            var repository = AccessTools.TypeByName("Jellyfin.Server.Implementations.Item.BaseItemRepository");
            var target = repository == null
                ? null
                : AccessTools.Method(repository, "GetItemList", new[] { typeof(InternalItemsQuery) });
            _dbProvider = repository == null ? null : AccessTools.Field(repository, "_dbProvider");
            var mapper = AccessTools.TypeByName("Jellyfin.Server.Implementations.Item.BaseItemMapper");
            var getType = mapper == null ? null : AccessTools.Method(mapper, "GetType", new[] { typeof(string) });
            if (getType != null)
            {
                _resolveType = (Func<string, Type>)Delegate.CreateDelegate(typeof(Func<string, Type>), getType);
            }

            if (target == null || _dbProvider == null || _resolveType == null || !typeof(IItemRepository).IsAssignableFrom(repository))
            {
                Available = false;
                logger?.LogWarning(
                    "JellyfinPlus: could not resolve BaseItemRepository.GetItemList / _dbProvider / BaseItemMapper.GetType; deep search paging "
                    + "loads every candidate as stock does. Search results are unaffected.");
                return;
            }

            harmony.Patch(target, prefix: new HarmonyMethod(typeof(SearchDeepPagePatches).GetMethod(nameof(GetItemListPrefix), BindingFlags.Static | BindingFlags.NonPublic)));
            Available = true;

            // Folder.SortItemsByRequest is O(n^2) (Array.IndexOf per item) and runs on every search's
            // candidates: ~40 ms for a 5000 pool. Same order from a dictionary. Independent of the above.
            try
            {
                var sorter = typeof(Folder).GetMethod("SortItemsByRequest", BindingFlags.Static | BindingFlags.NonPublic, null, new[] { typeof(InternalItemsQuery), typeof(IReadOnlyList<BaseItem>) }, null);
                if (sorter != null && sorter.ReturnType == typeof(BaseItem[]))
                {
                    harmony.Patch(sorter, prefix: new HarmonyMethod(typeof(SearchDeepPagePatches).GetMethod(nameof(SortItemsByRequestPrefix), BindingFlags.Static | BindingFlags.NonPublic)));
                }
            }
            catch (Exception ex)
            {
                logger?.LogWarning(ex, "JellyfinPlus: could not patch Folder.SortItemsByRequest; large id lists are ordered the slow stock way.");
            }

            logger?.LogInformation("JellyfinPlus: patched BaseItemRepository.GetItemList (a paged search loads only the page's entities)");
        }

        /// <summary>
        /// Called from SearchSortPatches once the final candidates are known: remembers them for this
        /// request when the page is small next to the pool.
        /// </summary>
        internal static void Record(HttpContext context, IReadOnlyList<MediaBrowser.Controller.Library.SearchResult> results, int start, int? limit)
        {
            if (!Available || context == null || results == null || !limit.HasValue || limit.Value <= 0
                || results.Count < MinPool || results.Count <= start + (long)limit.Value)
            {
                return;
            }

            var ids = new Guid[results.Count];
            var scores = new float[results.Count];
            var seen = new HashSet<Guid>();
            for (var i = 0; i < ids.Length; i++)
            {
                ids[i] = results[i].ItemId;
                scores[i] = results[i].Score;
                if (!seen.Add(ids[i]))
                {
                    // Stock's ToDictionary throws on a duplicate; leave that to it.
                    return;
                }
            }

            context.Items[PoolKey] = new Pool { Ids = ids, Scores = scores, Start = start, Limit = limit.Value };
        }

        /// <summary>
        /// Stock: <c>items.OrderBy(i =&gt; Array.IndexOf(query.ItemIds, i.Id)).ToArray()</c>, quadratic in
        /// the id count. Same stable order from a first-index dictionary (an id not in the list is -1,
        /// first, exactly as IndexOf says). Short lists keep the stock code.
        /// </summary>
        private static bool SortItemsByRequestPrefix(InternalItemsQuery query, IReadOnlyList<BaseItem> items, ref BaseItem[] __result)
        {
            try
            {
                var ids = query?.ItemIds;
                if (ids == null || items == null || ids.Length < 256)
                {
                    return true;
                }

                var position = new Dictionary<Guid, int>(ids.Length);
                for (var i = 0; i < ids.Length; i++)
                {
                    position.TryAdd(ids[i], i);
                }

                __result = items.OrderBy(i => position.GetValueOrDefault(i.Id, -1)).ToArray();
                return false;
            }
            catch (Exception ex)
            {
                Warn(ex);
                return true;
            }
        }

        private static bool GetItemListPrefix(object __instance, InternalItemsQuery filter, ref IReadOnlyList<BaseItem> __result)
        {
            Pool pool = null;
            try
            {
                pool = FindPool(filter);
                if (pool == null)
                {
                    return true;
                }

                pool.Busy = true;
                var items = Build((IItemRepository)__instance, __instance, filter, pool);
                if (items == null)
                {
                    return true;
                }

                __result = items;
                return false;
            }
            catch (Exception ex)
            {
                Warn(ex);
                return true;
            }
            finally
            {
                if (pool != null)
                {
                    pool.Busy = false;
                }
            }
        }

        private static Pool FindPool(InternalItemsQuery filter)
        {
            var items = _http.HttpContext?.Items;
            if (filter == null || items == null || !items.TryGetValue(PoolKey, out var o) || o is not Pool pool || pool.Busy)
            {
                return null;
            }

            if (filter.Limit.HasValue || filter.StartIndex.HasValue || !string.IsNullOrEmpty(filter.SearchTerm)
                || (filter.AdjacentTo.HasValue && filter.AdjacentTo.Value != Guid.Empty)
                || filter.ItemIds == null || filter.ItemIds.Length != pool.Ids.Length
                || !filter.ItemIds.AsSpan().SequenceEqual(pool.Ids))
            {
                return null;
            }

            return pool;
        }

        /// <summary>The stock-shaped result, or null to run the stock path.</summary>
        private static IReadOnlyList<BaseItem> Build(IItemRepository repo, object instance, InternalItemsQuery filter, Pool pool)
        {
            var t0 = Stopwatch.GetTimestamp();
            var ids = repo.GetItemIdsList(filter);
            var tIds = ServerTimingPatches.Ms(t0);
            if (ids.Count <= pool.Start + (long)pool.Limit)
            {
                return null;
            }

            var idArray = ids as Guid[] ?? ids.ToArray();
            var factory = (IDbContextFactory<JellyfinDbContext>)_dbProvider.GetValue(instance);
            if (factory == null)
            {
                return null;
            }

            var t1 = Stopwatch.GetTimestamp();
            Dictionary<Guid, string> sortNames;
            using (var db = factory.CreateDbContext())
            {
                var rows = db.BaseItems
                    .AsNoTracking()
                    .Where(e => EF.Parameter(idArray).Contains(e.Id))
                    .Select(e => new { e.Id, e.SortName, e.Type })
                    .ToList();
                if (rows.Count != idArray.Length)
                {
                    return null;
                }

                sortNames = new Dictionary<Guid, string>(rows.Count);
                var knownTypes = new Dictionary<string, bool>(StringComparer.Ordinal);
                foreach (var r in rows)
                {
                    if (r.SortName == null || string.IsNullOrEmpty(r.Type))
                    {
                        return null;
                    }

                    if (!knownTypes.TryGetValue(r.Type, out var known))
                    {
                        known = _resolveType(r.Type) != null;
                        knownTypes[r.Type] = known;
                    }

                    if (!known)
                    {
                        return null;
                    }

                    sortNames[r.Id] = r.SortName;
                }
            }

            var tRows = ServerTimingPatches.Ms(t1);

            // What the controller will order: the repository's (database) order, then Folder's own step
            // for a query without an OrderBy, then "score descending, SortName".
            IEnumerable<Guid> sequence = idArray;
            if (filter.OrderBy.Count == 0 && pool.Ids.Length > 1)
            {
                var position = new Dictionary<Guid, int>(pool.Ids.Length);
                for (var i = 0; i < pool.Ids.Length; i++)
                {
                    position.TryAdd(pool.Ids[i], i);
                }

                sequence = idArray.OrderBy(id => position.GetValueOrDefault(id, -1));
            }

            var scores = new Dictionary<Guid, float>(pool.Ids.Length);
            for (var i = 0; i < pool.Ids.Length; i++)
            {
                scores[pool.Ids[i]] = pool.Scores[i];
            }

            var pageIds = sequence
                .OrderByDescending(id => scores.GetValueOrDefault(id, 0f))
                .ThenBy(id => sortNames[id])
                .Skip(pool.Start)
                .Take(pool.Limit)
                .ToArray();

            var t2 = Stopwatch.GetTimestamp();
            IReadOnlyList<BaseItem> real;
            var original = filter.ItemIds;
            filter.ItemIds = pageIds;
            try
            {
                real = repo.GetItemList(filter);
            }
            finally
            {
                filter.ItemIds = original;
            }

            if (real.Count != pageIds.Length)
            {
                return null;
            }

            var realById = new Dictionary<Guid, BaseItem>(real.Count);
            foreach (var item in real)
            {
                if (!realById.TryAdd(item.Id, item))
                {
                    return null;
                }
            }

            var result = new BaseItem[idArray.Length];
            for (var i = 0; i < result.Length; i++)
            {
                var id = idArray[i];
                result[i] = realById.TryGetValue(id, out var entity)
                    ? entity
                    : new Video { Id = id, SortName = sortNames[id] };
            }

            ServerTimingPatches.Record("deep-ids", tIds, string.Create(CultureInfo.InvariantCulture, $"pool={pool.Ids.Length} filtered={idArray.Length}"));
            ServerTimingPatches.Record("deep-rows", tRows);
            ServerTimingPatches.Record("deep-page", ServerTimingPatches.Ms(t2), string.Create(CultureInfo.InvariantCulture, $"loaded={pageIds.Length}"));
            return result;
        }

        private static void Warn(Exception ex)
        {
            if (_warned)
            {
                return;
            }

            _warned = true;
            _logger?.LogWarning(ex, "JellyfinPlus: deep search paging failed; the search loads every candidate as stock does.");
        }
    }
}
