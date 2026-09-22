/*
 * Synthesised FSR2/DLSS inputs for recorded video.
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
 * Motion vectors, depth, jitter and a reactive mask for game temporal
 * upscalers (FSR2, DLSS), synthesised from decoded video.
 *
 * READ THIS BEFORE BELIEVING ANY OUTPUT OF THE FILTERS THAT USE IT.
 *
 * FSR2 and DLSS are fed, by a renderer, four things a camera never records:
 *
 *   1. screen-space motion vectors, exact, with the camera jitter removed,
 *   2. a depth buffer,
 *   3. the exact sub-pixel jitter the projection matrix was offset by,
 *   4. a reactive / transparency mask saying where history is a lie.
 *
 * None of those exist in an h264 file.  Every one of them here is estimated
 * from the picture, and every estimate is wrong in a way the algorithm was
 * never designed to tolerate:
 *
 *   - motion vectors: NVOFA optical flow.  Flow is not a motion vector.  It is
 *     measured from the same compressed picture being upscaled, it has no
 *     notion of the jitter it is supposed to exclude, and it is undefined
 *     wherever the picture is flat or occluded.
 *   - depth: either a constant (`flat`), which tells FSR2 the whole scene sits
 *     on one plane and disables every depth-driven decision it makes, or a
 *     monocular estimate, which is RELATIVE, unscaled, and jitters frame to
 *     frame.  FSR2 uses depth for disocclusion detection and motion vector
 *     dilation, so unstable depth actively manufactures ghosting.
 *   - jitter: measured global sub-pixel offset by Hanning-windowed phase
 *     correlation, the same estimator those measurements used.  It is REAL, but it
 *     is one global number, and on this material the median textured block
 *     departs from it by 0.29 px against FSR2's whole +/-0.5 px budget.  A
 *     fixed sensor produces a near-null sequence, which is precisely what
 *     AMD's documentation says must never be supplied.
 *   - reactive mask: forward/backward flow inconsistency, which finds
 *     occlusion and disocclusion but not transparency or shading change.
 *
 * The honest summary is in FSR2.md.  Nothing in this file makes a temporal
 * upscaler correct on recorded video; it makes one runnable on it.
 */

#ifndef AVFILTER_GU_INPUTS_H
#define AVFILTER_GU_INPUTS_H

#include <dlfcn.h>
#include <float.h>
#include <math.h>
#include <string.h>

#include "libavutil/mem.h"
#include "libavutil/opt.h"
#include "libavutil/tx.h"
#include "avfilter.h"

#include <ffnvcodec/dynlink_loader.h>

/* nvOpticalFlowCommon.h references this before declaring it; same forward
 * declaration vf_optix.c carries. */
typedef struct NV_OF_ROI_RECT NV_OF_ROI_RECT;
#include "nvOpticalFlowCommon.h"
#include "nvOpticalFlowCuda.h"

enum GUJitter { GU_JITTER_MEASURED = 0, GU_JITTER_CANCEL, GU_JITTER_ZERO, GU_JITTER_HALTON };
enum GUDepth  { GU_DEPTH_FLAT = 0, GU_DEPTH_MODEL, GU_DEPTH_MODEL_STABLE };
enum GUReact  { GU_REACT_NONE = 0, GU_REACT_FLOW };

/* NVOFA reports flow on a 4x4 grid in S10.5 fixed point, the same choice
 * vf_optix.c made and for the same reason: grid 4 is the finest this silicon
 * offers and the cost is fixed-function either way. */
#define GU_OF_GRID       4
#define GU_OF_FIXED      32.0f

typedef struct GUInputs {
    /* ---- configuration, set by the owning filter before gu_inputs_init ---- */
    int    w, h;
    int    jitter_mode;
    int    depth_mode;
    int    react_mode;
    const char *depth_model;
    int    device_index;

    /* ---- results, valid after gu_inputs_frame() ---- */
    float *flow;        /* w*h*2, pixels, previous -> current                 */
    float *depth;       /* w*h,   0..1, 1 = far (NOT inverted depth)          */
    float *reactive;    /* w*h,   0..1                                        */
    float  jitter_x, jitter_y;   /* pixels, global sub-pixel offset           */
    float  pcpeak;      /* phase correlation confidence 0..1                  */
    int    have_previous;
    int    frame_index;

    /* ---- internals ---- */
    CudaFunctions *cu;
    CUdevice   cu_device;
    CUcontext  cu_ctx;

    void *nvof_lib;
    NV_OF_CUDA_API_FUNCTION_LIST nvof;
    NvOFHandle          nvof_session;
    NvOFGPUBufferHandle nvof_frame[2];
    NvOFGPUBufferHandle nvof_out;
    uint32_t nvof_in_pitch, nvof_out_pitch;
    int      nvof_slot, nvof_ready;
    int      grid_w, grid_h;
    int16_t *grid;          /* raw NVOFA output, grid_w*grid_h*2              */
    int16_t *grid_bwd;

    uint8_t *luma, *luma_prev, *luma_s;

    /* phase correlation */
    AVTXContext *tx_fwd_row, *tx_fwd_col, *tx_inv_row, *tx_inv_col;
    av_tx_fn     fn_fwd_row, fn_fwd_col, fn_inv_row, fn_inv_col;
    int          pc_ok;
    float       *win_x, *win_y;          /* separable Hanning                 */
    AVComplexFloat *A, *B, *T;           /* w*h each                          */
    float       *pc_prev;                /* windowed previous luma            */

    /* depth */
    void  *ort_lib;
    void  *ort_api;                      /* const OrtApi*                     */
    void  *ort_env, *ort_sess, *ort_opts, *ort_meminfo;
    int    depth_in_w, depth_in_h;
    float *depth_in, *depth_out_raw;
    float *depth_prev;
    int    depth_ready;
} GUInputs;

/* ------------------------------------------------------------------ CUDA -- */

