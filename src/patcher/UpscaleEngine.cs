using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Controller.Streaming;
using MediaBrowser.MediaEncoding.Transcoding;

namespace Jellyfin.Plugin.GpuUpscale.Patcher
{
    /// <summary>
    /// What the server actually did for one playback session. Written at the moment the ffmpeg
    /// command is built, so it reflects the command that ran - never what the client asked for.
    /// </summary>
    public class SessionRecord
    {
        public string Timestamp { get; set; }

        public string PlaySessionId { get; set; }

        /// <summary>
        /// The viewer this transcode was started for, so the per-session endpoint can refuse to
        /// describe someone else's playback. Empty when the request carried nothing to identify
        /// one; see <see cref="UserKey"/>.
        /// </summary>
        public string UserId { get; set; }

        public string Source { get; set; }

        public int SourceWidth { get; set; }

        public int SourceHeight { get; set; }

        public int OutputWidth { get; set; }

        public int OutputHeight { get; set; }

        /// <summary>True only when a larger-than-source chain really went into the command.</summary>
        public bool UpscaleApplied { get; set; }

        /// <summary>True only when a sharpening pass really went into the command.</summary>
        public bool DeblurApplied { get; set; }

        /// <summary>True only when a denoise filter node really went into the command.</summary>
        public bool DenoiseApplied { get; set; }

        /// <summary>True only when a deblocking / deringing node really went into the command.</summary>
        public bool DeblockApplied { get; set; }

        /// <summary>True only when a neural super-resolution network really went into the command.</summary>
        public bool NeuralApplied { get; set; }

        /// <summary>
        /// True when this session's neural level (dlpp-1..4, vsr-rtcuda) runs CUDA-native and, as
        /// a real, felt consequence and not an internal detail, Detail/Refine/Chroma/Debanding and
        /// the scaling-kernel choice were all forced off for it - the Vulkan libplacebo stage those
        /// axes need is not reachable from this session's CUDA-only chain. See
        /// INTEGRATION_DESIGN.md section 6, "what should be user-visible."
        /// </summary>
        public bool CudaNeuralBypass { get; set; }

        public bool GameApplied { get; set; }

        /// <summary>True only when libplacebo debanding really went into the command.</summary>
        public bool DebandApplied { get; set; }

        public string DeblurLevel { get; set; }

        public string SrLevel { get; set; }

        /// <summary>The post-scale refinement pass that ran (SSimSuperRes), or "off".</summary>
        public string RefineLevel { get; set; }

        /// <summary>Whether a refinement pass was actually put in the shader.</summary>
        public bool RefineApplied { get; set; }

        /// <summary>The chroma upscaling pass that ran (KrigBilateral), or "off".</summary>
        public string ChromaLevel { get; set; }

        /// <summary>Whether a chroma pass was actually put in the shader.</summary>
        public bool ChromaApplied { get; set; }

        /// <summary>
        /// True when an SR level was asked for and deliberately not run because the upscale ratio
        /// was below SrMinScaleFactor. Reported so the player can say the level is inactive for
        /// this combination instead of claiming a network ran.
        /// </summary>
        public bool SrBypassed { get; set; }

        /// <summary>
        /// True when the SR level sharpens inside its own pass (NVScaler) and the separate
        /// sharpening pass was therefore dropped rather than stacked on top of it.
        /// </summary>
        public bool SrOwnsSharpening { get; set; }

        /// <summary>The libplacebo scaling kernel this job used.</summary>
        public string Upscaler { get; set; }

        /// <summary>The SR level that was asked for, even when it was bypassed.</summary>
        public string SrRequested { get; set; }

        /// <summary>
        /// The neural level that was asked for, even when it did not run. NeuralLevel carries only
        /// what was applied, so without this a requested-but-dropped network is indistinguishable
        /// from one nobody asked for, which is how the neural axis shipped dead once already.
        /// </summary>
        public string NeuralRequested { get; set; }

        public string DenoiseLevel { get; set; }

        /// <summary>The deblocking / deringing level that ran, or "off".</summary>
        public string DeblockLevel { get; set; }

        /// <summary>
        /// The deblock level that was asked for, even when it did not run. DeblockLevel carries
        /// only what was applied, and a level can be asked for and dropped here for a reason no
        /// other axis has: this build may simply not carry the filter. Without this, "requested
        /// and not available" would be indistinguishable from "nobody asked", which is exactly how
        /// the neural axis shipped dead once already.
        /// </summary>
        public string DeblockRequested { get; set; }

        /// <summary>The neural super-resolution level that ran, or "off".</summary>
        public string NeuralLevel { get; set; }

        public string GameLevel { get; set; }

        /// <summary>The jitter source the game upscaler actually ran with, or null when it did not run.</summary>
        public string GameJitter { get; set; }

        /// <summary>The depth source the game upscaler actually ran with, or null.</summary>
        public string GameDepth { get; set; }

        /// <summary>The reactive-mask source the game upscaler actually ran with, or null.</summary>
        public string GameReactive { get; set; }

        /// <summary>
        /// True when a depth source other than flat was asked for and the weights are not on this
        /// server, so flat is what ran. The filter's other fallback - no CUDA execution provider -
        /// happens inside ffmpeg and is not visible here, so this is not the whole story and does
        /// not claim to be.
        /// </summary>
        public bool GameDepthDowngraded { get; set; }

        /// <summary>
        /// The Vulkan denoise level dropped because this session also needed the patched binary,
        /// whose shaderc cannot compile that filter. Empty when nothing was dropped. Carried so the
        /// panel and the dashboard can say it happened rather than showing a level that did not run.
        /// </summary>
        public string DenoiseDroppedForPatchedBinary { get; set; }

        /// <summary>The video encoder that went into the command, when this plugin chose it.</summary>
        public string Encoder { get; set; }

        /// <summary>Why that encoder, in particular whether a configured encoder was refused.</summary>
        public string EncoderReason { get; set; }

        /// <summary>applied | not-requested | off-by-client | concurrency-cap | subtitle-burn-in | stream-copy | disabled | ineligible.</summary>
        public string Status { get; set; }

        public string Reason { get; set; }

        /// <summary>
        /// Null when this session never asked for a live A/B swap. Otherwise one of: swapping (the
        /// new ffmpeg process is admitted and starting), swap-capacity (refused; degraded to
        /// today's tear-down-and-restart), swapped (the new process was ready and the old one's
        /// teardown ran), swap-timeout (the new process never arrived in time; the old one's
        /// teardown ran anyway so it is never left running forever). See
        /// UpscaleEngine.TryAdmitSwap/OnNewJobReady and LIVE_APPLY_DESIGN.md.
        /// </summary>
        public string SwapStatus { get; set; }

        /// <summary>A one-line summary for a player overlay.</summary>
        public string Summary { get; set; }
    }

    /// <summary>
    /// Decides what to do with one encoding job and builds the ffmpeg fragments for it.
    /// Every entry point is total: on any surprise it reports "do nothing", so Jellyfin keeps its
    /// own behaviour.
    /// </summary>
    internal static class UpscaleEngine
    {
        private const int HistoryLimit = 50;

        private static readonly List<SessionRecord> _history = new List<SessionRecord>();
        private static readonly object _historyLock = new object();
        private static readonly ConcurrentDictionary<string, SessionRecord> _bySession =
            new ConcurrentDictionary<string, SessionRecord>(StringComparer.OrdinalIgnoreCase);

        private static readonly ConcurrentDictionary<string, Tuple<string, string>> _encoderBySession =
            new ConcurrentDictionary<string, Tuple<string, string>>(StringComparer.OrdinalIgnoreCase);

        /// <summary>Parks the encoder this plugin chose for a session, and backfills any record already made.</summary>
        public static void NoteEncoder(string playSessionId, string encoder, string reason)
        {
            if (string.IsNullOrEmpty(playSessionId))
            {
                return;
            }

            _encoderBySession[playSessionId] = Tuple.Create(encoder, reason);
            if (_bySession.TryGetValue(playSessionId, out var existing))
            {
                existing.Encoder = encoder;
                existing.EncoderReason = reason;
            }
        }

        /// <summary>Live settings, pushed across from the plugin.</summary>
        public static UpscaleSettings Settings { get; set; } = new UpscaleSettings();

        internal sealed class Plan
        {
            public bool Act { get; set; }

            public bool UpscaleApplied { get; set; }

            public bool DeblurApplied { get; set; }

            public bool DenoiseApplied { get; set; }

            public bool DebandApplied { get; set; }

            public int Width { get; set; }

            public int Height { get; set; }

            public int SourceWidth { get; set; }

            public int SourceHeight { get; set; }

            public string SrLevel { get; set; } = "off";

            /// <summary>The SR level the session or the dashboard asked for, before any bypass.</summary>
            public string SrRequested { get; set; } = "off";

            /// <summary>True when that level was dropped because the ratio was below SrMinScaleFactor.</summary>
            public bool SrBypassed { get; set; }

            /// <summary>
            /// True when the source carries no colour range tag, so the chain has to declare one
            /// rather than let libplacebo guess. See where this is set in Decide.
            /// </summary>
            public bool RangeUntagged { get; set; }

            public string DeblurLevel { get; set; } = "off";

            public string RefineLevel { get; set; } = "off";

            public bool RefineApplied { get; set; }

            public string ChromaLevel { get; set; } = "off";

            public bool ChromaApplied { get; set; }

            public string DenoiseLevel { get; set; } = "off";

            /// <summary>The ffmpeg filter node for the denoise level, or null.</summary>
            public string DenoiseFilter { get; set; }

            /// <summary>True when the denoise node needs Vulkan frames, i.e. goes after hwupload.</summary>
            public bool DenoiseWantsHwFrames { get; set; }

            /// <summary>
            /// The Vulkan denoise level that was dropped because this session also needs the
            /// patched binary, whose shaderc cannot compile that filter's shader. Null when
            /// nothing was dropped. Reported rather than silently applied.
            /// </summary>
            public string DenoiseDroppedForPatchedBinary { get; set; }

            public string DeblockLevel { get; set; } = "off";

            /// <summary>The deblock level asked for, whether or not this build could run it.</summary>
            public string DeblockRequested { get; set; } = "off";

            /// <summary>The ffmpeg filter node for the deblock level, or null.</summary>
            public string DeblockFilter { get; set; }

            /// <summary>True when the deblock node needs Vulkan frames. No level here does today.</summary>
            public bool DeblockWantsHwFrames { get; set; }

            public bool DeblockApplied { get; set; }

            public string NeuralLevel { get; set; } = "off";

            /// <summary>
            /// The neural level the session or the dashboard asked for, before the ratio decided
            /// which weight of that family actually runs. NeuralLevel carries what ran, so without
            /// this a substituted weight would be indistinguishable from the one chosen.
            /// </summary>
            public string NeuralRequested { get; set; } = "off";

            public string GameLevel { get; set; } = "off";

            /// <summary>The ffmpeg filter node for the neural super-resolution level, or null.</summary>
            public string NeuralFilter { get; set; }

            /// <summary>The ffmpeg filter node for the game upscaler level, or null.</summary>
            public string GameFilter { get; set; }

            public bool NeuralApplied { get; set; }

            public bool GameApplied { get; set; }

            /// <summary>
            /// True when NeuralLevel is dlpp-1..4 or vsr-rtcuda: both need AV_PIX_FMT_CUDA frames
            /// straight from decode, so BuildChain takes a separate, much shorter path for this
            /// session (decode cuda -> [optix] -> the neural filter(s) -> NVENC, no Vulkan, no
            /// libplacebo) and HwaccelArgs/the two hwaccel-suppression patches must leave decode's
            /// own -hwaccel cuda alone instead of forcing system memory. See
            /// INTEGRATION_DESIGN.md section 2.
            /// </summary>
            public bool UsesCudaNeural { get; set; }

            /// <summary>
            /// The bare "optix" node (no format=gbrpf32le wrap) to run ahead of the CUDA-native
            /// neural filter(s), or null when this session's denoise choice does not carry over
            /// (see ShaderLibrary.CudaDenoiseFilter - only optix/optix-temporal qualify).
            /// </summary>
            public string CudaDenoiseNode { get; set; }

            /// <summary>The resolved jitter / depth / reactive the game filter node was built with.</summary>
            public string GameJitter { get; set; }

            public string GameDepth { get; set; }

            public string GameReactive { get; set; }

            /// <summary>Depth fell back to flat because the weights are not installed.</summary>
            public bool GameDepthDowngraded { get; set; }

