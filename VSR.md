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

No fps number - can't run the filter without model files. `ffmpeg/vf_vsr.c` exists, builds, and
registers; that's the entire deliverable available right now. See `vfx-sdk-vsr-task.md` for the
original task brief.
