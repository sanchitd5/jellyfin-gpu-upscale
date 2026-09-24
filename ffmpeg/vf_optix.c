/*
 * Copyright (c) 2026
 *
 * This file is part of FFmpeg.
 *
 * FFmpeg is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * FFmpeg is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with FFmpeg; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
 */

/**
 * @file
 * Denoise video frames with the NVIDIA OptiX AI denoiser.
 *
 * The point of this filter, and the reason it exists next to vf_oidn, is
 * mode=temporal.  Every other denoiser reachable here is purely spatial: it
 * judges a frame on its own and therefore cannot see, let alone remove,
 * inter-frame flicker.  OptiX's TEMPORAL model takes the previous denoised
 * output plus a per-pixel motion field, reprojects the former through the
 * latter, and blends - which is the one axis on which it can beat a spatial
 * denoiser outright.
 *
 * Nothing here needs the OptiX SDK's libraries or the CUDA toolkit at run time:
 *  - OptiX is implemented *in the display driver*.  optix_stubs.h dlopen()s
 *    libnvoptix.so.1 and pulls the function table out of it.
 *  - The CUDA driver API comes from FFmpeg's own hwcontext_cuda: this filter
 *    takes AV_PIX_FMT_CUDA frames and reuses the CUDA context and stream that
 *    hwaccel decode already created, the same way vf_dlpp_rtcuda.c and
 *    vf_vsr_rtcuda.c do.  It never retains a CUDA context of its own.
 *  - The motion field comes from NVOFA, the fixed-function optical flow engine
 *    present on Turing and later, reached by dlopen()ing
 *    libnvidia-opticalflow.so.1.  It is hardware, it runs beside the SMs
 *    instead of on them, and it costs about a millisecond a frame.
 * Only headers are needed to build, and they are not shipped with this
 * repository - see OPTIX.md.
 *
 * Why NVOFA and not something better: a *denoiser* needs only approximate
 * reprojection.  Where it is wrong the model falls back towards the spatial
 * result rather than smearing, so flow quality buys diminishing returns very
 * quickly.  NVOFA is free (it is idle silicon otherwise) and produces a
 * 4x4-granularity field that is upsampled here on the GPU.
 *
 * GPU-resident conversion (roadmap/gpu-only-filters.md, "optix" row): this
 * filter used to declare AV_PIX_FMT_GBRPF32LE and do its own cuMemcpyHtoD /
 * cuMemcpyDtoH round trip every frame, on top of whatever hwdownload /
 * hwupload ffmpeg had to insert around it.  It was pure CUDA already, so
 * instead it now takes AV_PIX_FMT_CUDA frames directly (both nv12 and p010le
 * sw_format): a small CUDA C module (gu_optix_nv12_rgbf32.cu, compiled to PTX
 * at build time with clang's NVPTX backend and embedded via
 * gu_optix_nv12_rgbf32_ptx.h -- CT114 has no nvcc, same convention as
 * gu_dlpp_nv12_rgba.cu / gu_vsr_nv12_rgba.cu) converts NV12 or P010LE <-> the
 * interleaved float3 RGB buffer OptiX wants, and two more small kernels in
 * the same module smooth the NVOFA luma input (nv12 and p010le variants) and
 * expand its S10.5 flow grid, both device-to-device.  Nothing above this
 * filter has to hwdownload/hwupload around it any more, and nothing inside
 * it touches host memory on the per-frame path.
 *
 * p010le support: NVDEC decodes 10-bit sources straight to p010le (10-bit
 * samples packed into 16-bit little-endian words, value = sample << 6), not
 * nv12.  config_props below accepts either sw_format and filter_frame /
 * compute_flow_dev pick the matching kernel; the p010 kernels reduce to the
 * 8-bit domain (word >> 8) before the same BT.709 matrix the nv12 kernels
 * use, since the denoiser's own output stays 8-bit NV12 regardless of input.
 */

#include <string.h>
#include <stdint.h>

#include "libavutil/hwcontext.h"
#include "libavutil/hwcontext_cuda_internal.h"
#include "libavutil/cuda_check.h"
#include "libavutil/internal.h"
#include "libavutil/mem.h"
#include "libavutil/opt.h"
#include "libavutil/pixdesc.h"
#include "avfilter.h"
#include "filters.h"
#include "video.h"

/* OPTIXAPI becomes "static", so the header-only stub table has internal linkage
 * and needs no separate translation unit.  Must precede the OptiX headers. */
#define OPTIX_ENABLE_SDK_MIXING 1
#include <optix.h>
#include <optix_stubs.h>
#include <optix_function_table_definition.h>

/* The Optical Flow SDK header declares this C++-style ("struct X" with no
 * typedef) and then uses the bare name.  Harmless in C once it is typedef'd. */
