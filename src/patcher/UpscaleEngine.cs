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

        public string DenoiseLevel { get; set; }

        /// <summary>The video encoder that went into the command, when this plugin chose it.</summary>
        public string Encoder { get; set; }

        /// <summary>Why that encoder, in particular whether a configured encoder was refused.</summary>
        public string EncoderReason { get; set; }

        /// <summary>applied | not-requested | concurrency-cap | subtitle-burn-in | stream-copy | disabled | ineligible.</summary>
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

            public string DeblurLevel { get; set; } = "off";

            public string DenoiseLevel { get; set; } = "off";

            /// <summary>The ffmpeg filter node for the denoise level, or null.</summary>
            public string DenoiseFilter { get; set; }

            /// <summary>True when the denoise node needs Vulkan frames, i.e. goes after hwupload.</summary>
            public bool DenoiseWantsHwFrames { get; set; }

            public string ShaderPath { get; set; }

            /// <summary>The session explicitly asked for a larger picture.</summary>
            public bool ClientOptIn { get; set; }

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
                    default:
                        return "No enhancement";
                }
            }

            var parts = new List<string>();
            if (r.DenoiseApplied)
            {
                parts.Add("Denoise " + r.DenoiseLevel);
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
                parts.Add("Unblur " + r.DeblurLevel + " (CAS)");
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
                if (upscaleOption != null)
                {
                    if (string.Equals(upscaleOption, "off", StringComparison.OrdinalIgnoreCase))
                    {
                        requested = 0;
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
                string deblurLevel = cfg.DeblurAllowed ? (Option(state, "deblur") ?? cfg.DeblurLevel) : "off";
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

                if (!plan.UpscaleApplied)
                {
                    // The SR shaders only earn their pass when the output is meaningfully larger
                    // than the source, so at 1:1 they would cost a pass for nothing.
                    srLevel = "off";
                }

                // ---- denoise --------------------------------------------------------------
                // Same carrier as the others: a lowercase query parameter survives Jellyfin's
                // ParseStreamOptions into StreamOptions and is read back with GetOption.
                string denoiseLevel = cfg.DenoiseAllowed ? (Option(state, "denoise") ?? cfg.DenoiseLevel) : "off";
                if (!ShaderLibrary.IsDenoiseLevel(denoiseLevel))
                {
                    denoiseLevel = ShaderLibrary.IsDenoiseLevel(cfg.DenoiseLevel) ? cfg.DenoiseLevel : "off";
                }

                plan.DenoiseFilter = ShaderLibrary.DenoiseFilter(denoiseLevel, out string denoiseUsed, out bool denoiseHw);
                plan.DenoiseLevel = denoiseUsed;
                plan.DenoiseWantsHwFrames = denoiseHw;
                plan.DenoiseApplied = plan.DenoiseFilter != null;

                bool wantDeblur = !string.Equals(deblurLevel, "off", StringComparison.OrdinalIgnoreCase);
                if (!plan.UpscaleApplied && !wantDeblur && !plan.DenoiseApplied)
                {
                    return Plan.No("not-requested", upscaleReason ?? "nothing requested");
                }

                plan.ShaderPath = ShaderLibrary.Resolve(cfg, srLevel, deblurLevel, out string srUsed, out string deblurUsed);
                plan.SrLevel = srUsed;
                plan.DeblurLevel = deblurUsed;
                plan.DeblurApplied = !string.Equals(deblurUsed, "off", StringComparison.OrdinalIgnoreCase);

                // Debanding rides along on the libplacebo instance that is being built anyway, so
                // it is only "applied" when there is a chain for it to ride on.
                plan.DebandApplied = cfg.Deband;

                if (!plan.UpscaleApplied && !plan.DeblurApplied && !plan.DenoiseApplied)
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
        /// Ordering: the super-resolution shader hooks LUMA, which libplacebo runs before scaling,
        /// and the sharpening shader hooks MAIN, which runs after. So the picture is restored to
        /// its target size first and only then sharpened, once, at output resolution. Sharpening
        /// before the upscale would feed the network its own halos and get them magnified; running
        /// both as LUMA hooks would sharpen twice, since FSRCNNX already sharpens on the way up.
        /// That is also why the default sharpening level is conservative.
        /// </summary>
        public static string BuildChain(Plan plan)
        {
            UpscaleSettings cfg = Settings;
            var sb = new StringBuilder();
            sb.Append("format=yuv420p");

            // Denoise runs BEFORE the upscale, always: denoising after enlargement would be asked
            // to remove noise the network has already turned into structure. hqdn3d is a CPU
            // filter and so goes before hwupload; nlmeans_vulkan takes Vulkan frames and goes
            // after it, still ahead of libplacebo.
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
                string.IsNullOrWhiteSpace(cfg.Upscaler) ? "ewa_lanczos" : cfg.Upscaler);

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
