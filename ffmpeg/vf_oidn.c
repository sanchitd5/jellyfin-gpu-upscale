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
 * Denoise video frames with Intel Open Image Denoise (OIDN), RT filter.
 *
 * OIDN is a library, not a filter: it has no ffmpeg integration upstream.
 * This wraps its C API.  Frames arrive as planar float RGB (gbrpf32le),
 * are packed into the interleaved RGB float buffer OIDN's FLOAT3 format
 * wants, denoised, and unpacked again.  The pack/unpack passes are slice
 * threaded; the denoise itself runs on whichever OIDN device was selected
 * (CUDA by default where present, else CPU).
 *
 * Buffers are host memory, so the CUDA device pays a host<->device copy per
 * frame.  That is inherent: OIDN 2.x has no Vulkan backend, so a filter that
 * lives in an ffmpeg graph cannot be handed device-resident Vulkan frames.
 */

#include <float.h>

#include "libavutil/mem.h"
#include "libavutil/opt.h"
#include "libavutil/pixdesc.h"
#include "avfilter.h"
#include "filters.h"
#include "video.h"

#include <OpenImageDenoise/oidn.h>

typedef struct OIDNContext {
    const AVClass *class;

    int   quality;
    int   srgb;
    int   hdr;
    int   device_type;
    float input_scale;

    OIDNDevice device;
    OIDNFilter filter;

    /* OIDN-owned buffers where the device allows it: on a CUDA device a MANAGED buffer is
     * host-addressable and saves an explicit host->device copy per frame, which measured
     * several times faster than handing OIDN plain host memory.  Falls back to host storage. */
    OIDNBuffer color_buf;
    OIDNBuffer output_buf;

    float *color;   /* interleaved RGB in  */
    float *output;  /* interleaved RGB out */
    int    w, h;
} OIDNContext;

typedef struct ThreadData {
    AVFrame *in, *out;
} ThreadData;

static const enum AVPixelFormat pixel_fmts[] = {
    AV_PIX_FMT_GBRPF32LE,
    AV_PIX_FMT_NONE
};

/* gbrpf32le: plane 0 = G, plane 1 = B, plane 2 = R */
static int pack_slice(AVFilterContext *ctx, void *arg, int jobnr, int nb_jobs)
{
    OIDNContext *s = ctx->priv;
    ThreadData *td = arg;
    const int h0 = (s->h * jobnr) / nb_jobs;
    const int h1 = (s->h * (jobnr + 1)) / nb_jobs;

    for (int y = h0; y < h1; y++) {
        const float *g = (const float *)(td->in->data[0] + y * td->in->linesize[0]);
        const float *b = (const float *)(td->in->data[1] + y * td->in->linesize[1]);
        const float *r = (const float *)(td->in->data[2] + y * td->in->linesize[2]);
        float *dst = s->color + (size_t)y * s->w * 3;

        for (int x = 0; x < s->w; x++) {
            dst[3 * x + 0] = r[x];
            dst[3 * x + 1] = g[x];
            dst[3 * x + 2] = b[x];
        }
    }
    return 0;
}

static int unpack_slice(AVFilterContext *ctx, void *arg, int jobnr, int nb_jobs)
{
    OIDNContext *s = ctx->priv;
    ThreadData *td = arg;
    const int h0 = (s->h * jobnr) / nb_jobs;
    const int h1 = (s->h * (jobnr + 1)) / nb_jobs;

    for (int y = h0; y < h1; y++) {
        float *g = (float *)(td->out->data[0] + y * td->out->linesize[0]);
        float *b = (float *)(td->out->data[1] + y * td->out->linesize[1]);
        float *r = (float *)(td->out->data[2] + y * td->out->linesize[2]);
        const float *src = s->output + (size_t)y * s->w * 3;

        for (int x = 0; x < s->w; x++) {
            r[x] = src[3 * x + 0];
            g[x] = src[3 * x + 1];
            b[x] = src[3 * x + 2];
        }
    }
    return 0;
}

static int check_error(AVFilterContext *ctx)
{
    OIDNContext *s = ctx->priv;
    const char *msg = NULL;

    if (oidnGetDeviceError(s->device, &msg) != OIDN_ERROR_NONE) {
        av_log(ctx, AV_LOG_ERROR, "OIDN: %s\n", msg ? msg : "unknown error");
        return AVERROR_EXTERNAL;
    }
    return 0;
}

