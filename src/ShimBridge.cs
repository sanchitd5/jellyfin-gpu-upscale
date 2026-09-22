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
                // The name is unique per call because a fixed one is shared state: a config save
                // and a startup sync running together would write the same temp file and could
                // rename a half-written interleave, which is the very thing the rename removes.
                // Writing beside the file and renaming is atomic, so the shim can never read a
                // half-written config. But it needs permission to CREATE a file in that directory,
                // which is a different thing from permission to write the config itself: the config
                // is owned by the service user while /etc is owned by root, so the rename path fails
                // on the standard install and a plain overwrite succeeds. Preferring the rename and
                // falling back keeps the atomicity wherever the directory allows it, and keeps the
                // setting reaching the shim where it does not. The alternative, reporting success
                // while every dashboard change was silently dropped, is what this cost before.
                string temp = ConfigPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
                bool renamed = false;
                try
                {
                    File.WriteAllText(temp, json);

                    // The rename replaces the inode, so without this the shim's config would take
                    // this process's umask instead of the mode it was installed with. Only the mode
                    // travels: owner and group are not settable from .NET, so a config owned by
                    // another user ends up owned by Jellyfin.
                    if (OperatingSystem.IsLinux())
                    {
                        File.SetUnixFileMode(temp, File.GetUnixFileMode(ConfigPath));
                    }

                    File.Move(temp, ConfigPath, true);
                    renamed = true;
                }
                catch (Exception ex) when (ex is UnauthorizedAccessException || ex is IOException)
                {
                    try
                    {
                        File.Delete(temp);
                    }
                    catch (Exception)
                    {
                        // A failed sync must not also leave litter, but it is not worth a second failure.
                    }

                    // Not atomic, and the shim's own loader has to tolerate a torn read, which it
                    // does: a config that does not parse makes it stand down rather than guess.
                    File.WriteAllText(ConfigPath, json);
                }

                LastResult = renamed
                    ? "synced (shim standing down: " + patchActive + ")"
                    : "synced in place, no permission to write a temp file beside " + ConfigPath
                        + " (shim standing down: " + patchActive + ")";
            }
            catch (Exception ex)
            {
                LastResult = "sync failed: " + ex.Message;
                logger?.LogWarning(ex, "GpuUpscale: could not sync the ffmpeg shim config at {Path}", ConfigPath);
            }
        }
    }
}
