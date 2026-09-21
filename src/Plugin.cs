using System;
using System.Collections.Generic;
using System.Globalization;
using Jellyfin.Plugin.GpuUpscale.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.GpuUpscale
{
    /// <summary>
    /// Realtime GPU super-resolution upscaling for Jellyfin transcodes, via libplacebo and a GLSL shader.
    /// </summary>
    public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
    {
        private readonly ILogger<Plugin> _logger;

        public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer, ILogger<Plugin> logger)
            : base(applicationPaths, xmlSerializer)
        {
            Instance = this;
            _logger = logger;

            PatcherLoader.Load(logger, Configuration);
            ShimBridge.Sync(Configuration, PatcherLoader.Active, logger);
            logger?.LogInformation("GpuUpscale: {Status}", PatcherLoader.Status);
        }

        public static Plugin Instance { get; private set; }

        public override string Name => "GPU Upscale";

        public override Guid Id => Guid.Parse("6f2a9c31-4d7b-4e2a-9d15-8a1c0b7e3f44");

        public override string Description => "Realtime GPU super-resolution upscaling of transcodes using libplacebo and a GLSL shader.";

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
                "GpuUpscale: configuration updated (enabled={Enabled}, target={Target}p)",
                Configuration.Enabled,
                Configuration.TargetHeight);
        }
    }
}
