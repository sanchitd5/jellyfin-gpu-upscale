using System;
using System.Collections.Generic;
using System.Linq;
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

        // Each term is one more NOT EXISTS / EXISTS in the SQL, so what a request can ask is bounded.
        private const int MaxTerms = 100;
        private const int MaxTermLength = 200;

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
            if (request == null || !request.Path.HasValue || !request.Path.Value.EndsWith("/Items", StringComparison.OrdinalIgnoreCase))
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
        /// After the stock translation: with tagMatch=all and two or more tags, require every one
        /// of filter.Tags on top of the stock "any of them". The stock "tags" list the controller
        /// parsed is used as-is (not the locals TranslateQuery may add for IsSports / IsNews /
        /// IsKids), compared by the same clean value the stock filter uses.
        /// </summary>
        private static void TranslateQueryPostfix(InternalItemsQuery filter, ref IQueryable<BaseItemEntity> __result)
        {
            try
            {
                if (__result == null || filter == null || filter.Tags == null || filter.Tags.Length < 2)
                {
                    return;
                }

                var request = ItemsRequest();
                if (request == null || !ReadMatchAll(request))
                {
                    return;
                }

                var query = __result;
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

                __result = query;
            }
            catch (Exception ex)
            {
                Warn(ex);
            }
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
