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
 * Run a super-resolution ONNX model over video frames with ONNX Runtime.
 *
 * FFmpeg's own DNN module (libavfilter/dnn) speaks TensorFlow, OpenVINO and
 * libtorch, and none of those is a good fit for an NVIDIA box that has a
 * display driver but no CUDA toolkit.  Rather than add a fourth backend to
 * that module - which would also mean teaching vf_sr about 3-channel RGB
 * models - this is a standalone filter in the style of vf_oidn, wrapping the
 * ONNX Runtime C API directly.
 *
 * Frames arrive as planar float RGB (gbrpf32le).  They are repacked into the
 * NCHW float layout the model wants, run, clamped to [0,1] (residual SR nets
 * overshoot), and written back out at scale times the input size.  The scale
 * factor is not advertised anywhere in an ONNX graph, so it is discovered at
 * configure time by running one small probe frame through the session.
 *
 * Inference is synchronous and one frame at a time: these are small models and
 * the queueing machinery would buy nothing.  Pack and unpack are slice threaded.
 */

#include "libavutil/mem.h"
#include "libavutil/opt.h"
#include "libavutil/pixdesc.h"
#include "avfilter.h"
#include "filters.h"
#include "video.h"

#include <onnxruntime_c_api.h>

typedef struct ORTContext {
    const AVClass *class;

    char *model;
    int   device;        /* 0 = cuda, 1 = cpu */
    int   device_id;
    int   scale;         /* 0 = probe the model */
    int   fp16;
    int   threads;

    const OrtApi   *ort;
    OrtEnv         *env;
    OrtSessionOptions *opts;
    OrtSession     *session;
    OrtMemoryInfo  *meminfo;
    OrtAllocator   *alloc;

    char *in_name;
    char *out_name;

    float *in_buf;       /* NCHW RGB, in_w * in_h * 3 */
    int    in_w, in_h;
    int    out_w, out_h;

    const float *out_data;  /* borrowed from the output OrtValue for the unpack pass */
} ORTContext;

typedef struct ThreadData {
    AVFrame *in, *out;
} ThreadData;

static const enum AVPixelFormat pixel_fmts[] = {
    AV_PIX_FMT_GBRPF32LE,
    AV_PIX_FMT_NONE
};

#define ORT_CHECK(ctx, expr) do {                                              \
    OrtStatus *st_ = (expr);                                                   \
    if (st_) {                                                                 \
        ORTContext *s_ = (ctx)->priv;                                          \
        av_log(ctx, AV_LOG_ERROR, "onnxruntime: %s\n",                         \
               s_->ort->GetErrorMessage(st_));                                 \
        s_->ort->ReleaseStatus(st_);                                           \
        return AVERROR_EXTERNAL;                                               \
    }                                                                          \
} while (0)

/* gbrpf32le: plane 0 = G, plane 1 = B, plane 2 = R.  Model wants planar RGB. */
static int pack_slice(AVFilterContext *ctx, void *arg, int jobnr, int nb_jobs)
{
    ORTContext *s = ctx->priv;
    ThreadData *td = arg;
    const int h0 = (s->in_h * jobnr) / nb_jobs;
    const int h1 = (s->in_h * (jobnr + 1)) / nb_jobs;
    const size_t plane = (size_t)s->in_w * s->in_h;
    /* source plane index for destination channel R,G,B */
    static const int src_of[3] = { 2, 0, 1 };

    for (int c = 0; c < 3; c++) {
        const int p = src_of[c];
        for (int y = h0; y < h1; y++) {
            const float *src = (const float *)(td->in->data[p] + (ptrdiff_t)y * td->in->linesize[p]);
            float *dst = s->in_buf + c * plane + (size_t)y * s->in_w;
            memcpy(dst, src, (size_t)s->in_w * sizeof(float));
        }
    }
    return 0;
}

