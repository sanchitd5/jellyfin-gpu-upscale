using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using HarmonyLib;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
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
                var harmony = new Harmony(HarmonyId);

                /*
                 * THE CORE SET stays all-or-nothing ON PURPOSE.
                 *
                 * These five are interdependent, not five independent features. The filter patch
                 * emits a libplacebo chain that only works because the hwaccel patch supplied a
                 * Vulkan device and the decoder patches put frames in system memory for hwupload.
                 * Installing a subset would produce ffmpeg command lines that fail outright - that
                 * is WORSE than not patching, because it breaks playback instead of merely leaving
                 * it unenhanced. So if any one of them cannot be resolved, none are installed and
                 * Jellyfin keeps its own behaviour untouched.
                 *
                 * What has been fixed here is the reporting and the blast radius: the failure now
                 * NAMES the methods that could not be resolved instead of saying "method(s) not
                 * found", and the optional patches below are installed separately so that one of
                 * them failing can never take the core set down with it.
                 */
                var helper = typeof(EncodingHelper);
                var core = new List<(string Name, MethodBase Target, string Postfix)>
                {
                    ("GetVideoProcessingFilterParam", AccessTools.Method(helper, "GetVideoProcessingFilterParam"), nameof(VideoProcessingFilterPostfix)),
                    ("GetInputVideoHwaccelArgs", AccessTools.Method(helper, "GetInputVideoHwaccelArgs"), nameof(InputVideoHwaccelArgsPostfix)),
                    ("GetHwaccelType", AccessTools.Method(helper, "GetHwaccelType"), nameof(HwaccelTypePostfix)),
                    ("GetHardwareVideoDecoder", AccessTools.Method(helper, "GetHardwareVideoDecoder"), nameof(HardwareVideoDecoderPostfix)),
                    ("GetVideoEncoder", AccessTools.Method(helper, "GetVideoEncoder"), nameof(VideoEncoderPostfix)),
                };

                var missing = core.Where(p => p.Target == null).Select(p => p.Name).ToList();
                if (missing.Count > 0)
                {
                    Active = false;
                    Status = "failed: EncodingHelper method(s) not found on this Jellyfin build: "
                        + string.Join(", ", missing);
                    logger?.LogError(
                        "GpuUpscale: could not resolve EncodingHelper method(s) {Missing}; not patching. "
                        + "The core patches are interdependent, so a partial install would break transcoding.",
                        string.Join(", ", missing));
                    return;
                }

                foreach (var (name, target, postfix) in core)
                {
                    harmony.Patch(target, postfix: new HarmonyMethod(typeof(UpscalePatches).GetMethod(postfix, BindingFlags.Static | BindingFlags.NonPublic)));
                    logger?.LogInformation("GpuUpscale: patched {Method}", name);
                }

                _harmony = harmony;
                Active = true;

                // OPTIONAL PATCHES. Each is installed in its own try/catch after the core set is
                // already live, so a target that a future Jellyfin renames or removes degrades that
                // one feature and nothing else.
                var optional = new List<string>();
                var optionalFailed = new List<string>();
                ApplyOptional(harmony, logger, optional, optionalFailed);

                Status = "active (5 EncodingHelper methods patched)";
                if (optional.Count > 0)
                {
                    Status += "; optional: " + string.Join(", ", optional);
                }

                if (optionalFailed.Count > 0)
                {
                    Status += "; optional UNAVAILABLE: " + string.Join(", ", optionalFailed);
                }

                logger?.LogInformation("GpuUpscale: Harmony patches installed, plugin owns the transcode filter chain. {Status}", Status);
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

        /// <summary>True when the direct-play override is installed and can be switched on.</summary>
        public static bool DirectPlayOverrideAvailable { get; private set; }

        /// <summary>
        /// Installs the optional patches. Each one is independent: it resolves its own target and
        /// is patched inside its own try/catch, so a failure here can never disturb the core set,
        /// which is already installed and live by the time this runs.
        /// </summary>
        private static void ApplyOptional(Harmony harmony, ILogger logger, List<string> applied, List<string> failed)
        {
            // MediaInfoHelper lives in Jellyfin.Api, a different assembly from the core targets, and
            // is resolved BY NAME so that the patcher does not need a compile-time reference to a
            // web-API assembly it would then be version-pinned to.
            try
            {
                var mediaInfoHelper = AccessTools.TypeByName("Jellyfin.Api.Helpers.MediaInfoHelper");
                var target = mediaInfoHelper == null ? null : AccessTools.Method(mediaInfoHelper, "SetDeviceSpecificData");
                if (target == null)
                {
                    failed.Add("MediaInfoHelper.SetDeviceSpecificData (direct-play override)");
                    logger?.LogWarning(
                        "GpuUpscale: could not resolve Jellyfin.Api.Helpers.MediaInfoHelper.SetDeviceSpecificData. "
                        + "ForceTranscodeForDirectPlay will do nothing; everything else is unaffected.");
                    return;
                }

                harmony.Patch(target, prefix: new HarmonyMethod(
                    typeof(UpscalePatches).GetMethod(nameof(SetDeviceSpecificDataPrefix), BindingFlags.Static | BindingFlags.NonPublic)));

                DirectPlayOverrideAvailable = true;
                applied.Add("direct-play override");
                logger?.LogInformation("GpuUpscale: patched MediaInfoHelper.SetDeviceSpecificData (direct-play override available)");
            }
            catch (Exception ex)
            {
                failed.Add("MediaInfoHelper.SetDeviceSpecificData (direct-play override)");
                logger?.LogWarning(
                    ex,
                    "GpuUpscale: the optional direct-play override could not be installed. "
                    + "Upscaling itself is unaffected.");
            }
        }

        /// <summary>
        /// Turns direct play off for items this plugin would enhance, so that a transcode exists
        /// for the chain to run in.
        ///
        /// WHY THIS IS NEEDED. When a client can direct play, Jellyfin's PlaybackInfo response
        /// carries no TranscodingUrl at all - so there is no ffmpeg command, and nothing to
        /// enhance, however the plugin is configured. The injected web script solves this for the
        /// web player by asking PlaybackInfo not to allow direct play; this is the same lever
        /// applied server-side, which is the only thing that can reach clients that do not run the
        /// injected script.
        ///
        /// It is OFF by default (<see cref="UpscaleSettings.ForceTranscodeForDirectPlay"/>) because
        /// it is expensive and far-reaching: with it on, direct play effectively stops being used
        /// for any eligible item on any client, and every one of those sessions becomes a GPU
        /// transcode. Nothing about it changes behaviour until the flag is switched on.
        ///
        /// Total, like every other entry point here: any surprise means "leave Jellyfin alone".
        /// </summary>
        private static void SetDeviceSpecificDataPrefix(
            MediaSourceInfo mediaSource,
            ref bool enableDirectPlay,
            ref bool enableDirectStream)
        {
            try
            {
                if (!enableDirectPlay && !enableDirectStream)
                {
                    return;
                }

                var cfg = UpscaleEngine.Settings;
                if (cfg == null || !cfg.Enabled || !cfg.ForceTranscodeForDirectPlay)
                {
                    return;
                }

                if (mediaSource?.MediaStreams == null)
                {
                    return;
                }

                foreach (var stream in mediaSource.MediaStreams)
                {
                    if (stream == null || stream.Type != MediaStreamType.Video)
                    {
                        continue;
                    }

                    if (!UpscaleEngine.WouldEnhanceSource(stream.Width, stream.Height))
                    {
                        return;
                    }

                    enableDirectPlay = false;
                    enableDirectStream = false;
                    _logger?.LogInformation(
                        "GpuUpscale: direct play disabled for {Width}x{Height} source so it can be enhanced",
                        stream.Width,
                        stream.Height);
                    return;
                }
            }
            catch (Exception ex)
            {
                _logger?.LogError(ex, "GpuUpscale: direct-play override failed; leaving Jellyfin's decision alone");
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
