using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using Jellyfin.Plugin.Plus.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Plus
{
    /// <summary>
    /// Jellyfin Plus: realtime GPU super-resolution upscaling for transcodes (libplacebo and a GLSL shader), plus search and library-filter improvements.
    /// </summary>
    public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
    {
        private readonly ILogger<Plugin> _logger;

        public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer, ILogger<Plugin> logger)
            : base(applicationPaths, xmlSerializer)
        {
            Instance = this;
            _logger = logger;

            MigrateLegacySettings(logger);
            PatcherLoader.Load(logger, Configuration);
            ShimBridge.Sync(Configuration, PatcherLoader.Active, logger);
            logger?.LogInformation("JellyfinPlus: {Status}", PatcherLoader.Status);
        }

        public static Plugin Instance { get; private set; }

        /// <summary>
        /// One-time carry-over from the pre-rename plugin. Jellyfin names the settings file after the
        /// assembly, so the rename to Jellyfin.Plugin.Plus would otherwise start from defaults.
        /// BasePlugin loads the configuration lazily on the first <c>Configuration</c> access, so this
        /// must run before that access in the constructor. Never overwrites an existing new file.
        /// </summary>
        private void MigrateLegacySettings(ILogger logger)
        {
            try
            {
                string current = ConfigurationFilePath;
                string legacy = Path.Combine(Path.GetDirectoryName(current), "Jellyfin.Plugin.GpuUpscale.xml");
                if (!File.Exists(current) && File.Exists(legacy))
                {
                    File.Copy(legacy, current);
                    logger?.LogInformation("JellyfinPlus: migrated settings from {Legacy} to {Current}", legacy, current);
                }

                // The old default cache dir is saved verbatim in migrated settings; point it at the
                // renamed one (in memory; persisted on the next settings save).
                if (string.Equals(Configuration.ShaderCacheDirectory, LegacyShaderCache, StringComparison.Ordinal))
                {
                    Configuration.ShaderCacheDirectory = new PluginConfiguration().ShaderCacheDirectory;
                }
            }
            catch (Exception ex)
            {
                logger?.LogWarning(ex, "JellyfinPlus: settings migration failed; continuing with whatever configuration loads.");
            }
        }

        private const string LegacyShaderCache = "/var/cache/jellyfin/gpu-upscale-shaders";

        public override string Name => "Jellyfin Plus";

        public override Guid Id => Guid.Parse("6f2a9c31-4d7b-4e2a-9d15-8a1c0b7e3f44");

        /// <summary>One-line summary, used as meta.json "overview" (catalogue / plugin card).</summary>
        public const string Overview = "GPU video enhancement plus search, filtering and library quality-of-life improvements for Jellyfin.";

        /// <summary>
        /// Shown on the dashboard's plugin page as plain text (line breaks collapse to spaces, so each
        /// section leads with its own label). Keep it accurate
        /// to what ships: ENHANCEMENTS.md is the full list.
        /// </summary>
        public override string Description => DescriptionText;

        /// <summary>The same text goes into meta.json (scripts/proxmox-build.sh), which is what the page reads.</summary>
        internal const string DescriptionText =
            "GPU video enhancement and better search and browsing for Jellyfin. "
            + "Enhancement: real-time upscaling, denoise, unblur, deblock, deband and more, applied inside the transcode "
            + "and picked per playback from the player's Enhance panel; your files are never changed. "
            + "Search and library: tag-aware search with wildcards and exclusions, a Sort & filter sheet, quick and smart "
            + "tag filters, a date-added filter, infinite scroll, More Like This, bulk tag editing and card badges. "
            + "Every part falls back to stock Jellyfin if it cannot apply. Options: the Settings button. "
            + "Full list: ENHANCEMENTS.md at github.com/sanchitd5/jellyfin-plus.";

        public IEnumerable<PluginPageInfo> GetPages()
        {
            yield return new PluginPageInfo
            {
                Name = Name,
                EmbeddedResourcePath = string.Format(CultureInfo.InvariantCulture, "{0}.Configuration.configPage.html", GetType().Namespace),
            };
        }

        public override void UpdateConfiguration(BasePluginConfiguration configuration)
        {
            base.UpdateConfiguration(configuration);
            PatcherLoader.Configure(Configuration);
            ShimBridge.Sync(Configuration, PatcherLoader.Active, _logger);
            _logger?.LogInformation(
                "JellyfinPlus: configuration updated (enabled={Enabled}, target={Target}p)",
                Configuration.Enabled,
                Configuration.TargetHeight);
        }
    }
}