static int unpack_slice(AVFilterContext *ctx, void *arg, int jobnr, int nb_jobs)
{
    ORTContext *s = ctx->priv;
    ThreadData *td = arg;
    const int h0 = (s->out_h * jobnr) / nb_jobs;
    const int h1 = (s->out_h * (jobnr + 1)) / nb_jobs;
    const size_t plane = (size_t)s->out_w * s->out_h;
    static const int dst_of[3] = { 2, 0, 1 };

    for (int c = 0; c < 3; c++) {
        const int p = dst_of[c];
        for (int y = h0; y < h1; y++) {
            const float *src = s->out_data + c * plane + (size_t)y * s->out_w;
            float *dst = (float *)(td->out->data[p] + (ptrdiff_t)y * td->out->linesize[p]);
            for (int x = 0; x < s->out_w; x++) {
                float v = src[x];
                dst[x] = v < 0.f ? 0.f : (v > 1.f ? 1.f : v);
            }
        }
    }
    return 0;
}

/* Run one frame.  in_buf must already hold the packed input. */
static int run_session(AVFilterContext *ctx, int w, int h,
                       OrtValue **out_value, int64_t out_shape[4])
{
    ORTContext *s = ctx->priv;
    const OrtApi *ort = s->ort;
    int64_t shape[4] = { 1, 3, h, w };
    OrtValue *input = NULL;
    OrtTensorTypeAndShapeInfo *info = NULL;
    size_t ndim = 0;

    ORT_CHECK(ctx, ort->CreateTensorWithDataAsOrtValue(
        s->meminfo, s->in_buf, (size_t)w * h * 3 * sizeof(float),
        shape, 4, ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &input));

    {
        OrtStatus *st = ort->Run(s->session, NULL,
                                 (const char *const *)&s->in_name, (const OrtValue *const *)&input, 1,
                                 (const char *const *)&s->out_name, 1, out_value);
        ort->ReleaseValue(input);
        if (st) {
            av_log(ctx, AV_LOG_ERROR, "onnxruntime run: %s\n", ort->GetErrorMessage(st));
            ort->ReleaseStatus(st);
            return AVERROR_EXTERNAL;
        }
    }

    ORT_CHECK(ctx, ort->GetTensorTypeAndShape(*out_value, &info));
    {
        ONNXTensorElementDataType etype = ONNX_TENSOR_ELEMENT_DATA_TYPE_UNDEFINED;
        OrtStatus *st = ort->GetDimensionsCount(info, &ndim);
        if (!st && ndim == 4)
            st = ort->GetDimensions(info, out_shape, 4);
        if (!st)
            st = ort->GetTensorElementType(info, &etype);
        ort->ReleaseTensorTypeAndShapeInfo(info);
        if (st || ndim != 4) {
            if (st) ort->ReleaseStatus(st);
            av_log(ctx, AV_LOG_ERROR, "model output is not a 4-D NCHW tensor\n");
            return AVERROR(EINVAL);
        }
        /* Both callers read the tensor as float32 and size the read from the shape
         * alone, so a float16 export would be read to twice its length.  Checked
         * here rather than at each caller because that read is what crashes. */
        if (etype != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT) {
            av_log(ctx, AV_LOG_ERROR, "model output element type %d is not float32 "
                   "(ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT); re-export the model in "
                   "float32\n", (int)etype);
            return AVERROR(EINVAL);
        }
    }
    return 0;
}

