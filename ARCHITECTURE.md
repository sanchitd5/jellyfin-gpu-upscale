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
| `vf_optix.c` (`optix`, `optix-temporal` denoise) | **CUDA**, own `cu_ctx` | Zero Vulkan involvement. Pushes/pops its own CUDA context per frame. |
| `vf_ort.c` (`ort` neural SR) | **CUDA** via ONNX Runtime `CUDA_V2` execution provider | Falls back to CPU if the CUDA EP is unavailable at session init (logged, not silent). Zero Vulkan involvement. |
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
3. **CUDA-to-CUDA sidestep**: `optix` and `ort` are already pure CUDA and could in principle chain
   `AV_PIX_FMT_CUDA` hw frames directly between each other, and use stock `scale_cuda` instead of
   `libplacebo` for the final resize when no Vulkan-only shader (FSRCNNX/RCAS/deband/chroma/dlss/
   fsr2) is requested - staying 100% CUDA end to end for that session shape, no FFmpeg core patch
   needed. Not yet scoped or measured; only covers sessions that skip the Vulkan-only shader
   ladder entirely.

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
3. Final resize via stock `scale_cuda` instead of `libplacebo=` for this session shape.

Result: zero system-RAM touches, decode to encode, for that session shape. No FFmpeg upstream
patch needed anywhere in this tier.

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

Neither tier has been scoped into a build task yet. Tier 1 is the practical next step if GPU
residency is worth pursuing at all - real, bounded, and answers the "does this even matter"
question before anyone touches Tier 2's shared risk.

## Explored and blocked: NVIDIA Maxine VFX SDK (`vf_vsr.c`, not written)

A candidate `vf_vsr.c` wrapping Maxine's Video Super Resolution effect (`NVVFX_FX_SUPER_RES`) was
investigated as a pure-CUDA alternative to `vf_dlss.c` for plain video (no synthesised motion
vectors/depth/jitter needed, unlike DLSS/FSR2) - would have been Tier-1-shaped, chainable with
`vf_optix.c`/`vf_ort.c` via `AV_PIX_FMT_CUDA` hw frames. Stopped at Step 0: the SDK's open headers
are public and MIT, but the trained models and runtime library are gated behind an NGC/NVIDIA
Developer Program login this session doesn't have - no code was written. Full detail in `VSR.md`.