            public string ShaderPath { get; set; }

            /// <summary>The session explicitly asked for a larger picture.</summary>
            public bool ClientOptIn { get; set; }

            /// <summary>True when the SR level does its own sharpening and the RCAS pass was dropped.</summary>
            public bool SrOwnsSharpening { get; set; }

            /// <summary>The libplacebo scaling kernel for this job.</summary>
            public string Upscaler { get; set; }

            public string Status { get; set; } = "not-requested";

            public string Reason { get; set; } = string.Empty;

            public static Plan No(string status, string reason) =>
                new Plan { Act = false, Status = status, Reason = reason };
        }

        /* ------------------------------------------------------------------ session bookkeeping */

        public static IReadOnlyList<SessionRecord> History
        {
            get
            {
                lock (_historyLock)
                {
                    return _history.ToArray();
                }
            }
        }

        public static SessionRecord ForSession(string playSessionId)
        {
            if (string.IsNullOrEmpty(playSessionId))
            {
                return null;
            }

            return _bySession.TryGetValue(playSessionId, out var record) ? record : null;
        }

        public static void Record(SessionRecord record)
        {
            if (!string.IsNullOrEmpty(record.PlaySessionId))
            {
                _bySession[record.PlaySessionId] = record;
            }

            lock (_historyLock)
            {
                _history.Insert(0, record);
                if (_history.Count > HistoryLimit)
                {
                    foreach (var dropped in _history.Skip(HistoryLimit).ToList())
                    {
                        // Record runs more than once per session - GetVideoEncoder and the filter
                        // patch are separate call sites - so an OLDER record for a session that is
                        // still playing can fall off the tail while the live one is in the
                        // dictionary. Dropping the key on that would make the per-session endpoint
                        // answer "unknown" mid-playback and lose the parked encoder with it, so the
                        // entry only goes when it is still this very record.
                        if (!string.IsNullOrEmpty(dropped.PlaySessionId)
                            && _bySession.TryGetValue(dropped.PlaySessionId, out var current)
                            && ReferenceEquals(current, dropped))
                        {
                            _bySession.TryRemove(dropped.PlaySessionId, out _);
                            _encoderBySession.TryRemove(dropped.PlaySessionId, out _);
                        }
                    }

                    _history.RemoveRange(HistoryLimit, _history.Count - HistoryLimit);
                }
            }
        }

