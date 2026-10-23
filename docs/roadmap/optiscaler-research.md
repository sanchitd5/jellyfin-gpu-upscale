# OptiScaler background (upstream, not the DLSSNR fork)

Part of the [roadmap](README.md). Background research only - nothing here is built or planned as a
task. See [dlss-neural-rendering.md](dlss-neural-rendering.md) for the DLSS-Neural-Rendering-specific
findings (that file covers the `Dagherbou/OptiScaler_DLSSNR` fork in depth); this file covers the
real upstream project more broadly, for whatever general prior-art value it has to this project's
own NGX-calling-convention and DLL-hosting work.

**Status: research only, no code touched.**

## What it is, and its real license

`optiscaler/OptiScaler` on GitHub - **GPL-3.0**, 11,000+ stars, actively maintained (stable and
nightly releases, a Discord, a wiki). This is the real, mainline, legitimately-licensed project; the
`Dagherbou/OptiScaler_DLSSNR` fork investigated separately is a fork of it that adds the
not-upstream, not-merged DLSSNR module.

Its own description: "bridges upscaling/frame gen across GPUs. Supports DLSS2+/XeSS/FSR2+ inputs,
replaces native upscalers, enables FSR-FG/XeFG on non-FG titles." Mechanism, in its own words:
"OptiScaler acts as a middleware, it intercepts upscaler calls from the game (**Inputs**) and
redirects them to the chosen upscaling backend (**Output**)."

## Hooking mechanism

DLL proxying, not IAT patching or a runtime hook library alone (though Microsoft Detours ships
vendored under `OptiScaler/include/detours` and is used for finer-grained interception once loaded).
The proxy shape: `OptiScaler.dll` gets placed next to the game's executable renamed to one of several
real system/vendor DLL names the game already loads -
`dxgi.dll`/`winmm.dll`/`version.dll`/`dbghelp.dll`/`d3d12.dll`/`wininet.dll`/`winhttp.dll` - or as
`nvngx.dll` itself (replacing the driver's own NGX loader for that process), or a `.asi` for games
using an ASI loader. Windows' own DLL search order does the rest; the game loads what it thinks is
the system DLL and gets OptiScaler instead. `OptiScaler/proxies/*.h` (`NVNGX_Proxy.h`,
`Dxgi_Proxy.h`, `D3D12_Proxy.h`, `FfxApi_Proxy.h`, `XeSS_Proxy.h`, etc.) forward the real calls
through to the genuine system/vendor DLL once OptiScaler has done its interception.

## Vendor/hardware spoofing is a separate concern from the DLSSNR caller-identity spoof

Worth keeping distinct - two unrelated things both get called "spoofing" in this space:

1. **GPU-vendor spoofing** (`Spoofing.md`, OptiScaler's own doc): making a non-NVIDIA GPU (or a
   non-RTX NVIDIA GPU) pass a game's own hardware-vendor check so it *offers* DLSS as an option at
   all - DXGI/Vulkan adapter ID spoofing (report as e.g. "RTX 4090"), NVAPI call spoofing
   (`FakeNvapi`), all built into OptiScaler and documented, and on Linux delegated to Wine/DXVK's own
   config (`dxvk.conf` vendor-ID overrides, `PROTON_FORCE_NVAPI=1` for Proton). This is about what
   GPU the game *thinks* it's talking to.
2. **NGX caller-identity spoofing** (the DLSSNR-specific mechanism covered in
   [dlss-neural-rendering.md](dlss-neural-rendering.md)): the driver's own NGX snippet checking which
   *module* called it, independent of GPU vendor entirely - this is real regardless of whether the
   GPU checks in (1) already passed.

Neither is present in this project's own filters; noted here only so a future reader doesn't conflate
the two when re-reading either doc.

## `IFeature` architecture - real, consistent, useful prior art for NGX calling conventions

`OptiScaler/upscalers/` has a genuine common interface: `IFeature.h`/`.cpp` (the base), then
`IFeature_Dx11`/`IFeature_Dx12`/`IFeature_Vk`/`IFeature_Dx11wDx12`/`IFeature_VkwDx12` (the API-family
and cross-API-bridge variants), with a `FeatureProvider_Dx11`/`_Dx12`/`_Vk` factory layer selecting a
backend. Backends live one directory per vendor/feature: `dlss/`, `dlssd/` (Ray Reconstruction),
`ffx/`, `fsr2/`, `fsr2_212/`, `fsr31/`, `xess/` - no `dlssnr/` in mainline (confirms DLSSNR really is
unmerged, fork-only, matching the other file's finding).

**The `dlss/` backend (ordinary DLSS Super Resolution, NGX feature 1) is real, working, legitimately
licensed reference code** - `DLSSFeature.cpp`/`.h` plus per-API `DLSSFeature_Dx11`/`_Dx12`/`_Vk`.
Read directly: it drives the model through the ordinary, documented `NVSDK_NGX_Parameter` Set/Get
interface (`InParameters->Set(NVSDK_NGX_Parameter_Sharpness, ...)`,
`NVSDK_NGX_Parameter_DLSS_Feature_Create_Flags`, render/target/display resolution getters) - no
spoofing, no forwarder, because feature 1 isn't gated the way feature 18 is. This is directly useful
prior art for this project's own open question in
[gpu-only-dlss.md](gpu-only-dlss.md) about a possible CUDA-native `vf_dlss` path: a real, GPL-3.0,
maintained example of the exact `NVSDK_NGX_Parameter` vtable-style interface an earlier session's fork
in this project flagged as the next thing to wire up (buffer/stream/dimension passing) after
confirming the CUDA export table is real and callable.

## Platform: Windows-only, Linux support means Wine/Proton, not a native build

`setup_linux.sh` at the repo root is for installing OptiScaler *into a Wine/Proton prefix* for Linux
gamers running Windows games - not a native Linux build of OptiScaler itself. Its own `Spoofing.md`
confirms this: the "Linux" section is entirely about Wine/DXVK's *own* built-in spoofing mechanisms
(`dxvk.conf`, `PROTON_FORCE_NVAPI`), not anything OptiScaler does natively on Linux. Nothing in the
codebase suggests a portable/native-Linux build target exists or is planned. So: no code here is
directly reusable in this project (a native Linux ffmpeg filter, no Wine, no game process to inject
into) - the value is purely in the calling-convention/architecture knowledge (the `IFeature`
interface shape, the `NVSDK_NGX_Parameter` usage pattern in `dlss/`), not in any portable source.

## Maturity / reputation signal

GPL-3.0, 11,000+ GitHub stars, active Discord and wiki, stable + nightly release channels, GitHub
Sponsors / Buy Me a Coffee funding - a real, widely-used, actively maintained project, not a fringe
tool. This maturity is specifically about the *mainline* project (game-upscaler-swapping via DLL
proxying); it does not extend to the separate, unmerged, RenoDX-sourced DLSSNR module covered in
[dlss-neural-rendering.md](dlss-neural-rendering.md), which remains its own, less-settled thing with
its own open licensing question and its own open technical blocker (`0xBAD0000B`).
