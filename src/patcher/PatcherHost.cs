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
        private static Dictionary<string, object> Levels()
        {
            var cfg = UpscaleEngine.Settings;
            return new Dictionary<string, object>
            {
                ["Sr"] = ShaderLibrary.AvailableSrLevels(cfg),
                ["Deblur"] = ShaderLibrary.AvailableDeblurLevels(cfg),
                ["Denoise"] = ShaderLibrary.AvailableDenoiseLevels(),

                // Two axes of their own, not extra rungs of the SR list: the refinement pass
                // hooks POSTKERNEL and the chroma pass hooks CHROMA, so each composes with
                // whatever SR level is chosen. They are listed separately so the menu can
                // render them as separate controls rather than folding them into one list.
                ["Refine"] = ShaderLibrary.AvailableRefineLevels(cfg),
                ["Chroma"] = ShaderLibrary.AvailableChromaLevels(cfg),
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
        public static string SessionJson(string playSessionId)
        {
            var record = UpscaleEngine.ForSession(playSessionId);
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
                ["Levels"] = Levels(),
                ["Encoder"] = record.Encoder,
                ["EncoderReason"] = record.EncoderReason,
                ["Status"] = record.Status,
                ["Summary"] = record.Summary,
            });
        }
    }
}