#define GU_CHECK_CU(ctx, x)                                                      \
    do {                                                                         \
        CUresult _r = (x);                                                       \
        if (_r != CUDA_SUCCESS) {                                                \
            const char *_n = NULL;                                               \
            if (g->cu && g->cu->cuGetErrorName) g->cu->cuGetErrorName(_r, &_n);   \
            av_log(ctx, AV_LOG_ERROR, "CUDA error %s (%d) at " #x "\n",           \
                   _n ? _n : "?", (int)_r);                                       \
            return AVERROR_EXTERNAL;                                             \
        }                                                                        \
    } while (0)

/* --------------------------------------------------------------- Hanning -- */

static int gu_pc_init(AVFilterContext *ctx, GUInputs *g)
{
    int i, ret;
    float scale = 1.0f;

    g->win_x = av_malloc_array(g->w, sizeof(float));
    g->win_y = av_malloc_array(g->h, sizeof(float));
    g->A     = av_malloc_array((size_t)g->w * g->h, sizeof(AVComplexFloat));
    g->B     = av_malloc_array((size_t)g->w * g->h, sizeof(AVComplexFloat));
    g->T     = av_malloc_array((size_t)g->w * g->h, sizeof(AVComplexFloat));
    g->pc_prev = av_malloc_array((size_t)g->w * g->h, sizeof(float));
    if (!g->win_x || !g->win_y || !g->A || !g->B || !g->T || !g->pc_prev)
        return AVERROR(ENOMEM);

    /* cv::createHanningWindow is the separable outer product of two raised
     * cosines, which is what the those measurements scripts fed cv::phaseCorrelate. */
    for (i = 0; i < g->w; i++)
        g->win_x[i] = 0.5f * (1.0f - cosf(2.0f * (float)M_PI * i / (g->w - 1)));
    for (i = 0; i < g->h; i++)
        g->win_y[i] = 0.5f * (1.0f - cosf(2.0f * (float)M_PI * i / (g->h - 1)));

    ret = av_tx_init(&g->tx_fwd_row, &g->fn_fwd_row, AV_TX_FLOAT_FFT, 0, g->w, &scale, 0);
    if (ret < 0) goto unsupported;
    ret = av_tx_init(&g->tx_fwd_col, &g->fn_fwd_col, AV_TX_FLOAT_FFT, 0, g->h, &scale, 0);
    if (ret < 0) goto unsupported;
    ret = av_tx_init(&g->tx_inv_row, &g->fn_inv_row, AV_TX_FLOAT_FFT, 1, g->w, &scale, 0);
    if (ret < 0) goto unsupported;
    ret = av_tx_init(&g->tx_inv_col, &g->fn_inv_col, AV_TX_FLOAT_FFT, 1, g->h, &scale, 0);
    if (ret < 0) goto unsupported;

    g->pc_ok = 1;
    return 0;

unsupported:
    av_log(ctx, AV_LOG_WARNING,
           "av_tx has no FFT for %dx%d; measured jitter unavailable, "
           "falling back to zero jitter\n", g->w, g->h);
    g->pc_ok = 0;
    return 0;
}

/* 2D FFT by rows then columns, in place in dst (w*h complex). */
static void gu_fft2(GUInputs *g, AVComplexFloat *dst, int inverse)
{
    AVTXContext *rowc = inverse ? g->tx_inv_row : g->tx_fwd_row;
    av_tx_fn     rowf = inverse ? g->fn_inv_row : g->fn_fwd_row;
    AVTXContext *colc = inverse ? g->tx_inv_col : g->tx_fwd_col;
    av_tx_fn     colf = inverse ? g->fn_inv_col : g->fn_fwd_col;
    int x, y;

    for (y = 0; y < g->h; y++) {
        memcpy(g->T, dst + (size_t)y * g->w, g->w * sizeof(AVComplexFloat));
        rowf(rowc, dst + (size_t)y * g->w, g->T, sizeof(AVComplexFloat));
    }
    for (x = 0; x < g->w; x++) {
        for (y = 0; y < g->h; y++)
            g->T[y] = dst[(size_t)y * g->w + x];
        colf(colc, g->T + g->h, g->T, sizeof(AVComplexFloat));
        for (y = 0; y < g->h; y++)
            dst[(size_t)y * g->w + x] = g->T[g->h + y];
    }
}

/* Hanning-windowed phase correlation, the estimator the phase-correlation estimator
 * used through cv::phaseCorrelate, reimplemented on av_tx.  Returns the shift
 * that carries `prev` onto `cur`, sub-pixel, by the same 5x5 weighted centroid
 * OpenCV uses around the correlation peak. */
static void gu_phase_correlate(GUInputs *g, const uint8_t *cur, float *dx, float *dy, float *peak)
{
    int x, y, i, j, px = 0, py = 0;
    float best = -FLT_MAX, sum = 0.0f, cx = 0.0f, cy = 0.0f, total = 0.0f;

    *dx = *dy = 0.0f; *peak = 0.0f;
    if (!g->pc_ok)
        return;

    for (y = 0; y < g->h; y++) {
        for (x = 0; x < g->w; x++) {
            size_t k = (size_t)y * g->w + x;
            float wgt = g->win_y[y] * g->win_x[x];
            g->A[k].re = cur[k] * wgt; g->A[k].im = 0.0f;
            g->B[k].re = g->pc_prev[k]; g->B[k].im = 0.0f;
        }
    }
    gu_fft2(g, g->A, 0);
    gu_fft2(g, g->B, 0);

    /* cross power spectrum, normalised: R = A .* conj(B) / |A .* conj(B)| */
    for (i = 0; i < g->w * g->h; i++) {
        float re = g->A[i].re * g->B[i].re + g->A[i].im * g->B[i].im;
        float im = g->A[i].im * g->B[i].re - g->A[i].re * g->B[i].im;
        float m  = sqrtf(re * re + im * im) + 1e-12f;
        g->A[i].re = re / m; g->A[i].im = im / m;
    }
    gu_fft2(g, g->A, 1);

    for (y = 0; y < g->h; y++)
        for (x = 0; x < g->w; x++) {
            float v = g->A[(size_t)y * g->w + x].re;
            sum += v;
            if (v > best) { best = v; px = x; py = y; }
        }

    /* 5x5 weighted centroid about the peak, wrapped */
    for (j = -2; j <= 2; j++)
        for (i = -2; i <= 2; i++) {
            int sx = ((px + i) % g->w + g->w) % g->w;
            int sy = ((py + j) % g->h + g->h) % g->h;
            float v = g->A[(size_t)sy * g->w + sx].re;
            if (v < 0.0f) v = 0.0f;
            cx += v * (px + i); cy += v * (py + j); total += v;
        }
    if (total > 0.0f) { cx /= total; cy /= total; }
    else              { cx = px; cy = py; }

    if (cx > g->w / 2.0f) cx -= g->w;
    if (cy > g->h / 2.0f) cy -= g->h;

    /* OpenCV's convention: the shift that moves the SECOND image onto the
     * first.  We want previous -> current, hence the negation. */
    *dx = -cx; *dy = -cy;
    *peak = sum != 0.0f ? best / fabsf(sum) : 0.0f;
    if (*peak > 1.0f) *peak = 1.0f;
}

