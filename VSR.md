# NVIDIA Maxine VFX SDK - Video Super Resolution, and why it doesn't run yet

Status: **code exists (`ffmpeg/vf_vsr.c`, patch `0005`), builds and registers, but cannot be
verified end-to-end.** Not a licensing or access blocker anymore - see below. NVIDIA's own NGC
catalog currently ships zero TensorRT model files for this feature, for any GPU architecture.
`NvVFX_Load` is expected to fail until that changes.

## What this is

NVIDIA's Maxine VFX SDK ships a Video Super Resolution effect (`NVVFX_FX_VIDEO_SUPER_RES`, string
`"VideoSuperRes"` - corrected from the public GitHub mirror's `"SuperRes"`, see below) that is
**pure CUDA** - `NvCVImage` buffers in `NVCV_CUDA` memory, every transfer/run call takes an
explicit `CUstream`, no D3D11 or Vulkan anywhere in the SDK. Genuinely different GPU-residency
shape from every other SR path in this project: same category as `vf_optix.c`/`vf_ort.c`, targets
plain recorded video with no synthesised motion vectors/depth/jitter the way `vf_dlss.c`/
`vf_fsr2.c` need. Full rationale and confirmed API surface (as first read from the public GitHub
mirror) in `vfx-sdk-vsr-task.md`.

## SDK acquisition - resolved

The SDK Core package and the `nvvfxvideosuperres` feature package are both on CT114 now, placed by
hand under `/root/gameupscale/vfx/`:

- `/root/gameupscale/vfx/VideoFX/` - Core package v1.3.0.0 (`include/nvVideoEffects.h`,
  `nvCVImage.h`, `nvCVStatus.h`; `lib/libVideoFX.so.1.3.0`, `libNVCVImage.so`, `libnvngxruntime.so`)
- `/root/gameupscale/vfx/nvvfxvideosuperres/` - the VideoSuperRes feature package
  (`include/nvVFXVideoSuperRes.h`, `lib/libnvVFXVideoSuperRes.so`,
  `lib/libnvidia-ngx-vsr.so.1.8.3`)
- An NGC personal API key (`nvapi-...`) is configured at `/root/.ngc/config` on CT114 - this is
  what made the checks below possible non-interactively.

**The headers shipped in this NGC release differ from the public GitHub MIT mirror
(`github.com/NVIDIA-Maxine/Maxine-VFX-SDK`) in two ways that would have been guessed wrong from the
mirror alone:**

- the effect selector string is `"VideoSuperRes"`, not `"SuperRes"` as the mirror's naming
  suggested;
- quality is not a generic on/off mode - it's `NVVFX_QUALITY_LEVEL`, an integer selecting a named
  ladder (`VSR_Bicubic` .. `VSR_Ultra`, plus `STREAMING_MEDIUM`/`STREAMING_ULTRA` on Ampere+),
  confirmed against NVIDIA's filter reference doc
  (`docs.nvidia.com/maxine/vfx/latest/Filters/VideoSuperResolution.html`) since the header only
  gives the selector string, not the value enumeration.

`ffmpeg/vf_vsr.c` was written against these real, installed headers, not the mirror.

## The actual blocker: NGC has no models for this feature, on any GPU

`VideoFX/features/install_feature.sh` is NVIDIA's own installer: authenticates with the API key,
auto-detects GPU compute capability, downloads the feature library, then downloads the
GPU-appropriate TensorRT model files. Run non-interactively on CT114 with the configured key:

```
./install_feature.sh -f nvvfxvideosuperres
  -> Auto-detected GPU Compute capability = 86 (RTX 3090, correct)
  -> Authentication successful
  -> SUCCESS: Feature library installed
  -> NOTE: No models found for nvvfxvideosuperres SM86 (this is normal for some features)
  -> TensorRT models installed: 0
```

