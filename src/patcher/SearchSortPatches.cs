using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using HarmonyLib;
using Jellyfin.Database.Implementations;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Plus.Patcher
{
    /// <summary>
    /// Makes the search page's <c>sortBy</c>/<c>sortOrder</c> mean something, and widens the
    /// candidate pool so a sort or a filter is not applied to only the top few hundred relevance hits.
    ///
    /// WHY STOCK IGNORES SORT. On Jellyfin 12.1 ItemsController.GetItems with a searchTerm asks
    /// SearchManager for <c>limit * 3</c> candidate ids with relevance scores, loads those items
    /// through folder.GetItems (user access and every other /Items filter applied there), then ALWAYS
    /// re-orders the loaded items by the candidates' relevance score (ThenBy SortName) and pages them
    /// in memory with the request's startIndex/limit. The request's sortBy only reaches the SQL
    /// ORDER BY, which that re-order throws away.
    ///
    /// THE SEAM. SearchManager.GetSearchResultsAsync(SearchProviderQuery, CancellationToken) - the
    /// one place candidate ids and scores are produced, above every provider (the built-in SQL one,
    /// this plugin's tag-match postfix on it, and any external provider):
    ///
    /// - PREFIX: when the request is an /Items search carrying a supported sortBy or any filter from
    ///   the contract, raise SearchProviderQuery.Limit to at least <see cref="MaxCandidates"/>
    ///   (it is init-only, so by reflection). SearchManager and SqlSearchProvider both read
    ///   Limit, and so does SearchPatches' tag-match query, so the whole pool grows together.
    /// - POSTFIX (only when sortBy is present): re-score the returned candidates so that their
    ///   score order IS the requested sort order (score = count - rank). The controller's own
    ///   "order by score descending" then yields exactly the requested order, and its in-memory
    ///   startIndex/limit paging and total count are stock behaviour on the sorted list.
    ///
    /// WHY THIS AND NOT A CONTROLLER PATCH. The controller returns DTOs, so re-sorting there means
    /// forcing the DTO fields the sort needs (PlayCount and DatePlayed live in UserData, which the
    /// client may not have asked for), rewriting limit/startIndex to fetch the whole pool as DTOs
    /// (up to 2000 BaseItemDto built per keystroke) and re-paging afterwards. Here only ids and a
    /// float change hands, user-access filtering is still done by folder.GetItems untouched, and the
    /// set of items returned is exactly the stock set - only their order differs.
    ///
    /// WITH NO PARAMETERS the request is untouched: the prefix leaves Limit alone and the postfix
    /// returns the original task. Total, like every other patch: any failure returns the stock
    /// candidates in stock order.
    /// </summary>
    internal static class SearchSortPatches
    {
        /// <summary>Candidate-pool size used when a sort or filter is requested.</summary>
        public const int MaxCandidates = 2000;

        public const string SortByParam = "sortBy";
        public const string SortOrderParam = "sortOrder";
        public const string SeedParam = "jpSeed";

        // Request parameters from the wire contract that act AFTER candidate selection, so need a
        // pool wide enough to leave something once they have narrowed it. includeItemTypes /
        // mediaTypes are deliberately absent: the provider applies those itself, inside its query.
        private static readonly string[] _filterParams =
        {
            "isPlayed", "isFavorite", "tags", "tagMatch", "excludeTagNames", "personIds", "studioIds",
            "jpMinRuntime", "jpMaxRuntime", "jpMinDateAdded", "jpMaxDateAdded", "jpResolution",
        };

        private static readonly HttpContextAccessor _http = new HttpContextAccessor();

        private static ILogger _logger;
        private static FieldInfo _dbProvider;
        private static MethodInfo _setLimit;
        private static bool _warned;

        /// <summary>True once the target and every member it needs were resolved and patched.</summary>
        public static bool Available { get; private set; }

        public static void Apply(Harmony harmony, ILogger logger)
        {
            _logger = logger;

            var manager = AccessTools.TypeByName("Emby.Server.Implementations.Library.Search.SearchManager");
            var target = manager == null
                ? null
                : AccessTools.Method(manager, "GetSearchResultsAsync", new[] { typeof(SearchProviderQuery), typeof(CancellationToken) });
            _dbProvider = manager == null ? null : AccessTools.Field(manager, "_dbProvider");
            _setLimit = typeof(SearchProviderQuery).GetProperty(nameof(SearchProviderQuery.Limit))?.SetMethod;

            var missing = new List<string>();
            if (manager == null)
            {
                missing.Add("SearchManager");
            }
            else if (target == null)
            {
                missing.Add("GetSearchResultsAsync");
            }

            if (manager != null && _dbProvider == null)
            {
                missing.Add("_dbProvider");
            }

            if (_setLimit == null)
            {
                missing.Add("SearchProviderQuery.Limit setter");
            }

            if (missing.Count > 0)
            {
                Available = false;
                logger?.LogWarning(
                    "JellyfinPlus: could not resolve {Missing}; search sort / wide candidate pool are unavailable on "
                    + "this Jellyfin build. Stock search is unaffected.",
                    string.Join(", ", missing));
                return;
            }

            harmony.Patch(
                target,
                prefix: new HarmonyMethod(typeof(SearchSortPatches).GetMethod(nameof(GetSearchResultsPrefix), BindingFlags.Static | BindingFlags.NonPublic)),
                postfix: new HarmonyMethod(typeof(SearchSortPatches).GetMethod(nameof(GetSearchResultsPostfix), BindingFlags.Static | BindingFlags.NonPublic)));

            Available = true;
            logger?.LogInformation("JellyfinPlus: patched SearchManager.GetSearchResultsAsync (/Items search honours sortBy; candidate pool {Max} when sorting or filtering)", MaxCandidates);
        }

        /// <summary>What one request asked for, parsed once in the prefix and carried to the postfix.</summary>
        internal sealed class Spec
        {
            public (SortKey Key, bool Desc)[] Sort { get; set; } = Array.Empty<(SortKey, bool)>();

            public int? Seed { get; set; }

            /// <summary>True when a sort or any contract filter is present.</summary>
            public bool Widen { get; set; }

            public Guid? UserId { get; set; }
        }

        internal enum SortKey
        {
            SortName,
            DateCreated,
            PremiereDate,
            CommunityRating,
            Runtime,
            Random,
            PlayCount,
            DatePlayed,
        }

        /// <summary>
        /// Parses a request's sort and decides whether the pool must widen. Pure over the query
        /// collection so it can be tested. sortBy/sortOrder follow stock's rules (comma lists, a
        /// sortOrder per key, missing ones take the first, default Ascending); keys outside the
        /// contract are ignored, and none left means relevance (stock).
        /// </summary>
        internal static Spec ParseSpec(IQueryCollection query)
        {
            var spec = new Spec();

            var keys = SplitList(query, SortByParam);
            var orders = SplitList(query, SortOrderParam);
            var sort = new List<(SortKey, bool)>();
            for (var i = 0; i < keys.Count; i++)
            {
                var desc = i < orders.Count
                    ? string.Equals(orders[i], "Descending", StringComparison.OrdinalIgnoreCase)
                    : orders.Count > 0 && string.Equals(orders[0], "Descending", StringComparison.OrdinalIgnoreCase);
                if (TryParseKey(keys[i], out var key))
                {
                    sort.Add((key, desc));
                }
            }

            spec.Sort = sort.ToArray();

            if (query.TryGetValue(SeedParam, out var seedValues)
                && int.TryParse(seedValues.FirstOrDefault(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var seed))
            {
                spec.Seed = seed;
            }

            spec.Widen = spec.Sort.Length > 0
                || _filterParams.Any(p => query.TryGetValue(p, out var v) && v.Any(s => !string.IsNullOrWhiteSpace(s)));
            return spec;
        }

        private static List<string> SplitList(IQueryCollection query, string name)
            => query.TryGetValue(name, out var values)
                ? values
                    .Where(v => !string.IsNullOrEmpty(v))
                    .SelectMany(v => v.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                    .ToList()
                : new List<string>();

        private static bool TryParseKey(string name, out SortKey key)
        {
            // Enum.TryParse would also accept numbers ("3"); the contract names are the only input.
            foreach (var k in Enum.GetValues<SortKey>())
            {
                if (string.Equals(k.ToString(), name, StringComparison.OrdinalIgnoreCase))
                {
                    key = k;
                    return true;
                }
            }

            key = default;
            return false;
        }

        private static void GetSearchResultsPrefix(SearchProviderQuery query, out Spec __state)
        {
            __state = null;
            try
            {
                var request = _http.HttpContext?.Request;
                if (query == null || request == null || !request.Path.HasValue
                    || !request.Path.Value.EndsWith("/Items", StringComparison.OrdinalIgnoreCase))
                {
                    return;
                }

                var spec = ParseSpec(request.Query);
                if (!spec.Widen)
                {
                    return;
                }

                // Never lower a limit the caller already made larger (the all-types search asks for 2400).
                if ((query.Limit ?? 100) < MaxCandidates)
                {
                    _setLimit.Invoke(query, new object[] { MaxCandidates });
                }

                spec.UserId = query.UserId;
                if (spec.Sort.Length > 0)
                {
                    __state = spec;
                }
            }
            catch (Exception ex)
            {
                __state = null;
                Warn(ex);
            }
        }

        private static void GetSearchResultsPostfix(
            object __instance,
            Spec __state,
            ref Task<IReadOnlyList<SearchResult>> __result)
        {
            if (__instance == null || __state == null || __result == null)
            {
                return;
            }

            __result = SortAsync(__instance, __state, __result);
        }

        private static async Task<IReadOnlyList<SearchResult>> SortAsync(
            object manager,
            Spec spec,
            Task<IReadOnlyList<SearchResult>> original)
        {
            // The stock result, and any exception it throws, pass through exactly as before.
            var results = await original.ConfigureAwait(false);

            try
            {
                if (results == null || results.Count < 2)
                {
                    return results;
                }

                var factory = (IDbContextFactory<JellyfinDbContext>)_dbProvider.GetValue(manager);
                if (factory == null)
                {
                    return results;
                }

                var ids = results.Select(r => r.ItemId).Distinct().ToArray();
                var rows = await LoadRowsAsync(factory, ids, spec).ConfigureAwait(false);
                var ordered = SearchSortCore.Order(rows, spec.Sort, spec.Seed);
                return SearchSortCore.Rescore(ordered);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                Warn(ex);
                return results;
            }
        }

        private static async Task<List<SearchSortCore.Row>> LoadRowsAsync(
            IDbContextFactory<JellyfinDbContext> factory,
            Guid[] ids,
            Spec spec)
        {
            var db = await factory.CreateDbContextAsync().ConfigureAwait(false);
            await using (db.ConfigureAwait(false))
            {
                var items = await db.BaseItems
                    .AsNoTracking()
                    .Where(e => ids.Contains(e.Id))
                    .Select(e => new
                    {
                        e.Id,
                        e.SortName,
                        e.DateCreated,
                        e.PremiereDate,
                        e.ProductionYear,
                        e.CommunityRating,
                        e.RunTimeTicks,
                    })
                    .ToListAsync()
                    .ConfigureAwait(false);

                // Per-user columns are fetched only when asked for, and only for a known user.
                var needsUserData = spec.UserId.HasValue
                    && spec.Sort.Any(s => s.Key == SortKey.PlayCount || s.Key == SortKey.DatePlayed);
                var userData = new Dictionary<Guid, (int Count, DateTime? Played)>();
                if (needsUserData)
                {
                    var uid = spec.UserId.Value;
                    var ud = await db.UserData
                        .AsNoTracking()
                        .Where(u => u.UserId == uid && ids.Contains(u.ItemId))
                        .Select(u => new { u.ItemId, u.PlayCount, u.LastPlayedDate })
                        .ToListAsync()
                        .ConfigureAwait(false);
                    foreach (var g in ud.GroupBy(u => u.ItemId))
                    {
                        userData[g.Key] = (g.Max(u => u.PlayCount), g.Max(u => u.LastPlayedDate));
                    }
                }

                var byId = items.ToDictionary(i => i.Id);
                var rows = new List<SearchSortCore.Row>(ids.Length);
                foreach (var id in ids)
                {
                    // An id the database does not have (SearchPatches' placeholder id, for one) is kept,
                    // with every sort field unknown, so it sorts last and the candidate list never shrinks.
                    if (!byId.TryGetValue(id, out var i))
                    {
                        rows.Add(new SearchSortCore.Row(id, null, null, null, null, null, null, null));
                        continue;
                    }

                    // Mirrors OrderMapper's PremiereDate: the date, else Jan 1 of the production year.
                    var premiere = i.PremiereDate
                        ?? (i.ProductionYear.HasValue && i.ProductionYear.Value >= 1 && i.ProductionYear.Value <= 9999
                            ? new DateTime(i.ProductionYear.Value, 1, 1, 0, 0, 0, DateTimeKind.Utc)
                            : (DateTime?)null);
                    userData.TryGetValue(id, out var u);
                    rows.Add(new SearchSortCore.Row(
                        id,
                        i.SortName,
                        i.DateCreated,
                        premiere,
                        i.CommunityRating,
                        i.RunTimeTicks,
                        needsUserData ? u.Count : (int?)null,
                        needsUserData ? u.Played : null));
                }

                return rows;
            }
        }

        private static void Warn(Exception ex)
        {
            // Once: a persistent fault must not turn every search into a log line.
            if (_warned)
            {
                return;
            }

            _warned = true;
            _logger?.LogWarning(ex, "JellyfinPlus: search sort / wide candidate pool failed; search is returned as stock built it.");
        }
    }

    /// <summary>The pure part of search sorting: no database, no HTTP, so it can be tested directly.</summary>
    internal static class SearchSortCore
    {
        /// <summary>The sort fields of one candidate. Null means unknown, and sorts last in either direction.</summary>
        internal readonly record struct Row(
            Guid Id,
            string SortName,
            DateTime? Created,
            DateTime? Premiere,
            float? Rating,
            long? Runtime,
            int? PlayCount,
            DateTime? Played);

        /// <summary>
        /// Orders candidate ids by the requested keys. Unknown values go last whichever way the key
        /// runs; every remaining tie falls to SortName ascending, then id, so the order is total and a
        /// repeat call gives the same answer. Random keys use <paramref name="seed"/> when given (the
        /// same seed and ids always give the same order, across restarts too), else a fresh shuffle.
        /// </summary>
        internal static Guid[] Order(
            IReadOnlyList<Row> rows,
            (SearchSortPatches.SortKey Key, bool Desc)[] sort,
            int? seed)
        {
            Dictionary<Guid, long> random = null;
            if (sort.Any(s => s.Key == SearchSortPatches.SortKey.Random))
            {
                random = new Dictionary<Guid, long>(rows.Count);
                foreach (var r in rows)
                {
                    random[r.Id] = seed.HasValue ? SeededHash(seed.Value, r.Id) : Random.Shared.NextInt64();
                }
            }

            var list = rows.ToList();
            list.Sort((a, b) =>
            {
                foreach (var (key, desc) in sort)
                {
                    var c = key switch
                    {
                        SearchSortPatches.SortKey.SortName => CompareText(a.SortName, b.SortName, desc),
                        SearchSortPatches.SortKey.DateCreated => Compare(a.Created, b.Created, desc),
                        SearchSortPatches.SortKey.PremiereDate => Compare(a.Premiere, b.Premiere, desc),
                        SearchSortPatches.SortKey.CommunityRating => Compare(a.Rating, b.Rating, desc),
                        SearchSortPatches.SortKey.Runtime => Compare(a.Runtime, b.Runtime, desc),
                        SearchSortPatches.SortKey.PlayCount => Compare(a.PlayCount, b.PlayCount, desc),
                        SearchSortPatches.SortKey.DatePlayed => Compare(a.Played, b.Played, desc),
                        SearchSortPatches.SortKey.Random => Compare(random[a.Id], random[b.Id], desc),
                        _ => 0,
                    };
                    if (c != 0)
                    {
                        return c;
                    }
                }

                var t = CompareText(a.SortName, b.SortName, false);
                return t != 0 ? t : a.Id.CompareTo(b.Id);
            });

            return list.Select(r => r.Id).ToArray();
        }

        /// <summary>Scores ids so that descending score order is the given order: count - rank, so the first scores highest.</summary>
        internal static MediaBrowser.Controller.Library.SearchResult[] Rescore(Guid[] ordered)
        {
            var result = new MediaBrowser.Controller.Library.SearchResult[ordered.Length];
            for (var i = 0; i < ordered.Length; i++)
            {
                // Integers below 2^24 are exact in a float; the pool is capped far below that.
                result[i] = new MediaBrowser.Controller.Library.SearchResult(ordered[i], ordered.Length - i);
            }

            return result;
        }

        private static int Compare<T>(T? a, T? b, bool desc)
            where T : struct, IComparable<T>
        {
            if (!a.HasValue)
            {
                return b.HasValue ? 1 : 0;
            }

            if (!b.HasValue)
            {
                return -1;
            }

            var c = a.Value.CompareTo(b.Value);
            return desc ? -c : c;
        }

        private static int Compare<T>(T a, T b, bool desc)
            where T : struct, IComparable<T>
        {
            var c = a.CompareTo(b);
            return desc ? -c : c;
        }

        private static int CompareText(string a, string b, bool desc)
        {
            var aEmpty = string.IsNullOrEmpty(a);
            var bEmpty = string.IsNullOrEmpty(b);
            if (aEmpty)
            {
                return bEmpty ? 0 : 1;
            }

            if (bEmpty)
            {
                return -1;
            }

            var c = string.Compare(a, b, StringComparison.OrdinalIgnoreCase);
            return desc ? -c : c;
        }

        // FNV-1a over the seed and the id's bytes: unlike string/HashCode hashing it is the same in
        // every process, so "the same seed gives the same order" survives a server restart.
        private static long SeededHash(int seed, Guid id)
        {
            unchecked
            {
                var h = (ulong)14695981039346656037;
                Span<byte> buf = stackalloc byte[20];
                BitConverter.TryWriteBytes(buf, seed);
                id.TryWriteBytes(buf.Slice(4));
                foreach (var b in buf)
                {
                    h ^= b;
                    h *= 1099511628211;
                }

                return (long)h;
            }
        }
    }
}
