using System;
using System.IO;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using Jellyfin.Plugin.GpuUpscale.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.GpuUpscale
{
    /// <summary>
    /// Loads the Harmony patch assembly into the default (non-collectible) assembly load context
    /// and talks to it by reflection.
    ///
    /// Jellyfin loads plugins into a collectible <see cref="AssemblyLoadContext"/>, and Harmony
    /// cannot emit its detour stubs against a collectible assembly ("Resolving to a collectible
    /// assembly is not supported"). The patch code therefore lives outside the plugin directory,
    /// in <c>/usr/lib/jellyfin-gpuupscale</c>, so Jellyfin's plugin loader never sees it and it is
    /// loaded into the default context instead.
    /// </summary>
    internal static class PatcherLoader
    {
        public const string PatcherDirectory = "/usr/lib/jellyfin-gpuupscale";

        private static Type _host;

        // Written on the load path and read from request threads serving the dashboard, so the
        // backing fields are volatile: a property cannot be.
        private static volatile string _status = "patcher not loaded";

        private static volatile bool _active;

        private static ILogger _logger;

        public static string Status
        {
            get => _status;
            private set => _status = value;
        }

        public static bool Active
        {
            get => _active;
            private set => _active = value;
        }

        public static void Load(ILogger logger, PluginConfiguration configuration)
        {
            _logger = logger ?? _logger;

            if (_host != null)
            {
                Configure(configuration);
                return;
            }

            try
            {
                string harmony = Path.Combine(PatcherDirectory, "0Harmony.dll");
                string patcher = Path.Combine(PatcherDirectory, "Jellyfin.Plugin.GpuUpscale.Patcher.dll");
                if (!File.Exists(harmony) || !File.Exists(patcher))
                {
                    Status = "patcher assembly missing from " + PatcherDirectory;
                    logger?.LogError("GpuUpscale: {Status}", Status);
                    return;
                }

                AssemblyLoadContext.Default.LoadFromAssemblyPath(harmony);
                Assembly asm = AssemblyLoadContext.Default.LoadFromAssemblyPath(patcher);
                _host = asm.GetType("Jellyfin.Plugin.GpuUpscale.Patcher.PatcherHost");
                if (_host == null)
                {
                    Status = "PatcherHost type not found";
                    return;
                }

                Status = (string)_host.GetMethod("Apply", BindingFlags.Public | BindingFlags.Static)
                    .Invoke(null, new object[] { logger, Serialize(configuration) });
                Active = (bool)_host.GetMethod("IsActive", BindingFlags.Public | BindingFlags.Static).Invoke(null, null);
            }
            catch (Exception ex)
            {
                Status = "patcher load failed: " + (ex.InnerException ?? ex).Message;
                Active = false;
                _host = null;
                logger?.LogError(ex, "GpuUpscale: loading the patch assembly failed; Jellyfin will transcode normally.");
            }
        }

        public static void Configure(PluginConfiguration configuration)
        {
            try
            {
                _host?.GetMethod("Configure", BindingFlags.Public | BindingFlags.Static)
                    .Invoke(null, new object[] { Serialize(configuration) });
            }
            catch (Exception ex)
            {
                // The running patches keep their previous settings, which means the dashboard is
                // now reporting settings the patcher never received. Say so rather than leaving
                // that divergence invisible.
                _logger?.LogWarning(ex, "GpuUpscale: pushing the configuration to the patcher failed; the running patches keep their previous settings.");
            }
        }

        public static string SessionJson(string playSessionId, string requestingUserId)
        {
            try
            {
                if (_host != null)
                {
                    // Prefer the 2-arg overload that can refuse another viewer's session; fall back
                    // to the 1-arg one when the loaded patcher predates it, so a half-applied deploy
                    // (new plugin DLL, old patcher assembly still on disk) degrades to the old
                    // behaviour instead of throwing.
                    MethodInfo method = _host.GetMethod("SessionJson", new[] { typeof(string), typeof(string) });
                    if (method != null)
                    {
                        return (string)method.Invoke(null, new object[] { playSessionId, requestingUserId });
                    }

                    return (string)_host.GetMethod("SessionJson", new[] { typeof(string) })
                        .Invoke(null, new object[] { playSessionId });
                }
            }
            catch (Exception)
            {
                // fall through
            }

            return JsonSerializer.Serialize(new { PatchActive = false, Known = false, UpscaleApplied = false, DeblurApplied = false, Status = "patches-inactive", Summary = "Enhancement unavailable" });
        }

        public static string StatusJson()
        {
            try
            {
                if (_host != null)
                {
                    return (string)_host.GetMethod("StatusJson", BindingFlags.Public | BindingFlags.Static).Invoke(null, null);
                }
            }
            catch (Exception)
            {
                // fall through to the local status
            }

            return JsonSerializer.Serialize(new { PatchActive = false, PatchStatus = Status, Sessions = Array.Empty<object>() });
        }

        private static string Serialize(PluginConfiguration configuration) => JsonSerializer.Serialize(configuration);
    }
}
