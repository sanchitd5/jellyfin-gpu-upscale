# Driver inspection: what it unlocks and the features it enables

Part of the [roadmap](README.md). Status words are defined there.

## What the inspection work has unlocked

Each of these is reusable by every feature below:

- **Windows NVIDIA DLLs on Linux.** `pe_map` loads `nvaivpx.dll` and resolves 99 of 99 imports. The
  loader works around the Windows thread setup (TEB via `%gs`, which glibc does not use).
- **Host callback slots backed by real CUDA.** The DLL asks the host to allocate memory, load
  modules, look up functions, launch kernels and upload weights. We answer with real CUDA calls.
- **Launch capture.** Every `cuLaunchKernel` is logged with the kernel name, grid size and argument
  buffer, so the network's shape can be read from the log.
- **A whole ffmpeg chain in VRAM.** `vf_aivp_spike` goes NVDEC -> nv12 to RGBA -> DLL Process ->
  RGBA to nv12 -> NVENC. It makes zero per-frame copies between host and GPU and runs at 400 to
  440 fps at 960x540 -> 1920x1080.
- **GPU kernels without nvcc.** The colour conversion kernels are hand-written PTX, loaded with
  `cuModuleLoadData`.

## Features

| # | Feature | Source | Status | What it gives ffmpeg |
|---|---|---|---|---|
| 1 | RTX VSR (`vsr_drv_cuda`) | `nvaivpx.dll` / AIVP | Runs. 13 rounds of host-side work (TASK.md/TASK.L17.md) narrowed the blocker to L17's own constant bias term, not fixed. Stays on the table as an option; see status note below | Neural upscaling for 720p to 1080p/4K transcodes. The main target |
| 2 | Bypass resampler (`AIVP_FLAGS=0x100`) | same DLL | **Works**: 43.93 dB vs 41.66 dB bilinear, 0.08 ms/frame | A GPU scaler better than bilinear, usable now. The interim path while #1's neural output is unresolved |
| 3 | RTX Video HDR (TrueHDR, SDR to HDR) | `truehdr_drv_cuda` in the patch series | Not started | SDR library shown as HDR10 on HDR TVs. Stock ffmpeg has nothing like it |
| 4 | RTX Dynamic Vibrance (DeepDVC) | `deepdvc_drv_cuda` in the patch series | Not started | Neural colour and vibrance enhancement. Small and low risk |
| 5 | DLPP (`dlpp_drv_cuda`) | `nvdlppx.dll` | **In progress.** Now the active alternate route to real neural VSR, explored in parallel with #1, not a fallback held in reserve. Same host-callback/CUDA-launch pattern as AIVP; whether it hits the same kind of network-output blocker is not yet known | A second path to the same goal as #1: neural upscaling, in case AIVP's L17 blocker doesn't resolve |
| 6 | NGX DLISR | `nvngx_dlisr.dll` | Init works, stuck at the `CreateFeature` trap | Image SR on fixed 256x256 tiles. Mainly de-risking |
| 7 | Frame interpolation (NVOFFRUC / SmoothMotion) | patches 0010-0023 | Patches exist, never built | 24 to 48/60 fps motion smoothing on the GPU |

**RTX VSR (#1) status, 2026-09-23:** 13 host-side agent rounds (TASK.md Track B "L17 agent 1-13",
detail in `TASK.L17.md`) confirmed the network genuinely computes on real feature data, but L17's
output is dominated by its own constant bias term regardless of any argbuf field, field
combination, or allocation layout tried so far; no fix transfers between the two test frames. The
bypass path (#2) already beats bicubic and ships as the interim option; it does not replace this
goal. Two efforts are running in parallel to unblock it: DLPP (#5) as an alternate route to the
same neural-VSR goal, and a public-research pass checking whether documented NVIDIA behaviour
(Control Panel quality levels, driver-side gating) explains the blocker. Both are **in progress**;
this file will be updated once either reports back, not before.

## Shared infrastructure

- **A generic driver DLL filter.** `vf_aivp_spike` does not depend on the feature it runs: nv12/RGBA
  PTX, pooled surfaces and ffmpeg's CUDA stream. Features #3 to #6 would reuse it and supply only
  their own Process call and parameters.
- **A self-test and a driver hash gate.** Required before any of this ships. DLL offsets break when
  the driver updates, so the filter checks itself at startup and reports DEGRADED the way
  `vf_dlss.c` does.
- **The copy-count interposer as a standing check.** It proves the GPU-resident preset (TASK.md
  Track C) still holds for each new filter.
- **Capture, then codegen.** Once a network actually contributes to the output, the captured kernels
  and weights let us write our own filter that does not load the DLL. That removes the dependence on
  the driver version.
- **Vulkan <-> CUDA hwmap** (`vulkan-cuda-hwmap-task.md`). Lets these filters chain with the
  libplacebo passes without downloading frames to system RAM.

## Suggested order

1. **#2**, because it ships soonest.
2. **#1**, which means solving L17.
3. **#3 and #4**, which are cheap once the shared filter exists.
4. **#7**, the largest new capability.
5. **#5 and #6**, only as fallbacks if AIVP stays gated.

