using System;
using System.Collections.Generic;
using System.IO;

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

            // Accepted but not listed: names that pin a filter explicitly, so a caller can ask for
            // one by family, and so the pre-atadenoise meaning of "strong" stays reachable.
            ["atadenoise"] = "atadenoise",
            ["nlmeans"] = "nlmeans_vulkan",
            ["nlmeans-strong"] = "nlmeans_vulkan=s=2.0",
        };

        /// <summary>
        /// The denoise levels worth offering a viewer, cheapest first. The alias names above are
        /// accepted by the API but not listed, for the same reason the cas-* names are not.
        /// </summary>
        private static readonly string[] _denoiseMenu = { "off", "light", "strong", "max", "oidn" };

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
        public static string Resolve(UpscaleSettings cfg, string srLevel, string deblurLevel, out string srUsed, out string deblurUsed)
        {
            srUsed = "off";
            deblurUsed = "off";

            try
            {
                string srCanonical = CanonicalSr(srLevel);
                string srFile = Lookup(_srFiles, cfg.ShaderDirectory, srCanonical);
                string deblurFile = Lookup(_deblurFiles, cfg.ShaderDirectory, deblurLevel);

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

                if (srFile != null)
                {
                    srUsed = srCanonical;
                }

                if (deblurFile != null)
                {
                    deblurUsed = deblurLevel.Trim().ToLowerInvariant();
                }

                if (srFile == null && deblurFile == null)
                {
                    return null;
                }

                if (deblurFile == null)
                {
                    return srFile;
                }

                if (srFile == null)
                {
                    return deblurFile;
                }

                return Compose(cfg, srUsed, deblurUsed, srFile, deblurFile);
            }
            catch (Exception)
            {
                srUsed = "off";
                deblurUsed = "off";
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

        private static string Compose(UpscaleSettings cfg, string srLevel, string deblurLevel, string srFile, string deblurFile)
        {
            string dir = cfg.ShaderCacheDirectory;
            Directory.CreateDirectory(dir);
            string composed = Path.Combine(dir, srLevel + "+" + deblurLevel + ".glsl");

            if (File.Exists(composed)
                && File.GetLastWriteTimeUtc(composed) > File.GetLastWriteTimeUtc(srFile)
                && File.GetLastWriteTimeUtc(composed) > File.GetLastWriteTimeUtc(deblurFile))
            {
                return composed;
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
            File.WriteAllText(tmp, File.ReadAllText(srFile) + "\n\n" + File.ReadAllText(deblurFile));
            File.Move(tmp, composed, true);
            return composed;
        }
    }
}
