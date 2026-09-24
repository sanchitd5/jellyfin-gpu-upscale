# GPU-only versions of the existing filters

Part of the [roadmap](README.md). The detailed plan for dlss is in [gpu-only-dlss.md](gpu-only-dlss.md).

**Status: optix done (2026-09-23), verified on a scratch build on CT114. ort/oidn/fsr2/dlss not
started. The optix conversion is from an actual GPU run; the other four rows are still from
reading and grepping `ffmpeg/vf_*.c`, not from measurements.**

## The shared problem

All five custom filters declare `AV_PIX_FMT_GBRPF32LE`: planar 32-bit float RGB in system RAM,
12 bytes per pixel. So a chain with any of them:

1. downloads the decoded frame from the GPU,
2. converts it to float RGB on the CPU,
3. uploads it again to whatever GPU API the filter uses,
4. reads the result back,
5. converts it on the CPU, then uploads it once more for NVENC.

The GPU-resident preset (TASK.md Track C) requires none of that.

## Per filter

| Filter | Host traffic per frame today | GPU-only route | Effort |
|---|---|---|---|
| **optix** (denoise) | **Done, now p010le-aware.** Was: `cuMemcpyHtoD` input; `cuStreamSynchronize` + `cuMemcpyDtoH` output. Flow path: luma up, flow grid down, flow up again (`upload_luma`, `download_flow_grid`, `compute_flow`). Now: `vf_optix.c` takes `AV_PIX_FMT_CUDA` frames directly, reuses ffmpeg's own `AVCUDADeviceContext` (context+stream), and does NV12/P010LE<->RGB float3, luma smoothing and flow-grid expansion with real CUDA C kernels in `gu_optix_nv12_rgbf32.cu` (compiled to PTX at build time with clang's NVPTX backend, no nvcc needed, embedded via `gu_optix_nv12_rgbf32_ptx.h`; same convention as `gu_dlpp_nv12_rgba.cu`/`gu_vsr_nv12_rgba.cu`). No host buffer anywhere on the per-frame path. Verified: `-vf optix=mode=temporal` runs straight from `-hwaccel cuda` decode into `h264_nvenc` encode with no `hwdownload`/`hwupload` anywhere in the graph, 140 real frames, PSNR 47.7dB / SSIM 0.998 against the source (a plausible mild denoise, not corruption). **2026-09-24 bug + fix:** NVDEC decodes 10-bit sources to `p010le`, not `nv12` -- the original nv12-only kernels' byte reads misread p010le's 16-bit-word layout, and `config_props` rejected it outright ("needs even-sized NV12, got p010le"), killing any transcode of 10-bit content (`Rick and Morty S08E06`, `yuv420p10le`, reproduced directly). Fixed by adding p010-aware kernel variants (`p010_to_rgbf32`, `p010_smooth_luma_dev`) that reduce the 16-bit p010 word to the 8-bit domain (`word >> 8`) before the same BT.709 matrix, selected at `config_props`/`filter_frame` time by the input's actual `sw_format`. Same class of bug found and fixed in `dlpp_rtcuda`/`vsr_rtcuda` (`p010_to_rgba`). Verified against the real 10-bit source, plus a full 8-bit regression re-run. | **Low.** Done first, as planned |
| **ort** (Real-ESRGAN etc.) | CPU `pack_slice`, `CreateTensorWithDataAsOrtValue` on host memory, `Run`, CPU unpack. The CUDA EP copies in and out on every run | ORT **IoBinding** with a CUDA `OrtMemoryInfo`: the input tensor wraps the CUDA frame's device pointer, and the output goes to a device buffer. Pack and unpack as PTX kernels | **Low to medium** |
| **oidn** (denoise) | `OIDN_STORAGE_MANAGED` buffers filled and read by the CPU | OIDN 2.x CUDA device (`oidnNewCUDADevice` on ffmpeg's stream) plus `oidnNewSharedBuffer` over the CUDA frame's memory | **Medium.** Needs an OIDN build with the CUDA backend |
| **fsr2** | Same pattern as dlss: `cmd_upload`/`cmd_download` staging, `memcpy` of depth and reactive | Same Vulkan plan as [gpu-only-dlss.md](gpu-only-dlss.md). Shares `gu_inputs.h` | **Medium**, cheaper once dlss is done |
| **dlss** | See [gpu-only-dlss.md](gpu-only-dlss.md) | | Medium to high |

## Shared pieces that pay off across filters

1. **`gu_inputs.h` on the GPU:** optical flow, motion vectors, the reactive mask and depth. dlss and
   fsr2 use it. optix keeps its own copy of the flow code and could move onto the shared GPU version.
2. **One PTX colour-conversion module:** nv12/p010 to RGB float or half and back, for optix, ort and
   oidn. `vf_aivp_spike` already has it, and it needs no nvcc.
3. **Half precision where the backend accepts it.** OptiX, ORT (fp16 models) and DLSS all take fp16.
   That halves memory bandwidth even before going fully GPU-only.
4. **Engine chain building.** Once the filters take hardware frames, `UpscaleEngine` must emit
   `-hwaccel` and hwmap steps instead of `hwdownload,format=gbrpf32le`. The GPU-resident preset is
   enforced there too.
5. **The copy-count interposer as a regression check,** run against each filter.

## Order

1. **optix:** already CUDA; the biggest cut in copies for the least work.
2. **Shared PTX colour module plus ort IoBinding:** unblocks the super-resolution path the plugin
   already ships (Real-ESRGAN).
3. **oidn**, if the CUDA backend is available.
4. **`gu_inputs.h` on the GPU**, then dlss and fsr2 on Vulkan.

## Proof, per filter

The same as the GPU-resident preset: zero per-frame host copies after init, no
`hwdownload`/`hwupload` in the built command, near-zero PCIe in `nvidia-smi dmon`, flat CPU and RSS.
Also check PSNR against today's output on the same frames.

## Caveat

These are speed and CPU wins, not quality wins. Output should stay close to today's; that is what the
PSNR check is for.
