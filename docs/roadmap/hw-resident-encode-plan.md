# GPU-resident encode: Vulkan → NVENC without leaving the GPU

Task plan. Not started. Status: awaiting scope decision (see "Open decision" at the end).

## Goal

Skip the current `hwdownload,format=yuv420p` step that sends every enhanced output frame from
Vulkan device memory to system RAM before NVENC re-uploads it — a full frame's worth of PCIe
traffic each way, paid at output size (~12MB/frame at 2160p). Replace it with a GPU-to-GPU path.

## What's already proven (2026-09-22, this session)

- `GpuResidentEncode` config flag + `hwmap=derive_device=cuda` end-of-chain wiring shipped as
  opt-in (commit `9261844`), smoke-tested directly against the patched ffmpeg on CT114, **failed**:
  `Failed to map frame: -38` (`Function not implemented`). Reverted to off, live config confirmed
  clean (commit `49a59c4`).
- Root cause confirmed by reading FFmpeg source directly (subagent investigation, commit
  `45a954b`): `libavutil/hwcontext_vulkan.c`'s `vulkan_map_from()` has switch cases only for
  `AV_PIX_FMT_DRM_PRIME` and `AV_PIX_FMT_VAAPI`. No `AV_PIX_FMT_CUDA` case exists in either the
  `n8.1.2` tag this box builds or current FFmpeg `master`. `hwmap=derive_device=cuda` from a
  Vulkan source cannot work on any FFmpeg build that exists today. This is not a driver, SDK, or
  configure-flag gap — checked and ruled out first (build flags, CUDA stack, Vulkan extensions all
  present and correct on CT114).
- Real Vulkan→CUDA device-to-device transfer code **does** exist in the same file
  (`vulkan_export_to_cuda`, `vulkan_transfer_data_to_cuda`/`_from_cuda` — a real `cuMemcpy2DAsync`,
  no system-RAM round trip) but is wired only into `av_hwframe_transfer_data` (copy semantics), not
  `av_hwframe_map` (the call `hwmap` uses). No stock filtergraph node reaches for `transfer_data` in
  this direction, so there is currently no way to express "keep it on the GPU" in a filtergraph at
  all, copy or zero-copy.

## Corroboration from NVIDIA Video Codec SDK docs (developer.nvidia.com/video-codec-sdk, read
2026-09-22)

- SDK v13.1 explicitly supports "application allocated CUarray as NVENC input surface" — confirms
  NVENC hardware/driver genuinely accepts GPU-resident CUDA input directly, matching the user's
  point that this works fine on Windows. The capability is real at the hardware/SDK level.
- This matches what the FFmpeg source reading already implied: FFmpeg's own `hevc_nvenc` encoder
  wrapper already accepts `AV_PIX_FMT_CUDA` hw_frames_ctx input (that path is used elsewhere in
  FFmpeg, e.g. `scale_cuda` → `hevc_nvenc` chains). NVENC-accepts-CUDA is not the gap.
- The gap is narrowly: getting a Vulkan-produced frame (what libplacebo produces) into a
  `AV_PIX_FMT_CUDA` hw_frames_ctx that FFmpeg's NVENC wrapper can then consume. That's entirely an
  FFmpeg-abstraction-layer gap, not a hardware or NVIDIA-SDK limitation.

## Ruled out: PyNvVideoCodec

`developer.nvidia.com/blog/whats-new-in-pynvvideocodec-2-0` (read 2026-09-22): Python-only wrapper
around the same Video Codec SDK, no FFmpeg or C/C++ integration mentioned, no Vulkan frame
ingestion. Not a path here — this project's whole architecture is inside a live `ffmpeg` CLI
process Jellyfin spawns per session; swapping the encode step to a separate Python process would
mean abandoning that architecture, not routing around the `hwcontext_vulkan.c` gap.

## Ruled out: NVIDIA's own FFmpeg-with-GPU guide

`docs.nvidia.com/video-technologies/video-codec-sdk/13.1/ffmpeg-with-nvidia-gpu` (read
2026-09-22): NVIDIA's official recommended GPU-resident pattern is pure CUDA end-to-end -
`-hwaccel_output_format cuda` at decode, `scale_cuda` for scaling, straight into `hevc_nvenc`.
**No Vulkan interop mentioned anywhere.** `scale_npp` is even called out as deprecated for CUDA
>12.8. This confirms rather than contradicts the `hwcontext_vulkan.c` finding: NVIDIA's own
guidance never touches Vulkan, because their reference pipeline doesn't use it. It doesn't apply
directly to this project, whose GPU-resident stage is Vulkan/libplacebo (the SR shaders, deband,
chroma upscaling - none of which has a CUDA equivalent to fall back to). No official
Vulkan-to-CUDA bridge pattern exists to borrow from; the gap really is FFmpeg-internal and
specific to combining Vulkan-shader filtering with NVENC output, which is this project's situation
and not a commonly documented one.

## Real fix, and why it's not a quick patch

Add an `AV_PIX_FMT_CUDA` case to `vulkan_map_from()` that routes into the existing
`vulkan_export_to_cuda` / `transfer_data_to_cuda` machinery — copy semantics (device-to-device,
not true zero-copy pointer aliasing), but skips the system-RAM round trip entirely. This is
architecturally sound (CUDA imports the Vulkan image as a texture array, not a linear device
pointer, and NVENC wants linear/pitched memory, so a device-side copy is required either way —
likely why upstream never wired this in the first place: it isn't the "free" zero-copy case hwmap
usually represents).