typedef struct NV_OF_ROI_RECT NV_OF_ROI_RECT;
#include <nvOpticalFlowCuda.h>

#include <dlfcn.h>

#include "gu_optix_nv12_rgbf32_ptx.h"

enum OptixFilterMode {
    OPTIX_MODE_LDR = 0,
    OPTIX_MODE_HDR,
    OPTIX_MODE_TEMPORAL,
};

enum OptixFlowSource {
    OPTIX_FLOW_NVOF = 0,
    OPTIX_FLOW_NONE,
};

/* NVOFA reports flow on a 4x4 grid in S10.5 fixed point.  Grid 4 is the cheapest
 * granularity the engine offers that is also its most accurate per unit time; a
 * denoiser cannot use more. */
#define OPTIX_FLOW_GRID 4

typedef struct OptixContext {
    const AVClass *class;

    int   mode;
    int   flow_source;
    float blend;

    int w, h;

    AVCUDADeviceContext *hwctx;
    AVBufferRef *out_frames;

    CUmodule   mod;
    CUfunction k_nv12_to_rgbf32, k_p010_to_rgbf32, k_rgbf32_to_nv12;
    CUfunction k_smooth_luma, k_p010_smooth_luma, k_expand_flow;
    int is_p010;   /* input sw_format was p010le, not nv12 */

    OptixDeviceContext optix_ctx;
    OptixDenoiser      denoiser;
    OptixDenoiserSizes sizes;

    CUdeviceptr d_state;
    CUdeviceptr d_scratch;
    CUdeviceptr d_in;
    CUdeviceptr d_out[2];    /* ping-pong: OptiX forbids output == previousOutput */
    CUdeviceptr d_flow;
    /* hdr only: the model is scale-dependent and needs an intensity value. The output is a single
     * float; computeIntensitySizeInBytes is the SCRATCH that call needs (optix_types.h:1774), and
     * nothing documents the denoiser's own scratch as large enough for it, so it gets its own. */
    CUdeviceptr d_intensity;
    CUdeviceptr d_intensity_scratch;
    int         out_slot;
    int         have_previous;

    int grid_w, grid_h;

    /* NVOFA */
    void *nvof_lib;
    NV_OF_CUDA_API_FUNCTION_LIST nvof;
    NvOFHandle nvof_session;
    NvOFGPUBufferHandle nvof_frame[2];
    NvOFGPUBufferHandle nvof_out;
    uint32_t nvof_in_pitch, nvof_out_pitch;
    int nvof_slot;
    int nvof_ready;
} OptixContext;

/* Statement form: checks and returns on failure. Everywhere this filter needs
 * to unwind through a goto instead (to pop the pushed CUDA context first),
 * it uses CHECK_CU_EXPR below instead. */
#define CHECK_CU(x)                                                             \
    do {                                                                        \
        int _cu_ret = FF_CUDA_CHECK_DL(ctx, s->hwctx->internal->cuda_dl, (x));  \
        if (_cu_ret < 0)                                                        \
            return _cu_ret;                                                     \
    } while (0)

/* Expression form, for call sites that need to goto a cleanup label instead
 * of returning directly (filter_frame, compute_flow_dev: both have a pushed
 * CUDA context to pop first). */
#define CHECK_CU_EXPR(x) FF_CUDA_CHECK_DL(ctx, s->hwctx->internal->cuda_dl, (x))

#define CHECK_OPTIX(expr)                                                        \
    do {                                                                        \
        OptixResult _ox_ret = (expr);                                           \
        if (_ox_ret != OPTIX_SUCCESS) {                                         \
            av_log(ctx, AV_LOG_ERROR, "OptiX %s failed: %s\n", #expr,           \
                   optixGetErrorString(_ox_ret));                               \
            return AVERROR_EXTERNAL;                                            \
        }                                                                       \
    } while (0)

static void optix_log_cb(unsigned int level, const char *tag, const char *message, void *cbdata)
{
    av_log((AVFilterContext *)cbdata, level <= 2 ? AV_LOG_ERROR : AV_LOG_VERBOSE,
           "OptiX [%s] %s\n", tag ? tag : "?", message ? message : "");
}

