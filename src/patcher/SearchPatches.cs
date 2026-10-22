using System;
using System.Collections.Generic;
using System.Linq;
using System.Linq.Expressions;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using HarmonyLib;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Extensions;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.GpuUpscale.Patcher
{
    /// <summary>
    /// Makes library search match item tags as well as names, and lets a search EXCLUDE items by
    /// tag:
    ///
    /// - include: an item whose tag CONTAINS the search term (tag.includes(term)) is returned
    ///   alongside the stock name matches;
    /// - exclude: the request's excludeTags terms. A tag match counts only through a tag that
    ///   contains the search term and none of the exclude terms (TagMatch); a name match is dropped
    ///   if any of its tags contains an exclude term (WithoutAnyExcludedTag).
    ///
    /// Both are case- and diacritic-insensitive: terms go through the same GetCleanValue() that
    /// Jellyfin stores in ItemValues.CleanValue (lowercase, diacritics stripped, punctuation to
    /// spaces), so Contains on the two is a case-insensitive substring match that translates to SQL.
    ///
    /// THE SEAM. On Jellyfin 12.1 both /Items?searchTerm= (the web client's search page) and
    /// /Search/Hints go through SearchManager.GetSearchResultsAsync, whose built-in fallback provider
    /// is Emby.Server.Implementations.Library.Search.SqlSearchProvider. Its SearchAsync filters on
    /// CleanName and OriginalTitle only. A plugin-registered IInternalSearchProvider would be the
    /// cleaner extension point, but the user-access filter it would need (SearchQueryAccessFilter)
    /// is internal - re-implementing it is how a search leaks items from libraries a user cannot
    /// see. So this postfixes SqlSearchProvider.SearchAsync instead and builds the tag query through
    /// the provider's OWN private type/media/parent/access/version filters, so a tag match is
    /// subject to exactly the restrictions a name match is.
    ///
    /// THE EXCLUDE TERMS have no slot on SearchProviderQuery, so they are read from the request
    /// itself: the "excludeTags" query parameter (comma- or pipe-separated), which the injected
    /// search-page box appends. A client that never sends it sees no change at all.
    ///
    /// Total, like every other patch here: if the tag query fails for any reason the stock name
    /// results are returned unchanged. Search must never get worse because of this patch.
    /// </summary>
    internal static class SearchPatches
    {
        /// <summary>The request query parameter carrying the exclude terms.</summary>
        public const string ExcludeParam = "excludeTags";

        // Below stock ContainsMatchScore (50): a title match outranks a tag-only match.
        private const float TagMatchScore = 40f;

        // Mirrors SqlSearchProvider.DefaultSearchLimit / _placeholderId on 12.1.
        private const int DefaultSearchLimit = 100;
        private static readonly Guid _placeholderId = Guid.Parse("00000000-0000-0000-0000-000000000001");

        // Bounds on what a request can make the server do: each term is one more NOT EXISTS in
        // the SQL, so the count is capped, and so is each term's length.
        private const int MaxExcludeTerms = 20;
        private const int MaxExcludeTermLength = 100;

        // HttpContextAccessor keeps the current context in a static AsyncLocal, so a fresh instance
        // reads the same context the DI-registered one would (Jellyfin calls AddHttpContextAccessor).
        private static readonly HttpContextAccessor _http = new HttpContextAccessor();

        private static ILogger _logger;
        private static FieldInfo _dbProvider;
        private static MethodInfo _applyTypeFilter;
        private static MethodInfo _applyMediaTypeFilter;
        private static MethodInfo _applyParentFilter;
        private static MethodInfo _applyUserAccessFilter;
        private static MethodInfo _excludeVersions;

        /// <summary>True once the target and every helper it reuses were resolved and patched.</summary>
        public static bool Available { get; private set; }

        public static void Apply(Harmony harmony, ILogger logger)
        {
            _logger = logger;

            // Resolved BY NAME, like MediaInfoHelper: no compile-time reference to
            // Emby.Server.Implementations to be version-pinned to.
            var provider = AccessTools.TypeByName("Emby.Server.Implementations.Library.Search.SqlSearchProvider");
            var target = provider == null
                ? null
                : AccessTools.Method(provider, "SearchAsync", new[] { typeof(SearchProviderQuery), typeof(CancellationToken) });

            if (provider != null)
            {
                _dbProvider = AccessTools.Field(provider, "_dbProvider");
                _applyTypeFilter = AccessTools.Method(provider, "ApplyTypeFilter");
                _applyMediaTypeFilter = AccessTools.Method(provider, "ApplyMediaTypeFilter");
                _applyParentFilter = AccessTools.Method(provider, "ApplyParentFilter");
                _applyUserAccessFilter = AccessTools.Method(provider, "ApplyUserAccessFilter");
                _excludeVersions = AccessTools.Method(provider, "ExcludeVersionsOfMatchedPrimaries");
            }

            var missing = new List<string>();
            if (provider == null)
            {
                missing.Add("SqlSearchProvider");
            }
            else
            {
                if (target == null)
                {
                    missing.Add("SearchAsync");
                }

                if (_dbProvider == null)
                {
                    missing.Add("_dbProvider");
                }

                if (_applyTypeFilter == null)
                {
                    missing.Add("ApplyTypeFilter");
                }

                if (_applyMediaTypeFilter == null)
                {
                    missing.Add("ApplyMediaTypeFilter");
                }

                if (_applyParentFilter == null)
                {
                    missing.Add("ApplyParentFilter");
                }

                // The access filter is the one that must never be skipped: without it a tag match
                // could surface an item from a library the user is not allowed to see.
                if (_applyUserAccessFilter == null)
                {
                    missing.Add("ApplyUserAccessFilter");
                }

                if (_excludeVersions == null)
                {
                    missing.Add("ExcludeVersionsOfMatchedPrimaries");
                }
            }

            if (missing.Count > 0)
            {
                Available = false;
                logger?.LogWarning(
                    "GpuUpscale: could not resolve SqlSearchProvider member(s) {Missing}; tag search is "
                    + "unavailable on this Jellyfin build. Stock name search is unaffected.",
                    string.Join(", ", missing));
                return;
            }

            harmony.Patch(
                target,
                postfix: new HarmonyMethod(typeof(SearchPatches).GetMethod(nameof(SearchAsyncPostfix), BindingFlags.Static | BindingFlags.NonPublic)));

            Available = true;
            logger?.LogInformation("GpuUpscale: patched SqlSearchProvider.SearchAsync (search also matches tags; excludeTags honoured)");
        }

        /// <summary>
        /// SearchAsync is async, so the patched method is the stub that returns the Task. The
        /// postfix wraps that Task rather than blocking on it. The exclude terms are read here,
        /// synchronously on the request's own flow, before anything is awaited.
        /// </summary>
        private static void SearchAsyncPostfix(
            object __instance,
            SearchProviderQuery query,
            CancellationToken cancellationToken,
            ref Task<IReadOnlyList<SearchResult>> __result)
        {
            if (__instance == null || query == null || __result == null)
            {
                return;
            }

            string[] excludes;
            try
            {
                excludes = ReadExcludes();
            }
            catch (Exception ex)
            {
                _logger?.LogWarning(ex, "GpuUpscale: could not read {Param}; searching without exclusions.", ExcludeParam);
                excludes = Array.Empty<string>();
            }

            __result = WithTagMatches(__instance, query, excludes, __result, cancellationToken);
        }

        /// <summary>
        /// The request's excludeTags terms, cleaned exactly as stored tags are. Split BEFORE
        /// cleaning, because cleaning turns the separators into spaces.
        /// </summary>
        private static string[] ReadExcludes()
        {
            var request = _http.HttpContext?.Request;
            if (request == null || !request.Query.TryGetValue(ExcludeParam, out var values))
            {
                return Array.Empty<string>();
            }

            return values
                .Where(v => !string.IsNullOrEmpty(v))
                .SelectMany(v => v.Split(new[] { ',', '|' }, StringSplitOptions.RemoveEmptyEntries))
                .Select(t => t.Trim())
                .Where(t => t.Length > 0 && t.Length <= MaxExcludeTermLength)
                .Select(t => t.GetCleanValue())
                .Where(t => !string.IsNullOrEmpty(t))
                .Distinct(StringComparer.Ordinal)
                .Take(MaxExcludeTerms)
                .ToArray();
        }

        /// <summary>Holds a value so EF Core sends it as a SQL parameter rather than an inlined literal.</summary>
        private sealed class Param
        {
            public Param(string value) => Value = value;

            public string Value { get; }
        }

        private static readonly MethodInfo _stringContains = typeof(string).GetMethod(nameof(string.Contains), new[] { typeof(string) });

        /// <summary>
        /// The per-TAG test for a tag match: the tag contains the search term and none of the
        /// exclude terms. Exclusion therefore applies to the tag that matched, not the whole item:
        /// searching "cat" with "red" excluded drops a match on the tag "red cat" but keeps one on
        /// "black cat", even when that same item also carries some other tag containing "red".
        /// Built as one expression so it stays a single EXISTS in SQL, with one NOT LIKE per term.
        /// </summary>
        private static Expression<Func<ItemValueMap, bool>> TagMatch(string search, string[] excludes)
        {
            var v = Expression.Parameter(typeof(ItemValueMap), "v");
            var itemValue = Expression.Property(v, nameof(ItemValueMap.ItemValue));
            var cleanValue = Expression.Property(itemValue, nameof(ItemValue.CleanValue));

            Expression ContainsParam(string s) => Expression.Call(
                cleanValue,
                _stringContains,
                Expression.Property(Expression.Constant(new Param(s)), nameof(Param.Value)));

            Expression body = Expression.AndAlso(
                Expression.Equal(Expression.Property(itemValue, nameof(ItemValue.Type)), Expression.Constant(ItemValueType.Tags)),
                ContainsParam(search));
            foreach (var term in excludes)
            {
                body = Expression.AndAlso(body, Expression.Not(ContainsParam(term)));
            }

            return Expression.Lambda<Func<ItemValueMap, bool>>(body, v);
        }

        /// <summary>
        /// For NAME matches, which have no matching tag to judge: drops an item with any tag
        /// containing any of the exclude terms. (If the item also has a tag passing TagMatch it is
        /// still returned, via the tag query.)
        /// </summary>
        private static IQueryable<BaseItemEntity> WithoutAnyExcludedTag(IQueryable<BaseItemEntity> query, string[] excludes)
        {
            foreach (var term in excludes)
            {
                // A fresh local per iteration: the expression captures the variable, not its value.
                var t = term;
                query = query.Where(e => !e.ItemValues.Any(v => v.ItemValue.Type == ItemValueType.Tags
                    && v.ItemValue.CleanValue.Contains(t)));
            }

            return query;
        }

        private static async Task<IReadOnlyList<SearchResult>> WithTagMatches(
            object provider,
            SearchProviderQuery query,
            string[] excludes,
            Task<IReadOnlyList<SearchResult>> original,
            CancellationToken cancellationToken)
        {
            // The stock result, and any exception it throws, pass through exactly as before.
            var nameResults = await original.ConfigureAwait(false);

            try
            {
                // Same normalisation the stock provider applies to the term.
                var raw = query.SearchTerm?.Trim().RemoveDiacritics();
                var clean = string.IsNullOrEmpty(raw) ? null : raw.GetCleanValue();
                if (string.IsNullOrEmpty(clean))
                {
                    return nameResults;
                }

                var limit = query.Limit ?? DefaultSearchLimit;
                var factory = (IDbContextFactory<JellyfinDbContext>)_dbProvider.GetValue(provider);
                if (factory == null)
                {
                    return nameResults;
                }

                Guid[] tagIds;
                IReadOnlyList<SearchResult> keptNames = nameResults;
                var dbContext = await factory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
                await using (dbContext.ConfigureAwait(false))
                {
                    var tagMatch = TagMatch(clean, excludes);
                    IQueryable<BaseItemEntity> dbQuery = dbContext.BaseItems
                        .AsNoTracking()
                        .Where(e => e.Id != _placeholderId)
                        .Where(e => !e.IsVirtualItem)
                        .Where(e => e.ItemValues!.AsQueryable().Any(tagMatch));

                    dbQuery = (IQueryable<BaseItemEntity>)_applyTypeFilter.Invoke(provider, new object[] { dbQuery, query.IncludeItemTypes, query.ExcludeItemTypes });
                    dbQuery = (IQueryable<BaseItemEntity>)_applyMediaTypeFilter.Invoke(null, new object[] { dbQuery, query.MediaTypes });
                    dbQuery = (IQueryable<BaseItemEntity>)_applyParentFilter.Invoke(null, new object[] { dbQuery, query.ParentId });
                    dbQuery = (IQueryable<BaseItemEntity>)_applyUserAccessFilter.Invoke(provider, new object[] { dbContext, dbQuery, query });
                    dbQuery = (IQueryable<BaseItemEntity>)_excludeVersions.Invoke(null, new object[] { dbQuery });

                    tagIds = await dbQuery
                        .OrderBy(e => e.Id)
                        .Select(e => e.Id)
                        .Take(limit)
                        .ToArrayAsync(cancellationToken)
                        .ConfigureAwait(false);

                    // The stock name matches are excluded by any tag containing an exclude term.
                    // They were already access-filtered by the stock query, so only the tag test
                    // is applied here.
                    if (excludes.Length > 0 && nameResults.Count > 0)
                    {
                        var nameIds = nameResults.Select(r => r.ItemId).ToArray();
                        var keep = (await WithoutAnyExcludedTag(
                                dbContext.BaseItems.AsNoTracking().Where(e => nameIds.Contains(e.Id)),
                                excludes)
                            .Select(e => e.Id)
                            .ToArrayAsync(cancellationToken)
                            .ConfigureAwait(false))
                            .ToHashSet();
                        keptNames = nameResults.Where(r => keep.Contains(r.ItemId)).ToArray();
                    }
                }

                // A name match keeps its own (higher) score - also when it was excluded as a name
                // match but came back through a qualifying tag; a tag-only match gets TagMatchScore.
                var nameScores = new Dictionary<Guid, float>();
                foreach (var r in nameResults)
                {
                    nameScores[r.ItemId] = r.Score;
                }

                var scores = new Dictionary<Guid, float>();
                foreach (var r in keptNames)
                {
                    scores[r.ItemId] = r.Score;
                }

                foreach (var id in tagIds)
                {
                    scores.TryAdd(id, nameScores.TryGetValue(id, out var s) ? s : TagMatchScore);
                }

                if (scores.Count == 0 && excludes.Length > 0 && nameResults.Count > 0)
                {
                    // Every name match was excluded. An empty list here would make ItemsController fall
                    // back to its own name-only SearchTerm query, which knows nothing of the
                    // exclusion and would bring the excluded items straight back. One id that no
                    // item has keeps the result non-empty and loads nothing.
                    return new[] { new SearchResult(Guid.Empty, 0f) };
                }

                if (tagIds.Length == 0 && keptNames.Count == nameResults.Count)
                {
                    return nameResults;
                }

                return scores
                    .Select(kv => new SearchResult(kv.Key, kv.Value))
                    .OrderByDescending(r => r.Score)
                    .ThenBy(r => r.ItemId)
                    .Take(limit)
                    .ToArray();
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger?.LogWarning(ex, "GpuUpscale: tag search failed; returning name matches only, without exclusions.");
                return nameResults;
            }
        }
    }
}
