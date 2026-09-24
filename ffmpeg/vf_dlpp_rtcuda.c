/*
 * dlpp_rtcuda: RTX DLPP super-resolution (nvdlppx.dll) hosted live via our own PE loader, on
 * FFmpeg's own CUDA context and stream:
 *   CUDA frame (any NVDEC sw_format) -> semiplanar_to_rgba/planar444_to_rgba -> RGBA8 surface
 *   -> DLPP Process -> RGBA8 surface -> rgba_to_nv12 -> NV12 CUDA frame.
 * No host copies per frame (GPU-resident, verified at 10,790 real frames -- see TASK.md
 * "Track B: DLPP").
 *
 * NAME: this is Route A of Track B (see TASK.md and .agent-briefs/dlpp-promote-to-production.md)
 * -- a reverse-engineered Windows DLL hosted live at runtime through a custom PE loader.
 * `ffmpeg-patches/0006` reserves the filter name `dlpp_drv_cuda` for a DIFFERENT, unrelated
 * Route B implementation (capture + codegen against a driver-side DLPP entry point). This
 * filter must never collide with that name, hence `dlpp_rtcuda` -- "runtime-hosted", the
 * counterpart to this project's existing `_drv_` naming for the driver-DLL-via-shared-core
 * pattern (`vsr_drv_cuda`, `dlpp_drv_cuda`).
 *
 * Architecturally different from this repo's other five shipped filters (vf_oidn.c,
 * vf_optix.c, vf_ort.c, vf_fsr2.c, vf_dlss.c): those link NVIDIA's official SDKs at compile
 * time. This one maps a user-supplied, reverse-engineered Windows DLL through gu_dlpp_pe_map.c
 * (our own from-scratch PE32+ loader, no NVIDIA material) and calls into it directly. No
 * NVIDIA binary, header or SDK is linked, vendored, or required to build this file -- only at
 * run time does it dlopen()-equivalent-map a DLL the user places themselves. See RTXDLPP.md
 * for exactly what that DLL is, where it comes from, and the licence note.
 *
 * Promoted from the `rtx-video-re` spike's `vf_dlpp_spike.c` (which itself started as
 * `vf_aivp_spike.c` adapted for nvdlppx.dll instead of nvaivpx.dll): renamed, moved into this
 * repo's ffmpeg/ tree, and given an init-time self-test gate this spike did not have (see
 * config_props below and gu_dlpp_embed_selftest()). The two harness bugs already fixed as
 * gu_dlpp_embed's own unconditional defaults (wipe=0.0, native-scale field for level>=3) are
 * unchanged from the spike.
 *
 * Options: dll, level (quality 1-4, default 1: most-validated, simplest -- no native-scale-
 * buffer complication), w, h (default 2x), inject=<raw w*h*4 RGBA file> (test harness only,
 * replaces the decoded picture), dump=<ppm>, dump_frame=N.
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
#include <stdio.h>

#include "libavutil/hwcontext.h"
#include "libavutil/hwcontext_cuda_internal.h"
#include "libavutil/cuda_check.h"
#include "libavutil/mem.h"
#include "libavutil/opt.h"
#include "libavutil/pixdesc.h"

#include "avfilter.h"
#include "filters.h"
#include "video.h"

#include "gu_dlpp_embed.h"
#include "gu_dlpp_nv12_rgba_ptx.h"   /* generated at build time from gu_dlpp_nv12_rgba.cu (real
                                      * CUDA C, compiled to PTX with clang's NVPTX backend -- not
                                      * NVIDIA material, not extracted from any SDK). semiplanar_to_rgba
                                      * covers every NVDEC sw_format except yuv444p*
                                      * (nv12/nv16/p010le/p012le/p016le/p210le/p212le/p216le, all
                                      * Y-plane-plus-interleaved-chroma, parametrized by sample
                                      * width and chroma vertical subsampling); planar444_to_rgba
                                      * handles the yuv444p family's three separate planes. */

typedef struct DLPPRtCudaContext {
    const AVClass *class;
    char *dll, *inject, *dump;
    int level, ow, oh, dump_frame;

    AVCUDADeviceContext *hwctx;
    AVBufferRef *out_frames;
    CUmodule mod;
    CUfunction k_in_semi, k_in_planar444, k_out;
    uint64_t in_surf, out_surf;
    int64_t nframes;
    uint64_t cb0[19];
    /* Input format classification (see classify_nvdec_format below). */
    int is_planar444;
    int word_bytes;
    int chroma_vshift;
} DLPPRtCudaContext;