static av_cold int nvof_init(AVFilterContext *ctx)
{
    OptixContext *s = ctx->priv;
    NV_OF_STATUS (*create_instance)(uint32_t, NV_OF_CUDA_API_FUNCTION_LIST *);
    NV_OF_INIT_PARAMS init;
    NV_OF_BUFFER_DESCRIPTOR desc;
    NV_OF_CUDA_BUFFER_STRIDE_INFO stride;
    NV_OF_STATUS st;

    s->nvof_lib = dlopen("libnvidia-opticalflow.so.1", RTLD_NOW);
    if (!s->nvof_lib) {
        av_log(ctx, AV_LOG_WARNING, "NVOFA unavailable (%s)\n", dlerror());
        return AVERROR(ENOSYS);
    }
    create_instance = dlsym(s->nvof_lib, "NvOFAPICreateInstanceCuda");
    if (!create_instance) {
        av_log(ctx, AV_LOG_WARNING, "NvOFAPICreateInstanceCuda not found\n");
        return AVERROR(ENOSYS);
    }
    memset(&s->nvof, 0, sizeof(s->nvof));
    if ((st = create_instance(NV_OF_API_VERSION, &s->nvof)) != NV_OF_SUCCESS) {
        av_log(ctx, AV_LOG_WARNING, "NVOFA instance failed (%d)\n", st);
        return AVERROR(ENOSYS);
    }
    if ((st = s->nvof.nvCreateOpticalFlowCuda(s->hwctx->cuda_ctx, &s->nvof_session)) != NV_OF_SUCCESS) {
        av_log(ctx, AV_LOG_WARNING, "NVOFA session failed (%d)\n", st);
        return AVERROR(ENOSYS);
    }

    memset(&init, 0, sizeof(init));
    init.width        = s->w;
    init.height       = s->h;
    init.outGridSize  = NV_OF_OUTPUT_VECTOR_GRID_SIZE_4;
    init.hintGridSize = NV_OF_HINT_VECTOR_GRID_SIZE_UNDEFINED;
    init.mode         = NV_OF_MODE_OPTICALFLOW;
    /* FAST: the quality levels above it cost several times as much and a denoiser
     * cannot spend the difference.  Measured rather than assumed - see OPTIX.md. */
    init.perfLevel    = NV_OF_PERF_LEVEL_FAST;
    if ((st = s->nvof.nvOFInit(s->nvof_session, &init)) != NV_OF_SUCCESS) {
        av_log(ctx, AV_LOG_WARNING, "NVOFA init failed (%d)\n", st);
        return AVERROR(ENOSYS);
    }

    s->grid_w = (s->w + OPTIX_FLOW_GRID - 1) / OPTIX_FLOW_GRID;
    s->grid_h = (s->h + OPTIX_FLOW_GRID - 1) / OPTIX_FLOW_GRID;

    memset(&desc, 0, sizeof(desc));
    desc.width = s->w;
    desc.height = s->h;
    desc.bufferFormat = NV_OF_BUFFER_FORMAT_GRAYSCALE8;
    desc.bufferUsage  = NV_OF_BUFFER_USAGE_INPUT;
    for (int i = 0; i < 2; i++) {
        st = s->nvof.nvOFCreateGPUBufferCuda(s->nvof_session, &desc,
                                             NV_OF_CUDA_BUFFER_TYPE_CUDEVICEPTR, &s->nvof_frame[i]);
        if (st != NV_OF_SUCCESS) {
            av_log(ctx, AV_LOG_WARNING, "NVOFA input buffer failed (%d)\n", st);
            return AVERROR(ENOSYS);
        }
    }
    desc.width = s->grid_w;
    desc.height = s->grid_h;
    desc.bufferFormat = NV_OF_BUFFER_FORMAT_SHORT2;
    desc.bufferUsage  = NV_OF_BUFFER_USAGE_OUTPUT;
    st = s->nvof.nvOFCreateGPUBufferCuda(s->nvof_session, &desc,
                                         NV_OF_CUDA_BUFFER_TYPE_CUDEVICEPTR, &s->nvof_out);
    if (st != NV_OF_SUCCESS) {
        av_log(ctx, AV_LOG_WARNING, "NVOFA output buffer failed (%d)\n", st);
        return AVERROR(ENOSYS);
    }

    /* These two pitches drive every device-side access of NVOFA's own buffers
     * (the luma smoothing kernel writes at nvof_in_pitch, the flow-expansion
     * kernel reads at nvof_out_pitch).  On failure the stride struct is
     * untouched, so an unchecked call leaves them holding stack garbage.
     * Degrade to zero flow instead. */
    if ((st = s->nvof.nvOFGPUBufferGetStrideInfo(s->nvof_frame[0], &stride)) != NV_OF_SUCCESS) {
        av_log(ctx, AV_LOG_WARNING, "NVOFA input stride failed (%d)\n", st);
        return AVERROR(ENOSYS);
    }
    s->nvof_in_pitch = stride.strideInfo[0].strideXInBytes;
    if ((st = s->nvof.nvOFGPUBufferGetStrideInfo(s->nvof_out, &stride)) != NV_OF_SUCCESS) {
        av_log(ctx, AV_LOG_WARNING, "NVOFA output stride failed (%d)\n", st);
        return AVERROR(ENOSYS);
    }
    s->nvof_out_pitch = stride.strideInfo[0].strideXInBytes;

    s->nvof_ready = 1;
    av_log(ctx, AV_LOG_VERBOSE, "NVOFA flow %dx%d on a %dx%d grid\n",
           s->w, s->h, s->grid_w, s->grid_h);
    return 0;
}