static void gu_pc_store_prev(GUInputs *g, const uint8_t *cur)
{
    int x, y;
    if (!g->pc_ok) return;
    for (y = 0; y < g->h; y++)
        for (x = 0; x < g->w; x++) {
            size_t k = (size_t)y * g->w + x;
            g->pc_prev[k] = cur[k] * g->win_y[y] * g->win_x[x];
        }
}


/* ------------------------------------------------------------------ NVOFA -- */

static int gu_nvof_init(AVFilterContext *ctx, GUInputs *g)
{
    NV_OF_STATUS (*create_instance)(uint32_t, NV_OF_CUDA_API_FUNCTION_LIST *);
    NV_OF_INIT_PARAMS init;
    NV_OF_BUFFER_DESCRIPTOR desc;
    NV_OF_CUDA_BUFFER_STRIDE_INFO stride;
    NV_OF_STATUS st;
    int i;

    g->nvof_lib = dlopen("libnvidia-opticalflow.so.1", RTLD_NOW);
    if (!g->nvof_lib) {
        av_log(ctx, AV_LOG_WARNING, "NVOFA unavailable (%s)\n", dlerror());
        return AVERROR_EXTERNAL;
    }
    create_instance = dlsym(g->nvof_lib, "NvOFAPICreateInstanceCuda");
    if (!create_instance) {
        av_log(ctx, AV_LOG_WARNING, "NvOFAPICreateInstanceCuda not found\n");
        return AVERROR_EXTERNAL;
    }
    memset(&g->nvof, 0, sizeof(g->nvof));
    if ((st = create_instance(NV_OF_API_VERSION, &g->nvof)) != NV_OF_SUCCESS) {
        av_log(ctx, AV_LOG_WARNING, "NVOFA instance failed (%d)\n", st);
        return AVERROR_EXTERNAL;
    }
    if ((st = g->nvof.nvCreateOpticalFlowCuda(g->cu_ctx, &g->nvof_session)) != NV_OF_SUCCESS) {
        av_log(ctx, AV_LOG_WARNING, "NVOFA session failed (%d)\n", st);
        return AVERROR_EXTERNAL;
    }

    memset(&init, 0, sizeof(init));
    init.width        = g->w;
    init.height       = g->h;
    init.outGridSize  = NV_OF_OUTPUT_VECTOR_GRID_SIZE_4;
    init.hintGridSize = NV_OF_HINT_VECTOR_GRID_SIZE_UNDEFINED;
    init.mode         = NV_OF_MODE_OPTICALFLOW;
    init.perfLevel    = NV_OF_PERF_LEVEL_FAST;
    if ((st = g->nvof.nvOFInit(g->nvof_session, &init)) != NV_OF_SUCCESS) {
        av_log(ctx, AV_LOG_WARNING, "NVOFA init failed (%d)\n", st);
        return AVERROR_EXTERNAL;
    }

    g->grid_w = (g->w + GU_OF_GRID - 1) / GU_OF_GRID;
    g->grid_h = (g->h + GU_OF_GRID - 1) / GU_OF_GRID;

    memset(&desc, 0, sizeof(desc));
    desc.width  = g->w;
    desc.height = g->h;
    desc.bufferFormat = NV_OF_BUFFER_FORMAT_GRAYSCALE8;
    desc.bufferUsage  = NV_OF_BUFFER_USAGE_INPUT;
    for (i = 0; i < 2; i++) {
        st = g->nvof.nvOFCreateGPUBufferCuda(g->nvof_session, &desc,
                                             NV_OF_CUDA_BUFFER_TYPE_CUDEVICEPTR, &g->nvof_frame[i]);
        if (st != NV_OF_SUCCESS) {
            av_log(ctx, AV_LOG_WARNING, "NVOFA input buffer failed (%d)\n", st);
            return AVERROR_EXTERNAL;
        }
    }
    desc.width  = g->grid_w;
    desc.height = g->grid_h;
    desc.bufferFormat = NV_OF_BUFFER_FORMAT_SHORT2;
    desc.bufferUsage  = NV_OF_BUFFER_USAGE_OUTPUT;
    st = g->nvof.nvOFCreateGPUBufferCuda(g->nvof_session, &desc,
                                         NV_OF_CUDA_BUFFER_TYPE_CUDEVICEPTR, &g->nvof_out);
    if (st != NV_OF_SUCCESS) {
        av_log(ctx, AV_LOG_WARNING, "NVOFA output buffer failed (%d)\n", st);
        return AVERROR_EXTERNAL;
    }

    g->nvof.nvOFGPUBufferGetStrideInfo(g->nvof_frame[0], &stride);
    g->nvof_in_pitch = stride.strideInfo[0].strideXInBytes;
    g->nvof.nvOFGPUBufferGetStrideInfo(g->nvof_out, &stride);
    g->nvof_out_pitch = stride.strideInfo[0].strideXInBytes;

    g->grid     = av_malloc_array((size_t)g->grid_w * g->grid_h, 2 * sizeof(int16_t));
    g->grid_bwd = av_malloc_array((size_t)g->grid_w * g->grid_h, 2 * sizeof(int16_t));
    if (!g->grid || !g->grid_bwd)
        return AVERROR(ENOMEM);

    g->nvof_ready = 1;
    av_log(ctx, AV_LOG_VERBOSE, "NVOFA flow %dx%d on a %dx%d grid\n",
           g->w, g->h, g->grid_w, g->grid_h);
    return 0;
}

