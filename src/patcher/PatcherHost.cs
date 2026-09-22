using System;
using System.Collections.Generic;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.GpuUpscale.Patcher
{
    /// <summary>
    /// The entry point the plugin calls into, by reflection, across the load-context boundary.
    /// Every member takes and returns only primitives so no type has to be shared between the
    /// plugin's collectible context and this assembly's default one.
    /// </summary>
    public static class PatcherHost
    {
        private static readonly JsonSerializerOptions _json = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
        };

        public static string Apply(object logger, string settingsJson)
        {
            Configure(settingsJson);
            UpscalePatches.Apply(logger as ILogger);
            return UpscalePatches.Status;
        }

        public static void Configure(string settingsJson)
        {
            try
            {
                var settings = JsonSerializer.Deserialize<UpscaleSettings>(settingsJson, _json);
                if (settings != null)
                {
                    UpscaleEngine.Settings = settings;
                }
            }
            catch (Exception)
            {
                // keep whatever we had
            }
        }

        public static bool IsActive() => UpscalePatches.Active;

        /// <summary>
        /// The levels this server can actually deliver right now, so the injected player menu can
        /// be built from what exists instead of from a list baked into the script. A level whose
        /// shader file is not installed is not listed, and therefore is not offered.
        ///
        /// SrMinScaleFactor rides along because the menu has to be able to say that a chosen SR
        /// level is inactive for a low-ratio target rather than pretending it ran.
        /// </summary>
        /// <summary>
        /// The degraded wording the menu must render beside each game upscaler level. It is served
        /// rather than baked into the script so that the one place it is written is the same place
        /// the level is defined.
        /// </summary>
        private static Dictionary<string, string> GameLabels(UpscaleSettings cfg)
        {
            var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (string level in ShaderLibrary.AvailableGameLevels(cfg))
            {
                map[level] = ShaderLibrary.GameLabel(level);
            }

            return map;
        }

        /// <summary>The server's own wording for one option axis, keyed by value.</summary>
        private static Dictionary<string, string> OptionLabels(string axis, string[] values)
        {
            var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (string v in values)
            {
                map[v] = ShaderLibrary.GameOptionLabel(axis, v);
            }

            return map;
        }

        private static Dictionary<string, object> Levels()
        {
            var cfg = UpscaleEngine.Settings;
            return new Dictionary<string, object>
            {
                ["Sr"] = ShaderLibrary.AvailableSrLevels(cfg),
                ["Deblur"] = ShaderLibrary.AvailableDeblurLevels(cfg),
                ["Denoise"] = ShaderLibrary.AvailableDenoiseLevels(),

                // Compression cleanup, ahead of any enlargement, and gated by its master switch for
                // the same reason Neural, Game, Refine and Chroma are: Decide would force a level
                // back to off, so offering one would be a control that does nothing.
                ["Deblock"] = cfg?.DeblockAllowed == false
                    ? new List<string> { "off" }
                    : ShaderLibrary.AvailableDeblockLevels(),

                // Neural super-resolution: an axis of its own, and one that can be EMPTY. The
                // weights are not shipped, so on a server where they were never exported this
                // list is just "off" and the menu renders no choice rather than one that fails.
                // With the master switch off the list is "off" alone, for the same reason Refine
                // and Chroma are gated below: Decide would force the level back to off anyway.
                ["Neural"] = cfg?.NeuralAllowed == false
                    ? new List<string> { "off" }
                    : ShaderLibrary.AvailableNeuralLevels(cfg),

                // Game temporal upscalers: another axis of its own, and another that can be
                // short. dlss and dlaa need an NVIDIA DLSS runtime that is not shipped with
                // this plugin, so they are listed only where one was installed.
                // Gated by its master switch too, for the same reason.
                ["Game"] = cfg?.GameAllowed == false
                    ? new List<string> { "off" }
                    : ShaderLibrary.AvailableGameLevels(cfg),
                ["GameLabels"] = GameLabels(cfg),

                // The three synthesised-input options of those upscalers, their allowed values and
                // their wording, plus the levels they act on. Served rather than baked into the
                // script for the same reason the levels are: one place defines them, and a panel
                // row is shown only where it does something.
                ["GameJitter"] = new List<string>(ShaderLibrary.GameJitterValues),
                ["GameDepth"] = new List<string>(ShaderLibrary.GameDepthValues),
                ["GameReactive"] = new List<string>(ShaderLibrary.GameReactiveValues),
                ["GameJitterLabels"] = OptionLabels("jitter", ShaderLibrary.GameJitterValues),
                ["GameDepthLabels"] = OptionLabels("depth", ShaderLibrary.GameDepthValues),
                ["GameReactiveLabels"] = OptionLabels("reactive", ShaderLibrary.GameReactiveValues),
                // Every one of these reads the configured directories, not the built-in defaults:
                // the probe builds the panel, so a probe answering from different paths than the
                // transcode reads would offer levels whose weights are not where the filter looks.
                ["GameOptionLevels"] = ShaderLibrary.GameOptionLevels(cfg),

                // Two axes of their own, not extra rungs of the SR list: the refinement pass
                // hooks POSTKERNEL and the chroma pass hooks CHROMA, so each composes with
                // whatever SR level is chosen. They are listed separately so the menu can
                // render them as separate controls rather than folding them into one list.
                // With the master switch off the level is not offered at all, rather than offered
                // and then quietly ignored by Decide: a control that does nothing is the failure
                // this plugin keeps hitting.
                ["Refine"] = cfg?.RefineAllowed == false
                    ? new List<string> { "off" }
                    : ShaderLibrary.AvailableRefineLevels(cfg),
                ["Chroma"] = cfg?.ChromaAllowed == false
                    ? new List<string> { "off" }
                    : ShaderLibrary.AvailableChromaLevels(cfg),
                ["SrMinScaleFactor"] = cfg?.SrMinScaleFactor ?? 0d,
                ["MinScaleFactor"] = cfg?.MinScaleFactor ?? 0d,
                ["MaxSourceHeight"] = cfg?.MaxSourceHeight ?? 0,

                // MinScaleFactor / MaxSourceHeight / MaxTargetHeight are here so the player menu
                // can offer only targets this server would actually accept. Hardcoding them in the
                // script would drift away from the dashboard the first time anyone tuned one.
                ["MaxTargetHeight"] = cfg?.MaxTargetHeight ?? 0,
                ["Upscalers"] = ShaderLibrary.Upscalers,
            };
        }

        /// <summary>Status plus recent sessions, as JSON.</summary>
        public static string StatusJson()
        {
            return JsonSerializer.Serialize(new Dictionary<string, object>
            {
                ["PatchActive"] = UpscalePatches.Active,
                ["PatchStatus"] = UpscalePatches.Status,
                ["Sessions"] = UpscaleEngine.History,
            });
        }

        /// <summary>
        /// What actually happened for one play session, as JSON, or a null-ish record when nothing
        /// is known. Never reports enhancement that was not applied.
        /// </summary>
        public static string SessionJson(string playSessionId) => SessionJson(playSessionId, null);

        /// <summary>
        /// As <see cref="SessionJson(string)"/>, but refuses to describe a session that belongs to
        /// a different viewer. The record is reported as if it did not exist rather than as a
        /// permission error, so the response never tells a caller that someone else's session
        /// exists at all.
        ///
        /// An empty id on either side answers as before: a request or a record with nothing to
        /// identify a viewer is no worse off than it was before this check existed.
        /// </summary>
        public static string SessionJson(string playSessionId, string requestingUserId)
        {
            var record = UpscaleEngine.ForSession(playSessionId);
            if (record != null
                && !string.IsNullOrEmpty(record.UserId)
                && !string.IsNullOrEmpty(requestingUserId)
                && !string.Equals(record.UserId, requestingUserId, StringComparison.OrdinalIgnoreCase))
            {
                record = null;
            }

            if (record == null)
            {
                return JsonSerializer.Serialize(new Dictionary<string, object>
                {
                    ["PatchActive"] = UpscalePatches.Active,
                    ["Known"] = false,
                    ["UpscaleApplied"] = false,
                    ["DeblurApplied"] = false,
                    ["DenoiseApplied"] = false,
                    ["DenoiseLevel"] = "off",
                    ["DeblockLevel"] = "off",
                    ["DeblockApplied"] = false,
                    ["DeblockRequested"] = "off",
                    ["NeuralLevel"] = "off",
                    ["NeuralApplied"] = false,
                    ["NeuralRequested"] = "off",
                    ["SourceWidth"] = 0,
                    ["SourceHeight"] = 0,
                    ["OutputWidth"] = 0,
                    ["OutputHeight"] = 0,
                    ["GameLevel"] = "off",
                    ["DebandApplied"] = false,
                    ["SrLevel"] = "off",
                    ["RefineLevel"] = "off",
                    ["ChromaLevel"] = "off",
                    ["SrBypassed"] = false,
                    ["Encoder"] = null,
                    ["Status"] = UpscalePatches.Active ? "unknown" : "patches-inactive",
                    ["Summary"] = UpscalePatches.Active ? "No enhancement" : "Enhancement unavailable",
                    ["Levels"] = Levels(),
                });
            }

            return JsonSerializer.Serialize(new Dictionary<string, object>
            {
                ["PatchActive"] = UpscalePatches.Active,
                ["Known"] = true,
                ["Record"] = record,
                ["UpscaleApplied"] = record.UpscaleApplied,
                ["DeblurApplied"] = record.DeblurApplied,
                ["DenoiseApplied"] = record.DenoiseApplied,
                ["DenoiseLevel"] = record.DenoiseLevel ?? "off",
                ["DeblockLevel"] = record.DeblockLevel ?? "off",
                ["DeblockApplied"] = record.DeblockApplied,
                ["DeblockRequested"] = record.DeblockRequested ?? "off",
                ["NeuralLevel"] = record.NeuralLevel ?? "off",
                // Applied and requested both, so the panel can say "asked for, did not run" instead
                // of showing a dropped network exactly like one nobody selected.
                ["NeuralApplied"] = record.NeuralApplied,
                ["NeuralRequested"] = record.NeuralRequested ?? "off",
                // Flat, not only nested in Record: these four are the single end-to-end proof that
                // the size axis did anything, and the panel cannot reach them where they are.
                ["SourceWidth"] = record.SourceWidth,
                ["SourceHeight"] = record.SourceHeight,
                ["OutputWidth"] = record.OutputWidth,
                ["OutputHeight"] = record.OutputHeight,
                ["GameLevel"] = record.GameLevel ?? "off",
                ["GameApplied"] = record.GameApplied,
                ["GameJitter"] = record.GameJitter,
                ["GameDepth"] = record.GameDepth,
                ["GameReactive"] = record.GameReactive,
                ["GameDepthDowngraded"] = record.GameDepthDowngraded,
                ["DebandApplied"] = record.DebandApplied,
                ["SrLevel"] = record.SrLevel ?? "off",
                ["RefineLevel"] = record.RefineLevel ?? "off",
                ["RefineApplied"] = record.RefineApplied,
                ["ChromaLevel"] = record.ChromaLevel ?? "off",
                ["ChromaApplied"] = record.ChromaApplied,
                ["SrRequested"] = record.SrRequested ?? "off",
                ["SrBypassed"] = record.SrBypassed,
                ["SrOwnsSharpening"] = record.SrOwnsSharpening,
                ["Upscaler"] = record.Upscaler,
                ["DeblurLevel"] = record.DeblurLevel ?? "off",
                // Levels are deliberately NOT here. The panel polls this record every three
                // seconds while it is open, and the level lists change only on a config change or
                // an install, so re-serialising the whole set into every response was several
                // kilobytes a poll, per open panel, to say the same thing. The no-record branch
                // above still serves them, and that is the branch the probe takes.
                ["Encoder"] = record.Encoder,
                ["EncoderReason"] = record.EncoderReason,
                ["Status"] = record.Status,
                ["Summary"] = record.Summary,
            });
        }
    }
}
