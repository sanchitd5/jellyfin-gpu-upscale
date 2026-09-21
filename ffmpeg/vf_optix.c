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
 *  - The CUDA driver API is loaded the way FFmpeg's own CUDA code loads it,
 *    through nv-codec-headers' dynlink loader against libcuda.so.1.
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
 * quickly.  NVOFA is free (it is idle silicon otherwise), needs no kernel of
 * our own - which matters, because this build has no nvcc - and produces a
 * 4x4-granularity field that is upsampled here on the CPU.
 *
 * Frames arrive as planar float RGB (gbrpf32le), exactly as for vf_oidn, are
 * packed into the interleaved float3 layout OptiX wants, uploaded, denoised,
 * downloaded and unpacked.  Pack, unpack, luma extraction and flow expansion
 * are slice threaded.
 */

#include <float.h>
#include <stdint.h>

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

#include <ffnvcodec/dynlink_loader.h>
#include <dlfcn.h>

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
#define OPTIX_FLOW_Q    32.0f   /* 1 << 5, the S10.5 fractional scale */

typedef struct OptixContext {
    const AVClass *class;

    int   mode;
    int   flow_source;
    float blend;
    int   device_index;

    int w, h;

    CudaFunctions *cu;
    CUdevice   cu_device;
    CUcontext  cu_ctx;
    CUstream   stream;

    OptixDeviceContext optix_ctx;
    OptixDenoiser      denoiser;
    OptixDenoiserSizes sizes;

    CUdeviceptr d_state;
    CUdeviceptr d_scratch;
    CUdeviceptr d_in;
    CUdeviceptr d_out[2];    /* ping-pong: OptiX forbids output == previousOutput */
    CUdeviceptr d_flow;
    int         out_slot;
    int         have_previous;

    float *host_rgb;         /* interleaved RGB, both directions */
    float *host_flow;        /* per-pixel float2, temporal only */
    uint8_t *host_luma;      /* temporal only */
    uint8_t *host_luma_s;    /* the same, smoothed, which is what NVOFA is actually given */
    int16_t *host_grid;      /* raw NVOFA grid, temporal only */
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

typedef struct ThreadData {
    AVFrame *in, *out;
} ThreadData;

static const enum AVPixelFormat pixel_fmts[] = {
    AV_PIX_FMT_GBRPF32LE,
    AV_PIX_FMT_NONE
};

#define CHECK_CU(ctx, expr)                                                       \
    do {                                                                          \
        CUresult _cu_ret = (expr);                                                \
        if (_cu_ret != CUDA_SUCCESS) {                                            \
            const char *_cu_name = NULL;                                          \
            OptixContext *_s = (ctx)->priv;                                       \
            if (_s->cu && _s->cu->cuGetErrorName)                                 \
                _s->cu->cuGetErrorName(_cu_ret, &_cu_name);                       \
            av_log(ctx, AV_LOG_ERROR, "CUDA %s failed: %s\n", #expr,              \
                   _cu_name ? _cu_name : "unknown");                              \
            return AVERROR_EXTERNAL;                                              \
        }                                                                         \
    } while (0)

#define CHECK_OPTIX(ctx, expr)                                                    \
    do {                                                                          \
        OptixResult _ox_ret = (expr);                                             \
        if (_ox_ret != OPTIX_SUCCESS) {                                           \
            av_log(ctx, AV_LOG_ERROR, "OptiX %s failed: %s\n", #expr,             \
                   optixGetErrorString(_ox_ret));                                 \
            return AVERROR_EXTERNAL;                                              \
        }                                                                         \
    } while (0)

static void optix_log_cb(unsigned int level, const char *tag, const char *message, void *cbdata)
{
    av_log((AVFilterContext *)cbdata, level <= 2 ? AV_LOG_ERROR : AV_LOG_VERBOSE,
           "OptiX [%s] %s\n", tag ? tag : "?", message ? message : "");
}

/* gbrpf32le: plane 0 = G, plane 1 = B, plane 2 = R */
static int pack_slice(AVFilterContext *ctx, void *arg, int jobnr, int nb_jobs)
{
    OptixContext *s = ctx->priv;
    ThreadData *td = arg;
    const int h0 = (s->h * jobnr) / nb_jobs;
    const int h1 = (s->h * (jobnr + 1)) / nb_jobs;
    const int temporal = s->mode == OPTIX_MODE_TEMPORAL && s->host_luma;

    for (int y = h0; y < h1; y++) {
        const float *g = (const float *)(td->in->data[0] + y * td->in->linesize[0]);
        const float *b = (const float *)(td->in->data[1] + y * td->in->linesize[1]);
        const float *r = (const float *)(td->in->data[2] + y * td->in->linesize[2]);
        float *dst = s->host_rgb + (size_t)y * s->w * 3;
        uint8_t *luma = temporal ? s->host_luma + (size_t)y * s->w : NULL;

        for (int x = 0; x < s->w; x++) {
            dst[3 * x + 0] = r[x];
            dst[3 * x + 1] = g[x];
            dst[3 * x + 2] = b[x];
            if (luma) {
                /* NVOFA wants 8-bit luma; Rec.601 weights are what it was trained
                 * against and the exact primaries do not matter to a flow engine. */
                float yv = 0.299f * r[x] + 0.587f * g[x] + 0.114f * b[x];
                luma[x] = yv <= 0.f ? 0 : yv >= 1.f ? 255 : (uint8_t)(yv * 255.f + 0.5f);
            }
        }
    }
    return 0;
}

/* A 3x3 box over the luma before it reaches NVOFA.
 *
 * Not cosmetic.  NVOFA block-matches, and per-pixel noise is exactly the thing that
 * makes block matching return a wrong-but-confident vector.  Measured: on a grainy
 * source the raw-luma field left the temporal model worse than assuming no motion at
 * all, which is what a bad field looks like from the outside.  The smoothing costs one
 * cheap pass over an 8-bit plane and does not touch the picture - only the flow input. */
static int smooth_slice(AVFilterContext *ctx, void *arg, int jobnr, int nb_jobs)
{
    OptixContext *s = ctx->priv;
    const int h0 = (s->h * jobnr) / nb_jobs;
    const int h1 = (s->h * (jobnr + 1)) / nb_jobs;

    for (int y = h0; y < h1; y++) {
        const uint8_t *r0 = s->host_luma + (size_t)FFMAX(y - 1, 0) * s->w;
        const uint8_t *r1 = s->host_luma + (size_t)y * s->w;
        const uint8_t *r2 = s->host_luma + (size_t)FFMIN(y + 1, s->h - 1) * s->w;
        uint8_t *dst = s->host_luma_s + (size_t)y * s->w;

        for (int x = 0; x < s->w; x++) {
            const int xm = FFMAX(x - 1, 0), xp = FFMIN(x + 1, s->w - 1);
            dst[x] = (r0[xm] + r0[x] + r0[xp] +
                      r1[xm] + r1[x] + r1[xp] +
                      r2[xm] + r2[x] + r2[xp] + 4) / 9;
        }
    }
    return 0;
}

static int unpack_slice(AVFilterContext *ctx, void *arg, int jobnr, int nb_jobs)
{
    OptixContext *s = ctx->priv;
    ThreadData *td = arg;
    const int h0 = (s->h * jobnr) / nb_jobs;
    const int h1 = (s->h * (jobnr + 1)) / nb_jobs;

    for (int y = h0; y < h1; y++) {
        float *g = (float *)(td->out->data[0] + y * td->out->linesize[0]);
        float *b = (float *)(td->out->data[1] + y * td->out->linesize[1]);
        float *r = (float *)(td->out->data[2] + y * td->out->linesize[2]);
        const float *src = s->host_rgb + (size_t)y * s->w * 3;

        for (int x = 0; x < s->w; x++) {
            r[x] = src[3 * x + 0];
            g[x] = src[3 * x + 1];
            b[x] = src[3 * x + 2];
        }
    }
    return 0;
}

/* Expand the NVOFA grid into the dense float2 field OptiX wants.
 *
 * Two conversions happen here.  Scale: S10.5 fixed point to pixels.  Sign: NVOFA
 * is run with inputFrame = current and referenceFrame = previous, so its vector
 * at (x,y) points back to where that pixel was; OptiX defines flow as the
 * movement from the previous frame to the current one, i.e. the negation.
 * Getting this backwards does not fail, it doubles the apparent motion - which
 * is exactly the kind of bug a flicker measurement catches and an eyeball does
 * not, so it is measured rather than assumed. */
static int flow_slice(AVFilterContext *ctx, void *arg, int jobnr, int nb_jobs)
{
    OptixContext *s = ctx->priv;
    const int h0 = (s->h * jobnr) / nb_jobs;
    const int h1 = (s->h * (jobnr + 1)) / nb_jobs;

    for (int y = h0; y < h1; y++) {
        const int gy = FFMIN(y / OPTIX_FLOW_GRID, s->grid_h - 1);
        const int16_t *row = s->host_grid + (size_t)gy * s->grid_w * 2;
        float *dst = s->host_flow + (size_t)y * s->w * 2;

        for (int x = 0; x < s->w; x++) {
            const int gx = FFMIN(x / OPTIX_FLOW_GRID, s->grid_w - 1);
            dst[2 * x + 0] = -row[2 * gx + 0] / OPTIX_FLOW_Q;
            dst[2 * x + 1] = -row[2 * gx + 1] / OPTIX_FLOW_Q;
        }
    }
    return 0;
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
    if ((st = s->nvof.nvCreateOpticalFlowCuda(s->cu_ctx, &s->nvof_session)) != NV_OF_SUCCESS) {
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

    s->nvof.nvOFGPUBufferGetStrideInfo(s->nvof_frame[0], &stride);
    s->nvof_in_pitch = stride.strideInfo[0].strideXInBytes;
    s->nvof.nvOFGPUBufferGetStrideInfo(s->nvof_out, &stride);
    s->nvof_out_pitch = stride.strideInfo[0].strideXInBytes;

    s->host_luma   = av_malloc_array((size_t)s->w, s->h);
    s->host_luma_s = av_malloc_array((size_t)s->w, s->h);
    s->host_grid = av_malloc_array((size_t)s->grid_w * s->grid_h, 2 * sizeof(int16_t));
    s->host_flow = av_malloc_array((size_t)s->w * s->h, 2 * sizeof(float));
    if (!s->host_luma || !s->host_luma_s || !s->host_grid || !s->host_flow)
        return AVERROR(ENOMEM);

    s->nvof_ready = 1;
    av_log(ctx, AV_LOG_VERBOSE, "NVOFA flow %dx%d on a %dx%d grid\n",
           s->w, s->h, s->grid_w, s->grid_h);
    return 0;
}

/* Everything below here needs the CUDA context current.  It is a separate
 * function so that the push and the pop are a matched pair: CHECK_CU and
 * CHECK_OPTIX return straight out of whatever function they sit in, so any
 * failure between the two would otherwise leave this thread's context stack
 * unbalanced - which then breaks uninit()'s own push/pop and anything else
 * using CUDA on the thread. */
static int config_input_pushed(AVFilterLink *inlink)
{
    AVFilterContext *ctx = inlink->dst;
    OptixContext *s = ctx->priv;
    OptixDeviceContextOptions ctx_options;
    OptixDenoiserOptions dn_options;
    OptixDenoiserModelKind kind;
    const size_t npix = (size_t)inlink->w * inlink->h;
    const size_t rgb_bytes = npix * 3 * sizeof(float);
    int ret;

    CHECK_CU(ctx, s->cu->cuStreamCreate(&s->stream, 0));

    CHECK_OPTIX(ctx, optixInit());
    memset(&ctx_options, 0, sizeof(ctx_options));
    ctx_options.logCallbackFunction = optix_log_cb;
    ctx_options.logCallbackData     = ctx;
    ctx_options.logCallbackLevel    = 3;
    CHECK_OPTIX(ctx, optixDeviceContextCreate(s->cu_ctx, &ctx_options, &s->optix_ctx));

    switch (s->mode) {
    case OPTIX_MODE_HDR:      kind = OPTIX_DENOISER_MODEL_KIND_HDR;      break;
    case OPTIX_MODE_TEMPORAL: kind = OPTIX_DENOISER_MODEL_KIND_TEMPORAL; break;
    default:                  kind = OPTIX_DENOISER_MODEL_KIND_LDR;      break;
    }

    memset(&dn_options, 0, sizeof(dn_options));
    dn_options.denoiseAlpha = OPTIX_DENOISER_ALPHA_MODE_COPY;
    CHECK_OPTIX(ctx, optixDenoiserCreate(s->optix_ctx, kind, &dn_options, &s->denoiser));
    CHECK_OPTIX(ctx, optixDenoiserComputeMemoryResources(s->denoiser, s->w, s->h, &s->sizes));

    CHECK_CU(ctx, s->cu->cuMemAlloc(&s->d_state, s->sizes.stateSizeInBytes));
    CHECK_CU(ctx, s->cu->cuMemAlloc(&s->d_scratch, s->sizes.withoutOverlapScratchSizeInBytes));
    CHECK_CU(ctx, s->cu->cuMemAlloc(&s->d_in, rgb_bytes));
    CHECK_CU(ctx, s->cu->cuMemAlloc(&s->d_out[0], rgb_bytes));
    CHECK_CU(ctx, s->cu->cuMemAlloc(&s->d_out[1], rgb_bytes));
    CHECK_CU(ctx, s->cu->cuMemsetD8Async(s->d_out[0], 0, rgb_bytes, s->stream));
    CHECK_CU(ctx, s->cu->cuMemsetD8Async(s->d_out[1], 0, rgb_bytes, s->stream));

    CHECK_OPTIX(ctx, optixDenoiserSetup(s->denoiser, s->stream, s->w, s->h,
                                        s->d_state, s->sizes.stateSizeInBytes,
                                        s->d_scratch, s->sizes.withoutOverlapScratchSizeInBytes));

    s->host_rgb = av_malloc_array(npix * 3, sizeof(float));
    if (!s->host_rgb)
        return AVERROR(ENOMEM);

    if (s->mode == OPTIX_MODE_TEMPORAL) {
        CHECK_CU(ctx, s->cu->cuMemAlloc(&s->d_flow, npix * 2 * sizeof(float)));
        CHECK_CU(ctx, s->cu->cuMemsetD8Async(s->d_flow, 0, npix * 2 * sizeof(float), s->stream));
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

static int config_input(AVFilterLink *inlink)
{
    AVFilterContext *ctx = inlink->dst;
    OptixContext *s = ctx->priv;
    CUcontext popped;
    int ret;

    s->w = inlink->w;
    s->h = inlink->h;

    if (cuda_load_functions(&s->cu, ctx) < 0) {
        av_log(ctx, AV_LOG_ERROR, "could not load the CUDA driver library\n");
        return AVERROR_EXTERNAL;
    }
    CHECK_CU(ctx, s->cu->cuInit(0));
    CHECK_CU(ctx, s->cu->cuDeviceGet(&s->cu_device, s->device_index));
    /* The primary context is shared with anything else on this device in this
     * process, which is what we want: nothing else here uses CUDA, and a private
     * context would only add another set of allocations. */
    CHECK_CU(ctx, s->cu->cuDevicePrimaryCtxRetain(&s->cu_ctx, s->cu_device));
    CHECK_CU(ctx, s->cu->cuCtxPushCurrent(s->cu_ctx));

    ret = config_input_pushed(inlink);

    /* Unconditional: the stack has to come back balanced whether the setup
     * above succeeded or failed.  uninit() releases whatever was allocated. */
    s->cu->cuCtxPopCurrent(&popped);
    if (ret < 0)
        return ret;

    av_log(ctx, AV_LOG_VERBOSE,
           "OptiX denoiser %dx%d mode=%s flow=%s state=%zuMiB scratch=%zuMiB\n",
           s->w, s->h,
           s->mode == OPTIX_MODE_TEMPORAL ? "temporal" : s->mode == OPTIX_MODE_HDR ? "hdr" : "ldr",
           s->mode != OPTIX_MODE_TEMPORAL ? "n/a" : s->nvof_ready ? "nvofa" : "zero",
           s->sizes.stateSizeInBytes >> 20,
           s->sizes.withoutOverlapScratchSizeInBytes >> 20);
    return 0;
}

static int upload_luma(AVFilterContext *ctx, NvOFGPUBufferHandle dst)
{
    OptixContext *s = ctx->priv;
    CUDA_MEMCPY2D m;

    memset(&m, 0, sizeof(m));
    m.srcMemoryType = CU_MEMORYTYPE_HOST;
    m.srcHost       = s->host_luma_s;
    m.srcPitch      = s->w;
    m.dstMemoryType = CU_MEMORYTYPE_DEVICE;
    m.dstDevice     = s->nvof.nvOFGPUBufferGetCUdeviceptr(dst);
    m.dstPitch      = s->nvof_in_pitch;
    m.WidthInBytes  = s->w;
    m.Height        = s->h;
    CHECK_CU(ctx, s->cu->cuMemcpy2D(&m));
    return 0;
}

static int download_flow_grid(AVFilterContext *ctx)
{
    OptixContext *s = ctx->priv;
    CUDA_MEMCPY2D m;

    memset(&m, 0, sizeof(m));
    m.srcMemoryType = CU_MEMORYTYPE_DEVICE;
    m.srcDevice     = s->nvof.nvOFGPUBufferGetCUdeviceptr(s->nvof_out);
    m.srcPitch      = s->nvof_out_pitch;
    m.dstMemoryType = CU_MEMORYTYPE_HOST;
    m.dstHost       = s->host_grid;
    m.dstPitch      = s->grid_w * 2 * sizeof(int16_t);
    m.WidthInBytes  = s->grid_w * 2 * sizeof(int16_t);
    m.Height        = s->grid_h;
    CHECK_CU(ctx, s->cu->cuMemcpy2D(&m));
    return 0;
}

/* Run NVOFA between the frame just packed into host_luma and the one before it,
 * then hand OptiX a dense field.  Returns 0 when s->d_flow holds real motion. */
static int compute_flow(AVFilterContext *ctx, int nb_jobs)
{
    OptixContext *s = ctx->priv;
    NV_OF_EXECUTE_INPUT_PARAMS in;
    NV_OF_EXECUTE_OUTPUT_PARAMS out;
    NV_OF_STATUS st;
    int ret;

    ff_filter_execute(ctx, smooth_slice, NULL, NULL, nb_jobs);

    if ((ret = upload_luma(ctx, s->nvof_frame[s->nvof_slot])) < 0)
        return ret;

    if (!s->have_previous) {
        s->nvof_slot ^= 1;
        return AVERROR(EAGAIN);      /* nothing to compare against yet */
    }

    memset(&in, 0, sizeof(in));
    memset(&out, 0, sizeof(out));
    in.inputFrame          = s->nvof_frame[s->nvof_slot];
    in.referenceFrame      = s->nvof_frame[s->nvof_slot ^ 1];
    /* Successive frames of one video is exactly the case temporal hints are for. */
    in.disableTemporalHints = 0;
    out.outputBuffer       = s->nvof_out;

    if ((st = s->nvof.nvOFExecute(s->nvof_session, &in, &out)) != NV_OF_SUCCESS) {
        av_log(ctx, AV_LOG_WARNING, "NVOFA execute failed (%d), assuming no motion\n", st);
        s->nvof_slot ^= 1;
        return AVERROR_EXTERNAL;
    }
    if ((ret = download_flow_grid(ctx)) < 0)
        return ret;

    ff_filter_execute(ctx, flow_slice, NULL, NULL, nb_jobs);
    CHECK_CU(ctx, s->cu->cuMemcpyHtoD(s->d_flow, s->host_flow,
                                      (size_t)s->w * s->h * 2 * sizeof(float)));
    s->nvof_slot ^= 1;
    return 0;
}

static int filter_frame(AVFilterLink *inlink, AVFrame *in)
{
    AVFilterContext *ctx = inlink->dst;
    AVFilterLink *outlink = ctx->outputs[0];
    OptixContext *s = ctx->priv;
    const int nb_jobs = FFMIN(s->h, ff_filter_get_nb_threads(ctx));
    const size_t rgb_bytes = (size_t)s->w * s->h * 3 * sizeof(float);
    const unsigned row_stride = s->w * 3 * sizeof(float);
    OptixDenoiserGuideLayer guide;
    OptixDenoiserLayer layer;
    OptixDenoiserParams params;
    OptixImage2D image;
    ThreadData td;
    AVFrame *out;
    int temporal = s->mode == OPTIX_MODE_TEMPORAL;
    int have_flow = 0;
    int ret;

    if (av_frame_is_writable(in)) {
        out = in;
    } else {
        out = ff_get_video_buffer(outlink, outlink->w, outlink->h);
        if (!out) {
            av_frame_free(&in);
            return AVERROR(ENOMEM);
        }
        av_frame_copy_props(out, in);
    }

    td.in  = in;
    td.out = out;

    if ((ret = ff_filter_execute(ctx, pack_slice, &td, NULL, nb_jobs)) < 0)
        goto fail;

    if ((ret = s->cu->cuCtxPushCurrent(s->cu_ctx)) != CUDA_SUCCESS) {
        av_log(ctx, AV_LOG_ERROR, "cuCtxPushCurrent failed (%d)\n", ret);
        ret = AVERROR_EXTERNAL;
        goto fail;
    }

    if (temporal && s->nvof_ready)
        have_flow = compute_flow(ctx, nb_jobs) == 0;

    if (s->cu->cuMemcpyHtoD(s->d_in, s->host_rgb, rgb_bytes) != CUDA_SUCCESS) {
        ret = AVERROR_EXTERNAL;
        goto fail_ctx;
    }

    image.data               = s->d_in;
    image.width              = s->w;
    image.height             = s->h;
    image.rowStrideInBytes   = row_stride;
    image.pixelStrideInBytes = 3 * sizeof(float);
    image.format             = OPTIX_PIXEL_FORMAT_FLOAT3;

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

    if (optixDenoiserInvoke(s->denoiser, s->stream, &params,
                            s->d_state, s->sizes.stateSizeInBytes,
                            &guide, &layer, 1, 0, 0,
                            s->d_scratch, s->sizes.withoutOverlapScratchSizeInBytes) != OPTIX_SUCCESS) {
        av_log(ctx, AV_LOG_ERROR, "optixDenoiserInvoke failed\n");
        ret = AVERROR_EXTERNAL;
        goto fail_ctx;
    }

    if (s->cu->cuStreamSynchronize(s->stream) != CUDA_SUCCESS ||
        s->cu->cuMemcpyDtoH(s->host_rgb, s->d_out[s->out_slot], rgb_bytes) != CUDA_SUCCESS) {
        ret = AVERROR_EXTERNAL;
        goto fail_ctx;
    }

    s->cu->cuCtxPopCurrent(&s->cu_ctx);

    if (temporal)
        s->out_slot ^= 1;
    s->have_previous = 1;

    if ((ret = ff_filter_execute(ctx, unpack_slice, &td, NULL, nb_jobs)) < 0)
        goto fail;

    if (out != in)
        av_frame_free(&in);
    return ff_filter_frame(outlink, out);

fail_ctx:
    s->cu->cuCtxPopCurrent(&s->cu_ctx);
fail:
    if (out != in)
        av_frame_free(&out);
    av_frame_free(&in);
    return ret;
}

static av_cold void uninit(AVFilterContext *ctx)
{
    OptixContext *s = ctx->priv;

    if (s->cu && s->cu_ctx)
        s->cu->cuCtxPushCurrent(s->cu_ctx);

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

    if (s->cu) {
        if (s->d_state)   s->cu->cuMemFree(s->d_state);
        if (s->d_scratch) s->cu->cuMemFree(s->d_scratch);
        if (s->d_in)      s->cu->cuMemFree(s->d_in);
        if (s->d_out[0])  s->cu->cuMemFree(s->d_out[0]);
        if (s->d_out[1])  s->cu->cuMemFree(s->d_out[1]);
        if (s->d_flow)    s->cu->cuMemFree(s->d_flow);
        if (s->stream)    s->cu->cuStreamDestroy(s->stream);
        if (s->cu_ctx) {
            s->cu->cuCtxPopCurrent(&s->cu_ctx);
            s->cu->cuDevicePrimaryCtxRelease(s->cu_device);
        }
        cuda_free_functions(&s->cu);
    }

    av_freep(&s->host_rgb);
    av_freep(&s->host_flow);
    av_freep(&s->host_luma);
    av_freep(&s->host_luma_s);
    av_freep(&s->host_grid);
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
    { "device", "CUDA device index", OFFSET(device_index), AV_OPT_TYPE_INT,
      { .i64 = 0 }, 0, 64, VF },
    { NULL }
};

AVFILTER_DEFINE_CLASS(optix);

static const AVFilterPad optix_inputs[] = {
    {
        .name         = "default",
        .type         = AVMEDIA_TYPE_VIDEO,
        .filter_frame = filter_frame,
        .config_props = config_input,
    },
};

const FFFilter ff_vf_optix = {
    .p.name        = "optix",
    .p.description = NULL_IF_CONFIG_SMALL("Denoise frames with the NVIDIA OptiX AI denoiser."),
    .p.priv_class  = &optix_class,
    .p.flags       = AVFILTER_FLAG_SUPPORT_TIMELINE_GENERIC | AVFILTER_FLAG_SLICE_THREADS,
    .priv_size     = sizeof(OptixContext),
    .uninit        = uninit,
    FILTER_INPUTS(optix_inputs),
    FILTER_OUTPUTS(ff_video_default_filterpad),
    FILTER_PIXFMTS_ARRAY(pixel_fmts),
};