static int gu_upload_luma(AVFilterContext *ctx, GUInputs *g, const uint8_t *src,
                          NvOFGPUBufferHandle dst)
{
    CUDA_MEMCPY2D m = { 0 };
    m.srcMemoryType = CU_MEMORYTYPE_HOST;
    m.srcHost       = src;
    m.srcPitch      = g->w;
    m.dstMemoryType = CU_MEMORYTYPE_DEVICE;
    m.dstDevice     = g->nvof.nvOFGPUBufferGetCUdeviceptr(dst);
    m.dstPitch      = g->nvof_in_pitch;
    m.WidthInBytes  = g->w;
    m.Height        = g->h;
    GU_CHECK_CU(ctx, g->cu->cuMemcpy2D(&m));
    return 0;
}

static int gu_download_grid(AVFilterContext *ctx, GUInputs *g, int16_t *dst)
{
    CUDA_MEMCPY2D m = { 0 };
    m.srcMemoryType = CU_MEMORYTYPE_DEVICE;
    m.srcDevice     = g->nvof.nvOFGPUBufferGetCUdeviceptr(g->nvof_out);
    m.srcPitch      = g->nvof_out_pitch;
    m.dstMemoryType = CU_MEMORYTYPE_HOST;
    m.dstHost       = dst;
    m.dstPitch      = g->grid_w * 2 * sizeof(int16_t);
    m.WidthInBytes  = g->grid_w * 2 * sizeof(int16_t);
    m.Height        = g->grid_h;
    GU_CHECK_CU(ctx, g->cu->cuMemcpy2D(&m));
    return 0;
}

static int gu_nvof_run(AVFilterContext *ctx, GUInputs *g,
                       NvOFGPUBufferHandle in, NvOFGPUBufferHandle ref, int16_t *dst)
{
    NV_OF_EXECUTE_INPUT_PARAMS  ip;
    NV_OF_EXECUTE_OUTPUT_PARAMS op;
    NV_OF_STATUS st;

    memset(&ip, 0, sizeof(ip));
    memset(&op, 0, sizeof(op));
    ip.inputFrame     = in;
    ip.referenceFrame = ref;
    /* One output buffer serves both directions: the forward and backward runs are
     * sequential and each is downloaded before the next overwrites it. */
    op.outputBuffer   = g->nvof_out;
    if ((st = g->nvof.nvOFExecute(g->nvof_session, &ip, &op)) != NV_OF_SUCCESS) {
        av_log(ctx, AV_LOG_WARNING, "NVOFA execute failed (%d), assuming no motion\n", st);
        memset(dst, 0, (size_t)g->grid_w * g->grid_h * 2 * sizeof(int16_t));
        return 0;
    }
    return gu_download_grid(ctx, g, dst);
}

/* A 3x3 box over the luma before NVOFA sees it.  Lifted from vf_optix.c for the
 * same measured reason: per-pixel compression noise is exactly what makes block
 * matching return a wrong-but-confident vector.  The picture is not touched. */
static void gu_smooth_luma(GUInputs *g)
{
    int x, y;
    for (y = 0; y < g->h; y++) {
        int y0 = y > 0 ? y - 1 : 0, y1 = y < g->h - 1 ? y + 1 : g->h - 1;
        for (x = 0; x < g->w; x++) {
            int x0 = x > 0 ? x - 1 : 0, x1 = x < g->w - 1 ? x + 1 : g->w - 1;
            int s = g->luma[(size_t)y0 * g->w + x0] + g->luma[(size_t)y0 * g->w + x]
                  + g->luma[(size_t)y0 * g->w + x1] + g->luma[(size_t)y  * g->w + x0]
                  + g->luma[(size_t)y  * g->w + x]  + g->luma[(size_t)y  * g->w + x1]
                  + g->luma[(size_t)y1 * g->w + x0] + g->luma[(size_t)y1 * g->w + x]
                  + g->luma[(size_t)y1 * g->w + x1];
            g->luma_s[(size_t)y * g->w + x] = (s + 4) / 9;
        }
    }
}

static inline void gu_grid_sample(const GUInputs *g, const int16_t *grid,
                                  int x, int y, float *vx, float *vy)
{
    int gx = x / GU_OF_GRID, gy = y / GU_OF_GRID;
    size_t k;
    if (gx >= g->grid_w) gx = g->grid_w - 1;
    if (gy >= g->grid_h) gy = g->grid_h - 1;
    k = ((size_t)gy * g->grid_w + gx) * 2;
    /* NVOFA is run with inputFrame = current and referenceFrame = previous, so
     * its vector points BACK.  Negate to get previous -> current. */
    *vx = -grid[k]     / GU_OF_FIXED;
    *vy = -grid[k + 1] / GU_OF_FIXED;
}

static void gu_expand_flow(GUInputs *g)
{
    int x, y;
    for (y = 0; y < g->h; y++)
        for (x = 0; x < g->w; x++) {
            float vx, vy;
            gu_grid_sample(g, g->grid, x, y, &vx, &vy);
            g->flow[((size_t)y * g->w + x) * 2]     = vx;
            g->flow[((size_t)y * g->w + x) * 2 + 1] = vy;
        }
}

/* Reactive mask from forward/backward flow inconsistency.
 *
 * This is FSR2's own designed answer to ghosting used the only way recorded
 * video can supply it: warp by the forward field, look up the backward field
 * there, and call the residual the probability that history is wrong.  It finds
 * occlusion and disocclusion, which is where most of the ghosting comes from.
 * It does NOT find transparency, particles or shading change, which is what a
 * renderer's reactive mask is actually for. */
