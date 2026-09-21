namespace Jellyfin.Plugin.GpuUpscale.Patcher
{
    /// <summary>
    /// The plugin's settings as the patcher sees them. The plugin lives in Jellyfin's collectible
    /// plugin load context and this assembly lives in the default one, so settings cross the
    /// boundary as JSON rather than as a shared type.
    ///
    /// Every one of these is a default: a playback session may override the upscale target, the
    /// deblur level, the super-resolution level and the denoise level per session (see
    /// UpscaleEngine.Plan). The defaults are what make the features work even when the injected
    /// player UI never renders.
    /// </summary>
    public class UpscaleSettings
    {
        public bool Enabled { get; set; } = true;

        public int TargetHeight { get; set; } = 1080;

        public int MaxTargetHeight { get; set; } = 2160;

        public string Upscaler { get; set; } = "ewa_lanczos";

        public double MinScaleFactor { get; set; } = 1.15;

        public int MaxSourceHeight { get; set; } = 1440;

        public int MaxConcurrent { get; set; } = 4;

        /// <summary>
        /// The encoder to use when this plugin forces a transcode. Blank or "auto" means follow the
        /// codec the client negotiated. A named encoder is used only when ffmpeg actually has it
        /// AND the session declared the corresponding codec as playable - otherwise the
        /// client-negotiated codec wins, because handing a client a codec it cannot decode is a
        /// black screen rather than a worse picture.
        /// </summary>
        public string Encoder { get; set; } = "hevc_nvenc";

        public bool ForceTranscode { get; set; }

        /// <summary>
        /// Only enhance when the session asks for it. With this off, every eligible transcode is
        /// enhanced to TargetHeight, which is what makes enhancement work without the player UI.
        /// </summary>
        public bool RequireClientOptIn { get; set; }

        /// <summary>
        /// Super-resolution level used when a session does not name one. See ShaderLibrary for the
        /// ladder: off, fsrcnnx, fsrcnnx-heavy, fsrcnnx-max, anime4k-s, anime4k-m.
        /// </summary>
        public string SrLevel { get; set; } = "fsrcnnx";

        /// <summary>Sharpening applied by default: off, low, medium, high.</summary>
        public string DeblurLevel { get; set; } = "off";

        /// <summary>Master switch for sharpening. When false no session can turn it on.</summary>
        public bool DeblurAllowed { get; set; } = true;

        /// <summary>
        /// Denoise applied by default: off, light (hqdn3d), strong (nlmeans_vulkan).
        /// Off by default - it costs real throughput and whether it helps is a matter for the eye.
        /// </summary>
        public string DenoiseLevel { get; set; } = "off";

        /// <summary>Master switch for denoise. When false no session can turn it on.</summary>
        public bool DenoiseAllowed { get; set; } = true;

        /// <summary>
        /// libplacebo debanding. Measured within run-to-run variance of free, and low-bitrate
        /// webcam h264 bands visibly in dark gradients. Grain is forced to 0: libplacebo's default
        /// of 6 adds synthetic grain, which is wrong for this content.
        /// </summary>
        public bool Deband { get; set; } = true;

        /// <summary>Where the shader files live.</summary>
        public string ShaderDirectory { get; set; } = "/usr/share/jellyfin-shaders";

        /// <summary>Where composed shader files (super-resolution + sharpening) are cached.</summary>
        public string ShaderCacheDirectory { get; set; } = "/var/cache/jellyfin/gpu-upscale-shaders";
    }
}
