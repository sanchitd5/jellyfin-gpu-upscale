/*
 * Minimal <cuda.h> stand-in for building vf_optix.c without the CUDA toolkit.
 *
 * The OptiX and NVIDIA Optical Flow headers include <cuda.h> for the CUDA driver
 * API *types* only - CUcontext, CUstream, CUdeviceptr and friends.  nv-codec-headers
 * (ffnvcodec), which this FFmpeg build already requires for NVENC/NVDEC, declares
 * every one of them, so pointing <cuda.h> at that header removes a multi-gigabyte
 * toolkit dependency from the build.  The driver entry points themselves are loaded
 * at run time by ffnvcodec's dynlink loader, exactly as FFmpeg's own CUDA code does.
 *
 * This file is part of the jellyfin-gpu-upscale sources and contains no NVIDIA code.
 *
 * This file is free software; you can redistribute it and/or modify it under the
 * terms of the GNU Lesser General Public License as published by the Free Software
 * Foundation; either version 2.1 of the License, or (at your option) any later version.
 */
#ifndef GPUUPSCALE_COMPAT_CUDA_H
#define GPUUPSCALE_COMPAT_CUDA_H
#include <ffnvcodec/dynlink_cuda.h>
#endif /* GPUUPSCALE_COMPAT_CUDA_H */