#define CHECK_CU(x) FF_CUDA_CHECK_DL(ctx, s->hwctx->internal->cuda_dl, x)

/* Classifies an AV_PIX_FMT_CUDA frame's sw_format for the generalized semiplanar_to_rgba /
 * planar444_to_rgba kernels. FFmpeg's own libavcodec/nvdec.c (ff_nvdec_get_format) fixes the
 * complete, exhaustive set of formats -hwaccel_output_format cuda can ever produce: a switch
 * on decoded bit depth (8/10/12/16) x chroma layout (4:2:0/4:2:2/4:4:4). Every format below is
 * accepted; anything else (e.g. a future NVDEC output format, or a filter fed something that
 * never went through NVDEC at all) is rejected here with ENOSYS rather than misread. */
static int classify_nvdec_format(enum AVPixelFormat fmt, int *is_planar444,
                                  int *word_bytes, int *chroma_vshift)
{
    switch (fmt) {
    case AV_PIX_FMT_NV12:
        *is_planar444 = 0; *word_bytes = 1; *chroma_vshift = 1; return 0;
    case AV_PIX_FMT_NV16:
        *is_planar444 = 0; *word_bytes = 1; *chroma_vshift = 0; return 0;
    case AV_PIX_FMT_P010LE:
    case AV_PIX_FMT_P012LE:
    case AV_PIX_FMT_P016LE:
        *is_planar444 = 0; *word_bytes = 2; *chroma_vshift = 1; return 0;
    case AV_PIX_FMT_P210LE:
    case AV_PIX_FMT_P212LE:
    case AV_PIX_FMT_P216LE:
        *is_planar444 = 0; *word_bytes = 2; *chroma_vshift = 0; return 0;
    case AV_PIX_FMT_YUV444P:
        *is_planar444 = 1; *word_bytes = 1; *chroma_vshift = 0; return 0;
    case AV_PIX_FMT_YUV444P10MSBLE:
    case AV_PIX_FMT_YUV444P12MSBLE:
    case AV_PIX_FMT_YUV444P16LE:
        *is_planar444 = 1; *word_bytes = 2; *chroma_vshift = 0; return 0;
    default:
        return AVERROR(ENOSYS);
    }
}

