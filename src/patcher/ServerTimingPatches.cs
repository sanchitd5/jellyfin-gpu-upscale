using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using HarmonyLib;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Plus.Patcher
{
    /// <summary>
    /// A <c>Server-Timing</c> response header on <c>/Items?searchTerm=...</c> that says where the time of
    /// a search went, so "search feels slow" becomes a number in the browser's Network tab (Timing) instead
    /// of a guess. Stages, in the order they happen:
    ///
    /// - <c>search</c>: SearchManager.GetSearchResultsAsync end to end (candidate ids + scores, includes
    ///   <c>sort</c>).
    /// - <c>name</c>: the stock SqlSearchProvider name match. <c>tags</c>: what this plugin's tag-match
    ///   postfix added on top of it. <c>sort</c>: the sort / all-of-people re-score (SearchSortPatches).
    /// - <c>load</c>: <c>Folder.GetItems</c>, the entity load the controller does for the candidates (user
    ///   access and every other filter applied, full BaseItems materialised). With deep paging
    ///   (SearchDeepPagePatches) its sub-stages are <c>deep-ids</c>, <c>deep-rows</c> and <c>deep-page</c>.
    /// - <c>dto</c>: DtoService.GetBaseItemDtos, building the response items for the page.
    /// - <c>total</c>: from the start of the search stage to the moment the response headers are sent. It
    ///   leaves out routing, authentication and body serialisation.
    ///
    /// SCOPE AND COST. Nothing is recorded unless the request is an /Items request with a non-empty
    /// searchTerm: the SearchManager prefix is the only place a request gets a timing bag, and every
    /// other hook starts by looking for that bag (one dictionary lookup on HttpContext.Items), so every
    /// other request pays nothing measurable. The header carries durations and two counts, never item
    /// data. Total, like every other patch: a failure here only loses the header.
    /// </summary>
    internal static class ServerTimingPatches
    {
        internal const string BagKey = "JellyfinPlus.ServerTiming";

        private static readonly HttpContextAccessor _http = new HttpContextAccessor();

        private static ILogger _logger;
        private static bool _warned;

        /// <summary>True once the SearchManager hook (the one that creates the bag) is installed.</summary>
        public static bool Available { get; private set; }

        /// <summary>One request's stage durations, in the order they were first recorded.</summary>
        internal sealed class Timings
        {
            private readonly object _gate = new object();
            private readonly List<string> _order = new List<string>();
            private readonly Dictionary<string, double> _ms = new Dictionary<string, double>();
            private readonly Dictionary<string, string> _desc = new Dictionary<string, string>();

            public long Start { get; } = Stopwatch.GetTimestamp();

            /// <summary>When the provider (name match + tag postfix) was entered; set by its prefix.</summary>
            public long ProviderStart { get; set; }

            public void Add(string stage, double ms, string desc = null)
            {
                lock (_gate)
                {
                    if (!_ms.TryGetValue(stage, out var old))
                    {
                        _order.Add(stage);
                    }

                    _ms[stage] = old + ms;
                    if (desc != null)
                    {
                        _desc[stage] = desc;
                    }
                }
            }

            public string Format()
            {
                lock (_gate)
                {
                    var sb = new StringBuilder();
                    void Emit(string name, double ms)
                    {
                        if (sb.Length > 0)
                        {
                            sb.Append(", ");
                        }

                        sb.Append(name);
                        if (_desc.TryGetValue(name, out var d))
                        {
                            sb.Append(";desc=\"").Append(d).Append('"');
                        }

                        sb.Append(";dur=").Append(ms.ToString("0.0", CultureInfo.InvariantCulture));
                    }

                    foreach (var stage in _order)
                    {
                        if (stage == "provider")
                        {
                            // The provider total is only here so tags = provider - name can be derived.
                            continue;
                        }

                        Emit(stage, _ms[stage]);
                        if (stage == "name" && _ms.TryGetValue("provider", out var provider))
                        {
                            Emit("tags", Math.Max(0, provider - _ms["name"]));
                        }
                    }

                    Emit("total", Ms(Start));
                    return sb.ToString();
                }
            }
        }

        internal static double Ms(long startTimestamp)
            => (Stopwatch.GetTimestamp() - startTimestamp) * 1000.0 / Stopwatch.Frequency;

        /// <summary>The current request's bag, or null (not a search, or no request at all).</summary>
        internal static Timings Current()
        {
            var items = _http.HttpContext?.Items;
            return items != null && items.TryGetValue(BagKey, out var o) ? o as Timings : null;
        }

        /// <summary>Records a stage on the current request's bag, if there is one. Never throws.</summary>
        internal static void Record(string stage, double ms, string desc = null)
        {
            try
            {
                Current()?.Add(stage, ms, desc);
            }
            catch (Exception ex)
            {
                Warn(ex);
            }
        }

        public static void Apply(Harmony harmony, ILogger logger)
        {
            _logger = logger;

            var manager = AccessTools.TypeByName("Emby.Server.Implementations.Library.Search.SearchManager");
            var search = manager == null
                ? null
                : AccessTools.Method(manager, "GetSearchResultsAsync", new[] { typeof(SearchProviderQuery), typeof(System.Threading.CancellationToken) });
            if (search == null)
            {
                Available = false;
                logger?.LogWarning("JellyfinPlus: could not resolve SearchManager.GetSearchResultsAsync; the Server-Timing header on searches is unavailable. Search itself is unaffected.");
                return;
            }

            harmony.Patch(
                search,
                prefix: new HarmonyMethod(Method(nameof(SearchPrefix))) { priority = Priority.First },
                postfix: new HarmonyMethod(Method(nameof(SearchPostfix))) { priority = Priority.Last });
            Available = true;

            // Each of the rest is optional on its own: a missing one just leaves its stage out.
            TryPatch(harmony, "SqlSearchProvider.SearchAsync", () =>
            {
                var provider = AccessTools.TypeByName("Emby.Server.Implementations.Library.Search.SqlSearchProvider");
                return provider == null
                    ? null
                    : AccessTools.Method(provider, "SearchAsync", new[] { typeof(SearchProviderQuery), typeof(System.Threading.CancellationToken) });
            },
                prefix: new HarmonyMethod(Method(nameof(ProviderPrefix))) { priority = Priority.First },
                // First: runs before SearchPatches' tag postfix, so it sees the stock Task only (the name match).
                postfix: new HarmonyMethod(Method(nameof(NamePostfix))) { priority = Priority.First });
            TryPatch(harmony, "SqlSearchProvider.SearchAsync (provider total)", () =>
            {
                var provider = AccessTools.TypeByName("Emby.Server.Implementations.Library.Search.SqlSearchProvider");
                return provider == null
                    ? null
                    : AccessTools.Method(provider, "SearchAsync", new[] { typeof(SearchProviderQuery), typeof(System.Threading.CancellationToken) });
            },
                prefix: null,
                // Last: runs after the tag postfix replaced the Task, so it sees name match + tags.
                postfix: new HarmonyMethod(Method(nameof(ProviderPostfix))) { priority = Priority.Last });
            TryPatch(harmony, "Folder.GetItems", () => typeof(Folder).GetMethod(nameof(Folder.GetItems), new[] { typeof(InternalItemsQuery) }),
                prefix: new HarmonyMethod(Method(nameof(StagePrefix))),
                postfix: new HarmonyMethod(Method(nameof(LoadPostfix))));

            var dto = AccessTools.TypeByName("Emby.Server.Implementations.Dto.DtoService");
            if (dto != null)
            {
                foreach (var m in dto.GetMethods(BindingFlags.Instance | BindingFlags.Public).Where(m => m.Name == "GetBaseItemDtos"))
                {
                    var captured = m;
                    TryPatch(harmony, "DtoService.GetBaseItemDtos", () => captured,
                        prefix: new HarmonyMethod(Method(nameof(StagePrefix))),
                        postfix: new HarmonyMethod(Method(nameof(DtoPostfix))));
                }
            }

            logger?.LogInformation("JellyfinPlus: patched search stages for the Server-Timing header on /Items?searchTerm=");
        }

        private static MethodInfo Method(string name)
            => typeof(ServerTimingPatches).GetMethod(name, BindingFlags.Static | BindingFlags.NonPublic);

        private static void TryPatch(Harmony harmony, string what, Func<MethodBase> resolve, HarmonyMethod prefix, HarmonyMethod postfix)
        {
            try
            {
                var target = resolve();
                if (target == null)
                {
                    _logger?.LogInformation("JellyfinPlus: Server-Timing stage for {Target} unavailable on this Jellyfin build (the other stages still work).", what);
                    return;
                }

                harmony.Patch(target, prefix: prefix, postfix: postfix);
            }
            catch (Exception ex)
            {
                _logger?.LogWarning(ex, "JellyfinPlus: Server-Timing stage for {Target} could not be installed.", what);
            }
        }

        /// <summary>Starts the bag for a search request and arranges for the header to be written.</summary>
        private static void SearchPrefix(out Timings __state)
        {
            __state = null;
            try
            {
                var ctx = _http.HttpContext;
                var request = ctx?.Request;
                if (request == null || !request.Path.HasValue
                    || !request.Path.Value.EndsWith("/Items", StringComparison.OrdinalIgnoreCase)
                    || !request.Query.ContainsKey("searchTerm"))
                {
                    return;
                }

                if (ctx.Items.TryGetValue(BagKey, out var existing) && existing is Timings reused)
                {
                    __state = reused;
                    return;
                }

                var timings = new Timings();
                ctx.Items[BagKey] = timings;
                ctx.Response.OnStarting(
                    static state =>
                    {
                        var (context, bag) = ((HttpContext, Timings))state;
                        try
                        {
                            if (!context.Response.HasStarted)
                            {
                                context.Response.Headers["Server-Timing"] = bag.Format();
                            }
                        }
                        catch (Exception)
                        {
                            // Losing the header is the whole cost of a failure here.
                        }

                        return Task.CompletedTask;
                    },
                    (ctx, timings));
                __state = timings;
            }
            catch (Exception ex)
            {
                Warn(ex);
            }
        }

        private static void SearchPostfix(Timings __state, ref Task<IReadOnlyList<SearchResult>> __result)
        {
            if (__state == null || __result == null)
            {
                return;
            }

            __result = Track(__result, __state, "search", __state.Start);
        }

        private static void ProviderPrefix()
        {
            var tm = Current();
            if (tm != null)
            {
                tm.ProviderStart = Stopwatch.GetTimestamp();
            }
        }

        private static void NamePostfix(ref Task<IReadOnlyList<SearchResult>> __result)
        {
            var tm = Current();
            if (tm != null && __result != null)
            {
                __result = Track(__result, tm, "name", tm.ProviderStart);
            }
        }

        private static void ProviderPostfix(ref Task<IReadOnlyList<SearchResult>> __result)
        {
            var tm = Current();
            if (tm != null && __result != null)
            {
                __result = Track(__result, tm, "provider", tm.ProviderStart);
            }
        }

        private static void StagePrefix(out long __state)
            => __state = Current() == null ? 0 : Stopwatch.GetTimestamp();

        private static void LoadPostfix(long __state)
        {
            if (__state != 0)
            {
                Record("load", Ms(__state));
            }
        }

        private static void DtoPostfix(long __state)
        {
            if (__state != 0)
            {
                Record("dto", Ms(__state));
            }
        }

        // The continuation is registered before the caller awaits the Task (the postfix runs
        // synchronously, inside the patched method), so the stage is recorded before any code that
        // depends on that Task's result runs. The Task itself is returned unchanged.
        private static Task<T> Track<T>(Task<T> task, Timings timings, string stage, long start)
        {
            task.ContinueWith(
                _ => timings.Add(stage, Ms(start)),
                System.Threading.CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
            return task;
        }

        private static void Warn(Exception ex)
        {
            if (_warned)
            {
                return;
            }

            _warned = true;
            _logger?.LogWarning(ex, "JellyfinPlus: Server-Timing recording failed; searches are unaffected, the header may be missing.");
        }
    }
}