Re-run forcing every other supported GPU architecture (`-g a100` SM80, `-g h100` SM90, `-g l4`
SM89, `-g t4` SM75, `-g a40` SM86) to rule out an SM86-specific gap: **same result on all five -
zero models.** Sanity-checked the script and key are actually working by installing
`nvvfxdenoising` on the same run: that feature downloaded 2 real `.trtpkg` model files
successfully. So this is not an auth problem, not a script bug, not a GPU-architecture gap - NVIDIA
currently has no TensorRT model artifacts published on NGC for the VideoSuperRes feature at all.
The library and headers exist; the trained model that `NvVFX_Load` needs to actually run does not.

(Test installs for `nvvfxdenoising` and the four non-native GPU arch variants of
`nvvfxvideosuperres` were removed again after the check - out of scope for this task, kept off the
box.)

## What this means for `vf_vsr.c` - current state, several rounds of fixes in

The filter (`ffmpeg/vf_vsr.c`, `ffmpeg/0005-add-vsr-filter-to-build.patch`,
`WITH_VSR=1` in `scripts/build-ffmpeg.sh`) **builds, links, and registers** correctly in
`ffmpeg -filters` on every build since the fixes below landed. It is **still not confirmed to
produce a frame**. The blocker moved twice as real bugs got fixed - documented in order, because
each one looked like the final answer until the next test disproved it.

### Round 1: `NvVFX_CreateEffect` itself rejected the effect ("not yet implemented", -2)

Initially suspected to be data-center-GPU gating (CT114's RTX 3090 is a consumer card; NGC's own
`install_feature.sh` `GPU_MAP` lists only data-center parts). **That hypothesis was wrong.** The
real cause, found by testing NVIDIA's own `nvidia-vfx` PyPI package (`pip download --no-deps
--extra-index-url https://pypi.nvidia.com/ nvidia-vfx`, no NGC login, ~600MB wheel): **TensorRT
(`libnvinfer.so.10`, `libnvinfer_plugin.so.10`, `libnvonnxparser.so.10`) is a silent runtime
dependency of `libVideoFX.so`** that the NGC SDK Core download never mentions and CT114 never had
installed. With that package's bundled library set (which includes TensorRT) swapped in,
`CreateEffect` succeeded immediately. Confirmed directly with a minimal Python reproduction against
`nvvfx._ext._Effect("VideoSuperRes", 0)` before touching the C filter at all.

That same package's `nvvfx/_lib_loader.py` also proved `libnvidia-ngx-vsr.so.1.8.2` needs no
`NVVFX_MODEL_DIRECTORY` set at all - it never calls it, and that library version apparently bundles
its model internally, contradicting the NGC SDK Core's own empty `lib/models/` directory. `vf_vsr.c`'s
`models=` option is now optional, not a hard requirement, to match.

`build-ffmpeg.sh` now stages a `VFXLIBS_DIR` - a straight copy of the `nvidia-vfx` wheel's
`nvvfx/libs/` folder - wholesale, instead of the hand-assembled NGC-SDK-plus-separate-CUDA/NPP/cuDNN-
wheels combination this project tried first. Confirmed self-contained (`ldd` against nothing but
itself resolves clean) and confirmed to get further than the original combination.

### Round 2: two invalid parameters, found one at a time by direct testing

With TensorRT present, `CreateEffect` succeeds, but two of the parameters `vf_vsr.c` was setting
turned out not to be valid for this specific effect - each returned `NVCV_ERR_PARAMETER` (-5), and
each was found by simply running the filter, reading the exact failing call from the error message,
removing it, rebuilding, and testing again:

