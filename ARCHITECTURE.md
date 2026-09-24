# Architecture

What runs where, and on which GPU backend. This is a reference document, not a task list - see
`improvements.md` for open defects and measurements, `hw-resident-encode-plan.md` for the active
GPU-residency investigation this file's filter/backend map was pulled out of.

## Pipeline shape

One `-vf` chain, built by `UpscaleEngine.BuildChain` (`src/patcher/UpscaleEngine.cs`), in this
fixed order:

```
[decode: system memory, hwaccel deliberately suppressed - see UpscalePatches.cs]
  -> deblock (CPU-side node, source resolution, before anything that would amplify artefacts)
  -> denoise (CPU-side node OR Vulkan node, see per-filter backend below)
  -> neural SR (CPU-side node: vf_ort)
  -> game temporal upscaler (CPU-side node: vf_fsr2 / vf_dlss)
  -> hwupload (system memory -> Vulkan)
  -> [denoise/deblock Vulkan-hwframe variants land here instead, if selected]
  -> libplacebo (final resize, always; optionally FSRCNNX/RCAS/KrigBilateral/deband via
     custom_shader_path)
  -> hwdownload,format=yuv420p (Vulkan -> system memory)
  -> [hevc_nvenc encodes from system memory]
```

Every "CPU-side node" above is CPU-side only in FFmpeg's filter-graph sense (it consumes/produces
`format=gbrpf32le` planar-float system-memory AVFrames). Several of them do real GPU compute
internally via their own device context - see the table below. That distinction matters: it means
the chain round-trips GPU-to-system-memory-to-GPU at EVERY CPU-side node boundary, not just once.
A session running `denoise=optix` + `neural=ort` pays that round trip twice before it ever reaches
`hwupload`.

## Per-filter GPU backend

| Filter | Backend | Notes |
|---|---|---|
| `vf_optix.c` (`optix`, `optix-temporal` denoise) | **CUDA**, own `cu_ctx` | Zero Vulkan involvement. Reads/writes `AV_PIX_FMT_CUDA` hw frames directly (commit `61d6798`) - no more `cuMemcpyHtoD`/`cuMemcpyDtoH` round trip through system memory, reuses ffmpeg's own `AVCUDADeviceContext`. Verified: real decode->optix->NVENC run with no hwupload/hwdownload anywhere in the graph, 140 real frames, PSNR 47.7dB/SSIM 0.998 against source. This is Tier 1 item 2 for optix, done. |
| `vf_ort.c` (`ort` neural SR) | **CUDA** via ONNX Runtime `CUDA_V2` execution provider | Falls back to CPU if the CUDA EP is unavailable at session init (logged, not silent). Zero Vulkan involvement. Still reads/writes system-memory `gbrpf32le` frames - the `61d6798` hw-frame conversion was done for `optix` only; `vf_ort.c` is NOT yet converted. This is Tier 1 item 2's still-open half. |
| `vf_dlpp_rtcuda.c` (`dlpp_rtcuda`, opt-in neural SR route, see `RTXDLPP.md`) | **CUDA**, self-contained PE32+ loader hosting `nvdlppx.dll` at run time (`gu_dlpp_*` files) | Genuinely different architecture from every other row in this table: links no NVIDIA SDK at compile time, instead maps a user-supplied driver DLL directly. GPU-resident, verified zero per-frame host<->device copies at 113fps native 1080p->4K (commit `82bab39`). Opt-in (`WITH_RTXDLPP`), not in the mandatory five-filter list, not yet wired into `UpscaleEngine.Option()` or the plugin's 5-place checklist. |
| `vf_vsr_rtcuda.c` (`vsr_rtcuda`, opt-in fast resampler route, see `RTXVSR.md`) | **CUDA**, same PE32+ loader architecture hosting `nvaivpx.dll` at run time | Hardcoded to bypass mode only - the network path was removed entirely, not gated; AIVP's own neural path is dead (see `TASK.L17.md`, "Status: RETIRED"). GPU-resident (commit `fc999dd`). Opt-in (`WITH_RTXVSR`), not in the mandatory five-filter list, not yet wired into `UpscaleEngine.Option()` or the plugin's 5-place checklist. |
| `vf_dlss.c` (`dlss`, `dlaa` game upscalers) | **Vulkan**, explicitly - see the file's own header comment: "through NGX's Vulkan path" | Stays Vulkan - checked 2026-09-22 and the installed NGX SDK does not offer a CUDA path for this feature. `NGX_SDK/include/nvsdk_ngx_helpers_cuda.h` only wraps `NVSDK_NGX_Feature_ImageSignalProcessing` (DLISP, NVIDIA's older sharpen/denoise filter - a different feature from DLSS SR). `NVSDK_NGX_Feature_SuperSampling`, the feature `vf_dlss.c` actually uses, has helper wrappers only in `nvsdk_ngx_helpers_d3d.h` and `nvsdk_ngx_helpers_vk.h` - never CUDA, anywhere in this SDK. Binds to a single `VkDevice` per process (see the file's `ngx_claim` comment) - only one `dlss` instance can run at a time as a result. |
| `vf_fsr2.c` (`fsr2` game upscaler) | Vulkan compute, shares `gu_inputs.h` infrastructure with `vf_dlss.c` | |
| `vf_oidn.c` (`oidn`, `oidn-fast` denoise) | CPU by default; device selectable (`device=cpu/default/...`) | GPU-side OIDN was measured and deliberately not adopted - see `improvements.md`, "Already tested and deliberately not re-proposed." |
| `nlmeans_vulkan` (one of the `denoise=` levels) | **Vulkan**, stock FFmpeg filter | Runs on Vulkan hw frames, after `hwupload`, unlike the other denoise levels which are CPU-side nodes before it. |
| libplacebo (final resize + FSRCNNX/RCAS/KrigBilateral/deband shaders) | **Vulkan only** | No CUDA equivalent exists anywhere - GLSL shaders consumed by libplacebo's `custom_shader_path`. Every session hits this for the resize alone, shader or not. |

