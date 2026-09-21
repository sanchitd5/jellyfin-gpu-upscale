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
                    ["Encoder"] = null,
                    ["Status"] = UpscalePatches.Active ? "unknown" : "patches-inactive",
                    ["Summary"] = UpscalePatches.Active ? "No enhancement" : "Enhancement unavailable",
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
                ["DeblurLevel"] = record.DeblurLevel ?? "off",
                ["Encoder"] = record.Encoder,
                ["EncoderReason"] = record.EncoderReason,
                ["Status"] = record.Status,
                ["Summary"] = record.Summary,
            });
        }
    }
}