/* Everything below here needs the CUDA context current.  It is a separate
 * function so that the push and the pop in config_props are a matched pair:
 * CHECK_CU/CHECK_OPTIX return straight out of whatever function they sit in,
 * so any failure between the two would otherwise leave this thread's context
 * stack unbalanced - which then breaks uninit()'s own push/pop. */
static int config_props_pushed(AVFilterContext *ctx)
{
    OptixContext *s = ctx->priv;
    OptixDeviceContextOptions ctx_options;
    OptixDenoiserOptions dn_options;
    OptixDenoiserModelKind kind;
    const size_t npix = (size_t)s->w * s->h;
    const size_t rgb_bytes = npix * 3 * sizeof(float);
    int ret;

    CHECK_CU(s->hwctx->internal->cuda_dl->cuModuleLoadData(&s->mod, gu_optix_nv12_rgbf32_ptx));
    CHECK_CU(s->hwctx->internal->cuda_dl->cuModuleGetFunction(&s->k_nv12_to_rgbf32, s->mod, "nv12_to_rgbf32"));
    CHECK_CU(s->hwctx->internal->cuda_dl->cuModuleGetFunction(&s->k_p010_to_rgbf32, s->mod, "p010_to_rgbf32"));
    CHECK_CU(s->hwctx->internal->cuda_dl->cuModuleGetFunction(&s->k_rgbf32_to_nv12, s->mod, "rgbf32_to_nv12"));
    CHECK_CU(s->hwctx->internal->cuda_dl->cuModuleGetFunction(&s->k_smooth_luma, s->mod, "smooth_luma_dev"));
    CHECK_CU(s->hwctx->internal->cuda_dl->cuModuleGetFunction(&s->k_p010_smooth_luma, s->mod, "p010_smooth_luma_dev"));
    CHECK_CU(s->hwctx->internal->cuda_dl->cuModuleGetFunction(&s->k_expand_flow, s->mod, "expand_flow_dev"));

    CHECK_OPTIX(optixInit());
    memset(&ctx_options, 0, sizeof(ctx_options));
    ctx_options.logCallbackFunction = optix_log_cb;
    ctx_options.logCallbackData     = ctx;
    ctx_options.logCallbackLevel    = 3;
    CHECK_OPTIX(optixDeviceContextCreate(s->hwctx->cuda_ctx, &ctx_options, &s->optix_ctx));

    switch (s->mode) {
    case OPTIX_MODE_HDR:      kind = OPTIX_DENOISER_MODEL_KIND_HDR;      break;
    case OPTIX_MODE_TEMPORAL: kind = OPTIX_DENOISER_MODEL_KIND_TEMPORAL; break;
    default:                  kind = OPTIX_DENOISER_MODEL_KIND_LDR;      break;
    }

    memset(&dn_options, 0, sizeof(dn_options));
    dn_options.denoiseAlpha = OPTIX_DENOISER_ALPHA_MODE_COPY;
    CHECK_OPTIX(optixDenoiserCreate(s->optix_ctx, kind, &dn_options, &s->denoiser));
    CHECK_OPTIX(optixDenoiserComputeMemoryResources(s->denoiser, s->w, s->h, &s->sizes));

    CHECK_CU(s->hwctx->internal->cuda_dl->cuMemAlloc(&s->d_state, s->sizes.stateSizeInBytes));
    CHECK_CU(s->hwctx->internal->cuda_dl->cuMemAlloc(&s->d_scratch, s->sizes.withoutOverlapScratchSizeInBytes));
    CHECK_CU(s->hwctx->internal->cuda_dl->cuMemAlloc(&s->d_in, rgb_bytes));
    CHECK_CU(s->hwctx->internal->cuda_dl->cuMemAlloc(&s->d_out[0], rgb_bytes));
    CHECK_CU(s->hwctx->internal->cuda_dl->cuMemAlloc(&s->d_out[1], rgb_bytes));
    CHECK_CU(s->hwctx->internal->cuda_dl->cuMemsetD8Async(s->d_out[0], 0, rgb_bytes, s->hwctx->stream));
    CHECK_CU(s->hwctx->internal->cuda_dl->cuMemsetD8Async(s->d_out[1], 0, rgb_bytes, s->hwctx->stream));

    CHECK_OPTIX(optixDenoiserSetup(s->denoiser, s->hwctx->stream, s->w, s->h,
                                   s->d_state, s->sizes.stateSizeInBytes,
                                   s->d_scratch, s->sizes.withoutOverlapScratchSizeInBytes));

    /* The HDR model judges its input against an average intensity it does not carry
     * itself.  Left null, it denoises as if the frame were already normalised and the
     * output comes back off-scale, which looks like a broken filter rather than a
     * missing parameter.  A zero size means this build of the driver wants none. */
    if (s->mode == OPTIX_MODE_HDR) {
        CHECK_CU(s->hwctx->internal->cuda_dl->cuMemAlloc(&s->d_intensity, sizeof(float)));
        if (s->sizes.computeIntensitySizeInBytes)
            CHECK_CU(s->hwctx->internal->cuda_dl->cuMemAlloc(&s->d_intensity_scratch,
                                                              s->sizes.computeIntensitySizeInBytes));
    }

    if (s->mode == OPTIX_MODE_TEMPORAL) {
        CHECK_CU(s->hwctx->internal->cuda_dl->cuMemAlloc(&s->d_flow, npix * 2 * sizeof(float)));
        CHECK_CU(s->hwctx->internal->cuda_dl->cuMemsetD8Async(s->d_flow, 0, npix * 2 * sizeof(float), s->hwctx->stream));
        if (s->flow_source == OPTIX_FLOW_NVOF && (ret = nvof_init(ctx)) < 0) {
            /* A flow field of zeros is still a legal temporal denoise: it just
             * assumes nothing moved, which is right for the still parts of the
             * frame and wrong for the rest.  Degrading to that beats failing the
             * session, and the warning says exactly what was lost. */
            av_log(ctx, AV_LOG_WARNING,
                   "temporal mode without hardware flow: reprojection assumes a static scene\n");
            s->nvof_ready = 0;
        }
    }

    return 0;
}

