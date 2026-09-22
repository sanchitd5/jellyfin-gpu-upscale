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
 * Super-resolve video frames with NVIDIA's Maxine VFX SDK "VideoSuperRes" effect.
 *
 * Why this exists beside vf_dlss/vf_fsr2/vf_ort: it is the one SR path here built
 * for plain recorded video rather than game rendering.  DLSS and FSR2 want exact
 * motion vectors, a depth buffer and sub-pixel jitter that a renderer supplies and
 * a recording does not - this project synthesises all three and honestly labels
 * the result DEGRADED (see vf_dlss.c, vf_fsr2.c).  Maxine's VideoSuperRes effect
 * takes a plain frame and a quality-level selector; no synthesised game state
 * needed.  It is also pure CUDA end to end (see VSR.md), unlike vf_dlss.c which
 * runs through NGX's Vulkan path.
 *
 * API surface confirmed by reading the actual headers shipped in the NGC VFX SDK
 * Core package v1.3.0.0 (nvVideoEffects.h, nvCVImage.h, nvCVStatus.h) and the
 * nvvfxvideosuperres feature package's own nvVFXVideoSuperRes.h - not the public
 * GitHub MIT mirror, which ships only headers/samples and turned out to lag this
 * NGC release (see VSR.md's "headers differ from the public mirror" note).  Two
 * corrections the public mirror's naming would have gotten wrong if guessed from
 * it alone:
 *   - the effect selector string is "VideoSuperRes" (NVVFX_FX_VIDEO_SUPER_RES),
 *     not "SuperRes";
 *   - quality is NOT a generic on/off "mode": it is NVVFX_QUALITY_LEVEL, an
 *     integer selecting one of a fixed, named ladder (VSR_Bicubic .. VSR_Ultra,
 *     plus STREAMING_MEDIUM/STREAMING_ULTRA on Ampere+), confirmed against
 *     NVIDIA's own filter reference doc
 *     (docs.nvidia.com/maxine/vfx/latest/Filters/VideoSuperResolution.html,
 *     read 2026-09-22) since the header only gives the selector string, not its
 *     value enumeration.
 *
 * Design decision on frame format (see ARCHITECTURE.md's Tier 1/Tier 2 split):
 * this filter takes and returns system-memory AV_PIX_FMT_GBRPF32LE, exactly like
 * vf_optix.c and vf_ort.c, rather than AV_PIX_FMT_CUDA hw frames.  Not because the
 * SDK cannot do better - every NvCVImage buffer here lives in NVCV_CUDA (device)
 * memory and the whole effect runs without a host round trip internally - but
 * because going further (accepting a CUDA hw_frames_ctx from decode, chaining
 * device pointers directly with vf_optix/vf_ort, keeping the frame off system RAM
 * end to end) is Tier 1's job across several filters and the decode path at once,
 * not one new filter's.  Doing it here first would mean retrofitting vf_optix.c
 * and vf_ort.c to match later rather than landing Tier 1 as the coherent change
 * ARCHITECTURE.md already scopes it as.  This filter's own device buffers are a
 * clean building block for that when it happens: the host round trip is confined
 * to pack_slice/unpack_slice below, exactly where vf_optix.c's already is.
 *
 * NvCVImage buffers are RGBA, NVCV_U8, chunky - the SDK's default
 * NVVFX_IMAGE_ENCODING_RGB8 mode (nvVFXVideoSuperRes.h).  gbrpf32le is planar
 * float; pack_slice/unpack_slice convert, same shape as vf_optix.c's RGB packing,
 * with a synthesised opaque alpha since the pipeline carries none.
 *
 * No CUcontext handle appears anywhere in this SDK's public API - NvVFX_Run only
 * takes a CUstream (NVVFX_CUDA_STREAM).  So unlike vf_optix.c, this filter does
 * not retain a primary CUDA context or link the CUDA driver API at all: it uses
 * the SDK's own NvVFX_CudaStreamCreate/Destroy/Synchronize wrappers, which exist
 * in the header specifically so callers do not need to link libcuda.  This is a
 * deliberate deviation from vf_optix.c's device-management pattern, made because
 * the confirmed API genuinely has no context object to manage, not because the
 * convention was skipped.
 *
 * Never verified end to end: NvVFX_Load() needs a model directory
 * (NVVFX_MODEL_DIRECTORY) holding this feature's TensorRT model files, and the
 * NGC download obtained for this task (nvvfxvideosuperres_v1.3.0.0_lib_linux)
 * carries only the library and headers - no model weights, confirmed by listing
 * its contents and by VFXSDK_linux_1.3.0.0.tgz's own VideoFX/lib/models/
 * shipping empty.  The `models` option below has no default for exactly this
 * reason: pointing it at a real, populated directory is the operator's job (see
 * VSR.md), and this filter does not guess a path.  Everything up to NvVFX_Load()
 * failing (or succeeding, once models exist) is real code against a real,
 * version-matched header; nothing about NvVFX_Load()'s outcome has been observed
 * yet.
 */

#include <stdint.h>
#include <string.h>

#include "libavutil/common.h"
#include "libavutil/mem.h"
#include "libavutil/opt.h"
#include "avfilter.h"
#include "filters.h"
#include "video.h"

#include <nvCVStatus.h>
#include <nvCVImage.h>
#include <nvVideoEffects.h>
#include <nvVFXVideoSuperRes.h>

typedef struct VsrContext {
    const AVClass *class;

    int   quality;        /* NVVFX_QUALITY_LEVEL: VSR_Bicubic..HighBitrate_Ultra, STREAMING_* */
    char *models_dir;      /* NVVFX_MODEL_DIRECTORY: operator-supplied, no default (see VSR.md) */
    int   device_index;    /* NVVFX_GPU */
    int   out_w, out_h;    /* 0 = derive from scale */
    float scale;           /* used only when out_w/out_h are 0 */

    int in_w, in_h;

    NvVFX_Handle effect;
    CUstream     stream;   /* via NvVFX_CudaStreamCreate: no libcuda link needed, see file header */

    NvCVImage dev_in, dev_out;   /* NVCV_CUDA, persistent device buffers */
    NvCVImage host_in, host_out; /* NVCV_CPU wrappers around the packed host buffers below */

    uint8_t *host_in_rgba;   /* w*h*4, packed from the input frame each call */
    uint8_t *host_out_rgba;  /* out_w*out_h*4, unpacked into the output frame each call */

    int loaded;
} VsrContext;

typedef struct ThreadData {
    AVFrame *in, *out;
} ThreadData;

static const enum AVPixelFormat pixel_fmts[] = {
    AV_PIX_FMT_GBRPF32LE,
    AV_PIX_FMT_NONE
};

#define CHECK_NVCV(ctx, expr)                                                    \
    do {                                                                         \
        NvCV_Status _st = (expr);                                                \
        if (_st != NVCV_SUCCESS) {                                               \
            av_log(ctx, AV_LOG_ERROR, "%s failed: %s (%d)\n", #expr,             \
                   NvCV_GetErrorStringFromCode(_st), (int)_st);                  \
            return AVERROR_EXTERNAL;                                             \
        }                                                                        \
    } while (0)

/* gbrpf32le: plane 0 = G, plane 1 = B, plane 2 = R. Alpha is synthesised opaque -
 * the pipeline carries none, and RGB8 mode (the SDK default) wants RGBA. */
static int pack_slice(AVFilterContext *ctx, void *arg, int jobnr, int nb_jobs)
{
    VsrContext *s = ctx->priv;
    ThreadData *td = arg;
    const int h0 = (s->in_h * jobnr) / nb_jobs;
    const int h1 = (s->in_h * (jobnr + 1)) / nb_jobs;

    for (int y = h0; y < h1; y++) {
        const float *g = (const float *)(td->in->data[0] + y * td->in->linesize[0]);
        const float *b = (const float *)(td->in->data[1] + y * td->in->linesize[1]);
        const float *r = (const float *)(td->in->data[2] + y * td->in->linesize[2]);
        uint8_t *dst = s->host_in_rgba + (size_t)y * s->in_w * 4;

        for (int x = 0; x < s->in_w; x++) {
            dst[4 * x + 0] = av_clip_uint8((int)(r[x] * 255.f + 0.5f));
            dst[4 * x + 1] = av_clip_uint8((int)(g[x] * 255.f + 0.5f));
            dst[4 * x + 2] = av_clip_uint8((int)(b[x] * 255.f + 0.5f));
            dst[4 * x + 3] = 255;
        }
    }
    return 0;
}

static int unpack_slice(AVFilterContext *ctx, void *arg, int jobnr, int nb_jobs)
{
    VsrContext *s = ctx->priv;
    ThreadData *td = arg;
    const int h0 = (s->out_h * jobnr) / nb_jobs;
    const int h1 = (s->out_h * (jobnr + 1)) / nb_jobs;

    for (int y = h0; y < h1; y++) {
        float *g = (float *)(td->out->data[0] + y * td->out->linesize[0]);
        float *b = (float *)(td->out->data[1] + y * td->out->linesize[1]);
        float *r = (float *)(td->out->data[2] + y * td->out->linesize[2]);
        const uint8_t *src = s->host_out_rgba + (size_t)y * s->out_w * 4;

        for (int x = 0; x < s->out_w; x++) {
            r[x] = src[4 * x + 0] / 255.f;
            g[x] = src[4 * x + 1] / 255.f;
            b[x] = src[4 * x + 2] / 255.f;
        }
    }
    return 0;
}

static av_cold int config_output(AVFilterLink *outlink)
{
    AVFilterLink *inlink = outlink->src->inputs[0];
    AVFilterContext *ctx = outlink->src;
    VsrContext *s = ctx->priv;
    int ret;

    s->in_w = inlink->w;
    s->in_h = inlink->h;

    if (s->out_w > 0 && s->out_h > 0) {
        outlink->w = s->out_w;
        outlink->h = s->out_h;
    } else {
        outlink->w = (int)(s->in_w * s->scale + 0.5f);
        outlink->h = (int)(s->in_h * s->scale + 0.5f);
    }
    s->out_w = outlink->w;
    s->out_h = outlink->h;

    /* NVVFX_GPU is not a valid parameter selector for this effect - confirmed directly
     * (NvVFX_SetU32 returns NVCV_ERR_PARAMETER, -5). NVIDIA's own `nvidia-vfx` PyPI
     * package never sets it either; it selects a device by binding the CUDA context
     * before creating the effect, which this filter does not yet do (see device=
     * below). Only device 0 is exercised on this project's single-GPU box. */
    if (s->device_index != 0)
        av_log(ctx, AV_LOG_WARNING,
               "vsr: device=%d requested but only device 0 is currently wired up "
               "(NVVFX_GPU is not a valid parameter for this effect)\n", s->device_index);

    CHECK_NVCV(ctx, NvVFX_CreateEffect(NVVFX_FX_VIDEO_SUPER_RES, &s->effect));
    CHECK_NVCV(ctx, NvVFX_CudaStreamCreate(&s->stream));
    CHECK_NVCV(ctx, NvVFX_SetCudaStream(s->effect, NVVFX_CUDA_STREAM, s->stream));
    /* models= is optional, not required: NVIDIA's own `nvidia-vfx` PyPI package
     * (nvvfx._lib_loader, confirmed working against libnvidia-ngx-vsr.so.1.8.2)
     * never calls NVVFX_MODEL_DIRECTORY at all - that library version bundles
     * its model internally. Only set it when the operator supplies a directory,
     * for whichever SDK/library combination still expects one (see VSR.md). */
    if (s->models_dir && *s->models_dir)
        CHECK_NVCV(ctx, NvVFX_SetString(s->effect, NVVFX_MODEL_DIRECTORY, s->models_dir));
    CHECK_NVCV(ctx, NvVFX_SetU32(s->effect, NVVFX_QUALITY_LEVEL, (unsigned)s->quality));
    /* NVVFX_IMAGE_ENCODING_MODE is likewise not a valid parameter for this effect
     * (same NVCV_ERR_PARAMETER, -5, confirmed directly) - encoding is presumably
     * fixed or inferred from the bound NvCVImage's own format instead. NVIDIA's
     * own nvidia-vfx Python package never sets it either. */

    CHECK_NVCV(ctx, NvCVImage_Alloc(&s->dev_in,  s->in_w,  s->in_h,  NVCV_RGBA, NVCV_U8,
                                     NVCV_CHUNKY, NVCV_CUDA, 0));
    CHECK_NVCV(ctx, NvCVImage_Alloc(&s->dev_out, s->out_w, s->out_h, NVCV_RGBA, NVCV_U8,
                                     NVCV_CHUNKY, NVCV_CUDA, 0));
    CHECK_NVCV(ctx, NvVFX_SetImage(s->effect, NVVFX_INPUT_IMAGE, &s->dev_in));
    CHECK_NVCV(ctx, NvVFX_SetImage(s->effect, NVVFX_OUTPUT_IMAGE, &s->dev_out));

    s->host_in_rgba  = av_malloc_array((size_t)s->in_w * s->in_h, 4);
    s->host_out_rgba = av_malloc_array((size_t)s->out_w * s->out_h, 4);
    if (!s->host_in_rgba || !s->host_out_rgba)
        return AVERROR(ENOMEM);

    /* CPU wrappers around the packed host buffers, for NvCVImage_Transfer. Same
     * pixel format on both sides (RGBA/U8/chunky), differing only in memSpace -
     * no conversion, just a copy, so a NULL tmp buffer is fine (see nvCVImage.h's
     * own note on NvCVImage_Transfer). */
    CHECK_NVCV(ctx, NvCVImage_Init(&s->host_in, s->in_w, s->in_h,
                                    (int)((size_t)s->in_w * 4), s->host_in_rgba,
                                    NVCV_RGBA, NVCV_U8, NVCV_CHUNKY, NVCV_CPU));
    CHECK_NVCV(ctx, NvCVImage_Init(&s->host_out, s->out_w, s->out_h,
                                    (int)((size_t)s->out_w * 4), s->host_out_rgba,
                                    NVCV_RGBA, NVCV_U8, NVCV_CHUNKY, NVCV_CPU));

    /* Load can legitimately fail here with NVCV_ERR_MODEL/NVCV_ERR_FILE if
     * models_dir does not hold this feature's model files - see the file header
     * and VSR.md. That is real, useful failure information, not swallowed. */
    if ((ret = NvVFX_Load(s->effect)) != NVCV_SUCCESS) {
        av_log(ctx, AV_LOG_ERROR, "NvVFX_Load failed: %s (%d)\n",
               NvCV_GetErrorStringFromCode(ret), ret);
        return AVERROR_EXTERNAL;
    }
    s->loaded = 1;

    av_log(ctx, AV_LOG_VERBOSE, "Maxine VideoSuperRes %dx%d -> %dx%d quality=%d models=%s\n",
           s->in_w, s->in_h, s->out_w, s->out_h, s->quality,
           (s->models_dir && *s->models_dir) ? s->models_dir : "(bundled)");
    return 0;
}

static int filter_frame(AVFilterLink *inlink, AVFrame *in)
{
    AVFilterContext *ctx = inlink->dst;
    AVFilterLink *outlink = ctx->outputs[0];
    VsrContext *s = ctx->priv;
    const int nb_jobs_in  = FFMIN(s->in_h,  ff_filter_get_nb_threads(ctx));
    const int nb_jobs_out = FFMIN(s->out_h, ff_filter_get_nb_threads(ctx));
    ThreadData td;
    AVFrame *out;
    int ret;

    out = ff_get_video_buffer(outlink, outlink->w, outlink->h);
    if (!out) {
        av_frame_free(&in);
        return AVERROR(ENOMEM);
    }
    av_frame_copy_props(out, in);

    td.in = in;
    td.out = out;

    if ((ret = ff_filter_execute(ctx, pack_slice, &td, NULL, nb_jobs_in)) < 0)
        goto fail;

    if (NvCVImage_Transfer(&s->host_in, &s->dev_in, 1.f, s->stream, NULL) != NVCV_SUCCESS) {
        av_log(ctx, AV_LOG_ERROR, "upload to device image failed\n");
        ret = AVERROR_EXTERNAL;
        goto fail;
    }

    if (NvVFX_Run(s->effect, 0) != NVCV_SUCCESS) {
        av_log(ctx, AV_LOG_ERROR, "NvVFX_Run failed\n");
        ret = AVERROR_EXTERNAL;
        goto fail;
    }

    if (NvCVImage_Transfer(&s->dev_out, &s->host_out, 1.f, s->stream, NULL) != NVCV_SUCCESS) {
        av_log(ctx, AV_LOG_ERROR, "download from device image failed\n");
        ret = AVERROR_EXTERNAL;
        goto fail;
    }
    NvVFX_CudaStreamSynchronize(s->stream);

    if ((ret = ff_filter_execute(ctx, unpack_slice, &td, NULL, nb_jobs_out)) < 0)
        goto fail;

    av_frame_free(&in);
    return ff_filter_frame(outlink, out);

fail:
    av_frame_free(&in);
    av_frame_free(&out);
    return ret;
}

static av_cold void uninit(AVFilterContext *ctx)
{
    VsrContext *s = ctx->priv;

    if (s->effect) {
        if (s->loaded) {
            /* Images are shallow-copied handles into device buffers we own; clear
             * them before freeing those buffers so a stray NvVFX_Run after uninit
             * (there shouldn't be one) cannot dereference freed memory. */
            NvVFX_SetImage(s->effect, NVVFX_INPUT_IMAGE, NULL);
            NvVFX_SetImage(s->effect, NVVFX_OUTPUT_IMAGE, NULL);
        }
        NvVFX_DestroyEffect(s->effect);
    }
    if (s->stream)
        NvVFX_CudaStreamDestroy(s->stream);

    NvCVImage_Dealloc(&s->dev_in);
    NvCVImage_Dealloc(&s->dev_out);
    /* host_in/host_out are NvCVImage_Init() wrappers (NVCV_CPU, no owned
     * allocation) around host_in_rgba/host_out_rgba - Dealloc on them would be a
     * no-op either way, but the real frees are these: */
    av_freep(&s->host_in_rgba);
    av_freep(&s->host_out_rgba);
}

#define OFFSET(x) offsetof(VsrContext, x)
#define VF AV_OPT_FLAG_FILTERING_PARAM|AV_OPT_FLAG_VIDEO_PARAM

static const AVOption vsr_options[] = {
    { "quality", "NVVFX_QUALITY_LEVEL (see docs.nvidia.com/maxine/vfx/latest/Filters/VideoSuperResolution.html)",
      OFFSET(quality), AV_OPT_TYPE_INT, { .i64 = 3 /* VSR_High, NVIDIA's own default recommendation */ },
      0, 23, VF, .unit = "quality" },
        { "bicubic",           NULL, 0, AV_OPT_TYPE_CONST, { .i64 = 0  }, 0, 0, VF, .unit = "quality" },
        { "low",                NULL, 0, AV_OPT_TYPE_CONST, { .i64 = 1  }, 0, 0, VF, .unit = "quality" },
        { "medium",             NULL, 0, AV_OPT_TYPE_CONST, { .i64 = 2  }, 0, 0, VF, .unit = "quality" },
        { "high",                NULL, 0, AV_OPT_TYPE_CONST, { .i64 = 3  }, 0, 0, VF, .unit = "quality" },
        { "ultra",               NULL, 0, AV_OPT_TYPE_CONST, { .i64 = 4  }, 0, 0, VF, .unit = "quality" },
        { "denoise_low",         NULL, 0, AV_OPT_TYPE_CONST, { .i64 = 8  }, 0, 0, VF, .unit = "quality" },
        { "denoise_medium",      NULL, 0, AV_OPT_TYPE_CONST, { .i64 = 9  }, 0, 0, VF, .unit = "quality" },
        { "denoise_high",        NULL, 0, AV_OPT_TYPE_CONST, { .i64 = 10 }, 0, 0, VF, .unit = "quality" },
        { "denoise_ultra",       NULL, 0, AV_OPT_TYPE_CONST, { .i64 = 11 }, 0, 0, VF, .unit = "quality" },
        { "deblur_low",          NULL, 0, AV_OPT_TYPE_CONST, { .i64 = 12 }, 0, 0, VF, .unit = "quality" },
        { "deblur_medium",       NULL, 0, AV_OPT_TYPE_CONST, { .i64 = 13 }, 0, 0, VF, .unit = "quality" },
        { "deblur_high",         NULL, 0, AV_OPT_TYPE_CONST, { .i64 = 14 }, 0, 0, VF, .unit = "quality" },
        { "deblur_ultra",        NULL, 0, AV_OPT_TYPE_CONST, { .i64 = 15 }, 0, 0, VF, .unit = "quality" },
        { "highbitrate_low",     NULL, 0, AV_OPT_TYPE_CONST, { .i64 = 16 }, 0, 0, VF, .unit = "quality" },
        { "highbitrate_medium",  NULL, 0, AV_OPT_TYPE_CONST, { .i64 = 17 }, 0, 0, VF, .unit = "quality" },
        { "highbitrate_high",    NULL, 0, AV_OPT_TYPE_CONST, { .i64 = 18 }, 0, 0, VF, .unit = "quality" },
        { "highbitrate_ultra",   NULL, 0, AV_OPT_TYPE_CONST, { .i64 = 19 }, 0, 0, VF, .unit = "quality" },
        /* 21/23: Ampere+ only, not enforced here - NvVFX_Load fails cleanly on Turing. */
        { "streaming_medium",    NULL, 0, AV_OPT_TYPE_CONST, { .i64 = 21 }, 0, 0, VF, .unit = "quality" },
        { "streaming_ultra",     NULL, 0, AV_OPT_TYPE_CONST, { .i64 = 23 }, 0, 0, VF, .unit = "quality" },
    { "models", "directory holding the nvvfxvideosuperres feature's model files, only needed if "
      "libnvidia-ngx-vsr.so does not bundle its own (no default; see VSR.md)",
      OFFSET(models_dir), AV_OPT_TYPE_STRING, { .str = NULL }, 0, 0, VF },
    { "device", "CUDA device index (NVVFX_GPU)", OFFSET(device_index), AV_OPT_TYPE_INT,
      { .i64 = 0 }, 0, 64, VF },
    { "w", "output width (0 = derive from scale)", OFFSET(out_w), AV_OPT_TYPE_INT,
      { .i64 = 0 }, 0, 7680, VF },
    { "h", "output height (0 = derive from scale)", OFFSET(out_h), AV_OPT_TYPE_INT,
      { .i64 = 0 }, 0, 4320, VF },
    { "scale", "scale factor when w/h are 0 (SDK supports 4/3, 1.5, 2, 3, 4)",
      OFFSET(scale), AV_OPT_TYPE_FLOAT, { .dbl = 2.0 }, 1.0, 4.0, VF },
    { NULL }
};

AVFILTER_DEFINE_CLASS(vsr);

static const AVFilterPad vsr_inputs[] = {
    {
        .name         = "default",
        .type         = AVMEDIA_TYPE_VIDEO,
        .filter_frame = filter_frame,
    },
};

static const AVFilterPad vsr_outputs[] = {
    {
        .name         = "default",
        .type         = AVMEDIA_TYPE_VIDEO,
        .config_props = config_output,
    },
};

const FFFilter ff_vf_vsr = {
    .p.name        = "vsr",
    .p.description = NULL_IF_CONFIG_SMALL("NVIDIA Maxine Video Super Resolution."),
    .p.priv_class  = &vsr_class,
    .p.flags       = AVFILTER_FLAG_SLICE_THREADS,
    .priv_size     = sizeof(VsrContext),
    .uninit        = uninit,
    FILTER_INPUTS(vsr_inputs),
    FILTER_OUTPUTS(vsr_outputs),
    FILTER_PIXFMTS_ARRAY(pixel_fmts),
};