## GPU residency gaps (open investigation)

See `hw-resident-encode-plan.md` for the full writeup, findings so far:

1. **Vulkan output -> NVENC**: `hwdownload,format=yuv420p` before encode is a real, confirmed gap
   in FFmpeg itself (`hwcontext_vulkan.c`'s `vulkan_map_from()` has no `AV_PIX_FMT_CUDA` case, in
   any FFmpeg release including `master` - not a driver/config issue, checked against source).
   Smoke-tested and confirmed failing on CT114, 2026-09-22.
2. **Every CPU-side node boundary**: bigger in aggregate than (1). Each of `oidn`/`optix`/`ort`/
   `fsr2`/`dlss` round-trips system memory independently, regardless of (1). Not yet measured.
3. **CUDA-to-CUDA sidestep**: `optix` now reads/writes `AV_PIX_FMT_CUDA` hw frames directly
   (commit `61d6798`, see the table above) - the `vf_optix.c` half of this is done, not just
   scoped. `vf_ort.c` is NOT yet converted, so an `optix`+`ort` chain still round-trips system
   memory at the `ort` boundary. Separately, and not part of the original `optix`/`ort` framing
   this item was written for: `optix` + `dlpp_rtcuda` + `vsr_rtcuda` (commits `61d6798`, `82bab39`,
   `fc999dd`) is a three-filter chain that is ALL CUDA-native already - no FFmpeg core patch and,
   per the correction below, no Vulkan-CUDA interop of any kind needed for that specific chain.
   Stock `scale_cuda` in place of `libplacebo` for the final resize is still not done for any
   chain. `dlpp_rtcuda`/`vsr_rtcuda` are not yet wired into `UpscaleEngine` (see `TASK.md`,
   `INTEGRATION_DESIGN.md`), and running both hosted-DLL loaders alive in the same process at once
   is explicitly UNVERIFIED - every test so far ran exactly one of the two.

None of the three has a measurement yet of how much wall-clock time it would actually recover.
Per this project's own discipline (`improvements.md`, "Measure first"), that should happen before
code is written for any of them.

## Full GPU-resident pipeline: the honest tiering

"Do everything on the GPU, decode to encode, no system-memory round trips anywhere" splits into
two problems with very different cost, not one:

### Tier 1 - buildable today, no FFmpeg core patch

Covers sessions using only CUDA-native filters (`optix`, `ort`) plus a plain resize - no
FSRCNNX/RCAS/deband/chroma/dlss/fsr2.

1. Decode-side hwaccel is currently suppressed UNCONDITIONALLY (`HwaccelTypePostfix` /
   `HardwareVideoDecoderPostfix` in `UpscalePatches.cs` drop `-hwaccel` and the hw decoder for
   every acted-on session, regardless of what's in the chain - see `improvements.md` Throughput
   item 5, `[M]`, not yet done). Switch to `-hwaccel cuda -hwaccel_output_format cuda` for the
   sessions this tier covers.