static int config_props(AVFilterLink *outlink)
{
    AVFilterContext *ctx = outlink->src;
    OptixContext *s = ctx->priv;
    AVFilterLink *inlink = ctx->inputs[0];
    FilterLink *inl = ff_filter_link(inlink), *outl = ff_filter_link(outlink);
    AVHWFramesContext *in_fc, *out_fc;
    CUcontext dummy;
    int ret;

    if (!inl->hw_frames_ctx) {
        av_log(ctx, AV_LOG_ERROR, "needs CUDA frames (-hwaccel cuda -hwaccel_output_format cuda)\n");
        return AVERROR(EINVAL);
    }
    in_fc = (AVHWFramesContext *)inl->hw_frames_ctx->data;
    if ((in_fc->sw_format != AV_PIX_FMT_NV12 && in_fc->sw_format != AV_PIX_FMT_P010LE) ||
        (inlink->w | inlink->h) & 1) {
        av_log(ctx, AV_LOG_ERROR, "needs even-sized NV12 or P010LE, got %s\n",
               av_get_pix_fmt_name(in_fc->sw_format));
        return AVERROR(ENOSYS);
    }
    s->is_p010 = in_fc->sw_format == AV_PIX_FMT_P010LE;
    s->hwctx = in_fc->device_ctx->hwctx;
    s->w = inlink->w;
    s->h = inlink->h;

    /* Denoise only: output is the same size and format as the input. */
    s->out_frames = av_hwframe_ctx_alloc(in_fc->device_ref);
    if (!s->out_frames) return AVERROR(ENOMEM);
    out_fc = (AVHWFramesContext *)s->out_frames->data;
    out_fc->format = AV_PIX_FMT_CUDA;
    out_fc->sw_format = AV_PIX_FMT_NV12;
    out_fc->width = s->w;
    out_fc->height = s->h;
    if ((ret = av_hwframe_ctx_init(s->out_frames)) < 0) return ret;
    outl->hw_frames_ctx = av_buffer_ref(s->out_frames);
    if (!outl->hw_frames_ctx) return AVERROR(ENOMEM);
    outlink->w = s->w;
    outlink->h = s->h;

    if ((ret = CHECK_CU_EXPR(s->hwctx->internal->cuda_dl->cuCtxPushCurrent(s->hwctx->cuda_ctx))) < 0)
        return ret;

    ret = config_props_pushed(ctx);

    /* Unconditional: the stack has to come back balanced whether the setup
     * above succeeded or failed.  uninit() releases whatever was allocated. */
    s->hwctx->internal->cuda_dl->cuCtxPopCurrent(&dummy);
    if (ret < 0)
        return ret;

    av_log(ctx, AV_LOG_VERBOSE,
           "OptiX denoiser %dx%d mode=%s flow=%s state=%zuMiB scratch=%zuMiB, GPU-resident (CUDA frames)\n",
           s->w, s->h,
           s->mode == OPTIX_MODE_TEMPORAL ? "temporal" : s->mode == OPTIX_MODE_HDR ? "hdr" : "ldr",
           s->mode != OPTIX_MODE_TEMPORAL ? "n/a" : s->nvof_ready ? "nvofa" : "zero",
           s->sizes.stateSizeInBytes >> 20,
           s->sizes.withoutOverlapScratchSizeInBytes >> 20);
    return 0;
}