static av_cold int init_session(AVFilterContext *ctx)
{
    ORTContext *s = ctx->priv;
    const OrtApi *ort;
    size_t n_in = 0, n_out = 0;

    s->ort = ort = OrtGetApiBase()->GetApi(ORT_API_VERSION);
    if (!ort) {
        av_log(ctx, AV_LOG_ERROR, "ONNX Runtime does not support API version %d\n", ORT_API_VERSION);
        return AVERROR_EXTERNAL;
    }
    if (!s->model || !*s->model) {
        av_log(ctx, AV_LOG_ERROR, "no model= given\n");
        return AVERROR(EINVAL);
    }

    ORT_CHECK(ctx, ort->CreateEnv(ORT_LOGGING_LEVEL_WARNING, "ffmpeg_ort", &s->env));
    ORT_CHECK(ctx, ort->CreateSessionOptions(&s->opts));
    ORT_CHECK(ctx, ort->SetSessionGraphOptimizationLevel(s->opts, ORT_ENABLE_ALL));
    /* Always set this explicitly.  Left at the default, ONNX Runtime spawns one thread per
     * core and pins each one, which fails noisily inside an LXC container with a restricted
     * cpuset.  Inference runs on the GPU anyway; the CPU provider is a degraded fallback. */
    ORT_CHECK(ctx, ort->SetIntraOpNumThreads(s->opts, s->threads > 0 ? s->threads : 1));
    ORT_CHECK(ctx, ort->SetInterOpNumThreads(s->opts, 1));

    if (s->device == 0) {
        OrtCUDAProviderOptionsV2 *cuda = NULL;
        OrtStatus *st = ort->CreateCUDAProviderOptions(&cuda);
        if (!st) {
            char idbuf[16];
            const char *keys[] = { "device_id" };
            const char *vals[] = { idbuf };
            snprintf(idbuf, sizeof(idbuf), "%d", s->device_id);
            st = ort->UpdateCUDAProviderOptions(cuda, keys, vals, 1);
            if (!st)
                st = ort->SessionOptionsAppendExecutionProvider_CUDA_V2(s->opts, cuda);
            ort->ReleaseCUDAProviderOptions(cuda);
        }
        if (st) {
            /* Same contract as vf_oidn: warn and run on the CPU rather than fail the session. */
            av_log(ctx, AV_LOG_WARNING, "CUDA execution provider unavailable (%s), using CPU\n",
                   ort->GetErrorMessage(st));
            ort->ReleaseStatus(st);
        }
    }

    ORT_CHECK(ctx, ort->CreateSession(s->env, s->model, s->opts, &s->session));
    ORT_CHECK(ctx, ort->GetAllocatorWithDefaultOptions(&s->alloc));
    ORT_CHECK(ctx, ort->SessionGetInputCount(s->session, &n_in));
    ORT_CHECK(ctx, ort->SessionGetOutputCount(s->session, &n_out));
    if (n_in != 1 || n_out != 1) {
        av_log(ctx, AV_LOG_ERROR, "model must have exactly one input and one output "
                                  "(has %zu/%zu)\n", n_in, n_out);
        return AVERROR(EINVAL);
    }
    ORT_CHECK(ctx, ort->SessionGetInputName(s->session, 0, s->alloc, &s->in_name));
    ORT_CHECK(ctx, ort->SessionGetOutputName(s->session, 0, s->alloc, &s->out_name));
    ORT_CHECK(ctx, ort->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &s->meminfo));
    return 0;
}