2. Rewrite `vf_optix.c` and `vf_ort.c` to read/write `AV_PIX_FMT_CUDA` hw frames (a `CUdeviceptr`
   already inside an `AVHWFramesContext`) instead of system-memory `format=gbrpf32le` AVFrames.
   Both already run their own CUDA context internally (see the table above) - this replaces
   "download input to system memory, then the filter re-uploads it" with "read the incoming
   device pointer directly." Scoped to files this project already owns and patches per-file.
   **`vf_optix.c`'s half is DONE (commit `61d6798`)**, verified with a real decode->optix->NVENC
   run, no hwupload/hwdownload anywhere in the graph, 140 real frames, PSNR 47.7dB/SSIM 0.998.
   `vf_ort.c`'s half is still open - not converted, still round-trips system memory.
3. Final resize via stock `scale_cuda` instead of `libplacebo=` for this session shape. Still not
   done for any chain.

Result for the session shape this tier targets: zero system-RAM touches, decode to encode. No
FFmpeg upstream patch needed anywhere in this tier.

**A second, separately-arrived instance of Tier 1 residency exists today**: `optix` +
`dlpp_rtcuda` + `vsr_rtcuda` (commits `61d6798`, `82bab39`, `fc999dd`) is a three-filter chain
that is entirely CUDA-native - `dlpp_rtcuda` and `vsr_rtcuda` each host their driver DLL via their
own PE loader and never touch Vulkan (see the backend table above). Per the correction in
`INTEGRATION_DESIGN.md`, made after that doc's first draft: because `vf_optix.c` is now also pure
CUDA, this three-filter chain needs NO Vulkan-CUDA bridge at all, unlike the `optix`/`ort` pairing
this section was originally scoped around. The broken Vulkan-CUDA interop documented in Tier 2
below only blocks combining these three with the Vulkan-only stages (`sr`/`refine`/`chroma`/
`deband`/`kernel`, `dlss`, `fsr2`), not the CUDA chain itself. Two things still stand between this
and a shipped feature: `dlpp_rtcuda`/`vsr_rtcuda` are not wired into `UpscaleEngine` or the
plugin's 5-place checklist yet (see `TASK.md`, `INTEGRATION_DESIGN.md`), and running both hosted
loaders alive in the same ffmpeg process has never been tested - every test so far ran exactly one
of the two.

### Tier 2 - blocked on the Vulkan-CUDA interop gap, or a much larger fork

Any session touching the Vulkan-only stage - FSRCNNX, RCAS, deband, chroma upscaling via
libplacebo, or `dlss`/`fsr2` - crosses Vulkan<->CUDA twice (once on the way in if decode or a
prior filter is CUDA, once on the way out to NVENC). That's the exact gap documented above and in
`hw-resident-encode-plan.md`: FFmpeg's `hwcontext_vulkan.c` has no Vulkan-to-CUDA `hwmap` case, in
any release including `master`.

Two ways past it, both substantial, neither started:

- **Write the `hwcontext_vulkan.c` patch** (see `hw-resident-encode-plan.md` for the full scoping
  and risk discussion - it's shared plumbing under every Vulkan-touching filter here).
- **Port the Vulkan-only stages to CUDA**: FSRCNNX/RCAS/deband/KrigBilateral as CUDA kernels
  instead of GLSL shaders, `vf_dlss.c` switched from NGX's Vulkan path to NGX's CUDA path. This
  is not a patch - it's replacing libplacebo's role in this project's SR ladder, which is most of
  what makes this project's picture quality distinctive today (see README.md's measurements).
  Nobody should start this without deciding it's worth losing/rebuilding what libplacebo
  currently provides.
  **The `vf_dlss.c` half of this is closed, not just unscoped**: checked on CT114 2026-09-22, the
  installed NGX SDK (`NGX_SDK=/root/gameupscale/dlss`) does not ship a CUDA entry point for
  `NVSDK_NGX_Feature_SuperSampling` (DLSS SR/DLAA) at all - only D3D11/D3D12/Vulkan helper
  wrappers exist for that feature. The SDK's CUDA helper (`nvsdk_ngx_helpers_cuda.h`) covers only
  `NVSDK_NGX_Feature_ImageSignalProcessing` (DLISP, a distinct legacy sharpen/denoise feature).
  The low-level `NVSDK_NGX_CUDA_CreateFeature(NVSDK_NGX_Feature, ...)` entry point takes a generic
  feature-ID enum so it will compile against `Feature_SuperSampling`, but nothing in the shipped
  headers, helper wrappers or README establishes that the feature's redistributable
  (`libnvidia-ngx-dlss.so.310.9.1`) actually implements a CUDA execution path for it - calling it
  would be guessing at an unshipped API, which this project's own discipline rules out. If this
  reopens, it needs either a newer NGX SDK release that documents CUDA support for
  `Feature_SuperSampling`, or the `hwcontext_vulkan.c` interop patch above instead.