/* Run NVOFA between the frame just smoothed into nvof_frame[slot] and the one
 * before it, then expand its grid straight into s->d_flow.  Everything here
 * stays on the device: no host buffer, no cuMemcpy2D in either direction.
 * Returns 0 when s->d_flow holds real motion. */
static int compute_flow_dev(AVFilterContext *ctx, AVFrame *in)
{
    OptixContext *s = ctx->priv;
    CudaFunctions *cu = s->hwctx->internal->cuda_dl;
    CUstream st_ = s->hwctx->stream;
    NV_OF_EXECUTE_INPUT_PARAMS in_p;
    NV_OF_EXECUTE_OUTPUT_PARAMS out_p;
    NV_OF_STATUS st;
    CUdeviceptr dst = s->nvof.nvOFGPUBufferGetCUdeviceptr(s->nvof_frame[s->nvof_slot]);
    CUdeviceptr y = (CUdeviceptr)in->data[0];
    unsigned yp = in->linesize[0], dp = s->nvof_in_pitch, w = s->w, h = s->h;
    void *smooth_args[] = { &y, &yp, &dst, &dp, &w, &h };
    CUfunction k_smooth = s->is_p010 ? s->k_p010_smooth_luma : s->k_smooth_luma;

    CHECK_CU(cu->cuLaunchKernel(k_smooth, (w + 15) / 16, (h + 15) / 16, 1,
                                16, 16, 1, 0, st_, smooth_args, NULL));

    if (!s->have_previous) {
        s->nvof_slot ^= 1;
        return AVERROR(EAGAIN);      /* nothing to compare against yet */
    }

    memset(&in_p, 0, sizeof(in_p));
    memset(&out_p, 0, sizeof(out_p));
    in_p.inputFrame          = s->nvof_frame[s->nvof_slot];
    in_p.referenceFrame      = s->nvof_frame[s->nvof_slot ^ 1];
    /* Successive frames of one video is exactly the case temporal hints are for. */
    in_p.disableTemporalHints = 0;
    out_p.outputBuffer       = s->nvof_out;

    if ((st = s->nvof.nvOFExecute(s->nvof_session, &in_p, &out_p)) != NV_OF_SUCCESS) {
        av_log(ctx, AV_LOG_WARNING, "NVOFA execute failed (%d), assuming no motion\n", st);
        s->nvof_slot ^= 1;
        return AVERROR_EXTERNAL;
    }

    {
        CUdeviceptr grid = s->nvof.nvOFGPUBufferGetCUdeviceptr(s->nvof_out);
        unsigned gp = s->nvof_out_pitch, gw = s->grid_w, gh = s->grid_h;
        void *flow_args[] = { &grid, &gp, &gw, &gh, &s->d_flow, &w, &h };
        CHECK_CU(cu->cuLaunchKernel(s->k_expand_flow, (w + 15) / 16, (h + 15) / 16, 1,
                                    16, 16, 1, 0, st_, flow_args, NULL));
    }

    s->nvof_slot ^= 1;
    return 0;
}

