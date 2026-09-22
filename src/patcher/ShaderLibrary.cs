using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace Jellyfin.Plugin.GpuUpscale.Patcher
{
    /// <summary>
    /// Resolves the viewer-facing level names to shader files, and composes a super-resolution
    /// shader with a sharpening shader into the single file libplacebo's custom_shader_path takes.
    ///
    /// An mpv user-shader file may hold several //!HOOK blocks, so concatenating the two shaders
    /// gives both passes inside one Vulkan pass. HOOK POINT, NOT FILE ORDER, DECIDES WHAT RUNS
    /// FIRST: libplacebo runs the LUMA hooks before it scales and the MAIN hooks after. FSRCNNX
    /// hooks LUMA, Anime4K hooks MAIN, and RCAS (the sharpener, since it replaced CAS) hooks LUMA.
    /// See Compose() for what each pairing therefore actually does.
    ///
    /// LEVEL NAMING. The ladder names the family and the weight rather than pretending to be a
    /// single ordered quality scale, because the two families are not rungs of one ladder - they
    /// are different networks with different trained behaviour, and which one looks right on this
    /// content is a matter for the viewer's eye, not for a benchmark.
    /// </summary>
    internal static class ShaderLibrary
    {
        /// <summary>
        /// Super-resolution levels. "off" means no shader at all.
        ///
        /// fsrcnnx        FSRCNNX_x2_8-0-4-1  - the LIGHT FSRCNNX weight, deliberately the one that
        ///                carries the plain "fsrcnnx" name. Measured HIGHER real-footage detail
        ///                (2.4398) than the 16-weight (2.3815) at roughly half the GPU cost, so it
        ///                is the honest representative of the family.
        /// fsrcnnx-heavy  FSRCNNX_x2_16-0-4-1 - the old "standard". Kept selectable, not default:
        ///                it costs about double and measured no better.
        /// fsrcnnx-max    FSRCNN_x2_r1_32-0-2 - installed and accepted by the API, not offered in
        ///                either menu; measured no better again at about twice the cost of heavy.
        /// anime4k-s      Anime4K_Upscale_CNN_x2_S - the cheap generic 2x CNN.
        /// anime4k-m      Anime4K_Upscale_CNN_x2_M - the best measured reconstruction of
        ///                ground-truth detail (-0.8% vs -4.6% for FSRCNNX) and ~30% faster.
        /// </summary>
        private static readonly Dictionary<string, string> _srFiles = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["off"] = null,
            ["fsrcnnx"] = "FSRCNNX_x2_8-0-4-1.glsl",
            ["fsrcnnx-heavy"] = "FSRCNNX_x2_16-0-4-1.glsl",
            ["fsrcnnx-max"] = "FSRCNN_x2_r1_32-0-2.glsl",
            ["anime4k-s"] = "Anime4K_Upscale_CNN_x2_S.glsl",
            ["anime4k-m"] = "Anime4K_Upscale_CNN_x2_M.glsl",

            // NVIDIA Image Scaling v1.0.2 (agyild's mpv port, MIT). An upscaler that ALSO sharpens
            // internally (its own SHARPNESS, default 0.25), which is why Resolve() drops the
            // separate sharpening pass for it rather than stacking two sharpeners into ringing.
            // It measured +13.0% detail overshoot against the ground truth on this content, so it
            // is deliberately not in any recommended preset - it is offered because the viewer can
            // judge their own material, not because it won a benchmark.
            ["nvscaler"] = "NVScaler.glsl",

            // RAVU-Zoom r3 (gather build), bjin's mpv-prescalers, LGPL-3.0-or-later. The one SR
            // level here that is NOT a fixed-2x network: it hooks LUMA with //!WIDTH OUTPUT.w /
            // //!HEIGHT OUTPUT.h, so it scales straight to the requested size at whatever ratio was
            // asked for, and its only guard is "output bigger than source in both axes". That is
            // why _srRatioAgnostic lists it and why the SrMinScaleFactor bypass - which exists
            // because a fixed-2x network gets shrunk back below ~1.5x - does not apply to it.
            ["ravu-zoom"] = "ravu-zoom-r3.glsl",

            // CuNNy, funnyplanter, LGPL-3.0. int8 dp4a builds; this GPU has native dp4a and
            // libplacebo is the Vulkan backend upstream requires for them. Fixed 2x, and they
            // carry upstream's honest 1.3x guard, so they sit under SrMinScaleFactor like FSRCNNX.
            // The SOFT family is trained to anti-alias and not to sharpen, which is the safer
            // choice next to a sharpening pass; the DS build is offered for anyone who wants its
            // denoise-and-sharpen training instead. Ordered small to large.
            ["cunny-fast"] = "CuNNy-fast-SOFT-Q.glsl",
            ["cunny"] = "CuNNy-4x16-SOFT-Q.glsl",
            ["cunny-heavy"] = "CuNNy-4x32-SOFT-Q.glsl",
            ["cunny-ds"] = "CuNNy-4x16-DS-Q.glsl",
        };

        /// <summary>
        /// SR levels that scale to the requested size themselves instead of being a fixed-2x
        /// network that libplacebo shrinks back down.
        ///
        /// SrMinScaleFactor exists for the fixed-2x case: below about 1.5x so little of a 2x
        /// network's output survives the shrink that it measured no better than plain scaling.
        /// That reasoning does not apply to a prescaler that is handed the output size directly,
        /// so bypassing one of these below the threshold would be switching off a level for a
        /// reason that is not true of it. Decide() consults this before applying the bypass.
        /// </summary>
        private static readonly HashSet<string> _srRatioAgnostic = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "ravu-zoom",
        };

        /// <summary>
        /// POST-SCALE REFINEMENT. A different axis from the SR list, not another rung of it.
        ///
        /// SSimSuperRes (Shiandow, published by igv, LGPL-3.0-or-later) hooks POSTKERNEL: it runs
        /// AFTER libplacebo's scaling kernel and adjusts the already-enlarged image so that
        /// downscaling it reproduces the source. Three consequences decided the shape of this
        /// control rather than making it an SR level:
        ///
        ///  1. It does not produce the enlargement, it corrects one, so it has nothing to replace.
        ///     Every SR level here hooks LUMA or MAIN; POSTKERNEL is a third group, so it composes
        ///     with all of them and with the RCAS/NVSharpen pass rather than competing for a slot.
        ///  2. It is ratio-agnostic, and its guard (NATIVE_CROPPED.h OUTPUT.h &lt;) fires whenever the
        ///     output is taller than the source. So it runs BELOW SrMinScaleFactor, where the
        ///     fixed-2x networks are deliberately bypassed and the chain is otherwise plain
        ///     scaling plus a sharpener. That gap is a real share of sessions (720p to 1080p is
        ///     1.5x) and this is the only thing here that fills it with more than a sharpener.
        ///  3. Making it an SR level would have made it mutually exclusive with FSRCNNX, which is
        ///     exactly the combination worth having.
        ///
        /// It is therefore its own session option ("refine"), off by default, Advanced only, and
        /// not a rung of the graded ladder - nothing here has been measured for quality.
        /// </summary>
        private static readonly Dictionary<string, string> _refineFiles = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["off"] = null,
            ["ssimsuperres"] = "SSimSuperRes.glsl",
        };

        /// <summary>
        /// CHROMA upscaling. Another axis again: every other shader in this plugin is luma-only.
        ///
        /// These sources are 4:2:0, so the chroma planes are stored at a quarter of the luma
        /// resolution and are enlarged by libplacebo's ordinary kernel while the luma plane gets a
        /// trained network. KrigBilateral (Shiandow, published by igv, LGPL-3.0-or-later) hooks
        /// CHROMA and reconstructs the chroma planes guided by the luma plane. Its guard,
        /// CHROMA.w LUMA.w &lt;, fires exactly when chroma is subsampled, so it is correct as
        /// published and nothing is stripped.
        ///
        /// It composes with any SR level rather than replacing one, which is why it has its own
        /// control instead of a place in the SR list. Off by default, Advanced only.
        /// </summary>
        private static readonly Dictionary<string, string> _chromaFiles = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["off"] = null,
            ["krigbilateral"] = "KrigBilateral.glsl",
        };

        /// <summary>
        /// Names the old ladder used, so a persisted config, a stale browser localStorage or an
        /// older client keeps working instead of silently falling back to a default.
        ///
        /// "standard" deliberately lands on the light FSRCNNX weight rather than the 16-weight it
        /// used to mean: that tier measured worse than light at double the cost, so continuing to
        /// hand it out would be spending GPU time for nothing. Anyone who actually wants the
        /// 16-weight can still ask for it by its own name, "fsrcnnx-heavy".
        /// </summary>
        private static readonly Dictionary<string, string> _srAliases = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["light"] = "fsrcnnx",
            ["standard"] = "fsrcnnx",
            ["max"] = "fsrcnnx-max",
        };

        /// <summary>
        /// Sharpening levels. "off" means no sharpening pass.
        ///
        /// These are AMD FidelityFX RCAS (FSR v1.0.2), derived at install time from agyild's
        /// MIT-licensed FSR.glsl by shaders/make-rcas.sh. RCAS replaced this project's own CAS
        /// build after measurement against a clean ground truth (720p GT, LR made by lanczos
        /// downscale, 100 frames, PSNR/SSIM plus mean |Laplacian| of luma "detail energy"):
        ///
        ///   FSRCNNX + sharpener, vs ground truth      PSNR      SSIM
        ///     1.5x   RCAS-1.7                        43.668    0.98579
        ///     1.5x   CAS-low                         43.394    0.98512
        ///     2.0x   RCAS-1.7                        41.257    0.98108
        ///     2.0x   CAS-low                         40.782    0.97924
        ///
        ///   detail energy at 2.0x, ground truth = 3.5179 (plain ewa_lanczos = 2.9466):
        ///     FSRCNNX + RCAS 2.0 / 1.7 / 1.4  ->  3.7092 / 3.7934 / 3.8827   (+5% .. +10% of GT)
        ///     FSRCNNX + CAS low / med / high  ->  4.1852 / 4.4800 / 5.7194   (+19% .. +63% of GT)
        ///
        /// RCAS is better on fidelity AND lands near the ground truth's own detail rather than
        /// far above it, which is what over-sharpening looks like in this metric. It is also
        /// close to free: RCAS hooks LUMA, so it runs at the SR shader's output size instead of
        /// the full output size the way CAS (a MAIN hook) did - measured ~0% at 1080p/1440p
        /// against CAS's 12.1% at 2160p.
        ///
        /// INVERTED SCALE - READ THIS BEFORE CHANGING THE NUMBERS.
        /// RCAS's SHARPNESS is stops of REDUCTION: 0.0 is MAXIMUM sharpening and a LARGER number
        /// is GENTLER. That is the opposite of CAS, where larger meant sharper. AMD's shader also
        /// hard-clamps the value into [0, 2], so any value above 2.0 is silently identical to 2.0
        /// - "turning it up" past RCAS-2.0 changes nothing whatsoever. Hence low -> 2.0 and
        /// high -> 1.4, and hence the file names carry the raw sharpness, not the level name.
        ///
        /// The cas-* names are the CAS family, kept reachable by the API (and by the dashboard
        /// field) as a rollback path that needs no rebuild. They are deliberately not offered in
        /// either menu. The CAS files stay installed for them.
        /// </summary>
        private static readonly Dictionary<string, string> _deblurFiles = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["off"] = null,
            ["low"] = "RCAS-2.0.glsl",
            ["medium"] = "RCAS-1.7.glsl",
            ["high"] = "RCAS-1.4.glsl",
            ["cas-low"] = "CAS-low.glsl",
            ["cas-medium"] = "CAS-medium.glsl",
            ["cas-high"] = "CAS-high.glsl",

            // NVIDIA Image Sharpening v1.0.2 (agyild's mpv port, MIT), installed with its shipped
            // //!WHEN guard removed - as published it fires ONLY at exactly 1.0x scaling, so in
            // this chain it would silently never run. Its SHARPNESS runs the normal direction
            // (larger is sharper, 0.0-1.0), unlike RCAS which is inverted.
            //
            // Measured against RCAS in the same slot, same clip, same run, 1.5x, GT detail 3.5179:
            //   FSRCNNX + RCAS-2.0      PSNR 43.714  SSIM 0.98591  detail 3.4304  300f in 1.34 s
            //   FSRCNNX + NVSharpen .25 PSNR 43.012  SSIM 0.98571  detail 3.5720  300f in 1.54 s
            //   FSRCNNX + NVSharpen .65 PSNR 40.727  SSIM 0.98409  detail 4.0118
            // NVSharpen lands detail nearer the ground truth but costs 0.70 dB of fidelity and
            // roughly ten times RCAS's GPU overhead, so RCAS keeps the default slot. NVSharpen is
            // offered anyway: it is stable, and the difference is a matter of taste on real footage.
            ["nvsharpen"] = "NVSharpen-0.25.glsl",
            ["nvsharpen-strong"] = "NVSharpen-0.65.glsl",
        };

        /// <summary>
        /// The sharpening levels worth offering a viewer, in gentle-to-strong order. The cas-*
        /// rollback names are accepted but not listed: an option that measured worse than the one
        /// beside it does not belong in a menu.
        /// </summary>
        private static readonly string[] _deblurMenu = { "off", "low", "medium", "high", "nvsharpen", "nvsharpen-strong" };

        /// <summary>
        /// Denoise levels. These are ffmpeg filter nodes, not shaders, so they carry their filter
        /// string rather than a file name. "off" means no denoise node in the chain. The ladder is
        /// ordered by MEASURED COST, cheapest first, and it changes filter FAMILY as it climbs -
        /// it is not one filter turned up.
        ///
        /// light   atadenoise. Adaptive temporal denoise, a CPU filter, and the cheap default.
        /// strong  nlmeans_vulkan at its default strength. A SPATIAL denoiser: a different kind of
        ///         filter, not simply "more" of the one below it.
        /// max     nlmeans_vulkan=s=2.0. This was "strong" before atadenoise was added; the alias
        ///         "nlmeans-strong" also reaches it.
        ///
        /// Measured, library-scale survey, stable content 720p -> 1440p on an RTX 3090, against a
        /// no-denoise bar of PSNR 41.36 / statTD flicker 0.231 / 167.5 fps:
        ///
        ///   atadenoise       41.16 (-0.20 dB)   flicker 0.161 (-30%)   124.3 fps (-26%)
        ///   nlmeans_vulkan   41.01 (-0.35 dB)   flicker 0.226 ( -2%)    59.5 fps (-64%)
        ///   hqdn3d           40.31 (-1.05 dB)   flicker 0.131 (-43%)   110.4 fps (-34%)
        ///
        /// atadenoise therefore removes far more temporal noise for less fidelity cost at 2.1x the
        /// throughput of nlmeans, which is why it takes the cheap slot instead of being stacked
        /// above it. nlmeans is NOT dropped: it is a spatial filter and attacks per-frame grain
        /// that a temporal-adaptive filter leaves alone, so it can still win on some material.
        ///
        /// CAVEAT from the same survey, and it matters. On a realistically compressed source
        /// (CRF 28 - what this plugin usually receives) flicker had already collapsed to
        /// 0.002-0.05 BEFORE any filter, and every denoiser then landed within +/-0.05 dB of the
        /// bar, because x264 has already removed the temporal noise on static content. This is a
        /// CHEAPER REPLACEMENT for nlmeans on grainy high-bitrate sources, not a new capability.
        ///
        /// DO NOT ADD tmix. It is cheap (123.4 fps, flicker 0.177) and it will keep looking like a
        /// free win, exactly as hqdn3d did. Measured on a clip with 96.2% of its pixels still,
        /// tmix3 drove temporal error from 0.038 to 0.216 and SSIM from 0.985 to 0.964 - a 1.4%
        /// moving region is enough to ghost. atadenoise on that same clip stayed at TCE 0.054 /
        /// SSIM 0.982. The adaptive filter is the safe one; a plain frame average is not, at any
        /// stability level that was measured.
        ///
        /// hqdn3d=2:1:3:3 WAS "light" and HAS BEEN RETIRED. Do not put it back because it is
        /// cheap: measured on a degraded source it recovered 0.00 dB and 12% of the structural
        /// damage, i.e. it traded noise for blur one for one and returned nothing. A denoise level
        /// that removes as much picture as it removes noise is worse than no denoise at all,
        /// because the viewer pays for it in detail and believes they gained something.
        ///
        /// ROUTING INVARIANT - read this before adding a level. DenoiseFilter() decides where the
        /// node goes by looking for "_vulkan" in the FILTER STRING, and BuildChain puts a hardware
        /// node AFTER hwupload and a CPU node BEFORE it. atadenoise is a CPU filter and carries no
        /// "_vulkan", so it lands before hwupload exactly where hqdn3d used to; both nlmeans
        /// levels land after it. A new level must keep that correspondence, or ffmpeg will be
        /// handed frames in the wrong domain and the whole job fails.
        ///
        /// oidn is a CPU filter too, and that is why it sits where atadenoise sits. OIDN 2.x has
        /// no Vulkan backend, so it cannot be handed the Vulkan frames libplacebo works on. The
        /// alternative placement - after hwupload, with hwdownload,oidn,hwupload wrapped around
        /// it - was built and measured rather than assumed: 3 runs each at 720p -> 1440p gave
        /// 42/38/36 fps on the CPU side against 39/37/34 fps through the extra round trip, about
        /// 5% and inside the run-to-run drift of a shared GPU. So the round trip is NOT expensive;
        /// the CPU side is chosen because it is simpler, it keeps one hwupload boundary in the
        /// chain, and denoise runs before the upscale anyway. Note hwdownload cannot output
        /// gbrpf32le directly, so that variant needs its own format=yuv420p after the download.
        ///
        /// Denoise stays OFF by default, and on a clean source there is nothing for it to recover.
        /// </summary>
        private static readonly Dictionary<string, string> _denoiseFilters = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["off"] = null,
            ["light"] = "atadenoise",
            ["strong"] = "nlmeans_vulkan",
            ["max"] = "nlmeans_vulkan=s=2.0",

            // ADVANCED ONLY, and deliberately not a rung of the quality ladder. Intel Open Image
            // Denoise, wrapped as the ffmpeg filter "oidn" - a filter that exists nowhere upstream
            // and is carried by a SEPARATE patched binary, /usr/lib/jellyfin-ffmpeg-oidn/ffmpeg.
            // The stock jellyfin-ffmpeg has no such filter, so a session asking for this level is
            // routed to that binary by the ffmpeg shim, and every other session keeps the stock
            // one untouched. See OIDN.md at the root of this repository.
            //
            // Why it is not in the ladder, measured: on a genuinely grainy high-bitrate source it
            // recovers 74-86% of the fidelity lost to noise where nlmeans recovers 34-53% and
            // atadenoise 4-6%, and it does that WITHOUT over-smoothing. But on the sources this
            // server actually transcodes there is nothing for it to remove - within 0.01 dB of a
            // no-op control on a CRF-26 source, and a 0.8% change in detail energy on native
            // capture. It is also by far the most expensive level here. So: reachable by name,
            // listed in Advanced, never chosen for anybody automatically.
            //
            // The format= nodes are not decoration. OIDN takes interleaved float RGB, so the
            // filter declares gbrpf32le and the chain has to be converted into and out of it;
            // writing that explicitly keeps it visible in the built command rather than leaving
            // it to filter-graph negotiation.
            ["oidn"] = "format=gbrpf32le,oidn=quality=high:srgb=0,format=yuv420p",
            ["oidn-fast"] = "format=gbrpf32le,oidn=quality=fast:srgb=0,format=yuv420p",

            // ADVANCED ONLY as well, and for a different reason from OIDN. The NVIDIA OptiX AI
            // denoiser, filter "optix", carried by the SAME patched binary as oidn - one build,
            // two filters, so there is still exactly one thing on this server that can break and
            // it still breaks only for the sessions that asked for it. See OPTIX.md.
            //
            // "optix" is the spatial model. On grain it does the job OIDN already does: measured
            // on a degraded high-bitrate source it cut flicker 66% against OIDN's 61%, which is
            // inside the run-to-run spread of a shared GPU, at about 1.4x OIDN's throughput.
            //
            // "optix-temporal" is the one that reaches an axis nothing else here reaches. Every
            // other denoiser offered judges each frame on its own, so none of them can see
            // inter-frame flicker - atadenoise holds the light rung precisely because it is the
            // only cheap thing that touches the time axis at all. The TEMPORAL model takes the
            // previous denoised frame plus a per-pixel motion field, produced inside the filter
            // by NVOFA, this GPU's fixed-function optical flow engine, and reprojects through it.
            //
            // MEASURED, and the result is not the flattering one: on a GRAINY source the temporal
            // model cut flicker 60% where the spatial one cut 66%, because the same noise being
            // removed also corrupts the flow estimate it depends on. On a CLEAN source the flow is
            // clearly worth having - statTD 0.342 with it against 0.397 with a zero field - which
            // is what proves the reprojection is wired up correctly rather than inert; but on a
            // clean source no denoiser has anything to do. So this level is offered, named and
            // honestly costed. It is not promoted and it is not a rung.
            ["optix"] = "format=gbrpf32le,optix=mode=ldr,format=yuv420p",
            ["optix-temporal"] = "format=gbrpf32le,optix=mode=temporal,format=yuv420p",

            // Accepted but not listed: names that pin a filter explicitly, so a caller can ask for
            // one by family, and so the pre-atadenoise meaning of "strong" stays reachable.
            // Unlisted: the OptiX HDR model, for a caller who knows the source is linear HDR.
            ["optix-hdr"] = "format=gbrpf32le,optix=mode=hdr,format=yuv420p",

            ["atadenoise"] = "atadenoise",
            ["nlmeans"] = "nlmeans_vulkan",
            ["nlmeans-strong"] = "nlmeans_vulkan=s=2.0",
        };

        /// <summary>
        /// The denoise levels worth offering a viewer, cheapest first. The alias names above are
        /// accepted by the API but not listed, for the same reason the cas-* names are not.
        /// </summary>
        private static readonly string[] _denoiseMenu = { "off", "light", "strong", "max", "oidn", "optix", "optix-temporal" };

        /// <summary>
        /// Where the ONNX super-resolution weights live. Beside the patched binary rather than in
        /// the shader directory, because they are not shaders and they belong to that build: a
        /// server without the patched ffmpeg has no use for them.
        /// </summary>
        public const string NeuralModelDirectory = "/usr/lib/jellyfin-ffmpeg-oidn/models";

        /// <summary>
        /// NEURAL SUPER-RESOLUTION: a CPU-side network pass that enlarges the frame BEFORE
        /// hwupload, run by the "ort" filter - ONNX Runtime on its CUDA execution provider,
        /// carried by the SAME patched binary as oidn and optix.
        ///
        /// It is a separate axis from SrLevel and not a rung of anything. SrLevel is a libplacebo
        /// custom shader that runs inside the scaling pass; these are ONNX graphs that cannot be
        /// expressed as one, so they run ahead of it and libplacebo then scales whatever comes out
        /// to the requested size. Both can be on at once; the network runs first.
        ///
        /// WHAT THESE COST, measured once each in the deployed chain on a 960x540 source at a
        /// 1080p target, purely so the cost hint is not invented (stock binary, network off: 265
        /// fps):
        ///
        ///     realesr-anime-x2     24 fps   0.56x realtime
        ///     realesr-anime-x4     15 fps   0.34x realtime
        ///     realesr-general-x4   10 fps   0.24x realtime
        ///
        /// Read that plainly: NONE of them sustains realtime for a single session on this
        /// hardware, and they are roughly an order of magnitude more expensive than the shader
        /// that ships as the default. They are here because they are reachable by name and by the
        /// Advanced row, exactly as oidn and optix are, and for no other reason. Nothing selects
        /// them automatically and they are not costed into the generated quality ladder.
        ///
        /// The weights are NOT distributed with this plugin. They are exported from the official
        /// Real-ESRGAN checkpoints; see NEURAL.md. A level whose .onnx file is not present is not
        /// listed and not offered, and if the patched binary is missing the shim strips the node
        /// so the session plays unenhanced instead of failing.
        /// </summary>
        private static readonly Dictionary<string, string> _neuralModels =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["off"] = null,

            // SRVGGNetCompact, 64 feat / 16 conv, native x2. The cheapest of the three and the
            // only one whose scale matches a 540p source at a 1080p target exactly.
            ["realesr-anime-x2"] = "realesr-animevideo-x2-fp16.onnx",

            // SRVGGNetCompact, 64 feat / 16 conv, x4. Trained for anime video.
            ["realesr-anime-x4"] = "realesr-animevideov3-x4-fp16.onnx",

            // SRVGGNetCompact, 64 feat / 32 conv, x4. The general-purpose weight, twice the
            // convolutions of the other two and the slowest thing this plugin can be asked to run.
            ["realesr-general-x4"] = "realesr-general-x4v3-fp16.onnx",
        };

        /// <summary>The neural levels offered, cheapest first. "off" is always first.</summary>
        private static readonly string[] _neuralMenu =
            { "off", "realesr-anime-x2", "realesr-anime-x4", "realesr-general-x4" };


        /// <summary>
        /// Where a DLSS runtime has to be installed for the dlss/dlaa levels to be offered.
        /// NOTHING from NVIDIA is shipped with this plugin: the file is
        /// libnvidia-ngx-dlss.so.&lt;version&gt; out of github.com/NVIDIA/DLSS, under NVIDIA's
        /// proprietary licence, and the operator must fetch it themselves. See DLSS.md.
        /// </summary>
        public const string DlssRuntimeDirectory = "/usr/lib/jellyfin-ffmpeg-oidn/dlss";

        /// <summary>Monocular depth weights for the game upscalers. Not shipped; see FSR2.md.</summary>
        public const string DepthModelPath =
            "/usr/lib/jellyfin-ffmpeg-oidn/models/depth_anything_v2_vits.onnx";

        /// <summary>
        /// GAME TEMPORAL UPSCALERS - READ THIS BEFORE OFFERING ONE TO ANYBODY.
        ///
        /// FSR2 and DLSS are not image upscalers. They are temporal reconstruction algorithms for
        /// a renderer, and everything they gain over a plain resize comes from a renderer handing
        /// them four things a camera never records:
        ///
        ///   exact screen-space motion vectors, with the camera jitter removed
        ///   a depth buffer
        ///   the exact sub-pixel jitter the projection matrix was offset by, per frame
        ///   a reactive mask saying where history must not be trusted
        ///
        /// Recorded video has none of them, so every one is synthesised in the filter: NVOFA
        /// optical flow for the motion vectors, a monocular estimate (or a flat plane) for depth,
        /// a measured global phase-correlation offset for jitter, and forward/backward flow
        /// inconsistency for the reactive mask.
        ///
        /// The jitter one is fatal by construction and it was measured here, not assumed
        /// (the jitter measurements (see the README)): FSR2's jitter is a single GLOBAL scalar, this
        /// content's sub-pixel motion is LOCAL, and the median textured block departs from the
        /// global estimate by 0.29 px against FSR2's whole +/-0.5 px budget. With a near-null
        /// jitter sequence FSR2's lock creation picks the same display-resolution pixels every
        /// frame, the locks never sweep the display grid, and what is left is a temporal denoise
        /// plus a fixed Lanczos upsample. AMD's own documentation says the sequence must never
        /// produce a null vector, which is exactly what a fixed sensor produces.
        ///
        /// So these levels are ADVANCED, OPT-IN, OFF BY DEFAULT and NOT rungs of the generated
        /// quality ladder, they are labelled degraded everywhere they are shown, and nothing
        /// selects them automatically. They exist because they were asked for with all of the
        /// above understood.
        ///
        /// fsr2  AMD FidelityFX Super Resolution 2 (MIT), Vulkan backend. Scales to the target.
        /// dlss  NVIDIA DLSS Super Resolution through NGX. Scales to the target.
        /// dlaa  The same NGX network at 1:1 - a restoration pass BEFORE the scale, not an
        ///       upscaler. At 1:1 the entire gain would be accumulated sub-pixel samples, which
        ///       is the one thing missing, so expect close to a pass-through.
        /// </summary>
        private static readonly Dictionary<string, string> _gameFilters =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["off"] = null,
            ["fsr2"] = "fsr2",
            ["dlss"] = "dlss",
            ["dlaa"] = "dlss=mode=dlaa",
        };

        /// <summary>The game upscaler levels offered. "off" is always first.</summary>
        private static readonly string[] _gameMenu = { "off", "fsr2", "dlss", "dlaa" };

        /// <summary>The names offered as real levels, in ladder order. Aliases are accepted but not listed.</summary>
        public static IEnumerable<string> SrLevels => _srFiles.Keys;

        /// <summary>
        /// The libplacebo scaling kernels this plugin will put in a command. A kernel name goes
        /// straight into the ffmpeg filter string, so an unknown one does not degrade the picture -
        /// it fails the whole job. Hence a whitelist of names verified to load on this build, and
        /// an unrecognised request falls back rather than being tried.
        /// </summary>
        private static readonly string[] _upscalers =
        {
            "ewa_lanczos", "ewa_lanczossharp", "lanczos", "spline36", "spline16",
            "catmull_rom", "mitchell", "bicubic", "gaussian", "nearest", "bilinear",
        };

        public static List<string> Upscalers => new List<string>(_upscalers);

        /// <summary>The whitelisted kernel matching this name, or null when there is none.</summary>
        public static string CanonicalUpscaler(string name)
        {
            if (string.IsNullOrWhiteSpace(name))
            {
                return null;
            }

            string trimmed = name.Trim();
            foreach (string known in _upscalers)
            {
                if (string.Equals(known, trimmed, StringComparison.OrdinalIgnoreCase))
                {
                    return known;
                }
            }

            return null;
        }

        /// <summary>Maps an alias to its real level name, and leaves a real level alone.</summary>
        public static string CanonicalSr(string level)
        {
            if (string.IsNullOrWhiteSpace(level))
            {
                return null;
            }

            string trimmed = level.Trim();
            if (_srAliases.TryGetValue(trimmed, out string mapped))
            {
                return mapped;
            }

            return _srFiles.ContainsKey(trimmed) ? trimmed.ToLowerInvariant() : null;
        }

        public static bool IsSrLevel(string level) => CanonicalSr(level) != null;

        /// <summary>
        /// Does this SR level scale to the requested size itself? See _srRatioAgnostic: the
        /// SrMinScaleFactor bypass is aimed at fixed-2x networks and must not disable a prescaler
        /// that was handed the output size in the first place.
        /// </summary>
        public static bool SrIsRatioAgnostic(string level)
        {
            string canonical = CanonicalSr(level);
            return canonical != null && _srRatioAgnostic.Contains(canonical);
        }

        /// <summary>Maps a refinement level name to itself, or null when there is no such level.</summary>
        public static string CanonicalRefine(string level) => Canonical(_refineFiles, level);

        /// <summary>Maps a chroma level name to itself, or null when there is no such level.</summary>
        public static string CanonicalChroma(string level) => Canonical(_chromaFiles, level);

        public static bool IsRefineLevel(string level) => CanonicalRefine(level) != null;

        public static bool IsChromaLevel(string level) => CanonicalChroma(level) != null;

        private static string Canonical(Dictionary<string, string> table, string level)
        {
            if (string.IsNullOrWhiteSpace(level))
            {
                return null;
            }

            string trimmed = level.Trim();
            return table.ContainsKey(trimmed) ? trimmed.ToLowerInvariant() : null;
        }

        /// <summary>
        /// The refinement levels whose shader file is present. Same rule as the SR list: a level
        /// whose file was never installed is not offered, because an option that silently does
        /// nothing is worse than an absent one.
        /// </summary>
        public static List<string> AvailableRefineLevels(UpscaleSettings cfg) => Available(_refineFiles, cfg);

        /// <summary>The chroma levels whose shader file is present.</summary>
        public static List<string> AvailableChromaLevels(UpscaleSettings cfg) => Available(_chromaFiles, cfg);

        private static List<string> Available(Dictionary<string, string> table, UpscaleSettings cfg)
        {
            var found = new List<string>();
            foreach (var pair in table)
            {
                if (pair.Value == null || Lookup(table, cfg?.ShaderDirectory, pair.Key) != null)
                {
                    found.Add(pair.Key);
                }
            }

            return found;
        }

        /// <summary>
        /// The super-resolution levels whose shader file is actually present on this server, in
        /// ladder order. The player menu is built from this rather than from a hard-coded list, so
        /// a level whose file was never installed is not offered - an option that silently does
        /// nothing is worse than an absent one.
        /// </summary>
        public static List<string> AvailableSrLevels(UpscaleSettings cfg)
        {
            var found = new List<string>();
            foreach (var pair in _srFiles)
            {
                if (pair.Value == null || Lookup(_srFiles, cfg?.ShaderDirectory, pair.Key) != null)
                {
                    found.Add(pair.Key);
                }
            }

            return found;
        }

        /// <summary>The sharpening levels offered to a viewer whose shader file is present.</summary>
        public static List<string> AvailableDeblurLevels(UpscaleSettings cfg)
        {
            var found = new List<string>();
            foreach (string level in _deblurMenu)
            {
                if (_deblurFiles[level] == null || Lookup(_deblurFiles, cfg?.ShaderDirectory, level) != null)
                {
                    found.Add(level);
                }
            }

            return found;
        }

        /// <summary>The denoise levels offered to a viewer. These are ffmpeg filters, so there is no file to check.</summary>
        public static List<string> AvailableDenoiseLevels() => new List<string>(_denoiseMenu);

        public static bool IsDeblurLevel(string level) => level != null && _deblurFiles.ContainsKey(level.Trim());

        public static bool IsDenoiseLevel(string level) => level != null && _denoiseFilters.ContainsKey(level.Trim());

        /// <summary>The full path to a neural level's weights, or null when there is no such level.</summary>
        public static string NeuralModelPath(string level)
        {
            if (string.IsNullOrWhiteSpace(level)
                || !_neuralModels.TryGetValue(level.Trim(), out string file)
                || file == null)
            {
                return null;
            }

            return Path.Combine(NeuralModelDirectory, file);
        }

        public static bool IsNeuralLevel(string level) => level != null && _neuralModels.ContainsKey(level.Trim());

        public static bool IsGameLevel(string level) =>
            level != null && _gameFilters.ContainsKey(level.Trim());

        /// <summary>True when the level produces the OUTPUT size itself rather than the input size.</summary>
        public static bool GameScalesOutput(string level) =>
            level != null
            && (string.Equals(level.Trim(), "fsr2", StringComparison.OrdinalIgnoreCase)
                || string.Equals(level.Trim(), "dlss", StringComparison.OrdinalIgnoreCase));

        /// <summary>Is a DLSS runtime present? It is not shipped, so dlss/dlaa may not be offerable.</summary>
        public static bool DlssRuntimePresent()
        {
            try
            {
                return Directory.Exists(DlssRuntimeDirectory)
                    && Directory.GetFiles(DlssRuntimeDirectory, "libnvidia-ngx-dlss.so*").Length > 0;
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>
        /// Only the levels this server could actually run. dlss and dlaa need a DLSS runtime that
        /// is not shipped with the plugin, so on a server where nobody installed one they are not
        /// listed - the same rule the neural weights follow.
        /// </summary>
        public static List<string> AvailableGameLevels()
        {
            var list = new List<string>();
            bool dlss = DlssRuntimePresent();
            foreach (string level in _gameMenu)
            {
                if ((string.Equals(level, "dlss", StringComparison.Ordinal)
                     || string.Equals(level, "dlaa", StringComparison.Ordinal)) && !dlss)
                {
                    continue;
                }

                list.Add(level);
            }

            return list;
        }

        /// <summary>
        /// The allowed values of the three game-upscaler input options, and their defaults. They
        /// are public so the probe can serve them: the player panel must not carry its own copy of
        /// a list that lives in the ffmpeg filter's own AVOption table.
        /// </summary>
        public static readonly string[] GameJitterValues = { "measured", "cancel", "zero", "halton" };

        /// <summary>Allowed depth sources; "model" is the default.</summary>
        public static readonly string[] GameDepthValues = { "model", "model-stable", "flat" };

        /// <summary>Allowed reactive-mask sources; "flow" is the default.</summary>
        public static readonly string[] GameReactiveValues = { "flow", "none" };

        /// <summary>The built-in default jitter source, used when neither session nor dashboard says.</summary>
        public const string GameJitterDefault = "measured";

        /// <summary>The built-in default depth source.</summary>
        public const string GameDepthDefault = "model";

        /// <summary>The built-in default reactive-mask source.</summary>
        public const string GameReactiveDefault = "flow";

        /// <summary>
        /// The game levels on which jitter / depth / reactive do anything. All three run the same
        /// synthesised-input path in the filter, dlaa included - it is the same vf_dlss with
        /// mode=dlaa, and it is handed the same depth, jitter and reactive mask - so every level
        /// but "off" is listed. Served through the probe so the panel shows the rows only where
        /// they act, instead of deciding that here.
        /// </summary>
        public static List<string> GameOptionLevels()
        {
            var list = new List<string>();
            foreach (string level in AvailableGameLevels())
            {
                if (!string.Equals(level, "off", StringComparison.Ordinal))
                {
                    list.Add(level);
                }
            }

            return list;
        }

        /// <summary>The wording the panel must show beside each jitter value. The server owns it.</summary>
        public static string GameOptionLabel(string axis, string value)
        {
            switch ((axis ?? string.Empty) + ":" + (value ?? string.Empty))
            {
                case "jitter:measured":
                    return "Measured (phase correlation, the default)";
                case "jitter:cancel":
                    return "Measured, and declared already in the motion vectors";
                case "jitter:zero":
                    return "None (skips the per-frame FFT, much faster)";
                case "jitter:halton":
                    return "Halton sequence (a renderer's pattern; fiction on recorded video)";
                case "depth:model":
                    return "Monocular estimate (the default)";
                case "depth:model-stable":
                    return "Monocular estimate, flow-warped and blended";
                case "depth:flat":
                    return "Flat plane (no depth-driven decisions)";
                case "reactive:flow":
                    return "Forward/backward flow inconsistency (the default)";
                case "reactive:none":
                    return "None";
                default:
                    return value ?? string.Empty;
            }
        }

        /// <summary>The wording a viewer must see beside one of these levels. Not decoration.</summary>
        public static string GameLabel(string level)
        {
            switch ((level ?? string.Empty).Trim().ToLowerInvariant())
            {
                case "fsr2":
                    return "FSR2 (degraded: synthesised motion vectors, estimated depth, no true jitter)";
                case "dlss":
                    return "DLSS SR (degraded: synthesised motion vectors, estimated depth, no true jitter)";
                case "dlaa":
                    return "DLAA (degraded: no true jitter, so close to a pass-through)";
                default:
                    return "off";
            }
        }

        /// <summary>
        /// The ffmpeg filter node for a game upscaler level, or null for none. Always CPU-side:
        /// both filters take planar float RGB and carry their own conversions, so neither has
        /// "_vulkan" in it and both land before hwupload under the same routing invariant the
        /// denoise and neural levels obey.
        ///
        /// Depth falls back to flat when the weights are absent, and the filter falls back again
        /// on its own if ONNX Runtime has no CUDA execution provider - a per-frame vision
        /// transformer on the CPU runs at about 1 fps, which is not a transcode filter.
        /// </summary>
        public static string GameFilter(
            string level,
            int outWidth,
            int outHeight,
            UpscaleSettings cfg,
            string jitterOption,
            string depthOption,
            string reactiveOption,
            out string levelUsed,
            out string jitterUsed,
            out string depthUsed,
            out string reactiveUsed,
            out bool depthDowngraded)
        {
            levelUsed = "off";
            jitterUsed = null;
            depthUsed = null;
            reactiveUsed = null;
            depthDowngraded = false;
            if (string.IsNullOrWhiteSpace(level)
                || !_gameFilters.TryGetValue(level.Trim(), out string node)
                || node == null)
            {
                return null;
            }

            string canonical = level.Trim().ToLowerInvariant();
            bool isDlss = canonical == "dlss" || canonical == "dlaa";
            if (isDlss && !DlssRuntimePresent())
            {
                return null;
            }

            bool depthModel = false;
            try
            {
                depthModel = File.Exists(DepthModelPath);
            }
            catch (Exception)
            {
                depthModel = false;
            }

            var sb = new StringBuilder("format=gbrpf32le,");
            sb.Append(node);
            if (GameScalesOutput(canonical))
            {
                sb.AppendFormat(CultureInfo.InvariantCulture, "=w={0}:h={1}", outWidth, outHeight);
                sb.Append(':');
            }
            else
            {
                sb.Append(node.IndexOf('=') >= 0 ? ':' : '=');
            }

            // THREE LEVELS OF PRECEDENCE, and the same one for all three options: the session
            // wins, the dashboard is the fallback, the built-in default is the last word. An
            // unrecognised value at either level falls through to the next rather than reaching
            // the filter: these strings are concatenated into an ffmpeg filter argument, where a
            // name the filter does not know fails the whole job.
            string jitter = GameOption(
                jitterOption, GameOption(cfg?.GameJitter, GameJitterDefault, GameJitterValues), GameJitterValues);
            string reactive = GameOption(
                reactiveOption, GameOption(cfg?.GameReactive, GameReactiveDefault, GameReactiveValues), GameReactiveValues);
            string depth = GameOption(
                depthOption, GameOption(cfg?.GameDepth, GameDepthDefault, GameDepthValues), GameDepthValues);

            // The weights are not shipped. Without them the filter would fall back to flat on its
            // own; doing it here as well means the session record can SAY that it happened rather
            // than reporting a depth mode that never ran. The filter's OTHER self-downgrade - no
            // CUDA execution provider in ONNX Runtime - happens inside ffmpeg after this decision
            // and is not observable from here, so it is not claimed either way.
            depthDowngraded = !depthModel && depth != "flat";
            if (!depthModel)
            {
                depth = "flat";
            }

            sb.Append("jitter=").Append(jitter);
            sb.Append(":reactive=").Append(reactive);
            sb.Append(":depth=").Append(depth);
            jitterUsed = jitter;
            reactiveUsed = reactive;
            depthUsed = depth;
            if (depth != "flat")
            {
                sb.Append(":dmodel=").Append(DepthModelPath);
            }

            if (isDlss)
            {
                sb.Append(":sdk=").Append(DlssRuntimeDirectory);
            }

            sb.Append(",format=yuv420p");
            levelUsed = canonical;
            return sb.ToString();
        }

        /// <summary>An unrecognised option value is ignored rather than put into an ffmpeg command.</summary>
        private static string GameOption(string value, string fallback, params string[] allowed)
        {
            if (!string.IsNullOrWhiteSpace(value))
            {
                string v = value.Trim().ToLowerInvariant();
                foreach (string a in allowed)
                {
                    if (string.Equals(a, v, StringComparison.Ordinal))
                    {
                        return a;
                    }
                }
            }

            return fallback;
        }


        /// <summary>
        /// Only the levels whose weights are actually on disk. The weights are not shipped with the
        /// plugin, so on a server where nobody exported them this list is just "off" and the
        /// control disappears rather than offering something that would fail.
        /// </summary>
        public static List<string> AvailableNeuralLevels()
        {
            var list = new List<string>();
            foreach (string level in _neuralMenu)
            {
                string path = NeuralModelPath(level);
                if (path == null)
                {
                    list.Add(level);        // "off"
                    continue;
                }

                try
                {
                    if (File.Exists(path))
                    {
                        list.Add(level);
                    }
                }
                catch (Exception)
                {
                    // An unreadable model directory means the level is not offered, not a crash.
                }
            }

            return list;
        }

        /// <summary>
        /// The ffmpeg filter node for a neural level, or null for none. Always CPU-side: the
        /// "ort" filter takes planar float RGB, so it carries its own format conversions and
        /// therefore never has "_vulkan" in it, which is what puts it before hwupload under the
        /// same routing invariant the denoise levels obey.
        /// </summary>
        public static string NeuralFilter(string level, out string levelUsed)
        {
            levelUsed = "off";
            string path = NeuralModelPath(level);
            if (path == null)
            {
                return null;
            }

            try
            {
                if (!File.Exists(path))
                {
                    return null;
                }
            }
            catch (Exception)
            {
                return null;
            }

            levelUsed = level.Trim().ToLowerInvariant();
            return "format=gbrpf32le,ort=model=" + path + ",format=yuv420p";
        }

        /// <summary>
        /// The ffmpeg filter node for a denoise level, or null for none. Also reports whether the
        /// node wants hardware (Vulkan) frames, which decides whether it goes before or after
        /// hwupload in the chain.
        /// </summary>
        public static string DenoiseFilter(string level, out string levelUsed, out bool wantsHwFrames)
        {
            levelUsed = "off";
            wantsHwFrames = false;

            if (string.IsNullOrWhiteSpace(level) || !_denoiseFilters.TryGetValue(level.Trim(), out string filter) || filter == null)
            {
                return null;
            }

            levelUsed = level.Trim().ToLowerInvariant();
            wantsHwFrames = filter.IndexOf("_vulkan", StringComparison.OrdinalIgnoreCase) >= 0;
            return filter;
        }

        /// <summary>
        /// The shader file to hand libplacebo for this combination, or null for none.
        /// Returns null rather than throwing if anything is missing, so an unknown or unreadable
        /// level degrades to plain scaling instead of breaking the transcode.
        /// </summary>
        public static string Resolve(
            UpscaleSettings cfg,
            string srLevel,
            string deblurLevel,
            string refineLevel,
            string chromaLevel,
            out string srUsed,
            out string deblurUsed,
            out string refineUsed,
            out string chromaUsed)
        {
            srUsed = "off";
            deblurUsed = "off";
            refineUsed = "off";
            chromaUsed = "off";

            try
            {
                string srCanonical = CanonicalSr(srLevel);
                string srFile = Lookup(_srFiles, cfg.ShaderDirectory, srCanonical);
                string deblurFile = Lookup(_deblurFiles, cfg.ShaderDirectory, deblurLevel);
                string refineFile = Lookup(_refineFiles, cfg.ShaderDirectory, CanonicalRefine(refineLevel));
                string chromaFile = Lookup(_chromaFiles, cfg.ShaderDirectory, CanonicalChroma(chromaLevel));

                // NVScaler sharpens inside its own upscaling pass. Running a second sharpener over
                // its output is not "more sharpening", it is ringing, so the separate pass is
                // dropped here rather than being left for the viewer to discover. The session
                // record says it happened (SrOwnsSharpening) instead of silently reporting a level
                // that did not run.
                if (srFile != null
                    && string.Equals(srCanonical, "nvscaler", StringComparison.OrdinalIgnoreCase)
                    && deblurFile != null)
                {
                    deblurFile = null;
                }

                // ORDER IS THE HOOK ORDER, and these four occupy four groups, so the concatenation
                // order below is bookkeeping rather than semantics. libplacebo runs LUMA hooks
                // before it scales, MAIN hooks after, POSTKERNEL after the scaling kernel, and
                // CHROMA on the chroma planes:
                //
                //   sr      LUMA (FSRCNNX, CuNNy, ravu-zoom, NVScaler) or MAIN (Anime4K)
                //   deblur  LUMA (RCAS, NVSharpen)
                //   refine  POSTKERNEL (SSimSuperRes) - always after the scale, whatever precedes it
                //   chroma  CHROMA (KrigBilateral)   - a different plane entirely
                //
                // The one pairing where file order really does decide anything is sr+deblur when
                // both hook LUMA, and that is the existing arrangement documented at Compose().
                var files = new List<string>();
                var names = new List<string>();

                if (srFile != null)
                {
                    srUsed = srCanonical;
                    files.Add(srFile);
                    names.Add(srUsed);
                }

                if (deblurFile != null)
                {
                    deblurUsed = deblurLevel.Trim().ToLowerInvariant();
                    files.Add(deblurFile);
                    names.Add(deblurUsed);
                }

                if (refineFile != null)
                {
                    refineUsed = CanonicalRefine(refineLevel);
                    files.Add(refineFile);
                    names.Add(refineUsed);
                }

                if (chromaFile != null)
                {
                    chromaUsed = CanonicalChroma(chromaLevel);
                    files.Add(chromaFile);
                    names.Add(chromaUsed);
                }

                if (files.Count == 0)
                {
                    return null;
                }

                if (files.Count == 1)
                {
                    return files[0];
                }

                return Compose(cfg, names, files);
            }
            catch (Exception)
            {
                srUsed = "off";
                deblurUsed = "off";
                refineUsed = "off";
                chromaUsed = "off";
                return null;
            }
        }

        private static string Lookup(Dictionary<string, string> table, string dir, string level)
        {
            if (string.IsNullOrWhiteSpace(level) || !table.TryGetValue(level.Trim(), out string name) || name == null)
            {
                return null;
            }

            string path = Path.Combine(dir ?? string.Empty, name);
            return File.Exists(path) ? path : null;
        }

        /// <summary>
        /// The prefix libplacebo's shader_cache option takes for this shader combination, or null
        /// when there is nowhere to put it.
        ///
        /// It is a PATH PREFIX, not a directory: libplacebo appends its own suffixes and will leave
        /// hundreds of scratch files beside whatever it is pointed at. So it is pointed inside a
        /// subdirectory of the shader cache directory, where that litter stays away from the
        /// composed .glsl files Compose() writes and can be cleared wholesale. The composed file's
        /// name already identifies the combination, which is exactly the key the cache needs.
        /// </summary>
        public static string ShaderCachePrefix(UpscaleSettings cfg, string shaderPath)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(cfg?.ShaderCacheDirectory) || string.IsNullOrWhiteSpace(shaderPath))
                {
                    return null;
                }

                string dir = Path.Combine(cfg.ShaderCacheDirectory, "plcache");
                Directory.CreateDirectory(dir);
                return Path.Combine(dir, Path.GetFileNameWithoutExtension(shaderPath));
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static string Compose(UpscaleSettings cfg, List<string> names, List<string> files)
        {
            string dir = cfg.ShaderCacheDirectory;
            Directory.CreateDirectory(dir);
            string composed = Path.Combine(dir, string.Join("+", names) + ".glsl");

            if (File.Exists(composed))
            {
                DateTime stamp = File.GetLastWriteTimeUtc(composed);
                bool stale = false;
                foreach (string file in files)
                {
                    if (File.GetLastWriteTimeUtc(file) >= stamp)
                    {
                        stale = true;
                        break;
                    }
                }

                if (!stale)
                {
                    return composed;
                }
            }

            // The SR shader is written first, but file order is NOT what decides the running
            // order - the hook point is. libplacebo runs every LUMA hook before it scales and
            // every MAIN hook after, in file order within each group.
            //
            //   FSRCNNX (LUMA) + RCAS (LUMA):  FSRCNNX enlarges the luma plane, then RCAS sharpens
            //     that enlarged plane, both before the final scale. Sharpening therefore happens
            //     at 2x the source size rather than at output size, which is why RCAS costs about
            //     nothing at 1080p and 1440p.
            //
            //   Anime4K (MAIN) + RCAS (LUMA):  RCAS runs FIRST, on the source-sized luma plane,
            //     and Anime4K enlarges afterwards. Sharpen-before-enlarge, whatever the file order
            //     says. This was measured rather than assumed, because it is the arrangement the
            //     old comment (written for CAS, a MAIN hook) said could not happen: against ground
            //     truth, anime4k-m + RCAS-1.7 beat anime4k-m + CAS on both metrics at both ratios
            //     (1.5x 43.31/0.98578 vs 43.21/0.98574; 2.0x 40.74/0.98074 vs 40.38/0.97937), and
            //     its detail energy landed at 4.0065 against CAS-medium's 4.9302 for a ground
            //     truth of 3.5179. So the pairing is allowed for every SR family.
            string tmp = composed + "." + Guid.NewGuid().ToString("N") + ".tmp";
            var sb = new StringBuilder();
            foreach (string file in files)
            {
                if (sb.Length > 0)
                {
                    sb.Append("\n\n");
                }

                sb.Append(File.ReadAllText(file));
            }

            File.WriteAllText(tmp, sb.ToString());
            File.Move(tmp, composed, true);
            return composed;
        }
    }
}