static int config_input(AVFilterLink *inlink)
{
    AVFilterContext *ctx = inlink->dst;
    ORTContext *s = ctx->priv;
    int ret;

    if (!s->session && (ret = init_session(ctx)) < 0)
        return ret;

    s->in_w = inlink->w;
    s->in_h = inlink->h;

    if (s->scale <= 0) {
        /* Nothing in an ONNX graph states the scale factor of a super-resolution
         * model: it is implicit in a PixelShuffle or a Resize.  Ask the model. */
        const int pw = 32, ph = 32;
        int64_t oshape[4] = { 0, 0, 0, 0 };
        OrtValue *ov = NULL;
        float *save = s->in_buf;
        int sw = s->in_w, sh = s->in_h;

        s->in_buf = av_calloc((size_t)pw * ph * 3, sizeof(float));
        if (!s->in_buf) { s->in_buf = save; return AVERROR(ENOMEM); }
        s->in_w = pw; s->in_h = ph;
        ret = run_session(ctx, pw, ph, &ov, oshape);
        av_freep(&s->in_buf);
        s->in_buf = save; s->in_w = sw; s->in_h = sh;
        /* run_session can fail after Run() has already handed back a tensor -
         * the shape queries come after it - so ov may be live on the error
         * path too. */
        if (ret < 0) {
            if (ov)
                s->ort->ReleaseValue(ov);
            return ret;
        }
        if (oshape[1] != 3 || oshape[2] % ph || oshape[3] % pw ||
            oshape[2] / ph != oshape[3] / pw || oshape[2] / ph < 1) {
            s->ort->ReleaseValue(ov);
            av_log(ctx, AV_LOG_ERROR, "probe gave %"PRId64"x%"PRId64"x%"PRId64", not an integer "
                   "square scale of %dx%d RGB; set scale= explicitly\n",
                   oshape[1], oshape[3], oshape[2], pw, ph);
            return AVERROR(EINVAL);
        }
        s->scale = (int)(oshape[2] / ph);
        s->ort->ReleaseValue(ov);
        /* A fixed-output-size model answers the probe with its own size, not a ratio,
         * and the frame allocations below would follow it to gigabytes.  Cap where the
         * scale= option caps. */
        if (s->scale > 8) {
            av_log(ctx, AV_LOG_ERROR, "probe gave scale x%d, above the maximum of 8; "
                   "a fixed-output-size model cannot be probed, set scale= explicitly\n",
                   s->scale);
            s->scale = 0;
            return AVERROR(EINVAL);
        }
    }

    s->out_w = s->in_w * s->scale;
    s->out_h = s->in_h * s->scale;

    av_freep(&s->in_buf);
    s->in_buf = av_calloc((size_t)s->in_w * s->in_h * 3, sizeof(float));
    if (!s->in_buf)
        return AVERROR(ENOMEM);

    av_log(ctx, AV_LOG_VERBOSE, "onnxruntime %s: %s, %dx%d -> %dx%d (x%d), device=%s\n",
           OrtGetApiBase()->GetVersionString(), s->model,
           s->in_w, s->in_h, s->out_w, s->out_h, s->scale,
           s->device == 0 ? "cuda" : "cpu");
    return 0;
}

static int config_output(AVFilterLink *outlink)
{
    AVFilterContext *ctx = outlink->src;
    ORTContext *s = ctx->priv;

    outlink->w = s->out_w;
    outlink->h = s->out_h;
    return 0;
}

static int filter_frame(AVFilterLink *inlink, AVFrame *in)
{
    AVFilterContext *ctx = inlink->dst;
    AVFilterLink *outlink = ctx->outputs[0];
    ORTContext *s = ctx->priv;
    const int nb_jobs = FFMIN(s->out_h, ff_filter_get_nb_threads(ctx));
    int64_t oshape[4] = { 0, 0, 0, 0 };
    OrtValue *ov = NULL;
    ThreadData td;
    AVFrame *out;
    int ret;

    out = ff_get_video_buffer(outlink, outlink->w, outlink->h);
    if (!out) {
        av_frame_free(&in);
        return AVERROR(ENOMEM);
    }
    av_frame_copy_props(out, in);
    out->width  = outlink->w;
    out->height = outlink->h;

    td.in = in; td.out = out;

    if ((ret = ff_filter_execute(ctx, pack_slice, &td, NULL,
                                 FFMIN(s->in_h, ff_filter_get_nb_threads(ctx)))) < 0)
        goto fail;

    if ((ret = run_session(ctx, s->in_w, s->in_h, &ov, oshape)) < 0)
        goto fail;

    if (oshape[1] != 3 || oshape[2] != s->out_h || oshape[3] != s->out_w) {
        av_log(ctx, AV_LOG_ERROR, "model returned %"PRId64"x%"PRId64"x%"PRId64", expected "
               "3x%dx%d\n", oshape[1], oshape[3], oshape[2], s->out_h, s->out_w);
        ret = AVERROR(EINVAL);
        goto fail;
    }

    {
        float *data = NULL;
        OrtStatus *st = s->ort->GetTensorMutableData(ov, (void **)&data);
        if (st) {
            av_log(ctx, AV_LOG_ERROR, "onnxruntime: %s\n", s->ort->GetErrorMessage(st));
            s->ort->ReleaseStatus(st);
            ret = AVERROR_EXTERNAL;
            goto fail;
        }
        s->out_data = data;
    }

    ret = ff_filter_execute(ctx, unpack_slice, &td, NULL, nb_jobs);
    s->out_data = NULL;
    s->ort->ReleaseValue(ov);
    ov = NULL;
    if (ret < 0)
        goto fail;

    av_frame_free(&in);
    return ff_filter_frame(outlink, out);

fail:
    if (ov)
        s->ort->ReleaseValue(ov);
    av_frame_free(&out);
    av_frame_free(&in);
    return ret;
}

