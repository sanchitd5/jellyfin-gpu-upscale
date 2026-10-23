using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Linq.Expressions;
using System.Reflection;
using HarmonyLib;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Extensions;
using MediaBrowser.Controller.Entities;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Plus.Patcher
{
    /// <summary>
    /// Two extra tag filters for /Items library listings, driven by request parameters the stock
    /// web client never sends (the injected library filter panel does):
    ///
    /// - excludeTagNames: items carrying ANY of these tags are dropped. One tag name per parameter
    ///   value, taken verbatim (a name may contain commas or pipes), matched exactly after the same
    ///   GetCleanValue() normalisation Jellyfin applies to stored tags - the semantics of the
    ///   stock InternalItemsQuery.ExcludeTags, which is what is filled in.
    /// - tagMatch=all: the stock `tags` filter is an OR (an item with ANY listed tag); with this
    ///   it becomes an AND (an item with EVERY listed tag).
    ///
    /// THE SEAM. BaseItemRepository.TranslateQuery(IQueryable, JellyfinDbContext, InternalItemsQuery)
    /// is the one place every item listing and count (GetItems, GetItemsResult, the totals, the
    /// ItemCountService) turns an InternalItemsQuery into SQL, and it already understands
    /// ExcludeTags - ItemsController just has no parameter for it. Patching the controller instead
    /// would mean a prefix on a 90-parameter action that builds the query internally, with no
    /// handle on it; this method takes the query as an argument.
    ///
    /// - EXCLUDE is a PREFIX: it widens filter.ExcludeTags with the request's terms and lets the
    ///   stock code build the NOT EXISTS, so there is no second implementation of the predicate.
    /// - AND is a POSTFIX: the stock OR over filter.Tags has already been applied to the returned
    ///   query, and each tag is then required additionally. (OR AND each-tag) equals AND, so the
    ///   postfix can only narrow what the stock query returned. The stock query is not rewritten.
    ///
    /// - jpTagAnyOf (repeatable): one parameter value per group, tag names joined by '|'. The item must
    ///   carry at least one tag of EACH group (OR inside a group, AND between groups). Same postfix.
    ///
    /// THREE MORE NARROWING FILTERS, same postfix, same request scoping (any /Items request, only when
    /// the parameter is present): jpMinRuntime/jpMaxRuntime (whole minutes, inclusive, on
    /// RunTimeTicks; an item with no runtime matches neither), jpMinDateAdded/jpMaxDateAdded
    /// (YYYY-MM-DD, inclusive by UTC day, on DateCreated) and jpResolution (comma list of sd, hd, 4k;
    /// an item matches if it falls in ANY listed bucket). The resolution buckets are the stock
    /// isHd/is4K ones, copied from BaseItemRepository.TranslateQuery on 12.1 (identical on 12.3) so that this filter and
    /// the stock one agree: sd = width in (0, 1200), hd = width >= 1200 and not 4K, 4k = width >= 3800
    /// or height >= 2100, where an item's resolution is the best any of its versions offers and a
    /// folder (series, box set) answers on its children. A malformed value is ignored (never
    /// widens, never errors).
    ///
    /// NEITHER CAN WIDEN A RESULT, and neither touches user-access filtering: that is a separate
    /// step (ApplyAccessFiltering) on the same query. Both only ever add Where clauses.
    ///
    /// SCOPE. Acts only on a request whose path ends in /Items and that carries one of the two
    /// parameters; a client that never sends them sees no change at all. A failure in the patch
    /// leaves the query exactly as the stock code built it (logged once).
    /// </summary>
    internal static class LibraryFilterPatches
    {
        public const string ExcludeParam = "excludeTagNames";
        public const string MatchParam = "tagMatch";
        public const string MinRuntimeParam = "jpMinRuntime";
        public const string MaxRuntimeParam = "jpMaxRuntime";
        public const string MinAddedParam = "jpMinDateAdded";
        public const string MaxAddedParam = "jpMaxDateAdded";
        public const string ResolutionParam = "jpResolution";
        public const string TagAnyOfParam = "jpTagAnyOf";

        // Stock TranslateQuery's isHd / is4K thresholds (12.1; identical on 12.3).
        private const int HDWidth = 1200;
        private const int UHDWidth = 3800;
        private const int UHDHeight = 2100;
        private const long TicksPerMinute = TimeSpan.TicksPerMinute;

        // Each term is one more NOT EXISTS / EXISTS in the SQL, so what a request can ask is bounded.
        private const int MaxTerms = 100;
        private const int MaxTermLength = 200;

        // jpTagAnyOf: each group is one more EXISTS, each name one more IN member.
        private const int MaxAnyOfGroups = 10;
        private const int MaxAnyOfNames = 100;

        // Same static-AsyncLocal trick as SearchPatches: a fresh accessor reads the current context.
        private static readonly HttpContextAccessor _http = new HttpContextAccessor();

        private static ILogger _logger;
        private static bool _warned;

        /// <summary>True once TranslateQuery was resolved and patched.</summary>
        public static bool Available { get; private set; }

        public static void Apply(Harmony harmony, ILogger logger)
        {
            _logger = logger;

            // Resolved BY NAME, like MediaInfoHelper and SqlSearchProvider: no compile-time
            // reference to Jellyfin.Server.Implementations to be version-pinned to.
            var repository = AccessTools.TypeByName("Jellyfin.Server.Implementations.Item.BaseItemRepository");
            var target = repository == null
                ? null
                : AccessTools.GetDeclaredMethods(repository).FirstOrDefault(IsTranslateQuery);

            if (target == null)
            {
                Available = false;
                logger?.LogWarning(
                    "JellyfinPlus: could not resolve BaseItemRepository.TranslateQuery(IQueryable<BaseItemEntity>, "
                    + "JellyfinDbContext, InternalItemsQuery); the library tag exclude / match-all filters are "
                    + "unavailable on this Jellyfin build. Stock library listing is unaffected.");
                return;
            }

            harmony.Patch(
                target,
                prefix: new HarmonyMethod(typeof(LibraryFilterPatches).GetMethod(nameof(TranslateQueryPrefix), BindingFlags.Static | BindingFlags.NonPublic)),
                postfix: new HarmonyMethod(typeof(LibraryFilterPatches).GetMethod(nameof(TranslateQueryPostfix), BindingFlags.Static | BindingFlags.NonPublic)));

            Available = true;
            logger?.LogInformation("JellyfinPlus: patched BaseItemRepository.TranslateQuery (/Items honours {Exclude} and {Match}=all)", ExcludeParam, MatchParam);
        }

        // The exact shape, so a future overload or a changed signature fails soft instead of
        // patching the wrong method.
        private static bool IsTranslateQuery(MethodInfo m)
        {
            if (m.Name != "TranslateQuery")
            {
                return false;
            }

            var p = m.GetParameters();
            return p.Length == 3
                && p[0].ParameterType == typeof(IQueryable<BaseItemEntity>)
                && p[1].ParameterType == typeof(JellyfinDbContext)
                && p[2].ParameterType == typeof(InternalItemsQuery)
                && m.ReturnType == typeof(IQueryable<BaseItemEntity>);
        }

        /// <summary>The request, when it is an /Items listing that carries one of our parameters.</summary>
        private static HttpRequest ItemsRequest()
        {
            var request = _http.HttpContext?.Request;
            if (request == null || !request.Path.HasValue
                || !(request.Path.Value.EndsWith("/Items", StringComparison.OrdinalIgnoreCase)
                    // The search page's facet lists (SearchFacetsController) are computed over the same
                    // filtered result set, so the same narrowing filters must apply to them.
                    || request.Path.Value.EndsWith("/Search/Facets", StringComparison.OrdinalIgnoreCase)))
            {
                return null;
            }

            return request;
        }

        private static string[] ReadExcludes(HttpRequest request)
        {
            if (!request.Query.TryGetValue(ExcludeParam, out var values))
            {
                return Array.Empty<string>();
            }

            return values
                .Where(v => !string.IsNullOrWhiteSpace(v))
                .Select(v => v.Trim())
                .Where(v => v.Length <= MaxTermLength)
                .Distinct(StringComparer.Ordinal)
                .Take(MaxTerms)
                .ToArray();
        }

        private static bool ReadMatchAll(HttpRequest request)
            => request.Query.TryGetValue(MatchParam, out var values)
                && values.Any(v => string.Equals(v, "all", StringComparison.OrdinalIgnoreCase));

        /// <summary>
        /// Before the stock translation: fold the request's exclude terms into filter.ExcludeTags.
        /// Union only - whatever the caller or the user's own restrictions already put there stays.
        /// </summary>
        private static void TranslateQueryPrefix(InternalItemsQuery filter)
        {
            try
            {
                var request = filter == null ? null : ItemsRequest();
                if (request == null)
                {
                    return;
                }

                var excludes = ReadExcludes(request);
                if (excludes.Length == 0)
                {
                    return;
                }

                filter.ExcludeTags = (filter.ExcludeTags ?? Array.Empty<string>())
                    .Union(excludes, StringComparer.Ordinal)
                    .ToArray();
            }
            catch (Exception ex)
            {
                Warn(ex);
            }
        }

        /// <summary>
        /// After the stock translation, narrow further: with tagMatch=all and two or more tags,
        /// require every one of filter.Tags on top of the stock "any of them" (the stock "tags" list the
        /// controller parsed is used as-is, not the locals TranslateQuery may add for IsSports / IsNews /
        /// IsKids, compared by the same clean value the stock filter uses); then the jp* runtime,
        /// date-added and resolution ranges. Each is a Where on the stock query, nothing else.
        /// </summary>
        private static void TranslateQueryPostfix(JellyfinDbContext context, InternalItemsQuery filter, ref IQueryable<BaseItemEntity> __result)
        {
            try
            {
                if (__result == null || filter == null)
                {
                    return;
                }

                var request = ItemsRequest();
                if (request == null)
                {
                    return;
                }

                var query = __result;
                query = MatchAll(query, filter, request);
                query = TagAnyOf(query, request);
                query = RuntimeRange(query, request);
                query = DateAddedRange(query, request);
                query = Resolution(query, context, request);
                __result = query;
            }
            catch (Exception ex)
            {
                Warn(ex);
            }
        }

        private static IQueryable<BaseItemEntity> MatchAll(IQueryable<BaseItemEntity> query, InternalItemsQuery filter, HttpRequest request)
        {
            if (filter.Tags == null || filter.Tags.Length < 2 || !ReadMatchAll(request))
            {
                return query;
            }

            foreach (var tag in filter.Tags
                .Where(t => !string.IsNullOrWhiteSpace(t))
                .Select(t => t.GetCleanValue())
                .Where(t => !string.IsNullOrEmpty(t))
                .Distinct(StringComparer.Ordinal)
                .Take(MaxTerms))
            {
                // A fresh local per iteration: the expression captures the variable, not its value.
                var t = tag;
                query = query.Where(e => e.ItemValues!.Any(v => v.ItemValue.Type == ItemValueType.Tags
                    && v.ItemValue.CleanValue == t));
            }

            return query;
        }

        /// <summary>
        /// jpTagAnyOf: one parameter value per group, tag names separated by '|'. The item must carry at
        /// least one tag of EACH group (OR inside a group, AND between groups). Names are cleaned the way
        /// stored tags are. A group with no usable name is ignored; a name over the length cap is dropped;
        /// groups and names past the caps are not read. Only ever a Where, so it only narrows.
        /// </summary>
        internal static string[][] ParseTagAnyOf(IEnumerable<string> values)
        {
            var groups = new List<string[]>();
            foreach (var value in values ?? Array.Empty<string>())
            {
                if (string.IsNullOrWhiteSpace(value))
                {
                    continue;
                }

                var names = value.Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .Where(n => n.Length <= MaxTermLength)
                    .Select(n => n.GetCleanValue())
                    .Where(n => !string.IsNullOrEmpty(n))
                    .Distinct(StringComparer.Ordinal)
                    .Take(MaxAnyOfNames)
                    .ToArray();
                if (names.Length > 0)
                {
                    groups.Add(names);
                }

                if (groups.Count >= MaxAnyOfGroups)
                {
                    break;
                }
            }

            return groups.ToArray();
        }

        private static IQueryable<BaseItemEntity> TagAnyOf(IQueryable<BaseItemEntity> query, HttpRequest request)
        {
            if (!request.Query.TryGetValue(TagAnyOfParam, out var values))
            {
                return query;
            }

            foreach (var group in ParseTagAnyOf(values))
            {
                // A fresh local per iteration: the expression captures the variable, not its value.
                var names = group;
                query = query.Where(e => e.ItemValues!.Any(v => v.ItemValue.Type == ItemValueType.Tags
                    && names.Contains(v.ItemValue.CleanValue)));
            }

            return query;
        }

        /// <summary>A whole non-negative number of minutes as ticks, or null when absent or malformed.</summary>
        internal static long? ParseMinutes(HttpRequest request, string name)
        {
            if (!request.Query.TryGetValue(name, out var values)
                || !int.TryParse(values.FirstOrDefault(), NumberStyles.None, CultureInfo.InvariantCulture, out var minutes))
            {
                return null;
            }

            return minutes * TicksPerMinute;
        }

        private static IQueryable<BaseItemEntity> RuntimeRange(IQueryable<BaseItemEntity> query, HttpRequest request)
        {
            var min = ParseMinutes(request, MinRuntimeParam);
            var max = ParseMinutes(request, MaxRuntimeParam);
            if (min.HasValue)
            {
                var lo = min.Value;
                query = query.Where(e => e.RunTimeTicks != null && e.RunTimeTicks >= lo);
            }

            if (max.HasValue)
            {
                var hi = max.Value;
                query = query.Where(e => e.RunTimeTicks != null && e.RunTimeTicks <= hi);
            }

            return query;
        }

        /// <summary>A UTC midnight from YYYY-MM-DD, or null when absent or malformed.</summary>
        internal static DateTime? ParseDay(HttpRequest request, string name)
        {
            if (request.Query.TryGetValue(name, out var values)
                && DateTime.TryParseExact(values.FirstOrDefault(), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day))
            {
                return DateTime.SpecifyKind(day.Date, DateTimeKind.Utc);
            }

            return null;
        }

        private static IQueryable<BaseItemEntity> DateAddedRange(IQueryable<BaseItemEntity> query, HttpRequest request)
        {
            var min = ParseDay(request, MinAddedParam);
            var max = ParseDay(request, MaxAddedParam);
            if (min.HasValue)
            {
                var lo = min.Value;
                query = query.Where(e => e.DateCreated != null && e.DateCreated >= lo);
            }

            // Inclusive by day: strictly before the next midnight. The last representable day has no
            // next one, so it only requires a known date.
            if (max.HasValue)
            {
                if (max.Value.Date < DateTime.MaxValue.Date)
                {
                    var hiExclusive = max.Value.AddDays(1);
                    query = query.Where(e => e.DateCreated != null && e.DateCreated < hiExclusive);
                }
                else
                {
                    query = query.Where(e => e.DateCreated != null);
                }
            }

            return query;
        }

        /// <summary>Which of sd / hd / 4k the request lists; all false when absent or nothing valid.</summary>
        internal static (bool Sd, bool Hd, bool Uhd) ParseResolution(HttpRequest request)
        {
            bool sd = false, hd = false, uhd = false;
            if (request.Query.TryGetValue(ResolutionParam, out var values))
            {
                foreach (var token in values
                    .Where(v => !string.IsNullOrEmpty(v))
                    .SelectMany(v => v.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)))
                {
                    sd |= string.Equals(token, "sd", StringComparison.OrdinalIgnoreCase);
                    hd |= string.Equals(token, "hd", StringComparison.OrdinalIgnoreCase);
                    uhd |= string.Equals(token, "4k", StringComparison.OrdinalIgnoreCase);
                }
            }

            return (sd, hd, uhd);
        }

        private static IQueryable<Guid> VersionsMatching(JellyfinDbContext context, Expression<Func<BaseItemEntity, bool>> bound)
            => context.BaseItems
                .Where(v => v.PrimaryVersionId != null)
                .Where(bound)
                .Select(v => v.PrimaryVersionId!.Value);

        /// <summary>
        /// The stock isHd / is4K predicate (BaseItemRepository.TranslateQuery, 12.1; identical on 12.3) with the three
        /// buckets OR-ed instead of limited to what the two nullable flags can express. Kept in the
        /// stock shape on purpose, so the two cannot drift apart without it being obvious.
        /// </summary>
        private static IQueryable<BaseItemEntity> Resolution(IQueryable<BaseItemEntity> query, JellyfinDbContext context, HttpRequest request)
        {
            var (includeSD, includeHD, include4K) = ParseResolution(request);
            if (!includeSD && !includeHD && !include4K)
            {
                return query;
            }

            var versionsSd = VersionsMatching(context, v => v.Width > 0 && v.Width < HDWidth);
            var versionsHd = VersionsMatching(context, v => v.Width >= HDWidth);
            var versions4K = VersionsMatching(context, v => v.Width >= UHDWidth || v.Height >= UHDHeight);

            return query.Where(e =>
                (!e.IsFolder
                    && ((includeSD
                            && ((e.Width > 0 && e.Width < HDWidth) || versionsSd.Contains(e.Id))
                            && !versionsHd.Contains(e.Id)
                            && !versions4K.Contains(e.Id))
                        || (includeHD
                            && (e.Width >= HDWidth || versionsHd.Contains(e.Id))
                            && !(e.Width >= UHDWidth || e.Height >= UHDHeight)
                            && !versions4K.Contains(e.Id))
                        || (include4K
                            && (e.Width >= UHDWidth || e.Height >= UHDHeight || versions4K.Contains(e.Id)))))
                || (e.IsFolder
                    && (e.Children!.Any(a =>
                            (includeSD
                                && ((a.Item.Width > 0 && a.Item.Width < HDWidth) || versionsSd.Contains(a.ItemId))
                                && !versionsHd.Contains(a.ItemId)
                                && !versions4K.Contains(a.ItemId))
                            || (includeHD
                                && (a.Item.Width >= HDWidth || versionsHd.Contains(a.ItemId))
                                && !(a.Item.Width >= UHDWidth || a.Item.Height >= UHDHeight)
                                && !versions4K.Contains(a.ItemId))
                            || (include4K
                                && (a.Item.Width >= UHDWidth || a.Item.Height >= UHDHeight || versions4K.Contains(a.ItemId))))
                        || context.LinkedChildren.Any(lc =>
                            lc.ParentId == e.Id
                            && ((includeSD
                                    && ((lc.Child!.Width > 0 && lc.Child!.Width < HDWidth) || versionsSd.Contains(lc.ChildId))
                                    && !versionsHd.Contains(lc.ChildId)
                                    && !versions4K.Contains(lc.ChildId))
                                || (includeHD
                                    && (lc.Child!.Width >= HDWidth || versionsHd.Contains(lc.ChildId))
                                    && !(lc.Child!.Width >= UHDWidth || lc.Child!.Height >= UHDHeight)
                                    && !versions4K.Contains(lc.ChildId))
                                || (include4K
                                    && (lc.Child!.Width >= UHDWidth || lc.Child!.Height >= UHDHeight || versions4K.Contains(lc.ChildId))))))));
        }

        private static void Warn(Exception ex)
        {
            // Once: a persistent fault must not turn every library request into a log line.
            if (_warned)
            {
                return;
            }

            _warned = true;
            _logger?.LogWarning(ex, "JellyfinPlus: library tag filter ({Exclude} / {Match}) failed; the listing is returned as stock built it.", ExcludeParam, MatchParam);
        }
    }
}
