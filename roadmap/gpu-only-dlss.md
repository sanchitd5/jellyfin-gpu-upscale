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
- To check first: whether NGX exposes DLSS SR through its CUDA API. If it does, the filter could reuse
  the `vf_aivp_spike` CUDA chain instead. The belief is that it is D3D and Vulkan only.

Suggested first slice: steps 1 and 7, which give the biggest win for the least work.

