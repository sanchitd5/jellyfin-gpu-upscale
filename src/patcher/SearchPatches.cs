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
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Plus.Patcher
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
    /// THE SEAM. On Jellyfin 12.3 (as on 12.1) both /Items?searchTerm= (the web client's search page) and
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

        // Mirrors SqlSearchProvider.DefaultSearchLimit / _placeholderId (12.3; unchanged since 12.1).
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
                    "JellyfinPlus: could not resolve SqlSearchProvider member(s) {Missing}; tag search is "
                    + "unavailable on this Jellyfin build. Stock name search is unaffected.",
                    string.Join(", ", missing));
                return;
            }

            harmony.Patch(
                target,
                prefix: new HarmonyMethod(typeof(SearchPatches).GetMethod(nameof(SearchAsyncPrefix), BindingFlags.Static | BindingFlags.NonPublic)),
                postfix: new HarmonyMethod(typeof(SearchPatches).GetMethod(nameof(SearchAsyncPostfix), BindingFlags.Static | BindingFlags.NonPublic)));

            Available = true;
            logger?.LogInformation("JellyfinPlus: patched SqlSearchProvider.SearchAsync (search also matches tags; excludeTags honoured)");
        }

        // Mirrors SqlSearchProvider's score tiers (12.3; unchanged since 12.1).
        private const float ExactMatchScore = 100f;
        private const float PrefixMatchScore = 80f;
        private const float WordPrefixMatchScore = 75f;
        private const float ContainsMatchScore = 50f;

        /// <summary>
        /// THE NAME MATCH THROUGH THE FTS INDEX. When <see cref="FtsIndexEngine"/> is usable (built, verified,
        /// nothing pending) and the term is one a trigram index can answer, the stock query is replaced by the SAME
        /// query with one extra condition: the id is among the index's candidates for the term. The candidates are
        /// a superset of the stock predicate's matches (see FtsIndexEngine), and the stock predicate, the provider's
        /// own filters, the version exclusion and the score are all kept, so the result is the stock result. The
        /// extra condition sits directly after the name predicate, i.e. inside the set the version exclusion
        /// compares against, which a superset leaves unchanged. Anything else (index off or stale, a short term,
        /// a term with LIKE wildcards, too many candidates, any error) takes the unchanged stock path.
        /// </summary>
        private static bool SearchAsyncPrefix(
            object __instance,
            SearchProviderQuery query,
            CancellationToken cancellationToken,
            ref Task<IReadOnlyList<SearchResult>> __result)
        {
            try
            {
                if (__instance == null || query == null || string.IsNullOrWhiteSpace(query.SearchTerm))
                {
                    return true;
                }

                // Same normalisation the stock provider applies to the term.
                var raw = query.SearchTerm.Trim().RemoveDiacritics();

                // A wildcard term: the stock query would search the mangled literal; the postfix computes the real matches.
                if (!string.IsNullOrEmpty(raw) && WildPattern.Parse(raw, out _) != null)
                {
                    __result = Task.FromResult<IReadOnlyList<SearchResult>>(Array.Empty<SearchResult>());
                    return false;
                }

                if (!FtsIndexEngine.Usable)
                {
                    return true;
                }

                var clean = string.IsNullOrEmpty(raw) ? null : raw.GetCleanValue();
                if (string.IsNullOrEmpty(clean))
                {
                    return true;
                }

                var sortShape = SortNameShape(raw);
                if (!FtsIndexEngine.CanAnswer(clean, raw, sortShape))
                {
                    return true;
                }

                __result = FtsNameSearch(__instance, query, raw, clean, sortShape, cancellationToken);
                return false;
            }
            catch (Exception ex)
            {
                _logger?.LogWarning(ex, "JellyfinPlus: FTS name search could not start; using the stock query.");
                return true;
            }
        }

        /// <summary>
        /// The SortName operand of Jellyfin 12.3's name match: SqlSearchProvider computes
        /// BaseItem.GetSortName(term, true, server configuration) and tests SortName LIKE %shape% only when that
        /// is not blank. Null when stock adds no SortName test. BaseItem.ConfigurationManager is the same
        /// server-configuration singleton the provider is constructed with.
        /// </summary>
        private static string SortNameShape(string raw)
        {
            var shape = BaseItem.GetSortName(raw, true, BaseItem.ConfigurationManager.Configuration);
            return string.IsNullOrWhiteSpace(shape) ? null : shape;
        }

        private static async Task<IReadOnlyList<SearchResult>> FtsNameSearch(
            object provider,
            SearchProviderQuery query,
            string raw,
            string clean,
            string sortShape,
            CancellationToken ct)
        {
            var factory = (IDbContextFactory<JellyfinDbContext>)_dbProvider.GetValue(provider);
            var db = await factory.CreateDbContextAsync(ct).ConfigureAwait(false);
            await using (db.ConfigureAwait(false))
            {
                Guid[] candidates = null;
                try
                {
                    await db.Database.OpenConnectionAsync(ct).ConfigureAwait(false);
                    candidates = await FtsIndexEngine.NameCandidatesAsync(db.Database.GetDbConnection(), clean, raw, sortShape, ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger?.LogWarning(ex, "JellyfinPlus: FTS name candidates failed; using the stock query.");
                }

                FtsIndexEngine.Count(candidates == null ? "name:stock-query" : "name:fts");
                if (candidates != null && candidates.Length == 0)
                {
                    return Array.Empty<SearchResult>();
                }

                try
                {
                    return await RunNameQuery(provider, db, query, raw, clean, sortShape, candidates, ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex) when (candidates != null)
                {
                    // The constrained form failed: the unconstrained one IS the stock query.
                    _logger?.LogWarning(ex, "JellyfinPlus: FTS-constrained name query failed; re-running the stock query.");
                    FtsIndexEngine.Count("name:constrained-failed");
                    return await RunNameQuery(provider, db, query, raw, clean, sortShape, null, ct).ConfigureAwait(false);
                }
            }
        }

        /// <summary>
        /// The name matches of a wildcard term: SqlSearchProvider's query with its name predicate replaced by LIKE
        /// patterns (CleanName with the cleaned pattern; OriginalTitle with the uncleaned one, as stock tests it),
        /// the same filters, version exclusion, score tiers and ordering, and the FTS candidate condition when the
        /// index is usable and every column has a segment of 3+ characters.
        /// </summary>
        private static async Task<IReadOnlyList<SearchResult>> WildNames(object provider, SearchProviderQuery query, WildPattern wild, CancellationToken ct)
        {
            var factory = (IDbContextFactory<JellyfinDbContext>)_dbProvider.GetValue(provider);
            var db = await factory.CreateDbContextAsync(ct).ConfigureAwait(false);
            await using (db.ConfigureAwait(false))
            {
                Guid[] candidates = null;
                if (FtsIndexEngine.Usable)
                {
                    try
                    {
                        await db.Database.OpenConnectionAsync(ct).ConfigureAwait(false);
                        candidates = await FtsIndexEngine.WildNameCandidatesAsync(db.Database.GetDbConnection(), wild, ct).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException)
                    {
                        throw;
                    }
                    catch (Exception ex)
                    {
                        _logger?.LogWarning(ex, "JellyfinPlus: FTS wildcard candidates failed; using the plain LIKE query.");
                    }

                    FtsIndexEngine.Count(candidates == null ? "wild-name:like" : "wild-name:fts");
                    if (candidates != null && candidates.Length == 0)
                    {
                        return Array.Empty<SearchResult>();
                    }
                }

                try
                {
                    return await RunWildNameQuery(provider, db, query, wild, candidates, ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex) when (candidates != null)
                {
                    _logger?.LogWarning(ex, "JellyfinPlus: FTS-constrained wildcard query failed; re-running the plain LIKE query.");
                    FtsIndexEngine.Count("wild-name:constrained-failed");
                    return await RunWildNameQuery(provider, db, query, wild, null, ct).ConfigureAwait(false);
                }
            }
        }

        private static async Task<IReadOnlyList<SearchResult>> RunWildNameQuery(
            object provider,
            JellyfinDbContext db,
            SearchProviderQuery query,
            WildPattern wild,
            Guid[] candidates,
            CancellationToken ct)
        {
            // Locals, so EF sends them as parameters.
            var contains = wild.Contains;
            var exact = wild.Exact;
            var start = wild.Start;
            var word = wild.Word;
            var title = wild.TitleContains;
            var limit = query.Limit ?? DefaultSearchLimit;

            var dbQuery = db.BaseItems
                .AsNoTracking()
                .Where(e => e.Id != _placeholderId)
                .Where(e => !e.IsVirtualItem)
                .Where(e => EF.Functions.Like(e.CleanName, contains, "\\")
                    || (e.OriginalTitle != null && EF.Functions.Like(e.OriginalTitle, title, "\\")));
            if (candidates != null)
            {
                dbQuery = dbQuery.Where(e => EF.Parameter(candidates).Contains(e.Id));
            }

            dbQuery = ApplyProviderFilters(provider, db, query, dbQuery);
            dbQuery = (IQueryable<BaseItemEntity>)_excludeVersions.Invoke(null, new object[] { dbQuery });

            var scored = dbQuery.Select(e => new
            {
                e.Id,
                Score =
                    EF.Functions.Like(e.CleanName, exact, "\\") ? ExactMatchScore
                    : EF.Functions.Like(e.CleanName, start, "\\") ? PrefixMatchScore
                    : EF.Functions.Like(e.CleanName, word, "\\") ? WordPrefixMatchScore
                    : ContainsMatchScore,
            });

            return await scored
                .OrderByDescending(x => x.Score)
                .ThenBy(x => x.Id)
                .Take(limit)
                .Select(x => new SearchResult(x.Id, x.Score))
                .ToArrayAsync(ct)
                .ConfigureAwait(false);
        }

        /// <summary>
        /// SqlSearchProvider.SearchAsync's query (Jellyfin 12.3), verbatim, plus the optional candidate-id condition.
        /// 12.3 added the SortName test (its sortNameShape / likeSortName); <paramref name="sortShape"/> is that shape,
        /// null exactly when stock leaves the test out.
        /// </summary>
        private static async Task<IReadOnlyList<SearchResult>> RunNameQuery(
            object provider,
            JellyfinDbContext db,
            SearchProviderQuery query,
            string raw,
            string clean,
            string sortShape,
            Guid[] candidates,
            CancellationToken ct)
        {
            var cleanPrefix = clean + " ";
            var likeOriginal = $"%{raw}%";
            var likeSortName = sortShape == null ? null : $"%{sortShape}%";
            var limit = query.Limit ?? DefaultSearchLimit;

            var dbQuery = db.BaseItems
                .AsNoTracking()
                .Where(e => e.Id != _placeholderId)
                .Where(e => !e.IsVirtualItem);

            if (likeSortName is null)
            {
                dbQuery = dbQuery
                    .Where(e => e.CleanName!.Contains(clean)
                        || (e.OriginalTitle != null && EF.Functions.Like(e.OriginalTitle, likeOriginal)));
            }
            else
            {
                dbQuery = dbQuery
                    .Where(e => e.CleanName!.Contains(clean)
                        || (e.OriginalTitle != null && EF.Functions.Like(e.OriginalTitle, likeOriginal))
                        || (e.SortName != null && EF.Functions.Like(e.SortName, likeSortName)));
            }

            if (candidates != null)
            {
                dbQuery = dbQuery.Where(e => EF.Parameter(candidates).Contains(e.Id));
            }

            dbQuery = ApplyProviderFilters(provider, db, query, dbQuery);
            dbQuery = (IQueryable<BaseItemEntity>)_excludeVersions.Invoke(null, new object[] { dbQuery });

            var scored = dbQuery.Select(e => new
            {
                e.Id,
                Score =
                    (e.CleanName == clean) ? ExactMatchScore
                    : e.CleanName!.StartsWith(clean) ? PrefixMatchScore
                    : e.CleanName!.Contains(cleanPrefix) ? WordPrefixMatchScore
                    : ContainsMatchScore,
            });

            return await scored
                .OrderByDescending(x => x.Score)
                .ThenBy(x => x.Id)
                .Take(limit)
                .Select(x => new SearchResult(x.Id, x.Score))
                .ToArrayAsync(ct)
                .ConfigureAwait(false);
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
                _logger?.LogWarning(ex, "JellyfinPlus: could not read {Param}; searching without exclusions.", ExcludeParam);
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

        private static readonly MethodInfo _efLike = typeof(DbFunctionsExtensions).GetMethod(
            nameof(DbFunctionsExtensions.Like),
            new[] { typeof(DbFunctions), typeof(string), typeof(string), typeof(string) });

        private static readonly MethodInfo _stringContains = typeof(string).GetMethod(nameof(string.Contains), new[] { typeof(string) });

        /// <summary>
        /// The per-TAG test for a tag match: the tag contains the search term and none of the
        /// exclude terms. Exclusion therefore applies to the tag that matched, not the whole item:
        /// searching "cat" with "red" excluded drops a match on the tag "red cat" but keeps one on
        /// "black cat", even when that same item also carries some other tag containing "red".
        /// Built as one expression so it stays a single EXISTS in SQL, with one NOT LIKE per term.
        /// </summary>
        private static Expression<Func<ItemValueMap, bool>> TagMatch(string search, string[] excludes, WildPattern wild = null)
        {
            var v = Expression.Parameter(typeof(ItemValueMap), "v");
            var itemValue = Expression.Property(v, nameof(ItemValueMap.ItemValue));
            var cleanValue = Expression.Property(itemValue, nameof(ItemValue.CleanValue));

            Expression ContainsParam(string s) => Expression.Call(
                cleanValue,
                _stringContains,
                Expression.Property(Expression.Constant(new Param(s)), nameof(Param.Value)));

            // A wildcard term matches the tag through LIKE ... ESCAPE (the pattern as a parameter), a plain one by contains.
            Expression matches = wild == null
                ? ContainsParam(search)
                : Expression.Call(
                    _efLike,
                    Expression.Constant(EF.Functions),
                    cleanValue,
                    Expression.Property(Expression.Constant(new Param(wild.Contains)), nameof(Param.Value)),
                    Expression.Constant(WildPattern.Escape));
            Expression body = Expression.AndAlso(
                Expression.Equal(Expression.Property(itemValue, nameof(ItemValue.Type)), Expression.Constant(ItemValueType.Tags)),
                matches);
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

        // How many tag values / ItemValuesMap rows a "small match set" may have. Above either, the tag
        // matches are too broad to enumerate up front and BroadTagMatchedIds walks the candidates instead.
        private const int MaxTagValueIds = 5000;
        private const int MaxTagMapRows = 100000;

        /// <summary>The ItemValueIds of the tag values <see cref="TagMatch"/> accepts (term in, no exclude term in).</summary>
        private static IQueryable<Guid> MatchingTagValueIds(JellyfinDbContext db, string search, string[] excludes, Guid[] candidates = null, WildPattern wild = null)
        {
            // Locals, not constants, so EF sends them as parameters.
            var needle = search;
            var like = wild?.Contains;
            IQueryable<ItemValue> values = wild == null
                ? db.ItemValues.AsNoTracking().Where(v => v.Type == ItemValueType.Tags && v.CleanValue.Contains(needle))
                : db.ItemValues.AsNoTracking().Where(v => v.Type == ItemValueType.Tags && EF.Functions.Like(v.CleanValue, like, "\\"));
            if (candidates != null)
            {
                // The FTS index's candidates (a superset of the values containing the term): the exact test above
                // still decides, it just runs over a handful of primary-key lookups instead of every tag value.
                values = values.Where(v => EF.Parameter(candidates).Contains(v.ItemValueId));
            }

            foreach (var term in excludes)
            {
                var t = term;
                values = values.Where(v => !v.CleanValue.Contains(t));
            }

            return values.Select(v => v.ItemValueId);
        }

        /// <summary>
        /// The ids of the items carrying a tag that <see cref="TagMatch"/> accepts (a tag containing the term
        /// and none of the exclude terms), found WITHOUT touching BaseItems: the matching tag VALUES from
        /// ItemValues, then their ItemValuesMap rows through its (ItemValueId, ItemId) primary key.
        /// Returns an empty array when nothing matches (the caller then skips the item query altogether), or
        /// null when the matches are too many to enumerate. The ids come back distinct and in the database's own
        /// Id order.
        /// </summary>
        /// <remarks>
        /// Why: one correlated EXISTS per BaseItems row makes SQLite scan the whole item table and probe the
        /// map for every row (~1.3 s on 80k items with 2.3M map rows) whenever the term matches few or no tags.
        /// </remarks>
        private static async Task<Guid[]> MatchingTagItemIds(JellyfinDbContext db, string search, string[] excludes, CancellationToken ct, WildPattern wild = null)
        {
            Guid[] candidates = null;
            if (FtsIndexEngine.Usable)
            {
                try
                {
                    await db.Database.OpenConnectionAsync(ct).ConfigureAwait(false);
                    candidates = wild == null
                        ? await FtsIndexEngine.TagValueCandidatesAsync(db.Database.GetDbConnection(), search, ct).ConfigureAwait(false)
                        : await FtsIndexEngine.WildTagValueCandidatesAsync(db.Database.GetDbConnection(), wild, ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger?.LogWarning(ex, "JellyfinPlus: FTS tag candidates failed; using the stock tag scan.");
                }

                FtsIndexEngine.Count(candidates == null ? "tag:stock-query" : "tag:fts");
                if (candidates != null && candidates.Length == 0)
                {
                    return Array.Empty<Guid>();
                }
            }

            var valueIds = await MatchingTagValueIds(db, search, excludes, candidates, wild).Take(MaxTagValueIds + 1).ToListAsync(ct).ConfigureAwait(false);
            if (valueIds.Count == 0)
            {
                return Array.Empty<Guid>();
            }

            if (valueIds.Count > MaxTagValueIds)
            {
                return null;
            }

            var itemIds = await db.ItemValuesMap
                .AsNoTracking()
                .Where(m => EF.Parameter(valueIds).Contains(m.ItemValueId))
                .Select(m => m.ItemId)
                .Distinct()
                .OrderBy(id => id)
                .Take(MaxTagMapRows + 1)
                .ToArrayAsync(ct)
                .ConfigureAwait(false);
            return itemIds.Length > MaxTagMapRows ? null : itemIds;
        }

        /// <summary>The provider's own type, media-type, parent and user-access filters, in the stock order.</summary>
        private static IQueryable<BaseItemEntity> ApplyProviderFilters(
            object provider,
            JellyfinDbContext db,
            SearchProviderQuery query,
            IQueryable<BaseItemEntity> dbQuery)
        {
            dbQuery = (IQueryable<BaseItemEntity>)_applyTypeFilter.Invoke(provider, new object[] { dbQuery, query.IncludeItemTypes, query.ExcludeItemTypes });
            dbQuery = (IQueryable<BaseItemEntity>)_applyMediaTypeFilter.Invoke(null, new object[] { dbQuery, query.MediaTypes });
            dbQuery = (IQueryable<BaseItemEntity>)_applyParentFilter.Invoke(null, new object[] { dbQuery, query.ParentId });
            return (IQueryable<BaseItemEntity>)_applyUserAccessFilter.Invoke(provider, new object[] { db, dbQuery, query });
        }

        private static IQueryable<BaseItemEntity> SearchableItems(JellyfinDbContext db)
            => db.BaseItems.AsNoTracking().Where(e => e.Id != _placeholderId).Where(e => !e.IsVirtualItem);

        /// <summary>
        /// The first <paramref name="limit"/> ids (in Id order) of the items that carry a qualifying tag and pass
        /// the provider's filters - what the name search's own query does for names.
        /// </summary>
        private static async Task<Guid[]> TagMatchedIds(
            object provider,
            JellyfinDbContext db,
            SearchProviderQuery query,
            string clean,
            string[] excludes,
            int limit,
            CancellationToken ct,
            WildPattern wild = null)
        {
            var tagItemIds = await MatchingTagItemIds(db, clean, excludes, ct, wild).ConfigureAwait(false);
            if (tagItemIds == null)
            {
                return await BroadTagMatchedIds(provider, db, query, clean, excludes, limit, ct, wild).ConfigureAwait(false);
            }

            if (tagItemIds.Length == 0)
            {
                return Array.Empty<Guid>();
            }

            // tagItemIds is already in the database's own Id order (SQLite's, not Guid.CompareTo's).
            var pos = new Dictionary<Guid, int>(tagItemIds.Length);
            foreach (var id in tagItemIds)
            {
                pos[id] = pos.Count;
            }

            return await FilterOrderedHits(provider, db, query, TagMatch(clean, excludes, wild), tagItemIds, pos, limit, ct).ConfigureAwait(false);
        }

        /// <summary>
        /// The provider's filters (type, media type, parent, user access, then the version exclusion) over
        /// tag-matching ids that are already in Id order, taken from the front so the work stays proportional to
        /// the page asked for rather than to the number of matches: the first <paramref name="limit"/> hits are
        /// filtered, and the prefix doubles only if filters (or the version exclusion) ate too many.
        /// ExcludeVersionsOfMatchedPrimaries stays exact: it runs over the prefix plus the primary versions of
        /// its items, so a hit is dropped exactly when its primary also qualifies. <paramref name="pos"/> gives
        /// each id's place in the walk; an id beyond the prefix (a primary pulled in for that check) sorts after
        /// every id inside it, so removing it afterwards can only remove what would not have been in the first
        /// <paramref name="limit"/> anyway.
        /// </summary>
        private static async Task<Guid[]> FilterOrderedHits(
            object provider,
            JellyfinDbContext db,
            SearchProviderQuery query,
            Expression<Func<ItemValueMap, bool>> tag,
            IReadOnlyList<Guid> hits,
            Dictionary<Guid, int> pos,
            int limit,
            CancellationToken ct)
        {
            var result = Array.Empty<Guid>();
            var take = limit;
            while (hits.Count > 0)
            {
                var prefix = hits.Take(take).ToArray();
                var bound = pos[prefix[prefix.Length - 1]];
                var primaries = await db.BaseItems
                    .AsNoTracking()
                    .Where(e => EF.Parameter(prefix).Contains(e.Id) && e.PrimaryVersionId != null)
                    .Select(e => e.PrimaryVersionId.Value)
                    .Distinct()
                    .ToListAsync(ct)
                    .ConfigureAwait(false);
                var scope = prefix.Concat(primaries).Distinct().ToArray();
                var scoped = ApplyProviderFilters(
                    provider,
                    db,
                    query,
                    SearchableItems(db).Where(e => EF.Parameter(scope).Contains(e.Id)).Where(e => e.ItemValues!.AsQueryable().Any(tag)));
                scoped = (IQueryable<BaseItemEntity>)_excludeVersions.Invoke(null, new object[] { scoped });
                result = (await scoped
                        .OrderBy(e => e.Id)
                        .Select(e => e.Id)
                        .Take(limit)
                        .ToArrayAsync(ct)
                        .ConfigureAwait(false))
                    .Where(id => pos.TryGetValue(id, out var p) && p <= bound)
                    .ToArray();
                if (result.Length >= limit || take >= hits.Count)
                {
                    break;
                }

                take *= 2;
            }

            return result;
        }

        // Items examined per round by BroadTagMatchedIds.
        private const int BroadChunk = 2000;

        /// <summary>
        /// The same answer as the one-query form (<c>tag EXISTS</c> + filters + ExcludeVersions, ORDER BY Id,
        /// LIMIT), for terms matching too many tags to enumerate. SQLite plans that one query either as a
        /// primary-key walk that stops after <paramref name="limit"/> rows (when only the access filter applies) or,
        /// as soon as a type filter offers an index, as a scan of every filtered item with a map probe each
        /// followed by a sort - the full cost even though only the first rows are wanted. Here BaseItems is walked
        /// in Id order in chunks of ids (primary-key index only), the ItemValuesMap (by its ItemId index) says
        /// which of each chunk carry a qualifying tag, and <see cref="FilterOrderedHits"/> runs the provider's
        /// filters on those hits until enough have passed.
        /// </summary>
        private static async Task<Guid[]> BroadTagMatchedIds(
            object provider,
            JellyfinDbContext db,
            SearchProviderQuery query,
            string clean,
            string[] excludes,
            int limit,
            CancellationToken ct,
            WildPattern wild = null)
        {
            var tag = TagMatch(clean, excludes, wild);
            var tagValues = MatchingTagValueIds(db, clean, excludes, null, wild);
            var hits = new List<Guid>();
            var pos = new Dictionary<Guid, int>(); // Id -> its place in the walk
            var result = Array.Empty<Guid>();
            for (var start = 0; ; start += BroadChunk)
            {
                var skip = start;
                var chunk = await db.BaseItems
                    .AsNoTracking()
                    .OrderBy(e => e.Id)
                    .Select(e => e.Id)
                    .Skip(skip)
                    .Take(BroadChunk)
                    .ToArrayAsync(ct)
                    .ConfigureAwait(false);
                if (chunk.Length == 0)
                {
                    return result;
                }

                // The matching tag values are an uncorrelated subquery, so SQLite builds that set once per round and
                // each of the chunk's map rows is a lookup in it (no ItemValues probe and LIKE per row).
                var found = (await db.ItemValuesMap
                        .AsNoTracking()
                        .Where(m => EF.Parameter(chunk).Contains(m.ItemId) && tagValues.Contains(m.ItemValueId))
                        .Select(m => m.ItemId)
                        .Distinct()
                        .ToListAsync(ct)
                        .ConfigureAwait(false))
                    .ToHashSet();
                foreach (var id in chunk)
                {
                    pos[id] = pos.Count;
                }

                hits.AddRange(chunk.Where(found.Contains)); // chunk (SQL Id) order, not Guid order

                var last = chunk.Length < BroadChunk;
                if (hits.Count < limit && !last)
                {
                    continue;
                }

                result = await FilterOrderedHits(provider, db, query, tag, hits, pos, limit, ct).ConfigureAwait(false);
                if (result.Length >= limit || last)
                {
                    return result;
                }
            }
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

                // A wildcard term (* any run, ? one character). Stock cannot do it: its cleaning turns the wildcard
                // into a space and it searches for the literal mangled text. So the stock results are DROPPED for
                // such a term (the prefix does not even run the stock query): they would be at best a subset of the
                // real matches (a space is one thing a wildcard can stand for), at worst junk (the stock text with
                // one space where "??" demands two). The name matches are computed here instead, by the provider's
                // own filters and scoring tiers, and the tag matches below use the same pattern.
                var wild = WildPattern.Parse(raw, out var wildKind);
                if (wildKind == WildKind.NoSearch)
                {
                    return nameResults; // wildcards and punctuation only: no search, as stock
                }

                if (wild != null)
                {
                    nameResults = await WildNames(provider, query, wild, cancellationToken).ConfigureAwait(false);
                    clean = wild.Contains;
                }

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
                    tagIds = await TagMatchedIds(provider, dbContext, query, clean, excludes, limit, cancellationToken, wild).ConfigureAwait(false);

                    // The stock name matches are excluded by any tag containing an exclude term.
                    // They were already access-filtered by the stock query, so only the tag test
                    // is applied here.
                    if (excludes.Length > 0 && nameResults.Count > 0)
                    {
                        var nameIds = nameResults.Select(r => r.ItemId).ToArray();
                        var keep = (await WithoutAnyExcludedTag(
                                dbContext.BaseItems.AsNoTracking().Where(e => EF.Parameter(nameIds).Contains(e.Id)),
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

                if (scores.Count == 0 && (wild != null || (excludes.Length > 0 && nameResults.Count > 0)))
                {
                    // (A wildcard term with no match at all lands here too: the controller's own fallback would search
                    // the stock-mangled literal text and bring back junk.)
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
                _logger?.LogWarning(ex, "JellyfinPlus: tag search failed; returning name matches only, without exclusions.");
                return nameResults;
            }
        }
    }
}
