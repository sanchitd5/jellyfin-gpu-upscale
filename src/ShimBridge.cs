using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using Jellyfin.Plugin.GpuUpscale.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.GpuUpscale
{
    /// <summary>
    /// Keeps the pre-existing ffmpeg shim (/usr/local/bin/jellyfin-ffmpeg-upscale) in step with the
    /// plugin. While the Harmony patches are live the shim is told to stand down, so the two never
    /// both rewrite the same command; if patching ever fails the shim takes over with the plugin's
    /// settings and upscaling keeps working.
    /// </summary>
    internal static class ShimBridge
    {
        public const string ConfigPath = "/etc/jellyfin-upscale.json";

        public static string LastResult { get; private set; } = "not written";

        public static void Sync(PluginConfiguration cfg, bool patchActive, ILogger logger)
        {
            try
            {
                if (!File.Exists(ConfigPath))
                {
                    LastResult = "shim config not present; nothing to sync";
                    return;
                }

                Dictionary<string, JsonElement> existing;
                try
                {
                    existing = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(File.ReadAllText(ConfigPath))
                               ?? new Dictionary<string, JsonElement>();
                }
                catch (Exception)
                {
                    existing = new Dictionary<string, JsonElement>();
                }

                var merged = new Dictionary<string, object>();
                foreach (var kv in existing)
                {
                    merged[kv.Key] = kv.Value;
                }

                merged["plugin_patch_active"] = patchActive;
                merged["enabled"] = cfg.Enabled;
                merged["shader"] = (cfg.ShaderDirectory ?? string.Empty).TrimEnd('/') + "/FSRCNNX_x2_16-0-4-1.glsl";
                merged["upscaler"] = cfg.Upscaler ?? "ewa_lanczos";
                merged["encoder"] = cfg.Encoder ?? "hevc_nvenc";
                merged["min_scale_factor"] = cfg.MinScaleFactor;
                merged["max_target_height"] = cfg.MaxTargetHeight;
                merged["max_source_height"] = cfg.MaxSourceHeight;
                merged["max_concurrent"] = cfg.MaxConcurrent;
                merged["default_target_height"] = cfg.TargetHeight;

                string json = JsonSerializer.Serialize(merged, new JsonSerializerOptions { WriteIndented = true });

                // The shim reads this file on every transcode, so it must never be observed
                // half-written: write beside it and rename, which is atomic on the same filesystem.
                string temp = ConfigPath + ".tmp";
                File.WriteAllText(temp, json);
                File.Move(temp, ConfigPath, true);
                LastResult = "synced (shim standing down: " + patchActive + ")";
            }
            catch (Exception ex)
            {
                LastResult = "sync failed: " + ex.Message;
                logger?.LogWarning(ex, "GpuUpscale: could not sync the ffmpeg shim config at {Path}", ConfigPath);
            }
        }
    }
}
