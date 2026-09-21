using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using HarmonyLib;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Model.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.GpuUpscale.Patcher
{
    /// <summary>
    /// Runtime patches over MediaBrowser.Controller.MediaEncoding.EncodingHelper.
    ///
    /// Jellyfin 12.1 exposes no plugin hook for the video filter graph, so the chain is injected by
    /// patching the EncodingHelper members that decide the filter chain, the hardware device
    /// arguments, the hardware decoder and the output video encoder.
    /// </summary>
    internal static class UpscalePatches
    {
        private const string HarmonyId = "jellyfin.plugin.gpuupscale";

        private static ILogger _logger;
        private static Harmony _harmony;

        public static string Status { get; private set; } = "not applied";

        public static bool Active { get; private set; }

        public static void Apply(ILogger logger)
        {
            _logger = logger;
            if (_harmony != null)
            {
                return;
            }

            try
            {
                var helper = typeof(EncodingHelper);
                var patches = new List<(MethodBase Target, string Postfix)>
                {
                    (AccessTools.Method(helper, "GetVideoProcessingFilterParam"), nameof(VideoProcessingFilterPostfix)),
                    (AccessTools.Method(helper, "GetInputVideoHwaccelArgs"), nameof(InputVideoHwaccelArgsPostfix)),
                    (AccessTools.Method(helper, "GetHwaccelType"), nameof(HwaccelTypePostfix)),
                    (AccessTools.Method(helper, "GetHardwareVideoDecoder"), nameof(HardwareVideoDecoderPostfix)),
                    (AccessTools.Method(helper, "GetVideoEncoder"), nameof(VideoEncoderPostfix)),
                };

                if (patches.Any(p => p.Target == null))
                {
                    Status = "failed: EncodingHelper method(s) not found on this Jellyfin build";
                    logger?.LogError("GpuUpscale: could not resolve all EncodingHelper methods; not patching.");
                    return;
                }

                var harmony = new Harmony(HarmonyId);
                foreach (var (target, postfix) in patches)
                {
                    harmony.Patch(target, postfix: new HarmonyMethod(typeof(UpscalePatches).GetMethod(postfix, BindingFlags.Static | BindingFlags.NonPublic)));
                    logger?.LogInformation("GpuUpscale: patched {Method}", target.Name);
                }

                _harmony = harmony;
                Active = true;
                Status = "active (5 EncodingHelper methods patched)";
                logger?.LogInformation("GpuUpscale: Harmony patches installed, plugin owns the transcode filter chain.");
            }
            catch (Exception ex)
            {
                Status = "failed: " + ex.Message;
                Active = false;
                logger?.LogError(ex, "GpuUpscale: Harmony patching failed; Jellyfin will transcode normally.");
                try
                {
                    _harmony?.UnpatchAll(HarmonyId);
                }
                catch (Exception)
                {
                    // nothing else to do
                }

                _harmony = null;
            }
        }

        private static bool ShouldAct(EncodingJobInfo state, out UpscaleEngine.Plan plan)
        {
            plan = UpscaleEngine.Plan.No("ineligible", "n/a");
            try
            {
                plan = UpscaleEngine.Decide(state);
                return plan.Act;
            }
            catch (Exception ex)
            {
                _logger?.LogError(ex, "GpuUpscale: decision failed");
                return false;
            }
        }

        /// <summary>
        /// Replaces Jellyfin's -vf chain with the libplacebo chain, keeping Jellyfin's own
        /// non-scaling nodes. This is also where the session's outcome is recorded, so what the
        /// dashboard and the player overlay report is exactly what went into the command.
        /// </summary>
        private static void VideoProcessingFilterPostfix(EncodingJobInfo state, EncodingOptions options, string outputVideoCodec, ref string __result)
        {
            try
            {
                // Remember which ffmpeg Jellyfin is driving, so the encoder availability check
                // asks the right binary rather than guessing a path.
                try
                {
                    UpscaleEngine.NoteFfmpegPath(options?.EncoderAppPath);
                }
                catch (Exception)
                {
                    // not fatal; the check falls back to the known install paths
                }

                if (!ShouldAct(state, out var plan))
                {
                    if (plan.Status != "ineligible")
                    {
                        UpscaleEngine.Record(UpscaleEngine.Describe(state, plan, plan.Status, plan.Reason));
                    }

                    return;
                }

                // Subtitle burn-in produces a -filter_complex graph; leave that to Jellyfin.
                if (!string.IsNullOrEmpty(__result) && __result.IndexOf("-filter_complex", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    UpscaleEngine.Record(UpscaleEngine.Describe(state, plan, "subtitle-burn-in", "subtitles are burned in"));
                    return;
                }

                if (!UpscaleEngine.HasCapacity())
                {
                    _logger?.LogInformation("GpuUpscale: concurrency cap reached, leaving stock chain for {Path}", state.MediaPath);
                    UpscaleEngine.Record(UpscaleEngine.Describe(state, plan, "concurrency-cap", "all enhancement slots busy"));
                    return;
                }

                var kept = UpscaleEngine.KeepNonScalingNodes(ExtractVfBody(__result));
                string chain = UpscaleEngine.BuildChain(plan);
                __result = " -vf \"" + (kept.Count > 0 ? string.Join(",", kept) + "," + chain : chain) + "\"";

                var record = UpscaleEngine.Describe(state, plan, "applied", "filter chain injected");
                UpscaleEngine.Record(record);
                _logger?.LogInformation("GpuUpscale: {Summary} for {Path}", record.Summary, state.MediaPath);
            }
            catch (Exception ex)
            {
                _logger?.LogError(ex, "GpuUpscale: filter injection failed, keeping Jellyfin's chain");
            }
        }

        /// <summary>Pulls the filter list out of Jellyfin's ' -vf "..."' fragment.</summary>
        private static string ExtractVfBody(string vfParam)
        {
            if (string.IsNullOrWhiteSpace(vfParam))
            {
                return string.Empty;
            }

            int first = vfParam.IndexOf('"');
            int last = vfParam.LastIndexOf('"');
            return first < 0 || last <= first ? string.Empty : vfParam.Substring(first + 1, last - first - 1);
        }

        /// <summary>Swaps Jellyfin's CUDA/VAAPI device setup for the Vulkan device libplacebo needs.</summary>
        private static void InputVideoHwaccelArgsPostfix(EncodingJobInfo state, EncodingOptions options, ref string __result)
        {
            try
            {
                if (ShouldAct(state, out _))
                {
                    __result = UpscaleEngine.HwaccelArgs();
                }
            }
            catch (Exception ex)
            {
                _logger?.LogError(ex, "GpuUpscale: hwaccel arg injection failed");
            }
        }

        /// <summary>Drops decode-side -hwaccel so frames arrive in system memory for hwupload.</summary>
        private static void HwaccelTypePostfix(EncodingJobInfo state, EncodingOptions options, string videoCodec, int bitDepth, bool outputHwSurface, ref string __result)
        {
            try
            {
                if (ShouldAct(state, out _))
                {
                    __result = string.Empty;
                }
            }
            catch (Exception ex)
            {
                _logger?.LogError(ex, "GpuUpscale: hwaccel type suppression failed");
            }
        }

        /// <summary>Drops the hardware decoder (-c:v *_cuvid) for the same reason.</summary>
        private static void HardwareVideoDecoderPostfix(EncodingJobInfo state, EncodingOptions options, ref string __result)
        {
            try
            {
                if (ShouldAct(state, out _))
                {
                    __result = null;
                }
            }
            catch (Exception ex)
            {
                _logger?.LogError(ex, "GpuUpscale: decoder suppression failed");
            }
        }

        /// <summary>
        /// Owns the output video encoder for jobs this plugin touches.
        ///
        /// Two jobs here. The first is the original one: turn a stream copy into a real transcode
        /// so the chain can run, which happens when the viewer explicitly asked for enhancement or
        /// when ForceTranscode is set. The second is new: honour the configured Encoder setting on
        /// an ordinary transcode this plugin is enhancing. That setting was advertised on the
        /// dashboard and silently ignored - the plugin simply followed whatever codec the client
        /// had negotiated. It is honoured through UpscaleEngine.EncoderFor, which refuses a
        /// configured encoder ffmpeg does not have or the session did not declare playable, so a
        /// misconfiguration degrades to the negotiated codec instead of to a black screen.
        /// </summary>
        private static void VideoEncoderPostfix(EncodingJobInfo state, ref string __result)
        {
            try
            {
                var cfg = UpscaleEngine.Settings;
                if (cfg == null || string.IsNullOrEmpty(__result))
                {
                    return;
                }

                if (__result.IndexOf("copy", StringComparison.OrdinalIgnoreCase) < 0)
                {
                    ApplyConfiguredEncoderToTranscode(state, cfg, ref __result);
                    return;
                }

                if (!ShouldAct(state, out var plan))
                {
                    return;
                }

                bool explicitlyAsked = plan.ClientOptIn || plan.DeblurApplied || plan.DenoiseApplied;
                if (!explicitlyAsked && !cfg.ForceTranscode)
                {
                    return;
                }

                if (!UpscaleEngine.HasCapacity())
                {
                    UpscaleEngine.Record(UpscaleEngine.Describe(state, plan, "concurrency-cap", "all enhancement slots busy"));
                    return;
                }

                string encoder = UpscaleEngine.EncoderFor(state, out string encoderReason);
                UpscaleEngine.NoteEncoder(UpscaleEngine.SessionKey(state), encoder, encoderReason);
                _logger?.LogInformation(
                    "GpuUpscale: replacing stream copy with {Encoder} for {Path} ({Reason})",
                    encoder,
                    state.MediaPath,
                    encoderReason);
                __result = encoder;
            }
            catch (Exception ex)
            {
                _logger?.LogError(ex, "GpuUpscale: encoder substitution failed");
            }
        }

        /// <summary>
        /// Applies the configured Encoder to a job Jellyfin was already going to transcode and this
        /// plugin is enhancing. Only the configured encoder is ever written here: if the guards
        /// refuse it, Jellyfin's own choice is left exactly as it was, because Jellyfin picked it
        /// knowing the container and the client profile and this plugin does not.
        /// </summary>
        private static void ApplyConfiguredEncoderToTranscode(EncodingJobInfo state, UpscaleSettings cfg, ref string __result)
        {
            string configured = cfg.Encoder;
            if (string.IsNullOrWhiteSpace(configured)
                || string.Equals(configured.Trim(), "auto", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            configured = configured.Trim();
            if (string.Equals(configured, __result, StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            if (!ShouldAct(state, out _))
            {
                return;
            }

            string chosen = UpscaleEngine.EncoderFor(state, out string reason);
            string sessionKey = UpscaleEngine.SessionKey(state);

            if (!string.Equals(chosen, configured, StringComparison.OrdinalIgnoreCase))
            {
                UpscaleEngine.NoteEncoder(sessionKey, __result, reason + "; kept Jellyfin's " + __result);
                _logger?.LogInformation(
                    "GpuUpscale: keeping Jellyfin's encoder {Encoder} for {Path} ({Reason})",
                    __result,
                    state.MediaPath,
                    reason);
                return;
            }

            UpscaleEngine.NoteEncoder(sessionKey, chosen, reason + " (replacing Jellyfin's " + __result + ")");
            _logger?.LogInformation(
                "GpuUpscale: encoder {Was} -> {Now} for {Path} ({Reason})",
                __result,
                chosen,
                state.MediaPath,
                reason);
            __result = chosen;
        }
    }
}
