# Roadmap

Where the patched ffmpeg and this plugin could go next: new features that the NVIDIA driver
inspection work (TASK.md, `~/dev/rtx-video-re`) makes possible, and improvements to the filters
that already ship.

Status words mean exactly this:

- **Works**: measured on CT114.
- **Runs**: executes on CT114, output not yet useful.
- **Not started**: only inferred from code, DLL names, patch names or kernel strings.

Nothing here is a commitment. TASK.md stays the source of truth for the active work.

## Files

| File | What it covers |
|---|---|
| [driver-features.md](driver-features.md) | What the driver inspection has unlocked, the new features it enables (RTX VSR, the bypass resampler, TrueHDR, DeepDVC, DLPP, DLISR, frame interpolation), shared infrastructure, order |
| [gpu-only-filters.md](gpu-only-filters.md) | Moving the five existing filters (optix, ort, oidn, fsr2, dlss) off system RAM so frames stay on the GPU from decode to encode |
| [gpu-only-dlss.md](gpu-only-dlss.md) | The detailed plan for the largest of those, the `vf_dlss` Vulkan rewrite |
| [dlss-neural-rendering.md](dlss-neural-rendering.md) | NGX feature 18 ("DLSS5"/DLSSNR) - investigated, real CUDA-export finding, blocked on a caller-identity spoof and unclear third-party licensing |
| [optiscaler-research.md](optiscaler-research.md) | Background on upstream OptiScaler itself (GPL-3.0, DLL-proxying, `IFeature`/`NVSDK_NGX_Parameter` architecture) - prior art only, nothing planned |
| [plex.md](plex.md) | Serving the same filters to Plex, which has no plugin system |

## Overall order

1. Bypass resampler (driver-features #2): works today.
2. GPU-only optix, then the shared PTX colour module and ort IoBinding (gpu-only-filters).
3. RTX VSR once L17 is solved (driver-features #1).
4. GPU-only `gu_inputs.h`, then dlss and fsr2 on Vulkan.
5. TrueHDR and DeepDVC on the shared driver DLL filter.
6. Plex spike: capture real `Plex Transcoder` command lines.
