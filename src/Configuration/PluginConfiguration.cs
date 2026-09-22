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

        /// <summary>
        /// Deblocking used when a session does not name one: off, light, strong, fspp, pp7.
        /// Not a denoiser: it removes the source's OWN compression artefacts, DCT block edges and
        /// mosquito ringing, at source resolution before any super-resolution pass, because every
        /// network here was trained on clean downsampled images and rebuilds a block edge as if it
        /// were real detail. light and strong are libavfilter deblock and treat blocking only;
        /// fspp and pp7 are libpostproc and deringe as well, for more cost. Off by default because
        /// no strength has been measured on this content yet.
        /// </summary>
        public string DeblockLevel { get; set; } = "off";

        /// <summary>Master switch for deblocking. When false, no session can turn it on.</summary>
        public bool DeblockAllowed { get; set; } = true;

        /// <summary>
        /// Neural super-resolution used when a session does not name one: off, realesr-anime-x2,
        /// realesr-anime-x4, realesr-general-x4. Advanced and off by default - every one of them
        /// is far below realtime on this hardware. A fifth level, vsr (NVIDIA Maxine Video Super
        /// Resolution), exists in the plumbing but is withheld by ShaderLibrary.VsrOffered until
        /// a hang in NvVFX_Load is fixed - see VSR.md. Not selectable by naming it here.
        /// </summary>
        public string NeuralLevel { get; set; } = "off";

        /// <summary>Master switch for neural super-resolution.</summary>
        public bool NeuralAllowed { get; set; } = true;

        /// <summary>
        /// Game temporal upscaler applied by default: off, fsr2, dlss, dlaa. OFF, and it stays
        /// off: these are renderer algorithms fed inputs recorded video cannot supply. See the
        /// block above ShaderLibrary._gameFilters.
        /// </summary>
        public string GameLevel { get; set; } = "off";

        /// <summary>May a session ask for a game temporal upscaler at all?</summary>
        public bool GameAllowed { get; set; } = true;

        /// <summary>How jitter is supplied: measured, cancel, zero, halton.</summary>
        public string GameJitter { get; set; } = "measured";

        /// <summary>How depth is supplied: model, model-stable, flat.</summary>
        public string GameDepth { get; set; } = "model";

        /// <summary>How the reactive mask is supplied: flow, none.</summary>
        public string GameReactive { get; set; } = "flow";

        /// <summary>
        /// Post-scale refinement used when a session does not name one: off, ssimsuperres.
        /// Composes with any super-resolution level instead of replacing one.
        /// </summary>
        public string RefineLevel { get; set; } = "off";

        /// <summary>May a session ask for post-scale refinement at all?</summary>
        public bool RefineAllowed { get; set; } = true;

        /// <summary>
        /// Chroma upscaling used when a session does not name one: off, krigbilateral.
        /// Composes with any super-resolution level instead of replacing one.
        /// </summary>
        public string ChromaLevel { get; set; } = "off";

        /// <summary>May a session ask for chroma upscaling at all?</summary>
        public bool ChromaAllowed { get; set; } = true;

        /// <summary>libplacebo debanding, with synthetic grain forced off.</summary>
        public bool Deband { get; set; } = true;

        /// <summary>How hard debanding cuts. Higher smooths more banding and more real gradient with it.</summary>
        public int DebandThreshold { get; set; } = 3;

        /// <summary>
        /// Grain added back after debanding. 0 on purpose: libplacebo's own default of 6 adds
        /// synthetic grain, which is wrong for this content.
        /// </summary>
        public int DebandGrain { get; set; }

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
        /// Hand the libplacebo output to NVENC as a CUDA frame (hwmap=derive_device=cuda) instead
        /// of hwdownload,format=yuv420p, skipping the Vulkan-to-system-memory-to-CUDA round trip
        /// at output size. Off by default: it needs the patched binary's Vulkan-CUDA interop
        /// confirmed on the server before it can be trusted on a live session - see improvements.md.
        /// </summary>
        public bool GpuResidentEncode { get; set; }

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

        /// <summary>
        /// Where the Real-ESRGAN ONNX weights live. They are not shipped with this plugin; a
        /// neural level whose file is missing is not offered at all.
        /// </summary>
        public string NeuralModelDirectory { get; set; } = "/usr/lib/jellyfin-ffmpeg-oidn/models";

        /// <summary>
        /// Where the NVIDIA DLSS runtime lives. Nothing from NVIDIA ships with this plugin, so
        /// until the operator puts it here the dlss and dlaa levels are not offered.
        /// </summary>
        public string DlssRuntimeDirectory { get; set; } = "/usr/lib/jellyfin-ffmpeg-oidn/dlss";

        /// <summary>
        /// The monocular depth ONNX model the game upscalers are fed instead of a depth buffer.
        /// Not shipped either; without it those levels fall back to a flat plane.
        /// </summary>
        public string DepthModelPath { get; set; } = "/usr/lib/jellyfin-ffmpeg-oidn/models/depth_anything_v2_vits.onnx";
    }
}
