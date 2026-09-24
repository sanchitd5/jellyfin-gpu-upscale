# DLSS Neural Rendering ("DLSS5") — investigated, not started

Part of the [roadmap](README.md). Not the same thing as [gpu-only-dlss.md](gpu-only-dlss.md), which
covers the existing `vf_dlss` (Super Resolution/DLAA, NGX feature 1) Vulkan rewrite. This file is
about a different, newer NGX feature entirely.

**Status: investigated over several sessions, real findings, nothing built, nothing committed.**

## What "DLSS5" actually is

Not an NVIDIA SDK release. NVIDIA's own public DLSS SDK (`github.com/NVIDIA/DLSS`, the same repo
[DLSS.md](../DLSS.md) already points at) is still at `v310.9.1` as of this investigation - no
newer/transformer-model tag exists there.

"DLSS5" is community jargon for **NGX feature ID 18**, internally `nvngx_dlssnr.dll`
("DLSS Neural Rendering") - a real component NVIDIA ships inside the Windows Game Ready driver
(confirmed present in driver 616.92's `Display.Driver/` payload, extracted via
`~/dev/rtx-video-re`, same licensed-extraction convention this project already uses for
`nvdlppx.dll`/`nvaivpx.dll`), but gated to first-party titles and undocumented publicly.

## The two real walls found

1. **A caller-identity spoof is the only known way in.** NGX's own snippet for this feature
   "resolves the module that owns its caller's return address and refuses any whose path does not
   contain `nvngx.dll`" (confirmed from the `OptiScaler_DLSSNR` fork's own source/docs, branch
   `dlss-neural-rendering`, `OptiScaler/dlssnr/`). Every known working integration (`DLSS5-Autopilot`,
   `renodx-dlss5`, `OptiScaler_DLSSNR`) ships a forwarder DLL (`nvngx.dll_dlssnr.dll`, ~13KB, no
   NVIDIA code in it) whose only job is satisfying that path check.
2. **The forwarder's own colour-composition code is unclearly licensed.** `OptiScaler_DLSSNR`'s own
   docs credit it as "taken from RenoDX's DLSS 5 addon by clshortfuse" - closed-source, no published
   licence, sourced from a community mirror. Not something to vendor here under this project's own
   "NOTHING FROM NVIDIA IS IN THIS REPOSITORY... always properly licensed" rule
   ([DLSS.md](../DLSS.md), [RTXDLPP.md](../RTXDLPP.md)).

The forwarder itself (`nvngx.dll_dlssnr.dll`) was inspected read-only (export table only, nothing
built against it): exports a small custom C API (`dlssnr_call_*`, `dlssnr_d3d11_*`, `dlssnr_vk_*`,
`dlssnr_last_ratio_*`, `dlssnr_query_scaling_ratio`) wrapping the underlying NGX calls - notably it
does carry a `dlssnr_vk_*` family, so the forwarder itself isn't D3D-only even though the wider
OptiScaler host application (`IFeature_VkwDx12.cpp` etc.) is Windows/D3D12-centric.

## What's actually promising, not yet tested

The **real** `nvngx_dlssnr.dll` (165MB, the genuine NVIDIA artifact, not the third-party forwarder)
exports the full standard public NGX API surface on all four families:

```
NVSDK_NGX_CUDA_{CreateFeature,CreateFeature1,EvaluateFeature,GetFeatureRequirements,
  GetScratchBufferSize,Init,Init1,Init_Ext,Init_Ext1,PopulateParameters_Impl,
  ReleaseFeature,Shutdown,Shutdown1}
NVSDK_NGX_D3D11_*   (same set)
NVSDK_NGX_D3D12_*   (same set)
NVSDK_NGX_VULKAN_*  (same set)
```

Same shape already proven callable via plain `dlopen`/`dlsym` for the older SR runtime
(`libnvidia-ngx-dlss.so.310.9.1`, feature 1) - see [gpu-only-dlss.md](gpu-only-dlss.md)'s caveat,
now with real counter-evidence that the CUDA family is public API, not D3D/Vulkan-only.

Two open questions, genuinely untested:

1. **Does the caller-identity spoof even apply to the CUDA entry points**, or only to how the
   D3D/Vulkan paths get authorized for game engines? Nobody has tried calling
   `NVSDK_NGX_CUDA_CreateFeature` for feature 18 directly, unspoofed, and checked whether it's
   refused.
2. `~/dev/rtx-video-re`'s `loader_ngx` already runs a *different* NGX snippet DLL
   (`nvngx_dlisr.dll`, feature `ImageSignalProcessing`) live on Linux - maps it, runs `DllMain` to
   completion, gets a real value back from `NVSDK_NGX_GetSnippetVersion`. Same harness, untested
   against `nvngx_dlssnr.dll`'s CUDA path.

If the CUDA path doesn't need the spoof, this becomes a real, cleanly-licensed filter (the DLL
itself is a legitimate NVIDIA driver artifact this project is licensed to use, same basis as
`nvdlppx.dll`) built the same way `oidn`/`optix`/`ort`/`fsr2` are - no forwarder, no third-party
RenoDX code, no spoofing. If it does need the spoof, this stays blocked on the same licensing
problem as every third-party DLSSNR integration found so far.

## Not started

No filter file exists. Nothing committed. This is parked here rather than pursued further while
[gpu-only-filters.md](gpu-only-filters.md)'s optix→Vulkan→CUDA bridge-chain segfault (the
`optix,hwmap=derive_device=vulkan,hwmap=derive_device=cuda` crash, unrelated to the
`disable_multiplane` fix that solved the simpler nv12 case) is the active priority.
