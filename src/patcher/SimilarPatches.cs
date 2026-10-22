using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using HarmonyLib;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.GpuUpscale.Patcher
{
    /// <summary>
    /// "More Like This" for plain Video items (clips).
    ///
    /// WHY IT IS EMPTY TODAY. GET /Items/{id}/Similar goes through SimilarItemsManager.GetSimilarItemsAsync,
    /// which asks every registered provider whether it Supports(item.GetType()). The built-in local
    /// providers cover Movie/Trailer, Series, Audio, MusicAlbum, MusicArtist and LiveTvProgram; nothing
    /// supports the base Video type that a Home Videos library produces, and no remote provider is
    /// configured for it, so the manager returns an empty list. (The web client has a second gate of
    /// its own, see web/src/controller/detail-related.js.)
    ///
    /// THE PATCH. A prefix on SimilarItemsManager.GetSimilarItemsAsync that handles ONLY items whose
    /// exact type is Video; everything else runs the stock method untouched. For a Video it ranks the
    /// library's other Videos by the tags and people they share with the source:
    ///
    ///   score(candidate) = sum over shared tags   of 5  * idf
    ///                    + sum over shared people of 15 * idf          idf = 1 / ln(2 + postings)
    ///
    /// The 5 and 15 are MovieSimilarItemsProvider's own tag and actor weights; the idf term stops a
    /// tag carried by thousands of clips from outvoting a rare one. Everything is plain SQL against the
    /// mapping tables (no per-item loop), and the work is bounded: at most MaxValues rarest source
    /// tags and MaxValues rarest source people take part, and a value carried by more than MaxPostings
    /// items is skipped as uninformative, so a request reads at most about 2 * MaxValues * MaxPostings
    /// rows however large the library is.
    ///
    /// USER ACCESS. The candidate ids are only a ranking. The items actually returned are loaded
    /// through ILibraryManager.GetItemList on an InternalItemsQuery(user) after
    /// ConfigureUserAccess(), i.e. the same TopParentIds, parental-rating, blocked-tag and
    /// alternate-version filters every library listing uses; the SQL that finds candidates is also
    /// limited to the user's accessible top-level libraries. The manager's own
    /// FilterByLibraryAccessAsync then runs over the result as a second layer. If any piece needed
    /// for that cannot be resolved the patch is not installed. With no user (an API key without a
    /// user context) the stock behaviour (empty) is kept, never an unfiltered answer.
    ///
    /// Total, like every patch here: any failure leaves the stock result (empty for Video).
    /// </summary>
    internal static class SimilarPatches
    {
        private const double TagWeight = 5.0;
        private const double PersonWeight = 15.0;

        // Work bounds, see the class comment.
        private const int MaxValues = 12;
        private const int MaxSourceValues = 60;
        private const int MaxPostings = 3000;
        private const int MaxLimit = 50;

        private static ILogger _logger;
        private static FieldInfo _dbProvider;
        private static FieldInfo _libraryManager;
        private static MethodInfo _filterByLibraryAccess;

        // BaseItemEntity.Type stores the CLR type's full name.
        private static readonly string VideoTypeName = typeof(Video).FullName;

        /// <summary>True once the target and every member it reuses were resolved and patched.</summary>
        public static bool Available { get; private set; }

        public static void Apply(Harmony harmony, ILogger logger)
        {
            _logger = logger;

            // Resolved BY NAME, like SearchPatches: no compile-time reference to
            // Emby.Server.Implementations to be version-pinned to.
            var manager = AccessTools.TypeByName("Emby.Server.Implementations.Library.SimilarItems.SimilarItemsManager");
            var target = manager == null ? null : AccessTools.Method(manager, "GetSimilarItemsAsync");
            if (manager != null)
            {
                _dbProvider = AccessTools.Field(manager, "_dbProvider");
                _libraryManager = AccessTools.Field(manager, "_libraryManager");
                _filterByLibraryAccess = AccessTools.Method(manager, "FilterByLibraryAccessAsync");
            }

            var missing = new List<string>();
            if (manager == null)
            {
                missing.Add("SimilarItemsManager");
            }
            else
            {
                if (target == null)
                {
                    missing.Add("GetSimilarItemsAsync");
                }

                if (_dbProvider == null)
                {
                    missing.Add("_dbProvider");
                }

                if (_libraryManager == null)
                {
                    missing.Add("_libraryManager");
                }

                // The second access layer. Not optional: a build without it is a build this patch
                // has not been checked against.
                if (_filterByLibraryAccess == null)
                {
                    missing.Add("FilterByLibraryAccessAsync");
                }
            }

            if (missing.Count > 0)
            {
                Available = false;
                logger?.LogWarning(
                    "GpuUpscale: could not resolve SimilarItemsManager member(s) {Missing}; More Like This for "
                    + "Video items is unavailable on this Jellyfin build. Stock behaviour is unaffected.",
                    string.Join(", ", missing));
                return;
            }

            harmony.Patch(
                target,
                prefix: new HarmonyMethod(typeof(SimilarPatches).GetMethod(nameof(GetSimilarItemsAsyncPrefix), BindingFlags.Static | BindingFlags.NonPublic)));

            Available = true;
            logger?.LogInformation("GpuUpscale: patched SimilarItemsManager.GetSimilarItemsAsync (More Like This for Video items, ranked by shared tags and people)");
        }

        /// <summary>
        /// Parameter names must match the original's. Returning false skips the original and uses
        /// __result; returning true runs it untouched.
        /// </summary>
        private static bool GetSimilarItemsAsyncPrefix(
            object __instance,
            BaseItem item,
            Jellyfin.Database.Implementations.Entities.User user,
            DtoOptions dtoOptions,
            int? limit,
            LibraryOptions libraryOptions,
            CancellationToken cancellationToken,
            ref Task<IReadOnlyList<BaseItem>> __result)
        {
            try
            {
                // Exact type: Movie, Episode, MusicVideo, Trailer... all derive from Video and keep
                // their own providers. No user: keep the stock (empty) answer rather than guess at access.
                if (__instance == null || item == null || user == null || item.GetType() != typeof(Video))
                {
                    return true;
                }

                var count = Math.Clamp(limit ?? MaxLimit, 1, MaxLimit);
                __result = RankAsync(__instance, item, user, dtoOptions, count, cancellationToken);
                return false;
            }
            catch (Exception ex)
            {
                _logger?.LogWarning(ex, "GpuUpscale: Video similar-items prefix failed; using the stock result.");
                return true;
            }
        }

        private static async Task<IReadOnlyList<BaseItem>> RankAsync(
            object manager,
            BaseItem item,
            Jellyfin.Database.Implementations.Entities.User user,
            DtoOptions dtoOptions,
            int limit,
            CancellationToken cancellationToken)
        {
            try
            {
                var factory = (IDbContextFactory<JellyfinDbContext>)_dbProvider.GetValue(manager);
                var libraryManager = (ILibraryManager)_libraryManager.GetValue(manager);
                if (factory == null || libraryManager == null)
                {
                    return Array.Empty<BaseItem>();
                }

                // The user's accessible top-level libraries. Must run BEFORE ItemIds is set: the
                // library manager only fills TopParentIds for a query that names no ids.
                var query = new InternalItemsQuery(user)
                {
                    IncludeItemTypes = new[] { BaseItemKind.Video },
                    ExcludeItemIds = new[] { item.Id },
                    DtoOptions = dtoOptions ?? new DtoOptions(),
                    EnableTotalRecordCount = false
                };
                libraryManager.ConfigureUserAccess(query, user);
                var topParents = query.TopParentIds;
                if (topParents == null || topParents.Length == 0)
                {
                    return Array.Empty<BaseItem>();
                }

                var scores = await ScoreAsync(factory, item.Id, topParents, cancellationToken).ConfigureAwait(false);
                if (scores.Count == 0)
                {
                    return Array.Empty<BaseItem>();
                }

                // Over-fetch: some candidates are dropped by the access pipeline below.
                query.ItemIds = scores
                    .OrderByDescending(kv => kv.Value)
                    .ThenBy(kv => kv.Key)
                    .Take(Math.Max(limit * 4, 48))
                    .Select(kv => kv.Key)
                    .ToArray();

                var loaded = libraryManager.GetItemList(query);

                IReadOnlyList<BaseItem> ranked = loaded
                    .Where(i => i != null && i.Id != item.Id)
                    .OrderByDescending(i => scores.TryGetValue(i.Id, out var s) ? s : 0d)
                    .ThenBy(i => i.Id)
                    .Take(limit)
                    .ToList();

                // Second layer: the manager's own library-access check, applied to what is returned.
                var checkedTask = (Task<IReadOnlyList<BaseItem>>)_filterByLibraryAccess.Invoke(
                    manager, new object[] { ranked, user, cancellationToken });
                ranked = await checkedTask.ConfigureAwait(false);

                _logger?.LogDebug(
                    "GpuUpscale: More Like This for Video {ItemId}: {Candidates} candidates, {Returned} returned",
                    item.Id,
                    scores.Count,
                    ranked.Count);
                return ranked;
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                // The stock answer for a Video is an empty list, so that is the safe failure.
                _logger?.LogWarning(ex, "GpuUpscale: Video similar-items ranking failed; returning nothing.");
                return Array.Empty<BaseItem>();
            }
        }

        /// <summary>
        /// Candidate id to score. Videos only, inside the user's libraries, never the source itself.
        /// </summary>
        private static async Task<Dictionary<Guid, double>> ScoreAsync(
            IDbContextFactory<JellyfinDbContext> factory,
            Guid sourceId,
            Guid[] topParents,
            CancellationToken cancellationToken)
        {
            var scores = new Dictionary<Guid, double>();
            var videoType = VideoTypeName;

            var db = await factory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
            await using (db.ConfigureAwait(false))
            {
                // TAGS. The source's tag value ids, then how many items carry each.
                var sourceTags = await db.ItemValuesMap.AsNoTracking()
                    .Where(m => m.ItemId == sourceId && m.ItemValue.Type == ItemValueType.Tags)
                    .Select(m => m.ItemValueId)
                    .Take(MaxSourceValues)
                    .ToListAsync(cancellationToken).ConfigureAwait(false);

                if (sourceTags.Count > 0)
                {
                    var freq = await db.ItemValuesMap.AsNoTracking()
                        .Where(m => sourceTags.Contains(m.ItemValueId))
                        .GroupBy(m => m.ItemValueId)
                        .Select(g => new { Id = g.Key, N = g.Count() })
                        .ToListAsync(cancellationToken).ConfigureAwait(false);

                    var chosen = Rarest(freq.Select(f => (f.Id, f.N)));
                    if (chosen.Count > 0)
                    {
                        var ids = chosen.Keys.ToList();
                        var rows = await db.ItemValuesMap.AsNoTracking()
                            .Where(m => ids.Contains(m.ItemValueId)
                                && m.ItemId != sourceId
                                && m.Item.Type == videoType
                                && !m.Item.IsVirtualItem
                                && m.Item.TopParentId != null
                                && topParents.Contains(m.Item.TopParentId.Value))
                            .Select(m => new { m.ItemValueId, m.ItemId })
                            .ToListAsync(cancellationToken).ConfigureAwait(false);

                        foreach (var r in rows)
                        {
                            scores[r.ItemId] = scores.GetValueOrDefault(r.ItemId) + (TagWeight * chosen[r.ItemValueId]);
                        }
                    }
                }

                // PEOPLE. Same shape; one row per (item, person, role), so de-duplicate per pair.
                var sourcePeople = await db.PeopleBaseItemMap.AsNoTracking()
                    .Where(m => m.ItemId == sourceId)
                    .Select(m => m.PeopleId)
                    .Distinct()
                    .Take(MaxSourceValues)
                    .ToListAsync(cancellationToken).ConfigureAwait(false);

                if (sourcePeople.Count > 0)
                {
                    var freq = await db.PeopleBaseItemMap.AsNoTracking()
                        .Where(m => sourcePeople.Contains(m.PeopleId))
                        .GroupBy(m => m.PeopleId)
                        .Select(g => new { Id = g.Key, N = g.Count() })
                        .ToListAsync(cancellationToken).ConfigureAwait(false);

                    var chosen = Rarest(freq.Select(f => (f.Id, f.N)));
                    if (chosen.Count > 0)
                    {
                        var ids = chosen.Keys.ToList();
                        var rows = await db.PeopleBaseItemMap.AsNoTracking()
                            .Where(m => ids.Contains(m.PeopleId)
                                && m.ItemId != sourceId
                                && m.Item.Type == videoType
                                && !m.Item.IsVirtualItem
                                && m.Item.TopParentId != null
                                && topParents.Contains(m.Item.TopParentId.Value))
                            .Select(m => new { m.PeopleId, m.ItemId })
                            .Distinct()
                            .ToListAsync(cancellationToken).ConfigureAwait(false);

                        foreach (var r in rows)
                        {
                            scores[r.ItemId] = scores.GetValueOrDefault(r.ItemId) + (PersonWeight * chosen[r.PeopleId]);
                        }
                    }
                }
            }

            return scores;
        }

        /// <summary>
        /// The values worth matching on: shared with at least one other item (N &gt;= 2, the source
        /// being one), not so common they say nothing or cost too much to read (N &lt;= MaxPostings),
        /// rarest first and at most MaxValues. Maps value id to its idf weight.
        /// </summary>
        private static Dictionary<Guid, double> Rarest(IEnumerable<(Guid Id, int N)> freq)
        {
            return freq
                .Where(f => f.N >= 2 && f.N <= MaxPostings)
                .OrderBy(f => f.N)
                .Take(MaxValues)
                .ToDictionary(f => f.Id, f => 1.0 / Math.Log(2.0 + f.N));
        }
    }
}
