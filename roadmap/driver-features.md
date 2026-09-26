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
- **GPU kernels without nvcc.** The colour conversion kernels are real CUDA C (`.cu`, e.g.
  `gu_dlpp_nv12_rgba.cu`) compiled to PTX with clang's NVPTX backend and loaded with
  `cuModuleLoadData`. They handle both NV12 and p010le, so 10-bit/HDR sources work.
- **Filters that host the driver DLLs live inside the patched ffmpeg.** `dlpp_rtcuda` and
  `vsr_rtcuda` map `nvdlppx.dll` / `nvaivpx.dll` at run time through our own PE32+ loader
  (`gu_*_pe_map.c`). Nothing from NVIDIA is in the repo; the DLLs are user-supplied. Both DLLs
  coexist in one ffmpeg process, verified in a combined `optix` + `dlpp_rtcuda` + `vsr_rtcuda`
  chain.

## Features

| # | Feature | Source | Status | What it gives ffmpeg |
|---|---|---|---|---|
| 1 | RTX VSR as a neural upscaler (`vsr_drv_cuda`) | `nvaivpx.dll` / AIVP | **Retired as a neural target, 2026-09-23** (user decision). 16 agent rounds (TASK.L17.md) never got the network to contribute real detail; L17's constant bias term dominated. AIVP wraps DLPP's network internally, so real neural SR goes through #5 instead | Nothing further planned. Do not pursue L17 |
| 2 | Bypass resampler, shipped as `vsr_rtcuda` (`AIVP_FLAGS=0x100`) | same DLL | **Works, deployed on CT114** (2026-09-24). 43.93 dB vs 41.66 dB bicubic, 0.08 ms/frame, GPU-resident. Opt-in via `WITH_RTXVSR=1`, not in the mandatory five | A GPU scaler better than bicubic. Also the conform-resize that DLPP levels 3/4 chain into. Not neural |
| 3 | RTX Video HDR (TrueHDR, SDR to HDR) | `truehdr_drv_cuda` in the patch series | Not started | SDR library shown as HDR10 on HDR TVs. Stock ffmpeg has nothing like it |
| 4 | RTX Dynamic Vibrance (DeepDVC) | `deepdvc_drv_cuda` in the patch series | Not started | Neural colour and vibrance enhancement. Small and low risk |
| 5 | DLPP, shipped as `dlpp_rtcuda` | `nvdlppx.dll` | **Works, deployed on CT114** (2026-09-24), and reachable from the panel as one "RTX DLPP" entry with a Level control (commit e7952b9). Real cross-frame gain over bicubic once two harness bugs were fixed (wipe field forced to 0.0, native-scale derived from the output/input ratio). Level 4 at the correct scale: 37.48 dB vs 34.81 dB at the wrong scale. Levels 3/4 segfault on a non-integer ratio taken alone, so they chain into `vsr_rtcuda` for the final resize. p010le fixed and verified on the production binary. Opt-in via `WITH_RTXDLPP=1`. Still open: the "known open" items in TASK.md "Track B: DLPP" and `INTEGRATION_DESIGN.md`. `dlpp_drv_cuda` (capture + codegen, patch 0006) is a separate Route B, not started | The real neural upscaling path. Replaces #1 as the main target |
| 6 | NGX DLISR | `nvngx_dlisr.dll` | Init works, stuck at the `CreateFeature` trap. Decided: user-supplied DLL, same convention as `nvdlppx.dll`/`nvaivpx.dll` and the DLSS runtime - never fetched or vendored by us, no forwarder/spoof needed since this is a documented feature (`nvsdk_ngx_helpers_cuda.h` wraps `NVSDK_NGX_Feature_ImageSignalProcessing` legitimately) | Image SR on fixed 256x256 tiles. Mainly de-risking |
| 7 | Frame interpolation (NVOFFRUC / SmoothMotion) | patches 0010-0023 | Patches exist, never built | 24 to 48/60 fps motion smoothing on the GPU |

**Where the neural goal landed, 2026-09-25:** the AIVP route (#1) was retired on 2026-09-23 after
16 rounds. DLPP driven directly (#5) went around the blocker: AIVP's kernels are internally named
`dlpp_*`, so it is a wrapper around DLPP's network, and its wrapper never sets the two fields DLPP
needs. With those fixed, DLPP gives a real gain over bicubic. Both filters are built into the
production ffmpeg (all seven filters confirmed via `-filters`: the mandatory five plus
`dlpp_rtcuda` and `vsr_rtcuda`) and deployed. Both are opt-in, outside the mandatory five. Still
not started: #3, #4, #7. #6 is stuck at `CreateFeature`.

## Shared infrastructure

- **A generic driver DLL filter.** `vf_aivp_spike` does not depend on the feature it runs: nv12/RGBA
  PTX, pooled surfaces and ffmpeg's CUDA stream. `dlpp_rtcuda` and `vsr_rtcuda` are the two
  productised instances (each with its own copy of the loader so neither build depends on the
  other). Features #3, #4 and #6 would reuse the same pattern and supply only their own Process
  call and parameters.
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

1. **#2 and #5**: done, deployed.
2. **#3 and #4**, which are cheap now that the DLL-hosting filter pattern is proven twice.
3. **#7**, the largest new capability.
4. **#6**, low priority: image SR on fixed tiles, mainly de-risking.
5. **#1**: retired, not scheduled.

