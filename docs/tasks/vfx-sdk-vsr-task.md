# Task: new filter, vf_vsr.c, wrapping NVIDIA Maxine VFX SDK Video Super Resolution

Handover doc for a subagent. Read `ARCHITECTURE.md`, `hw-resident-encode-plan.md`, and
`livetestbox.md` in this repo first for the surrounding investigation. Read `AGENTS.md` and
`CLAUDE.md` for this project's engineering culture before touching anything - especially "read the
actual header/SDK on the server, never guess an API shape" (this project's own OptiX HDR incident
in `improvements.md` is the precedent).

## Why this task exists

Two other GPU-residency paths in this investigation are blocked or high-risk:
`hwcontext_vulkan.c`'s missing Vulkan-to-CUDA `hwmap` case (scoped in `hw-resident-encode-plan.md`,
shared plumbing under every Vulkan filter here, currently blocked on tooling permission), and
migrating `vf_dlss.c` off Vulkan (closed - the installed NGX SDK has no CUDA path for
`Feature_SuperSampling`, only for the unrelated DLISP feature). Researching alternatives turned up
something not previously considered: NVIDIA's **Maxine VFX SDK** ships a "Video Super Resolution"
effect (`nvvfxvideosuperres`) that is genuinely different from both DLSS and RTX Video Super
Resolution (the Windows-only, D3D11-driver-extension feature `mpv`'s `vf_d3d11vpp.c` uses via a
private GUID - confirmed via that file's own source, dead end for this Linux project, unrelated
SDK). This one is:

- **Pure CUDA**, confirmed by reading the actual header (`nvCVImage.h` from
  `github.com/NVIDIA-Maxine/Maxine-VFX-SDK`, fetched 2026-09-22): `NVCV_GPU`/`NVCV_CUDA` buffer
  type (value 1, CUDA device memory), every transfer/effect function takes an explicit
  `CUstream`. No D3D11, no Vulkan, anywhere in this SDK.
- **Linux-supported**: driver >=590.44 per NVIDIA's own docs
  (`docs.nvidia.com/maxine/vfx/latest/Filters/VideoSuperResolution.html`). CT114 runs driver
  595.84 - clears this.
- **Ampere+ required** for the best quality tiers (`STREAMING_MEDIUM`/`STREAMING_ULTRA` - not
  supported on Turing). The RTX 3090 is Ampere, compute cap 8.6 - qualifies.
- **MIT licensed** headers and samples - checked the actual `LICENSE` file in
  `github.com/NVIDIA-Maxine/Maxine-VFX-SDK`, copyright NVIDIA Corporation, standard MIT text.
  Matches this project's own license rule in `AGENTS.md`: MIT copies straight in with its header.
  The trained model/runtime binaries are distributed separately (NVIDIA's Maxine End-user
  Redistributables installer) under whatever EULA governs that download - same shape as this
  project's existing DLSS `.so` runtime blob (see `DLSS.md`), an external proprietary dependency
  the open code links against, not something vendored into the GPL tree.
- **Semantically a better fit than DLSS for this project's use case.** DLSS Super Resolution is
  built for game rendering - it wants motion vectors, jitter, depth, which this project already has
  to synthesize for recorded video and honestly labels "DEGRADED" as a result (see `vf_dlss.c`'s
  `-filters` description string). NVIDIA's Video Super Resolution effect is built for plain video
  input - no synthesized game state needed. Closer to what `vf_ort.c` (Real-ESRGAN via ONNX
  Runtime) already does, just NVIDIA's own trained model and inference stack instead.

## Confirmed API surface (read directly from `nvVideoEffects.h`/`nvCVImage.h`, not guessed - but
see Step 0, the exact version/behavior installed on CT114 still needs independent confirmation)

Handle-based, small surface:

```c
NvVFX_CreateEffect(NVVFX_FX_SUPER_RES /* "SuperRes" */, &effect);   // or NVVFX_FX_SR_UPSCALE "Upscale"
NvVFX_SetU32(effect, NVVFX_MODE, mode);                              // quality/perf mode
NvVFX_SetImage(effect, NVVFX_INPUT_IMAGE, &inputImg);                // NvCVImage, NVCV_CUDA memSpace
NvVFX_SetImage(effect, NVVFX_OUTPUT_IMAGE, &outputImg);
NvVFX_SetCudaStream(effect, NVVFX_CUDA_STREAM, stream);
NvVFX_Load(effect);
NvVFX_Run(effect, async);
NvVFX_DestroyEffect(effect);
```