static void gu_build_reactive(GUInputs *g)
{
    int x, y;
    for (y = 0; y < g->h; y++)
        for (x = 0; x < g->w; x++) {
            float fx, fy, bx, by, ex, ey, err, mag, v;
            int sx, sy;
            gu_grid_sample(g, g->grid, x, y, &fx, &fy);
            sx = (int)lrintf(x + fx); sy = (int)lrintf(y + fy);
            if (sx < 0) sx = 0; if (sx >= g->w) sx = g->w - 1;
            if (sy < 0) sy = 0; if (sy >= g->h) sy = g->h - 1;
            /* the backward grid was produced with the roles swapped, so its
             * stored sign already means current -> previous once negated */
            gu_grid_sample(g, g->grid_bwd, sx, sy, &bx, &by);
            ex = fx + (-bx); ey = fy + (-by);
            err = sqrtf(ex * ex + ey * ey);
            mag = sqrtf(fx * fx + fy * fy) + sqrtf(bx * bx + by * by);
            v = err / (0.5f * mag + 1.0f);
            if (v > 1.0f) v = 1.0f;
            if (v < 0.0f) v = 0.0f;
            g->reactive[(size_t)y * g->w + x] = v;
        }
}

/* ------------------------------------------------------------------ depth -- */

/*
 * Monocular depth through ONNX Runtime, loaded with dlopen so that this filter
 * links against no inference stack at all: if libonnxruntime is missing the
 * filter warns once and falls back to flat depth rather than failing the
 * session.  ONNX Runtime is the same runtime the `ort` filter in this binary
 * uses; no second stack is installed.
 *
 * What comes out is RELATIVE INVERSE depth, per frame, with no scale and no
 * temporal term.  Depth Anything V2 does not know that frame N and frame N+1
 * are the same scene.  FSR2 reads depth for disocclusion detection and motion
 * vector dilation, both of which compare depth ACROSS frames, so the model's
 * frame-to-frame wander is read by FSR2 as geometry appearing and vanishing.
 * `depth=model-stable` warps the previous depth by the flow field and blends,
 * which is a patch over that, not a fix for it.
 */

#include <onnxruntime_c_api.h>

typedef const OrtApiBase *(*gu_ort_base_fn)(void);
#define GU_ORT ((const OrtApi *)g->ort_api)

static void gu_depth_close(GUInputs *g)
{
    if (g->ort_api) {
        if (g->ort_sess)    GU_ORT->ReleaseSession(g->ort_sess);
        if (g->ort_opts)    GU_ORT->ReleaseSessionOptions(g->ort_opts);
        if (g->ort_meminfo) GU_ORT->ReleaseMemoryInfo(g->ort_meminfo);
        if (g->ort_env)     GU_ORT->ReleaseEnv(g->ort_env);
    }
    g->ort_sess = g->ort_opts = g->ort_meminfo = g->ort_env = NULL;
    /* The handle is dropped and the image deliberately left mapped.  ONNX
     * Runtime keeps worker threads, thread-local arenas and CUDA EP state alive
     * past session release and registers static destructors, so unmapping it at
     * filter teardown faults the whole ffmpeg process and takes the viewer's
     * playback with it.  One leaked image per process is the cheap side. */
    g->ort_lib = NULL;
    g->ort_api = NULL;
    g->depth_ready = 0;
}

static int gu_depth_init(AVFilterContext *ctx, GUInputs *g)
{
    gu_ort_base_fn base_fn;
    const OrtApiBase *base;
    OrtStatus *st;

    if (!g->depth_model || !*g->depth_model) {
        av_log(ctx, AV_LOG_WARNING,
               "depth=model asked for but no dmodel= path given; using flat depth\n");
        return AVERROR(EINVAL);
    }
    g->ort_lib = dlopen("libonnxruntime.so.1", RTLD_NOW | RTLD_GLOBAL);
    if (!g->ort_lib)
        g->ort_lib = dlopen("libonnxruntime.so", RTLD_NOW | RTLD_GLOBAL);
    if (!g->ort_lib) {
        av_log(ctx, AV_LOG_WARNING,
               "ONNX Runtime not loadable (%s); using flat depth\n", dlerror());
        return AVERROR_EXTERNAL;
    }
    base_fn = (gu_ort_base_fn)dlsym(g->ort_lib, "OrtGetApiBase");
    if (!base_fn) {
        av_log(ctx, AV_LOG_WARNING, "OrtGetApiBase not found; using flat depth\n");
        return AVERROR_EXTERNAL;
    }
    base = base_fn();
    g->ort_api = (void *)base->GetApi(ORT_API_VERSION);
    if (!g->ort_api) {
        av_log(ctx, AV_LOG_WARNING, "ONNX Runtime API version mismatch; using flat depth\n");
        return AVERROR_EXTERNAL;
    }

#define GU_ORT_CHECK(x)                                                        \
    do {                                                                       \
        st = (x);                                                              \
        if (st) {                                                              \
            av_log(ctx, AV_LOG_WARNING, "onnxruntime: %s; using flat depth\n",  \
                   GU_ORT->GetErrorMessage(st));                               \
            GU_ORT->ReleaseStatus(st);                                         \
            return AVERROR_EXTERNAL;                                           \
        }                                                                      \
    } while (0)

    GU_ORT_CHECK(GU_ORT->CreateEnv(ORT_LOGGING_LEVEL_ERROR, "gu_depth",
                                   (OrtEnv **)&g->ort_env));
    GU_ORT_CHECK(GU_ORT->CreateSessionOptions((OrtSessionOptions **)&g->ort_opts));
    GU_ORT_CHECK(GU_ORT->SetIntraOpNumThreads(g->ort_opts, 2));
    GU_ORT_CHECK(GU_ORT->SetSessionGraphOptimizationLevel(g->ort_opts, ORT_ENABLE_ALL));
    /* CUDA if the provider is there, CPU if not: a depth estimate is not worth
     * failing a transcode over. */
    st = GU_ORT->SessionOptionsAppendExecutionProvider_CUDA(g->ort_opts,
             &(OrtCUDAProviderOptions){ .device_id = g->device_index });
    if (st) {
        /* A per-frame vision transformer on the CPU is not a transcode filter, it is
         * a still-image tool: measured around 1 fps at 518x518 on this box.  So the
         * absence of the CUDA execution provider is a fallback to FLAT depth, not a
         * fallback to slow depth. */
        av_log(ctx, AV_LOG_WARNING,
               "ONNX Runtime has no CUDA execution provider here (%s); the depth model "
               "would run on the CPU at about 1 fps, so depth falls back to flat\n",
               GU_ORT->GetErrorMessage(st));
        GU_ORT->ReleaseStatus(st);
        return AVERROR_EXTERNAL;
    }
    GU_ORT_CHECK(GU_ORT->CreateSession(g->ort_env, g->depth_model, g->ort_opts,
                                       (OrtSession **)&g->ort_sess));
    GU_ORT_CHECK(GU_ORT->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault,
                                             (OrtMemoryInfo **)&g->ort_meminfo));

    /* Depth Anything V2 and MiDaS both want a square, stride-14 or stride-32
     * input.  518 is DA-V2's native size and the cheapest that keeps its
     * accuracy; nothing here depends on the exact number. */
    g->depth_in_w = g->depth_in_h = 518;
    g->depth_in       = av_malloc_array((size_t)g->depth_in_w * g->depth_in_h * 3, sizeof(float));
    g->depth_out_raw  = av_malloc_array((size_t)g->depth_in_w * g->depth_in_h, sizeof(float));
    if (!g->depth_in || !g->depth_out_raw)
        return AVERROR(ENOMEM);

    g->depth_ready = 1;
    av_log(ctx, AV_LOG_VERBOSE, "monocular depth: %s at %dx%d\n",
           g->depth_model, g->depth_in_w, g->depth_in_h);
    return 0;
}