static av_cold void uninit(AVFilterContext *ctx)
{
    ORTContext *s = ctx->priv;

    if (!s->ort)
        return;
    if (s->in_name && s->alloc)
        s->alloc->Free(s->alloc, s->in_name);
    if (s->out_name && s->alloc)
        s->alloc->Free(s->alloc, s->out_name);
    s->in_name = s->out_name = NULL;
    if (s->meminfo)
        s->ort->ReleaseMemoryInfo(s->meminfo);
    if (s->session)
        s->ort->ReleaseSession(s->session);
    if (s->opts)
        s->ort->ReleaseSessionOptions(s->opts);
    if (s->env)
        s->ort->ReleaseEnv(s->env);
    av_freep(&s->in_buf);
}

#define OFFSET(x) offsetof(ORTContext, x)
#define VF AV_OPT_FLAG_FILTERING_PARAM|AV_OPT_FLAG_VIDEO_PARAM

static const AVOption ort_options[] = {
    { "model", "path to the .onnx model", OFFSET(model), AV_OPT_TYPE_STRING,
      { .str = NULL }, 0, 0, VF },
    { "device", "execution provider", OFFSET(device), AV_OPT_TYPE_INT,
      { .i64 = 0 }, 0, 1, VF, .unit = "device" },
        { "cuda", "CUDA execution provider", 0, AV_OPT_TYPE_CONST, { .i64 = 0 }, 0, 0, VF, .unit = "device" },
        { "cpu",  "CPU execution provider",  0, AV_OPT_TYPE_CONST, { .i64 = 1 }, 0, 0, VF, .unit = "device" },
    { "device_id", "CUDA device index", OFFSET(device_id), AV_OPT_TYPE_INT,
      { .i64 = 0 }, 0, 15, VF },
    { "scale", "output scale factor, 0 to probe the model", OFFSET(scale), AV_OPT_TYPE_INT,
      { .i64 = 0 }, 0, 8, VF },
    { "threads", "intra-op threads, only meaningful for the CPU provider", OFFSET(threads),
      AV_OPT_TYPE_INT, { .i64 = 0 }, 0, 64, VF },
    { NULL }
};

AVFILTER_DEFINE_CLASS(ort);

static const AVFilterPad ort_inputs[] = {
    {
        .name         = "default",
        .type         = AVMEDIA_TYPE_VIDEO,
        .filter_frame = filter_frame,
        .config_props = config_input,
    },
};

static const AVFilterPad ort_outputs[] = {
    {
        .name         = "default",
        .type         = AVMEDIA_TYPE_VIDEO,
        .config_props = config_output,
    },
};

const FFFilter ff_vf_ort = {
    .p.name        = "ort",
    .p.description = NULL_IF_CONFIG_SMALL("Run a super-resolution ONNX model with ONNX Runtime."),
    .p.priv_class  = &ort_class,
    .p.flags       = AVFILTER_FLAG_SLICE_THREADS,
    .priv_size     = sizeof(ORTContext),
    .uninit        = uninit,
    FILTER_INPUTS(ort_inputs),
    FILTER_OUTPUTS(ort_outputs),
    FILTER_PIXFMTS_ARRAY(pixel_fmts),
};
