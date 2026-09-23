# Roadmap: features from driver inspection

What the NVIDIA driver reverse-engineering work (TASK.md, `~/dev/rtx-video-re`) makes possible for
the patched ffmpeg, and for media servers beyond Jellyfin.

Status words mean exactly this:

- **Works**: measured on CT114.
- **Runs**: executes on CT114, output not yet useful.
- **Not started**: only inferred from DLL names, patch names or kernel strings.

Nothing below is a commitment. TASK.md stays the source of truth for the active work.

## What the inspection work has unlocked

Each of these is reusable by every feature below:

- **Windows NVIDIA DLLs on Linux.** `pe_map` loads `nvaivpx.dll` and resolves 99 of 99 imports. The
  loader works around the Windows thread setup (TEB via `%gs`, which glibc does not use).
- **Host callback slots backed by real CUDA.** The DLL asks the host to allocate memory, load
  modules, look up functions, launch kernels and upload weights. We answer with real CUDA calls.
- **Launch capture.** Every `cuLaunchKernel` is logged with the kernel name, grid size and argument
  buffer, so the network's shape can be read from the log.
- **A whole ffmpeg chain in VRAM.** `vf_aivp_spike` goes NVDEC -> nv12 to RGBA -> DLL Process ->
  RGBA to nv12 -> NVENC. It makes zero per-frame copies between host and GPU and runs at 400 to
  440 fps at 960x540 -> 1920x1080.
- **GPU kernels without nvcc.** The colour conversion kernels are hand-written PTX, loaded with
  `cuModuleLoadData`.

## Features

| # | Feature | Source | Status | What it gives ffmpeg |
|---|---|---|---|---|
| 1 | RTX VSR (`vsr_drv_cuda`) | `nvaivpx.dll` / AIVP | Runs. Blocked on L17 (network output unused) | Neural upscaling for 720p to 1080p/4K transcodes. The main target |
| 2 | Bypass resampler (`AIVP_FLAGS=0x100`) | same DLL | **Works**: 43.93 dB vs 41.66 dB bilinear, 0.08 ms/frame | A GPU scaler better than bilinear, usable now. A fallback level while L17 is open |
| 3 | RTX Video HDR (TrueHDR, SDR to HDR) | `truehdr_drv_cuda` in the patch series | Not started | SDR library shown as HDR10 on HDR TVs. Stock ffmpeg has nothing like it |
| 4 | RTX Dynamic Vibrance (DeepDVC) | `deepdvc_drv_cuda` in the patch series | Not started | Neural colour and vibrance enhancement. Small and low risk |
| 5 | DLPP | `nvdlppx.dll` | Not started | A sibling SR network. A fallback route for #1 if AIVP stays gated |
| 6 | NGX DLISR | `nvngx_dlisr.dll` | Init works, stuck at the `CreateFeature` trap | Image SR on fixed 256x256 tiles. Mainly de-risking |
| 7 | Frame interpolation (NVOFFRUC / SmoothMotion) | patches 0010-0023 | Patches exist, never built | 24 to 48/60 fps motion smoothing on the GPU |

## Shared infrastructure

- **A generic driver DLL filter.** `vf_aivp_spike` does not depend on the feature it runs: nv12/RGBA
  PTX, pooled surfaces and ffmpeg's CUDA stream. Features #3 to #6 would reuse it and supply only
  their own Process call and parameters.
- **A self-test and a driver hash gate.** Required before any of this ships. DLL offsets break when
  the driver updates, so the filter checks itself at startup and reports DEGRADED the way
  `vf_dlss.c` does.
- **The copy-count interposer as a standing check.** It proves the GPU-resident preset (TASK.md
  Track C) still holds for each new filter.
- **Capture, then codegen.** Once a network actually contributes to the output, the captured kernels
  and weights let us write our own filter that does not load the DLL. That removes the dependence on
  the driver version.
- **Vulkan <-> CUDA hwmap** (`vulkan-cuda-hwmap-task.md`). Lets these filters chain with the
  libplacebo passes without downloading frames to system RAM.

## Suggested order

1. **#2**, because it ships soonest.
2. **#1**, which means solving L17.
3. **#3 and #4**, which are cheap once the shared filter exists.
4. **#7**, the largest new capability.
5. **#5 and #6**, only as fallbacks if AIVP stays gated.

## GPU-only DLSS (`vf_dlss` rewrite)

**Status: not started. Plan only, from reading `ffmpeg/vf_dlss.c` and `ffmpeg/gu_inputs.h`.**

Today every frame crosses the host bus about 7 times, and the CPU blocks on each frame:

| Step | Code | Host traffic |
|---|---|---|
| Input format | `query_formats`: `AV_PIX_FMT_GBRPF32LE` | Decoded frame downloaded before the filter |
| Optical flow | `gu_upload_luma`, NVOFA, `gu_download_grid` | Luma up, flow grid down (`cuMemcpy2D`) |
| Flow, reactive mask, depth maths | `gu_inputs_frame` | CPU |
| Pack colour and motion vectors | `pack_color_slice`, `pack_mv_slice` | CPU threads |
| Depth and bias | `memcpy` into `.host` staging | CPU copy |
| Upload | `cmd_upload` x4 | 4 uploads per frame |
| Output | `vkCmdCopyImageToBuffer`, `submit_wait` | Readback plus a blocking wait |
| Unpack | `unpack_slice` | CPU, then an upload for NVENC |

