using System;
using System.Reflection;
using System.Threading.Tasks;
using HarmonyLib;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.MediaEncoding.Transcoding;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.GpuUpscale.Patcher
{
    /// <summary>
    /// The A/B live-apply swap, built for real per .agent-briefs/ab-swap-implement.md.
    ///
    /// LIVE_APPLY_DESIGN.md named "TranscodingJobHelper" as the stock class this project had never
    /// patched, flagged as unconfirmed. It does not exist under that name on this Jellyfin build
    /// (12.1): confirmed by decompiling the actual assemblies this project builds against
    /// (MediaBrowser.MediaEncoding.dll). The real owner of transcode-job lifecycle here is
    /// <see cref="TranscodeManager"/> (MediaBrowser.MediaEncoding.Transcoding), a public sealed
    /// class implementing MediaBrowser.Controller.MediaEncoding.ITranscodeManager.
    ///
    /// THE SEAM. Jellyfin.Api.Controllers.PlaystateController.ReportPlaybackStopped (the server
    /// side of jellyfin-web's changeStream() calling stopActiveEncodings(oldPlaySessionId), per
    /// live-apply.js's own comment) calls TranscodeManager.KillTranscodingJobs(deviceId,
    /// playSessionId, deleteFiles) - torn down immediately, before the new ffmpeg process for the
    /// re-negotiated stream exists. That immediate teardown is the gap this design closes.
    ///
    /// THE FIX. KillTranscodingJobsPrefix defers (skips) that call for a session this plugin
    /// admitted as a live-apply swap (see UpscaleEngine.TryAdmitSwap, driven by the "swapfrom"
    /// query marker network.js now attaches - see UpscalePatches.BuildVerdict). StartFfMpegPostfix
    /// detects "the new process is ready": TranscodeManager.StartFfMpeg already does not return
    /// until the new job's first segment file exists (or the job exits) - see its own wait loop -
    /// so no separate filesystem watch was needed, that plumbing already existed in stock Jellyfin.
    /// Once the new job for the SAME DEVICE is ready, UpscaleEngine.OnNewJobReady replays the
    /// deferred kill for real, tearing the old process down only now. A swap that never completes
    /// (the client never re-negotiates, or admission never happened) times out on its own
    /// (UpscaleEngine.SweepExpiredSwaps) and still tears the old job down - it is never orphaned.
    /// </summary>
    internal static class SwapPatches
    {
        private static ILogger _logger;

        /// <summary>True once both targets were resolved and patched.</summary>
        public static bool Available { get; private set; }

        public static void Apply(Harmony harmony, ILogger logger)
        {
            _logger = logger;

            var killMethod = AccessTools.Method(
                typeof(TranscodeManager),
                "KillTranscodingJobs",
                new[] { typeof(string), typeof(string), typeof(Func<string, bool>) });
            var startMethod = AccessTools.Method(typeof(TranscodeManager), "StartFfMpeg");

            if (killMethod == null || startMethod == null)
            {
                Available = false;
                logger?.LogWarning(
                    "GpuUpscale: could not resolve TranscodeManager.{Missing}; the A/B live-apply "
                    + "swap is unavailable on this Jellyfin build. Live-apply still works, via "
                    + "today's tear-down-and-restart.",
                    killMethod == null && startMethod == null
                        ? "KillTranscodingJobs and StartFfMpeg"
                        : killMethod == null ? "KillTranscodingJobs" : "StartFfMpeg");
                return;
            }

            harmony.Patch(
                killMethod,
                prefix: new HarmonyMethod(typeof(SwapPatches).GetMethod(nameof(KillTranscodingJobsPrefix), BindingFlags.Static | BindingFlags.NonPublic)));
            harmony.Patch(
                startMethod,
                postfix: new HarmonyMethod(typeof(SwapPatches).GetMethod(nameof(StartFfMpegPostfix), BindingFlags.Static | BindingFlags.NonPublic)));

            Available = true;
            logger?.LogInformation("GpuUpscale: patched TranscodeManager.KillTranscodingJobs/StartFfMpeg for the A/B live-apply swap");
        }

        /// <summary>
        /// Skips the real kill (returning a completed Task in its place, since
        /// TranscodeManager.KillTranscodingJobs is a plain method returning Task, not async - a
        /// skipped call with no __result set would hand its caller a null Task to await) while a
        /// swap for this exact old session id is admitted and pending. Any surprise falls through
        /// to the normal kill: this must never be the reason a session fails to tear down.
        /// </summary>
        private static bool KillTranscodingJobsPrefix(object __instance, string deviceId, string playSessionId, Func<string, bool> deleteFiles, ref Task __result)
        {
            try
            {
                if (string.IsNullOrEmpty(playSessionId))
                {
                    return true;
                }

                if (__instance is TranscodeManager manager
                    && UpscaleEngine.TryDeferKill(manager, playSessionId, deviceId, deleteFiles))
                {
                    _logger?.LogInformation("GpuUpscale: deferring teardown of {PlaySessionId} for a live A/B swap", playSessionId);
                    __result = Task.CompletedTask;
                    return false;
                }

                return true;
            }
            catch (Exception ex)
            {
                _logger?.LogError(ex, "GpuUpscale: swap-kill prefix failed; falling back to the normal kill");
                return true;
            }
        }

        /// <summary>
        /// StartFfMpeg is `async Task&lt;TranscodingJob&gt;`, so the Task Harmony hands the postfix
        /// is the live, still-in-flight one - wrapping it with a continuation (rather than trying to
        /// read __result's value directly) is what lets this run AFTER the new process is actually
        /// ready without changing what the original caller awaits or its result.
        /// </summary>
        private static void StartFfMpegPostfix(ref Task<TranscodingJob> __result)
        {
            __result = ContinueAfterReady(__result);
        }

        private static async Task<TranscodingJob> ContinueAfterReady(Task<TranscodingJob> inner)
        {
            TranscodingJob job = await inner.ConfigureAwait(false);
            try
            {
                UpscaleEngine.OnNewJobReady(job);
            }
            catch (Exception ex)
            {
                _logger?.LogError(ex, "GpuUpscale: swap cutover failed after the new ffmpeg process was ready");
            }

            return job;
        }
    }
}