`NvCVImage` buffers use `NvCVImage_Alloc(..., NVCV_CUDA, ...)` for CUDA-device-memory images -
this is the type the filter should use throughout, matching `vf_optix.c`'s existing CUDA-context
pattern in this repo rather than introducing a new device-management style.

There are also `NVVFX_FX_DENOISING` ("Denoising") and `NVVFX_FX_ARTIFACT_REDUCTION`
("ArtifactReduction") effect selectors in the same SDK - out of scope for this task, but worth a
one-line note in the report if you notice anything relevant, since this project already has
`denoise=`/`deblock=` axes that might one day want the same treatment.

## Step 0: verify what's actually installed/available before writing any code

This project's culture (and this exact investigation's last two subtasks) is clear: do not write
code against an API whose presence on the actual box hasn't been confirmed. Before touching
`ffmpeg/`:

1. SSH to CT114 (`ssh -p 2298 root@192.168.1.2` from this machine, then `pct exec 114 -- <cmd>`
   from the pve host) and check whether the Maxine VFX SDK is already present anywhere (it
   won't be - this is genuinely new - but confirm, don't assume).
2. Determine how to actually obtain it. The open-source repo
   (`github.com/NVIDIA-Maxine/Maxine-VFX-SDK`) has the MIT headers/samples but NOT the trained
   model files - those come from NVIDIA's Maxine End-user Redistributables installer or SDK
   download, which may require NVIDIA Developer Program registration. Check what's actually
   fetchable without an interactive login (a `curl`/`wget` against a public redistributable URL,
   the kind of thing `build-ffmpeg.sh` already does for the DLSS/OptiX SDKs via env-var paths like
   `NGX_SDK`/`OPTIX_SDK`) versus what would require the user to manually place files on the box
   first, same as `DLSS.md` documents for the existing DLSS runtime blob. If it requires manual
   placement, STOP and report exactly what needs to be downloaded and placed where (write this as
   a new `VSR.md` following the existing `DLSS.md`/`OPTIX.md`/`FSR2.md`/`OIDN.md` pattern in this
   repo) rather than attempting to fetch something that needs interactive auth.
3. If a runtime/model file genuinely cannot be obtained non-interactively, this task stops at
   documentation: write `VSR.md` with exact instructions for the user to fetch and place the SDK,
   matching the existing doc pattern, and report back that code work is blocked on that manual
   step. Do not fabricate or guess at model filenames/paths.

## If the SDK is obtainable: implementation

1. Read `ffmpeg/vf_optix.c` in full as the reference pattern for CUDA context management in this
   project (`cu_ctx`, `cuCtxPushCurrent`/`cuCtxPopCurrent`, device selection) - match it rather
   than inventing a new style.
2. Write `ffmpeg/vf_vsr.c` as a new, standalone filter (same shape as the existing four -
   `AVFilter` boilerplate, `AVOption`s for mode/strength, `config_input`/`config_output`,
   `filter_frame`, `uninit`) wrapping the API above. Pure CUDA in and out - no Vulkan, no system
   memory round trip beyond whatever this project's existing CPU-side node convention requires (see
   `ARCHITECTURE.md`'s "Every CPU-side node" note - decide whether this filter should be written to
   accept/emit `AV_PIX_FMT_CUDA` hw frames directly, which would make it usable in the Tier-1
   CUDA-native chain from `ARCHITECTURE.md`, rather than system-memory `format=gbrpf32le` like the
   existing neural filters - this is a real design choice worth getting right the first time rather
   than retrofitting later, and ties directly into the Tier 1 plan already written up).
3. New patch file `ffmpeg/0006-add-vsr-filter-to-build.patch` (or whatever number is free once
   `0005` exists or doesn't - check current state, don't assume `0005` was landed), following the
   format of the existing patches (read `ffmpeg/0002-add-optix-filter-to-build.patch` for the exact
   shape).