/* ImageNet normalisation, the preprocessing every DPT-family depth model wants */
static void gu_depth_pack(GUInputs *g, const AVFrame *in)
{
    static const float mean[3] = { 0.485f, 0.456f, 0.406f };
    static const float sdev[3] = { 0.229f, 0.224f, 0.225f };
    const float *R = (const float *)in->data[2], *G = (const float *)in->data[0],
                *B = (const float *)in->data[1];
    int rls = in->linesize[2] / 4, gls = in->linesize[0] / 4, bls = in->linesize[1] / 4;
    int x, y, N = g->depth_in_w * g->depth_in_h;

    for (y = 0; y < g->depth_in_h; y++) {
        int sy = (int)((int64_t)y * g->h / g->depth_in_h);
        for (x = 0; x < g->depth_in_w; x++) {
            int sx = (int)((int64_t)x * g->w / g->depth_in_w);
            int o = y * g->depth_in_w + x;
            g->depth_in[o]         = (R[(size_t)sy * rls + sx] - mean[0]) / sdev[0];
            g->depth_in[o + N]     = (G[(size_t)sy * gls + sx] - mean[1]) / sdev[1];
            g->depth_in[o + 2 * N] = (B[(size_t)sy * bls + sx] - mean[2]) / sdev[2];
        }
    }
}

static int gu_depth_run(AVFilterContext *ctx, GUInputs *g, const AVFrame *in)
{
    const int64_t shape[4] = { 1, 3, g->depth_in_h, g->depth_in_w };
    const char *in_names[1], *out_names[1];
    char *in_name = NULL, *out_name = NULL;
    OrtAllocator *alloc = NULL;
    OrtValue *tin = NULL, *tout = NULL;
    OrtTensorTypeAndShapeInfo *info = NULL;
    ONNXTensorElementDataType etype = ONNX_TENSOR_ELEMENT_DATA_TYPE_UNDEFINED;
    size_t count = 0;
    OrtStatus *st;
    float *raw = NULL, lo = FLT_MAX, hi = -FLT_MAX;
    int x, y, ret = 0;

    gu_depth_pack(g, in);

    if ((st = GU_ORT->GetAllocatorWithDefaultOptions(&alloc))) goto fail;
    if ((st = GU_ORT->SessionGetInputName(g->ort_sess, 0, alloc, &in_name)))   goto fail;
    if ((st = GU_ORT->SessionGetOutputName(g->ort_sess, 0, alloc, &out_name))) goto fail;
    in_names[0] = in_name; out_names[0] = out_name;

    if ((st = GU_ORT->CreateTensorWithDataAsOrtValue(g->ort_meminfo, g->depth_in,
             (size_t)g->depth_in_w * g->depth_in_h * 3 * sizeof(float), shape, 4,
             ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &tin))) goto fail;
    if ((st = GU_ORT->Run(g->ort_sess, NULL, in_names, (const OrtValue *const *)&tin, 1,
                          out_names, 1, &tout))) goto fail;

    /* dmodel= is a user path, so the output geometry is not ours to assume: a
     * model that is not 518x518 float32 would be read past its end here, which
     * is a crash or a leak of whatever follows it, not a bad picture. */
    if ((st = GU_ORT->GetTensorTypeAndShape(tout, &info))) goto fail;
    st = GU_ORT->GetTensorElementType(info, &etype);
    if (!st) st = GU_ORT->GetTensorShapeElementCount(info, &count);
    GU_ORT->ReleaseTensorTypeAndShapeInfo(info);
    info = NULL;
    if (st) goto fail;
    if (etype != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT ||
        count != (size_t)g->depth_in_w * g->depth_in_h) {
        av_log(ctx, AV_LOG_WARNING,
               "depth model returns %zu elements of type %d, expected %d float32 "
               "values; flat depth this frame\n",
               count, (int)etype, g->depth_in_w * g->depth_in_h);
        goto flat;
    }

    if ((st = GU_ORT->GetTensorMutableData(tout, (void **)&raw))) goto fail;

    for (x = 0; x < g->depth_in_w * g->depth_in_h; x++) {
        if (raw[x] < lo) lo = raw[x];
        if (raw[x] > hi) hi = raw[x];
    }
    if (hi - lo < 1e-6f) hi = lo + 1e-6f;

    /* Depth Anything V2 emits relative INVERSE depth: large is near.  That is
     * exactly FSR2's inverted-depth convention, so it is passed through and the
     * context carries FFX_FSR2_ENABLE_DEPTH_INVERTED.  The normalisation is
     * per frame, which is the instability this cannot avoid: the same wall gets
     * a different number in every frame it is not the nearest thing in. */
    for (y = 0; y < g->h; y++) {
        int sy = (int)((int64_t)y * g->depth_in_h / g->h);
        for (x = 0; x < g->w; x++) {
            int sx = (int)((int64_t)x * g->depth_in_w / g->w);
            g->depth[(size_t)y * g->w + x] =
                (raw[(size_t)sy * g->depth_in_w + sx] - lo) / (hi - lo);
        }
    }
    goto done;

fail:
    av_log(ctx, AV_LOG_WARNING, "depth inference failed (%s); flat depth this frame\n",
           st ? GU_ORT->GetErrorMessage(st) : "?");
    if (st) GU_ORT->ReleaseStatus(st);

flat:
    for (x = 0; x < g->w * g->h; x++) g->depth[x] = 0.5f;
    ret = AVERROR_EXTERNAL;

done:
    if (tin)  GU_ORT->ReleaseValue(tin);
    if (tout) GU_ORT->ReleaseValue(tout);
    if (alloc && in_name)  GU_ORT->AllocatorFree(alloc, in_name);
    if (alloc && out_name) GU_ORT->AllocatorFree(alloc, out_name);
    return ret;
}

