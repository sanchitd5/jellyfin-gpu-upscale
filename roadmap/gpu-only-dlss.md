# GPU-only DLSS (`vf_dlss` rewrite)

Part of the [roadmap](README.md). [gpu-only-filters.md](gpu-only-filters.md) applies the same idea to the other filters.

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
- **Checked, confirmed, not just believed**: NGX does NOT expose DLSS SR through its CUDA API.
  Verified on CT114 2026-09-22 (`ARCHITECTURE.md`'s Tier 2 section has the full detail) - the
  installed NGX SDK (`NGX_SDK=/root/gameupscale/dlss`) ships no CUDA entry point for
  `NVSDK_NGX_Feature_SuperSampling` (DLSS SR/DLAA) at all, only D3D11/D3D12/Vulkan helper
  wrappers. The SDK's own CUDA helper (`nvsdk_ngx_helpers_cuda.h`) covers only
  `NVSDK_NGX_Feature_ImageSignalProcessing` (DLISP, a distinct legacy sharpen/denoise feature),
  not `Feature_SuperSampling`. The low-level `NVSDK_NGX_CUDA_CreateFeature` entry point takes a
  generic feature-ID enum so it will compile against `Feature_SuperSampling`, but nothing in the
  shipped headers, helper wrappers or README establishes the redistributable
  (`libnvidia-ngx-dlss.so.310.9.1`) actually implements a CUDA execution path for it - calling it
  would be guessing at an unshipped API. So the `vf_aivp_spike` CUDA-chain reuse this bullet
  floated is closed, not open: this plan stays on Vulkan (steps 1-7 above), or would need a newer
  NGX SDK release that documents CUDA support for `Feature_SuperSampling`.

Suggested first slice: steps 1 and 7, which give the biggest win for the least work.

## The bidirectional CUDA<->Vulkan bridge now exists - what it does and does not change here

**Fixed 2026-09-24, verified end to end on real GPU** (five real bugs found and fixed getting there;
full root causes and commands in `livetestbox.md`, summarized in `ARCHITECTURE.md`'s Tier 2
section): `hwmap=derive_device=vulkan` and `hwmap=derive_device=cuda` now compose reliably in either
order, chained, including round-tripping OUT to Vulkan and back INTO CUDA within one filtergraph -
not just the single one-way hop step 1 above already relied on (Vulkan->CUDA, `0006`, which worked
before this session too). Verified real chain shape: a CUDA-native filter -> `hwmap=derive_device=
vulkan` -> one or more Vulkan-only stages (libplacebo: scale/kernel, deband, chroma, refine, unblur)
-> `hwmap=derive_device=cuda` -> back to a CUDA-native filter -> NVENC, `EXIT:0`, real frame counts,
composed with `dlpp_rtcuda` specifically (see `UpscaleEngine.BuildChain`'s CUDA-native branch,
`ffmpeg/0007-0009`).

**What this does NOT change about this plan**: nothing in steps 1-7 above gets shorter or skippable.
`vf_dlss.c` today is still `AV_PIX_FMT_GBRPF32LE`-only with no hardware-frame support at all and its
own bespoke `VkDevice` outside FFmpeg's `AVHWDeviceContext` (confirmed by reading the file directly,
2026-09-24 - `pixel_fmts[]` at line 164, `vk_init()`'s raw `VkDeviceCreateInfo` at line ~292). The
bridge is plumbing between two *already hw-frame-native* filters; it does nothing for a filter that
isn't hw-frame-native yet. This plan's own work - rewriting `vf_dlss.c` to read/write real
`AV_PIX_FMT_VULKAN` frames - is unchanged and still not started.

**What the bridge DOES unlock, once (and only once) this rewrite happens**: composing a Vulkan-
native `dlss` with the CUDA-native filters this project already ships, in one session, with no
system-memory round trip anywhere in the composition - e.g. `optix (CUDA, denoise) ->
hwmap=derive_device=vulkan -> dlss (Vulkan) -> hwmap=derive_device=cuda -> dlpp_rtcuda or
vsr_rtcuda (CUDA) -> NVENC`, or `dlss` alongside `chroma`/`deband`/`refine`/unblur on the SAME
Vulkan hop it already needs for NGX, without paying a second bridge for each. Before this fix, that
composition would have hit the exact chained-round-trip bugs this session found (a segfault first,
then two different ENOSYS causes) - so the honest way to say this is: the bridge removes a blocker
that would otherwise have hit whoever combined a rewritten `dlss` with a CUDA-native filter next,
not a blocker on the rewrite itself.

**Same story for `fsr2`** (shares `gu_inputs.h` with `dlss`, per the caveats above, and is equally
`GBRPF32LE`-only and Vulkan-only today, unverified but presumably the same architecture - not
re-read line by line this pass, worth confirming before relying on this claim for `fsr2`
specifically). Its own equivalent rewrite is out of scope for this file (see
[gpu-only-filters.md](gpu-only-filters.md)) but would benefit from the same bridge the same way.

