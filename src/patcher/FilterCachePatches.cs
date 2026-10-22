using System;
using System.Collections;
using System.Collections.Generic;
using System.Data.Common;
using System.Globalization;
using System.Linq;
using System.Reflection;
using HarmonyLib;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Plus.Patcher
{
    /// <summary>
    /// Serves GET /Items/Filters and /Items/Filters2 from <see cref="FilterCacheEngine"/> when that is SAFE,
    /// and otherwise lets Jellyfin's own code run untouched.
    ///
    /// THE SEAM. The three BaseItemRepository methods the two controller actions end in:
    /// GetQueryFiltersLegacy (years, ratings, tags, genres), GetTagNames (Filters2's tags) and GetGenres
    /// (Filters2's genres). By the time a query reaches them LibraryManager has already turned the request
    /// into InternalItemsQuery fields (user restrictions, TopParentIds, item types), so the decision is made
    /// on exactly what stock would have executed, not on a re-parse of the HTTP request. A prefix returning
    /// false skips the stock body; a prefix that returns true (or throws) leaves stock to run.
    ///
    /// SAFE means ALL of:
    ///  1. The cache is ready, built for every library in scope, and its fingerprint still matches the
    ///     library (see <see cref="FilterCacheEngine"/>): never a stale answer.
    ///  2. The query has a user, and that user has NO item-level restriction: no MaxParentalRating, no
    ///     BlockUnratedItems, no BlockedTags, no AllowedTags, no content restrictions. Those make the visible
    ///     item set differ from "every item in the library", so a cached tag could exist only on an item the
    ///     user cannot see. Such users get stock, always.
    ///  3. Every library in scope is one the user can open (CollectionFolder.IsVisible). Stock does not check
    ///     this for an explicit parentId; this does, and falls through (to stock) when it fails, so the cache
    ///     can never be the reason an inaccessible library's keys are shown.
    ///  4. The scope is a union of whole libraries: a library parent (TopParentIds), the user's libraries (no
    ///     parent), and nothing narrower (not a series, a collection, a folder).
    ///  5. Nothing else in the query narrows the item set. Compared by reflection against a default
    ///     InternalItemsQuery: any settable property outside a short allow-list that differs from its default
    ///     (mediaTypes, isMovie, isKids, excludeItemTypes, a limit, ...) means stock. A new field in a future
    ///     Jellyfin therefore defaults to stock.
    ///  6. Item types, if requested, are ordinary item types (not the by-name kinds, which are not stored per
    ///     library). Years and ratings are answered per type from the cache.
    ///
    /// The genre prefix additionally requires the request to be /Items/Filters2, because it fabricates Genre
    /// objects carrying only Id and Name, which is all that action reads.
    /// </summary>
    internal static class FilterCachePatches
    {
        private static readonly HttpContextAccessor _http = new HttpContextAccessor();
        private static readonly object _defaultQuery = new InternalItemsQuery();
        private static ILogger _logger;
        private static bool _warned;

        // Properties allowed to differ from a default query; each is handled explicitly in Resolve().
        private static readonly HashSet<string> _handled = new HashSet<string>(StringComparer.Ordinal)
        {
            nameof(InternalItemsQuery.User),
            nameof(InternalItemsQuery.IncludeItemTypes),
            nameof(InternalItemsQuery.TopParentIds),
            nameof(InternalItemsQuery.AncestorIds),
            nameof(InternalItemsQuery.Recursive),
            nameof(InternalItemsQuery.EnableTotalRecordCount),
            nameof(InternalItemsQuery.DtoOptions),
            nameof(InternalItemsQuery.MaxParentalRating),
            nameof(InternalItemsQuery.BlockUnratedItems),
            nameof(InternalItemsQuery.ExcludeInheritedTags),
            nameof(InternalItemsQuery.IncludeInheritedTags),
            nameof(InternalItemsQuery.UserHasContentRestrictions),
        };

        private static readonly PropertyInfo[] _compared = typeof(InternalItemsQuery)
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.GetMethod != null && p.SetMethod != null && p.SetMethod.IsPublic && p.GetIndexParameters().Length == 0)
            .Where(p => !_handled.Contains(p.Name))
            .ToArray();

        // Kinds that are not stored per library (no TopParentId) and so are never in the cache.
        private static readonly HashSet<BaseItemKind> _byName = new HashSet<BaseItemKind>
        {
            BaseItemKind.Person, BaseItemKind.Genre, BaseItemKind.MusicGenre, BaseItemKind.MusicArtist, BaseItemKind.Studio,
        };

        public static bool Available { get; private set; }

        public static void Apply(Harmony harmony, ILogger logger)
        {
            _logger = logger;
            var repository = AccessTools.TypeByName("Jellyfin.Server.Implementations.Item.BaseItemRepository");
            var legacy = repository == null ? null : AccessTools.Method(repository, "GetQueryFiltersLegacy", new[] { typeof(InternalItemsQuery) });
            var tags = repository == null ? null : AccessTools.Method(repository, "GetTagNames", new[] { typeof(InternalItemsQuery) });
            var genres = repository == null ? null : AccessTools.Method(repository, "GetGenres", new[] { typeof(InternalItemsQuery) });
            if (legacy == null || tags == null || genres == null)
            {
                Available = false;
                logger?.LogWarning(
                    "JellyfinPlus: could not resolve BaseItemRepository.GetQueryFiltersLegacy / GetTagNames / GetGenres; "
                    + "the filter key cache is unavailable on this Jellyfin build. Stock /Items/Filters is unaffected.");
                return;
            }

            const BindingFlags f = BindingFlags.Static | BindingFlags.NonPublic;
            harmony.Patch(legacy, prefix: new HarmonyMethod(typeof(FilterCachePatches).GetMethod(nameof(LegacyPrefix), f)));
            harmony.Patch(tags, prefix: new HarmonyMethod(typeof(FilterCachePatches).GetMethod(nameof(TagsPrefix), f)));
            harmony.Patch(genres, prefix: new HarmonyMethod(typeof(FilterCachePatches).GetMethod(nameof(GenresPrefix), f)));
            Available = true;
            logger?.LogInformation("JellyfinPlus: patched BaseItemRepository.GetQueryFiltersLegacy / GetTagNames / GetGenres (/Items/Filters served from the filter key cache when safe)");
        }

        // ---------------------------------------------------------------- the three prefixes

        private static bool LegacyPrefix(InternalItemsQuery filter, ref QueryFiltersLegacy __result)
        {
            try
            {
                using var scope = Resolve(filter, new[] { FilterCacheEngine.Kind.Tag, FilterCacheEngine.Kind.Genre, FilterCacheEngine.Kind.Year, FilterCacheEngine.Kind.Rating });
                if (scope == null)
                {
                    return true;
                }

                var tags = scope.Read(FilterCacheEngine.Kind.Tag);
                var genres = scope.Read(FilterCacheEngine.Kind.Genre);
                var years = scope.Read(FilterCacheEngine.Kind.Year);
                var ratings = scope.Read(FilterCacheEngine.Kind.Rating);
                __result = new QueryFiltersLegacy
                {
                    Tags = tags.Select(t => t.Value).OrderBy(v => v, StringComparer.Ordinal).ToArray(),
                    Genres = genres.Select(t => t.Value).OrderBy(v => v, StringComparer.Ordinal).ToArray(),
                    Years = years.Select(t => int.Parse(t.Clean, CultureInfo.InvariantCulture)).OrderBy(y => y).ToArray(),
                    OfficialRatings = ratings.Select(t => t.Value).OrderBy(v => v, StringComparer.Ordinal).ToArray(),
                };
                FilterCacheEngine.Count("served:legacy");
                return false;
            }
            catch (Exception ex)
            {
                Warn(ex);
                return true;
            }
        }

        private static bool TagsPrefix(InternalItemsQuery filter, ref IReadOnlyList<string> __result)
        {
            try
            {
                using var scope = Resolve(filter, new[] { FilterCacheEngine.Kind.Tag });
                if (scope == null)
                {
                    return true;
                }

                __result = scope.Read(FilterCacheEngine.Kind.Tag).Select(t => t.Value).OrderBy(v => v, StringComparer.Ordinal).ToArray();
                FilterCacheEngine.Count("served:tags");
                return false;
            }
            catch (Exception ex)
            {
                Warn(ex);
                return true;
            }
        }

        private static bool GenresPrefix(InternalItemsQuery filter, ref QueryResult<(BaseItem Item, ItemCounts ItemCounts)> __result)
        {
            try
            {
                var path = _http.HttpContext?.Request?.Path.Value;
                if (path == null || !path.EndsWith("/Items/Filters2", StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }

                // A single music type means GetMusicGenres in the controller, not this call; and music genres
                // are different entities. Only the plain genre list is cached.
                using var scope = Resolve(filter, new[] { FilterCacheEngine.Kind.GenreEntity });
                if (scope == null)
                {
                    return true;
                }

                var items = scope.Read(FilterCacheEngine.Kind.GenreEntity)
                    .OrderBy(g => g.Value, StringComparer.Ordinal)
                    .Select(g => ((BaseItem)new Genre { Id = Guid.Parse(g.RefId), Name = g.Value }, (ItemCounts)null))
                    .ToList();
                __result = new QueryResult<(BaseItem Item, ItemCounts ItemCounts)>(items);
                FilterCacheEngine.Count("served:genres");
                return false;
            }
            catch (Exception ex)
            {
                Warn(ex);
                return true;
            }
        }

        // ---------------------------------------------------------------- the safety decision

        /// <summary>What a request resolved to: the libraries and item types it covers, on an open connection.</summary>
        internal sealed class Scope : IDisposable
        {
            private readonly JellyfinDbContext _db;
            private readonly DbConnection _conn;

            public Scope(JellyfinDbContext db, DbConnection conn, Guid[] libs, string[] types)
            {
                _db = db;
                _conn = conn;
                Libs = libs;
                Types = types;
            }

            public Guid[] Libs { get; }

            /// <summary>Item type names to restrict to, or null for every type.</summary>
            public string[] Types { get; }

            public List<(string Clean, string Value, string RefId)> Read(FilterCacheEngine.Kind kind)
                => FilterCacheEngine.ReadKeys(_conn, Libs, kind, Types);

            public void Dispose() => _db.Dispose();
        }

        /// <summary>
        /// Decides whether the cache may answer this query, and for what scope. Null means "run stock",
        /// and the reason is counted (visible in the status endpoint). Public surface for the harness.
        /// </summary>
        internal static Scope Resolve(InternalItemsQuery f, FilterCacheEngine.Kind[] kinds)
        {
            if (!FilterCacheEngine.Ready)
            {
                return Reject("engine-off");
            }

            var libs = ScopeLibraries(f, out var reason);
            if (libs == null)
            {
                return Reject(reason);
            }

            string[] types = null;
            if (f.IncludeItemTypes.Length > 0)
            {
                types = new string[f.IncludeItemTypes.Length];
                for (var i = 0; i < types.Length; i++)
                {
                    var kind = f.IncludeItemTypes[i];
                    types[i] = _byName.Contains(kind) ? null : FilterCacheEngine.TypeName(kind);
                    if (types[i] == null)
                    {
                        return Reject("item-type");
                    }
                }
            }

            var db = FilterCacheEngine.OpenDb(out var conn);
            try
            {
                foreach (var k in kinds)
                {
                    if (!FilterCacheEngine.IsFresh(db, conn, libs, k, out var why))
                    {
                        FilterCacheEngine.RequestHeal();
                        db.Dispose();
                        return Reject(why);
                    }
                }

                return new Scope(db, conn, libs, types);
            }
            catch
            {
                db.Dispose();
                throw;
            }
        }

        /// <summary>The library folder ids the query covers, or null (with a reason) when it must go to stock.</summary>
        internal static Guid[] ScopeLibraries(InternalItemsQuery f, out string reason)
        {
            var user = f.User;
            if (user == null)
            {
                reason = "no-user";
                return null;
            }

            // Not UserHasContentRestrictions: that is also true for a user limited to some libraries (no
            // EnableAllFolders), which is a LIBRARY restriction handled by the accessible-libraries check
            // below, not an item-level one. Item-level means rating or tag rules, listed here.
            if (f.MaxParentalRating != null || f.BlockUnratedItems.Length > 0 || f.ExcludeInheritedTags.Length > 0
                || f.IncludeInheritedTags.Length > 0)
            {
                reason = "restricted-user";
                return null;
            }

            if (!IsPlain(f))
            {
                reason = "narrowed-query";
                return null;
            }

            var accessible = FilterCacheEngine.AccessibleFolders(user);
            if (accessible.Count == 0)
            {
                reason = "no-libraries";
                return null;
            }

            Guid[] libs;
            if (f.TopParentIds.Length > 0 && f.AncestorIds.Length == 0)
            {
                // A library parent, or the user's own views (no parent in Filters2).
                libs = f.TopParentIds.Distinct().ToArray();
            }
            else if (f.TopParentIds.Length == 0 && f.AncestorIds.Length == 1
                && f.AncestorIds[0] == FilterCacheEngine.UserRootId())
            {
                // No parent in /Items/Filters: the stock query scopes by ancestor only and so spans every
                // library. The cache answers for the libraries this user can open, which is the same set for
                // anyone with full access and a subset otherwise: never wider than stock.
                libs = accessible.ToArray();
            }
            else
            {
                reason = "narrow-scope";
                return null;
            }

            if (libs.Any(l => !accessible.Contains(l)))
            {
                reason = "inaccessible-library";
                return null;
            }

            reason = null;
            return libs;
        }

        /// <summary>True when no property outside the handled allow-list differs from a default query.</summary>
        internal static bool IsPlain(InternalItemsQuery f)
        {
            foreach (var p in _compared)
            {
                if (!SameValue(p.GetValue(f), p.GetValue(_defaultQuery)))
                {
                    return false;
                }
            }

            return true;
        }

        private static bool SameValue(object a, object b)
        {
            if (ReferenceEquals(a, b))
            {
                return true;
            }

            if (a == null || b == null)
            {
                // A null and an empty collection both mean "no constraint".
                return IsEmpty(a) && IsEmpty(b);
            }

            if (a is string || a is IDictionary || !(a is IEnumerable ea) || !(b is IEnumerable eb))
            {
                return a.Equals(b);
            }

            return ea.Cast<object>().SequenceEqual(eb.Cast<object>());
        }

        private static bool IsEmpty(object o) => o == null || (o is IEnumerable e && !(o is string) && !e.Cast<object>().Any());

        private static Scope Reject(string reason)
        {
            FilterCacheEngine.Count("stock:" + reason);
            return null;
        }

        private static void Warn(Exception ex)
        {
            if (_warned)
            {
                return;
            }

            _warned = true;
            _logger?.LogWarning(ex, "JellyfinPlus: the filter key cache failed on a request; stock served it (further failures are not logged).");
        }
    }
}