static int config_props(AVFilterLink *outlink)
{
    AVFilterContext *ctx = outlink->src;
    DLPPRtCudaContext *s = ctx->priv;
    AVFilterLink *inlink = ctx->inputs[0];
    FilterLink *inl = ff_filter_link(inlink), *outl = ff_filter_link(outlink);
    AVHWFramesContext *in_fc, *out_fc;
    CUcontext dummy;
    uint8_t *inj = NULL;
    float scale;
    char selftest_id[64];
    int ret;

    if (!inl->hw_frames_ctx) {
        av_log(ctx, AV_LOG_ERROR, "needs CUDA frames (-hwaccel cuda -hwaccel_output_format cuda)\n");
        return AVERROR(EINVAL);
    }
    in_fc = (AVHWFramesContext *)inl->hw_frames_ctx->data;
    if (classify_nvdec_format(in_fc->sw_format, &s->is_planar444, &s->word_bytes, &s->chroma_vshift) < 0 ||
        (inlink->w | inlink->h) & 1) {
        av_log(ctx, AV_LOG_ERROR, "needs an even-sized NVDEC CUDA format, got %s\n",
               av_get_pix_fmt_name(in_fc->sw_format));
        return AVERROR(ENOSYS);
    }
    s->hwctx = in_fc->device_ctx->hwctx;
    if (!s->ow) s->ow = inlink->w * 2;
    if (!s->oh) s->oh = inlink->h * 2;
    /* Native-scale field (params+0x38): auto-derived from the actual output
     * width so it always matches the requested buffer, rather than a second
     * knob the user could set inconsistently with w/h. Only read by DLPP at
     * level >= 3; harmless to compute unconditionally. */
    scale = (float)s->ow / inlink->w;

    s->out_frames = av_hwframe_ctx_alloc(in_fc->device_ref);
    if (!s->out_frames) return AVERROR(ENOMEM);
    out_fc = (AVHWFramesContext *)s->out_frames->data;
    out_fc->format = AV_PIX_FMT_CUDA;
    out_fc->sw_format = AV_PIX_FMT_NV12;
    out_fc->width = s->ow;
    out_fc->height = s->oh;
    if ((ret = av_hwframe_ctx_init(s->out_frames)) < 0) return ret;
    outl->hw_frames_ctx = av_buffer_ref(s->out_frames);
    if (!outl->hw_frames_ctx) return AVERROR(ENOMEM);
    outlink->w = s->ow;
    outlink->h = s->oh;

    if (s->inject) {
        size_t n = (size_t)inlink->w * inlink->h * 4;
        FILE *f = fopen(s->inject, "rb");
        inj = av_malloc(n);
        if (!f || !inj || fread(inj, 1, n, f) != n) {
            av_log(ctx, AV_LOG_ERROR, "inject: cannot read %zu bytes from %s\n", n, s->inject);
            if (f) fclose(f);
            av_free(inj);
            return AVERROR(EINVAL);
        }
        fclose(f);
    }

    ret = CHECK_CU(s->hwctx->internal->cuda_dl->cuCtxPushCurrent(s->hwctx->cuda_ctx));
    if (ret < 0) { av_free(inj); return ret; }
    ret = gu_dlpp_embed_load_ptx(gu_dlpp_nv12_rgba_ptx, (void **)&s->mod) ? AVERROR_EXTERNAL : 0;
    if (!ret) ret = CHECK_CU(s->hwctx->internal->cuda_dl->cuModuleGetFunction(&s->k_in_semi, s->mod, "semiplanar_to_rgba"));
    if (!ret) ret = CHECK_CU(s->hwctx->internal->cuda_dl->cuModuleGetFunction(&s->k_in_planar444, s->mod, "planar444_to_rgba"));
    if (!ret) ret = CHECK_CU(s->hwctx->internal->cuda_dl->cuModuleGetFunction(&s->k_out, s->mod, "rgba_to_nv12"));
    CHECK_CU(s->hwctx->internal->cuda_dl->cuCtxPopCurrent(&dummy));
    if (ret < 0) { av_free(inj); return ret; }

    ret = gu_dlpp_embed_init(s->dll, s->hwctx->cuda_ctx, s->hwctx->stream,
                             inlink->w, inlink->h, s->ow, s->oh,
                             (unsigned)s->level, scale, inj,
                             &s->in_surf, &s->out_surf);
    av_free(inj);
    if (ret) {
        av_log(ctx, AV_LOG_ERROR,
               "gu_dlpp_embed_init rc=%d: could not map %s / create a DLPP instance. "
               "Check the path (see RTXDLPP.md) and that the driver providing nvppex.dll's "
               "PPE export table is loaded.\n", ret, s->dll);
        return AVERROR_EXTERNAL;
    }

    /* Self-test gate, run once here at init and never again: map + CreateInstance already
     * happened above inside gu_dlpp_embed_init(); this drives one real Process call before
     * FFmpeg commits to this filter chain, so a DLL that maps but cannot actually process a
     * frame (wrong DLL version, offsets moved by a driver update, GPU state it does not like)
     * fails here with a clear message instead of crashing on frame 1 or -- worse -- returning
     * silently wrong pixels for an entire session. Same fail-at-config_output discipline as
     * this project's FFRtxArchGate (ffmpeg-patches/0002): refuse to build the chain rather
     * than run degraded or crash mid-stream. */
    ret = gu_dlpp_embed_selftest(selftest_id, sizeof selftest_id);
    if (ret) {
        av_log(ctx, AV_LOG_ERROR,
               "dlpp_rtcuda self-test failed (Process rc=%#x) against %s -- refusing to build "
               "this filter chain. A likely cause is a driver/DLL update that moved the "
               "internal offsets this filter hard-codes (see TASK.md \"Track B: DLPP\"); "
               "%s\n", ret, s->dll, selftest_id);
        gu_dlpp_embed_close();
        return AVERROR_EXTERNAL;
    }
    av_log(ctx, AV_LOG_INFO, "dlpp_rtcuda self-test ok, %s\n", selftest_id);

    gu_dlpp_embed_cb_calls(s->cb0);
    av_log(ctx, AV_LOG_INFO, "DLPP level %d %dx%d -> %dx%d (scale %.3f) on ctx %p stream %p%s\n",
           s->level, inlink->w, inlink->h, s->ow, s->oh, scale,
           s->hwctx->cuda_ctx, s->hwctx->stream, s->inject ? " (injected input)" : "");
    return 0;
}

