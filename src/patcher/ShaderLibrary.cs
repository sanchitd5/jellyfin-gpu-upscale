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
        /// string rather than a file name. "off" means no denoise node in the chain.
        ///
        /// light   nlmeans_vulkan at its default strength. Recovered 46% of the structural damage
        ///         of a visibly noisy source.
        /// strong  nlmeans_vulkan=s=2.0. Recovered 53%.
        ///
        /// hqdn3d=2:1:3:3 WAS "light" and HAS BEEN RETIRED. Do not put it back because it is
        /// cheap: measured on a degraded source it recovered 0.00 dB and 12% of the structural
        /// damage, i.e. it traded noise for blur one for one and returned nothing. A denoise level
        /// that removes as much picture as it removes noise is worse than no denoise at all,
        /// because the viewer pays for it in detail and believes they gained something.
        ///
        /// Both surviving levels carry "_vulkan" in the filter string, which is what
        /// DenoiseFilter() keys on to route them after hwupload. That is not incidental: adding a
        /// CPU denoise level here would need no code change but WOULD need the string to not
        /// contain "_vulkan".
        ///
        /// Denoise stays OFF by default. It costs roughly 60% of throughput (still about 2.5x
        /// realtime at 4K), and on a clean source there is nothing for it to recover.
        /// </summary>
        private static readonly Dictionary<string, string> _denoiseFilters = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["off"] = null,
            ["light"] = "nlmeans_vulkan",
            ["strong"] = "nlmeans_vulkan=s=2.0",
        };

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

        /// <summary>The denoise levels. These are ffmpeg filters, so there is no file to check.</summary>
        public static List<string> AvailableDenoiseLevels() => new List<string>(_denoiseFilters.Keys);

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