Tier 2 has not been scoped into a build task. Tier 1 is partially done, not merely scoped: the
`optix` hw-frame conversion (item 2's `optix` half, commit `61d6798`) is verified, and a second
CUDA-native instance (`optix`+`dlpp_rtcuda`+`vsr_rtcuda`) now exists outside this section's
original framing. What remains of Tier 1 - `vf_ort.c`'s conversion, `scale_cuda` for the final
resize, and wiring the two new filters into `UpscaleEngine` - is the practical next step if GPU
residency is worth pursuing further; it is real, bounded, and answers the "does this even matter"
question before anyone touches Tier 2's shared risk.

## Web client: real ES modules, bundled at build time

This file covers server-side GPU/filter architecture; the browser-side panel (`web/`) has its own
module structure, documented where it is maintained rather than duplicated here: `CLAUDE.md`'s
"Before you change the client" section for the file-by-file layout, `context-map.md` at the repo
root for the full module/export/import list, and `WEB_PANEL_DESIGN.md` section 9/9.1 for how it got
there. In one line: `web/src/{lib,model,controller,view}/*.js` and `web/src/bootstrap.js` are real
ES modules, bundled by esbuild (build-time only, see `scripts/build-web-panel.sh`) into the single
plain IIFE (`web/gpu-upscale.js`) that `scripts/jellyfin-gpuupscale-webinject` publishes - no ES
module support is needed, or used, at runtime in the browser.

## Deployment: binary selection is per-invocation, not per-restart

The real production shim (`/usr/local/bin/jellyfin-ffmpeg-upscale` on CT114, not in this repo; see
`shim/jellyfin-ffmpeg-upscale` for the local counterpart with the `PATCHED_FILTERS` tuple) re-probes
the patched binary's filter list on every invocation, keyed by the binary's mtime/size, and fails
open to stock ffmpeg on any problem. A rebuilt binary therefore goes live for real sessions the
moment it's staged - **no Jellyfin restart is needed for an ffmpeg binary swap to take effect.**
Confirmed on a real CT114 production build that swapped in the `61d6798` optix fix alongside all
seven filters (`oidn`, `optix`, `ort`, `fsr2`, `dlss`, `dlpp_rtcuda`, `vsr_rtcuda`), verified present
via `-filters`, `.prev` backup preserved. This matters for deployment-risk reasoning: a binary swap
is live immediately, but a filter is only *reachable* once the shim's own `PATCHED_FILTERS` tuple
names it - `dlpp_rtcuda` and `vsr_rtcuda` are compiled in today but not yet in that tuple, so they
are live-swappable but not yet reachable from real sessions.

## Explored and blocked, then retired: NVIDIA Maxine VFX SDK (`vf_vsr.c`)

**RETIRED 2026-09-23** as a neural target - see `VSR.md`'s RETIRED banner. This section's original
text below is now stale in one respect and is kept for history, corrected here: the SDK's access
gate was resolved (an NGC key was obtained and used on CT114), `vf_vsr.c` was in fact written
against the real installed headers, and it builds, links and registers correctly in `ffmpeg
-filters`. The actual, still-standing blocker is that NVIDIA's NGC catalog ships zero TensorRT
model files for this feature on any GPU architecture - not a licensing or access problem. The build
flag was renamed `WITH_VSR` -> `WITH_MAXINE_VSR` (refuses to build without `MAXINE_VSR_UNRETIRE=1`)
so it can't be confused with RTX VSR (`vsr_rtcuda`, see `RTXVSR.md`), which is the live target now
under Track C in `TASK.md` and does NOT depend on Maxine or its missing models.

Original framing, for context: a candidate `vf_vsr.c` wrapping Maxine's Video Super Resolution
effect (`NVVFX_FX_VIDEO_SUPER_RES`) was investigated as a pure-CUDA alternative to `vf_dlss.c` for
plain video (no synthesised motion vectors/depth/jitter needed, unlike DLSS/FSR2) - would have been
Tier-1-shaped, chainable with `vf_optix.c`/`vf_ort.c` via `AV_PIX_FMT_CUDA` hw frames. Full detail
in `VSR.md`.