static int filter_frame(AVFilterLink *inlink, AVFrame *in)
{
    AVFilterContext *ctx = inlink->dst;
    AVFilterLink *outlink = ctx->outputs[0];
    OptixContext *s = ctx->priv;
    CudaFunctions *cu = s->hwctx->internal->cuda_dl;
    CUstream st_ = s->hwctx->stream;
    OptixDenoiserGuideLayer guide;
    OptixDenoiserLayer layer;
    OptixDenoiserParams params;
    OptixImage2D image;
    AVFrame *out;
    CUcontext dummy;
    int temporal = s->mode == OPTIX_MODE_TEMPORAL;
    int have_flow = 0;
    int ret;

    out = av_frame_alloc();
    if (!out) { ret = AVERROR(ENOMEM); goto fail; }
    if ((ret = av_hwframe_get_buffer(s->out_frames, out, 0)) < 0) goto fail;
    if ((ret = av_frame_copy_props(out, in)) < 0) goto fail;
    out->width = s->w;
    out->height = s->h;

    if ((ret = CHECK_CU_EXPR(cu->cuCtxPushCurrent(s->hwctx->cuda_ctx))) < 0)
        goto fail;

    {
        CUdeviceptr y = (CUdeviceptr)in->data[0], uv = (CUdeviceptr)in->data[1];
        unsigned yp = in->linesize[0], uvp = in->linesize[1];
        unsigned dp = s->w * 3 * sizeof(float), w = s->w, h = s->h;
        void *args[] = { &y, &yp, &uv, &uvp, &s->d_in, &dp, &w, &h };
        CUfunction k_in = s->is_p010 ? s->k_p010_to_rgbf32 : s->k_nv12_to_rgbf32;
        if ((ret = CHECK_CU_EXPR(cu->cuLaunchKernel(k_in, (w + 15) / 16, (h + 15) / 16, 1,
                                                     16, 16, 1, 0, st_, args, NULL))) < 0)
            goto fail_ctx;
    }

    if (temporal && s->nvof_ready)
        have_flow = compute_flow_dev(ctx, in) == 0;

    image.data               = s->d_in;
    image.width               = s->w;
    image.height              = s->h;
    image.rowStrideInBytes    = s->w * 3 * sizeof(float);
    image.pixelStrideInBytes  = 3 * sizeof(float);
    image.format              = OPTIX_PIXEL_FORMAT_FLOAT3;

    memset(&guide, 0, sizeof(guide));
    memset(&layer, 0, sizeof(layer));
    memset(&params, 0, sizeof(params));
    params.blendFactor = s->blend;

    layer.input  = image;
    layer.output = image;
    layer.output.data = s->d_out[s->out_slot];

    if (temporal) {
        layer.previousOutput = image;
        layer.previousOutput.data = s->d_out[s->out_slot ^ 1];
        guide.flow = image;
        guide.flow.data               = s->d_flow;
        guide.flow.format             = OPTIX_PIXEL_FORMAT_FLOAT2;
        guide.flow.pixelStrideInBytes = 2 * sizeof(float);
        guide.flow.rowStrideInBytes   = s->w * 2 * sizeof(float);
        /* Only claim the previous layers once one has actually been produced;
         * claiming it on frame one makes the model reproject uninitialised memory. */
        params.temporalModeUsePreviousLayers = s->have_previous;
        if (!have_flow && s->nvof_ready && s->have_previous) {
            /* Flow failed for this frame only.  The field still holds the last
             * good one, which is a better guess than garbage and far better than
             * dropping out of temporal mode mid-stream. */
            av_log(ctx, AV_LOG_DEBUG, "reusing the previous flow field\n");
        }
    }

    /* Must precede the invoke: it writes the very field the invoke reads, on the same
     * stream, so the ordering is the stream's rather than ours.  The header requires
     * hdrIntensity stay null for every other model. */
    if (s->mode == OPTIX_MODE_HDR && s->d_intensity) {
        if (optixDenoiserComputeIntensity(s->denoiser, st_, &image, s->d_intensity,
                                          s->d_intensity_scratch,
                                          s->sizes.computeIntensitySizeInBytes) != OPTIX_SUCCESS) {
            av_log(ctx, AV_LOG_ERROR, "optixDenoiserComputeIntensity failed\n");
            ret = AVERROR_EXTERNAL;
            goto fail_ctx;
        }
        params.hdrIntensity = s->d_intensity;
    }

    if (optixDenoiserInvoke(s->denoiser, st_, &params,
                            s->d_state, s->sizes.stateSizeInBytes,
                            &guide, &layer, 1, 0, 0,
                            s->d_scratch, s->sizes.withoutOverlapScratchSizeInBytes) != OPTIX_SUCCESS) {
        av_log(ctx, AV_LOG_ERROR, "optixDenoiserInvoke failed\n");
        ret = AVERROR_EXTERNAL;
        goto fail_ctx;
    }

    {
        CUdeviceptr y = (CUdeviceptr)out->data[0], uv = (CUdeviceptr)out->data[1];
        unsigned yp = out->linesize[0], uvp = out->linesize[1];
        unsigned dp = s->w * 3 * sizeof(float), w = s->w, h = s->h;
        void *args[] = { &s->d_out[s->out_slot], &dp, &y, &yp, &uv, &uvp, &w, &h };
        if ((ret = CHECK_CU_EXPR(cu->cuLaunchKernel(s->k_rgbf32_to_nv12, (w / 2 + 15) / 16, (h / 2 + 15) / 16, 1,
                                                     16, 16, 1, 0, st_, args, NULL))) < 0)
            goto fail_ctx;
    }

    cu->cuCtxPopCurrent(&dummy);

    if (temporal)
        s->out_slot ^= 1;
    s->have_previous = 1;

    av_frame_free(&in);
    return ff_filter_frame(outlink, out);

fail_ctx:
    cu->cuCtxPopCurrent(&dummy);
fail:
    av_frame_free(&out);
    av_frame_free(&in);
    return ret;
}