/* Warp the previous depth by the flow and blend.  Monocular depth is relative
 * and renormalised every frame, so untreated it flickers; FSR2 reads that
 * flicker as geometry changing and stops trusting history, which is ghosting.
 * This moves depth with the scene instead.  It is a smoother, not a fix: the
 * scale error it is smoothing is still there. */
static void gu_depth_stabilise(GUInputs *g)
{
    const float a = 0.5f;
    int x, y;
    if (!g->have_previous) {
        memcpy(g->depth_prev, g->depth, (size_t)g->w * g->h * sizeof(float));
        return;
    }
    for (y = 0; y < g->h; y++)
        for (x = 0; x < g->w; x++) {
            size_t k = (size_t)y * g->w + x;
            float vx = g->flow[k * 2], vy = g->flow[k * 2 + 1];
            int sx = (int)lrintf(x - vx), sy = (int)lrintf(y - vy);
            float prev;
            if (sx < 0) sx = 0; if (sx >= g->w) sx = g->w - 1;
            if (sy < 0) sy = 0; if (sy >= g->h) sy = g->h - 1;
            prev = g->depth_prev[(size_t)sy * g->w + sx];
            g->depth[k] = a * g->depth[k] + (1.0f - a) * prev;
        }
    memcpy(g->depth_prev, g->depth, (size_t)g->w * g->h * sizeof(float));
}

/* ------------------------------------------------------- init / per frame -- */

static void gu_inputs_uninit(GUInputs *g)
{
    if (g->cu && g->cu_ctx)
        g->cu->cuCtxPushCurrent(g->cu_ctx);
    if (g->nvof_session) {
        int i;
        for (i = 0; i < 2; i++)
            if (g->nvof_frame[i]) g->nvof.nvOFDestroyGPUBufferCuda(g->nvof_frame[i]);
        if (g->nvof_out) g->nvof.nvOFDestroyGPUBufferCuda(g->nvof_out);
        g->nvof.nvOFDestroy(g->nvof_session);
        g->nvof_session = NULL;
    }
    if (g->nvof_lib) { dlclose(g->nvof_lib); g->nvof_lib = NULL; }
    gu_depth_close(g);
    if (g->cu && g->cu_ctx) {
        g->cu->cuCtxPopCurrent(&g->cu_ctx);
        g->cu->cuDevicePrimaryCtxRelease(g->cu_device);
        g->cu_ctx = NULL;
    }
    if (g->cu) { cuda_free_functions(&g->cu); g->cu = NULL; }

    av_tx_uninit(&g->tx_fwd_row); av_tx_uninit(&g->tx_fwd_col);
    av_tx_uninit(&g->tx_inv_row); av_tx_uninit(&g->tx_inv_col);

    av_freep(&g->flow);      av_freep(&g->depth);    av_freep(&g->reactive);
    av_freep(&g->grid);      av_freep(&g->grid_bwd);
    av_freep(&g->luma);      av_freep(&g->luma_prev); av_freep(&g->luma_s);
    av_freep(&g->win_x);     av_freep(&g->win_y);
    av_freep(&g->A);         av_freep(&g->B);        av_freep(&g->T);
    av_freep(&g->pc_prev);
    av_freep(&g->depth_in);  av_freep(&g->depth_out_raw); av_freep(&g->depth_prev);
}

static int gu_inputs_init(AVFilterContext *ctx, GUInputs *g, int w, int h)
{
    size_t npix;
    int ret;

    g->w = w; g->h = h;
    npix = (size_t)w * h;

    g->flow     = av_calloc(npix, 2 * sizeof(float));
    g->depth    = av_calloc(npix, sizeof(float));
    g->reactive = av_calloc(npix, sizeof(float));
    g->luma     = av_calloc(npix, 1);
    g->luma_prev= av_calloc(npix, 1);
    g->luma_s   = av_calloc(npix, 1);
    g->depth_prev = av_calloc(npix, sizeof(float));
    if (!g->flow || !g->depth || !g->reactive || !g->luma || !g->luma_prev ||
        !g->luma_s || !g->depth_prev)
        return AVERROR(ENOMEM);

    if ((ret = cuda_load_functions(&g->cu, ctx)) < 0) {
        av_log(ctx, AV_LOG_ERROR, "cannot load libcuda\n");
        return ret;
    }
    GU_CHECK_CU(ctx, g->cu->cuInit(0));
    GU_CHECK_CU(ctx, g->cu->cuDeviceGet(&g->cu_device, g->device_index));
    GU_CHECK_CU(ctx, g->cu->cuDevicePrimaryCtxRetain(&g->cu_ctx, g->cu_device));
    GU_CHECK_CU(ctx, g->cu->cuCtxPushCurrent(g->cu_ctx));

    if (gu_nvof_init(ctx, g) < 0) {
        av_log(ctx, AV_LOG_WARNING,
               "no hardware optical flow: motion vectors will be ZERO, which tells "
               "the upscaler nothing moved\n");
        g->nvof_ready = 0;
    }

    if ((ret = gu_pc_init(ctx, g)) < 0) {
        g->cu->cuCtxPopCurrent(&g->cu_ctx);
        return ret;
    }

    if (g->depth_mode != GU_DEPTH_FLAT && gu_depth_init(ctx, g) < 0) {
        gu_depth_close(g);
        g->depth_mode = GU_DEPTH_FLAT;
    }

    GU_CHECK_CU(ctx, g->cu->cuCtxPopCurrent(&g->cu_ctx));

    g->have_previous = 0;
    g->frame_index   = 0;
    return 0;
}