static int config_input(AVFilterLink *inlink)
{
    AVFilterContext *ctx = inlink->dst;
    OIDNContext *s = ctx->priv;
    const size_t npix = (size_t)inlink->w * inlink->h;
    const char *name = NULL;
    int ret;

    s->w = inlink->w;
    s->h = inlink->h;

    s->device = oidnNewDevice(s->device_type);
    if (!s->device && s->device_type != OIDN_DEVICE_TYPE_CPU) {
        av_log(ctx, AV_LOG_WARNING, "OIDN device unavailable, falling back to CPU\n");
        s->device = oidnNewDevice(OIDN_DEVICE_TYPE_CPU);
    }
    if (!s->device) {
        av_log(ctx, AV_LOG_ERROR, "could not create an OIDN device\n");
        return AVERROR_EXTERNAL;
    }
    oidnCommitDevice(s->device);
    if ((ret = check_error(ctx)) < 0)
        return ret;

    s->filter = oidnNewFilter(s->device, "RT");
    if (!s->filter)
        return AVERROR_EXTERNAL;

    s->color_buf  = oidnNewBufferWithStorage(s->device, npix * 3 * sizeof(float), OIDN_STORAGE_MANAGED);
    s->output_buf = oidnNewBufferWithStorage(s->device, npix * 3 * sizeof(float), OIDN_STORAGE_MANAGED);
    if (s->color_buf && s->output_buf) {
        s->color  = oidnGetBufferData(s->color_buf);
        s->output = oidnGetBufferData(s->output_buf);
    }

    if (s->color && s->output) {
        oidnSetFilterImage(s->filter, "color",  s->color_buf,
                           OIDN_FORMAT_FLOAT3, s->w, s->h, 0, 0, 0);
        oidnSetFilterImage(s->filter, "output", s->output_buf,
                           OIDN_FORMAT_FLOAT3, s->w, s->h, 0, 0, 0);
    } else {
        /* No managed storage on this device: plain host memory still works, it just makes
         * OIDN copy every frame across on its own. */
        oidnReleaseBuffer(s->color_buf);
        oidnReleaseBuffer(s->output_buf);
        s->color_buf = s->output_buf = NULL;
        s->color  = av_malloc_array(npix * 3, sizeof(float));
        s->output = av_malloc_array(npix * 3, sizeof(float));
        if (!s->color || !s->output)
            return AVERROR(ENOMEM);
        oidnSetSharedFilterImage(s->filter, "color",  s->color,
                                 OIDN_FORMAT_FLOAT3, s->w, s->h, 0, 0, 0);
        oidnSetSharedFilterImage(s->filter, "output", s->output,
                                 OIDN_FORMAT_FLOAT3, s->w, s->h, 0, 0, 0);
    }
    oidnSetFilterBool(s->filter, "hdr",  s->hdr);
    oidnSetFilterBool(s->filter, "srgb", s->hdr ? 0 : s->srgb);
    oidnSetFilterInt(s->filter, "quality", s->quality);
    if (s->input_scale > 0.f)
        oidnSetFilterFloat(s->filter, "inputScale", s->input_scale);
    oidnCommitFilter(s->filter);
    if ((ret = check_error(ctx)) < 0)
        return ret;

    switch (s->device_type) {
    case OIDN_DEVICE_TYPE_CPU:  name = "cpu";  break;
    case OIDN_DEVICE_TYPE_CUDA: name = "cuda"; break;
    default:                    name = "default"; break;
    }
    av_log(ctx, AV_LOG_VERBOSE, "OIDN RT %dx%d device=%s quality=%d srgb=%d hdr=%d\n",
           s->w, s->h, name, s->quality, s->hdr ? 0 : s->srgb, s->hdr);
    return 0;
}

static int filter_frame(AVFilterLink *inlink, AVFrame *in)
{
    AVFilterContext *ctx = inlink->dst;
    AVFilterLink *outlink = ctx->outputs[0];
    OIDNContext *s = ctx->priv;
    const int nb_jobs = FFMIN(s->h, ff_filter_get_nb_threads(ctx));
    ThreadData td;
    AVFrame *out;
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

    oidnExecuteFilter(s->filter);
    if ((ret = check_error(ctx)) < 0)
        goto fail;

    if ((ret = ff_filter_execute(ctx, unpack_slice, &td, NULL, nb_jobs)) < 0)
        goto fail;

    if (out != in)
        av_frame_free(&in);
    return ff_filter_frame(outlink, out);

fail:
    if (out != in)
        av_frame_free(&out);
    av_frame_free(&in);
    return ret;
}

