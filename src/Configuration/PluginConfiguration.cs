using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.GpuUpscale.Configuration
{
    /// <summary>
    /// Server-side defaults for the GPU enhancement chain.
    ///
    /// A playback session may override the upscale target, the unblur level, the super-resolution
    /// level and the denoise level individually. These settings are what applies when a session
    /// says nothing, so the features remain usable even if the injected player UI never renders.
    /// </summary>
    public class PluginConfiguration : BasePluginConfiguration
    {
        /// <summary>Master switch. When false nothing is injected and Jellyfin transcodes normally.</summary>
        public bool Enabled { get; set; } = true;

        /// <summary>Height upscaled to when a session does not name one. Width follows the source aspect.</summary>
        public int TargetHeight { get; set; } = 1080;

        /// <summary>Hard ceiling on any requested target height.</summary>
        public int MaxTargetHeight { get; set; } = 2160;

        /// <summary>
        /// Super-resolution level used when a session does not name one:
        /// off, fsrcnnx, fsrcnnx-heavy, fsrcnnx-max, anime4k-s, anime4k-m.
        /// </summary>
        public string SrLevel { get; set; } = "fsrcnnx";

        /// <summary>Unblur level used when a session does not name one: off, low, medium, high.</summary>
        public string DeblurLevel { get; set; } = "off";

        /// <summary>Master switch for unblur. When false, no session can turn it on.</summary>
        public bool DeblurAllowed { get; set; } = true;

        /// <summary>Denoise used when a session does not name one: off, light, strong.</summary>
        public string DenoiseLevel { get; set; } = "off";

        /// <summary>Master switch for denoise. When false, no session can turn it on.</summary>
        public bool DenoiseAllowed { get; set; } = true;

        /// <summary>libplacebo debanding, with synthetic grain forced off.</summary>
        public bool Deband { get; set; } = true;

        /// <summary>libplacebo upscaler kernel used underneath the shaders.</summary>
        public string Upscaler { get; set; } = "ewa_lanczos";

        /// <summary>Skip upscaling unless the target height is at least this multiple of the source.</summary>
        public double MinScaleFactor { get; set; } = 1.15;

        /// <summary>
        /// Run the super-resolution network only at or above this ratio. Below it the upscale
        /// still happens with plain scaling plus sharpening. Measured crossover is about 1.52; see
        /// UpscaleSettings.SrMinScaleFactor for the numbers. 0 disables the bypass.
        /// </summary>
        public double SrMinScaleFactor { get; set; } = 1.60;

        /// <summary>Never upscale sources taller than this.</summary>
        public int MaxSourceHeight { get; set; } = 1440;

        /// <summary>Maximum simultaneous enhanced transcodes; past this, stock transcoding is used.</summary>
        public int MaxConcurrent { get; set; } = 4;

        /// <summary>
        /// Encoder used when this plugin forces a transcode. Blank or "auto" follows the codec the
        /// client negotiated. A named encoder applies only when ffmpeg has it and the session
        /// declared that codec playable; otherwise the client-negotiated codec is used.
        /// </summary>
        public string Encoder { get; set; } = "hevc_nvenc";

        /// <summary>Turn a would-be video stream copy into a real transcode even without a session request.</summary>
        public bool ForceTranscode { get; set; }

        /// <summary>
        /// Turn direct play off for anything this plugin would enhance, so a transcode exists for
        /// the chain to run in. Off by default; see the config page for the cost.
        /// </summary>
        public bool ForceTranscodeForDirectPlay { get; set; }

        /// <summary>Only enhance when the session asks. Off means every eligible transcode is enhanced.</summary>
        public bool RequireClientOptIn { get; set; }

        /// <summary>Where the shader files live.</summary>
        public string ShaderDirectory { get; set; } = "/usr/share/jellyfin-shaders";

        /// <summary>Where composed (super-resolution + unblur) shader files are cached.</summary>
        public string ShaderCacheDirectory { get; set; } = "/var/cache/jellyfin/gpu-upscale-shaders";
    }
}
