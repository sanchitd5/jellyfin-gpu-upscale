using System;
using System.Globalization;
using System.Linq;
using System.Linq.Expressions;
using System.Reflection;
using HarmonyLib;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Plus.Patcher
{
    /// <summary>
    /// Two extra ORDER BY keys for /Items library listings, both driven by request parameters the
    /// stock web client never sends (the injected script's list-page module does):
    ///
    /// 1. SEEDED RANDOM. With <c>jpListSeed=N</c> the Random sort is a fixed function of (item id, N)
    ///    instead of a fresh dice roll per query, so page 2 continues page 1's shuffle (no repeats, no
    ///    gaps) and the same seed gives the same order again, across restarts.
    ///    Stock repeats because OrderMapper.MapOrderByField maps ItemSortBy.Random to
    ///    <c>EF.Functions.Random()</c> (SQLite random() in ORDER BY), and every page is its own query
    ///    with its own LIMIT/OFFSET, hence its own shuffle.
    ///
    /// 2. RECENTLY EDITED. With <c>jpSortKey=DateLastSaved</c>, a sort on ItemSortBy.DateLastContentAdded
    ///    is ordered by the item's own <c>DateLastSaved</c> instead. The enum has no DateLastSaved member
    ///    and the query binder silently drops a sortBy name it does not know (CommaDelimitedCollectionModelBinder
    ///    catches the FormatException), so the client cannot ask for it by name; it sends the
    ///    placeholder key plus this parameter. Without the patch (or without the parameter) the
    ///    placeholder keeps its stock meaning, which on a Video is "no value", i.e. name order.
    ///
    /// THE SEAM. <c>OrderMapper.MapOrderByField(ItemSortBy, InternalItemsQuery, JellyfinDbContext)</c> is
    /// public static and is the only place a Random or DateLastContentAdded ORDER BY term is built. A
    /// postfix replaces the returned key expression; nothing else about the query changes.
    ///
    /// THE SEEDED KEY. EF Core's SQLite provider has no seedable or hash function, and the plugin must
    /// not register one on Jellyfin's connection. Jellyfin item ids are 36-character upper-case text
    /// (an MD5 digest formatted as a guid), so every hex digit is uniform and independent. The key is
    /// the concatenation of 16 of an id's 32 hex digits, taken at positions chosen by a seeded
    /// shuffle: <c>substr(Id,p0,1) || substr(Id,p1,1) || ...</c>. That is plain text ordering, which
    /// SQLite sorts like any column; different seeds pick different digit orders (so different
    /// shuffles); and the positions travel as SQL parameters, so EF compiles one query shape for every
    /// seed instead of one per seed. 16 digits = 64 bits: for an 80k-item library the chance of ANY two
    /// ids sharing a key is about 2e-10 (none in the real-database proof), and the stock SortName
    /// tiebreaker that follows a sort still applies if it happens.
    ///
    /// ORDER ONLY. The patch returns a different ORDER BY expression. It never adds, removes or
    /// widens a Where clause, so which rows a user can see (library access, parental rating, tags) is
    /// exactly what stock decided (invariant 13). Ascending and descending both work (the stock code
    /// applies the direction to whatever key it is given).
    ///
    /// SCOPE. Acts only when ALL of these hold, otherwise the stock expression runs untouched:
    ///  - the sort being mapped is Random (seed) or DateLastContentAdded (recently edited);
    ///  - the current HTTP request path ends in /Items;
    ///  - the request carries the matching parameter: <c>jpListSeed</c> as a positive integer, or
    ///    <c>jpSortKey</c> equal to <c>DateLastSaved</c>;
    ///  - the query is not a search (a search term makes ItemsController and SearchSortPatches order by
    ///    relevance and by <c>jpSeed</c>; this patch leaves that path alone).
    /// Every other Random user (Suggestions, similar items, splash screen, image providers, playback
    /// shuffle) has no such parameter and keeps the real random order.
    /// </summary>
    internal static class ListSortPatches
    {
        public const string SeedParam = "jpListSeed";
        public const string SortKeyParam = "jpSortKey";
        public const string RecentlyEditedValue = "DateLastSaved";

        /// <summary>How many hex digits of the id form the seeded key (of 32).</summary>
        internal const int KeyDigits = 16;

        // Same static-AsyncLocal trick as LibraryFilterPatches: a fresh accessor reads the current context.
        private static readonly HttpContextAccessor _http = new HttpContextAccessor();

        private static ILogger _logger;
        private static bool _warned;

        /// <summary>True once OrderMapper.MapOrderByField was resolved and patched.</summary>
        public static bool Available { get; private set; }

        public static void Apply(Harmony harmony, ILogger logger)
        {
            _logger = logger;

            var mapper = AccessTools.TypeByName("Jellyfin.Server.Implementations.Item.OrderMapper");
            var target = mapper?.GetMethod(
                "MapOrderByField",
                BindingFlags.Public | BindingFlags.Static,
                null,
                new[] { typeof(ItemSortBy), typeof(InternalItemsQuery), typeof(JellyfinDbContext) },
                null);

            if (target == null
                || !typeof(Expression<Func<BaseItemEntity, object>>).IsAssignableFrom(target.ReturnType))
            {
                Available = false;
                logger?.LogWarning(
                    "JellyfinPlus: could not resolve OrderMapper.MapOrderByField(ItemSortBy, InternalItemsQuery, "
                    + "JellyfinDbContext); the seeded Random sort ({Seed}) and the recently-edited sort ({Key}) are "
                    + "unavailable on this Jellyfin build. Stock sorting is unaffected.", SeedParam, SortKeyParam);
                return;
            }

            harmony.Patch(
                target,
                postfix: new HarmonyMethod(typeof(ListSortPatches).GetMethod(nameof(MapOrderByFieldPostfix), BindingFlags.Static | BindingFlags.NonPublic)));

            Available = true;
            logger?.LogInformation(
                "JellyfinPlus: patched OrderMapper.MapOrderByField (/Items honours {Seed} for Random and {Key}={Value})",
                SeedParam, SortKeyParam, RecentlyEditedValue);
        }

        /// <summary>The current request when it is an /Items listing, else null.</summary>
        private static HttpRequest ItemsRequest()
        {
            var request = _http.HttpContext?.Request;
            return request != null && request.Path.HasValue
                && request.Path.Value.EndsWith("/Items", StringComparison.OrdinalIgnoreCase)
                ? request
                : null;
        }

        /// <summary>A positive int from digits only, or null (absent, zero, negative, malformed, overflowing).</summary>
        internal static int? ParseSeed(string value)
            => int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var seed) && seed > 0 ? seed : null;

        internal static bool IsRecentlyEdited(string value)
            => string.Equals(value, RecentlyEditedValue, StringComparison.OrdinalIgnoreCase);

        private static void MapOrderByFieldPostfix(ItemSortBy sortBy, InternalItemsQuery query, ref Expression<Func<BaseItemEntity, object>> __result)
        {
            try
            {
                if ((sortBy != ItemSortBy.Random && sortBy != ItemSortBy.DateLastContentAdded)
                    || query == null || !string.IsNullOrEmpty(query.SearchTerm))
                {
                    return;
                }

                var request = ItemsRequest();
                if (request == null)
                {
                    return;
                }

                if (sortBy == ItemSortBy.Random)
                {
                    var seed = ParseSeed(request.Query.TryGetValue(SeedParam, out var seedValues) ? seedValues.FirstOrDefault() : null);
                    if (seed != null)
                    {
                        __result = BuildSeededKey(seed.Value);
                    }
                }
                else if (request.Query.TryGetValue(SortKeyParam, out var keyValues) && IsRecentlyEdited(keyValues.FirstOrDefault()))
                {
                    __result = BuildLastSavedKey();
                }
            }
            catch (Exception ex)
            {
                Warn(ex);
            }
        }

        /// <summary>The item's own DateLastSaved (null sorts first ascending, like every other nullable key).</summary>
        internal static Expression<Func<BaseItemEntity, object>> BuildLastSavedKey()
        {
            var e = Expression.Parameter(typeof(BaseItemEntity), "e");
            return Expression.Lambda<Func<BaseItemEntity, object>>(
                Expression.Convert(Expression.Property(e, nameof(BaseItemEntity.DateLastSaved)), typeof(object)),
                e);
        }

        // Positions travel as properties of a captured object, which EF turns into SQL parameters,
        // so the expression SHAPE (and EF's compiled-query cache entry) is the same for every seed.
        internal sealed class Positions
        {
            public int P0 { get; set; }
            public int P1 { get; set; }
            public int P2 { get; set; }
            public int P3 { get; set; }
            public int P4 { get; set; }
            public int P5 { get; set; }
            public int P6 { get; set; }
            public int P7 { get; set; }
            public int P8 { get; set; }
            public int P9 { get; set; }
            public int P10 { get; set; }
            public int P11 { get; set; }
            public int P12 { get; set; }
            public int P13 { get; set; }
            public int P14 { get; set; }
            public int P15 { get; set; }
        }

        /// <summary>
        /// The 16 character offsets (0-based, into the 36-character guid text) the key reads, in key
        /// order: a seeded Fisher-Yates over the 32 hex positions (the dashes sit at 8, 13, 18, 23), first 16.
        /// Pure function of the seed (SplitMix64), the same in every process.
        /// </summary>
        internal static int[] OffsetsFor(int seed)
        {
            var hex = new int[32];
            var n = 0;
            for (var i = 0; i < 36; i++)
            {
                if (i != 8 && i != 13 && i != 18 && i != 23)
                {
                    hex[n++] = i;
                }
            }

            ulong state = unchecked((ulong)seed * 0x9E3779B97F4A7C15UL);
            ulong Next()
            {
                unchecked
                {
                    state += 0x9E3779B97F4A7C15UL;
                    var z = state;
                    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9UL;
                    z = (z ^ (z >> 27)) * 0x94D049BB133111EBUL;
                    return z ^ (z >> 31);
                }
            }

            for (var i = hex.Length - 1; i > 0; i--)
            {
                var j = (int)(Next() % (ulong)(i + 1));
                (hex[i], hex[j]) = (hex[j], hex[i]);
            }

            return hex.Take(KeyDigits).ToArray();
        }

        /// <summary>C# mirror of the SQL key, for tests: the same digits in the same order.</summary>
        internal static string KeyOf(Guid id, int seed)
        {
            var text = id.ToString().ToUpperInvariant();
            return new string(OffsetsFor(seed).Select(o => text[o]).ToArray());
        }

        /// <summary>The seeded ORDER BY key: Id.ToString().Substring(p,1) joined with +.</summary>
        internal static Expression<Func<BaseItemEntity, object>> BuildSeededKey(int seed)
        {
            var offsets = OffsetsFor(seed);
            var holder = new Positions();
            for (var i = 0; i < KeyDigits; i++)
            {
                typeof(Positions).GetProperty("P" + i).SetValue(holder, offsets[i]);
            }

            var e = Expression.Parameter(typeof(BaseItemEntity), "e");
            var idText = Expression.Call(Expression.Property(e, nameof(BaseItemEntity.Id)), typeof(Guid).GetMethod(nameof(Guid.ToString), Type.EmptyTypes));
            var substring = typeof(string).GetMethod(nameof(string.Substring), new[] { typeof(int), typeof(int) });
            var concat = typeof(string).GetMethod(nameof(string.Concat), new[] { typeof(string), typeof(string) });
            var self = Expression.Constant(holder);
            var one = Expression.Constant(1);

            Expression key = null;
            for (var i = 0; i < KeyDigits; i++)
            {
                var digit = Expression.Call(idText, substring, Expression.Property(self, "P" + i), one);
                key = key == null ? digit : Expression.Call(concat, key, digit);
            }

            return Expression.Lambda<Func<BaseItemEntity, object>>(Expression.Convert(key, typeof(object)), e);
        }

        private static void Warn(Exception ex)
        {
            // Once: a persistent fault must not turn every sorted listing into a log line.
            if (_warned)
            {
                return;
            }

            _warned = true;
            _logger?.LogWarning(ex, "JellyfinPlus: list sort patch ({Seed} / {Key}) failed; the stock sort expression is used.", SeedParam, SortKeyParam);
        }
    }
}