static av_cold void uninit(AVFilterContext *ctx)
{
    OIDNContext *s = ctx->priv;

    if (s->filter)
        oidnReleaseFilter(s->filter);
    if (s->color_buf || s->output_buf) {
        /* the buffers own the memory in this case */
        s->color = s->output = NULL;
        oidnReleaseBuffer(s->color_buf);
        oidnReleaseBuffer(s->output_buf);
    } else {
        av_freep(&s->color);
        av_freep(&s->output);
    }
    if (s->device)
        oidnReleaseDevice(s->device);
}

#define OFFSET(x) offsetof(OIDNContext, x)
#define VF AV_OPT_FLAG_FILTERING_PARAM|AV_OPT_FLAG_VIDEO_PARAM

static const AVOption oidn_options[] = {
    { "quality", "denoising quality preset", OFFSET(quality), AV_OPT_TYPE_INT,
      { .i64 = OIDN_QUALITY_HIGH }, OIDN_QUALITY_FAST, OIDN_QUALITY_HIGH, VF, .unit = "quality" },
        { "fast",     "high performance",           0, AV_OPT_TYPE_CONST, { .i64 = OIDN_QUALITY_FAST     }, 0, 0, VF, .unit = "quality" },
        { "balanced", "balanced quality/speed",     0, AV_OPT_TYPE_CONST, { .i64 = OIDN_QUALITY_BALANCED }, 0, 0, VF, .unit = "quality" },
        { "high",     "highest quality",            0, AV_OPT_TYPE_CONST, { .i64 = OIDN_QUALITY_HIGH     }, 0, 0, VF, .unit = "quality" },
    { "srgb", "input is sRGB encoded", OFFSET(srgb), AV_OPT_TYPE_BOOL,
      { .i64 = 0 }, 0, 1, VF },
    { "hdr", "input is linear HDR", OFFSET(hdr), AV_OPT_TYPE_BOOL,
      { .i64 = 0 }, 0, 1, VF },
    { "input_scale", "HDR input scale, 0 for auto", OFFSET(input_scale), AV_OPT_TYPE_FLOAT,
      { .dbl = 0 }, 0, FLT_MAX, VF },
    { "device", "OIDN device to run on", OFFSET(device_type), AV_OPT_TYPE_INT,
      { .i64 = OIDN_DEVICE_TYPE_DEFAULT }, OIDN_DEVICE_TYPE_DEFAULT, OIDN_DEVICE_TYPE_METAL, VF, .unit = "device" },
        { "default", "best available device", 0, AV_OPT_TYPE_CONST, { .i64 = OIDN_DEVICE_TYPE_DEFAULT }, 0, 0, VF, .unit = "device" },
        { "cpu",     "CPU device",            0, AV_OPT_TYPE_CONST, { .i64 = OIDN_DEVICE_TYPE_CPU     }, 0, 0, VF, .unit = "device" },
        { "cuda",    "CUDA device",           0, AV_OPT_TYPE_CONST, { .i64 = OIDN_DEVICE_TYPE_CUDA    }, 0, 0, VF, .unit = "device" },
    { NULL }
};

AVFILTER_DEFINE_CLASS(oidn);

static const AVFilterPad oidn_inputs[] = {
    {
        .name         = "default",
        .type         = AVMEDIA_TYPE_VIDEO,
        .filter_frame = filter_frame,
        .config_props = config_input,
    },
};

const FFFilter ff_vf_oidn = {
    .p.name        = "oidn",
    .p.description = NULL_IF_CONFIG_SMALL("Denoise frames with Intel Open Image Denoise."),
    .p.priv_class  = &oidn_class,
    .p.flags       = AVFILTER_FLAG_SUPPORT_TIMELINE_GENERIC | AVFILTER_FLAG_SLICE_THREADS,
    .priv_size     = sizeof(OIDNContext),
    .uninit        = uninit,
    FILTER_INPUTS(oidn_inputs),
    FILTER_OUTPUTS(ff_video_default_filterpad),
    FILTER_PIXFMTS_ARRAY(pixel_fmts),
};