static int filter_frame(AVFilterLink *inlink, AVFrame *in)
{
    AVFilterContext *ctx = inlink->dst;
    DLPPRtCudaContext *s = ctx->priv;
    CudaFunctions *cu = s->hwctx->internal->cuda_dl;
    CUstream st = s->hwctx->stream;
    AVFrame *out = av_frame_alloc();
    CUcontext dummy;
    int ret, rc;

    if (!out) { ret = AVERROR(ENOMEM); goto fail; }
    if ((ret = av_hwframe_get_buffer(s->out_frames, out, 0)) < 0) goto fail;
    if ((ret = av_frame_copy_props(out, in)) < 0) goto fail;
    out->width = s->ow;
    out->height = s->oh;

    if ((ret = CHECK_CU(cu->cuCtxPushCurrent(s->hwctx->cuda_ctx))) < 0) goto fail;
    if (!s->inject) {
        unsigned w = inlink->w, h = inlink->h;
        if (s->is_planar444) {
            CUdeviceptr y = (CUdeviceptr)in->data[0], u = (CUdeviceptr)in->data[1], v = (CUdeviceptr)in->data[2];
            unsigned yp = in->linesize[0], up = in->linesize[1], vp = in->linesize[2];
            int word_bytes = s->word_bytes;
            void *args[] = { &y, &yp, &u, &up, &v, &vp, &s->in_surf, &w, &h, &word_bytes };
            ret = CHECK_CU(cu->cuLaunchKernel(s->k_in_planar444, (w + 15) / 16, (h + 15) / 16, 1,
                                              16, 16, 1, 0, st, args, NULL));
        } else {
            CUdeviceptr y = (CUdeviceptr)in->data[0], uv = (CUdeviceptr)in->data[1];
            unsigned yp = in->linesize[0], uvp = in->linesize[1];
            int word_bytes = s->word_bytes, chroma_vshift = s->chroma_vshift;
            void *args[] = { &y, &yp, &uv, &uvp, &s->in_surf, &w, &h, &word_bytes, &chroma_vshift };
            ret = CHECK_CU(cu->cuLaunchKernel(s->k_in_semi, (w + 15) / 16, (h + 15) / 16, 1,
                                              16, 16, 1, 0, st, args, NULL));
        }
    }
    if (!ret && (rc = gu_dlpp_embed_process())) {
        av_log(ctx, AV_LOG_ERROR, "Process rc=%#x\n", rc);
        ret = AVERROR_EXTERNAL;
    }
    if (!ret) {
        CUdeviceptr y = (CUdeviceptr)out->data[0], uv = (CUdeviceptr)out->data[1];
        unsigned yp = out->linesize[0], uvp = out->linesize[1], w = s->ow, h = s->oh;
        void *args[] = { &s->out_surf, &y, &yp, &uv, &uvp, &w, &h };
        ret = CHECK_CU(cu->cuLaunchKernel(s->k_out, (w / 2 + 15) / 16, (h / 2 + 15) / 16, 1,
                                          16, 16, 1, 0, st, args, NULL));
    }
    if (!ret && s->dump && s->nframes == s->dump_frame) {
        ret = CHECK_CU(cu->cuStreamSynchronize(st));
        if (!ret && (rc = gu_dlpp_embed_dump_ppm(s->dump)))
            av_log(ctx, AV_LOG_ERROR, "dump rc=%d\n", rc);
        else if (!ret)
            av_log(ctx, AV_LOG_INFO, "dumped frame %"PRId64" to %s\n", s->nframes, s->dump);
    }
    CHECK_CU(cu->cuCtxPopCurrent(&dummy));
    if (ret < 0) goto fail;

    s->nframes++;
    av_frame_free(&in);
    return ff_filter_frame(ctx->outputs[0], out);
fail:
    av_frame_free(&in);
    av_frame_free(&out);
    return ret;
}