4. Wire the build: `WITH_VSR` flag in `scripts/build-ffmpeg.sh`, matching how `WITH_OPTIX`/
   `WITH_ORT`/`WITH_DLSS` are already handled (SDK path env var, header existence check before
   compiling, same pattern as `NGX_SDK`/`OPTIX_SDK`).
5. Plugin-side wiring, same checklist `CLAUDE.md` already states for "adding a setting" and adding
   an axis level: `PluginConfiguration.cs` + `UpscaleSettings.cs` mirror, `configPage.html` control
   + load/save lines, the probe so the client can offer it, `ShaderLibrary.cs`'s neural-level (or a
   new axis, if this doesn't fit cleanly under the existing `neural=` axis - decide and justify)
   dictionary, `UpscaleEngine.BuildChain`. Off by default, same as every other unmeasured addition
   in this project's history.
6. Build via `pct exec 114 -- bash -c 'cd /opt/jellyfin-gpu-upscale && bash
   scripts/proxmox-build.sh --with-ffmpeg --no-activate'` (push to `origin/main` first - the build
   script hard-resets the server checkout). Confirm all SIX filters now present in `ffmpeg
   -filters` (the five existing plus `vsr`), and confirm the five existing ones still work via a
   standalone smoke test each (this is a new file, not a shared-plumbing edit, so the blast radius
   to the other four is much lower than the `hwmap` patch - but verify rather than assume, cheap
   insurance).
7. Standalone smoke test for `vsr` itself: bare `ffmpeg -f lavfi -i testsrc=... -vf
   "...,vsr=...,..." -f null -`, confirm real output frames, no Jellyfin involvement.
8. If it works: a rough quality/speed sanity check the way `NEURAL.md`/`OIDN.md`/`FSR2.md` already
   record numbers for their filters - fps at a representative resolution, so this doesn't join the
   pile of unmeasured additions this project's `improvements.md` keeps warning about. A full
   ground-truth PSNR/SSIM benchmark like README.md's existing shader measurements is a bigger ask;
   a basic fps number is the minimum bar before calling this done.

## Guardrails, non-negotiable

- Never restart jellyfin.service on CT114. Never touch the live plugin config XML. Always
  `--no-activate`. All verification is standalone `ffmpeg` invocations, never through Jellyfin.
- Do not guess at the Maxine VFX SDK's model filenames, download URLs, or license terms - read
  what's actually there (the public GitHub repo, and whatever download page/README documents the
  redistributable installer) and stop to ask if a step needs interactive authentication this
  session doesn't have.
- If `--with-ffmpeg` rebuild regresses any of the five existing filters: restore `.prev`, re-verify
  with smoke tests, report as failed. Do not leave the box in a degraded state.
- This task does NOT touch `hwcontext_vulkan.c`, the `GpuResidentEncode` setting, or attempt the
  Vulkan-CUDA `hwmap` patch - that's the separate, already-scoped, currently-blocked task in
  `hw-resident-encode-plan.md`. Independent of this one.

## Docs to update when done

Same dense style already used throughout this repo:

1. New `VSR.md` (or `MAXINE-VSR.md`) following the existing `DLSS.md`/`OPTIX.md`/`FSR2.md`/
   `OIDN.md` pattern - SDK source, license, what's vendored vs. installed by hand, driver/GPU
   requirements, measured numbers once they exist.
2. `ARCHITECTURE.md` - new row in the per-filter backend table for `vf_vsr.c` (**CUDA**, and
   whether it's hw-frame-native or system-memory, per the design decision in implementation step
   2), and a note in the Tier 1 section of "Full GPU-resident pipeline" if it ended up hw-frame
   native.
3. `improvements.md` - new entry if this becomes a real, shippable feature (follow the existing
   entry format/severity tags for consistency).
4. `livetestbox.md` (local only, gitignored, NOT committed) - full command log, same pattern as the
   prior three investigations recorded there.
5. If real code lands and is verified working: commit and push everything to `origin/main` (check
   `git log` for message style, include `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`).
   If blocked on manual SDK acquisition: commit and push just the `VSR.md` instructions and any
   doc updates, not incomplete/non-functional code.

## Report back

Concisely: is the SDK actually obtainable non-interactively or does it need manual placement (and
exactly what, if so), did the filter get written and verified, did the five existing filters
survive, what's the fps number if you got one, and what state is CT114's ffmpeg binary in right
now.