        /// <summary>The key a client can use to ask what happened to its own session.</summary>
        public static string SessionKey(EncodingJobInfo state)
        {
            try
            {
                if (state?.BaseRequest is StreamingRequestDto dto && !string.IsNullOrEmpty(dto.PlaySessionId))
                {
                    return dto.PlaySessionId;
                }

                return state?.BaseRequest?.GetOption("playSessionId");
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// The viewer this transcode belongs to, as a lowercase "N"-format GUID, or null when the
        /// request carried nothing to identify one.
        ///
        /// Found by reflection rather than by a typed property on purpose: which member carries the
        /// user differs between the request DTO and the job state across Jellyfin versions, and this
        /// assembly is loaded beside a server it was not compiled against. A miss here is not fatal
        /// - it yields null, and the endpoint then falls back to the behaviour it had before, which
        /// is to answer anyone. It must never throw into the transcode path.
        /// </summary>
        public static string UserKey(EncodingJobInfo state)
        {
            try
            {
                object[] roots = { state?.BaseRequest, state };
                foreach (var root in roots)
                {
                    if (root == null)
                    {
                        continue;
                    }

                    var type = root.GetType();
                    object value = type.GetProperty("UserId")?.GetValue(root);
                    if (value == null)
                    {
                        object user = type.GetProperty("User")?.GetValue(root);
                        value = user?.GetType().GetProperty("Id")?.GetValue(user);
                    }

                    if (value is Guid guid)
                    {
                        if (guid != Guid.Empty)
                        {
                            return guid.ToString("N", CultureInfo.InvariantCulture);
                        }

                        continue;
                    }

                    string text = value?.ToString();
                    if (!string.IsNullOrEmpty(text) && Guid.TryParse(text, out var parsed) && parsed != Guid.Empty)
                    {
                        return parsed.ToString("N", CultureInfo.InvariantCulture);
                    }
                }

                return null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        public static SessionRecord Describe(EncodingJobInfo state, Plan plan, string status, string reason)
        {
            var record = new SessionRecord
            {
                Timestamp = DateTime.UtcNow.ToString("u", CultureInfo.InvariantCulture),
                PlaySessionId = SessionKey(state),
                UserId = UserKey(state),
                Source = state?.MediaPath,
                SourceWidth = plan.SourceWidth,
                SourceHeight = plan.SourceHeight,
                OutputWidth = plan.Act ? plan.Width : plan.SourceWidth,
                OutputHeight = plan.Act ? plan.Height : plan.SourceHeight,
                UpscaleApplied = plan.Act && plan.UpscaleApplied,
                DeblurApplied = plan.Act && plan.DeblurApplied,
                DenoiseApplied = plan.Act && plan.DenoiseApplied,
                DeblockApplied = plan.Act && plan.DeblockApplied,
                NeuralApplied = plan.Act && plan.NeuralApplied,
                GameApplied = plan.Act && plan.GameApplied,
                DebandApplied = plan.Act && plan.DebandApplied,
                DeblurLevel = plan.Act && plan.DeblurApplied ? plan.DeblurLevel : "off",
                SrLevel = plan.Act && plan.UpscaleApplied ? plan.SrLevel : "off",
                RefineLevel = plan.Act && plan.RefineApplied ? plan.RefineLevel : "off",
                RefineApplied = plan.Act && plan.RefineApplied,
                ChromaLevel = plan.Act && plan.ChromaApplied ? plan.ChromaLevel : "off",
                ChromaApplied = plan.Act && plan.ChromaApplied,
                SrRequested = plan.SrRequested ?? "off",
                // Unconditional, unlike NeuralLevel below: what was asked for, whether or not it ran.
                NeuralRequested = plan.NeuralRequested ?? "off",
                SrBypassed = plan.Act && plan.SrBypassed,
                SrOwnsSharpening = plan.Act && plan.SrOwnsSharpening,
                Upscaler = plan.Act ? plan.Upscaler : null,
                DenoiseLevel = plan.Act && plan.DenoiseApplied ? plan.DenoiseLevel : "off",
                DeblockLevel = plan.Act && plan.DeblockApplied ? plan.DeblockLevel : "off",
                // Unconditional, like NeuralRequested: what was asked for, run or not.
                DeblockRequested = plan.DeblockRequested ?? "off",
                NeuralLevel = plan.Act && plan.NeuralApplied ? plan.NeuralLevel : "off",
                GameLevel = plan.Act && plan.GameApplied ? plan.GameLevel : "off",
                GameJitter = plan.Act && plan.GameApplied ? plan.GameJitter : null,
                GameDepth = plan.Act && plan.GameApplied ? plan.GameDepth : null,
                GameReactive = plan.Act && plan.GameApplied ? plan.GameReactive : null,
                GameDepthDowngraded = plan.Act && plan.GameApplied && plan.GameDepthDowngraded,
                DenoiseDroppedForPatchedBinary = plan.Act ? plan.DenoiseDroppedForPatchedBinary : null,
                CudaNeuralBypass = plan.Act && plan.UsesCudaNeural,
                Status = status,
                Reason = reason,
            };

            // GetVideoEncoder and GetVideoProcessingFilterParam are separate call sites and
            // Jellyfin does not promise an order, so the encoder decision is parked by session id
            // and picked up by whichever of the two builds the record second.
            if (!string.IsNullOrEmpty(record.PlaySessionId)
                && _encoderBySession.TryGetValue(record.PlaySessionId, out var enc))
            {
                record.Encoder = enc.Item1;
                record.EncoderReason = enc.Item2;
            }

            record.Summary = Summarise(record);
            return record;
        }

        /// <summary>Which sharpener a deblur level actually is, for the honest report.</summary>
        private static string SharpenerName(string level)
        {
            if (level == null)
            {
                return "RCAS";
            }

            if (level.StartsWith("cas-", StringComparison.OrdinalIgnoreCase))
            {
                return "CAS";
            }

            return level.StartsWith("nvsharpen", StringComparison.OrdinalIgnoreCase)
                ? "NVIDIA Image Sharpening"
                : "RCAS";
        }

        /// <summary>
        /// Which network a neural level actually is, for the honest report. The level name says
        /// the family and the factor; this names the weights file that ran and the engine that
        /// ran it, so the record names the model rather than an opaque level.
        /// </summary>
        private static string NeuralName(string level)
        {
            // RTX VSR bypass resampler: a fast GPU resample, not a network - the filter's own
            // header comment is explicit about this, and the report must not overclaim it (see
            // INTEGRATION_DESIGN.md section 4). No "-x" model factor, no ONNX Runtime.
            if (ShaderLibrary.IsVsrRtcudaLevel(level))
            {
                return "RTX VSR bypass resample (nvaivpx.dll), NOT a neural network - "
                    + "fast GPU resample, measured better than bilinear, no detail added";
            }

            // RTX DLPP: content-dependent, never negative but never large either (the filter's
            // own DEGRADED AVOption text) - do not present the four levels as a ladder.
            if (ShaderLibrary.IsDlppLevel(level))
            {
                return "RTX DLPP level " + level.Trim().Substring("dlpp-".Length)
                    + " (nvdlppx.dll), DEGRADED: gain is content-dependent across levels, "
                    + "never negative but never large either";
            }

            string path = ShaderLibrary.NeuralModelPath(level, Settings);
            if (string.IsNullOrWhiteSpace(path))
            {
                return "none";
            }

            return System.IO.Path.GetFileName(path)
                + ", Real-ESRGAN compact (SRVGGNetCompact), ONNX Runtime CUDA";
        }

        /// <summary>
        /// Which ffmpeg filter a denoise level actually is, for the honest report. The level names
        /// are a cost ladder that spans two filter families (atadenoise, then nlmeans), so naming
        /// the level alone would not tell the viewer what ran.
        /// </summary>
        private static string DenoiserName(string level)
        {
            string filter = ShaderLibrary.DenoiseFilter(level, out _, out _);
            if (string.IsNullOrWhiteSpace(filter))
            {
                return "none";
            }

            // A level may be a small chain rather than one node - the OIDN levels carry the
            // format= conversions the filter needs around them. Report the filter that actually
            // denoises, not the plumbing, and name OIDN in full because it is the one level that
            // does not run on the stock jellyfin-ffmpeg at all.
            foreach (string node in SplitFilters(filter))
            {
                if (node.StartsWith("format=", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if (node.StartsWith("oidn", StringComparison.OrdinalIgnoreCase))
                {
                    return node + ", Intel Open Image Denoise";
                }

                // OptiX has two models behind one filter name and they are not interchangeable -
                // the temporal one is the whole point of the level - so the report has to say
                // WHICH one ran, not just that OptiX did.
                if (node.StartsWith("optix", StringComparison.OrdinalIgnoreCase))
                {
                    if (node.IndexOf("mode=temporal", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        return node + ", NVIDIA OptiX AI denoiser, temporal model with NVOFA motion vectors";
                    }

                    return node + ", NVIDIA OptiX AI denoiser, "
                        + (node.IndexOf("mode=hdr", StringComparison.OrdinalIgnoreCase) >= 0 ? "HDR" : "LDR")
                        + " spatial model";
                }

                return node;
            }

            return filter;
        }

        /// <summary>
        /// Which ffmpeg filter a deblock level actually is, for the honest report. Same reason as
        /// DenoiserName: the level names span three filter families (deblock, fspp, pp7), so the
        /// level alone does not say what ran, and only two of the three attack ringing.
        /// </summary>
        private static string DeblockerName(string level)
        {
            string filter = ShaderLibrary.DeblockFilter(level, out _, out _);
            if (string.IsNullOrWhiteSpace(filter))
            {
                return "none";
            }

            if (filter.StartsWith("deblock", StringComparison.OrdinalIgnoreCase))
            {
                return filter + ", libavfilter deblocking on the coding grid, no deringing";
            }

            if (filter.StartsWith("fspp", StringComparison.OrdinalIgnoreCase))
            {
                return filter + ", libpostproc fast simple post-processing, deblock and dering";
            }

            return filter + ", libpostproc";
        }

        /// <summary>
        /// Which pass actually produced the output size, for the "Upscaled WxH to WxH (...)" line.
        /// Pulled out of Summarise() because it was one nested ternary answering four different
        /// "who resized this" cases, which is exactly the shape a fifth case (this method's own
        /// reason for existing: the CUDA-native neural branch) gets bolted onto wrong instead of
        /// added cleanly. A game upscaler hands libplacebo a picture already at the target size,
        /// so the scale is a no-op and the SR level was forced off to avoid enlarging twice. A
        /// CUDA-native neural session (dlpp-*/vsr-rtcuda) is the same story: it takes
        /// UpscaleEngine's separate CUDA hwaccel branch (see Decide()), the Vulkan/SR shader chain
        /// never runs, and the resize was actually done by vsr_rtcuda (levels 3/4 conforming
        /// dlpp_rtcuda's fixed 2x output to the real target, or vsr-rtcuda alone) or by
        /// dlpp_rtcuda itself (levels 1/2, which take the requested size directly - see
        /// ShaderLibrary.CudaNeuralFilter). Reporting any of those as "plain scaling" names a pass
        /// that never ran (libplacebo's own scaler) and hides the one that did - the exact honesty
        /// failure AGENTS.md's reporting invariant exists to catch.
        /// </summary>
        private static string ResizeCredit(SessionRecord r)
        {
            if (!string.Equals(r.SrLevel, "off", StringComparison.OrdinalIgnoreCase))
            {
                return r.SrLevel;
            }

            if (r.GameApplied && !string.IsNullOrEmpty(r.GameLevel)
                && !string.Equals(r.GameLevel, "off", StringComparison.OrdinalIgnoreCase))
            {
                return r.GameLevel + ", which produced the output size itself";
            }

            if (r.CudaNeuralBypass && ShaderLibrary.IsVsrRtcudaLevel(r.NeuralLevel))
            {
                return "vsr_rtcuda, fast GPU resample";
            }

            if (r.CudaNeuralBypass && ShaderLibrary.IsDlppLevel(r.NeuralLevel))
            {
                return ShaderLibrary.DlppLevelNumber(r.NeuralLevel) >= 3
                    ? "vsr_rtcuda, conforming " + r.NeuralLevel + "'s fixed 2x output to this size"
                    : r.NeuralLevel + ", native output size";
            }

            return "plain scaling";
        }

        private static string Summarise(SessionRecord r)
        {
            if (r.Status != "applied")
            {
                switch (r.Status)
                {
                    case "concurrency-cap":
                        return "Enhancement requested but not applied (all upscale slots busy)";
                    case "subtitle-burn-in":
                        return "Enhancement not applied (burned-in subtitles)";
                    case "stream-copy":
                        return "Enhancement not applied (video is being streamed as-is)";
                    case "disabled":
                        return "Enhancement disabled on the server";
                    case "off-by-client":
                        return "No enhancement (the viewer selected Off; playing as Jellyfin would)";
                    default:
                        return "No enhancement";
                }
            }

            var parts = new List<string>();

            // First in the summary because it is first in the chain: it runs at source resolution,
            // ahead of everything below, on the damage the source codec did rather than on grain.
            if (r.DeblockApplied)
            {
                parts.Add("Deblock " + r.DeblockLevel + " (" + DeblockerName(r.DeblockLevel) + ", source resolution, before the scale)");
            }
            else if (!string.IsNullOrEmpty(r.DeblockRequested)
                && !string.Equals(r.DeblockRequested, "off", StringComparison.OrdinalIgnoreCase))
            {
                // Said out loud, like SrBypassed: this axis can be asked for and dropped because
                // this ffmpeg build has no such filter, and a viewer who picked a level is entitled
                // to know it did not run rather than reading a summary that simply omits it.
                parts.Add("deblock " + r.DeblockRequested + " not run (this ffmpeg build does not carry the filter)");
            }

            if (r.DenoiseApplied)
            {
                parts.Add("Denoise " + r.DenoiseLevel + " (" + DenoiserName(r.DenoiseLevel) + ")");
            }

            if (r.NeuralApplied)
            {
                parts.Add("Neural SR " + r.NeuralLevel + " (" + NeuralName(r.NeuralLevel) + ")");

                // Say which weight ran when it is not the one named, for the same reason SrBypassed
                // is said out loud: the viewer picked a level and is entitled to know what ran.
                if (!string.IsNullOrEmpty(r.NeuralRequested)
                    && !string.Equals(r.NeuralRequested, r.NeuralLevel, StringComparison.OrdinalIgnoreCase))
                {
                    parts.Add(string.Format(
                        CultureInfo.InvariantCulture,
                        "{0} run in place of {1} at {2:0.00}x (the larger weight's extra pixels would "
                            + "have been scaled straight back off)",
                        r.NeuralLevel,
                        r.NeuralRequested,
                        r.SourceHeight > 0 ? (double)r.OutputHeight / r.SourceHeight : 0));
                }
            }

            if (r.GameApplied)
            {
                // The degraded wording is not optional and is not softened. A viewer reading
                // this report must not believe they are getting what a game gets.
                parts.Add("Game upscaler " + r.GameLevel + " (" + ShaderLibrary.GameLabel(r.GameLevel)
                    + "; jitter " + (r.GameJitter ?? "?")
                    + ", depth " + (r.GameDepth ?? "?")
                    + (r.GameDepthDowngraded ? " - the depth weights are not installed, so flat is what ran" : string.Empty)
                    + ", reactive " + (r.GameReactive ?? "?") + ")");
            }

            // Never silent. The viewer asked for a denoise and did not get it, and the reason is
            // a property of this build rather than of their choice, so it says which and why.
            if (!string.IsNullOrEmpty(r.DenoiseDroppedForPatchedBinary))
            {
                parts.Add("denoise " + r.DenoiseDroppedForPatchedBinary
                    + " NOT run: it needs the stock ffmpeg's shader compiler, and this session also"
                    + " uses a filter only the patched binary carries");
            }

            if (r.UpscaleApplied)
            {
                // Name the shader family rather than assuming FSRCNNX: two families are selectable.
                parts.Add(string.Format(
                    CultureInfo.InvariantCulture,
                    "Upscaled {0}x{1} to {2}x{3} ({4})",
                    r.SourceWidth,
                    r.SourceHeight,
                    r.OutputWidth,
                    r.OutputHeight,
                    ResizeCredit(r)));
            }

            if (r.DeblurApplied)
            {
                parts.Add("Unblur " + r.DeblurLevel + " (" + SharpenerName(r.DeblurLevel) + ")");
            }

            // These two are named in full because neither is an SR level and a viewer reading
            // "Upscaled ... (fsrcnnx)" would otherwise have no way to tell that a second and a
            // third shader pass also ran.
            if (r.RefineApplied)
            {
                parts.Add("Refine " + r.RefineLevel + " (SSimSuperRes, post-scale)");
            }

            if (r.ChromaApplied)
            {
                parts.Add("Chroma " + r.ChromaLevel + " (KrigBilateral, 4:2:0 chroma upscaling)");
            }

            // Say it out loud rather than quietly reporting "plain scaling": the viewer picked a
            // super-resolution level and is entitled to know it was not run, and why.
            if (r.SrBypassed)
            {
                parts.Add(string.Format(
                    CultureInfo.InvariantCulture,
                    "{0} not run at {1:0.00}x (below the {2:0.00}x super-resolution threshold; "
                        + "plain scaling measured as good there and costs far less)",
                    r.SrRequested,
                    r.SourceHeight > 0 ? (double)r.OutputHeight / r.SourceHeight : 0,
                    Settings?.SrMinScaleFactor ?? 0));
            }

            if (r.SrOwnsSharpening)
            {
                parts.Add("unblur left to " + r.SrLevel + ", which sharpens internally");
            }

            if (r.DebandApplied)
            {
                parts.Add("deband");
            }

            return parts.Count > 0 ? string.Join(", ", parts) : "No enhancement";
        }

        /* ------------------------------------------------------------------------- the decision */

        /// <summary>
        /// Every axis this plugin reads off the request, in one place, because two things now need
        /// the same list: deciding whether a session named anything, and remembering what it named.
        /// </summary>
        private static readonly string[] _axisNames =
        {
            "upscale", "maxheight", "sr", "deblur", "deblock", "denoise", "neural", "game",
            "refine", "chroma", "deband", "kernel", "jitter", "depth", "reactive"
        };

        // The axes a play session arrived with, kept so a later request for the SAME session that
        // lost them can be answered with what the viewer actually chose. Bounded, and evicted with
        // the session record, so a long-running server does not accumulate them.
        private static readonly ConcurrentDictionary<string, Dictionary<string, string>> _optionsBySession =
            new ConcurrentDictionary<string, Dictionary<string, string>>(StringComparer.OrdinalIgnoreCase);

        /// <summary>
        /// THE PARAMETERS DO NOT SURVIVE THE HLS MASTER PLAYLIST.
        ///
        /// The client marks the TranscodingUrl, which is the master playlist. Jellyfin then writes
        /// the VARIANT urls into that playlist itself, and it writes the parameters it knows about,
        /// not ours. The browser fetches the variant, and that request - the one that actually
        /// builds the ffmpeg command - arrives with every axis missing, so the server falls back to
        /// its dashboard defaults and honestly reports having done so. The viewer sees their picks
        /// in the panel, a chain that is not theirs on the stream, and nothing anywhere saying why.
        ///
        /// PlaySessionId does survive that hop, so the axes are remembered against it the first
        /// time they are seen and restored for later requests of the same session that lack them.
        /// A request that carries axes always wins: this only ever fills a gap.
        /// </summary>
        private static void RememberOrRestoreOptions(EncodingJobInfo state)
        {
            try
            {
                string key = SessionKey(state);
                if (string.IsNullOrEmpty(key))
                {
                    return;
                }

                var present = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (string axis in _axisNames)
                {
                    string value = RawOption(state, axis);
                    if (value != null)
                    {
                        present[axis] = value;
                    }
                }

                if (present.Count > 0)
                {
                    // Bounded the crude way rather than leaked: this holds a handful of short
                    // strings per session, and the cap is far above any real concurrent count.
                    if (_optionsBySession.Count > 256)
                    {
                        _optionsBySession.Clear();
                    }

                    _optionsBySession[key] = present;
                    return;
                }

                // Nothing on this request: restore what the session arrived with, if anything, by
                // writing it back onto the request so every existing read path sees it unchanged.
                if (!_optionsBySession.TryGetValue(key, out var remembered) || remembered == null)
                {
                    return;
                }

                foreach (var pair in remembered)
                {
                    try
                    {
                        // Indexer, not Add: Add throws on a key that is already there, and this
                        // runs on the transcode path where that would be a failed session.
                        var opts = state?.BaseRequest?.StreamOptions;
                        if (opts != null)
                        {
                            opts[pair.Key] = pair.Value;
                        }
                    }
                    catch (Exception)
                    {
                        // A collection that refuses the write leaves the axis unset, which is the
                        // behaviour before this existed rather than a new failure.
                    }
                }
            }
            catch (Exception)
            {
                // Never throw into the transcode path for a convenience.
            }
        }

        private static string RawOption(EncodingJobInfo state, string name)
        {
            try
            {
                string value = state?.BaseRequest?.GetOption(name);
                return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static string Option(EncodingJobInfo state, string name)
        {
            return RawOption(state, name);
        }

        /// <summary>
        /// True when this session named an enhancement axis itself, as opposed to inheriting a
        /// dashboard default.
        ///
        /// The difference decides whether a stream copy is worth replacing with a full transcode.
        /// A plan's *Applied flags cannot answer it: they are equally true for a dashboard default,
        /// so reading them there would turn every direct-play-eligible session on the server into a
        /// GPU transcode the moment an admin set one of those defaults.
        /// </summary>
        public static bool SessionNamedEnhancement(EncodingJobInfo state)
        {
            string[] axes = { "sr", "deblur", "deblock", "denoise", "neural", "game", "refine", "chroma", "deband", "kernel", "jitter", "depth", "reactive" };
            foreach (string axis in axes)
            {
                if (Option(state, axis) != null)
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Works out what this job should get. Session options win; the dashboard settings are the
        /// fallback, which is what keeps the features working when the player UI is not there.
        /// </summary>
        public static Plan Decide(EncodingJobInfo state)
        {
            try
            {
                // Before anything reads an axis: the HLS variant request arrives without them, and
                // this is where the session's own choices come back. See RememberOrRestoreOptions.
                RememberOrRestoreOptions(state);

                UpscaleSettings cfg = Settings;
                if (cfg == null || !cfg.Enabled)
                {
                    return Plan.No("disabled", "plugin disabled");
                }

                if (state == null || !state.IsVideoRequest)
                {
                    return Plan.No("ineligible", "not a video request");
                }

                var vs = state.VideoStream;
                if (vs?.Width == null || vs.Height == null || vs.Width <= 0 || vs.Height <= 0)
                {
                    return Plan.No("ineligible", "unknown source size");
                }

                int sw = vs.Width.Value;
                int sh = vs.Height.Value;

                var plan = new Plan { SourceWidth = sw, SourceHeight = sh, Width = sw, Height = sh };

                // A source that never declared its range is the one case libplacebo has to guess
                // at, and guessing full on limited material lifts black by about 9/255 across the
                // whole frame. That is larger than any shader difference this plugin measures, and
                // it was previously corrected only inside the benchmark harness, so the served
                // segment carried a shift the measurements did not. Video is limited range unless
                // it says otherwise, so an untagged source is told so before anything scales it.
                plan.RangeUntagged = string.IsNullOrWhiteSpace(vs.ColorRange);

                // ---- upscale target -------------------------------------------------------
                // "upscale" is a lowercase query parameter, so Jellyfin puts it in the request's
                // StreamOptions verbatim (Jellyfin.Api ParseStreamOptions). Unlike a bitrate or a
                // maxHeight it is never clamped or rewritten on the way through.
                string upscaleOption = Option(state, "upscale");
                int? requested = null;

                // "SAID NOTHING" AND "SAID OFF" ARE DIFFERENT ANSWERS.
                //
                // A session carrying no upscale marker at all has expressed no opinion, so the
                // dashboard defaults apply - that is what RequireClientOptIn=false means and it is
                // deliberately left alone. A session carrying upscale=off has expressed one, and
                // the only honest reading of it is stock Jellyfin behaviour: no upscale, and no
                // server-side deblur or denoise default either, so nothing turns a would-be direct
                // play or stream copy into a transcode. Only levels the session asked for BY NAME
                // survive an explicit Off.
                bool clientSaidOff = false;
                if (upscaleOption != null)
                {
                    if (string.Equals(upscaleOption, "off", StringComparison.OrdinalIgnoreCase))
                    {
                        requested = 0;
                        clientSaidOff = true;
                    }
                    else if (int.TryParse(upscaleOption, NumberStyles.Integer, CultureInfo.InvariantCulture, out int parsed))
                    {
                        requested = parsed;
                    }
                }

                // Older clients (and the first version of gpu-upscale.js) signalled an upscale with
                // maxHeight. Only treat it as a request when it is actually ABOVE the source:
                // Jellyfin fills MaxHeight in from the device profile for ordinary playback too,
                // usually at or below the source height, and taking that as "the session asked for
                // this size" silently suppressed the RequireClientOptIn=false default - the job
                // was then rejected as "target within MinScaleFactor of source" and nothing was
                // enhanced. A maxHeight at or below the source is a ceiling, not a request.
                if (requested == null && state.BaseRequest?.MaxHeight > sh)
                {
                    requested = state.BaseRequest.MaxHeight;
                }

                int target = 0;
                if (requested.HasValue)
                {
                    target = requested.Value;
                    plan.ClientOptIn = target > sh;
                }
                else if (!cfg.RequireClientOptIn)
                {
                    target = cfg.TargetHeight;
                }

                string upscaleReason = null;
                if (target <= 0)
                {
                    upscaleReason = "no upscale requested";
                }
                else if (sw < sh)
                {
                    // Portrait source (width < height, a phone recording). The whole ladder - its
                    // cost table, its shader choices, MaxSourceHeight's own cutoff - is measured
                    // and tuned against 16:9 landscape content (state.js's FPS/DENOISE_COST/
                    // NEURAL_COST comments, RTXDLPP.md's benchmark baseline). None of it has been
                    // validated the other way round, and MaxSourceHeight's own check does not
                    // reliably catch this: it compares sh against a landscape-tuned cutoff, but
                    // for a portrait source sh is already the LONG dimension, so a 1080x1920
                    // source can sail past a cutoff meant to stop enlarging something already
                    // tall enough. Bypassed outright rather than run the landscape math on
                    // sideways content and hope it holds - reported 2026-09-24 against a real
                    // 1080x1920 source.
                    upscaleReason = "portrait source, upscale bypassed";
                }
                else if (sh > cfg.MaxSourceHeight)
                {
                    upscaleReason = "source taller than MaxSourceHeight";
                }
                else
                {
                    target = Math.Min(target, cfg.MaxTargetHeight);
                    if (target <= sh * cfg.MinScaleFactor)
                    {
                        upscaleReason = "target within MinScaleFactor of source";
                    }
                    else
                    {
                        target -= target % 2;

                        // Width rounds to a multiple of 8, not 2. NVENC allocates surfaces on an
                        // 8-pixel alignment, so a width like 1918 is padded internally and the
                        // encoder works on a surface wider than the picture it is given. The
                        // nearest multiple of 8 moves the width by at most 4 pixels, which on a
                        // 16:9 target is inside a pixel of the exact aspect ratio.
                        int tw = (int)Math.Round(sw * ((double)target / sh) / 8.0, MidpointRounding.AwayFromZero) * 8;
                        if (tw > 0)
                        {
                            plan.UpscaleApplied = true;
                            plan.Width = tw;
                            plan.Height = target;
                        }
                        else
                        {
                            upscaleReason = "bad computed width";
                        }
                    }
                }

                // ---- sharpening -----------------------------------------------------------
                string deblurDefault = clientSaidOff ? "off" : cfg.DeblurLevel;
                string deblurLevel = cfg.DeblurAllowed ? (Option(state, "deblur") ?? deblurDefault) : "off";
                // A VALUE THAT FAILS ITS CHECK FALLS BACK TO THE COMPUTED DEFAULT, NOT THE
                // DASHBOARD ONE. The two are the same until the session says Off, and there the
                // dashboard value would defeat the explicit Off: a stale or misspelt level would
                // buy the viewer a server-side pass they asked not to have, and a transcode with
                // it. Every axis below is guarded the same way and for the same reason.
                if (!ShaderLibrary.IsDeblurLevel(deblurLevel))
                {
                    deblurLevel = ShaderLibrary.IsDeblurLevel(deblurDefault) ? deblurDefault : "off";
                }

                // ---- super-resolution level ----------------------------------------------
                // No clientSaidOff default of its own: an explicit Off leaves no upscale, and an
                // SR level without one is forced off below. An unusable value falls back to the
                // dashboard and then to "off" - never to a named network, which would put a level
                // nobody chose into SrRequested and report the viewer as having asked for it.
                string srLevel = Option(state, "sr") ?? cfg.SrLevel;
                if (!ShaderLibrary.IsSrLevel(srLevel))
                {
                    srLevel = ShaderLibrary.IsSrLevel(cfg.SrLevel) ? cfg.SrLevel : "off";
                }

                plan.SrRequested = ShaderLibrary.CanonicalSr(srLevel) ?? "off";

                // ---- post-scale refinement and chroma upscaling ---------------------------
                // Two axes of their own, carried on the same lowercase-query-parameter channel as
                // everything else. Neither is an SR level: the refinement hooks POSTKERNEL and the
                // chroma pass hooks CHROMA, so both compose with whatever SR level is in force
                // rather than replacing it. See ShaderLibrary._refineFiles / _chromaFiles.
                // Both gated the same way as neural and game: with the master switch off the
                // session's own parameter is not read at all, so the dashboard decides.
                string refineDefault = clientSaidOff ? "off" : cfg.RefineLevel;
                string refineLevel = cfg.RefineAllowed ? (Option(state, "refine") ?? refineDefault) : "off";
                if (!ShaderLibrary.IsRefineLevel(refineLevel))
                {
                    refineLevel = ShaderLibrary.IsRefineLevel(refineDefault) ? refineDefault : "off";
                }

                string chromaDefault = clientSaidOff ? "off" : cfg.ChromaLevel;
                string chromaLevel = cfg.ChromaAllowed ? (Option(state, "chroma") ?? chromaDefault) : "off";
                if (!ShaderLibrary.IsChromaLevel(chromaLevel))
                {
                    chromaLevel = ShaderLibrary.IsChromaLevel(chromaDefault) ? chromaDefault : "off";
                }

                if (!plan.UpscaleApplied)
                {
                    // The SR shaders only earn their pass when the output is meaningfully larger
                    // than the source, so at 1:1 they would cost a pass for nothing. The same is
                    // true of the refinement pass: SSimSuperRes corrects an enlargement, and its
                    // own //!WHEN guard would not fire at 1:1 anyway, so offering it there would be
                    // offering a pass that silently does nothing. The chroma pass is different -
                    // 4:2:0 chroma is subsampled whether or not the frame is being enlarged - so it
                    // is deliberately left alone here.
                    srLevel = "off";
                    refineLevel = "off";
                }
                else if (cfg.SrMinScaleFactor > 1.0
                    && !string.Equals(srLevel, "off", StringComparison.OrdinalIgnoreCase)
                    && !ShaderLibrary.SrIsRatioAgnostic(srLevel)
                    && plan.Height < sh * cfg.SrMinScaleFactor)
                {
                    // BELOW THE RATIO THE NETWORK IS WORTH RUNNING. Both shipped SR networks are
                    // fixed 2x, and below about 1.5x their output is shrunk back far enough that
                    // they measured no better than plain ewa_lanczos - at 1.41x they measured
                    // WORSE on detail energy - while costing ~15% of throughput. So drop the
                    // network and keep the rest of the chain: the upscale still happens, and the
                    // sharpener (RCAS, which costs about nothing) recovers more detail at these
                    // ratios than the network did. See UpscaleSettings.SrMinScaleFactor.
                    //
                    // NOT every SR level is fixed-2x. ravu-zoom is handed the output size directly
                    // and scales to it at any ratio, so the shrink-back argument above is simply
                    // untrue of it and SrIsRatioAgnostic exempts it. The refinement pass
                    // (SSimSuperRes) is exempt for the same reason and is not touched here at all -
                    // filling this gap with something better than a sharpener is the whole reason
                    // it was added.
                    plan.SrBypassed = true;
                    srLevel = "off";
                }

                // ---- denoise --------------------------------------------------------------
                // Same carrier as the others: a lowercase query parameter survives Jellyfin's
                // ParseStreamOptions into StreamOptions and is read back with GetOption.
                string denoiseDefault = clientSaidOff ? "off" : cfg.DenoiseLevel;
                string denoiseLevel = cfg.DenoiseAllowed ? (Option(state, "denoise") ?? denoiseDefault) : "off";
                if (!ShaderLibrary.IsDenoiseLevel(denoiseLevel))
                {
                    denoiseLevel = ShaderLibrary.IsDenoiseLevel(denoiseDefault) ? denoiseDefault : "off";
                }

                // ---- deblocking and deringing ---------------------------------------------
                // Same carrier and the same fallback rule as denoise, because it is the closest
                // existing shape: a pre-SR restoration pass that could in principle land either
                // side of hwupload. BuildChain puts this node AHEAD of the denoise one: this pass
                // attacks what the source encoder did, and handing a temporal denoiser a frame
                // whose block edges have already gone is the way round that gives the denoiser
                // fewer false edges to chase. Assumed, not measured, and the reverse order would be
                // defensible too; what is NOT in question is that both run at source resolution and
                // ahead of the super-resolution pass.
                string deblockDefault = clientSaidOff ? "off" : cfg.DeblockLevel;
                string deblockLevel = cfg.DeblockAllowed ? (Option(state, "deblock") ?? deblockDefault) : "off";
                if (!ShaderLibrary.IsDeblockLevel(deblockLevel))
                {
                    deblockLevel = ShaderLibrary.IsDeblockLevel(deblockDefault) ? deblockDefault : "off";
                }

                // Recorded before DeblockFilter can drop it: this axis is the one that can be a
                // real level and still not run, because the filter may be absent from this build.
                plan.DeblockRequested = ShaderLibrary.IsDeblockLevel(deblockLevel)
                    ? deblockLevel.Trim().ToLowerInvariant()
                    : "off";

                plan.DeblockFilter = ShaderLibrary.DeblockFilter(deblockLevel, out string deblockUsed, out bool deblockHw);
                plan.DeblockLevel = deblockUsed;
                plan.DeblockWantsHwFrames = deblockHw;
                plan.DeblockApplied = plan.DeblockFilter != null;

                plan.DenoiseFilter = ShaderLibrary.DenoiseFilter(denoiseLevel, out string denoiseUsed, out bool denoiseHw);
                plan.DenoiseLevel = denoiseUsed;
                plan.DenoiseWantsHwFrames = denoiseHw;
                plan.DenoiseApplied = plan.DenoiseFilter != null;

                // ---- neural super-resolution ----------------------------------------------
                // Its own axis, same carrier as the rest. Never inferred from anything: a session
                // gets a network only if it or the dashboard named one, because every level here
                // is well below realtime and choosing one for a viewer would be a decision this
                // plugin has no business making.
                string neuralDefault = clientSaidOff ? "off" : cfg.NeuralLevel;
                string neuralLevel = cfg.NeuralAllowed ? (Option(state, "neural") ?? neuralDefault) : "off";
                if (!ShaderLibrary.IsNeuralLevel(neuralLevel))
                {
                    neuralLevel = ShaderLibrary.IsNeuralLevel(neuralDefault) ? neuralDefault : "off";
                }

                plan.NeuralRequested = ShaderLibrary.IsNeuralLevel(neuralLevel)
                    ? neuralLevel.Trim().ToLowerInvariant()
                    : "off";

                plan.UsesCudaNeural = ShaderLibrary.IsCudaNeuralLevel(neuralLevel);

                if (plan.UsesCudaNeural)
                {
                    // CUDA-NATIVE BRANCH: dlpp-1..4 / vsr-rtcuda. Both filters need AV_PIX_FMT_CUDA
                    // frames straight from decode (RTXDLPP.md/RTXVSR.md), and the Vulkan-CUDA
                    // interop the rest of this chain would need to reach them from the normal
                    // Vulkan pipeline is confirmed broken today (vulkan-cuda-hwmap-task.md). So
                    // this session takes UpscaleEngine's separate CUDA hwaccel branch instead
                    // (see HwaccelArgs/BuildChain): decode cuda -> [optix] -> the neural filter(s)
                    // -> NVENC, and every Vulkan-only axis is forced off for it rather than
                    // silently ignored - see INTEGRATION_DESIGN.md sections 2 and 6.
                    plan.NeuralFilter = ShaderLibrary.CudaNeuralFilter(
                        neuralLevel, plan.Width, plan.Height, out string cudaNeuralUsed, cfg);
                    plan.NeuralLevel = cudaNeuralUsed;
                    plan.NeuralApplied = plan.NeuralFilter != null;
                    plan.UsesCudaNeural = plan.NeuralApplied;

                    // Only optix/optix-temporal have a CUDA-hw-frame path (ARCHITECTURE.md); any
                    // other denoise choice does not carry over to this branch and is dropped, the
                    // same "reported, not silent" rule DenoiseDroppedForPatchedBinary already uses
                    // a few lines below for a different reason.
                    plan.CudaDenoiseNode = ShaderLibrary.CudaDenoiseFilter(denoiseLevel);
                    if (plan.CudaDenoiseNode == null && plan.DenoiseApplied)
                    {
                        plan.DenoiseDroppedForPatchedBinary = plan.DenoiseLevel;
                    }

                    plan.DenoiseFilter = null;
                    plan.DenoiseApplied = false;
                    plan.DenoiseLevel = "off";
                    plan.DenoiseWantsHwFrames = false;

                    // Deblock is a CPU pre-filter (ShaderLibrary.DeblockFilter), never routed
                    // into cudaNodes by BuildChain's CUDA-native branch below, which returns only
                    // CudaDenoiseNode + NeuralFilter. Left un-reset here, plan.DeblockApplied and
                    // plan.DeblockLevel would still say "applied" in the session record while
                    // BuildChain silently dropped the node from the command actually built - the
                    // exact "rendered, stored, never sent" bug this project keeps hitting.
                    plan.DeblockFilter = null;
                    plan.DeblockApplied = false;
                    plan.DeblockLevel = "off";
                    plan.DeblockWantsHwFrames = false;

                    // The Vulkan-only stages this branch cannot reach: forced off here rather than
                    // silently dropped downstream, so the session record and BuildChain agree with
                    // each other about what actually ran.
                    srLevel = "off";
                    refineLevel = "off";
                    chromaLevel = "off";
                    deblurLevel = "off";
                }
                else
                {
                    // The heights go in because the weight that runs depends on the ratio: a x4
                    // network at a 2x target spends four times the pixels and libplacebo discards
                    // half of them.
                    plan.NeuralFilter = ShaderLibrary.NeuralFilter(
                        neuralLevel, plan.SourceHeight, plan.Height, out string neuralUsed, cfg);
                    plan.NeuralLevel = neuralUsed;
                    plan.NeuralApplied = plan.NeuralFilter != null;
                }

                // ---- game temporal upscalers (fsr2 / dlss / dlaa) --------------------------
                // Advanced, opt-in, off by default and never chosen automatically. See the
                // block above _gameFilters in ShaderLibrary for why they are labelled degraded.
                string gameDefault = clientSaidOff ? "off" : cfg.GameLevel;
                string gameLevel = cfg.GameAllowed ? (Option(state, "game") ?? gameDefault) : "off";
                if (!ShaderLibrary.IsGameLevel(gameLevel))
                {
                    gameLevel = ShaderLibrary.IsGameLevel(gameDefault) ? gameDefault : "off";
                }

                // fsr2/dlss/dlaa are Vulkan (vf_dlss.c's own header, "through NGX's Vulkan path");
                // this session's CUDA-native branch has no Vulkan device at all, so a game level
                // asked for alongside dlpp-*/vsr-rtcuda cannot run either. Same forced-off,
                // reported-not-silent treatment as srLevel/refineLevel/chromaLevel just above.
                if (plan.UsesCudaNeural)
                {
                    gameLevel = "off";
                }

                // jitter / depth / reactive are per-session on exactly the same carrier as the
                // eleven axes above: lowercase query options off the streaming request. Each falls
                // back to the dashboard setting and then to the built-in default inside
                // GameFilter, which is also where an unrecognised value is rejected. They are read
                // unconditionally and are inert by construction: with game=off no filter node is
                // built, so nothing carries them.
                plan.GameFilter = ShaderLibrary.GameFilter(
                    gameLevel,
                    plan.Width,
                    plan.Height,
                    cfg,
                    Option(state, "jitter"),
                    Option(state, "depth"),
                    Option(state, "reactive"),
                    out string gameUsed,
                    out string gameJitter,
                    out string gameDepth,
                    out string gameReactive,
                    out bool gameDepthDowngraded);
                plan.GameLevel = gameUsed;
                plan.GameApplied = plan.GameFilter != null;
                plan.GameJitter = gameJitter;
                plan.GameDepth = gameDepth;
                plan.GameReactive = gameReactive;
                plan.GameDepthDowngraded = gameDepthDowngraded;

                // ---- two binaries, and not every filter runs on both -----------------------
                // The Vulkan denoise levels compile their shader at run time, and the patched
                // binary's shaderc is older than the stock one's: nlmeans_vulkan needs
                // GL_EXT_expect_assume, which it rejects. So the level runs on the stock binary
                // and fails on the patched one. A session asking for BOTH a Vulkan denoise and a
                // filter only the patched binary carries therefore routes to the patched binary
                // and dies with "shaderc compile status 'error'", killing the whole transcode.
                //
                // Dropping the denoise and saying so is the honest outcome: the viewer loses one
                // pass instead of the stream.
                //
                // AND IT IS NOW CONDITIONAL ON THE BINARY, NOT ASSUMED. build-ffmpeg.sh builds
                // shaderc from source, so a current binary runs the filter and this guard must not
                // fire: a permanent block would keep punishing every session for a defect that was
                // fixed. The probe RUNS one frame through nlmeans_vulkan on the patched binary
                // rather than asking whether the filter is listed, because listing it is exactly
                // what the broken build did. An older binary still degrades to one lost pass.
                bool needsPatchedBinary = plan.NeuralApplied || plan.GameApplied
                    || (plan.DenoiseApplied && ShaderLibrary.IsPatchedOnlyFilter(plan.DenoiseFilter));
                if (plan.DenoiseApplied && plan.DenoiseWantsHwFrames && needsPatchedBinary
                    && !VulkanDenoiseRunsOnPatchedBinary())
                {
                    plan.DenoiseDroppedForPatchedBinary = plan.DenoiseLevel;
                    plan.DenoiseFilter = null;
                    plan.DenoiseApplied = false;
                    plan.DenoiseLevel = "off";
                    plan.DenoiseWantsHwFrames = false;
                }

                // fsr2 and dlss produce the OUTPUT size themselves. Running an SR network as
                // well would enlarge the already-enlarged picture and let libplacebo shrink it
                // back - two upscalers fighting, which is worse than either. dlaa is exempt: it
                // is 1:1, so it is a restoration pass ahead of the normal scale, not a rival.
                if (plan.GameApplied && ShaderLibrary.GameScalesOutput(plan.GameLevel))
                {
                    srLevel = "off";
                    refineLevel = "off";
                }

                bool wantDeblur = !string.Equals(deblurLevel, "off", StringComparison.OrdinalIgnoreCase);
                bool wantRefine = !string.Equals(refineLevel, "off", StringComparison.OrdinalIgnoreCase);
                bool wantChroma = !string.Equals(chromaLevel, "off", StringComparison.OrdinalIgnoreCase);
                if (!plan.UpscaleApplied && !wantDeblur && !wantRefine && !wantChroma
                    && !plan.DenoiseApplied && !plan.DeblockApplied && !plan.NeuralApplied && !plan.GameApplied)
                {
                    return clientSaidOff
                        ? Plan.No("off-by-client", "the viewer selected Off")
                        : Plan.No("not-requested", upscaleReason ?? "nothing requested");
                }

                // ---- deband and the scaling kernel, both session-overridable ---------------
                // Same lowercase-query-parameter carrier as everything else. The kernel is checked
                // against a whitelist before it is used: an unknown string here would go straight
                // into the ffmpeg command and fail the whole job, so an unrecognised value is
                // ignored rather than tried.
                string debandOption = Option(state, "deband");
                bool wantDeband = cfg.Deband;
                if (debandOption != null)
                {
                    // Whitelisted both ways, like every other axis: an unrecognised value falls back
                    // to the dashboard default rather than being read as "on".
                    if (string.Equals(debandOption, "off", StringComparison.OrdinalIgnoreCase)
                        || string.Equals(debandOption, "0", StringComparison.Ordinal)
                        || string.Equals(debandOption, "false", StringComparison.OrdinalIgnoreCase))
                    {
                        wantDeband = false;
                    }
                    else if (string.Equals(debandOption, "on", StringComparison.OrdinalIgnoreCase)
                        || string.Equals(debandOption, "1", StringComparison.Ordinal)
                        || string.Equals(debandOption, "true", StringComparison.OrdinalIgnoreCase))
                    {
                        wantDeband = true;
                    }
                }

                // Debanding and the scaling kernel both belong to the libplacebo pass, which this
                // session's CUDA-native branch never reaches.
                if (plan.UsesCudaNeural)
                {
                    wantDeband = false;
                }

                plan.Upscaler = ShaderLibrary.CanonicalUpscaler(Option(state, "kernel"))
                    ?? ShaderLibrary.CanonicalUpscaler(cfg.Upscaler)
                    ?? "ewa_lanczos";

                // The scaling kernel belongs to the same libplacebo instance as deband, which the
                // CUDA-native branch never builds (BuildChain returns early with only
                // CudaDenoiseNode + NeuralFilter). Left as the resolved string here, Describe()
                // would report a kernel choice - e.g. "ewa_lanczos" - that never actually ran,
                // the same stale-"on" failure mode deband/kernel were flagged for in review.
                if (plan.UsesCudaNeural)
                {
                    plan.Upscaler = null;
                }

                plan.ShaderPath = ShaderLibrary.Resolve(
                    cfg,
                    srLevel,
                    deblurLevel,
                    refineLevel,
                    chromaLevel,
                    out string srUsed,
                    out string deblurUsed,
                    out string refineUsed,
                    out string chromaUsed);
                plan.SrLevel = srUsed;
                plan.DeblurLevel = deblurUsed;
                plan.DeblurApplied = !string.Equals(deblurUsed, "off", StringComparison.OrdinalIgnoreCase);
                plan.RefineLevel = refineUsed;
                plan.RefineApplied = !string.Equals(refineUsed, "off", StringComparison.OrdinalIgnoreCase);
                plan.ChromaLevel = chromaUsed;
                plan.ChromaApplied = !string.Equals(chromaUsed, "off", StringComparison.OrdinalIgnoreCase);
                plan.SrOwnsSharpening = wantDeblur
                    && !plan.DeblurApplied
                    && string.Equals(srUsed, "nvscaler", StringComparison.OrdinalIgnoreCase);

                // Debanding rides along on the libplacebo instance that is being built anyway, so
                // it is only "applied" when there is a chain for it to ride on.
                plan.DebandApplied = wantDeband;

                if (!plan.UpscaleApplied && !plan.DeblurApplied && !plan.RefineApplied
                    && !plan.ChromaApplied && !plan.DenoiseApplied && !plan.DeblockApplied
                    && !plan.NeuralApplied && !plan.GameApplied)
                {
                    // Sharpening was asked for but its shader is missing: nothing left to do.
                    return Plan.No("not-requested", "requested shaders unavailable");
                }

                plan.Act = true;
                plan.Status = "applied";
                return plan;
            }
            catch (Exception ex)
            {
                return Plan.No("ineligible", "error: " + ex.Message);
            }
        }

        /// <summary>
        /// Would an upscale actually apply to a source of this size, under the current settings?
        ///
        /// This is the same arithmetic <see cref="Decide"/> uses for the upscale target, factored
        /// out so the direct-play override asks exactly the question the engine will later answer.
        /// If the two ever disagreed, the override would force expensive transcodes for material
        /// the engine then declined to enhance, which is the worst of both worlds.
        /// </summary>
        public static bool WouldEnhanceSource(int? width, int? height)
        {
            try
            {
                UpscaleSettings cfg = Settings;
                if (cfg == null || !cfg.Enabled)
                {
                    return false;
                }

                if (width == null || height == null || width <= 0 || height <= 0)
                {
                    return false;
                }

                int sh = height.Value;
                if (sh > cfg.MaxSourceHeight)
                {
                    return false;
                }

                int target = Math.Min(cfg.TargetHeight, cfg.MaxTargetHeight);
                return target > sh * cfg.MinScaleFactor;
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>
        /// Is there capacity for another enhanced transcode right now. Counts live ffmpeg processes
        /// already running a libplacebo chain.
        /// </summary>
        public static bool HasCapacity()
        {
            try
            {
                int max = Settings?.MaxConcurrent ?? 0;
                if (max <= 0)
                {
                    return false;
                }

                // More than one patch asks this while a single ffmpeg command is being built, and
                // the walk below opens and reads /proc/<pid>/cmdline for EVERY process on the box.
                // The answer cannot meaningfully change inside one build, so it is computed once
                // and reused for a window just long enough to cover one. This is a memo, not a
                // change to the concurrency model: the count and the cap are unchanged, and a stale
                // answer can at worst admit or refuse one job at the boundary.
                lock (_capacityLock)
                {
                    if (DateTime.UtcNow - _capacityAt < CapacityWindow)
                    {
                        return _capacityLive < max;
                    }
                }

                int live = 0;
                foreach (string dir in Directory.EnumerateDirectories("/proc"))
                {
                    string name = Path.GetFileName(dir);
                    if (name.Length == 0 || !char.IsDigit(name[0]))
                    {
                        continue;
                    }

                    try
                    {
                        string cmdline = File.ReadAllText(Path.Combine(dir, "cmdline"));
                        if (cmdline.IndexOf("libplacebo", StringComparison.Ordinal) >= 0
                            && cmdline.IndexOf("ffmpeg", StringComparison.Ordinal) >= 0)
                        {
                            live++;
                        }
                    }
                    catch (Exception)
                    {
                        // process vanished or unreadable; ignore
                    }
                }

                lock (_capacityLock)
                {
                    _capacityLive = live;
                    _capacityAt = DateTime.UtcNow;
                }

                return live < max;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static readonly object _capacityLock = new object();
        private static readonly TimeSpan CapacityWindow = TimeSpan.FromSeconds(2);
        private static int _capacityLive;
        private static DateTime _capacityAt = DateTime.MinValue;

        /* --------------------------------------------------------------- live A/B swap (KEYED BY THE OLD PlaySessionId) */

        /// <summary>
        /// One live-apply swap in flight: the old ffmpeg job is still running, a new one has been
        /// admitted, and the old job's teardown (KillTranscodingJobs, called by stock Jellyfin when
        /// the client's re-negotiation reports the old session stopped) is being held until the new
        /// job's first segment is ready - or until this entry times out.
        /// </summary>
        private sealed class SwapState
        {
            public string DeviceId;
            public DateTime RegisteredUtc;
            public bool KillRequested;
            public TranscodeManager Manager;
            public string PendingKillDeviceId;
            public Func<string, bool> PendingDelete;
        }

        private static readonly ConcurrentDictionary<string, SwapState> _pendingSwaps =
            new ConcurrentDictionary<string, SwapState>(StringComparer.OrdinalIgnoreCase);

        private static int _activeSwapCount;

        /// <summary>
        /// How long a swap may stay pending before its deferred kill is forced through anyway. Long
        /// enough for a real transcode start (probe + first segment), short enough that a client
        /// that never re-negotiates does not hold a GPU slot indefinitely.
        /// </summary>
        private static readonly TimeSpan SwapTimeout = TimeSpan.FromSeconds(15);

        /// <summary>
        /// Admits a live-apply swap for the OLD session id, if HasCapacity() has room for the extra
        /// process AND the separate swap cap (MaxConcurrentSwaps) is not exhausted. Total: any
        /// surprise here refuses the swap rather than risking a stuck teardown.
        /// </summary>
        public static string TryAdmitSwap(string oldSessionId, string deviceId)
        {
            try
            {
                if (string.IsNullOrEmpty(oldSessionId))
                {
                    return null;
                }

                SweepExpiredSwaps();

                int cap = Settings?.MaxConcurrentSwaps ?? 0;
                if (cap <= 0 || _activeSwapCount >= cap || !HasCapacity())
                {
                    return "swap-capacity";
                }

                var swap = new SwapState { DeviceId = deviceId, RegisteredUtc = DateTime.UtcNow };
                if (_pendingSwaps.TryAdd(oldSessionId, swap))
                {
                    Interlocked.Increment(ref _activeSwapCount);
                }

                return "swapping";
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// Called from the KillTranscodingJobs Harmony prefix. Returns true (and the caller skips
        /// the real kill) only while a swap for this exact old session id is still admitted and not
        /// expired - the kill arguments are remembered so the real teardown can be replayed once the
        /// new job is ready, or by the timeout sweep if it never arrives.
        /// </summary>
        public static bool TryDeferKill(TranscodeManager manager, string oldSessionId, string deviceId, Func<string, bool> deleteFiles)
        {
            try
            {
                if (string.IsNullOrEmpty(oldSessionId))
                {
                    return false;
                }

                SweepExpiredSwaps();
                if (!_pendingSwaps.TryGetValue(oldSessionId, out var swap))
                {
                    return false;
                }

                swap.Manager = manager;
                swap.PendingKillDeviceId = deviceId;
                swap.PendingDelete = deleteFiles;
                swap.KillRequested = true;
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>
        /// Called from the StartFfMpeg Harmony postfix once the new ffmpeg process has produced its
        /// first segment - StartFfMpeg's own wait loop already blocks on exactly that before
        /// returning, so no separate readiness watch was needed. Finds a pending swap for the SAME
        /// DEVICE (old and new PlaySessionIds differ; DeviceId does not) and, if the old job's
        /// teardown was already requested and deferred, replays it for real now - this is the cut.
        /// </summary>
        public static void OnNewJobReady(TranscodingJob newJob)
        {
            try
            {
                string deviceId = newJob?.DeviceId;
                if (string.IsNullOrEmpty(deviceId))
                {
                    return;
                }

                string foundKey = null;
                SwapState found = null;
                foreach (var kv in _pendingSwaps)
                {
                    if (string.Equals(kv.Value.DeviceId, deviceId, StringComparison.OrdinalIgnoreCase))
                    {
                        foundKey = kv.Key;
                        found = kv.Value;
                        break;
                    }
                }

                if (found == null)
                {
                    return;
                }

                CompleteSwap(foundKey, found, "swapped", newJob.PlaySessionId);
            }
            catch (Exception)
            {
                // never break a real cutover for a bookkeeping failure
            }
        }

        /// <summary>Sweeps swaps whose new job never arrived, forcing the deferred kill through so the old job is never orphaned or double-counted forever.</summary>
        private static void SweepExpiredSwaps()
        {
            try
            {
                foreach (var kv in _pendingSwaps)
                {
                    if (DateTime.UtcNow - kv.Value.RegisteredUtc > SwapTimeout)
                    {
                        CompleteSwap(kv.Key, kv.Value, "swap-timeout");
                    }
                }
            }
            catch (Exception)
            {
                // best effort; a swap left pending here is still bounded by MaxConcurrentSwaps
            }
        }

        private static void CompleteSwap(string oldSessionId, SwapState swap, string finalStatus, string newSessionId = null)
        {
            if (_pendingSwaps.TryRemove(oldSessionId, out _))
            {
                Interlocked.Decrement(ref _activeSwapCount);
            }

            if (swap.KillRequested && swap.Manager != null)
            {
                try
                {
                    _ = swap.Manager.KillTranscodingJobs(swap.PendingKillDeviceId, oldSessionId, swap.PendingDelete ?? (p => false));
                }
                catch (Exception)
                {
                    // the old job may now leak until its own ping timeout; better than crashing
                    // the path that would otherwise have torn it down
                }
            }

            if (_bySession.TryGetValue(oldSessionId, out var oldRecord))
            {
                oldRecord.SwapStatus = finalStatus;
            }

            if (!string.IsNullOrEmpty(newSessionId) && _bySession.TryGetValue(newSessionId, out var newRecord))
            {
                newRecord.SwapStatus = finalStatus;
            }
        }

        /// <summary>Public read of a session's own option, for callers outside this class (BuildVerdict's swapfrom marker).</summary>
        public static string OptionValue(EncodingJobInfo state, string name) => RawOption(state, name);

        /* ------------------------------------------------------------------- encoder selection */

        /// <summary>The ffmpeg binary Jellyfin is using, captured from EncodingOptions when seen.</summary>
        private static string _ffmpegPath;

        private static HashSet<string> _encoders;

        /// <summary>
        /// True once the probe has been attempted, whatever it returned. A failure has to be
        /// remembered SEPARATELY from the result: without this, "I could not ask" re-spawned up to
        /// three ffmpeg processes on the transcode path for every session on a server where the
        /// probe cannot work at all.
        /// </summary>
        private static bool _encodersProbed;
        private static readonly object _encodersLock = new object();

        public static void NoteFfmpegPath(string path)
        {
            if (!string.IsNullOrWhiteSpace(path) && _ffmpegPath == null)
            {
                _ffmpegPath = path;
            }
        }

        /// <summary>
        /// The set of encoder names this ffmpeg build actually has, or null if it could not be
        /// asked. Null is deliberately different from empty: "I do not know" must not be read as
        /// "the encoder is missing", because the safe response to not knowing is to leave the
        /// client-negotiated codec alone.
        /// </summary>
        private static HashSet<string> AvailableEncoders()
        {
            if (_encodersProbed)
            {
                return _encoders;
            }

            lock (_encodersLock)
            {
                if (_encodersProbed)
                {
                    return _encoders;
                }

                var candidates = new List<string>();
                if (!string.IsNullOrWhiteSpace(_ffmpegPath))
                {
                    candidates.Add(_ffmpegPath);
                }

                candidates.Add("/usr/lib/jellyfin-ffmpeg/ffmpeg");
                candidates.Add("/usr/bin/ffmpeg");

                foreach (string exe in candidates)
                {
                    try
                    {
                        if (!File.Exists(exe))
                        {
                            continue;
                        }

                        var psi = new System.Diagnostics.ProcessStartInfo(exe, "-hide_banner -loglevel quiet -encoders")
                        {
                            RedirectStandardOutput = true,
                            RedirectStandardError = true,
                            UseShellExecute = false,
                        };

                        using (var proc = System.Diagnostics.Process.Start(psi))
                        {
                            // BOTH pipes are drained before the wait. Reading stdout to the end
                            // with stderr redirected and never read deadlocks the moment the child
                            // fills the stderr pipe - forever, with no timeout, on a transcode
                            // thread holding the probe lock.
                            var stdoutRead = proc.StandardOutput.ReadToEndAsync();
                            var stderrRead = proc.StandardError.ReadToEndAsync();
                            if (!proc.WaitForExit(15000))
                            {
                                // Leaving it running would strand an ffmpeg per attempt.
                                try
                                {
                                    proc.Kill();
                                    proc.WaitForExit(2000);
                                }
                                catch (Exception)
                                {
                                    // already gone
                                }

                                continue;
                            }

                            if (!System.Threading.Tasks.Task.WaitAll(new[] { stdoutRead, stderrRead }, 5000))
                            {
                                continue;
                            }

                            string stdout = stdoutRead.Result;

                            var found = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                            foreach (string line in stdout.Split('\n'))
                            {
                                // " V....D hevc_nvenc           NVIDIA NVENC hevc encoder"
                                string t = line.Trim();
                                int sp = t.IndexOf(' ');
                                if (sp <= 0 || t.Length < sp + 2)
                                {
                                    continue;
                                }

                                string rest = t.Substring(sp + 1).TrimStart();
                                int sp2 = rest.IndexOf(' ');
                                string name = sp2 > 0 ? rest.Substring(0, sp2) : rest;
                                if (name.Length > 0 && name.IndexOf('-') < 0)
                                {
                                    found.Add(name);
                                }
                            }

                            if (found.Count > 0)
                            {
                                _encoders = found;
                                _encodersProbed = true;
                                return _encoders;
                            }
                        }
                    }
                    catch (Exception)
                    {
                        // try the next candidate
                    }
                }

                // Every candidate failed. Remember that, so the next session does not spawn the
                // same three processes again; null still means "unknown", not "missing".
                _encodersProbed = true;
                return null;
            }
        }

        private static HashSet<string> _filters;
        private static bool _filtersProbed;
        private static readonly object _filtersLock = new object();

        /// <summary>
        /// Does this ffmpeg build carry a filter of this name?
        ///
        /// Asked once and remembered, the way the encoder probe is, and for the same reason: this
        /// runs on the transcode path and must never spawn a process per session. The probe failing
        /// is remembered separately from its result, so a server where it cannot work does not
        /// re-spawn three processes for every playback.
        ///
        /// UNKNOWN COUNTS AS MISSING HERE, which is the opposite of AvailableEncoders' rule and is
        /// deliberate. A refused encoder still plays the video; a filter name ffmpeg does not know
        /// fails the whole job. So when the binary cannot be asked, the caller is told the filter is
        /// not there and the level is not offered.
        /// </summary>
        public static bool HasFilter(string name)
        {
            if (string.IsNullOrWhiteSpace(name))
            {
                return false;
            }

            var filters = AvailableFilters();
            return filters != null && filters.Contains(name.Trim());
        }

        private static readonly object _vulkanDenoiseLock = new object();
        private static bool _vulkanDenoiseProbed;
        private static bool _vulkanDenoiseWorks;

        /// <summary>
        /// Can the PATCHED binary actually run a Vulkan denoise, as opposed to merely listing it?
        ///
        /// Presence and capability are different questions here, and the difference cost a dead
        /// stream: nlmeans_vulkan compiles its shader at run time, and a build whose shaderc
        /// predates GL_EXT_expect_assume lists the filter, accepts the chain, and then fails the
        /// whole transcode. So this RUNS one frame through it rather than asking whether it exists.
        ///
        /// Asked once per process and remembered, like the encoder and filter probes, because this
        /// sits on the transcode path. Unknown counts as NOT WORKING, the same rule HasFilter uses
        /// and for the same reason: the cost of being wrong in that direction is one dropped pass,
        /// and the cost of being wrong in the other is the viewer's stream.
        /// </summary>
        public static bool VulkanDenoiseRunsOnPatchedBinary()
        {
            if (_vulkanDenoiseProbed)
            {
                return _vulkanDenoiseWorks;
            }

            lock (_vulkanDenoiseLock)
            {
                if (_vulkanDenoiseProbed)
                {
                    return _vulkanDenoiseWorks;
                }

                _vulkanDenoiseProbed = true;
                _vulkanDenoiseWorks = false;

                try
                {
                    string exe = ShaderLibrary.PatchedFfmpegPath();
                    if (string.IsNullOrWhiteSpace(exe) || !File.Exists(exe))
                    {
                        return _vulkanDenoiseWorks;
                    }

                    // One 64x64 frame of synthetic input: enough to force the shader to compile,
                    // small enough that a server under load does not notice it happening.
                    const string args = "-hide_banner -loglevel error -init_hw_device vulkan=vk:0 "
                        + "-filter_hw_device vk -f lavfi -i testsrc=size=64x64:rate=1 -frames:v 1 "
                        + "-vf \"format=yuv420p,hwupload,nlmeans_vulkan,hwdownload,format=yuv420p\" -f null -";

                    var psi = new System.Diagnostics.ProcessStartInfo(exe, args)
                    {
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        UseShellExecute = false,
                    };

                    using (var proc = System.Diagnostics.Process.Start(psi))
                    {
                        var outRead = proc.StandardOutput.ReadToEndAsync();
                        var errRead = proc.StandardError.ReadToEndAsync();
                        if (!proc.WaitForExit(20000))
                        {
                            try
                            {
                                proc.Kill();
                            }
                            catch (Exception)
                            {
                                // Already gone.
                            }

                            return _vulkanDenoiseWorks;
                        }

                        System.Threading.Tasks.Task.WaitAll(new System.Threading.Tasks.Task[] { outRead, errRead }, 5000);
                        _vulkanDenoiseWorks = proc.ExitCode == 0;
                    }
                }
                catch (Exception)
                {
                    _vulkanDenoiseWorks = false;
                }

                return _vulkanDenoiseWorks;
            }
        }

        /// <summary>The filter names this ffmpeg build has, or null when it could not be asked.</summary>
        private static HashSet<string> AvailableFilters()
        {
            if (_filtersProbed)
            {
                return _filters;
            }

            lock (_filtersLock)
            {
                if (_filtersProbed)
                {
                    return _filters;
                }

                var candidates = new List<string>();
                if (!string.IsNullOrWhiteSpace(_ffmpegPath))
                {
                    candidates.Add(_ffmpegPath);
                }

                candidates.Add("/usr/lib/jellyfin-ffmpeg/ffmpeg");
                candidates.Add("/usr/bin/ffmpeg");

                foreach (string exe in candidates)
                {
                    try
                    {
                        if (!File.Exists(exe))
                        {
                            continue;
                        }

                        var psi = new System.Diagnostics.ProcessStartInfo(exe, "-hide_banner -loglevel quiet -filters")
                        {
                            RedirectStandardOutput = true,
                            RedirectStandardError = true,
                            UseShellExecute = false,
                        };

                        using (var proc = System.Diagnostics.Process.Start(psi))
                        {
                            // Both pipes drained before the wait, for the deadlock the encoder
                            // probe documents: stderr left unread fills and stops the child while
                            // this thread waits forever on a transcode path holding the lock.
                            var stdoutRead = proc.StandardOutput.ReadToEndAsync();
                            var stderrRead = proc.StandardError.ReadToEndAsync();
                            if (!proc.WaitForExit(15000))
                            {
                                try
                                {
                                    proc.Kill();
                                    proc.WaitForExit(2000);
                                }
                                catch (Exception)
                                {
                                    // already gone
                                }

                                continue;
                            }

                            if (!System.Threading.Tasks.Task.WaitAll(new[] { stdoutRead, stderrRead }, 5000))
                            {
                                continue;
                            }

                            var found = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                            foreach (string line in stdoutRead.Result.Split('\n'))
                            {
                                // " T. fspp              V->V       Apply Fast Simple Post-processing filter."
                                // Flags first, then the name. The header lines carry no flags token
                                // followed by a name, so they fall out of the arrow check below.
                                string[] parts = line.Trim().Split(
                                    new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                                if (parts.Length < 3 || parts[2].IndexOf("->", StringComparison.Ordinal) < 0)
                                {
                                    continue;
                                }

                                if (parts[1].Length > 0)
                                {
                                    found.Add(parts[1]);
                                }
                            }

                            if (found.Count > 0)
                            {
                                _filters = found;
                                _filtersProbed = true;
                                return _filters;
                            }
                        }
                    }
                    catch (Exception)
                    {
                        // try the next candidate
                    }
                }

                _filtersProbed = true;
                return null;
            }
        }

        /// <summary>The codec family an encoder name produces, or null if it is not one we know.</summary>
        private static string CodecOf(string encoder)
        {
            if (string.IsNullOrWhiteSpace(encoder))
            {
                return null;
            }

            string e = encoder.ToLowerInvariant();
            if (e.Contains("hevc") || e.Contains("h265") || e.Contains("x265"))
            {
                return "hevc";
            }

            if (e.Contains("av1"))
            {
                return "av1";
            }

            if (e.Contains("vp9"))
            {
                return "vp9";
            }

            if (e.Contains("h264") || e.Contains("x264") || e.Contains("avc"))
            {
                return "h264";
            }

            return null;
        }

        /// <summary>
        /// The codecs the SESSION declared it can play, normalised.
        ///
        /// This is the honest capability list and it is not the same thing as the negotiated
        /// codec. EncodingJobInfo.SupportedVideoCodecs carries what the device profile said it
        /// accepts; BaseRequest.VideoCodec carries the single codec Jellyfin then picked. Checking
        /// the configured encoder against the negotiated codec alone can only ever succeed when
        /// the two already agree, which would leave the Encoder setting inert - the exact bug
        /// being fixed.
        /// </summary>
        private static HashSet<string> SupportedCodecs(EncodingJobInfo state)
        {
            var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                string[] supported = state?.SupportedVideoCodecs;
                if (supported != null)
                {
                    foreach (string c in supported)
                    {
                        string n = Normalise(c);
                        if (n != null)
                        {
                            set.Add(n);
                        }
                    }
                }
            }
            catch (Exception)
            {
                // fall through to whatever the request itself names
            }

            string negotiated = ClientCodec(state);
            if (negotiated != null)
            {
                set.Add(negotiated);
            }

            return set;
        }

        private static string Normalise(string codec)
        {
            if (string.IsNullOrWhiteSpace(codec))
            {
                return null;
            }

            string c = codec.Trim().ToLowerInvariant();
            if (c.Contains("hevc") || c.Contains("h265"))
            {
                return "hevc";
            }

            if (c.Contains("av1"))
            {
                return "av1";
            }

            if (c.Contains("vp9"))
            {
                return "vp9";
            }

            if (c.Contains("h264") || c.Contains("avc"))
            {
                return "h264";
            }

            return null;
        }

        /// <summary>The codec the client negotiated, normalised, or null when it said nothing.</summary>
        private static string ClientCodec(EncodingJobInfo state)
        {
            string requested = state?.BaseRequest?.VideoCodec ?? string.Empty;
            if (requested.IndexOf("h264", StringComparison.OrdinalIgnoreCase) >= 0
                || requested.IndexOf("avc", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "h264";
            }

            if (requested.IndexOf("hevc", StringComparison.OrdinalIgnoreCase) >= 0
                || requested.IndexOf("h265", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "hevc";
            }

            if (requested.IndexOf("av1", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "av1";
            }

            return null;
        }

        /// <summary>
        /// The encoder to substitute for a stream copy.
        ///
        /// The configured Encoder setting is honoured, which it previously was not - the plugin
        /// followed the client's negotiated codec and quietly ignored the dashboard field. It is
        /// honoured with two guards, because handing a client a codec it cannot decode is not a
        /// worse picture, it is no picture:
        ///
        ///   1. ffmpeg must actually have that encoder. If the encoder list cannot be read at all,
        ///      that counts as "unknown", not as "missing", and the configured encoder is refused
        ///      rather than gambled on.
        ///   2. The session must have declared the encoder's codec playable. Jellyfin puts the
        ///      codecs the client will accept in the request's VideoCodec list; if the configured
        ///      encoder's codec is not among them, the client-negotiated codec wins.
        ///
        /// Blank or "auto" means "follow the client", which is the old behaviour on request.
        /// </summary>
        public static string EncoderFor(EncodingJobInfo state, out string reason)
        {
            string clientCodec = ClientCodec(state);
            string clientEncoder = clientCodec == "h264" ? "h264_nvenc"
                : clientCodec == "hevc" ? "hevc_nvenc"
                : clientCodec == "av1" ? "av1_nvenc"
                : null;

            string configured = Settings?.Encoder;

            if (string.IsNullOrWhiteSpace(configured) || string.Equals(configured.Trim(), "auto", StringComparison.OrdinalIgnoreCase))
            {
                reason = clientEncoder != null
                    ? "Encoder set to auto; following the client-negotiated " + clientCodec
                    : "Encoder set to auto and the client named no codec; using hevc_nvenc";
                return clientEncoder ?? "hevc_nvenc";
            }

            configured = configured.Trim();
            string fallback = clientEncoder ?? configured;

            var available = AvailableEncoders();
            if (available == null)
            {
                reason = "could not read the ffmpeg encoder list; refused configured '" + configured + "' and used " + fallback;
                return fallback;
            }

            if (!available.Contains(configured))
            {
                reason = "ffmpeg has no encoder '" + configured + "'; used " + fallback;
                return fallback;
            }

            string configuredCodec = CodecOf(configured);
            if (configuredCodec == null)
            {
                reason = "cannot tell what codec '" + configured + "' produces, so cannot check the client supports it; used " + fallback;
                return fallback;
            }

            var supported = SupportedCodecs(state);
            if (supported.Count > 0 && !supported.Contains(configuredCodec))
            {
                reason = "session supports [" + string.Join(",", supported.OrderBy(x => x))
                    + "] and not " + configuredCodec + "; refused configured '" + configured
                    + "' and used " + fallback;
                return fallback;
            }

            reason = "configured encoder '" + configured + "' applied";
            return configured;
        }

        /// <summary>
        /// The hwaccel device arguments this plan's chain needs: Vulkan for the normal libplacebo
        /// chain, or CUDA for a session running one of the CUDA-native neural levels (dlpp-1..4,
        /// vsr-rtcuda) - see Plan.UsesCudaNeural and INTEGRATION_DESIGN.md section 2. The CUDA
        /// form also asks for the OUTPUT format on the decoder itself
        /// (-hwaccel_output_format cuda), unlike the Vulkan form, because this branch never
        /// leaves GPU memory: decode hands CUDA frames straight to the filter chain.
        /// </summary>
        public static string HwaccelArgs(Plan plan) =>
            plan != null && plan.UsesCudaNeural
                ? " -hwaccel cuda -hwaccel_output_format cuda"
                : " -init_hw_device vulkan=vk:0 -filter_hw_device vk";

        /// <summary>
        /// The libplacebo chain for this plan.
        ///
        /// Ordering inside the shader file is decided by the hook points, not by this method -
        /// see ShaderLibrary.Compose. Both FSRCNNX and RCAS hook LUMA, so the sharpening runs on
        /// the network's enlarged luma plane, before the final scale, and therefore at 2x the
        /// source size rather than at output size. That is what makes RCAS nearly free.
        /// The one thing this method does own is that DENOISE runs first, before the upscale.
        /// </summary>
        public static string BuildChain(Plan plan)
        {
            UpscaleSettings cfg = Settings;

            if (plan.UsesCudaNeural)
            {
                // CUDA-NATIVE BRANCH. Decode already produced AV_PIX_FMT_CUDA frames (see
                // HwaccelArgs), so this never touches "format=yuv420p", never hwuploads and never
                // reaches libplacebo - the whole point being no system-memory round trip anywhere
                // in the graph, verified this session (host-callback counters showed +0 allocs
                // and +0 host-to-device copies after init, across every frame, for both
                // dlpp_rtcuda and vsr_rtcuda together). NVENC takes the CUDA frame directly, same
                // as GpuResidentEncode's hwmap path does for the Vulkan chain, except there is no
                // hwmap needed here because the frame was never anywhere else.
                var cudaNodes = new List<string>();
                if (!string.IsNullOrEmpty(plan.CudaDenoiseNode))
                {
                    cudaNodes.Add(plan.CudaDenoiseNode);
                }

                if (plan.NeuralApplied && !string.IsNullOrEmpty(plan.NeuralFilter))
                {
                    cudaNodes.Add(plan.NeuralFilter);
                }

                return string.Join(",", cudaNodes);
            }

            var sb = new StringBuilder();
            sb.Append("format=yuv420p");

            // Declared before anything reads the pixels. Only for a source that said nothing: a
            // file that declares full range is left alone, because forcing tv on genuinely full
            // material is the same error in the other direction.
            if (plan.RangeUntagged)
            {
                sb.Append(",setparams=range=tv");
            }

            var cpuNodes = new List<string>();

            // Deblocking runs FIRST of everything, at source resolution, before denoise and long
            // before the scale. The SR networks were trained on clean downsampled images, so a DCT
            // block edge or mosquito ringing reaching one is reconstructed as detail - the pass
            // amplifies the artefact. There is no later point that undoes that, which is why this
            // node is the head of the chain rather than an option somewhere in the middle. Every
            // level is a CPU filter today (this build has no deblock_vulkan), so it lands before
            // hwupload; the hardware branch below exists so the invariant holds if one ever does.
            if (plan.DeblockApplied && !plan.DeblockWantsHwFrames)
            {
                cpuNodes.Add(plan.DeblockFilter);
            }

            // Denoise runs BEFORE the upscale, always: denoising after enlargement would be asked
            // to remove noise the network has already turned into structure. Which SIDE of
            // hwupload it lands on is decided by the filter, not by the level name: atadenoise is
            // a CPU filter and goes before hwupload, while the nlmeans_vulkan levels take Vulkan
            // frames and go after it, still ahead of libplacebo. See the routing invariant at
            // ShaderLibrary._denoiseFilters.
            if (plan.DenoiseApplied && !plan.DenoiseWantsHwFrames)
            {
                cpuNodes.Add(plan.DenoiseFilter);
            }

            // Neural super-resolution runs AFTER denoise and BEFORE hwupload. After denoise for
            // the reason denoise runs first at all - a network handed noise turns it into
            // structure. Before hwupload because the "ort" filter takes planar float RGB on the
            // CPU, exactly as oidn does; libplacebo then scales whatever the network produced to
            // the size the session actually asked for, so the network's own factor never has to
            // match the target ratio.
            if (plan.NeuralApplied)
            {
                cpuNodes.Add(plan.NeuralFilter);
            }

            // The game temporal upscalers run last on the CPU side, after denoise and after
            // neural SR, immediately before hwupload. fsr2 and dlss hand libplacebo a picture
            // that is already at the target size, so the libplacebo scale becomes a no-op;
            // dlaa hands it the source size and libplacebo still does the scaling.
            if (plan.GameApplied)
            {
                cpuNodes.Add(plan.GameFilter);
            }

            AppendCpuNodes(sb, cpuNodes);

            sb.Append(",hwupload");

            if (plan.DeblockApplied && plan.DeblockWantsHwFrames)
            {
                sb.Append(',').Append(plan.DeblockFilter);
            }

            if (plan.DenoiseApplied && plan.DenoiseWantsHwFrames)
            {
                sb.Append(',').Append(plan.DenoiseFilter);
            }

            sb.AppendFormat(
                CultureInfo.InvariantCulture,
                ",libplacebo=w={0}:h={1}:upscaler={2}",
                plan.Width,
                plan.Height,
                string.IsNullOrWhiteSpace(plan.Upscaler) ? "ewa_lanczos" : plan.Upscaler);

            // Debanding. grain=0 is not a detail: libplacebo defaults it to 6, which dithers
            // synthetic grain over the picture. That is wrong for this content, which is already
            // noisy - the point of debanding here is the flat dark gradients, not texture.
            //
            // Both numbers are clamped to libplacebo's documented 0-1000 range for these two
            // AVOptions rather than passed through: a value outside it is rejected when the filter
            // is opened, which fails the whole transcode instead of producing a worse picture.
            if (plan.DebandApplied)
            {
                sb.AppendFormat(
                    CultureInfo.InvariantCulture,
                    ":deband=1:deband_threshold={0}:deband_grain={1}",
                    Math.Max(0, Math.Min(1000, cfg?.DebandThreshold ?? 3)),
                    Math.Max(0, Math.Min(1000, cfg?.DebandGrain ?? 0)));
            }

            if (!string.IsNullOrEmpty(plan.ShaderPath) && File.Exists(plan.ShaderPath))
            {
                sb.Append(":custom_shader_path=").Append(plan.ShaderPath);

                // Without a cache, every ffmpeg process compiles the composed GLSL again - and
                // FSRCNNX plus RCAS is a lot of it - so the first segment stalls, and so does the
                // restart after every seek. The prefix is per shader combination, because a cache
                // keyed on one combination is useless to another.
                string cachePrefix = ShaderLibrary.ShaderCachePrefix(cfg, plan.ShaderPath);
                if (!string.IsNullOrEmpty(cachePrefix))
                {
                    sb.Append(":shader_cache=").Append(cachePrefix);
                }
            }

            // Default: bring the frame back to system memory so NVENC re-uploads it itself.
            // GpuResidentEncode instead derives a CUDA device from the existing Vulkan one and
            // hands NVENC the frame without leaving the GPU - see the config page for why this
            // is opt-in rather than the default.
            sb.Append(cfg?.GpuResidentEncode == true
                ? ",hwmap=derive_device=cuda"
                : ",hwdownload,format=yuv420p");
            return sb.ToString();
        }

        /// <summary>
        /// Appends the CPU-side nodes, converting into planar float ONCE around a run of nodes
        /// that want it rather than once per node.
        ///
        /// oidn, optix, ort, fsr2 and dlss each carry their own format=gbrpf32le,...,format=yuv420p
        /// because each has to work in float. Emitted per node, two of them in a row (denoise=oidn
        /// plus a neural level) converted back to yuv420p and straight into float again BETWEEN the
        /// two passes, which re-subsamples chroma to 4:2:0 and requantises to 8 bit in the middle
        /// of the group. The wrappers are stripped and the conversions emitted around the run, so
        /// the group stays in float throughout. A single float node, or one with a non-float node
        /// such as atadenoise beside it, produces exactly the string it produced before.
        /// </summary>
        private static void AppendCpuNodes(StringBuilder sb, List<string> nodes)
        {
            const string floatIn = "format=gbrpf32le,";
            const string floatOut = ",format=yuv420p";

            bool inFloat = false;
            foreach (string node in nodes)
            {
                string body = node;
                bool wantsFloat = body.StartsWith(floatIn, StringComparison.Ordinal)
                    && body.EndsWith(floatOut, StringComparison.Ordinal);
                if (wantsFloat)
                {
                    body = body.Substring(floatIn.Length, body.Length - floatIn.Length - floatOut.Length);
                }

                if (wantsFloat && !inFloat)
                {
                    sb.Append(",format=gbrpf32le");
                    inFloat = true;
                }
                else if (!wantsFloat && inFloat)
                {
                    sb.Append(",format=yuv420p");
                    inFloat = false;
                }

                sb.Append(',').Append(body);
            }

            if (inFloat)
            {
                sb.Append(",format=yuv420p");
            }
        }

        /// <summary>
        /// Splits an ffmpeg filter chain on the commas that separate nodes, leaving commas that
        /// are escaped or inside parentheses (as in Jellyfin's scale=trunc(min(...)) expressions) alone.
        /// </summary>
        public static List<string> SplitFilters(string chain)
        {
            var nodes = new List<string>();
            if (string.IsNullOrEmpty(chain))
            {
                return nodes;
            }

            int depth = 0;
            var cur = new StringBuilder();
            char prev = '\0';
            foreach (char ch in chain)
            {
                if (ch == '(' && prev != '\\')
                {
                    depth++;
                }
                else if (ch == ')' && prev != '\\')
                {
                    depth--;
                }

                if (ch == ',' && depth == 0 && prev != '\\')
                {
                    nodes.Add(cur.ToString());
                    cur.Clear();
                }
                else
                {
                    cur.Append(ch);
                }

                prev = ch;
            }

            if (cur.Length > 0)
            {
                nodes.Add(cur.ToString());
            }

            return nodes.Where(n => !string.IsNullOrWhiteSpace(n)).ToList();
        }

        private static readonly string[] _replacedNodes = { "scale", "hwupload", "hwdownload", "hwmap", "format", "libplacebo" };

        /// <summary>
        /// Keeps Jellyfin's own non-scaling filter nodes (colour tagging and friends) and drops the
        /// scaling / hardware-frame nodes that our chain replaces.
        /// </summary>
        public static List<string> KeepNonScalingNodes(string chain)
        {
            var kept = new List<string>();
            foreach (string node in SplitFilters(chain))
            {
                string trimmed = node.Trim();
                int eq = trimmed.IndexOf('=');
                string name = eq >= 0 ? trimmed.Substring(0, eq) : trimmed;
                if (!_replacedNodes.Any(p => name.StartsWith(p, StringComparison.OrdinalIgnoreCase)))
                {
                    kept.Add(trimmed);
                }
            }

            return kept;
        }
    }
}
