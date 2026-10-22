using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Text.Json.Serialization;
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
    /// <summary>One facet row: a person, studio or tag, with the number of matching items carrying it.</summary>
    public sealed class SearchFacet
    {
        /// <summary>Gets or sets the item id to filter by (personIds / studioIds); null for a tag, which is filtered by name.</summary>
        [JsonPropertyName("id")]
        public Guid? Id { get; set; }

        /// <summary>Gets or sets the display name.</summary>
        [JsonPropertyName("name")]
        public string Name { get; set; }

        /// <summary>Gets or sets the PersonKind names the person is credited under on the matching items (people only).</summary>
        [JsonPropertyName("roles")]
        public string[] Roles { get; set; } = Array.Empty<string>();

        /// <summary>Gets or sets the number of distinct matching items that carry it.</summary>
        [JsonPropertyName("count")]
        public int Count { get; set; }
    }

    /// <summary>
    /// "Who / what appears in THESE search results": facet lists for the search page's Sort and filter
    /// sheet, computed over exactly the items the search page's own /Items request would return.
    ///
    ///   GET /JellyfinPlus/Search/Facets?searchTerm=..&amp;kind=people|studios|tags[&amp;q=..][&amp;limit=50]
    ///       [&amp;userId=..][&amp;parentId=..][&amp;includeItemTypes=..][&amp;mediaTypes=..]
    ///       [&amp;isPlayed=..][&amp;isFavorite=..][&amp;tags=a|b][&amp;studioIds=..]
    ///       [&amp;excludeTags=..][&amp;excludeTagNames=..][&amp;tagMatch=all][&amp;jp*=..]
    ///
    /// Answers <c>[{ id, name, roles, count }]</c>, count descending then name.
    ///
    /// HOW IT MATCHES /Items. (1) Candidates come from ISearchManager.GetSearchResultsAsync with the same
    /// SearchProviderQuery /Items builds (term, user, parent, types) and a limit of
    /// <see cref="MaxCandidates"/> - the widened pool the sort and filter patches use - so the tag-match
    /// postfix on the SQL provider and the excludeTags exclusion apply, because they read the current
    /// request's query string. (2) The candidate ids go through ILibraryManager.GetItemIds with an
    /// InternalItemsQuery(user) carrying the same filters /Items would, which runs the stock
    /// BaseItemRepository.TranslateQuery and user-access filtering; the plugin's TranslateQuery patch
    /// (excludeTagNames, tagMatch=all, jpMin/MaxRuntime, jpMin/MaxDateAdded, jpResolution) recognises
    /// this route as well as /Items. (3) Credits are aggregated over the surviving ids only.
    ///
    /// A FACET IGNORES ITS OWN FILTER. The people list ignores personIds / personTypes / jpPersonMatch,
    /// the studio list ignores studioIds, the tag list ignores tags / tagMatch: otherwise picking one
    /// person would shrink the list to that person's co-stars and "any of" could never grow.
    ///
    /// ACCESS. The user is the authenticated one (or, for an administrator, the userId asked for). Only
    /// ids that survive user-access filtering are aggregated, so a person who appears only on items the
    /// user cannot see is never listed.
    /// </summary>
    [ApiController]
    [Authorize]
    [Route("JellyfinPlus/Search")]
    public class SearchFacetsController : ControllerBase
    {
        /// <summary>Candidate-pool size: the same widened pool the sort and filter patches use.</summary>
        internal const int MaxCandidates = 2000;

        internal const int DefaultLimit = 50;
        internal const int MaxLimit = 200;
        private const int MaxQueryLength = 100;

        // Types the search page lists, when the client names none. Excludes people, studios, genres,
        // folders and the like, which would only spend candidate slots and carry no credits.
        private static readonly BaseItemKind[] DefaultTypes =
        {
            BaseItemKind.Movie, BaseItemKind.Series, BaseItemKind.Episode, BaseItemKind.Video, BaseItemKind.MusicVideo,
        };

        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly ISearchManager _searchManager;
        private readonly IDbContextFactory<JellyfinDbContext> _dbFactory;

        /// <summary>Initializes a new instance of the <see cref="SearchFacetsController"/> class.</summary>
        public SearchFacetsController(
            ILibraryManager libraryManager,
            IUserManager userManager,
            ISearchManager searchManager,
            IDbContextFactory<JellyfinDbContext> dbFactory)
        {
            _libraryManager = libraryManager;
            _userManager = userManager;
            _searchManager = searchManager;
            _dbFactory = dbFactory;
        }

        /// <summary>Gets the people / studios / tags credited on the items a search matches.</summary>
        [HttpGet("Facets")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public async Task<ActionResult<IReadOnlyList<SearchFacet>>> GetFacets(
            [FromQuery] string searchTerm,
            [FromQuery] Guid? userId,
            [FromQuery] Guid? parentId,
            [FromQuery] string kind,
            [FromQuery] string q,
            [FromQuery] int? limit,
            [FromQuery] string includeItemTypes,
            [FromQuery] string excludeItemTypes,
            [FromQuery] string mediaTypes,
            [FromQuery] bool? isPlayed,
            [FromQuery] bool? isFavorite,
            [FromQuery] string tags,
            [FromQuery] string studioIds,
            CancellationToken cancellationToken)
        {
            var clock = Stopwatch.StartNew();

            var facetKind = ParseKind(kind);
            if (facetKind == null)
            {
                return BadRequest("kind must be people, studios or tags.");
            }

            var user = ResolveUser(userId, out var error);
            if (user == null)
            {
                return error;
            }

            if (string.IsNullOrWhiteSpace(searchTerm))
            {
                return Ok(Array.Empty<SearchFacet>());
            }

            if (parentId.HasValue && parentId.Value != Guid.Empty
                && _libraryManager.GetItemById<BaseItem>(parentId.Value, user) == null)
            {
                // Not found, or not visible to this user: the same refusal, so existence does not leak.
                return NotFound();
            }

            var include = ParseEnums<BaseItemKind>(includeItemTypes);
            var exclude = ParseEnums<BaseItemKind>(excludeItemTypes);
            var media = ParseEnums<MediaType>(mediaTypes);
            if (include.Length == 0 && exclude.Length == 0)
            {
                include = DefaultTypes;
            }

            var candidates = await _searchManager.GetSearchResultsAsync(
                new SearchProviderQuery
                {
                    SearchTerm = searchTerm,
                    UserId = user.Id,
                    IncludeItemTypes = include,
                    ExcludeItemTypes = exclude,
                    MediaTypes = media,
                    Limit = MaxCandidates,
                    ParentId = parentId,
                },
                cancellationToken).ConfigureAwait(false);

            if (candidates.Count == 0)
            {
                return Ok(Array.Empty<SearchFacet>());
            }

            var query = new InternalItemsQuery(user)
            {
                ItemIds = candidates.Select(c => c.ItemId).Distinct().ToArray(),
                IncludeItemTypes = include,
                ExcludeItemTypes = exclude,
                MediaTypes = media,
                IsPlayed = isPlayed,
                IsFavorite = isFavorite,
                Recursive = true,
                EnableTotalRecordCount = false,
                CollapseBoxSetItems = false,
            };

            // The facet for a dimension ignores that dimension's own filter (see the class summary).
            if (facetKind != FacetKind.Tags)
            {
                query.Tags = SplitPipes(tags);
            }

            if (facetKind != FacetKind.Studios)
            {
                query.StudioIds = ParseGuids(studioIds);
            }

            var blockedUnrated = user.GetPreferenceValues<UnratedItem>(PreferenceKind.BlockUnratedItems);
            if (blockedUnrated != null)
            {
                query.BlockUnratedItems = blockedUnrated;
            }

            // The web client sends isMissing=false for episodes unless the user opted in to missing ones.
            if (!user.DisplayMissingEpisodes)
            {
                query.IsMissing = false;
            }

            var ids = _libraryManager.GetItemIds(query);
            if (ids.Count == 0)
            {
                return Ok(Array.Empty<SearchFacet>());
            }

            var take = Math.Clamp(limit ?? DefaultLimit, 1, MaxLimit);
            var needle = string.IsNullOrWhiteSpace(q) ? null : q.Trim();
            if (needle != null && needle.Length > MaxQueryLength)
            {
                needle = needle.Substring(0, MaxQueryLength);
            }

            var db = await _dbFactory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
            await using (db.ConfigureAwait(false))
            {
                var rows = await SearchFacetsCore.AggregateAsync(db, facetKind.Value, ids, needle, take, cancellationToken).ConfigureAwait(false);
                Response.Headers["Server-Timing"] = "facets;dur=" + clock.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture);
                return Ok(rows);
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

        internal static FacetKind? ParseKind(string kind)
        {
            if (string.IsNullOrWhiteSpace(kind))
            {
                return FacetKind.People;
            }

            return kind.Trim().ToLowerInvariant() switch
            {
                "people" => FacetKind.People,
                "studios" => FacetKind.Studios,
                "tags" => FacetKind.Tags,
                _ => null,
            };
        }

        /// <summary>Names from a comma list, kept only when they are a real member of the enum (numbers are not accepted).</summary>
        internal static T[] ParseEnums<T>(string list)
            where T : struct, Enum
        {
            if (string.IsNullOrWhiteSpace(list))
            {
                return Array.Empty<T>();
            }

            var names = Enum.GetNames<T>();
            return list
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(s => names.FirstOrDefault(n => string.Equals(n, s, StringComparison.OrdinalIgnoreCase)))
                .Where(n => n != null)
                .Select(n => Enum.Parse<T>(n))
                .Distinct()
                .ToArray();
        }

        internal static Guid[] ParseGuids(string list)
            => string.IsNullOrWhiteSpace(list)
                ? Array.Empty<Guid>()
                : list.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .Select(s => Guid.TryParse(s, out var g) ? g : Guid.Empty)
                    .Where(g => g != Guid.Empty)
                    .Distinct()
                    .ToArray();

        internal static string[] SplitPipes(string list)
            => string.IsNullOrWhiteSpace(list)
                ? Array.Empty<string>()
                : list.Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    }

    internal enum FacetKind
    {
        People,
        Studios,
        Tags,
    }

    /// <summary>The database half of the facets: no HTTP, no library manager, so it can be tested on a bare DbContext.</summary>
    internal static class SearchFacetsCore
    {
        // The stored BaseItemEntity.Type of person and studio items (the full CLR type name).
        internal static readonly string PersonType = typeof(Person).FullName;
        internal static readonly string StudioType = typeof(Studio).FullName;

        /// <summary>Escapes LIKE wildcards in a typeahead needle, for use with escape character '\'.</summary>
        internal static string LikePattern(string needle)
            => "%" + needle.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("%", "\\%", StringComparison.Ordinal).Replace("_", "\\_", StringComparison.Ordinal) + "%";

        internal static Task<List<SearchFacet>> AggregateAsync(
            JellyfinDbContext db,
            FacetKind kind,
            IReadOnlyCollection<Guid> ids,
            string needle,
            int limit,
            CancellationToken ct)
            => kind switch
            {
                FacetKind.People => PeopleAsync(db, ids, needle, limit, ct),
                FacetKind.Studios => ValuesAsync(db, ids, ItemValueType.Studios, StudioType, needle, limit, ct),
                _ => ValuesAsync(db, ids, ItemValueType.Tags, null, needle, limit, ct),
            };

        /// <summary>
        /// People credited on <paramref name="ids"/>: ONE grouped query on PeopleBaseItemMap joined to Peoples
        /// (distinct items per person name, top <paramref name="limit"/> by count then name), joined by name
        /// to the Person item whose id the personIds filter takes (the stock personIds predicate joins
        /// Person item and Peoples rows on Name too), plus a second, tiny query for the roles of just
        /// those names. A name with no Person item cannot be filtered by id, so it is not listed.
        /// </summary>
        internal static async Task<List<SearchFacet>> PeopleAsync(
            JellyfinDbContext db,
            IReadOnlyCollection<Guid> ids,
            string needle,
            int limit,
            CancellationToken ct)
        {
            var idArray = ids as Guid[] ?? ids.ToArray();
            var personType = PersonType;

            IQueryable<PeopleBaseItemMap> credits = db.PeopleBaseItemMap.AsNoTracking().Where(m => idArray.Contains(m.ItemId));
            if (needle != null)
            {
                var pattern = LikePattern(needle);
                credits = credits.Where(m => EF.Functions.Like(m.People.Name, pattern, "\\"));
            }

            var grouped = credits
                .GroupBy(m => m.People.Name)
                .Select(g => new { Name = g.Key, Count = g.Select(m => m.ItemId).Distinct().Count() });

            // Over-fetch a little: two Person items sharing a name would otherwise eat into the limit.
            var rows = await (
                from g in grouped
                join b in db.BaseItems.AsNoTracking().Where(b => b.Type == personType) on g.Name equals b.Name
                orderby g.Count descending, g.Name
                select new { b.Id, g.Name, g.Count })
                .Take(limit * 2)
                .ToListAsync(ct)
                .ConfigureAwait(false);

            var top = rows.GroupBy(r => r.Name).Select(g => g.First()).Take(limit).ToList();
            if (top.Count == 0)
            {
                return new List<SearchFacet>();
            }

            var names = top.Select(r => r.Name).ToArray();
            var roleRows = await db.PeopleBaseItemMap.AsNoTracking()
                .Where(m => idArray.Contains(m.ItemId) && names.Contains(m.People.Name))
                .Select(m => new { m.People.Name, m.People.PersonType })
                .Distinct()
                .ToListAsync(ct)
                .ConfigureAwait(false);
            var roles = roleRows
                .Where(r => !string.IsNullOrEmpty(r.PersonType))
                .GroupBy(r => r.Name)
                .ToDictionary(g => g.Key, g => g.Select(r => r.PersonType).Distinct().OrderBy(r => r, StringComparer.Ordinal).ToArray());

            return top.Select(r => new SearchFacet
            {
                Id = r.Id,
                Name = r.Name,
                Count = r.Count,
                Roles = roles.TryGetValue(r.Name, out var rs) ? rs : Array.Empty<string>(),
            }).ToList();
        }

        /// <summary>
        /// Studios or tags on <paramref name="ids"/>: one grouped query on ItemValuesMap. Studios are joined by
        /// name to the Studio item whose id studioIds takes (and dropped without one); tags have no id.
        /// </summary>
        internal static async Task<List<SearchFacet>> ValuesAsync(
            JellyfinDbContext db,
            IReadOnlyCollection<Guid> ids,
            ItemValueType type,
            string itemType,
            string needle,
            int limit,
            CancellationToken ct)
        {
            var idArray = ids as Guid[] ?? ids.ToArray();
            IQueryable<ItemValueMap> maps = db.ItemValuesMap.AsNoTracking()
                .Where(m => idArray.Contains(m.ItemId) && m.ItemValue.Type == type);
            if (needle != null)
            {
                var pattern = LikePattern(needle);
                maps = maps.Where(m => EF.Functions.Like(m.ItemValue.Value, pattern, "\\"));
            }

            var grouped = maps
                .GroupBy(m => m.ItemValue.Value)
                .Select(g => new { Name = g.Key, Count = g.Select(m => m.ItemId).Distinct().Count() });

            if (itemType == null)
            {
                var tagRows = await grouped
                    .OrderByDescending(g => g.Count).ThenBy(g => g.Name)
                    .Take(limit)
                    .ToListAsync(ct)
                    .ConfigureAwait(false);
                return tagRows.Select(r => new SearchFacet { Name = r.Name, Count = r.Count }).ToList();
            }

            var rows = await (
                from g in grouped
                join b in db.BaseItems.AsNoTracking().Where(b => b.Type == itemType) on g.Name equals b.Name
                orderby g.Count descending, g.Name
                select new { b.Id, g.Name, g.Count })
                .Take(limit * 2)
                .ToListAsync(ct)
                .ConfigureAwait(false);
            return rows.GroupBy(r => r.Name).Select(g => g.First()).Take(limit)
                .Select(r => new SearchFacet { Id = r.Id, Name = r.Name, Count = r.Count })
                .ToList();
        }
    }
}