static av_cold void uninit(AVFilterContext *ctx)
{
    OptixContext *s = ctx->priv;
    CudaFunctions *cu = s->hwctx ? s->hwctx->internal->cuda_dl : NULL;
    CUcontext dummy;
    int pushed = 0;

    if (cu && s->hwctx->cuda_ctx)
        pushed = cu->cuCtxPushCurrent(s->hwctx->cuda_ctx) == CUDA_SUCCESS;

    if (s->nvof_session) {
        for (int i = 0; i < 2; i++)
            if (s->nvof_frame[i])
                s->nvof.nvOFDestroyGPUBufferCuda(s->nvof_frame[i]);
        if (s->nvof_out)
            s->nvof.nvOFDestroyGPUBufferCuda(s->nvof_out);
        s->nvof.nvOFDestroy(s->nvof_session);
    }
    if (s->nvof_lib)
        dlclose(s->nvof_lib);

    if (s->denoiser)
        optixDenoiserDestroy(s->denoiser);
    if (s->optix_ctx)
        optixDeviceContextDestroy(s->optix_ctx);

    if (cu) {
        if (s->d_state)   cu->cuMemFree(s->d_state);
        if (s->d_scratch) cu->cuMemFree(s->d_scratch);
        if (s->d_in)      cu->cuMemFree(s->d_in);
        if (s->d_out[0])  cu->cuMemFree(s->d_out[0]);
        if (s->d_out[1])  cu->cuMemFree(s->d_out[1]);
        if (s->d_flow)    cu->cuMemFree(s->d_flow);
        if (s->d_intensity) cu->cuMemFree(s->d_intensity);
        if (s->d_intensity_scratch) cu->cuMemFree(s->d_intensity_scratch);
        if (s->mod)       cu->cuModuleUnload(s->mod);
        if (pushed)
            cu->cuCtxPopCurrent(&dummy);
    }

    av_buffer_unref(&s->out_frames);
}

#define OFFSET(x) offsetof(OptixContext, x)
#define VF AV_OPT_FLAG_FILTERING_PARAM|AV_OPT_FLAG_VIDEO_PARAM

static const AVOption optix_options[] = {
    { "mode", "denoiser model", OFFSET(mode), AV_OPT_TYPE_INT,
      { .i64 = OPTIX_MODE_LDR }, OPTIX_MODE_LDR, OPTIX_MODE_TEMPORAL, VF, .unit = "mode" },
        { "ldr",      "low dynamic range, spatial",  0, AV_OPT_TYPE_CONST, { .i64 = OPTIX_MODE_LDR      }, 0, 0, VF, .unit = "mode" },
        { "hdr",      "high dynamic range, spatial", 0, AV_OPT_TYPE_CONST, { .i64 = OPTIX_MODE_HDR      }, 0, 0, VF, .unit = "mode" },
        { "temporal", "temporally stable, uses motion vectors", 0, AV_OPT_TYPE_CONST, { .i64 = OPTIX_MODE_TEMPORAL }, 0, 0, VF, .unit = "mode" },
    { "flow", "source of the motion field in temporal mode", OFFSET(flow_source), AV_OPT_TYPE_INT,
      { .i64 = OPTIX_FLOW_NVOF }, OPTIX_FLOW_NVOF, OPTIX_FLOW_NONE, VF, .unit = "flow" },
        { "nvof", "NVIDIA optical flow engine", 0, AV_OPT_TYPE_CONST, { .i64 = OPTIX_FLOW_NVOF }, 0, 0, VF, .unit = "flow" },
        { "none", "assume a static scene",      0, AV_OPT_TYPE_CONST, { .i64 = OPTIX_FLOW_NONE }, 0, 0, VF, .unit = "flow" },
    { "blend", "0 is fully denoised, 1 is the untouched input", OFFSET(blend), AV_OPT_TYPE_FLOAT,
      { .dbl = 0 }, 0, 1, VF },
    { NULL }
};

AVFILTER_DEFINE_CLASS(optix);

static const AVFilterPad optix_inputs[] = {
    {
        .name         = "default",
        .type         = AVMEDIA_TYPE_VIDEO,
        .filter_frame = filter_frame,
    },
};

static const AVFilterPad optix_outputs[] = {
    {
        .name         = "default",
        .type         = AVMEDIA_TYPE_VIDEO,
        .config_props = config_props,
    },
};

const FFFilter ff_vf_optix = {
    .p.name        = "optix",
    .p.description = NULL_IF_CONFIG_SMALL("Denoise frames with the NVIDIA OptiX AI denoiser, GPU-resident."),
    .p.priv_class  = &optix_class,
    .p.flags       = AVFILTER_FLAG_SUPPORT_TIMELINE_GENERIC,
    .priv_size     = sizeof(OptixContext),
    .uninit        = uninit,
    FILTER_INPUTS(optix_inputs),
    FILTER_OUTPUTS(optix_outputs),
    FILTER_SINGLE_PIXFMT(AV_PIX_FMT_CUDA),
    .flags_internal = FF_FILTER_FLAG_HWFRAME_AWARE,
};