**Why this isn't a same-shape patch as the project's existing four** (`ffmpeg/0001`–`0004`, which
each add one new standalone filter file to the build): those patches touch nothing another filter
depends on. `hwcontext_vulkan.c` is shared plumbing underneath every Vulkan-touching filter here —
oidn's Vulkan path, optix, fsr2, dlss, and libplacebo's whole SR/deband/chroma shader stack. A
correctness bug here (Vulkan semaphore vs. CUDA stream sync ordering is the classic way this class
of patch goes wrong) doesn't fail loud on the new code path only — it risks corrupted frames or a
GPU hang across every enhancement session on the box, including ones that never touch
`GpuResidentEncode`.

## What it would take

1. Read `vulkan_export_to_cuda`/`vulkan_transfer_data_to_cuda` closely enough to understand the
   synchronization contract (semaphore wait/signal, CUDA stream ordering) before writing anything.
2. Write a new `AV_PIX_FMT_CUDA` case in `vulkan_map_from()` that performs the device-to-device
   copy, as a new patch file (`ffmpeg/0005-vulkan-cuda-hwmap.patch` following the existing
   numbering convention).
3. Build via `scripts/build-ffmpeg.sh`, confirm all five existing custom filters still present
   (script already gates on this) AND still functionally correct post-rebuild, not just linked —
   run the existing `VulkanDenoiseRunsOnPatchedBinary` -style smoke test for each, since this patch
   touches code every one of them depends on.
4. Re-run the exact `hwmap=derive_device=cuda` smoke test from `livetestbox.md`. Confirm it
   produces real output frames, not just a clean exit.
5. **Then measure**, before ever flipping any default: does the device-to-device copy this
   actually enables beat the current hwdownload+re-upload cost enough to justify the change and the
   risk? Per this project's own measurement discipline (`improvements.md` "Measure first"), that
   number does not exist yet and should be estimated or bench-checked before step 1-4 are attempted,
   not after.

## Option (c): CUDA-to-CUDA, sidestep Vulkan entirely for a subset of sessions

Found while checking the user's "what about CUDA-to-CUDA shaders" question against the actual
filter source (2026-09-22):

- `vf_optix.c` and `vf_ort.c` (ONNX Runtime, `SessionOptionsAppendExecutionProvider_CUDA_V2`) are
  already pure CUDA - zero Vulkan involvement in either. `vf_dlss.c` explicitly runs "through
  NGX's Vulkan path" (its own file comment) even though NGX supports a CUDA backend too - this
  project chose Vulkan for DLSS specifically. libplacebo (FSRCNNX/RCAS/KrigBilateral/deband, and
  the plain resize every session runs today) is Vulkan-only; no CUDA equivalent exists to fall
  back to.
- **Bigger finding, changes the priority of this whole task:** every CPU-side node in
  `BuildChain` (`oidn`, `optix`, `ort`, `fsr2`, `dlss`) takes and returns SYSTEM-MEMORY AVFrames
  (`format=gbrpf32le`). Each filter uploads to its own device context internally and downloads
  back to system RAM before the next node runs, every frame - independent of the
  `hwcontext_vulkan.c` gap this whole doc is about. A session running `denoise=optix` +
  `neural=ort` already pays a GPU-RAM-GPU round trip TWICE before ever reaching the one
  hwdownload-before-NVENC round trip that's been the subject of this investigation. Fixing that
  one handoff removes the smallest round trip in the chain, not the biggest.
- The real high-value CUDA-to-CUDA move: make `optix` and `ort` pass an `AV_PIX_FMT_CUDA` hw frame
  directly to each other (no `format=gbrpf32le` system-memory bounce between them when both are in
  the chain), and for a session that uses only CUDA-native filters plus a plain resize (no
  FSRCNNX/RCAS/deband/chroma/dlss/fsr2), route the final scale through stock `scale_cuda` instead
  of `libplacebo=`. That stays 100% CUDA end to end with **no FFmpeg core patch** - `scale_cuda` is
  upstream stock, and the changes needed are entirely inside this project's own `vf_optix.c`/
  `vf_ort.c`/`BuildChain`, which it already owns and patches freely.
- Coverage caveat: only helps sessions that don't touch the Vulkan-only shader ladder. Any session
  using FSRCNNX, RCAS, deband, chroma upscaling, DLSS or FSR2 still needs libplacebo/Vulkan and
  still hits the exact gap documented above - this option doesn't make that gap go away, it makes
  it not matter for a specific, probably common, subset of sessions (plain neural SR + denoise,
  no shader-ladder SR).
- Not yet scoped in the same detail as the hwmap patch above (no measurement of how many real
  sessions on this box would actually hit the CUDA-only subset, no code written). Worth measuring
  before either this or the `hwcontext_vulkan.c` patch, per the "measure first" note below.

## Open decision

Two ways to sequence this, put to the user, not yet answered:

- **(a) Write the patch now.** Scope it as: write patch + build + standalone smoke-test only,
  staged, never touching live plugin config. Same guardrails as the first (failed) attempt.
- **(b) Measure first.** Before touching `hwcontext_vulkan.c` at all, estimate or bench the actual
  ceiling: how much does the current `hwdownload,format=yuv420p` round trip actually cost in wall
  clock at the resolutions this box actually serves? If it's a small fraction of total transcode
  time (NVENC + the shader passes likely dominate), the payoff may not justify the risk of touching
  shared plumbing five other filters depend on.

(b) fits this project's stated philosophy better ("Measure first" is a named section in
`improvements.md`, and the one item everyone ranked #1 — encoder rate control — is itself a
"measure before you touch anything" case). Recommend (b), pending user confirmation.