static float gu_halton(int index, int base)
{
    float f = 1.0f, r = 0.0f;
    while (index > 0) {
        f /= base;
        r += f * (index % base);
        index /= base;
    }
    return r;
}

/* in must be gbrpf32le at g->w x g->h */
static int gu_inputs_frame(AVFilterContext *ctx, GUInputs *g, const AVFrame *in)
{
    const float *R = (const float *)in->data[2], *G = (const float *)in->data[0],
                *B = (const float *)in->data[1];
    int rls = in->linesize[2] / 4, gls = in->linesize[0] / 4, bls = in->linesize[1] / 4;
    int x, y, ret = 0;

    for (y = 0; y < g->h; y++)
        for (x = 0; x < g->w; x++) {
            float l = 0.299f * R[(size_t)y * rls + x]
                    + 0.587f * G[(size_t)y * gls + x]
                    + 0.114f * B[(size_t)y * bls + x];
            l = l < 0.0f ? 0.0f : l > 1.0f ? 1.0f : l;
            g->luma[(size_t)y * g->w + x] = (uint8_t)lrintf(l * 255.0f);
        }

    /* ---- jitter ---------------------------------------------------------- */
    switch (g->jitter_mode) {
    case GU_JITTER_ZERO:
        g->jitter_x = g->jitter_y = 0.0f;
        g->pcpeak = 0.0f;
        break;
    case GU_JITTER_HALTON:
        /* What a renderer would supply.  On recorded video it is a lie: the
         * sample positions it claims were used are not the ones the sensor
         * used, and FSR2 has no way to find that out. */
        g->jitter_x = gu_halton(g->frame_index + 1, 2) - 0.5f;
        g->jitter_y = gu_halton(g->frame_index + 1, 3) - 0.5f;
        g->pcpeak = 0.0f;
        break;
    default:
        if (g->have_previous)
            gu_phase_correlate(g, g->luma, &g->jitter_x, &g->jitter_y, &g->pcpeak);
        else
            g->jitter_x = g->jitter_y = g->pcpeak = 0.0f;
        break;
    }
    if (g->jitter_mode == GU_JITTER_MEASURED || g->jitter_mode == GU_JITTER_CANCEL)
        gu_pc_store_prev(g, g->luma);

    /* ---- motion vectors -------------------------------------------------- */
    gu_smooth_luma(g);
    if (g->nvof_ready) {
        int cur = g->nvof_slot, prev = g->nvof_slot ^ 1;
        if ((ret = g->cu->cuCtxPushCurrent(g->cu_ctx)) != CUDA_SUCCESS)
            return AVERROR_EXTERNAL;
        if (gu_upload_luma(ctx, g, g->luma_s, g->nvof_frame[cur]) < 0) {
            g->cu->cuCtxPopCurrent(&g->cu_ctx);
            return AVERROR_EXTERNAL;
        }
        if (g->have_previous) {
            if (gu_nvof_run(ctx, g, g->nvof_frame[cur], g->nvof_frame[prev], g->grid) < 0)
                memset(g->grid, 0, (size_t)g->grid_w * g->grid_h * 2 * sizeof(int16_t));
            if (g->react_mode == GU_REACT_FLOW &&
                gu_nvof_run(ctx, g, g->nvof_frame[prev], g->nvof_frame[cur], g->grid_bwd) < 0)
                memset(g->grid_bwd, 0, (size_t)g->grid_w * g->grid_h * 2 * sizeof(int16_t));
        } else {
            memset(g->grid,     0, (size_t)g->grid_w * g->grid_h * 2 * sizeof(int16_t));
            memset(g->grid_bwd, 0, (size_t)g->grid_w * g->grid_h * 2 * sizeof(int16_t));
        }
        g->cu->cuCtxPopCurrent(&g->cu_ctx);
        g->nvof_slot ^= 1;
        gu_expand_flow(g);
    } else {
        memset(g->flow, 0, (size_t)g->w * g->h * 2 * sizeof(float));
    }

    /* ---- reactive mask --------------------------------------------------- */
    if (g->react_mode == GU_REACT_FLOW && g->nvof_ready && g->have_previous)
        gu_build_reactive(g);
    else
        memset(g->reactive, 0, (size_t)g->w * g->h * sizeof(float));

    /* ---- depth ----------------------------------------------------------- */
    if (g->depth_mode != GU_DEPTH_FLAT && g->depth_ready) {
        (void)gu_depth_run(ctx, g, in);
        if (g->depth_mode == GU_DEPTH_MODEL_STABLE)
            gu_depth_stabilise(g);
    } else {
        /* A constant depth buffer.  Every depth-driven decision FSR2 makes -
         * disocclusion, motion vector dilation, the depth clip pass - reduces
         * to a no-op, which is at least a KNOWN failure rather than a noisy
         * one. */
        for (x = 0; x < g->w * g->h; x++) g->depth[x] = 0.5f;
    }

    memcpy(g->luma_prev, g->luma, (size_t)g->w * g->h);
    g->have_previous = 1;
    g->frame_index++;
    return 0;
}
#endif /* AVFILTER_GU_INPUTS_H */



