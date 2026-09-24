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
2. **The colour-composition shader (not the forwarder itself) is unclearly licensed.** The forwarder
   DLL is `OptiScaler_DLSSNR`'s own original ~12KB shim, "contains no NVIDIA code," committed
   prebuilt because it rebuilds almost never. The actual licensing problem is one layer up: the pass
   that composes the model's output (`shaders/dlssnr/precompile/dlssnr.hlsl` - two-branch luminance
   ratio, OkLab hue correction, AP1 clamp) is explicitly "taken from RenoDX's DLSS 5 addon by
   clshortfuse... their design, reimplemented here with different names; that does not make it ours,"
   with a mandatory `RenoDX_ATTRIBUTION.txt` before any build is distributed - attribution-only, not
   a real license grant, still closed-source at the true source. (Not theirs, and fine: the OkLab
   matrices are Bjorn Ottosson's published constants, and the AP1/sRGB/PQ transforms are standard
   colour science - it's specifically the composition algorithm that's borrowed.) Not something to
   vendor here under this project's own "NOTHING FROM NVIDIA IS IN THIS REPOSITORY... always properly
   licensed" rule ([DLSS.md](../DLSS.md), [RTXDLPP.md](../RTXDLPP.md)).

The forwarder itself (`nvngx.dll_dlssnr.dll`) was inspected read-only (export table only, nothing
built against it): exports a small custom C API (`dlssnr_call_*`, `dlssnr_d3d11_*`, `dlssnr_vk_*`,
`dlssnr_last_ratio_*`, `dlssnr_query_scaling_ratio`) wrapping the underlying NGX calls - notably it
does carry a `dlssnr_vk_*` family, so the forwarder itself isn't D3D-only even though the wider
OptiScaler host application (`IFeature_VkwDx12.cpp` etc.) is Windows/D3D12-centric.

### What the caller check actually resolves against, and a real forwarder-free experiment

Read directly from `OptiScaler_DLSSNR`'s own source/docs (`forwarder/README.md`,
`FORWARDER_INVESTIGATION.md`), not inferred: the snippet calls `RtlPcToFileHeader` on its caller's
return address and rejects anything whose path does not contain `nvngx.dll` - the driver core itself
is `_nvngx.dll`, so it always passes its own check. A subtlety worth keeping if this is ever
revisited: the forwarder function must not tail-call the snippet (`return snippetFn(...)` becomes a
`jmp`, the forwarder's own stack frame disappears, and the snippet resolves the *forwarder's* caller
instead) - the result has to go into a `volatile` local first to keep the frame alive.

**There is a real forwarder-free path, already tried, that gets further than expected then hits a
different wall.** Instead of calling the snippet directly, call the *driver core's*
`NVSDK_NGX_D3D12_CreateFeature(18)` and let the core call the snippet - the snippet then sees the
core (`_nvngx.dll`) as its caller and the identity check passes for free, no forwarder needed. This
is reportedly how RenoDX itself avoids shipping a forwarder (it detours the core's own
Create/Evaluate). `OptiScaler_DLSSNR`'s own `DlssNr_Proxy.cpp`/`.h` is exactly this experiment
(`[DlssNr] UseProxy=true`, off by default).

Result, per `FORWARDER_INVESTIGATION.md`'s evidence log: **the proxy path is confirmed past the
caller check** (the core routes feature 18 at all, ruling out "unknown feature"), but fails later, at
feature creation, with `0xBAD0000B FAIL_UnableToInitializeFeature` - a real, different, downstream
failure, not the identity check. Disproven so far: a warm-up/retry race (20 attempts over ~1.3s, all
`0xBAD0000B`, stable not transient) and an app-id/SDK-version mismatch (`Init_Ext` reinit is
idempotent, returns the app's original ids unchanged). Untried, as of that log: whether the driver
core's snippet *search path* (set once at the game's own `Init`, not addable after) actually contains
wherever `nvngx_dlssnr.dll` sits; whether a discovery call
(`GetFeatureRequirements`/`UpdateFeature`) has to precede `CreateFeature` for this feature
specifically; whether `GetScratchBufferSize(18)` has to be satisfied first.

