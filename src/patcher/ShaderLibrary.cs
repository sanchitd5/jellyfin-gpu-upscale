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
    /// gives both passes inside one Vulkan pass. The two SR families hook at different points:
    /// FSRCNNX hooks LUMA, Anime4K hooks MAIN, and CAS hooks MAIN. The SR shader is always written
    /// first, so where both hook MAIN the picture is enlarged before it is sharpened.
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

        /// <summary>Sharpening levels. "off" means no sharpening pass.</summary>
        private static readonly Dictionary<string, string> _deblurFiles = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["off"] = null,
            ["low"] = "CAS-low.glsl",
            ["medium"] = "CAS-medium.glsl",
            ["high"] = "CAS-high.glsl",
        };

        /// <summary>
        /// Denoise levels. These are ffmpeg filter nodes, not shaders, so they carry their filter
        /// string rather than a file name. "off" means no denoise node in the chain.
        ///
        /// light   hqdn3d, measured 163 fps / 5.5x realtime at 1080p out.
        /// strong  nlmeans_vulkan, measured 86 fps / 2.9x realtime at 1080p out.
        /// </summary>
        private static readonly Dictionary<string, string> _denoiseFilters = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["off"] = null,
            ["light"] = "hqdn3d=2:1:3:3",
            ["strong"] = "nlmeans_vulkan",
        };

        /// <summary>The names offered as real levels, in ladder order. Aliases are accepted but not listed.</summary>
        public static IEnumerable<string> SrLevels => _srFiles.Keys;

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

            // The SR shader goes first. FSRCNNX hooks LUMA and CAS hooks MAIN, so for that family
            // the order is set by the hook points; Anime4K hooks MAIN like CAS does, and there the
            // file order is what puts the enlargement before the sharpening.
            string tmp = composed + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllText(tmp, File.ReadAllText(srFile) + "\n\n" + File.ReadAllText(deblurFile));
            File.Move(tmp, composed, true);
            return composed;
        }
    }
}
