# Documentation

The entry points live at the repository root:

| File | Read it for |
|---|---|
| [README.md](../README.md) | What the plugin does, requirements, the enhancement levels and why they were chosen |
| [INSTALL.md](../INSTALL.md) | Installing from scratch, with environment checks and troubleshooting |
| [ENHANCEMENTS.md](../ENHANCEMENTS.md) | Every change to Jellyfin, server and client: patches, routes, request parameters, storage keys |
| [AGENTS.md](../AGENTS.md) | Architecture invariants and verification standards for anyone changing the code |
| [CLAUDE.md](../CLAUDE.md) | Working on the repo with Claude Code |
| [context-map.md](../context-map.md) | Every client module, with its exports and imports |

Everything else is here, grouped by what it is.

**[video-enhancement.md](video-enhancement.md)** is the full manual for server-side video
enhancement: the Enhance panel, every level and axis, configuration, throughput, how the server
applies it, and what was measured and rejected.

## architecture/ — how the pieces fit

| File | About |
|---|---|
| [ARCHITECTURE.md](architecture/ARCHITECTURE.md) | The overall architecture |
| [LIVE_APPLY_DESIGN.md](architecture/LIVE_APPLY_DESIGN.md) | Live-apply smoothness: root cause and the A/B swap design |
| [RUNTIME_FILTER_CONTROL_DESIGN.md](architecture/RUNTIME_FILTER_CONTROL_DESIGN.md) | Runtime filter control (zmq/sendcmd), the alternative to the A/B swap |
| [WEB_PANEL_DESIGN.md](architecture/WEB_PANEL_DESIGN.md) | The Enhance panel: data-driven levels, server versus client wording, `dlpp_rtcuda` / `vsr_rtcuda` |
| [INTEGRATION_DESIGN.md](architecture/INTEGRATION_DESIGN.md) | Integrating `dlpp_rtcuda` and `vsr_rtcuda` into the plugin |

## filters/ — one document per custom ffmpeg filter

Each one covers what the level does, what it costs, and what you must obtain or build yourself.

| File | Filter |
|---|---|
| [OIDN.md](filters/OIDN.md) | Intel Open Image Denoise (`vf_oidn`) |
| [OPTIX.md](filters/OPTIX.md) | NVIDIA OptiX denoise (`vf_optix`) |
| [NEURAL.md](filters/NEURAL.md) | ONNX Runtime neural super-resolution (`vf_ort`) |
| [FSR2.md](filters/FSR2.md) | AMD FSR2 (`vf_fsr2`) |
| [DLSS.md](filters/DLSS.md) | NVIDIA DLSS / DLAA (`vf_dlss`) |
| [RTXDLPP.md](filters/RTXDLPP.md) | RTX DLPP super-resolution (`dlpp_rtcuda`), opt-in |
| [RTXVSR.md](filters/RTXVSR.md) | RTX VSR bypass resampler (`vsr_rtcuda`), opt-in |
| [VSR.md](filters/VSR.md) | NVIDIA Maxine VFX SDK VSR (`vf_vsr`), retired |

## research/ — background reading, not plans

| File | About |
|---|---|
| [RTX-VSR-RESEARCH.md](research/RTX-VSR-RESEARCH.md) | Public research on NVIDIA RTX Video Super Resolution's architecture |
| [rtx-video-re-design.md](research/rtx-video-re-design.md) | Design of `rtx-video-re` (`rtxv`), from what the patch series says about itself |
| [patchFFMPEGDLPP-open-source.md](research/patchFFMPEGDLPP-open-source.md) | An external FFmpeg patch series for CUDA graph-replay filters, kept for reference |
| [hints.md](research/hints.md) | Hints taken from the GPU compute-graph filter pattern |

## roadmap/ — what might come next

| File | About |
|---|---|
| [README.md](roadmap/README.md) | Roadmap index |
| [QOL_IDEAS.md](roadmap/QOL_IDEAS.md) | Quality-of-life candidates for Jellyfin 12.1, with the stock seam for each (many have shipped; see ENHANCEMENTS.md) |
| [mobile-redesign.md](roadmap/mobile-redesign.md) | Phone UI and theme redesign plan for jellyfin-web 12.3: audit, tokens, delivery mechanism, prioritised proposals, wireframes, phases |
| [improvements.md](roadmap/improvements.md) | The improvement programme for the enhancement engine |
| [hw-resident-encode-plan.md](roadmap/hw-resident-encode-plan.md) | GPU-resident encode: Vulkan to NVENC without leaving the GPU |
| [gpu-only-filters.md](roadmap/gpu-only-filters.md) | GPU-only versions of the existing filters |
| [gpu-only-dlss.md](roadmap/gpu-only-dlss.md) | GPU-only DLSS (`vf_dlss` rewrite) |
| [driver-features.md](roadmap/driver-features.md) | What driver inspection unlocks |
| [dlss-neural-rendering.md](roadmap/dlss-neural-rendering.md) | DLSS Neural Rendering: investigated, not started |
| [optiscaler-research.md](roadmap/optiscaler-research.md) | OptiScaler background |
| [plex.md](roadmap/plex.md) | Plex support |

## tasks/ — working briefs and their logs

Long-running task briefs, kept with their results. They are historical records: where one disagrees
with ENHANCEMENTS.md or the code, the code wins.

| File | Task |
|---|---|
| [TASK.md](tasks/TASK.md) | An NVIDIA neural super-resolution upscaler in this plugin (Tracks B and C: DLPP, VSR) |
| [TASK.L17.md](tasks/TASK.L17.md) | Remaining items on the L17 blocker |
| [rtx-cuda-vsr-task.md](tasks/rtx-cuda-vsr-task.md) | The `rtx_cuda` route to a real VSR |
| [vfx-sdk-vsr-task.md](tasks/vfx-sdk-vsr-task.md) | `vf_vsr.c` wrapping the Maxine VFX SDK |
| [vulkan-cuda-hwmap-task.md](tasks/vulkan-cuda-hwmap-task.md) | Patching FFmpeg's `hwcontext_vulkan.c` for Vulkan↔CUDA hwmap |

Code comments and build-error messages refer to these documents by bare name (for example "see
OPTIX.md"); each name is unique, so a file search finds it.