**Why this matters here**: it means "does the caller check apply outside D3D/Vulkan" is the wrong
question to keep asking in the abstract - the check is about *who the core thinks called it*, not
which API family. A CUDA-only integration calling the CUDA entry points directly (not through any
driver core acting on a game's behalf) would almost certainly hit the exact same
`RtlPcToFileHeader`-based rejection the D3D/Vulkan snippet calls hit, unspoofed, for the same reason
- there is no "CUDA is exempt" evidence anywhere in this investigation, only "routing through the
core instead of the snippet skips it, then something else stops you." That downstream blocker
(`0xBAD0000B`) is real, general, and still open even in OptiScaler's own maintained fork - not a
licensing problem, a genuine unsolved integration bug three plausible causes deep.

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

Two open questions, genuinely untested - read against the forwarder-free-experiment finding above,
the more useful framing is no longer "is CUDA exempt from the check" (nothing suggests it would be)
but "does routing through the driver core (which passes its own check for free) reach a CUDA feature
without a forwarder, and does that hit the same `0xBAD0000B`-class wall or a different one":

1. Has anyone tried calling `NVSDK_NGX_CUDA_CreateFeature` for feature 18 - either directly (almost
   certainly rejected, same `RtlPcToFileHeader` check, no evidence CUDA is special-cased) or via
   whatever the CUDA family's equivalent of "route through the core" would be, if one exists?
   Untested either way.
2. `~/dev/rtx-video-re`'s `loader_ngx` already runs a *different* NGX snippet DLL
   (`nvngx_dlisr.dll`, feature `ImageSignalProcessing`) live on Linux - maps it, runs `DllMain` to
   completion, gets a real value back from `NVSDK_NGX_GetSnippetVersion`. Same harness, untested
   against `nvngx_dlssnr.dll`'s CUDA path.

If a forwarder-free route into the CUDA path exists and clears whatever `0xBAD0000B`'s real cause
turns out to be, this becomes a real, cleanly-licensed filter (the DLL itself is a legitimate
NVIDIA driver artifact this project is licensed to use, same basis as `nvdlppx.dll`) built the same
way `oidn`/`optix`/`ort`/`fsr2` are - no forwarder, no third-party RenoDX shader. Realistically,
though, this project would still need to solve the exact same unsolved initialization failure
`OptiScaler_DLSSNR`'s own maintainers have not yet solved in their more mature, more-tested
codebase - not a smaller problem than theirs, the same one from a different entry point.

## `DLSS5VKLayer` (`bmitch87/DLSS5VKLayer`) - a real Linux transport, same licensed core underneath

A Linux Vulkan implicit layer plus a helper process (`dlssnr_helper.exe`, cross-built with
clang/mingw64, no Windows machine needed) that runs the real `nvngx_dlssnr.dll` under Wine/Proton,
bridging frames across the process boundary via shared memory and `VK_EXT_external_memory_dma_buf`
zero-copy where available. AGPL-3.0, experimental ("for local testing and research"), 32 commits,
113 stars at the time of this check. Does not redistribute NVIDIA files - same "user must supply"
convention this project already follows.

**Checked directly against the real source (`layer_linux/src/dlssnr/`), not trusted from a
summary**: this is not independent, cleanly-licensed code. It vendors `OptiScaler_DLSSNR` as
`third_party/optiscaler/` - same `DlssNr_Menu.cpp`/`DlssNr_Common.h` naming, same "reversible
proxy" concept as `OptiScaler_DLSSNR`'s own `FORWARDER_INVESTIGATION.md`, and a `dlssnr.hlsl`
that's a near-identical superset of `OptiScaler_DLSSNR`'s own shader (a few added constants for
HDR proxy/transfer), pointing at the same `third_party/optiscaler/RenoDX_ATTRIBUTION.txt`. The
AGPL-3.0 licence covers bmitch87's own layer/helper/transport code, not this vendored shader -
same RenoDX-derived, attribution-only situation as before, same likely caller-identity spoof and
`0xBAD0000B`-class wall inherited from the code it wraps (not independently re-verified this
session, but nothing in the source suggests it avoided that problem, only that it didn't need to
solve the *separate* problem of running the DLL on Linux at all).

**What's genuinely new and reusable here**: the Wine-hosted-helper-plus-zero-copy-transport
pattern for getting *any* Windows-only NGX DLL running on Linux at all, decoupled from whichever
feature it hosts. That's real prior art regardless of feature 18's own licensing wall, and could
matter for a future Windows-only NVIDIA DLL this project wants on Linux without a native `.so`.

## Not started

No filter file exists. Nothing committed. This is parked here rather than pursued further while
[gpu-only-filters.md](gpu-only-filters.md)'s optix→Vulkan→CUDA bridge-chain segfault (the
`optix,hwmap=derive_device=vulkan,hwmap=derive_device=cuda` crash, unrelated to the
`disable_multiplane` fix that solved the simpler nv12 case) is the active priority.
