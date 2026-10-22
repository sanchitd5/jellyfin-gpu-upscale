using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using HarmonyLib;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Plus.Patcher
{
    /// <summary>
    /// MEASUREMENT ONLY. Times where the weekly library scan spends its wall clock, with no behaviour
    /// change: every prefix/postfix only reads a timestamp and bumps counters, and the async targets are
    /// observed through a continuation on the task they already returned (never replaced, never awaited,
    /// so results and exceptions flow exactly as before).
    ///
    /// What is timed (all INCLUSIVE: a parent's time contains its children's, and a folder's
    /// ValidateChildrenInternal2 contains the subtree below it, so per-depth totals overlap and must not
    /// be summed across depths or across phases):
    ///   validate     Folder.ValidateChildrenInternal2, per folder, by depth of that folder
    ///   nonCached    Folder.GetNonCachedChildren, by depth. SYNCHRONOUS PART ONLY: the file listing and
    ///                ignore rules. The per-file resolve is a lazy iterator drained later by ToArray(),
    ///                so it shows up under resolvePath, not here.
    ///   resolvePath  LibraryManager.ResolvePath (the private 6-argument overload every child of a scanned
    ///                folder goes through), by depth of the PARENT folder. The disk-resolve cost proper.
    ///   subFolders   Folder.ValidateSubFolders (the recursion into child folders), by depth
    ///   refreshRec   Folder.RefreshMetadataRecursive (refreshing the children), by depth
    ///   meta         MetadataService&lt;,&gt;.RefreshMetadata, by item kind only (Video / Folder)
    ///
    /// DEPTH is relative to the library's physical root: 1 = model, 2 = category, 3 = date folder,
    /// 0 = the library root itself, "4+" deeper, "other" = path under no known library root. Roots are
    /// learned from CollectionFolder.PhysicalLocations when the scan reaches the CollectionFolder.
    ///
    /// OUTPUT. One INF line per non-empty bucket every 15 minutes while a scan runs (cumulative since
    /// the scan began, tagged "partial") and at the end of each scan (tagged "final", then counters
    /// reset). The end hook runs as a continuation, so a cancelled or failed scan still reports.
    ///
    /// Total and fail-soft like every patch here. Nothing logs per call.
    /// </summary>
    internal static class ScanTimingPatches
    {
        private const int Phases = 5;
        private const int DepthBuckets = 6; // 0 root, 1, 2, 3, 4+, other
        private const int MetaBase = Phases * DepthBuckets;
        private const int Slots = MetaBase + 2; // + Video, Folder

        private const int PhValidate = 0;
        private const int PhNonCached = 1;
        private const int PhResolve = 2;
        private const int PhSubFolders = 3;
        private const int PhRefreshRec = 4;

        private static readonly string[] PhaseNames = { "validate", "nonCached", "resolvePath", "subFolders", "refreshRec" };
        private static readonly string[] DepthNames = { "0:root", "1:model", "2:category", "3:date", "4+", "other" };

        private static readonly long[] Count = new long[Slots];
        private static readonly long[] TotalTicks = new long[Slots];
        private static readonly long[] MaxTicks = new long[Slots];

        private static ILogger _logger;
        private static volatile string[] _roots = Array.Empty<string>();
        private static Timer _timer;
        private static long _scanStart;
        private static int _scanning;

        /// <summary>True once the required targets were resolved and patched.</summary>
        public static bool Available { get; private set; }

        private sealed class Pending
        {
            public long Start;
            public int Slot;
        }

        public static void Apply(Harmony harmony, ILogger logger)
        {
            _logger = logger;

            var folder = typeof(Folder);
            var validate = AccessTools.Method(folder, "ValidateChildrenInternal2");
            var libMgr = AccessTools.TypeByName("Emby.Server.Implementations.Library.LibraryManager");
            var scan = libMgr == null ? null : AccessTools.Method(libMgr, "ValidateMediaLibraryInternal");

            // Required: without the folder method there is nothing to measure, without the scan hook
            // there is nowhere to report from.
            var missing = new List<string>();
            if (validate == null)
            {
                missing.Add("Folder.ValidateChildrenInternal2");
            }

            if (libMgr == null)
            {
                missing.Add("LibraryManager");
            }
            else if (scan == null)
            {
                missing.Add("LibraryManager.ValidateMediaLibraryInternal");
            }

            if (missing.Count > 0)
            {
                Available = false;
                logger?.LogWarning(
                    "JellyfinPlus: could not resolve {Missing}; scan timing is unavailable on this Jellyfin build. Stock behaviour is unaffected.",
                    string.Join(", ", missing));
                return;
            }

            // Best effort: a missing phase is reported and skipped, the rest still measures.
            var nonCached = AccessTools.Method(folder, "GetNonCachedChildren");
            var subFolders = AccessTools.Method(folder, "ValidateSubFolders");
            var refreshRec = AccessTools.Method(folder, "RefreshMetadataRecursive");
            var resolvePath = libMgr.GetMethods(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.DeclaredOnly)
                .FirstOrDefault(m => m.Name == "ResolvePath" && m.GetParameters().Length == 6);
            var videoSvc = AccessTools.TypeByName("MediaBrowser.Providers.Videos.VideoMetadataService");
            // Declared on MetadataService<TItemType, TIdType>; neither concrete service overrides it.
            var meta = videoSvc == null ? null : AccessTools.Method(videoSvc, "RefreshMetadata");

            const BindingFlags f = BindingFlags.Static | BindingFlags.NonPublic;
            var self = typeof(ScanTimingPatches);
            var patched = new List<string>();
            var skipped = new List<string>();
            var targets = new List<MethodBase>();

            void Hook(string name, MethodBase target, string pre, string post)
            {
                if (target == null)
                {
                    skipped.Add(name);
                    return;
                }

                try
                {
                    harmony.Patch(
                        target,
                        prefix: new HarmonyMethod(self.GetMethod(pre, f)),
                        postfix: new HarmonyMethod(self.GetMethod(post, f)));
                    patched.Add(name + " (" + Describe(target) + ")");
                    targets.Add(target);
                }
                catch (Exception ex)
                {
                    skipped.Add(name);
                    logger?.LogWarning(ex, "JellyfinPlus: scan timing could not patch {Method}; continuing without it.", name);
                }
            }

            Hook("Folder.ValidateChildrenInternal2", validate, nameof(ValidatePre), nameof(ValidatePost));
            Hook("Folder.GetNonCachedChildren", nonCached, nameof(StatePre), nameof(NonCachedPost));
            Hook("LibraryManager.ResolvePath", resolvePath, nameof(StatePre), nameof(ResolvePost));
            Hook("Folder.ValidateSubFolders", subFolders, nameof(StatePre), nameof(SubFoldersPost));
            Hook("Folder.RefreshMetadataRecursive", refreshRec, nameof(StatePre), nameof(RefreshRecPost));
            Hook("MetadataService.RefreshMetadata", meta, nameof(StatePre), nameof(MetaPost));
            Hook("LibraryManager.ValidateMediaLibraryInternal", scan, nameof(ScanPre), nameof(ScanPost));

            if (!patched.Any(p => p.StartsWith("Folder.ValidateChildrenInternal2", StringComparison.Ordinal))
                || !patched.Any(p => p.StartsWith("LibraryManager.ValidateMediaLibraryInternal", StringComparison.Ordinal)))
            {
                // A required hook failed to install: do not leave half a probe running silently.
                // Per target, never UnpatchAll: that would take the core transcode patches with it.
                foreach (var t in targets)
                {
                    try
                    {
                        harmony.Unpatch(t, HarmonyPatchType.All, harmony.Id);
                    }
                    catch (Exception)
                    {
                        // nothing else to do
                    }
                }

                Available = false;
                logger?.LogWarning("JellyfinPlus: scan timing required hooks failed; unavailable. Stock behaviour is unaffected.");
                return;
            }

            Available = true;
            logger?.LogInformation("JellyfinPlus: scan timing patched {Patched}", string.Join("; ", patched));
            if (skipped.Count > 0)
            {
                logger?.LogWarning("JellyfinPlus: scan timing skipped (not found or failed): {Skipped}", string.Join(", ", skipped));
            }
        }

        private static string Describe(MethodBase m)
        {
            return (m.DeclaringType?.FullName ?? "?") + "." + m.Name + "("
                + string.Join(", ", m.GetParameters().Select(p => p.ParameterType.Name)) + ")";
        }

        // ---------------------------------------------------------------- recording

        private static int DepthBucket(BaseItem item)
        {
            if (item == null)
            {
                return DepthBuckets - 1;
            }

            if (item is CollectionFolder)
            {
                return 0;
            }

            var path = item.Path;
            if (string.IsNullOrEmpty(path))
            {
                return DepthBuckets - 1;
            }

            var roots = _roots;
            for (var r = 0; r < roots.Length; r++)
            {
                var root = roots[r];
                if (path.Length < root.Length || !path.StartsWith(root, StringComparison.Ordinal))
                {
                    continue;
                }

                if (path.Length == root.Length)
                {
                    return 0;
                }

                if (path[root.Length] != '/' && path[root.Length] != '\\')
                {
                    continue;
                }

                var end = path.Length;
                if (path[end - 1] == '/' || path[end - 1] == '\\')
                {
                    end--;
                }

                var depth = 0;
                for (var i = root.Length; i < end; i++)
                {
                    if (path[i] == '/' || path[i] == '\\')
                    {
                        depth++;
                    }
                }

                return depth >= 4 ? 4 : depth;
            }

            return DepthBuckets - 1;
        }

        private static void Record(int slot, long startTicks)
        {
            var d = Stopwatch.GetTimestamp() - startTicks;
            Interlocked.Increment(ref Count[slot]);
            Interlocked.Add(ref TotalTicks[slot], d);
            long cur;
            while (d > (cur = Volatile.Read(ref MaxTicks[slot])))
            {
                if (Interlocked.CompareExchange(ref MaxTicks[slot], d, cur) == cur)
                {
                    break;
                }
            }
        }

        /// <summary>Observe an async target's completion without touching its task.</summary>
        private static void Observe(Task task, int slot, long start)
        {
            if (task == null)
            {
                return;
            }

            task.ContinueWith(
                static (t, s) =>
                {
                    var p = (Pending)s;
                    Record(p.Slot, p.Start);
                },
                new Pending { Start = start, Slot = slot },
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
        }

        // ---------------------------------------------------------------- prefixes / postfixes

        private static void StatePre(out long __state)
        {
            __state = Stopwatch.GetTimestamp();
        }

        private static void ValidatePre(Folder __instance, out long __state)
        {
            __state = Stopwatch.GetTimestamp();
            try
            {
                if (__instance is CollectionFolder cf)
                {
                    LearnRoots(cf);
                }
            }
            catch (Exception)
            {
                // measurement only
            }
        }

        private static void LearnRoots(CollectionFolder cf)
        {
            var locs = cf.PhysicalLocations;
            if (locs == null)
            {
                return;
            }

            var cur = _roots;
            List<string> add = null;
            foreach (var l in locs)
            {
                if (string.IsNullOrEmpty(l))
                {
                    continue;
                }

                var n = l.TrimEnd('/', '\\');
                if (n.Length > 0 && Array.IndexOf(cur, n) < 0 && (add == null || !add.Contains(n)))
                {
                    (add ??= new List<string>()).Add(n);
                }
            }

            if (add != null)
            {
                _roots = cur.Concat(add).ToArray();
            }
        }

        private static void ValidatePost(Folder __instance, long __state, Task __result)
        {
            try
            {
                Observe(__result, (PhValidate * DepthBuckets) + DepthBucket(__instance), __state);
            }
            catch (Exception)
            {
                // measurement only
            }
        }

        private static void NonCachedPost(Folder __instance, long __state)
        {
            try
            {
                Record((PhNonCached * DepthBuckets) + DepthBucket(__instance), __state);
            }
            catch (Exception)
            {
                // measurement only
            }
        }

        // Parameter name must match the original's (private 6-argument ResolvePath).
        private static void ResolvePost(Folder parent, long __state)
        {
            try
            {
                Record((PhResolve * DepthBuckets) + DepthBucket(parent), __state);
            }
            catch (Exception)
            {
                // measurement only
            }
        }

        private static void SubFoldersPost(Folder __instance, long __state, Task __result)
        {
            try
            {
                Observe(__result, (PhSubFolders * DepthBuckets) + DepthBucket(__instance), __state);
            }
            catch (Exception)
            {
                // measurement only
            }
        }

        private static void RefreshRecPost(Folder __instance, long __state, Task __result)
        {
            try
            {
                Observe(__result, (PhRefreshRec * DepthBuckets) + DepthBucket(__instance), __state);
            }
            catch (Exception)
            {
                // measurement only
            }
        }

        // Parameter name must match the original's.
        private static void MetaPost(BaseItem item, long __state, Task<ItemUpdateType> __result)
        {
            try
            {
                var slot = item is Video ? MetaBase : (item is Folder ? MetaBase + 1 : -1);
                if (slot >= 0)
                {
                    Observe(__result, slot, __state);
                }
            }
            catch (Exception)
            {
                // measurement only
            }
        }

        // ---------------------------------------------------------------- scan boundaries

        private static void ScanPre()
        {
            try
            {
                Reset();
                Volatile.Write(ref _scanStart, Stopwatch.GetTimestamp());
                Volatile.Write(ref _scanning, 1);
                var t = new Timer(static _ => Emit("partial", false), null, TimeSpan.FromMinutes(15), TimeSpan.FromMinutes(15));
                Interlocked.Exchange(ref _timer, t)?.Dispose();
            }
            catch (Exception)
            {
                // measurement only
            }
        }

        private static void ScanPost(Task __result)
        {
            try
            {
                if (__result == null)
                {
                    return;
                }

                // Continuation runs on success, fault and cancel alike, so an aborted scan still reports.
                __result.ContinueWith(
                    static _ =>
                    {
                        try
                        {
                            Interlocked.Exchange(ref _timer, null)?.Dispose();
                            Volatile.Write(ref _scanning, 0);
                            Emit("final", true);
                        }
                        catch (Exception)
                        {
                            // measurement only
                        }
                    },
                    CancellationToken.None,
                    TaskContinuationOptions.ExecuteSynchronously,
                    TaskScheduler.Default);
            }
            catch (Exception)
            {
                // measurement only
            }
        }

        private static void Reset()
        {
            for (var i = 0; i < Slots; i++)
            {
                Interlocked.Exchange(ref Count[i], 0);
                Interlocked.Exchange(ref TotalTicks[i], 0);
                Interlocked.Exchange(ref MaxTicks[i], 0);
            }
        }

        private static void Emit(string kind, bool reset)
        {
            try
            {
                var logger = _logger;
                if (logger == null)
                {
                    return;
                }

                var freq = (double)Stopwatch.Frequency;
                var scanMin = (Stopwatch.GetTimestamp() - Volatile.Read(ref _scanStart)) / freq / 60.0;
                var any = false;
                for (var i = 0; i < Slots; i++)
                {
                    var n = reset ? Interlocked.Exchange(ref Count[i], 0) : Volatile.Read(ref Count[i]);
                    var tot = reset ? Interlocked.Exchange(ref TotalTicks[i], 0) : Volatile.Read(ref TotalTicks[i]);
                    var max = reset ? Interlocked.Exchange(ref MaxTicks[i], 0) : Volatile.Read(ref MaxTicks[i]);
                    if (n == 0)
                    {
                        continue;
                    }

                    any = true;
                    string name;
                    if (i >= MetaBase)
                    {
                        name = i == MetaBase ? "meta kind=Video" : "meta kind=Folder";
                    }
                    else
                    {
                        name = PhaseNames[i / DepthBuckets] + " depth=" + DepthNames[i % DepthBuckets];
                    }

                    var totMs = tot * 1000.0 / freq;
                    logger.LogInformation(
                        "JellyfinPlus: scan timing {Kind} scanMin={ScanMin} [{Bucket}] count={Count} totalMs={TotalMs} avgMs={AvgMs} maxMs={MaxMs} (inclusive)",
                        kind,
                        scanMin.ToString("F1", CultureInfo.InvariantCulture),
                        name,
                        n,
                        totMs.ToString("F0", CultureInfo.InvariantCulture),
                        (totMs / n).ToString("F2", CultureInfo.InvariantCulture),
                        (max * 1000.0 / freq).ToString("F0", CultureInfo.InvariantCulture));
                }

                if (!any)
                {
                    logger.LogInformation("JellyfinPlus: scan timing {Kind} scanMin={ScanMin} no samples", kind, scanMin.ToString("F1", CultureInfo.InvariantCulture));
                }
            }
            catch (Exception)
            {
                // measurement only
            }
        }
    }
}