1. `NvVFX_SetU32(effect, NVVFX_GPU, ...)` - not a valid parameter for `VideoSuperRes`. NVIDIA's own
   Python wrapper never sets it either; it selects a device by which CUDA context is current before
   creating the effect, which `vf_vsr.c` does not yet do. Removed; `device=` now warns instead of
   silently doing nothing when non-zero (CT114 is single-GPU, so this hasn't mattered in practice).
2. `NvVFX_SetU32(effect, NVVFX_IMAGE_ENCODING_MODE, NVVFX_IMAGE_ENCODING_RGB8)` - also invalid for
   this effect, same error code, found immediately after fixing (1) let the filter get further.
   Removed. Encoding is presumably fixed or inferred from the bound `NvCVImage`'s own format.

Neither of these was guessable in advance from the header alone - the header declares both
constants as generically valid `NvVFX_SetU32` targets, with no per-effect applicability table. They
were only findable by running the real thing and reading what it actually said.

### Round 3 (current, unresolved): `NvVFX_Load` hangs rather than failing or succeeding

With both invalid parameters removed, `CreateEffect`, `CudaStreamCreate`, `SetCudaStream`,
`SetU32(QUALITY_LEVEL)`, and the `NvCVImage_Alloc`/`SetImage` calls all succeed. `NvVFX_Load` then
**does not return** - tested twice, once against a synthetic `testsrc` frame and once (in parallel,
different process) against 2 seconds of a real 1080p video file, both killed after 15+ minutes with
no result.

This was initially assumed to be a legitimate first-time TensorRT engine build (NVIDIA's own
reference TensorRT ffmpeg filter, `github.com/NVIDIA/GMAT`'s `tensorrt.cpp`, confirms the standard
pattern: build once, `engine->serialize()` to a `.trtcache` file, `deserializeCudaEngine()` from it
on every subsequent run - so a slow *first* load would be normal and forgivable). **That is not what
was observed.** Evidence against "legitimately slow":

- All ~15 threads sat in `futex_do_wait` (one in `hrtimer_nanosleep`), with **7 seconds of total CPU
  time across every thread after 15+ minutes of wall clock** - a real TensorRT autotuning pass keeps
  its worker threads busy; this pattern looks like threads waiting on each other, not computing.
- **No `.trtcache`, `.engine`, or any new file was written anywhere** searched (`/root`, `/tmp`,
  `~/.cache`) during either 15-minute run. If it were genuinely mid-build, NVIDIA's own convention
  (per GMAT above) would still not necessarily write a partial file until the build finishes, so
  this alone isn't conclusive - but combined with the CPU-time evidence, a hang is the more
  consistent explanation.

**Both processes were killed rather than left running further.** Neither ever touched Jellyfin or
the live plugin config - both were standalone `ffmpeg` invocations per this project's standing
guardrail. The five pre-existing filters were re-verified working immediately after the kill.

**Not yet tried:** whether this is specific to the `NvCVImage`-pointer-based `SetImage` approach
`vf_vsr.c` uses (the lower-level API path documented in the SDK's own architecture guide) versus the
width/height-setter approach NVIDIA's Python wrapper uses internally (`set_input_image(w, h)`/
`set_output_image(w, h)`, which may allocate and bind images differently under the hood). Also not
tried: running the equivalent Python reproduction through to a real `.run()` call (only `.load()`
was exercised, and that hung too when dimensions were set the same way this filter sets them) to
determine whether the hang is `vf_vsr.c`-specific or present in NVIDIA's own reference package too -
which would mean it's an SDK/driver-level issue, not a bug in this project's code.

If this turns out to be a genuine (if unreasonably long) one-time compile with no caching available
in this configuration, **that alone would make `vsr` unusable for real-time Jellyfin transcoding
regardless of whether it otherwise works** - a viewer cannot wait behind a multi-minute filter
initialization. This is a real, separate go/no-go question from "does it work at all," and it is
currently unresolved in the "hung, not slow" direction, which is worse.

## Two (and now three) build-time bugs fixed getting this far

1. **`libVideoFX.so`'s own CUDA/NPP/cuDNN/TensorRT dependencies were never resolvable at runtime.**
   `ffmpeg`'s own rpath is not transitive: it resolves ffmpeg's direct `NEEDED` entries but not
   `libVideoFX.so`'s own `NEEDED` entries - the same RUNPATH-non-transitivity gotcha `NEURAL.md`
   already documents and fixes for ORT's CUDA provider. Without this the freshly built `ffmpeg`
   binary failed to even start: `error while loading shared libraries: libnppial.so.12: cannot open
   shared object file`. Fixed by `patchelf --set-rpath '$ORIGIN'` on every staged VideoFX `.so`, now
   automatic in `build-ffmpeg.sh`.
2. **`proxmox-build.sh`'s own restore-the-previous-binary safety net never ran.** Under `set -e`, a
   `die` inside `build-ffmpeg.sh`'s internal filter check unwound straight past the caller's own
   restore logic and left a broken binary installed and live - hit twice on this exact task before a
   `|| true` guard was added. **This broke the box Jellyfin actively uses, twice, mid-session** -
   found and fixed by restoring `.prev` by hand both times, then closing the actual bug rather than
   just working around it once.
3. **A stale symlink from an earlier build made `cp -a` silently write into the wrong file.** After
   switching to `VFXLIBS_DIR` staging, a leftover `libVideoFX.so -> libVideoFX.so.1.3.0` symlink from
   the previous NGC-SDK-based layout caused `cp -a` to write the new library's contents *through* the
   symlink into the old versioned file, while the plain-named file stayed a symlink - so the
   patchelf loop's symlink-skip guard silently patched nothing, and the binary failed to start again
   the same way as bug 1. Fixed by wiping `$PREFIX/vfx/lib` before staging instead of merging into it.

`scripts/build-ffmpeg.sh` also had a real, unrelated efficiency bug fixed along the way: `shaderc`
and `libplacebo` were git-cloned and rebuilt from source on every single invocation regardless of
which `WITH_*` flags were set, costing several minutes of C++ compilation per run - felt heavily
during this task's many rebuild-and-test iterations. A stamp file at `/usr/local` now records the
installed tag and skips the rebuild when it already matches.

## Path forward

- **Diagnose the `NvVFX_Load` hang.** This is the actual next step, not NGC/models/GPU-gating (all
  resolved or ruled out above). Candidates: try the width/height-setter image-binding API instead of
  raw `NvCVImage` pointers; reproduce (or rule out) the hang in NVIDIA's own `nvidia-vfx` Python
  package by actually calling `.run()`, not just `.load()`; check for a deadlock between `Load`'s
  internal thread pool and something in this specific FFmpeg build (Vulkan/shaderc initialization
  happening on the same process, for instance).
- **Even once `Load` returns, measure whether it caches.** A second invocation running fast (per the
  `.trtcache` pattern NVIDIA's own `GMAT` TensorRT filter uses) is a hard requirement for real-time
  viability, not a nice-to-have - untested and unresolved.
- Do **not** substitute a different feature's model file or fabricate a models directory to make
  something pass - that would be exactly the "fabricate an API to make progress" failure mode this
  project's own `vf_dlss.c` CUDA investigation already flagged and refused to do.

## Licensing (confirmed, now that the SDK is actually on the box)

- `VideoFX/README.md`, `Changelog.txt`, and the headers: MIT-equivalent open license terms per the
  public GitHub mirror's `LICENSE` (`Copyright (c) 2021 NVIDIA Corporation`) - the mirror and the
  NGC Core package ship the same open headers.
- `nvvfxvideosuperres/license/` on CT114 holds three NVIDIA PDFs actually shipped with the NGC
  feature download: `NVIDIA-Software-License-Agreement-2025.05.05.pdf`,
  `NVIDIA-Open-Model-License-Agreements-24-10-2025.pdf`,
  `product-specific-terms-for-nvidia-ai-products-2025.05.05.pdf`. These govern the compiled
  feature library and (once NVIDIA publishes them) the trained model files - read before shipping
  anything built against this SDK, not vendored into this GPL tree, same as the DLSS runtime blob.

## Closed investigation: raw-CUDA-kernel alternative to the Maxine SDK (2026-09-22)

Separately explored and now closed: whether NVIDIA's *other* "Video Super Resolution" - the
driver-level consumer feature Chrome/Edge use to upscale video calls (historically confirmed
Windows/D3D11-only via mpv's `vf_d3d11vpp.c`) - ships extractable CUDA kernels that could be driven
directly, bypassing the Maxine SDK's NGC/`CreateEffect` blocker entirely. `ffmpeg/rtx_cuda.h` was
filed as scaffolding for this kind of approach (a generic shared core for driving externally-
compiled cubins + a weights blob directly via the CUDA driver API) before this investigation
concluded - it has **no working consumer for VSR or anything else in this repo** and should not be
assumed functional; see its own file header for status.

Three independent checks all reached the same answer:

- **NVIDIA's Linux driver (595.84) ships no VSR kernels at all.** `libnvidia-ngx.so` carries the
  capability/config keys (`VSR.Available`, `VSR.MinDriverVersionMajor`, the `nvbroadcast_vfx_sr`
  family, `dlvsr`) proving the feature exists in NGX's schema, but zero compiled kernels behind
  them - no `.nv_fatbin`/`.nvFatBinSegment` section anywhere outside `libnvoptix.so` (already used
  by `vf_optix.c`). `nvngx.dll` ships only as a Windows PE stub for Proton/Wine compatibility, not
  natively callable.
- **NVIDIA's Windows driver (GeForce 616.92, downloaded and inspected clean) has no separable VSR
  component either.** The only VSR-named files, `nvvitvsr.dll`/`nvsvsr.dll`, are UI-resource-only
  PE binaries (Control Panel toggle-switch icon artwork, `.rdata`+`.rsrc` sections, no code at all).
  Every CUDA-adjacent DLL in the 1167-file driver tree was checked for fatbin markers
  (`__nv_relfatbin`, `__fatbin_reloc`) - zero hits. The actual implementation is compiled into the
  monolithic, obfuscated `nvlddmkm.sys` kernel driver and/or the D3D user-mode driver blob, with no
  symbol boundary to extract even if disassembly were on the table.
- **Chromium's own public source (BSD-licensed, the actual code that successfully invokes this
  feature) confirms why.** `ToggleNvidiaVpSuperResolution()` in `ui/gl/swap_chain_presenter.cc`
  calls `ID3D11VideoContext::VideoProcessorSetStreamExtension()` with NVIDIA's private GUID
  `kNvidiaPPEInterfaceGUID = {0xd43ce1b3, 0x1f4b, 0x48ac, {0xba, 0xee, 0xc3, 0xc2, 0x53, 0x75, 0xe6,
  0xf7}}`. Pure D3D11 video-processor extension, no CUDA involvement anywhere. NVAPI (NVIDIA's real
  public SDK, distinct from the closed driver internals above) is Windows/D3D-native; the Linux
  `libnvidia-api.so` exists only to re-export the NVAPI ABI to DXVK/Wine, and still needs a real (or
  DXVK-translated) `ID3D11VideoContext` underneath - no Vulkan- or CUDA-native path exists at any
  layer.

Also checked and ruled out: "DLPP" as a search term (raised as a possible lead) turned up nothing
real anywhere in the Linux driver tree - the only case-insensitive hits were `ADLPPort00`..`11`
(display-port enumeration names, an unrelated substring collision) and a single 4-byte binary
coincidence (`dLPp%`) inside the GSP firmware blob and the kernel module object file, neither of
which is a genuine identifier.

**Verdict: this is a structural dead end, not a missing-lead problem.** RTX Video Super Resolution
has no CUDA entry point on any platform. Continuing to look for one would be searching for
something that provably does not exist. The Maxine SDK's `CreateEffect`/no-models blocker above
remains the only real, and final, stopping point for `vf_vsr.c`.

## Driver/GPU requirements (confirmed, unchanged from the original research)

- Linux driver 570.190+/580.82+/590.44+ depending on branch. CT114: 595.84, clears all three.
- `STREAMING_MEDIUM`/`STREAMING_ULTRA` quality modes require Ampere or later. CT114's RTX 3090 is
  Ampere, SM86 - qualifies for the best tiers once models exist.

## Nothing measured

No fps number, no confirmed frame output - `NvVFX_Load` hangs rather than returning (see Round 3
above). `ffmpeg/vf_vsr.c` builds, links, and registers correctly in `ffmpeg -filters` on every build
since the fixes landed; the five pre-existing filters (`oidn`, `optix`, `ort`, `fsr2`, `dlss`) were
smoke-tested against real output after every rebuild in this session and remain unaffected. See
`vfx-sdk-vsr-task.md` for the original task brief.
