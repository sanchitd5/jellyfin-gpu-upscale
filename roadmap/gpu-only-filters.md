# GPU-only versions of the existing filters

Part of the [roadmap](README.md). The detailed plan for dlss is in [gpu-only-dlss.md](gpu-only-dlss.md).

**Status: not started. From reading and grepping `ffmpeg/vf_*.c`, not from measurements.**

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
| **optix** (denoise) | `cuMemcpyHtoD` input; `cuStreamSynchronize` + `cuMemcpyDtoH` output. Flow path: luma up, flow grid down, flow up again (`upload_luma`, `download_flow_grid`, `compute_flow`) | Already CUDA inside. Take `AV_PIX_FMT_CUDA` frames, convert nv12 to RGB with PTX (reuse `vf_aivp_spike`'s kernels), keep the flow grid on the device, and write the output straight into a CUDA frame | **Low.** Best first candidate |
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
