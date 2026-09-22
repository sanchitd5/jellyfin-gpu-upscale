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

## What this means for `vf_vsr.c`

The filter (`ffmpeg/vf_vsr.c`, `ffmpeg/0005-add-vsr-filter-to-build.patch`,
`WITH_VSR=1` in `scripts/build-ffmpeg.sh`) is real code against the real installed SDK, not a
guess. It **builds and registers** - `WITH_VSR=1` requires `VFXSDK_DIR`/`VFXVSR_DIR` to point at
the paths above and fails loudly in preflight if they're missing, matching `WITH_DLSS`'s pattern.
It is **not confirmed to run**: `NvVFX_Load()` needs a `models=` directory containing real
TensorRT engine files, and NGC has none to give it right now. Expect
`NvVFX_Load` to fail with a "model not found" class of error until NVIDIA publishes them - there is
nothing left to fetch or configure on this project's side.

## Update (2026-09-22, later the same day): build now succeeds, filter registers, but a second wall

`ffmpeg/vf_vsr.c` now builds and runs against the real SDK end to end (see "Two build-time bugs
fixed" below). With a real `models=` path supplied, `NvVFX_CreateEffect(NVVFX_FX_VIDEO_SUPER_RES,
...)` itself fails: `The requested feature is not yet implemented (-2)`. This happens **before**
model loading, `NvVFX_Load`, or anything image-related - the effect handle is never created. Ruled
out by direct testing, not assumed:

- **Not a path/discovery problem.** `$PREFIX/vfx/features/nvvfxvideosuperres/` holds exactly the
  layout `install_feature.sh` itself produces (flat `libnvVFXVideoSuperRes.so` and
  `libnvidia-ngx-vsr.so.1.8.3` beside the feature's `include/`), staged next to `libVideoFX.so` the
  same way the SDK's own installer lays it out under `/usr/local/VideoFX/features/`. Symlinking
  `/usr/local/VideoFX` at the real SDK's canonical path and re-testing changed nothing.
- **Not a missing-dependency problem.** Every `.so` in the chain resolves clean (`ldd` shows zero
  "not found" after the rpath fix below).
- **Not the pixel-format design** - `vf_vsr.c` already converts `AV_PIX_FMT_GBRPF32LE` to
  `NVCV_RGBA`/`NVCV_U8` via `NvCVImage_Transfer` before touching the effect, matching the bundled
  SDK doc's own filter spec (interleaved 8-bit BGRA/RGBA) exactly. Checked against the doc actually
  shipped inside the SDK Core tarball
  (`VideoFX/share/docs/videoFX-user-guide/Filters/VideoSuperResolution.html`, v1.3.0.0,
  "Last updated on Mar 06, 2026") rather than the public website, which turned out to describe an
  older mode ladder (`STREAMING_MEDIUM`/`STREAMING_ULTRA` don't appear in the bundled doc at all -
  the real modes are `VSR_Bicubic`..`VSR_Ultra` plus separate `Denoise_*`/`Deblur_*`/
  `HighBitrate_*` modes 8-19).

**What's left unproven, stated as a hypothesis, not a fact:** `install_feature.sh`'s own
`GPU_MAP` - the table it uses to pick which TensorRT models to fetch - lists only data-center parts
(`a100 a30 a2 a10 a16 a40 t4 l4 l40 h100 b100 b200 b40`). No consumer GeForce/RTX card appears
anywhere in it. It's plausible `NvVFX_CreateEffect` gates VideoSuperRes to recognised data-center
GPUs regardless of raw compute capability matching (CT114's RTX 3090 auto-detects as SM86, same
number as the datacenter A40/A10/A16, but a different, ungated product line) - this would explain
"not yet implemented" independent of the missing-models problem. Not confirmed: would need testing
on an actual A-series/L-series/H100 box, which this project doesn't have. Do not treat this as
settled; it's the most consistent explanation of what was actually observed, nothing more.

So the filter now has **two independent, stacked blockers**, either of which alone would stop it
running: no TensorRT models published on NGC for any GPU (confirmed), and a `CreateEffect`-level
rejection whose cause (data-center gating, a bug in this SDK build, something else) is not yet
identified. Continuing further needs either an NVIDIA support answer or hardware this project does
not have.

## Two build-time bugs fixed getting this far

1. **`libVideoFX.so`'s own CUDA/NPP/cuDNN dependencies were never resolvable at runtime.**
   `ffmpeg`'s own rpath is not transitive: it resolves ffmpeg's direct `NEEDED` entries but not
   `libVideoFX.so`'s own `NEEDED` entries (the CUDA/NPP/cuDNN libraries staged beside it) - the same
   RUNPATH-non-transitivity gotcha `NEURAL.md` already documents and fixes for ORT's CUDA provider.
   Without this the freshly built `ffmpeg` binary failed to even start:
   `error while loading shared libraries: libnppial.so.12: cannot open shared object file`. Fixed by
   `patchelf --set-rpath '$ORIGIN'` on every staged VideoFX `.so`, now automatic in
   `build-ffmpeg.sh`. CT114 also has no CUDA toolkit installed at all, so `libcudart.so.12` and five
   `libnpp*.so.12` files, plus cuDNN 9's `libcudnn*.so.9`, came from NVIDIA's own public PyPI wheels
   (`nvidia-cuda-runtime-cu12`, `nvidia-npp-cu12`, `nvidia-cudnn-cu12`) - no login, same convention
   `NEURAL.md` documents for ORT's own CUDA/cuDNN libs.
2. **`proxmox-build.sh`'s own restore-the-previous-binary safety net never ran.** Under `set -e`, a
   `die` inside `build-ffmpeg.sh`'s internal filter check unwound straight past the caller's own
   restore logic and left a broken binary installed and live - hit twice on this exact task before a
   `|| true` guard was added. **This broke the box Jellyfin actively uses, twice, mid-session** -
   found and fixed by restoring `.prev` by hand both times, then closing the actual bug rather than
   just working around it once.

## Path forward, none of it actionable right now

- **Wait for NVIDIA to publish VideoSuperRes models to NGC.** No ETA available; this project has no
  visibility into NGC's release schedule. Re-run `install_feature.sh -f nvvfxvideosuperres`
  periodically (or after a Maxine SDK release announcement) to check.
- **File the gap with NVIDIA** if there's a support channel for it (not attempted this session -
  out of scope, no account-linked support access confirmed).
- Do **not** substitute a different feature's model file or fabricate a models directory to make
  `NvVFX_Load` pass - that would be exactly the "fabricate an API to make progress" failure mode
  this project's own `vf_dlss.c` CUDA investigation already flagged and refused to do.

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

## Driver/GPU requirements (confirmed, unchanged from the original research)

- Linux driver 570.190+/580.82+/590.44+ depending on branch. CT114: 595.84, clears all three.
- `STREAMING_MEDIUM`/`STREAMING_ULTRA` quality modes require Ampere or later. CT114's RTX 3090 is
  Ampere, SM86 - qualifies for the best tiers once models exist.

## Nothing measured

No fps number - `NvVFX_CreateEffect` itself fails before a single frame could be processed (see
above), independent of the missing models. `ffmpeg/vf_vsr.c` exists, builds, links, and registers
correctly in `ffmpeg -filters`; the five pre-existing filters (`oidn`, `optix`, `ort`, `fsr2`,
`dlss`) were smoke-tested against real output after this work and are unaffected. See
`vfx-sdk-vsr-task.md` for the original task brief.
