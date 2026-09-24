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
| **optix** (denoise) | **Done, now handles every sw_format NVDEC can produce.** Was: `cuMemcpyHtoD` input; `cuStreamSynchronize` + `cuMemcpyDtoH` output. Flow path: luma up, flow grid down, flow up again (`upload_luma`, `download_flow_grid`, `compute_flow`). Now: `vf_optix.c` takes `AV_PIX_FMT_CUDA` frames directly, reuses ffmpeg's own `AVCUDADeviceContext` (context+stream), and does NV-family/planar-444<->RGB float3, luma smoothing and flow-grid expansion with real CUDA C kernels in `gu_optix_nv12_rgbf32.cu` (compiled to PTX at build time with clang's NVPTX backend, no nvcc needed, embedded via `gu_optix_nv12_rgbf32_ptx.h`; same convention as `gu_dlpp_nv12_rgba.cu`/`gu_vsr_nv12_rgba.cu`). No host buffer anywhere on the per-frame path. Verified: `-vf optix=mode=temporal` runs straight from `-hwaccel cuda` decode into `h264_nvenc` encode with no `hwdownload`/`hwupload` anywhere in the graph, 140 real frames, PSNR 47.7dB / SSIM 0.998 against the source (a plausible mild denoise, not corruption). **2026-09-24 bug + fix:** NVDEC decodes 10-bit sources to `p010le`, not `nv12` -- the original nv12-only kernels' byte reads misread p010le's 16-bit-word layout, and `config_props` rejected it outright ("needs even-sized NV12, got p010le"), killing any transcode of 10-bit content (`Rick and Morty S08E06`, `yuv420p10le`, reproduced directly). Fixed first for nv12/p010le specifically, then **generalized the same pass to the complete, exhaustive NVDEC sw_format list** (`libavcodec/nvdec.c`'s `ff_nvdec_get_format`): `semiplanar_to_rgbf32`/`smooth_luma_dev` take sample width (1 or 2 bytes) and chroma vertical-subsampling as runtime parameters instead of one hard-coded format, covering nv12/nv16/p010le/p012le/p016le/p210le/p212le/p216le; `planar444_to_rgbf32` is a structurally distinct kernel for yuv444p/yuv444p10msble/yuv444p12msble/yuv444p16le (three separate full-resolution planes, no interleaved chroma at all). Every 16-bit-word format reduces to the 8-bit domain (`word >> 8`) before the same BT.709 matrix, since NVDEC always MSB-justifies a sub-16-bit sample regardless of real bit depth. Same generalization done in `dlpp_rtcuda`/`vsr_rtcuda` (`semiplanar_to_rgba`/`planar444_to_rgba`). VERIFIED against real content: the real 10-bit/8-bit sources this library actually has (nv12, p010le), full end-to-end decode->filter->encode plus a pixel-level regression check (identical mean byte value before/after the generalization refactor). VERIFIED, synthetic content: the six format-shape combinations this library has no source file for (nv12-shape, nv16-shape, p01x-shape, p21x-shape, yuv444p 8-bit, yuv444p 16-bit-word) via a standalone CUDA driver-API harness that launches the actual compiled kernel against synthetic device buffers and checks the real GPU output against a host-computed BT.709 reference -- all six passed, zero mismatches. | **Low.** Done first, as planned |
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
   enforced there too. **The hwmap half of this is now real for one path, not yet for these five
   filters**: 2026-09-24, `ffmpeg/0007-0009` fixed the chained `hwmap=derive_device=vulkan` ->
   `hwmap=derive_device=cuda` round trip (three separate bugs - a segfault, a stale-format
   self-heal, and a frame-format staleness fix; see `livetestbox.md`), and `UpscaleEngine.BuildChain`
   now uses it to let deband/kernel-scale/refine/chroma/deblur (the Vulkan libplacebo stage) run
   alongside the CUDA-native neural levels this project already ships (`dlpp_rtcuda`/`vsr_rtcuda` -
   RTXDLPP.md/RTXVSR.md, a different track from this doc's optix/ort/oidn/fsr2/dlss table, since
   those two never went through system memory in the first place). That is the SAME hwmap
   mechanism this item names, proven working end to end and in production, but it does not by
   itself move ort/oidn/fsr2/dlss onto hardware frames - those five still round-trip system memory
   exactly as this table describes until each is separately converted. What today's fix removes is
   one blocker for whichever of them gets converted next: once a filter reads/writes
   `AV_PIX_FMT_CUDA` (optix's own conversion, done, is the model - see the table row below) or Vulkan
   hw frames directly, this same bridge is available to route it through the other stage's Vulkan
   frames without a host round trip either.
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
