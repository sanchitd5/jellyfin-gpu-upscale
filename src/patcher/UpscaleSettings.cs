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

        /// <summary>
        /// Run the super-resolution network only when the output is at least this multiple of the
        /// source. Below it the upscale still happens, with plain ewa_lanczos plus whatever
        /// sharpening the session asked for, and the GPU cost of the network is not spent.
        ///
        /// WHY 1.60, MEASURED, NOT GUESSED. Both shipped SR networks are fixed-2x: below 2x
        /// libplacebo shrinks their output back down, and the further below 2x the less of the
        /// network survives. Against a clean ground truth (720p GT, LR by lanczos downscale, 100
        /// frames), FSRCNNX against plain ewa_lanczos:
        ///
        ///   ratio   PSNR gain    detail energy vs plain   (ground truth detail = 3.5179)
        ///   1.41    +0.041 dB    3.2721 vs 3.3445   -2.2%   network LOSES detail
        ///   1.50    +0.079 dB    3.2726 vs 3.2822   -0.3%   break-even
        ///   1.70    +0.306 dB    3.2481 vs 3.1355   +3.6%   network earns its pass
        ///   1.90    +0.480 dB    3.2140 vs 2.9982   +7.2%
        ///   2.00    +0.181 dB    3.5158 vs 2.9466  +19.3%
        ///
        /// The detail crossover is at about 1.52. The network costs ~15% of throughput at 1080p
        /// out, so at 1.5x - which is exactly 720p to 1080p, a large share of real sessions - it
        /// was being paid for a result inside measurement noise. 1.60 puts the threshold on the
        /// far side of the crossover rather than on top of it.
        ///
        /// What fills the gap is the sharpener, not a bigger network: at 1.5x, plain scaling plus
        /// RCAS-2.0 ("low") measured detail energy 3.5950 against a ground truth of 3.5179, where
        /// FSRCNNX alone managed 3.2726 - nearer the truth, for about 1% of the throughput
        /// instead of 15%.
        ///
        /// Snapping the target height up so the ratio lands nearer 2x was measured as the
        /// alternative and is worse on every axis: from a 1.5x source, FSRCNNX to 2x then shrunk
        /// to the requested size scored PSNR 43.547 / SSIM 0.98584 / detail 3.4420, against
        /// 43.668 / 0.98579 / 3.4981 for FSRCNNX+RCAS straight to the requested size - and it
        /// ships 78% more pixels to do it.
        ///
        /// Set to 0 (or anything at or below 1) to disable the bypass and always run the network.
        /// </summary>
        public double SrMinScaleFactor { get; set; } = 1.60;

        public int MaxSourceHeight { get; set; } = 1440;

        public int MaxConcurrent { get; set; } = 4;

        /// <summary>
        /// Hand the libplacebo output to NVENC as a CUDA frame (hwmap=derive_device=cuda) instead
        /// of hwdownload,format=yuv420p. Off by default: needs the patched binary's Vulkan-CUDA
        /// interop confirmed on the server before it can be trusted on a live session.
        /// </summary>
        public bool GpuResidentEncode { get; set; }

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
        /// Turn direct play off for anything this plugin would enhance, so a transcode exists for
        /// the chain to run in. OFF by default: it is the difference between "enhance the sessions
        /// that were transcoding anyway" and "transcode almost everything, on every client".
        /// </summary>
        public bool ForceTranscodeForDirectPlay { get; set; }

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
        /// Denoise applied by default: off, light (atadenoise), strong and max (nlmeans_vulkan).
        /// Off by default - it costs real throughput and whether it helps is a matter for the eye.
        ///
        /// The Vulkan levels compile their shader at run time, so whether they work depends on the
        /// binary a session routes to rather than on this setting. A session needing both a Vulkan
        /// denoise and a filter only the patched ffmpeg carries has the denoise dropped and
        /// reported, because on a build with an older shaderc it would otherwise fail the whole
        /// transcode. See the denoise table in ShaderLibrary for what that cost.
        /// </summary>
        public string DenoiseLevel { get; set; } = "off";

        /// <summary>Master switch for denoise. When false no session can turn it on.</summary>
        public bool DenoiseAllowed { get; set; } = true;

        /// <summary>
        /// Deblocking applied by default: off, light, strong (libavfilter deblock), fspp, pp7
        /// (libpostproc). NOT another denoiser. Denoise removes noise the camera put there;
        /// this removes what the encoder put there, the DCT block edges and the mosquito ringing
        /// of the source's own compression, and it runs at source resolution ahead of any
        /// super-resolution pass. Every network in this plugin was trained on clean downsampled
        /// images, so an unhandled block edge is reconstructed as though it were real detail and
        /// the artefact is sharpened along with the picture.
        ///
        /// light and strong address blocking only. fspp and pp7 also deringe, and cost more for it.
        ///
        /// Off by default because none of these strengths has been measured on this content yet,
        /// which is this project's rule for anything unmeasured.
        /// </summary>
        public string DeblockLevel { get; set; } = "off";

        /// <summary>Master switch for deblocking. When false no session can turn it on.</summary>
        public bool DeblockAllowed { get; set; } = true;

        /// <summary>
        /// Neural super-resolution applied by default: off, realesr-anime-x2, realesr-anime-x4,
        /// realesr-general-x4. A separate axis from SrLevel - it is an ONNX network run ahead of
        /// the scaling pass, not a libplacebo shader inside it, and the two compose.
        ///
        /// Off by default and it should stay off: measured at 24, 15 and 10 fps respectively on a
        /// 540p source at a 1080p target, against 265 fps with it off. None of them reaches
        /// realtime for one session. It is offered, not recommended.
        ///
        /// vsr (NVIDIA Maxine Video Super Resolution) shares this axis's plumbing but is not a
        /// selectable value yet - ShaderLibrary.VsrOffered gates it off pending a fix to a
        /// NvVFX_Load hang. See VSR.md.
        /// </summary>
        public string NeuralLevel { get; set; } = "off";

        /// <summary>Master switch for neural super-resolution. When false no session can turn it on.</summary>
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
        /// Post-scale refinement applied by default: off, ssimsuperres. A separate axis from
        /// SrLevel - it hooks POSTKERNEL and composes with every SR level rather than replacing
        /// one, and it is not subject to SrMinScaleFactor. Off by default: it costs a pass and
        /// nothing here has measured whether it is worth one on this content.
        /// </summary>
        public string RefineLevel { get; set; } = "off";

        /// <summary>Master switch for post-scale refinement. When false no session can turn it on.</summary>
        public bool RefineAllowed { get; set; } = true;

        /// <summary>
        /// Chroma upscaling applied by default: off, krigbilateral. Also a separate axis: it
        /// hooks CHROMA, so it touches planes no other level here touches and composes with all
        /// of them. Off by default, for the same reason.
        /// </summary>
        public string ChromaLevel { get; set; } = "off";

        /// <summary>Master switch for chroma upscaling. When false no session can turn it on.</summary>
        public bool ChromaAllowed { get; set; } = true;

        /// <summary>
        /// libplacebo debanding. Measured within run-to-run variance of free, and low-bitrate
        /// webcam h264 bands visibly in dark gradients. Grain is forced to 0: libplacebo's default
        /// of 6 adds synthetic grain, which is wrong for this content.
        /// </summary>
        public bool Deband { get; set; } = true;

        /// <summary>
        /// How hard the deband pass cuts, in libplacebo's threshold units. Higher removes more
        /// banding and costs real gradient detail with it; the pass itself costs the same either way.
        /// </summary>
        public int DebandThreshold { get; set; } = 3;

        /// <summary>
        /// Grain added back after debanding. 0 on purpose: libplacebo's own default of 6 adds
        /// synthetic grain, which is wrong for this content.
        /// </summary>
        public int DebandGrain { get; set; }

        /// <summary>Where the shader files live.</summary>
        public string ShaderDirectory { get; set; } = "/usr/share/jellyfin-shaders";

        /// <summary>Where composed shader files (super-resolution + sharpening) are cached.</summary>
        public string ShaderCacheDirectory { get; set; } = "/var/cache/jellyfin/gpu-upscale-shaders";

        /// <summary>
        /// Where the Real-ESRGAN ONNX weights live. They belong to the patched binary, not to the
        /// shader directory, and they are not shipped: a level whose file is absent is not offered.
        /// </summary>
        public string NeuralModelDirectory { get; set; } = "/usr/lib/jellyfin-ffmpeg-oidn/models";

        /// <summary>
        /// Where the NVIDIA DLSS runtime has to be installed. Nothing from NVIDIA ships with this
        /// plugin, so until the operator fetches it the dlss and dlaa levels are not offered.
        /// </summary>
        public string DlssRuntimeDirectory { get; set; } = "/usr/lib/jellyfin-ffmpeg-oidn/dlss";

        /// <summary>
        /// The monocular depth ONNX model the game upscalers are fed in place of a depth buffer.
        /// Not shipped either; without it those levels have only a flat plane to work from.
        /// </summary>
        public string DepthModelPath { get; set; } = "/usr/lib/jellyfin-ffmpeg-oidn/models/depth_anything_v2_vits.onnx";

        /// <summary>
        /// Where nvdlppx.dll (RTX DLPP) has to be installed for the dlpp-1..dlpp-4 neural levels
        /// to be offered. NOTHING from NVIDIA ships with this plugin: the operator fetches the DLL
        /// themselves from a driver package. See RTXDLPP.md. Same trust boundary as
        /// DlssRuntimeDirectory above.
        /// </summary>
        public string RtxDlppDllPath { get; set; } = "/usr/lib/jellyfin-ffmpeg-oidn/rtxdlpp/dll/nvdlppx.dll";

        /// <summary>
        /// Where nvaivpx.dll (RTX VSR / AIVP) has to be installed for the vsr-rtcuda neural level
        /// to be offered. Same trust boundary as RtxDlppDllPath above. See RTXVSR.md.
        /// </summary>
        public string RtxVsrDllPath { get; set; } = "/usr/lib/jellyfin-ffmpeg-oidn/rtxvsr/dll/nvaivpx.dll";
    }
}