Plan, keeping NGX on Vulkan:

1. **Vulkan frames in and out.** `AV_PIX_FMT_VULKAN` via `FFVulkanContext`, like the stock
   `vf_*_vulkan` filters. Chain: `-hwaccel vulkan` -> `dlss` -> `hwmap=derive_device=cuda` ->
   `h264_nvenc`. ffmpeg maps Vulkan to CUDA but not the reverse, so decode happens in Vulkan.
2. **Colour conversion in a compute shader:** nv12/p010 into DLSS's float input image.
3. **Optical flow on the GPU:** NVOFA's Vulkan interface (believed to be `nvOpticalFlowVulkan.h`,
   to be confirmed against the SDK). The flow grid stays in a GPU buffer.
4. **Motion vectors in shaders:** upsample, negate and fp16-pack the flow. The reactive mask comes
   from forward/backward consistency.
5. **Depth:** constant or flow-derived depth from a shader. The ONNX depth model via ORT CUDA with
   Vulkan-to-CUDA external memory is a later option.
6. **Output:** a compute shader converts DLSS's RGBA straight into the output `AVVkFrame` as nv12.
7. **No blocking wait:** ffmpeg exec pools and `AVVkFrame` timeline semaphores, using
   `ff_vk_exec_add_dep_signal_sem` from patch `0039`.

What stays on the host: command recording, submits, DLSS scalars (jitter, reset, sharpness) and
NGX setup. None of that is frame data.

Proof is the same as the GPU-resident preset in TASK.md: zero per-frame copies after init, no
`hwdownload`/`hwupload`, near-zero PCIe in `nvidia-smi dmon`, flat CPU and RSS. PSNR against the
current `vf_dlss` output on the same frames should also be close.

Caveats:

- This makes DLSS faster, not better. The motion vectors are still synthesised, so it stays DEGRADED.
- It rewrites most of `vf_dlss.c` and adds about 5 shaders. `gu_inputs.h` is shared with `vf_fsr2`,
  so FSR2 would gain from the same flow and mask shaders.
- To check first: whether NGX exposes DLSS SR through its CUDA API. If it does, the filter could reuse
  the `vf_aivp_spike` CUDA chain instead. The belief is that it is D3D and Vulkan only.

Suggested first slice: steps 1 and 7, which give the biggest win for the least work.

## Plex support

**Status: not started. Nothing below has been tested against a Plex server.**

The patched ffmpeg and its filters do not depend on Jellyfin. Only the plugin (config page, probe,
client panel, `StreamOptions`, the shim's routing) is Jellyfin-specific. So the filters could serve
Plex too, but the way they get into a transcode would be entirely different.

### How Plex differs (assumptions to verify first)

- **Plex runs its own transcoder fork.** It calls `Plex Transcoder`, under
  `/usr/lib/plexmediaserver/`. It is not a stock ffmpeg, and Plex has no setting to point it at
  another binary.
- **Plex has no plugin system to hook into.** Server plugins were retired years ago, so there is no
  equivalent of `UpscaleEngine` or the web-injected client panel.
- **The command line is Plex-specific.** Plex passes its own flags and output formats (progress
  URLs, its segmenting and logging options). A stock-based ffmpeg may reject some of them.
- **Plex updates replace the binary.** Anything installed in its directory is overwritten on update.

### Possible routes

| Route | How | Risk |
|---|---|---|
| A. Wrapper around `Plex Transcoder` | Rename the real binary and put a script in its place. The script injects our filter into the chain, then runs either our ffmpeg or the real transcoder | Must understand Plex's flags. Updates undo it, so a reinstall hook is needed |
| B. Build our filters into Plex's transcoder | Plex publishes its transcoder source for licence compliance. Apply our `vf_*` patches to that tree | Depends on whether the published source builds and matches what ships. Heaviest option |
| C. Server-wide default only | Route A with one fixed enhancement chain from a config file, no per-user choice | Simplest. No UI, so no per-session control |

The likely first step is **C, built on route A**. A small spike would:

1. Capture real `Plex Transcoder` command lines for direct stream, transcode and hardware transcode.
2. Check whether our ffmpeg accepts them unchanged.
3. If it does not, map the flags that differ.

Only then design the wrapper.

### Carried over from this project's rules

- **Degrade, don't fail.** If our binary or filter is missing, the wrapper runs the real transcoder
  unchanged. A dead stream is worse than an unenhanced one.
- **Prove the chain.** Log the built command and check that the filter is present when on and absent
  when off, the same audit as `journalctl -u jellyfin | grep libplacebo`.
- **Stay out of the GPL tree.** No NVIDIA binaries and no Plex binaries go into this repo.