static av_cold void uninit(AVFilterContext *ctx)
{
    DLPPRtCudaContext *s = ctx->priv;
    if (s->hwctx) {
        uint64_t cb[19];
        gu_dlpp_embed_cb_calls(cb);
        av_log(ctx, AV_LOG_INFO, "frames %"PRId64"; host callbacks after init: "
               "alloc(1) +%"PRIu64" htod(9) +%"PRIu64" launch(8) +%"PRIu64"\n",
               s->nframes, cb[1] - s->cb0[1], cb[9] - s->cb0[9], cb[8] - s->cb0[8]);
    }
    gu_dlpp_embed_close();
    if (s->mod) {
        CudaFunctions *cu = s->hwctx->internal->cuda_dl;
        CUcontext dummy;
        CHECK_CU(cu->cuCtxPushCurrent(s->hwctx->cuda_ctx));
        CHECK_CU(cu->cuModuleUnload(s->mod));
        CHECK_CU(cu->cuCtxPopCurrent(&dummy));
    }
    av_buffer_unref(&s->out_frames);
}

#define OFFSET(x) offsetof(DLPPRtCudaContext, x)
#define FLAGS (AV_OPT_FLAG_FILTERING_PARAM | AV_OPT_FLAG_VIDEO_PARAM)
static const AVOption dlpp_rtcuda_options[] = {
    { "dll", "path to nvdlppx.dll (not shipped: see RTXDLPP.md)", OFFSET(dll), AV_OPT_TYPE_STRING,
      { .str = "/usr/lib/jellyfin-ffmpeg-oidn/rtxdlpp/dll/nvdlppx.dll" }, 0, 0, FLAGS },
    { "level", "quality level 1-4 (default 1: most-validated, no native-scale complication); "
      "DEGRADED: gain is content-dependent across levels, never negative but never large "
      "either -- see TASK.md \"Track B: DLPP\"",
      OFFSET(level), AV_OPT_TYPE_INT, { .i64 = 1 }, 1, 4, FLAGS },
    { "w", "output width (0 = 2x)", OFFSET(ow), AV_OPT_TYPE_INT, { .i64 = 0 }, 0, 7680, FLAGS },
    { "h", "output height (0 = 2x)", OFFSET(oh), AV_OPT_TYPE_INT, { .i64 = 0 }, 0, 4320, FLAGS },
    { "inject", "raw RGBA input file, replaces decoded pictures (test harness only)",
      OFFSET(inject), AV_OPT_TYPE_STRING, { .str = NULL }, 0, 0, FLAGS },
    { "dump", "write the output of dump_frame as PPM (test harness only)", OFFSET(dump), AV_OPT_TYPE_STRING, { .str = NULL }, 0, 0, FLAGS },
    { "dump_frame", "frame index to dump", OFFSET(dump_frame), AV_OPT_TYPE_INT, { .i64 = 0 }, 0, INT_MAX, FLAGS },
    { NULL }
};

AVFILTER_DEFINE_CLASS(dlpp_rtcuda);

static const AVFilterPad dlpp_rtcuda_inputs[] = {
    { .name = "default", .type = AVMEDIA_TYPE_VIDEO, .filter_frame = filter_frame },
};

static const AVFilterPad dlpp_rtcuda_outputs[] = {
    { .name = "default", .type = AVMEDIA_TYPE_VIDEO, .config_props = config_props },
};

const FFFilter ff_vf_dlpp_rtcuda = {
    .p.name         = "dlpp_rtcuda",
    .p.description  = NULL_IF_CONFIG_SMALL("RTX DLPP super-resolution (nvdlppx) via a runtime "
                                            "PE loader, GPU-resident. DEGRADED: content-dependent "
                                            "gain, never negative but modest (see TASK.md "
                                            "\"Track B: DLPP\"); levels 3/4 native-scale path "
                                            "verified only at exact integer ratios."),
    .p.priv_class   = &dlpp_rtcuda_class,
    .priv_size      = sizeof(DLPPRtCudaContext),
    .uninit         = uninit,
    FILTER_INPUTS(dlpp_rtcuda_inputs),
    FILTER_OUTPUTS(dlpp_rtcuda_outputs),
    FILTER_SINGLE_PIXFMT(AV_PIX_FMT_CUDA),
    .flags_internal = FF_FILTER_FLAG_HWFRAME_AWARE,
};
