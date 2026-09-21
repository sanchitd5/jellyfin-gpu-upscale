using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Controller.Streaming;

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

        public string DenoiseLevel { get; set; }

        /// <summary>The video encoder that went into the command, when this plugin chose it.</summary>
        public string Encoder { get; set; }

        /// <summary>Why that encoder, in particular whether a configured encoder was refused.</summary>
        public string EncoderReason { get; set; }

        /// <summary>applied | not-requested | off-by-client | concurrency-cap | subtitle-burn-in | stream-copy | disabled | ineligible.</summary>
        public string Status { get; set; }

        public string Reason { get; set; }

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
                        if (!string.IsNullOrEmpty(dropped.PlaySessionId))
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

        public static SessionRecord Describe(EncodingJobInfo state, Plan plan, string status, string reason)
        {
            var record = new SessionRecord
            {
                Timestamp = DateTime.UtcNow.ToString("u", CultureInfo.InvariantCulture),
                PlaySessionId = SessionKey(state),
                Source = state?.MediaPath,
                SourceWidth = plan.SourceWidth,
                SourceHeight = plan.SourceHeight,
                OutputWidth = plan.Act ? plan.Width : plan.SourceWidth,
                OutputHeight = plan.Act ? plan.Height : plan.SourceHeight,
                UpscaleApplied = plan.Act && plan.UpscaleApplied,
                DeblurApplied = plan.Act && plan.DeblurApplied,
                DenoiseApplied = plan.Act && plan.DenoiseApplied,
                DebandApplied = plan.Act && plan.DebandApplied,
                DeblurLevel = plan.Act && plan.DeblurApplied ? plan.DeblurLevel : "off",
                SrLevel = plan.Act && plan.UpscaleApplied ? plan.SrLevel : "off",
                RefineLevel = plan.Act && plan.RefineApplied ? plan.RefineLevel : "off",
                RefineApplied = plan.Act && plan.RefineApplied,
                ChromaLevel = plan.Act && plan.ChromaApplied ? plan.ChromaLevel : "off",
                ChromaApplied = plan.Act && plan.ChromaApplied,
                SrRequested = plan.SrRequested ?? "off",
                SrBypassed = plan.Act && plan.SrBypassed,
                SrOwnsSharpening = plan.Act && plan.SrOwnsSharpening,
                Upscaler = plan.Act ? plan.Upscaler : null,
                DenoiseLevel = plan.Act && plan.DenoiseApplied ? plan.DenoiseLevel : "off",
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
            if (r.DenoiseApplied)
            {
                parts.Add("Denoise " + r.DenoiseLevel + " (" + DenoiserName(r.DenoiseLevel) + ")");
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
                    string.Equals(r.SrLevel, "off", StringComparison.OrdinalIgnoreCase) ? "plain scaling" : r.SrLevel));
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

        private static string Option(EncodingJobInfo state, string name)
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

        /// <summary>
        /// Works out what this job should get. Session options win; the dashboard settings are the
        /// fallback, which is what keeps the features working when the player UI is not there.
        /// </summary>
        public static Plan Decide(EncodingJobInfo state)
        {
            try
            {
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
                        int tw = (int)Math.Round(sw * ((double)target / sh) / 2.0, MidpointRounding.AwayFromZero) * 2;
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
                if (!ShaderLibrary.IsDeblurLevel(deblurLevel))
                {
                    deblurLevel = ShaderLibrary.IsDeblurLevel(cfg.DeblurLevel) ? cfg.DeblurLevel : "off";
                }

                // ---- super-resolution level ----------------------------------------------
                string srLevel = Option(state, "sr") ?? cfg.SrLevel;
                if (!ShaderLibrary.IsSrLevel(srLevel))
                {
                    srLevel = ShaderLibrary.IsSrLevel(cfg.SrLevel) ? cfg.SrLevel : "fsrcnnx";
                }

                plan.SrRequested = ShaderLibrary.CanonicalSr(srLevel) ?? "off";

                // ---- post-scale refinement and chroma upscaling ---------------------------
                // Two axes of their own, carried on the same lowercase-query-parameter channel as
                // everything else. Neither is an SR level: the refinement hooks POSTKERNEL and the
                // chroma pass hooks CHROMA, so both compose with whatever SR level is in force
                // rather than replacing it. See ShaderLibrary._refineFiles / _chromaFiles.
                string refineDefault = clientSaidOff ? "off" : cfg.RefineLevel;
                string refineLevel = Option(state, "refine") ?? refineDefault;
                if (!ShaderLibrary.IsRefineLevel(refineLevel))
                {
                    refineLevel = ShaderLibrary.IsRefineLevel(cfg.RefineLevel) ? cfg.RefineLevel : "off";
                }

                string chromaDefault = clientSaidOff ? "off" : cfg.ChromaLevel;
                string chromaLevel = Option(state, "chroma") ?? chromaDefault;
                if (!ShaderLibrary.IsChromaLevel(chromaLevel))
                {
                    chromaLevel = ShaderLibrary.IsChromaLevel(cfg.ChromaLevel) ? cfg.ChromaLevel : "off";
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
                    denoiseLevel = ShaderLibrary.IsDenoiseLevel(cfg.DenoiseLevel) ? cfg.DenoiseLevel : "off";
                }

                plan.DenoiseFilter = ShaderLibrary.DenoiseFilter(denoiseLevel, out string denoiseUsed, out bool denoiseHw);
                plan.DenoiseLevel = denoiseUsed;
                plan.DenoiseWantsHwFrames = denoiseHw;
                plan.DenoiseApplied = plan.DenoiseFilter != null;

                bool wantDeblur = !string.Equals(deblurLevel, "off", StringComparison.OrdinalIgnoreCase);
                bool wantRefine = !string.Equals(refineLevel, "off", StringComparison.OrdinalIgnoreCase);
                bool wantChroma = !string.Equals(chromaLevel, "off", StringComparison.OrdinalIgnoreCase);
                if (!plan.UpscaleApplied && !wantDeblur && !wantRefine && !wantChroma && !plan.DenoiseApplied)
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
                    wantDeband = !(string.Equals(debandOption, "off", StringComparison.OrdinalIgnoreCase)
                        || string.Equals(debandOption, "0", StringComparison.Ordinal)
                        || string.Equals(debandOption, "false", StringComparison.OrdinalIgnoreCase));
                }

                plan.Upscaler = ShaderLibrary.CanonicalUpscaler(Option(state, "kernel"))
                    ?? ShaderLibrary.CanonicalUpscaler(cfg.Upscaler)
                    ?? "ewa_lanczos";

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
                    && !plan.ChromaApplied && !plan.DenoiseApplied)
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

                return live < max;
            }
            catch (Exception)
            {
                return false;
            }
        }

        /* ------------------------------------------------------------------- encoder selection */

        /// <summary>The ffmpeg binary Jellyfin is using, captured from EncodingOptions when seen.</summary>
        private static string _ffmpegPath;

        private static HashSet<string> _encoders;
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
            if (_encoders != null)
            {
                return _encoders;
            }

            lock (_encodersLock)
            {
                if (_encoders != null)
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
                            string stdout = proc.StandardOutput.ReadToEnd();
                            if (!proc.WaitForExit(15000))
                            {
                                continue;
                            }

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
                                return _encoders;
                            }
                        }
                    }
                    catch (Exception)
                    {
                        // try the next candidate
                    }
                }

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

        /// <summary>Vulkan device arguments the libplacebo chain needs.</summary>
        public static string HwaccelArgs() => " -init_hw_device vulkan=vk:0 -filter_hw_device vk";

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
            var sb = new StringBuilder();
            sb.Append("format=yuv420p");

            // Denoise runs BEFORE the upscale, always: denoising after enlargement would be asked
            // to remove noise the network has already turned into structure. Which SIDE of
            // hwupload it lands on is decided by the filter, not by the level name: atadenoise is
            // a CPU filter and goes before hwupload, while the nlmeans_vulkan levels take Vulkan
            // frames and go after it, still ahead of libplacebo. See the routing invariant at
            // ShaderLibrary._denoiseFilters.
            if (plan.DenoiseApplied && !plan.DenoiseWantsHwFrames)
            {
                sb.Append(',').Append(plan.DenoiseFilter);
            }

            sb.Append(",hwupload");

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
            if (plan.DebandApplied)
            {
                sb.Append(":deband=1:deband_threshold=3:deband_grain=0");
            }

            if (!string.IsNullOrEmpty(plan.ShaderPath) && File.Exists(plan.ShaderPath))
            {
                sb.Append(":custom_shader_path=").Append(plan.ShaderPath);
            }

            sb.Append(",hwdownload,format=yuv420p");
            return sb.ToString();
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
