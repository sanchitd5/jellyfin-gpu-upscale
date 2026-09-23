

    avfilter: add a shared core for the   CUDA filters
    
    Seven of the filters that follow replay a captured   kernel graph, and all
    seven are 1:1 filters built the same way.  A <feature>_cuda_gen.h describes one
    feature's graph -- which cubins to load, how big each scratch buffer is at a
    given frame size, where the weights go, and every launch's grid, block and
    argument block -- and the filter's job is to turn that into CUDA calls.  That
    job is the same every time: gate the GPU architecture, load the modules, lay out
    one contiguous arena, upload the weights, bind the input and output images, then
    replay the launch list once per frame.  This is that job, written once.
    
    What stays in each vf_*.c is what genuinely differs: its AVOptions, which
    generated config the options select, the shape of its I/O binding, and the named
    tunable offsets it patches into the argument blocks.
    
    The generated headers are per-feature and expose everything as static, so the
    core never includes them.  Each filter instead passes its tables in through
    layout-compatible views and proves the cast with a static_assert, so a generator
    change that broke the assumption fails the build rather than corrupting a
    launch.
    
    Two decisions here are load-bearing rather than tidiness, and are commented as
    such in the source: the arena is one contiguous allocation because several
    kernels do a tile/halo read a little past the logical end of their input buffer,
    which is harmless inside an arena and becomes an illegal access once the heap
    fragments; and cuSurfObjectCreate/Destroy are resolved out of libcuda directly,
    once per process, because they are the one pair ffnvcodec's loader does not
    export.
---
 libavfilter/rtx_cuda.c     | 846 +++++++++++++++++++++++++++++++++++++++++++++
 libavfilter/rtx_cuda.h     | 498 ++++++++++++++++++++++++++
 libavfilter/rtx_dlpp_abi.h | 102 ++++++
 3 files changed, 1446 insertions(+)

diff --git a/libavfilter/rtx_cuda.c b/libavfilter/rtx_cuda.c
new file mode 100644
index 0000000000..18dc71d1dc
--- /dev/null
+++ b/libavfilter/rtx_cuda.c
@@ -0,0 +1,846 @@
+/*
+ * Shared core for the CUDA filters.
+ *
+ * This file is part of FFmpeg.
+ *
+ * FFmpeg is free software; you can redistribute it and/or
+ * modify it under the terms of the GNU Lesser General Public
+ * License as published by the Free Software Foundation; either
+ * version 2.1 of the License, or (at your option) any later version.
+ *
+ * FFmpeg is distributed in the hope that it will be useful,
+ * but WITHOUT ANY WARRANTY; without even the implied warranty of
+ * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
+ * Lesser General Public License for more details.
+ *
+ * You should have received a copy of the GNU Lesser General Public
+ * License along with FFmpeg; if not, write to the Free Software
+ * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
+ */
+
+#include <dlfcn.h>
+#include <math.h>
+#include <stdio.h>
+#include <string.h>
+
+#include "libavutil/eval.h"
+#include "libavutil/file.h"
+#include "libavutil/macros.h"
+#include "libavutil/mem.h"
+#include "libavutil/pixdesc.h"
+#include "libavutil/thread.h"
+
+#include "filters.h"
+#include "rtx_cuda.h"
+#include "video.h"
+
+#define CHECK_CU(x) FF_CUDA_CHECK_DL(ctx, r->hwctx->internal->cuda_dl, x)
+
+/* Arena sub-buffer alignment (>= cuMemAlloc's own guarantee, which the
+ * per-buffer allocations used to rely on) and a trailing guard covering the
+ * tile/halo over-read past the final buffer described in the header. */
+#define RTX_ALLOC_ALIGN 512
+#define RTX_ALLOC_GUARD (1 << 20)
+
+const FFRtxPixFmt ff_rtx_packed_rgb_fmts[5] = {
+    { AV_PIX_FMT_RGB0,     CU_AD_FORMAT_UNSIGNED_INT8, 4, 0 },
+    { AV_PIX_FMT_RGBA,     CU_AD_FORMAT_UNSIGNED_INT8, 4, 0 },
+    { AV_PIX_FMT_BGR0,     CU_AD_FORMAT_UNSIGNED_INT8, 4, 1 },
+    { AV_PIX_FMT_BGRA,     CU_AD_FORMAT_UNSIGNED_INT8, 4, 1 },
+    { AV_PIX_FMT_RGBA64LE, CU_AD_FORMAT_UNORM_INT16X4, 8, 2 },
+};
+
+const FFRtxPixFmt *ff_rtx_find_fmt(const FFRtxPixFmt *tbl, int n,
+                                   enum AVPixelFormat f)
+{
+    for (int i = 0; i < n; i++)
+        if (tbl[i].f == f)
+            return &tbl[i];
+    return NULL;
+}
+
+/* ------------------------------------------------------------------------- *
+ * cuSurfObjectCreate/Destroy
+ *
+ * The only pair ffnvcodec's dynlink loader does not export, so it comes
+ * straight out of libcuda -- once per process.  libcuda is already loaded (the
+ * hwcontext holds it) and lives for the process, so this neither dlcloses nor
+ * refcounts.
+ * ------------------------------------------------------------------------- */
+typedef CUresult (*tcuSurfObjectCreate)(FFCUsurfObject *, const CUDA_RESOURCE_DESC *);
+typedef CUresult (*tcuSurfObjectDestroy)(FFCUsurfObject);
+
+static tcuSurfObjectCreate  rtx_surf_create;
+static tcuSurfObjectDestroy rtx_surf_destroy;
+
+static void rtx_load_surf_fns(void)
+{
+    void *libcuda = dlopen("libcuda.so.1", RTLD_NOW | RTLD_GLOBAL);
+    if (!libcuda)
+        return;
+    rtx_surf_create  = (tcuSurfObjectCreate)dlsym(libcuda, "cuSurfObjectCreate");
+    rtx_surf_destroy = (tcuSurfObjectDestroy)dlsym(libcuda, "cuSurfObjectDestroy");
+}
+
+static int rtx_surf_fns(AVFilterContext *ctx)
+{
+    static AVOnce once = AV_ONCE_INIT;
+    ff_thread_once(&once, rtx_load_surf_fns);
+    if (!rtx_surf_create || !rtx_surf_destroy) {
+        av_log(ctx, AV_LOG_ERROR, "cuSurfObjectCreate unavailable\n");
+        return AVERROR_EXTERNAL;
+    }
+    return 0;
+}
+
+/* ------------------------------------------------------------------------- *
+ * Device binding and output plumbing
+ * ------------------------------------------------------------------------- */
+void ff_rtx_uninit(AVFilterContext *ctx)
+{
+    FFRtxPriv *p = ctx->priv;
+    ff_rtx_free_graph(ctx, &p->r);
+}
+
+int ff_rtx_config_formats(AVFilterContext *ctx, AVFilterLink *inlink,
+                          const FFRtxFormats *f,
+                          AVHWFramesContext **in_frames_ctx,
+                          const FFRtxPixFmt **inpf, const FFRtxPixFmt **outpf)
+{
+    FilterLink *il = ff_filter_link(inlink);
+    const char *hint = f->hint ? f->hint : "";
+    const char *open = f->hint ? " (" : "", *close = f->hint ? ")" : "";
+    enum AVPixelFormat fmt;
+
+    if (!il->hw_frames_ctx) {
+        av_log(ctx, AV_LOG_ERROR, "No hw context provided on input\n");
+        return AVERROR(EINVAL);
+    }
+    *in_frames_ctx = (AVHWFramesContext *)il->hw_frames_ctx->data;
+
+    fmt   = (*in_frames_ctx)->sw_format;
+    *inpf = ff_rtx_find_fmt(f->in_tbl, f->n_in, fmt);
+    if (!*inpf) {
+        av_log(ctx, AV_LOG_ERROR, "Unsupported input format %s%s%s%s\n",
+               av_get_pix_fmt_name(fmt), open, hint, close);
+        return AVERROR(ENOSYS);
+    }
+    if (!outpf)
+        return 0;
+
+    /* av_get_pix_fmt() strcmps its argument, so an option cleared to NULL --
+     * av_opt_set(..., "format", NULL, 0) is legal for a string option -- must
+     * not reach it. */
+    if (f->out_format && *f->out_format) {
+        fmt = av_get_pix_fmt(f->out_format);
+        if (fmt == AV_PIX_FMT_NONE) {
+            av_log(ctx, AV_LOG_ERROR, "invalid output format '%s'\n", f->out_format);
+            return AVERROR(EINVAL);
+        }
+    }
+    *outpf = ff_rtx_find_fmt(f->out_tbl ? f->out_tbl : f->in_tbl,
+                             f->out_tbl ? f->n_out : f->n_in, fmt);
+    if (!*outpf) {
+        av_log(ctx, AV_LOG_ERROR, "Unsupported output format %s%s%s%s\n",
+               av_get_pix_fmt_name(fmt), open, hint, close);
+        return AVERROR(ENOSYS);
+    }
+    return 0;
+}
+
+int ff_rtx_bind_device(AVFilterContext *ctx, FFRtxCuda *r,
+                       AVHWFramesContext *in_frames_ctx)
+{
+    r->device_ref = av_buffer_ref(in_frames_ctx->device_ref);
+    if (!r->device_ref)
+        return AVERROR(ENOMEM);
+    r->hwctx  = ((AVHWDeviceContext *)r->device_ref->data)->hwctx;
+    r->cu_ctx = r->hwctx->cuda_ctx;
+    r->stream = r->hwctx->stream;
+    return 0;
+}
+
+int ff_rtx_config_hwframes(AVFilterContext *ctx, AVFilterLink *outlink,
+                           FFRtxCuda *r, int oW, int oH,
+                           enum AVPixelFormat sw_format)
+{
+    FilterLink *ol = ff_filter_link(outlink);
+    AVHWFramesContext *out_frames_ctx;
+    int ret;
+
+    outlink->w = oW;
+    outlink->h = oH;
+
+    av_buffer_unref(&ol->hw_frames_ctx);
+    ol->hw_frames_ctx = av_hwframe_ctx_alloc(r->device_ref);
+    if (!ol->hw_frames_ctx)
+        return AVERROR(ENOMEM);
+    out_frames_ctx = (AVHWFramesContext *)ol->hw_frames_ctx->data;
+    out_frames_ctx->format            = AV_PIX_FMT_CUDA;
+    out_frames_ctx->sw_format         = sw_format;
+    out_frames_ctx->width             = oW;
+    out_frames_ctx->height            = oH;
+    out_frames_ctx->initial_pool_size = 4;
+
+    if ((ret = ff_filter_init_hw_frames(ctx, outlink, 4)) < 0)
+        return ret;
+    ret = av_hwframe_ctx_init(ol->hw_frames_ctx);
+    if (ret < 0)
+        av_log(ctx, AV_LOG_ERROR, "Failed to init CUDA frame context: %d\n", ret);
+    return ret;
+}
+
+int ff_rtx_setup(AVFilterContext *ctx, FFRtxCuda *r, const char *what,
+                 int (*setup_graph)(AVFilterContext *ctx))
+{
+    CUcontext dummy;
+    int ret;
+
+    if ((ret = CHECK_CU(r->hwctx->internal->cuda_dl->cuCtxPushCurrent(r->cu_ctx))) < 0)
+        return ret;
+    ret = setup_graph(ctx);
+    CHECK_CU(r->hwctx->internal->cuda_dl->cuCtxPopCurrent(&dummy));
+    if (ret < 0) {
+        av_log(ctx, AV_LOG_ERROR, "%s graph setup failed (%d)\n", what, ret);
+        return ret;
+    }
+    r->ready = 1;
+    return 0;
+}
+
+/* ------------------------------------------------------------------------- *
+ * Graph setup
+ * ------------------------------------------------------------------------- */
+int ff_rtx_arch_gate(AVFilterContext *ctx, FFRtxCuda *r,
+                     const FFRtxArchGate *gate, int experimental)
+{
+    CudaFunctions *cu = r->hwctx->internal->cuda_dl;
+    CUdevice dev = 0;
+    int cc_major = 0, cc_minor = 0, ret;
+
+    if ((ret = CHECK_CU(cu->cuCtxGetDevice(&dev))) < 0)
+        return ret;
+    if ((ret = CHECK_CU(cu->cuDeviceGetAttribute(&cc_major,
+            CU_DEVICE_ATTRIBUTE_COMPUTE_CAPABILITY_MAJOR, dev))) < 0)
+        return ret;
+    if ((ret = CHECK_CU(cu->cuDeviceGetAttribute(&cc_minor,
+            CU_DEVICE_ATTRIBUTE_COMPUTE_CAPABILITY_MINOR, dev))) < 0)
+        return ret;
+
+    if (gate->hard_min_major && cc_major < gate->hard_min_major) {
+        av_log(ctx, AV_LOG_ERROR, gate->hard_msg, cc_major, cc_minor);
+        return AVERROR(ENOSYS);
+    }
+    /* Blackwell (cc 12.x) and Ada (cc 8.9) are the two the cubins were verified
+     * byte-exact on; everything else needs the opt-in. */
+    if (cc_major >= 12 || (cc_major == 8 && cc_minor == 9))
+        return 0;
+    if (!experimental) {
+        av_log(ctx, AV_LOG_ERROR, gate->gate_msg, cc_major, cc_minor);
+        return AVERROR(ENOSYS);
+    }
+    av_log(ctx, AV_LOG_WARNING, gate->warn_msg, cc_major, cc_minor);
+    return 0;
+}
+
+int ff_rtx_load_modules(AVFilterContext *ctx, FFRtxCuda *r, const char *dir,
+                        const FFRtxModule *mods, int nmod, int max_mid,
+                        const FFRtxFunc *funcs, int nfunc, int max_fid,
+                        const char *load_hint)
+{
+    CudaFunctions *cu = r->hwctx->internal->cuda_dl;
+    char path[1024];
+    int ret;
+
+    r->max_mid = max_mid;
+    r->max_fid = max_fid;
+    r->mod = av_calloc(max_mid + 1, sizeof(*r->mod));
+    r->fn  = av_calloc(max_fid + 1, sizeof(*r->fn));
+    if (!r->mod || !r->fn)
+        return AVERROR(ENOMEM);
+
+    for (int i = 0; i < nmod; i++) {
+        uint8_t *buf = NULL;
+        size_t bsz = 0;
+
+        if (mods[i].mid < 0 || mods[i].mid > max_mid) {
+            av_log(ctx, AV_LOG_ERROR, "%s has module id %d, past the %d these "
+                   "tables were sized for\n", mods[i].file, mods[i].mid, max_mid);
+            return AVERROR_BUG;
+        }
+        snprintf(path, sizeof(path), "%s/%s", dir, mods[i].file);
+        ret = av_file_map(path, &buf, &bsz, 0, ctx);
+        if (ret < 0) {
+            av_log(ctx, AV_LOG_ERROR, "cannot read cubin %s\n", path);
+            return ret;
+        }
+        /* Every cubin is a multi-arch fatbin; cuModuleLoadData picks the image
+         * for the running GPU, so a failure here means this data dir carries
+         * none. */
+        ret = CHECK_CU(cu->cuModuleLoadData(&r->mod[mods[i].mid], buf));
+        av_file_unmap(buf, bsz);
+        if (ret < 0) {
+            if (load_hint) {
+                CUdevice dev = 0;
+                int cc_major = 0, cc_minor = 0;
+                cu->cuCtxGetDevice(&dev);
+                cu->cuDeviceGetAttribute(&cc_major,
+                    CU_DEVICE_ATTRIBUTE_COMPUTE_CAPABILITY_MAJOR, dev);
+                cu->cuDeviceGetAttribute(&cc_minor,
+                    CU_DEVICE_ATTRIBUTE_COMPUTE_CAPABILITY_MINOR, dev);
+                av_log(ctx, AV_LOG_ERROR, "%s has no image for this GPU (cc %d.%d).  %s\n",
+                       mods[i].file, cc_major, cc_minor, load_hint);
+            }
+            return ret;
+        }
+    }
+    for (int i = 0; i < nfunc; i++) {
+        if (funcs[i].fid < 0 || funcs[i].fid > max_fid ||
+            funcs[i].mid < 0 || funcs[i].mid > max_mid) {
+            av_log(ctx, AV_LOG_ERROR, "kernel %s has ids %d/%d, past the %d/%d "
+                   "these tables were sized for\n", funcs[i].name,
+                   funcs[i].fid, funcs[i].mid, max_fid, max_mid);
+            return AVERROR_BUG;
+        }
+        ret = CHECK_CU(cu->cuModuleGetFunction(&r->fn[funcs[i].fid],
+                                               r->mod[funcs[i].mid], funcs[i].name));
+        if (ret < 0) {
+            av_log(ctx, AV_LOG_ERROR, "missing kernel %s\n", funcs[i].name);
+            return ret;
+        }
+    }
+    return 0;
+}
+
+int ff_rtx_alloc_arena(AVFilterContext *ctx, FFRtxCuda *r, int nalloc,
+                       void (*fill_sizes)(AVFilterContext *ctx, long long *sz),
+                       unsigned flags)
+{
+    CudaFunctions *cu = r->hwctx->internal->cuda_dl;
+    long long *sz;
+    size_t total = 0;
+    int ret;
+
+    r->nalloc = nalloc;
+    r->alloc = av_calloc(nalloc, sizeof(*r->alloc));
+    sz       = av_calloc(nalloc, sizeof(*sz));
+    if (!r->alloc || !sz) {
+        av_freep(&sz);
+        return AVERROR(ENOMEM);
+    }
+
+    fill_sizes(ctx, sz);
+    /* Lay the arena out in one pass, parking each ordinal's offset in alloc[]
+     * until there is a base address to add it to. */
+    for (int a = 0; a < nalloc; a++) {
+        r->alloc[a] = total;
+        total += FFALIGN(sz[a] > 0 ? (size_t)sz[a] : 1, RTX_ALLOC_ALIGN);
+    }
+    av_freep(&sz);
+    total += RTX_ALLOC_GUARD;
+
+    if ((ret = CHECK_CU(cu->cuMemAlloc(&r->arena, total))) < 0)
+        return ret;
+    r->arena_size = total;
+    for (int a = 0; a < nalloc; a++)
+        r->alloc[a] += r->arena;
+
+    if (flags & FF_RTX_ARENA_ZERO) {
+        /* cuMemAlloc does not zero.  Start from a known-zero arena so any
+         * scratch a kernel reads before writing is deterministically 0, as in a
+         * fresh loader process; the weight uploads then fill their buffers. */
+        if ((ret = CHECK_CU(cu->cuMemsetD8Async(r->arena, 0, total, r->stream))) < 0)
+            return ret;
+        if ((ret = CHECK_CU(cu->cuStreamSynchronize(r->stream))) < 0)
+            return ret;
+    }
+    return 0;
+}
+
+int ff_rtx_snapshot_arena(AVFilterContext *ctx, FFRtxCuda *r)
+{
+    CudaFunctions *cu = r->hwctx->internal->cuda_dl;
+    int ret;
+
+    if (!r->arena_uploaded)     /* nothing to preserve; the reset is a pure memset */
+        return 0;
+    if ((ret = CHECK_CU(cu->cuMemAlloc(&r->arena_template, r->arena_uploaded))) < 0)
+        return ret;
+    return CHECK_CU(cu->cuMemcpyDtoDAsync(r->arena_template, r->arena,
+                                          r->arena_uploaded, r->stream));
+}
+
+int ff_rtx_reset_arena(AVFilterContext *ctx, FFRtxCuda *r)
+{
+    CudaFunctions *cu = r->hwctx->internal->cuda_dl;
+    int ret;
+
+    if (r->arena_uploaded) {
+        ret = CHECK_CU(cu->cuMemcpyDtoDAsync(r->arena, r->arena_template,
+                                             r->arena_uploaded, r->stream));
+        if (ret < 0)
+            return ret;
+    }
+    return CHECK_CU(cu->cuMemsetD8Async(r->arena + r->arena_uploaded, 0,
+                                        r->arena_size - r->arena_uploaded,
+                                        r->stream));
+}
+
+int ff_rtx_upload_weights(AVFilterContext *ctx, FFRtxCuda *r, const char *dir,
+                          const char *file, const FFRtxUpload *up, int nup)
+{
+    CudaFunctions *cu = r->hwctx->internal->cuda_dl;
+    uint8_t *weights = NULL;
+    size_t wsz = 0, end;
+    char path[1024];
+    int ret;
+
+    snprintf(path, sizeof(path), "%s/%s", dir, file);
+    if ((ret = av_file_map(path, &weights, &wsz, 0, ctx)) < 0) {
+        av_log(ctx, AV_LOG_ERROR, "cannot read weights %s\n", path);
+        return ret;
+    }
+    for (int i = 0; i < nup; i++) {
+        if (up[i].file_off + up[i].size > (long long)wsz) {
+            av_log(ctx, AV_LOG_ERROR, "%s is too small\n", path);
+            ret = AVERROR_INVALIDDATA;
+            break;
+        }
+        /* Async: a graph carries hundreds of small uploads (dlpp_drv: 525
+         * averaging 8.8 KiB) and the blocking form pays its round trip on every
+         * one of them.  The source is the mapping below, which has to stay put
+         * until the copies land -- hence the synchronize before it is dropped. */
+        ret = CHECK_CU(cu->cuMemcpyHtoDAsync((CUdeviceptr)up[i].dst,
+                                             weights + up[i].file_off, up[i].size,
+                                             r->stream));
+        if (ret < 0)
+            break;
+        /* Track how far into the arena the uploads reach, so a later
+         * ff_rtx_snapshot_arena() only has to preserve that much. */
+        end = (size_t)((CUdeviceptr)up[i].dst + up[i].size - r->arena);
+        if (end > r->arena_uploaded)
+            r->arena_uploaded = end;
+    }
+    /* The copies read from the mapping, so they must complete before it goes. */
+    if (ret >= 0)
+        ret = CHECK_CU(cu->cuStreamSynchronize(r->stream));
+    else
+        cu->cuStreamSynchronize(r->stream);
+    av_file_unmap(weights, wsz);
+    return ret < 0 ? ret : 0;
+}
+
+int ff_rtx_alloc_launches(AVFilterContext *ctx, FFRtxCuda *r,
+                          int nlaunch, size_t launch_size)
+{
+    r->launches = av_calloc(nlaunch, launch_size);
+    if (!r->launches)
+        return AVERROR(ENOMEM);
+    r->nlaunch     = nlaunch;
+    r->launch_size = launch_size;
+    return 0;
+}
+
+/* ------------------------------------------------------------------------- *
+ * Image binding
+ * ------------------------------------------------------------------------- */
+static FFRtxImage *rtx_image_slot(AVFilterContext *ctx, FFRtxCuda *r)
+{
+    if (r->nimage >= FF_RTX_MAX_IMAGES) {
+        av_log(ctx, AV_LOG_ERROR, "too many graph images\n");
+        return NULL;
+    }
+    return &r->image[r->nimage++];
+}
+
+/* The descriptor every captured graph samples with: linear filtering over
+ * normalized coordinates.  Only the address mode varies. */
+static CUDA_TEXTURE_DESC rtx_tex_desc(unsigned flags)
+{
+    CUDA_TEXTURE_DESC td = { 0 };
+    if (flags & FF_RTX_CLAMP)
+        td.addressMode[0] = td.addressMode[1] = td.addressMode[2] =
+            CU_TR_ADDRESS_MODE_CLAMP;
+    td.filterMode = CU_TR_FILTER_MODE_LINEAR;
+    td.flags      = CU_TRSF_NORMALIZED_COORDINATES;
+    return td;
+}
+
+static int rtx_bind_handles(AVFilterContext *ctx, FFRtxCuda *r, FFRtxImage *img,
+                            const CUDA_RESOURCE_DESC *rd, unsigned flags)
+{
+    CudaFunctions *cu = r->hwctx->internal->cuda_dl;
+    int ret;
+
+    if (flags & FF_RTX_TEX) {
+        CUDA_TEXTURE_DESC td = rtx_tex_desc(flags);
+        if ((ret = CHECK_CU(cu->cuTexObjectCreate(&img->tex, rd, &td, NULL))) < 0)
+            return ret;
+    }
+    if (flags & FF_RTX_SURF) {
+        if ((ret = rtx_surf_fns(ctx)) < 0)
+            return ret;
+        if (rtx_surf_create(&img->surf, rd) != CUDA_SUCCESS) {
+            av_log(ctx, AV_LOG_ERROR, "cuSurfObjectCreate failed\n");
+            return AVERROR_EXTERNAL;
+        }
+    }
+    return 0;
+}
+
+FFRtxImage *ff_rtx_image_array(AVFilterContext *ctx, FFRtxCuda *r, int W, int H,
+                               CUarray_format cufmt, unsigned flags)
+{
+    CudaFunctions *cu = r->hwctx->internal->cuda_dl;
+    FFRtxImage *img = rtx_image_slot(ctx, r);
+    CUDA_ARRAY3D_DESCRIPTOR ad = { 0 };
+    CUDA_RESOURCE_DESC rd = { 0 };
+
+    if (!img)
+        return NULL;
+
+    ad.Width = W; ad.Height = H; ad.Depth = 0;
+    ad.Format = cufmt;
+    ad.NumChannels = 4;
+    ad.Flags = (flags & FF_RTX_LDST) ? CUDA_ARRAY3D_SURFACE_LDST : 0;
+    if (CHECK_CU(cu->cuArray3DCreate(&img->arr, &ad)) < 0)
+        return NULL;
+
+    rd.resType = CU_RESOURCE_TYPE_ARRAY;
+    rd.res.array.hArray = img->arr;
+    return rtx_bind_handles(ctx, r, img, &rd, flags) < 0 ? NULL : img;
+}
+
+FFRtxImage *ff_rtx_image_pitch(AVFilterContext *ctx, FFRtxCuda *r, int W, int H,
+                               CUarray_format cufmt, int bpp, unsigned flags)
+{
+    CudaFunctions *cu = r->hwctx->internal->cuda_dl;
+    FFRtxImage *img = rtx_image_slot(ctx, r);
+    CUDA_RESOURCE_DESC rd = { 0 };
+
+    if (!img)
+        return NULL;
+
+    if (CHECK_CU(cu->cuMemAllocPitch(&img->ptr, &img->pitch,
+                                     (size_t)W * bpp, H, 16)) < 0)
+        return NULL;
+    if (flags & FF_RTX_ZERO) {
+        if (CHECK_CU(cu->cuMemsetD8Async(img->ptr, 0, img->pitch * H, r->stream)) < 0)
+            return NULL;
+    }
+
+    rd.resType = CU_RESOURCE_TYPE_PITCH2D;
+    rd.res.pitch2D.devPtr       = img->ptr;
+    rd.res.pitch2D.format       = cufmt;
+    rd.res.pitch2D.numChannels  = 4;
+    rd.res.pitch2D.width        = W;
+    rd.res.pitch2D.height       = H;
+    rd.res.pitch2D.pitchInBytes = img->pitch;
+    return rtx_bind_handles(ctx, r, img, &rd, flags) < 0 ? NULL : img;
+}
+
+FFRtxImage *ff_rtx_image_linear(AVFilterContext *ctx, FFRtxCuda *r,
+                                size_t size, size_t pitch)
+{
+    CudaFunctions *cu = r->hwctx->internal->cuda_dl;
+    FFRtxImage *img = rtx_image_slot(ctx, r);
+
+    if (!img)
+        return NULL;
+    if (CHECK_CU(cu->cuMemAlloc(&img->ptr, size)) < 0)
+        return NULL;
+    img->pitch = pitch;
+    return img;
+}
+
+/* Resolve each launch's fnid back to a kernel name rather than the name to a
+ * single fid: one kernel name can appear under several fids (the per-layer
+ * k_conv modules all export k_conv_fp16_nhwc), so only the launch list says
+ * which one the graph actually runs.  @p n limits the comparison to a prefix. */
+static int rtx_find_launch(const FFRtxCuda *r, const FFRtxFunc *funcs, int nfunc,
+                           const char *name, size_t n)
+{
+    for (int li = 0; li < r->nlaunch; li++) {
+        int fnid = ff_rtx_launch_at(r, li)->fnid;
+        for (int i = 0; i < nfunc; i++)
+            if (funcs[i].fid == fnid && !strncmp(funcs[i].name, name, n))
+                return li;
+    }
+    return -1;
+}
+
+int ff_rtx_find_launch(const FFRtxCuda *r, const FFRtxFunc *funcs, int nfunc,
+                       const char *name)
+{
+    return rtx_find_launch(r, funcs, nfunc, name, strlen(name) + 1);
+}
+
+int ff_rtx_find_launch_prefix(const FFRtxCuda *r, const FFRtxFunc *funcs, int nfunc,
+                              const char *prefix)
+{
+    return rtx_find_launch(r, funcs, nfunc, prefix, strlen(prefix));
+}
+
+/* ------------------------------------------------------------------------- *
+ * Per-frame replay
+ *
+ * None of this synchronizes.  Every op -- the input copy, all the launches, the
+ * output copy -- is issued on the shared device stream (hwctx->stream), and
+ * every consumer runs on it too: a downstream CUDA filter, or hwcontext_cuda's
+ * transfer path, which copies on that same stream and syncs itself.  So stream
+ * issue-order already orders our output before any read of it, and orders the
+ * next producer's reuse of the freed input buffer after our read.  Blocking per
+ * frame would only bound errors to this frame, at the cost of all CPU/GPU
+ * overlap.  This relies on the single-shared-stream contract: a consumer on its
+ * own context/stream would need an event at that boundary.
+ * ------------------------------------------------------------------------- */
+int ff_rtx_filter_frame(AVFilterLink *inlink, AVFrame *in, FFRtxCuda *r,
+                        const FFRtxFrameOp *op,
+                        void (*retag)(AVFilterContext *ctx, AVFrame *out))
+{
+    AVFilterContext *ctx = inlink->dst;
+    AVFilterLink *outlink = ctx->outputs[0];
+    CudaFunctions *cu = r->hwctx ? r->hwctx->internal->cuda_dl : NULL;
+    CUcontext dummy;
+    AVFrame *out;
+    int ret;
+
+    if (!r->ready) {
+        av_frame_free(&in);
+        return AVERROR(EINVAL);
+    }
+
+    out = ff_get_video_buffer(outlink, op->oW, op->oH);
+    if (!out) {
+        av_frame_free(&in);
+        return AVERROR(ENOMEM);
+    }
+    av_frame_copy_props(out, in);
+    if (retag)
+        retag(ctx, out);
+
+    ret = FF_CUDA_CHECK_DL(ctx, cu, cu->cuCtxPushCurrent(r->cu_ctx));
+    if (ret < 0)
+        goto fail;
+
+    /* Restore the arena to its post-upload state for a graph that reads scratch
+     * before writing it: a fresh process gets zeroed pages, a long-running host
+     * recycles dirty memory. */
+    if (op->flags & FF_RTX_OP_RESET_ARENA) {
+        ret = ff_rtx_reset_arena(ctx, r);
+        if (ret < 0)
+            goto fail_pop;
+    }
+    ret = ff_rtx_frame_to_image(ctx, r, in, op->in_img, op->iW, op->iH, op->ibpp);
+    if (ret < 0)
+        goto fail_pop;
+    ret = op->run ? op->run(ctx)
+                  : ff_rtx_launch_all(ctx, r, !!(op->flags & FF_RTX_OP_PSIZE));
+    if (ret < 0)
+        goto fail_pop;
+    ret = ff_rtx_image_to_frame(ctx, r, op->out_img, out, op->oW, op->oH, op->obpp);
+    if (ret < 0)
+        goto fail_pop;
+
+    if (op->flags & FF_RTX_OP_OPAQUE_ALPHA)
+        ret = ff_rtx_fill_opaque_alpha(ctx, r, out, op->oW, op->oH, op->obpp);
+
+fail_pop:
+    FF_CUDA_CHECK_DL(ctx, cu, cu->cuCtxPopCurrent(&dummy));
+fail:
+    av_frame_free(&in);
+    if (ret < 0) {
+        av_frame_free(&out);
+        return ret;
+    }
+    return ff_filter_frame(outlink, out);
+}
+
+int ff_rtx_launch(AVFilterContext *ctx, FFRtxCuda *r, int fnid,
+                  const unsigned grid[3], const unsigned block[3], unsigned smem,
+                  void *params, size_t psize)
+{
+    CudaFunctions *cu = r->hwctx->internal->cuda_dl;
+    void *extra[] = { CU_LAUNCH_PARAM_BUFFER_POINTER, params,
+                      CU_LAUNCH_PARAM_BUFFER_SIZE, &psize, CU_LAUNCH_PARAM_END };
+
+    /* The tables are the generator's, but the sizes they are indexed against
+     * are the caller's -- ISR has to state them by hand, its header carrying no
+     * MAX_FID -- so an out-of-range id is a bug to report, not to dereference. */
+    if (fnid < 0 || fnid > r->max_fid || !r->fn[fnid]) {
+        av_log(ctx, AV_LOG_ERROR, "launch of unresolved kernel id %d (max %d)\n",
+               fnid, r->max_fid);
+        return AVERROR_BUG;
+    }
+    return CHECK_CU(cu->cuLaunchKernel(r->fn[fnid], grid[0], grid[1], grid[2],
+                                       block[0], block[1], block[2],
+                                       smem, r->stream, NULL, extra));
+}
+
+int ff_rtx_launch_all(AVFilterContext *ctx, FFRtxCuda *r, int use_psize)
+{
+    for (int li = 0; li < r->nlaunch; li++) {
+        FFRtxLaunch *l = ff_rtx_launch_at(r, li);
+        int ret = ff_rtx_launch(ctx, r, l->fnid, l->grid, l->block, l->smem,
+                                l->params, use_psize ? l->psize : l->argsize);
+        if (ret < 0)
+            return ret;
+    }
+    return 0;
+}
+
+int ff_rtx_frame_to_image(AVFilterContext *ctx, FFRtxCuda *r, const AVFrame *in,
+                          const FFRtxImage *img, int W, int H, int bpp)
+{
+    CudaFunctions *cu = r->hwctx->internal->cuda_dl;
+    CUDA_MEMCPY2D c = { 0 };
+
+    c.srcMemoryType = CU_MEMORYTYPE_DEVICE;
+    c.srcDevice     = (CUdeviceptr)in->data[0];
+    c.srcPitch      = in->linesize[0];
+    if (img->arr) {
+        c.dstMemoryType = CU_MEMORYTYPE_ARRAY;
+        c.dstArray      = img->arr;
+    } else {
+        c.dstMemoryType = CU_MEMORYTYPE_DEVICE;
+        c.dstDevice     = img->ptr;
+        c.dstPitch      = img->pitch;
+    }
+    c.WidthInBytes = (size_t)W * bpp;
+    c.Height       = H;
+    return CHECK_CU(cu->cuMemcpy2DAsync(&c, r->stream));
+}
+
+int ff_rtx_image_to_frame(AVFilterContext *ctx, FFRtxCuda *r,
+                          const FFRtxImage *img, AVFrame *out,
+                          int W, int H, int bpp)
+{
+    CudaFunctions *cu = r->hwctx->internal->cuda_dl;
+    CUDA_MEMCPY2D c = { 0 };
+
+    if (img->arr) {
+        c.srcMemoryType = CU_MEMORYTYPE_ARRAY;
+        c.srcArray      = img->arr;
+    } else {
+        c.srcMemoryType = CU_MEMORYTYPE_DEVICE;
+        c.srcDevice     = img->ptr;
+        c.srcPitch      = img->pitch;
+    }
+    c.dstMemoryType = CU_MEMORYTYPE_DEVICE;
+    c.dstDevice     = (CUdeviceptr)out->data[0];
+    c.dstPitch      = out->linesize[0];
+    c.WidthInBytes  = (size_t)W * bpp;
+    c.Height        = H;
+    return CHECK_CU(cu->cuMemcpy2DAsync(&c, r->stream));
+}
+
+int ff_rtx_fill_opaque_alpha(AVFilterContext *ctx, FFRtxCuda *r, AVFrame *out,
+                             int oW, int oH, int bpp)
+{
+    CudaFunctions *cu = r->hwctx->internal->cuda_dl;
+    size_t px = bpp;                                       /* 8 for rgba64le */
+    CUdeviceptr a0 = (CUdeviceptr)out->data[0] + (px - 2); /* last u16 = alpha */
+    int ret = 0;
+
+    /* Set just the alpha u16 of each pixel, stride = bpp.  A padded row is
+     * covered by running over the padding too: it is inside the frame
+     * allocation and nothing reads it (hwframe transfers copy oW*bpp per row),
+     * so one memset does the whole plane instead of one per row -- which at 4K
+     * was over two thousand launches on the critical stream.  The pitch comes
+     * from cuMemAllocPitch and is a multiple of 512, hence of bpp, but fall
+     * back to the row loop rather than assume it. */
+    if (out->linesize[0] % (int)px == 0) {
+        size_t stride_px = (size_t)out->linesize[0] / px;
+        return CHECK_CU(cu->cuMemsetD2D16Async(a0, px, 0xFFFF, 1,
+                                               stride_px * oH, r->stream));
+    }
+    for (int y = 0; y < oH && ret >= 0; y++)
+        ret = CHECK_CU(cu->cuMemsetD2D16Async(a0 + (size_t)y * out->linesize[0],
+                                              px, 0xFFFF, 1, oW, r->stream));
+    return ret;
+}
+
+/* ------------------------------------------------------------------------- *
+ * Teardown and helpers
+ * ------------------------------------------------------------------------- */
+void ff_rtx_free_graph(AVFilterContext *ctx, FFRtxCuda *r)
+{
+    if (r->hwctx) {
+        CudaFunctions *cu = r->hwctx->internal->cuda_dl;
+        CUcontext dummy;
+
+        CHECK_CU(cu->cuCtxPushCurrent(r->cu_ctx));
+        for (int i = 0; i < r->nimage; i++) {
+            FFRtxImage *img = &r->image[i];
+            if (img->tex)  CHECK_CU(cu->cuTexObjectDestroy(img->tex));
+            if (img->surf) rtx_surf_destroy(img->surf);
+            if (img->arr)  CHECK_CU(cu->cuArrayDestroy(img->arr));
+            if (img->ptr)  CHECK_CU(cu->cuMemFree(img->ptr));
+        }
+        if (r->arena)          CHECK_CU(cu->cuMemFree(r->arena));
+        if (r->arena_template) CHECK_CU(cu->cuMemFree(r->arena_template));
+        for (int i = 0; r->mod && i <= r->max_mid; i++)
+            if (r->mod[i]) CHECK_CU(cu->cuModuleUnload(r->mod[i]));
+        CHECK_CU(cu->cuCtxPopCurrent(&dummy));
+    }
+
+    av_freep(&r->mod);
+    av_freep(&r->fn);
+    av_freep(&r->alloc);
+    av_freep(&r->launches);
+    av_buffer_unref(&r->device_ref);
+    memset(r, 0, sizeof(*r));
+}
+
+enum { VAR_IN_W, VAR_IW, VAR_IN_H, VAR_IH, VAR_VARS_NB };
+static const char *const rtx_var_names[] = { "in_w", "iw", "in_h", "ih", NULL };
+
+int ff_rtx_eval_dims(AVFilterContext *ctx, AVFilterLink *inlink,
+                     const char *w_expr, const char *h_expr, int defscale,
+                     int *oW, int *oH)
+{
+    double var_values[VAR_VARS_NB], res;
+    int ret;
+
+    var_values[VAR_IN_W] = var_values[VAR_IW] = inlink->w;
+    var_values[VAR_IN_H] = var_values[VAR_IH] = inlink->h;
+
+    if (w_expr && *w_expr) {
+        if ((ret = av_expr_parse_and_eval(&res, w_expr, rtx_var_names, var_values,
+                                          NULL, NULL, NULL, NULL, NULL, 0, ctx)) < 0)
+            return ret;
+        *oW = (int)(res + 0.5);
+    } else {
+        *oW = inlink->w * defscale;
+    }
+    if (h_expr && *h_expr) {
+        if ((ret = av_expr_parse_and_eval(&res, h_expr, rtx_var_names, var_values,
+                                          NULL, NULL, NULL, NULL, NULL, 0, ctx)) < 0)
+            return ret;
+        *oH = (int)(res + 0.5);
+    } else {
+        *oH = inlink->h * defscale;
+    }
+    if (*oW < 1 || *oH < 1) {
+        av_log(ctx, AV_LOG_ERROR, "invalid output size %dx%d\n", *oW, *oH);
+        return AVERROR(EINVAL);
+    }
+    return 0;
+}
+
+/*   scale = f32(544)/f32(min(W,H));  q(v) = 32*floor(((double)(f32)(v*scale) + 24)/32) */
+static int rtx_nn_q(int v, float scale)
+{
+    float t = (float)v * scale;
+    double u = (double)t + 24.0;
+    return 32 * (int)floor(u / 32.0);
+}
+
+void ff_rtx_nn_dims(int W, int H, int *NW, int *NH)
+{
+    int mn = W < H ? W : H;
+    float scale = 544.0f / (float)mn;
+
+    *NW = rtx_nn_q(W, scale);
+    *NH = rtx_nn_q(H, scale);
+}
diff --git a/libavfilter/rtx_cuda.h b/libavfilter/rtx_cuda.h
new file mode 100644
index 0000000000..57d047600d
--- /dev/null
+++ b/libavfilter/rtx_cuda.h
@@ -0,0 +1,498 @@
+/*
+ * Shared core for the  CUDAfilters.
+ *
+ * This file is part of FFmpeg.
+ *
+ * FFmpeg is free software; you can redistribute it and/or
+ * modify it under the terms of the GNU Lesser General Public
+ * License as published by the Free Software Foundation; either
+ * version 2.1 of the License, or (at your option) any later version.
+ *
+ * FFmpeg is distributed in the hope that it will be useful,
+ * but WITHOUT ANY WARRANTY; without even the implied warranty of
+ * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
+ * Lesser General Public License for more details.
+ *
+ * You should have received a copy of the GNU Lesser General Public
+ * License along with FFmpeg; if not, write to the Free Software
+ * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
+ */
+
+/**
+ * @file
+ * Shared machinery for the filters that replay a captured   kernel graph:
+ * vf_vsr_cuda, vf_vsr_drv_cuda, vf_dlpp_drv_cuda, vf_deepdvc_drv_cuda,
+ * vf_truehdr_cuda, vf_truehdr_drv_cuda and vf_isr_cuda.
+ *
+ * All seven are 1:1 filters built the same way.  rtx-video-re emits a
+ * <feature>_cuda_gen.h describing one feature's graph -- which cubins to load,
+ * how big each scratch buffer is at a given frame size, where the weights go,
+ * and every launch's grid/block/argument block -- and the filter's job is to
+ * turn that into CUDA calls.  That job is the same every time: gate the GPU
+ * architecture, load the modules, lay out one contiguous arena, upload the
+ * weights, bind the input/output images, then replay the launch list once per
+ * frame.  This header is that job, written once.
+ *
+ * What stays in each vf_*.c is what genuinely differs: its AVOptions, which
+ * generated config the options select, the shape of its I/O binding, and the
+ * named tunable offsets it patches into the argument blocks.
+ *
+ * The generated headers are per-feature and expose everything as `static`, so
+ * this core never includes them.  Instead each filter passes its tables in
+ * through the layout-compatible views below, and calls its own generated fills
+ * behind the small callbacks these functions take.
+ */
+
+#ifndef AVFILTER_RTX_CUDA_H
+#define AVFILTER_RTX_CUDA_H
+
+#include <assert.h>
+#include <stddef.h>
+#include <stdint.h>
+
+#include "libavutil/cuda_check.h"
+#include "libavutil/hwcontext.h"
+#include "libavutil/hwcontext_cuda_internal.h"
+#include "libavutil/pixfmt.h"
+
+#include "avfilter.h"
+
+/* Constants ffnvcodec's dynlink headers do not carry.  Everything else these
+ * filters need -- cuTexObjectCreate, cuArray3DCreate, cuMemAllocPitch,
+ * cuMemsetD2D16Async, cuMemcpyDtoDAsync, the CU_AD_FORMAT_* enumerators for the
+ * standard types -- is already in CudaFunctions / dynlink_cuda.h. */
+#ifndef CU_TRSF_NORMALIZED_COORDINATES
+#define CU_TRSF_NORMALIZED_COORDINATES 0x02
+#endif
+#ifndef CU_AD_FORMAT_UNORM_INT16X4
+#define CU_AD_FORMAT_UNORM_INT16X4 ((CUarray_format)0xc5)
+#endif
+#ifndef CU_AD_FORMAT_UNORM_INT_101010_2
+#define CU_AD_FORMAT_UNORM_INT_101010_2 ((CUarray_format)0x50)
+#endif
+/* cuLaunchKernel packed-argument sentinels. */
+#ifndef CU_LAUNCH_PARAM_END
+#define CU_LAUNCH_PARAM_END            ((void*)0x00)
+#define CU_LAUNCH_PARAM_BUFFER_POINTER ((void*)0x01)
+#define CU_LAUNCH_PARAM_BUFFER_SIZE    ((void*)0x02)
+#endif
+
+/* cuSurfObjectCreate/Destroy are the one pair ffnvcodec's loader does not
+ * export, so they are resolved out of libcuda directly -- once per process,
+ * inside this core, rather than once per filter instance. */
+typedef unsigned long long FFCUsurfObject;
+
+/* ------------------------------------------------------------------------- *
+ * Layout-compatible views of the generated tables.
+ *
+ * Every <feature>_cuda_gen.h emits its module, function and upload records with
+ * the same layout under a per-feature struct name, and its launch record with a
+ * common leading sequence (the trailing params[] array is sized per feature).
+ * The core works through these views; each filter casts its own tables and
+ * proves the cast with FF_RTX_ASSERT_*_LAYOUT, so a generator change that broke
+ * the assumption would fail the build rather than corrupt a launch.
+ * ------------------------------------------------------------------------- */
+typedef struct FFRtxModule { int mid; const char *file; } FFRtxModule;
+typedef struct FFRtxFunc   { int fid, mid; const char *name; } FFRtxFunc;
+typedef struct FFRtxUpload { long long file_off, size; uint64_t dst; } FFRtxUpload;
+
+typedef struct FFRtxLaunch {
+    int      fnid, argsize, psize;
+    unsigned grid[3], block[3], smem;
+    uint8_t  params[];
+} FFRtxLaunch;
+
+#define FF_RTX_ASSERT_FIELD(T, U, f) \
+    static_assert(offsetof(T, f) == offsetof(U, f) && \
+                  sizeof(((T *)0)->f) == sizeof(((U *)0)->f), \
+                  #T "." #f " does not match " #U)
+
+#define FF_RTX_ASSERT_MODULE_LAYOUT(T) \
+    static_assert(sizeof(T) == sizeof(FFRtxModule), #T " is not FFRtxModule-shaped")
+#define FF_RTX_ASSERT_FUNC_LAYOUT(T) \
+    static_assert(sizeof(T) == sizeof(FFRtxFunc), #T " is not FFRtxFunc-shaped"); \
+    FF_RTX_ASSERT_FIELD(T, FFRtxFunc, fid); \
+    FF_RTX_ASSERT_FIELD(T, FFRtxFunc, mid); \
+    FF_RTX_ASSERT_FIELD(T, FFRtxFunc, name)
+#define FF_RTX_ASSERT_UPLOAD_LAYOUT(T) \
+    static_assert(sizeof(T) == sizeof(FFRtxUpload), #T " is not FFRtxUpload-shaped"); \
+    FF_RTX_ASSERT_FIELD(T, FFRtxUpload, file_off); \
+    FF_RTX_ASSERT_FIELD(T, FFRtxUpload, size); \
+    FF_RTX_ASSERT_FIELD(T, FFRtxUpload, dst)
+/* The launch view is a prefix, not the whole struct -- params[] is sized per
+ * feature -- so this checks the leading sequence plus where params[] starts. */
+#define FF_RTX_ASSERT_LAUNCH_LAYOUT(T) \
+    FF_RTX_ASSERT_FIELD(T, FFRtxLaunch, fnid); \
+    FF_RTX_ASSERT_FIELD(T, FFRtxLaunch, argsize); \
+    FF_RTX_ASSERT_FIELD(T, FFRtxLaunch, psize); \
+    FF_RTX_ASSERT_FIELD(T, FFRtxLaunch, grid); \
+    FF_RTX_ASSERT_FIELD(T, FFRtxLaunch, block); \
+    FF_RTX_ASSERT_FIELD(T, FFRtxLaunch, smem); \
+    static_assert(offsetof(T, params) == sizeof(FFRtxLaunch), \
+                  #T ".params does not follow the FFRtxLaunch prefix")
+
+/* ------------------------------------------------------------------------- *
+ * Pixel formats
+ * ------------------------------------------------------------------------- */
+/**
+ * A frame format the graph can be bound to.  @p sel is the kernel's own format
+ * selector where the network has one (VSR/DLPP: 0 = raw 8-bit RGB order,
+ * 1 = raw 8-bit with an R<->B swap, 2 = the format-agnostic tex.f32 read /
+ * sust.p store that packs any UNORM array in its native order); features
+ * without a selector leave it 0, or reuse the field for their own flag.
+ */
+typedef struct FFRtxPixFmt {
+    enum AVPixelFormat f;
+    CUarray_format     cufmt;
+    int                bpp;
+    int                sel;
+} FFRtxPixFmt;
+
+/* The packed-RGB formats the VSR-family networks accept.  The R<->B swap only
+ * exists on the raw 8-bit path, so B-first formats are 8-bit only; higher bit
+ * depths go through the native-order sel-2 path.  A feature whose selector is
+ * not mapped cannot honour sel at all, so it takes only the R-first 8-bit rows
+ * (FF_RTX_N_RGB8_R_FIRST): feeding it a B-first frame would drive the network
+ * with red and blue transposed. */
+extern const FFRtxPixFmt ff_rtx_packed_rgb_fmts[5];
+#define FF_RTX_N_RGB8_R_FIRST 2
+
+const FFRtxPixFmt *ff_rtx_find_fmt(const FFRtxPixFmt *tbl, int n,
+                                   enum AVPixelFormat f);
+
+/* ------------------------------------------------------------------------- *
+ * Runtime state
+ * ------------------------------------------------------------------------- */
+/**
+ * One image the graph binds: a CUDA array or a linear/pitched allocation, with
+ * the bindless texture and/or surface handle over it.  Only the members the
+ * requested binding needs are set; the rest stay zero.
+ */
+typedef struct FFRtxImage {
+    CUarray        arr;    ///< set for array-backed images
+    CUdeviceptr    ptr;    ///< set for pitched/linear images
+    size_t         pitch;  ///< row stride of @ref ptr
+    CUtexObject    tex;
+    FFCUsurfObject surf;
+} FFRtxImage;
+
+#define FF_RTX_MAX_IMAGES 8
+
+/**
+ * Everything the core allocates for one configured graph.  Embed this in the
+ * filter's private context and pass its address to every ff_rtx_* call;
+ * ff_rtx_free_graph() releases all of it.
+ */
+typedef struct FFRtxCuda {
+    AVCUDADeviceContext *hwctx;
+    AVBufferRef         *device_ref;
+    CUcontext            cu_ctx;
+    CUstream             stream;
+
+    CUmodule            *mod;            ///< [max_mid + 1], indexed by mid
+    CUfunction          *fn;             ///< [max_fid + 1], indexed by fid
+    int                  max_mid, max_fid;
+
+    CUdeviceptr          arena;          ///< one contiguous block, sub-allocated
+    CUdeviceptr          arena_template; ///< pristine copy of the uploaded prefix
+    size_t               arena_size;
+    size_t               arena_uploaded;  ///< bytes from arena start covered by uploads
+    CUdeviceptr         *alloc;          ///< [nalloc] pointers into @ref arena
+    int                  nalloc;
+
+    void                *launches;       ///< the feature's own launch array
+    int                  nlaunch;
+    size_t               launch_size;    ///< sizeof one element of @ref launches
+
+    FFRtxImage           image[FF_RTX_MAX_IMAGES];
+    int                  nimage;
+
+    int                  ready;          ///< the graph is built and replayable
+} FFRtxCuda;
+
+/** The launch at index @p i of a graph built by ff_rtx_alloc_launches(). */
+static inline FFRtxLaunch *ff_rtx_launch_at(const FFRtxCuda *r, int i)
+{
+    return (FFRtxLaunch *)((uint8_t *)r->launches + (size_t)i * r->launch_size);
+}
+
+/**
+ * Every filter in the family embeds FFRtxCuda directly after its AVClass
+ * pointer, so one uninit serves them all.  FF_RTX_ASSERT_PRIV_LAYOUT proves the
+ * layout per filter, so a context that grew a member in front would fail the
+ * build rather than free the wrong bytes.
+ */
+typedef struct FFRtxPriv {
+    const AVClass *class;
+    FFRtxCuda      r;
+} FFRtxPriv;
+
+#define FF_RTX_ASSERT_PRIV_LAYOUT(T) \
+    static_assert(offsetof(T, r) == offsetof(FFRtxPriv, r), \
+                  #T ".r is not where FFRtxPriv.r is")
+
+void ff_rtx_uninit(AVFilterContext *ctx);
+
+/* ------------------------------------------------------------------------- *
+ * Device binding and output plumbing
+ * ------------------------------------------------------------------------- */
+/**
+ * The formats a filter accepts, for ff_rtx_config_formats().
+ */
+typedef struct FFRtxFormats {
+    const FFRtxPixFmt *in_tbl;
+    int                n_in;
+    const FFRtxPixFmt *out_tbl;    ///< NULL: the output is always the input format
+    int                n_out;
+    const char        *out_format; ///< the `format` option; NULL/empty = same as input
+    const char        *hint;       ///< appended to a rejection, e.g. "use rgb0/rgba"
+} FFRtxFormats;
+
+/**
+ * The config_output prologue every filter shares: require a CUDA hwframe input,
+ * look its sw_format up in the input table, and resolve the output format --
+ * the `format` option when set, else the input format -- in the output table.
+ * @p outpf may be NULL for a filter whose output format is its input format.
+ */
+int ff_rtx_config_formats(AVFilterContext *ctx, AVFilterLink *inlink,
+                          const FFRtxFormats *f,
+                          AVHWFramesContext **in_frames_ctx,
+                          const FFRtxPixFmt **inpf, const FFRtxPixFmt **outpf);
+
+/**
+ * Take a reference on the input frames context's device and cache the CUDA
+ * context and stream.  Must be called before anything else touches @p r.
+ */
+int ff_rtx_bind_device(AVFilterContext *ctx, FFRtxCuda *r,
+                       AVHWFramesContext *in_frames_ctx);
+
+/**
+ * Set the output link's size and build its CUDA frames context.  Call after
+ * ff_rtx_bind_device() and before ff_rtx_setup().
+ */
+int ff_rtx_config_hwframes(AVFilterContext *ctx, AVFilterLink *outlink,
+                           FFRtxCuda *r, int oW, int oH,
+                           enum AVPixelFormat sw_format);
+
+/**
+ * Push the CUDA context, run @p setup_graph, pop it again.  @p what names the
+ * graph in the failure message.
+ */
+int ff_rtx_setup(AVFilterContext *ctx, FFRtxCuda *r, const char *what,
+                 int (*setup_graph)(AVFilterContext *ctx));
+
+/* ------------------------------------------------------------------------- *
+ * Graph setup (all of these need the CUDA context current)
+ * ------------------------------------------------------------------------- */
+/**
+ * How far a feature's cubins have been validated.  The shared policy is that
+ * Blackwell (cc 12.x) and Ada (cc 8.9) run ungated -- those are the two the
+ * cubins were checked byte-exact on -- and every other architecture needs
+ * experimental_arch, because its images were matched statically rather than
+ * exercised.  What differs per feature is the wording and whether there is a
+ * floor below which no image exists at all.
+ */
+typedef struct FFRtxArchGate {
+    int         hard_min_major; ///< refuse cc_major below this outright; 0 = no floor
+    const char *hard_msg;       ///< printf'd with cc_major, cc_minor
+    const char *gate_msg;       ///< refusal when unvalidated and not opted in
+    const char *warn_msg;       ///< warning when running the opted-in path
+} FFRtxArchGate;
+
+int ff_rtx_arch_gate(AVFilterContext *ctx, FFRtxCuda *r,
+                     const FFRtxArchGate *gate, int experimental);
+
+/**
+ * Load every cubin named by @p mods out of @p dir and resolve every kernel in
+ * @p funcs, into r->mod[]/r->fn[] sized for @p max_mid / @p max_fid.
+ * @p load_hint, if set, is appended to a module-load failure (which is nearly
+ * always "this data dir has no image for the running GPU").
+ */
+int ff_rtx_load_modules(AVFilterContext *ctx, FFRtxCuda *r, const char *dir,
+                        const FFRtxModule *mods, int nmod, int max_mid,
+                        const FFRtxFunc *funcs, int nfunc, int max_fid,
+                        const char *load_hint);
+
+#define FF_RTX_ARENA_ZERO 1  ///< memset the arena before the weights land in it
+
+/**
+ * Allocate the graph's scratch and weight buffers as ONE contiguous arena and
+ * hand out r->alloc[0..nalloc-1] into it.
+ *
+ * @p fill_sizes is the feature's generated allocation model: it writes the
+ * largest size asked for each ordinal, as the driver's own allocator does.
+ *
+ * Contiguity is load-bearing, not tidiness: several kernels do a tile/halo read
+ * a little past the logical end of their input buffer.  That is harmless while
+ * the following bytes are mapped, which inside one arena they always are (an
+ * adjacent buffer, or the trailing guard).  With a separate allocation per
+ * buffer they scatter, and after a filter-graph rebuild (an mpv seek, say) the
+ * heap fragments until the bytes past a buffer are an unmapped hole -- turning
+ * the benign over-read into a CUDA_ERROR_ILLEGAL_ADDRESS that poisons the
+ * context.
+ */
+int ff_rtx_alloc_arena(AVFilterContext *ctx, FFRtxCuda *r, int nalloc,
+                       void (*fill_sizes)(AVFilterContext *ctx, long long *sz),
+                       unsigned flags);
+
+/**
+ * Arrange for ff_rtx_reset_arena() to restore the arena to its post-upload
+ * state.  For graphs that read scratch before writing it: a fresh process gets
+ * zeroed pages from cuMemAlloc and is byte-exact, but a long-running host
+ * recycles dirty memory, so the arena has to be put back between frames.
+ *
+ * Only the uploaded prefix is snapshotted.  ff_rtx_alloc_arena() zeroed the
+ * whole arena and the uploads then wrote a prefix of it, so everything past the
+ * last uploaded byte is known to be zero -- the reset can memset it instead of
+ * copying it back, which is bit-identical and much cheaper (a device-to-device
+ * copy reads and writes, a memset only writes).  Call after the uploads.
+ */
+int ff_rtx_snapshot_arena(AVFilterContext *ctx, FFRtxCuda *r);
+int ff_rtx_reset_arena(AVFilterContext *ctx, FFRtxCuda *r);
+
+/**
+ * Map @p dir/@p file and run every upload in @p up into the arena.  One
+ * weights blob per data dir holds each distinct payload exactly once -- the
+ * qualities of a feature share most layers, and the driver plugins share all of
+ * them -- so a config's uploads index into it by the generated file offset.
+ */
+int ff_rtx_upload_weights(AVFilterContext *ctx, FFRtxCuda *r, const char *dir,
+                          const char *file, const FFRtxUpload *up, int nup);
+
+/** Allocate the launch array the feature's fill_graph() will populate. */
+int ff_rtx_alloc_launches(AVFilterContext *ctx, FFRtxCuda *r,
+                          int nlaunch, size_t launch_size);
+
+/* Image binding flags. */
+#define FF_RTX_TEX   (1 << 0)  ///< create a bindless texture over the image
+#define FF_RTX_SURF  (1 << 1)  ///< create a bindless surface over the image
+#define FF_RTX_LDST  (1 << 2)  ///< array is SURFACE_LDST capable
+#define FF_RTX_CLAMP (1 << 3)  ///< texture address mode CLAMP (else the default WRAP)
+#define FF_RTX_ZERO  (1 << 4)  ///< zero the backing store (pitched images only)
+
+/**
+ * Bind a W x H image the graph can read and/or write.  Textures are always
+ * created linear-filtered with normalized coordinates, which is what the
+ * captured graphs sample with.
+ *
+ * ff_rtx_image_array()  -- a CUDA array, the usual input texture / output surface
+ * ff_rtx_image_pitch()  -- pitched linear memory bound as a PITCH2D texture
+ * ff_rtx_image_linear() -- a plain packed buffer, no texture or surface
+ *
+ * The returned pointer is owned by @p r and stays valid until
+ * ff_rtx_free_graph(); NULL means the image could not be created (the reason is
+ * already logged).
+ */
+FFRtxImage *ff_rtx_image_array(AVFilterContext *ctx, FFRtxCuda *r, int W, int H,
+                               CUarray_format cufmt, unsigned flags);
+FFRtxImage *ff_rtx_image_pitch(AVFilterContext *ctx, FFRtxCuda *r, int W, int H,
+                               CUarray_format cufmt, int bpp, unsigned flags);
+FFRtxImage *ff_rtx_image_linear(AVFilterContext *ctx, FFRtxCuda *r,
+                                size_t size, size_t pitch);
+
+/**
+ * Index of the first launch running kernel @p name, or -1.  For the features
+ * whose generated config does not yet carry the launch index of a tunable's
+ * kernel the way VSR's sel_launch does.
+ */
+int ff_rtx_find_launch(const FFRtxCuda *r, const FFRtxFunc *funcs, int nfunc,
+                       const char *name);
+/** As ff_rtx_find_launch(), matching a kernel-name prefix. */
+int ff_rtx_find_launch_prefix(const FFRtxCuda *r, const FFRtxFunc *funcs, int nfunc,
+                              const char *prefix);
+
+/* ------------------------------------------------------------------------- *
+ * Per-frame replay
+ * ------------------------------------------------------------------------- */
+/* ff_rtx_filter_frame() flags. */
+#define FF_RTX_OP_PSIZE        (1 << 0)  ///< launch with the kernel's own cbank size
+#define FF_RTX_OP_RESET_ARENA  (1 << 1)  ///< restore the pristine arena before each frame
+#define FF_RTX_OP_OPAQUE_ALPHA (1 << 2)  ///< force opaque alpha over the output
+
+/**
+ * What one frame through a configured graph consists of.  in_img and out_img
+ * are the same image for a filter that works in place.
+ */
+typedef struct FFRtxFrameOp {
+    const FFRtxImage *in_img, *out_img;
+    int iW, iH, ibpp;
+    int oW, oH, obpp;
+    unsigned flags;
+    /** Replace ff_rtx_launch_all() -- for a graph the launch list cannot
+     *  describe on its own, like ISR's per-tile pointer cursor. */
+    int (*run)(AVFilterContext *ctx);
+} FFRtxFrameOp;
+
+/**
+ * One whole frame: take the output buffer, copy the input frame's properties,
+ * push the CUDA context, replay the graph over the frame, pop, and forward the
+ * result.  @p retag, if set, adjusts the output frame's properties (the TrueHDR
+ * filters retag SDR input as HDR) before the graph runs.  Consumes @p in.
+ */
+int ff_rtx_filter_frame(AVFilterLink *inlink, AVFrame *in, FFRtxCuda *r,
+                        const FFRtxFrameOp *op,
+                        void (*retag)(AVFilterContext *ctx, AVFrame *out));
+
+/** Issue one launch.  @p params is its argument block, @p psize its cbank size. */
+int ff_rtx_launch(AVFilterContext *ctx, FFRtxCuda *r, int fnid,
+                  const unsigned grid[3], const unsigned block[3], unsigned smem,
+                  void *params, size_t psize);
+
+/**
+ * Issue the whole launch list in order.  @p use_psize selects the kernel's own
+ * EIATTR_CBANK_PARAM_SIZE rather than the captured driver argsize -- the driver
+ * over-reports for some DLPP tex/surf kernels, which makes cuLaunchKernel fail
+ * with CUDA_ERROR_LAUNCH_OUT_OF_RESOURCES.
+ */
+int ff_rtx_launch_all(AVFilterContext *ctx, FFRtxCuda *r, int use_psize);
+
+/** Copy a pitched input frame into the graph's input image. */
+int ff_rtx_frame_to_image(AVFilterContext *ctx, FFRtxCuda *r, const AVFrame *in,
+                          const FFRtxImage *img, int W, int H, int bpp);
+/** Copy the graph's output image back out into a pitched frame. */
+int ff_rtx_image_to_frame(AVFilterContext *ctx, FFRtxCuda *r,
+                          const FFRtxImage *img, AVFrame *out,
+                          int W, int H, int bpp);
+
+/**
+ * Force opaque alpha over @p out.  The resample store kernel
+ * (dlpp_ResampleAndComposeFP16) omits the alpha write in its formatted path --
+ * unlike postProcess, which stores 1.0 -- so >= 10-bit output on the resample
+ * path would come out fully transparent (RGB is correct; verified in SASS, and
+ * the SDK DLL has the same omission).  These networks always produce opaque
+ * output, so this runs for any sel-2 output: it fixes the resample case and is
+ * a harmless no-op on the fast path.
+ */
+int ff_rtx_fill_opaque_alpha(AVFilterContext *ctx, FFRtxCuda *r, AVFrame *out,
+                             int oW, int oH, int bpp);
+
+/* ------------------------------------------------------------------------- *
+ * Teardown and helpers
+ * ------------------------------------------------------------------------- */
+/**
+ * Release everything ff_rtx_* built, against the CUDA context it was built on,
+ * and reset @p r so a graph can be built again.  Safe when nothing is
+ * configured.  config_output() may run more than once -- a mid-stream
+ * reconfigure, or a media player rebuilding its filter graph on seek -- so this
+ * must leave no leaked allocation and no stale device pointer baked into a
+ * launch argument block.
+ */
+void ff_rtx_free_graph(AVFilterContext *ctx, FFRtxCuda *r);
+
+/**
+ * Evaluate the `w`/`h` output-size expressions over in_w/iw/in_h/ih.  An unset
+ * or empty expression means @p defscale x the input.
+ */
+int ff_rtx_eval_dims(AVFilterContext *ctx, AVFilterLink *inlink,
+                     const char *w_expr, const char *h_expr, int defscale,
+                     int *oW, int *oH);
+
+/**
+ * TrueHDR's internal network resolution: shorter side -> 544, longer side
+ * aspect-scaled and quantized to a multiple of 32.  Must bit-match the float32
+ * arithmetic of rtxv.fit.truehdr.nn_dims (verified byte-exact across 28
+ * resolutions).
+ */
+void ff_rtx_nn_dims(int W, int H, int *NW, int *NH);
+
+#endif /* AVFILTER_RTX_CUDA_H */
diff --git a/libavfilter/rtx_dlpp_abi.h b/libavfilter/rtx_dlpp_abi.h
new file mode 100644
index 0000000000..207bd962b1
--- /dev/null
+++ b/libavfilter/rtx_dlpp_abi.h
@@ -0,0 +1,102 @@
+/*
+ * The DLPP kernel ABI, shared by the two filters that drive those kernels.
+ *
+ * This file is part of FFmpeg.
+ *
+ * FFmpeg is free software; you can redistribute it and/or
+ * modify it under the terms of the GNU Lesser General Public
+ * License as published by the Free Software Foundation; either
+ * version 2.1 of the License, or (at your option) any later version.
+ *
+ * FFmpeg is distributed in the hope that it will be useful,
+ * but WITHOUT ANY WARRANTY; without even the implied warranty of
+ * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
+ * Lesser General Public License for more details.
+ *
+ * You should have received a copy of the GNU Lesser General Public
+ * License along with FFmpeg; if not, write to the Free Software
+ * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
+ */
+
+/**
+ * @file
+ * vf_vsr_drv_cuda and vf_dlpp_drv_cuda replay two different driver plugins, but
+ * the glue kernels around their networks are literally the same kernels -- the
+ * DLPP pre/post-process and resample-and-compose -- so the argument-block
+ * offsets of the format selectors are one ABI, not two.  They were captured
+ * once; this is where they live, so a re-capture cannot update one filter and
+ * leave the other patching a stale offset.
+ *
+ * What stays per filter is what genuinely differs: which tunables that filter
+ * exposes and where they sit (vsr_drv's detail/smooth on preProcess, dlpp_drv's
+ * wipe on the SR head).
+ */
+
+#ifndef AVFILTER_RTX_DLPP_ABI_H
+#define AVFILTER_RTX_DLPP_ABI_H
+
+#include <stdint.h>
+#include <string.h>
+
+#include "avfilter.h"
+#include "rtx_cuda.h"
+
+/* The input kernel, and the two alternative output-store kernels: the fast path
+ * ends in postProcess, the resample path in ResampleAndComposeFP16. */
+#define FF_DLPP_PRE_KERNEL       "dlpp_preProcess"
+#define FF_DLPP_POST_KERNEL      "dlpp_postProcess"
+#define FF_DLPP_RESAMPLE_KERNEL  "dlpp_ResampleAndComposeFP16"
+
+/* Format-selector offsets in each kernel's params block. */
+#define FF_DLPP_PRE_FMT_OFF      0x30
+#define FF_DLPP_POST_FMT_OFF     0x40
+#define FF_DLPP_RESAMPLE_FMT_OFF 0x50
+
+/**
+ * Patch the input and output format selectors of a DLPP-family graph.
+ *
+ * The captured argbufs carry sel 0 (RGBA8); a chosen format that is not sel 0
+ * needs the kernel told, so a selector that cannot be found is a bug in the
+ * generated tables rather than something to skip -- silently leaving sel 0 in
+ * place would emit a whole encode with red and blue transposed.
+ *
+ * @param pre_out receives the preProcess launch index, which is also where both
+ *                filters' own preProcess tunables live; -1 when there is none
+ *                and the format did not need one.
+ */
+static inline int ff_dlpp_patch_selectors(AVFilterContext *ctx, FFRtxCuda *r,
+                                          const FFRtxFunc *funcs, int nfunc,
+                                          const FFRtxPixFmt *inpf,
+                                          const FFRtxPixFmt *outpf,
+                                          const char *tag, int *pre_out)
+{
+    int pre   = ff_rtx_find_launch(r, funcs, nfunc, FF_DLPP_PRE_KERNEL);
+    int store = ff_rtx_find_launch(r, funcs, nfunc, FF_DLPP_POST_KERNEL);
+    int store_fmt_off = FF_DLPP_POST_FMT_OFF;
+
+    if (store < 0) {
+        store = ff_rtx_find_launch(r, funcs, nfunc, FF_DLPP_RESAMPLE_KERNEL);
+        store_fmt_off = FF_DLPP_RESAMPLE_FMT_OFF;
+    }
+    *pre_out = pre;
+
+    if (inpf->sel) {
+        uint32_t sel = inpf->sel;
+        if (pre < 0) {
+            av_log(ctx, AV_LOG_ERROR, "no input pre-process kernel for config %s\n", tag);
+            return AVERROR_BUG;
+        }
+        memcpy(ff_rtx_launch_at(r, pre)->params + FF_DLPP_PRE_FMT_OFF, &sel, 4);
+    }
+    if (outpf->sel) {
+        uint32_t sel = outpf->sel;
+        if (store < 0) {
+            av_log(ctx, AV_LOG_ERROR, "no output-store kernel for config %s\n", tag);
+            return AVERROR_BUG;
+        }
+        memcpy(ff_rtx_launch_at(r, store)->params + store_fmt_off, &sel, 4);
+    }
+    return 0;
+}
+
+#endif /* AVFILTER_RTX_DLPP_ABI_H */


------


    avfilter: add vsr_drv_cuda, the driver RTX VSR network
    
    This is a newer and heavier network over the same DLPP kernels,
    with its own quality levels and tunables, and it is worth having both: they do
    not produce the same picture.
    
    The driver numbers its networks 0-4, but they are not ordered by strength and
    index 0 is a byte-identical duplicate of index 4.  Only 1-4 are exposed here:
    one network reachable under two numbers is a usability trap, not a feature.  By
    fidelity the order runs q1 (most faithful) > q3 > q4 > q2 (most aggressive
    detail synthesis), so the default is q1.
    
    Two things differ from vsr_cuda beyond the tables, and both are visible here:
    each launch is issued with the kernel's own EIATTR_CBANK_PARAM_SIZE rather than
    the captured driver argsize, because the driver over-reports by 8 bytes for the
    two DLPP tex/surf kernels and cuLaunchKernel then fails with
    CUDA_ERROR_LAUNCH_OUT_OF_RESOURCES; and the graph has only two bindless slots in
    total -- the input texture at dlpp_preProcess and the output surface at
    dlpp_postProcess or ResampleAndComposeFP16 -- with no internal surfaces.
    
    The graph super-resolves 2x internally: an exact isotropic 2x output stores
    directly, anything else composes to the requested rectangle.
---
 configure                     |   1 +
 doc/filters.texi              |  77 ++++++++++
 libavfilter/Makefile          |   1 +
 libavfilter/allfilters.c      |   1 +
 libavfilter/vf_vsr_drv_cuda.c | 350 ++++++++++++++++++++++++++++++++++++++++++
 5 files changed, 430 insertions(+)

diff --git a/configure b/configure
index f8b1e2ba2b..32ed6f6836 100755
--- a/configure
+++ b/configure
@@ -4324,6 +4324,7 @@ scale_vulkan_filter_deps="vulkan spirv_compiler swscale"
 vpp_qsv_filter_deps="libmfx"
 vpp_qsv_filter_select="qsvvpp"
 vsr_cuda_filter_deps="ffnvcodec nvfdata_vsr"
+vsr_drv_cuda_filter_deps="ffnvcodec nvfdata_vsr_drv"
 xfade_opencl_filter_deps="opencl"
 xfade_vulkan_filter_deps="vulkan spirv_compiler"
 yadif_cuda_filter_deps="ffnvcodec"
diff --git a/doc/filters.texi b/doc/filters.texi
index ee0fdf2236..d7870e6827 100644
--- a/doc/filters.texi
+++ b/doc/filters.texi
@@ -28014,6 +28014,83 @@ ingest @strong{YCbCr only}.  The Vulkan encoders reject every RGB pixel format
 likewise takes @code{nv12}/@code{p010}, so @code{vsr_cuda}'s RGB output cannot be
 fed to an encoder directly.
 
+@anchor{vsr_drv_cuda}
+@section vsr_drv_cuda
+
+Upscale video with the   driver's   Super Resolution network,
+running it directly on CUDA.
+
+This is the driver's AIVP plugin, not the NGX SDK network that @ref{vsr_cuda}
+drives -- a newer and heavier network over the same underlying kernels.  The
+two do not produce the same picture, and neither is uniformly better, so it is
+worth comparing them on your own content.  @code{dlpp_drv_cuda} is a third
+option again.
+
+The graph super-resolves 2x internally.  An exact isotropic 2x output stores
+directly; any other size resamples that result to the requested rectangle with
+a bicubic compose.
+
+It accepts the following options:
+
+@table @option
+@item quality
+Which of the driver's four networks to run, @code{1} to @code{4}.  Default
+@code{1}.
+
+They are @strong{not} ordered by strength.  By fidelity, from the most faithful
+to the most aggressive at synthesizing detail, the order is @code{1}, @code{3},
+@code{4}, @code{2}.  The default @code{1} is the least grainy and the closest
+to a faithful upscale; @code{2} invents the most.
+
+@item detail
+@item smooth
+Perceptual pre-processing of the input, each @code{0} to @code{16} and
+defaulting to @code{0}, which is neutral and byte-exact against the driver.
+@option{detail} raises high-frequency content and @option{smooth} lowers it --
+an unsharp/denoise pair applied before the network.  They tune the look, not
+the fidelity.
+
+@item w
+@item h
+Output width and height, as expressions (as in @ref{scale}); the variables
+@var{iw}/@var{in_w} and @var{ih}/@var{in_h} hold the input size.  Defaults
+@code{iw*2} and @code{ih*2}.
+
+@item format
+Output pixel format.  Empty (the default) keeps the input format.
+
+@item data
+Directory holding the extracted cubins and the shared @file{weights.bin}.
+
+@item experimental_arch
+Allow GPU architectures whose cubins were matched statically rather than
+exercised.  Ada (sm_89) and Blackwell do not need this.  Turing and older
+cannot run this network at all -- its convolution kernels need sm_80 tensor
+cores -- and are refused unconditionally.
+@end table
+
+@subsection Supported formats
+
+Packed RGB formats are accepted for both input and output: @code{rgb0},
+@code{rgba}, @code{bgr0}, @code{bgra} (8-bit) and @code{rgba64le} (16-bit).
+Input and output formats are chosen independently (see the @option{format}
+option).  16-bit carries the network's full internal precision and avoids
+banding.
+
+The kernels branch on a format selector that exposes an R@math{<->}B swap only
+on the 8-bit path, so the B-first @code{bgr0}/@code{bgra} are handled natively.
+That swap does not exist on the high-bit-depth path, which packs in array-native
+order, so 16-bit is R-first only (@code{rgba64le}).
+
+This filter does @strong{not} do YUV@math{<->}RGB conversion or tone mapping;
+see @ref{vsr_cuda} for the @code{libplacebo} pipeline that feeds these filters
+from real video and for the hardware decode/encode combinations.
+
+The cubins and weights are extracted from the open-sourced; conference shared   libraries and
+are @emph{not} shipped: the filter is only built when an
+@code{ -video-filters} package carrying the driver VSR data is installed, and
+@option{data} defaults to that package's data directory.
+
 @section yadif_cuda
 
 Deinterlace the input video using the @ref{yadif} algorithm, but implemented
diff --git a/libavfilter/Makefile b/libavfilter/Makefile
index 9f955565b2..ffba98faca 100644
--- a/libavfilter/Makefile
+++ b/libavfilter/Makefile
@@ -577,6 +577,7 @@ OBJS-$(CONFIG_FRC_AMF_FILTER)                += vf_frc_amf.o vf_amf_common.o
 OBJS-$(CONFIG_VQE_AMF_FILTER)                += vf_vqe_amf.o vf_amf_common.o
 OBJS-$(CONFIG_VPP_QSV_FILTER)                += vf_vpp_qsv.o
 OBJS-$(CONFIG_VSR_CUDA_FILTER)               += vf_vsr_cuda.o rtx_cuda.o
+OBJS-$(CONFIG_VSR_DRV_CUDA_FILTER)           += vf_vsr_drv_cuda.o rtx_cuda.o
 OBJS-$(CONFIG_VSTACK_FILTER)                 += vf_stack.o framesync.o
 OBJS-$(CONFIG_W3FDIF_FILTER)                 += vf_w3fdif.o
 OBJS-$(CONFIG_WAVEFORM_FILTER)               += vf_waveform.o
diff --git a/libavfilter/allfilters.c b/libavfilter/allfilters.c
index 35629fe1c3..7e4bc775f5 100644
--- a/libavfilter/allfilters.c
+++ b/libavfilter/allfilters.c
@@ -541,6 +541,7 @@ extern const FFFilter ff_vf_vignette;
 extern const FFFilter ff_vf_vmafmotion;
 extern const FFFilter ff_vf_vpp_qsv;
 extern const FFFilter ff_vf_vsr_cuda;
+extern const FFFilter ff_vf_vsr_drv_cuda;
 extern const FFFilter ff_vf_vstack;
 extern const FFFilter ff_vf_w3fdif;
 extern const FFFilter ff_vf_waveform;
diff --git a/libavfilter/vf_vsr_drv_cuda.c b/libavfilter/vf_vsr_drv_cuda.c
new file mode 100644
index 0000000000..62fb7f7b49
--- /dev/null
+++ b/libavfilter/vf_vsr_drv_cuda.c
@@ -0,0 +1,350 @@
+/*
+ *  
+ *
+ * This file is part of FFmpeg.
+ *
+ * FFmpeg is free software; you can redistribute it and/or
+ * modify it under the terms of the GNU Lesser General Public
+ * License as published by the Free Software Foundation; either
+ * version 2.1 of the License, or (at your option) any later version.
+ *
+ * FFmpeg is distributed in the hope that it will be useful,
+ * but WITHOUT ANY WARRANTY; without even the implied warranty of
+ * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
+ * Lesser General Public License for more details.
+ *
+ * You should have received a copy of the GNU Lesser General Public
+ * License along with FFmpeg; if not, write to the Free Software
+ * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
+ */
+
+/**
+ * @file
+ * Super-resolution filter driving the Super Resolution
+ * network (the DXVA/PPE plugin nvaivpx.dll, ppe/features/AIVP) -- distinct from
+ * vf_vsr_cuda, which runs the NGX SDK snippet. The driver graph
+ * is a newer/heavier network; . vsr_drv_cuda_gen.h encodes,
+ * per quality and scaling path, how the whole graph (grids, scratch allocations,
+ * packed arg-buffer scalars incl. division-magic constants and float32 resample
+ * steps, weight-upload targets, pointer fixups) scales with the input W,H and
+ * output oW,oH
+ * The filter evaluates that at config time and replays the graph with libcuda; no
+ * DLL is needed at run time.  The replay machinery itself is rtx_cuda.c.
+ *
+ * The graph performs a fixed internal 2x super-resolution.  Exact isotropic 2x
+ * output takes the "fast" path (direct dlpp_postProcess store); any other factor
+ * takes the "resample" path (dlpp_ResampleAndComposeFP16 to the requested rect).
+ *
+ * Differences from vf_vsr_cuda:
+ *   - Each launch is issued with the kernel's EIATTR_CBANK_PARAM_SIZE (psize) as
+ *     CU_LAUNCH_PARAM_BUFFER_SIZE, NOT the captured driver argsize (the driver
+ *     over-reports by 8 bytes for the two DLPP tex/surf kernels, which makes
+ *     cuLaunchKernel return CUDA_ERROR_LAUNCH_OUT_OF_RESOURCES).
+ *   - Only two bindless slots in the whole graph (input tex @ dlpp_preProcess,
+ *     output surf @ dlpp_postProcess/ResampleAndComposeFP16); no internal surfaces.
+ *
+ * The cubins and the shared weights blob are external files (the "data" option),
+ * extracted from the open-sourced; conference shared driver and not shipped with FFmpeg.
+ */
+
+#include "libavutil/hwcontext.h"
+#include "libavutil/mem.h"
+#include "libavutil/opt.h"
+#include "libavutil/pixdesc.h"
+
+#include "avfilter.h"
+#include "filters.h"
+#include "rtx_cuda.h"
+#include "rtx_dlpp_abi.h"
+#include "video.h"
+
+/* Generated by rtx-video-re from the open-sourced; conference shared   library, and
+ * installed rather than carried here -- located, together with the cubins and
+ * weights it names, through pkg-config (see configure's nvfdata_* checks). */
+#include <vsr_drv_cuda_gen.h>
+
+FF_RTX_ASSERT_MODULE_LAYOUT(VsrDrvModule);
+FF_RTX_ASSERT_FUNC_LAYOUT(VsrDrvFunc);
+FF_RTX_ASSERT_UPLOAD_LAYOUT(VsrDrvGenUpload);
+FF_RTX_ASSERT_LAUNCH_LAYOUT(VsrDrvGenLaunch);
+
+/* preProcess arg-buffer offsets of the two input pre-processing floats (params
+ * +0x3c/+0x40, direct copies; located by sentinel probe -- both inside its 64-byte
+ * param cbank).  preProcess is the first launch in every config. */
+#define VSRDRV_PRE_DETAIL_OFF 0x38
+#define VSRDRV_PRE_SMOOTH_OFF 0x3c
+/* The format selectors -- the 3-way enum documented on ff_rtx_packed_rgb_fmts,
+ * sentinel-probed at the driver's params +0x30/+0x34 (see rtx-video-re
+ * docs/FINDINGS-vsr-drv-params.md) -- sit on the DLPP glue kernels this filter
+ * shares with vf_dlpp_drv_cuda, so their offsets live in rtx_dlpp_abi.h. */
+
+typedef struct VsrDrvCudaContext {
+    const AVClass *class;
+
+    FFRtxCuda   r;
+    FFRtxImage *in_img, *out_img;
+
+    int W, H, oW, oH;                 ///< input / output size
+    int cfg;                          ///< index into vsrdrv_configs
+
+    const FFRtxPixFmt *inpf, *outpf;
+
+    int   quality;
+    float detail;                     ///< preProcess detail gain (params +0x3c -> arg@0x38)
+    float smooth;                     ///< preProcess smoothing   (params +0x40 -> arg@0x3c)
+    char *w_expr;
+    char *h_expr;
+    char *data_dir;
+    char *out_format;                 ///< output pixel format (empty = same as input)
+    int   experimental_arch;          ///< allow the unverified sub-Blackwell (sm_75/sm_80) path
+} VsrDrvCudaContext;
+
+#define OFFSET(x) offsetof(VsrDrvCudaContext, x)
+#define FLAGS (AV_OPT_FLAG_VIDEO_PARAM | AV_OPT_FLAG_FILTERING_PARAM)
+
+static const AVOption vsr_drv_cuda_options[] = {
+    /* Driver quality selects the internal network; they are NOT ordered by index.
+     * By fidelity/gentleness: q1 (most faithful) > q3 > q4 > q2 (most aggressive
+     * detail synthesis).  Default q1 -- the least grainy, closest to a faithful
+     * upscale.
+     *
+     * The driver's own index 0 selects the same network as 4, byte-identically.
+     * It is not exposed: one model under two numbers only invites someone to A/B
+     * them and find no difference. */
+    { "quality", "driver VSR quality level (1=gentlest .. 2=strongest)", OFFSET(quality), AV_OPT_TYPE_INT, {.i64=1}, 1, 4, FLAGS },
+    /* Perceptual input pre-processing (driver params +0x3c/+0x40, fed to
+     * dlpp_preProcess). 0 = neutral (byte-exact with the DLL); >0 only.  detail
+     * raises high-frequency, smooth lowers it -- an unsharp/denoise pair.  These
+     * tune look, NOT fidelity (see rtx-video-re docs/FINDINGS-vsr-drv-params.md). */
+    { "detail", "input detail gain (0=neutral, higher=sharper)", OFFSET(detail), AV_OPT_TYPE_FLOAT, {.dbl=0}, 0, 16, FLAGS },
+    { "smooth", "input smoothing (0=neutral, higher=softer)",    OFFSET(smooth), AV_OPT_TYPE_FLOAT, {.dbl=0}, 0, 16, FLAGS },
+    { "w", "output width expression (default: 2x input)",  OFFSET(w_expr), AV_OPT_TYPE_STRING, {.str=NULL}, 0, 0, FLAGS },
+    { "h", "output height expression (default: 2x input)", OFFSET(h_expr), AV_OPT_TYPE_STRING, {.str=NULL}, 0, 0, FLAGS },
+    { "data", "directory with extracted driver VSR cubins + the shared weights.bin",
+      OFFSET(data_dir), AV_OPT_TYPE_STRING, {.str=VSRDRV_DEFAULT_DATA_DIR}, 0, 0, FLAGS },
+    { "format", "output pixel format (empty = same as input); e.g. bgra, rgba64le",
+      OFFSET(out_format), AV_OPT_TYPE_STRING, {.str=NULL}, 0, 0, FLAGS },
+    /* The cubins ship as multi-arch fatbins (sm_75/sm_80/sm_120); cuModuleLoadData
+     * picks the image for the running GPU.  Blackwell (sm_120) is validated byte-
+     * exact; Ada (sm_89) is verified on an RTX 4060 Ti -- the sm_80 slice loaded
+     * there is byte-identical to the driver DLL's own sm_80 cubin for all 53
+     * kernels.  Other sub-Blackwell arches run that same sm_80 image but were never
+     * exercised on real silicon, hence the opt-in.  (Turing/older can't run VSR at
+     * all -- its conv kernels are sm_80+; refused unconditionally.) */
+    { "experimental_arch", "allow the unverified sub-Blackwell path (sm_89/Ada does not need this)",
+      OFFSET(experimental_arch), AV_OPT_TYPE_BOOL, {.i64=0}, 0, 1, FLAGS },
+    { NULL }
+};
+
+AVFILTER_DEFINE_CLASS(vsr_drv_cuda);
+
+FF_RTX_ASSERT_PRIV_LAYOUT(VsrDrvCudaContext);
+
+static const FFRtxArchGate vsrdrv_gate = {
+    /* The all_fuse_with_pooling conv kernels use the sm_80+ tensor-core MMA
+     * (m16n8k16 / HMMA.16816), which Turing/Volta/Pascal tensor cores cannot
+     * execute -- so the driver ships no cc<8 image for them and cuModuleLoadData
+     * would fail (CUDA_ERROR_NO_BINARY_FOR_GPU).   's real Turing VSR path
+     * uses a different (HMMA.1688) kernel set and launch graph, which we captured
+     * only on Blackwell -- so it cannot be driven here.  experimental_arch cannot
+     * help, so this refusal is unconditional. */
+    .hard_min_major = 8,
+    .hard_msg =
+        "vsr_drv_cuda cannot run on this GPU (cc %d.%d): VSR's conv kernels "
+        "require sm_80+ (Ampere) tensor cores (the m16n8k16 MMA), so the driver "
+        "ships no image for Turing/Volta/Pascal.   's Turing VSR uses a "
+        "different kernel set and graph that is not captured here -- needs "
+        "Ampere or newer.\n",
+    .gate_msg =
+        "vsr_drv_cuda is validated on Blackwell (cc 12.x) and Ada (cc 8.9); this "
+        "GPU is cc %d.%d.  Other Ampere/Ada support is unverified (they run the "
+        "sm_80 image) -- set experimental_arch=1 to attempt it.\n",
+    .warn_msg =
+        "vsr_drv_cuda: EXPERIMENTAL sub-Blackwell (cc %d.%d) path -- it runs the "
+        "sm_80 image, unverified on real hardware.\n",
+};
+
+/* ------------------------------------------------------------------------- *
+ * One-time graph setup for the selected config + W,H,oW,oH (context current).
+ * ------------------------------------------------------------------------- */
+static void fill_sizes(AVFilterContext *ctx, long long *sz)
+{
+    VsrDrvCudaContext *s = ctx->priv;
+    vsrdrv_fill_allocs(s->cfg, s->W, s->H, s->oW, s->oH, sz);
+}
+
+static int setup_graph(AVFilterContext *ctx)
+{
+    VsrDrvCudaContext *s = ctx->priv;
+    const VsrDrvConfig *c = &vsrdrv_configs[s->cfg];
+    VsrDrvGenUpload *up;
+    int ret, nup, pre;
+
+    if ((ret = ff_rtx_arch_gate(ctx, &s->r, &vsrdrv_gate, s->experimental_arch)) < 0)
+        return ret;
+    if ((ret = ff_rtx_load_modules(ctx, &s->r, s->data_dir,
+                                   (const FFRtxModule *)c->modules, c->nmod, VSRDRV_MAX_MID,
+                                   (const FFRtxFunc *)c->funcs, c->nfunc, VSRDRV_MAX_FID,
+                                   NULL)) < 0)
+        return ret;
+    if ((ret = ff_rtx_alloc_arena(ctx, &s->r, c->nalloc, fill_sizes, 0)) < 0)
+        return ret;
+
+    up = av_calloc(c->nupload, sizeof(*up));
+    if (!up)
+        return AVERROR(ENOMEM);
+    nup = vsrdrv_fill_uploads(s->cfg, s->W, s->H, s->oW, s->oH,
+                              (const vsrdrv_devptr *)s->r.alloc, up);
+    ret = ff_rtx_upload_weights(ctx, &s->r, s->data_dir, "weights.bin",
+                                (const FFRtxUpload *)up, nup);
+    av_freep(&up);
+    if (ret < 0)
+        return ret;
+
+    /* input array + texture (linear/normalized/clamp; the frame is copied in
+     * each frame), and the output array + surface (the SUST.P target). */
+    s->in_img = ff_rtx_image_array(ctx, &s->r, s->W, s->H, s->inpf->cufmt,
+                                   FF_RTX_TEX | FF_RTX_CLAMP);
+    s->out_img = ff_rtx_image_array(ctx, &s->r, s->oW, s->oH, s->outpf->cufmt,
+                                    FF_RTX_SURF | FF_RTX_LDST);
+    if (!s->in_img || !s->out_img)
+        return AVERROR_EXTERNAL;
+
+    /* Build the graph.  vsrdrv_fill_graph() is generated from the same fit as the
+     * tables above and assigns every field through its named vsrdrv_*_params
+     * struct, so the argument blocks are constructed rather than patched.
+     * CUdeviceptr and vsrdrv_devptr are both 64-bit device addresses; the casts
+     * are only to satisfy `unsigned long long *` vs `uint64_t *` on LP64. */
+    if ((ret = ff_rtx_alloc_launches(ctx, &s->r, c->nlaunch, sizeof(VsrDrvGenLaunch))) < 0)
+        return ret;
+    if (vsrdrv_fill_graph(s->cfg, s->W, s->H, s->oW, s->oH,
+                          (const vsrdrv_devptr *)s->r.alloc,
+                          (vsrdrv_devptr)s->in_img->tex, (vsrdrv_devptr)s->out_img->surf,
+                          s->r.launches) != c->nlaunch) {
+        av_log(ctx, AV_LOG_ERROR, "generated fill disagrees with the config tables\n");
+        return AVERROR_BUG;
+    }
+
+    /* Format selectors, on the shared DLPP glue kernels.  preProcess is also
+     * where this filter's own tunables sit, so keep its launch index. */
+    if ((ret = ff_dlpp_patch_selectors(ctx, &s->r, (const FFRtxFunc *)c->funcs,
+                                       c->nfunc, s->inpf, s->outpf, c->tag, &pre)) < 0)
+        return ret;
+
+    /* Perceptual tunables: overwrite the two preProcess input pre-processing floats
+     * (params +0x3c/+0x40 -> its arg @0x38/@0x3c) when set non-zero.  0 leaves the
+     * byte-exact-with-the-DLL default. */
+    if (s->detail != 0 || s->smooth != 0) {
+        uint8_t *a;
+        if (pre < 0) {
+            av_log(ctx, AV_LOG_ERROR,
+                   "no input pre-process kernel for config %s; detail/smooth "
+                   "cannot be applied\n", c->tag);
+            return AVERROR_BUG;
+        }
+        a = ff_rtx_launch_at(&s->r, pre)->params;
+        if (s->detail != 0) memcpy(a + VSRDRV_PRE_DETAIL_OFF, &s->detail, 4);
+        if (s->smooth != 0) memcpy(a + VSRDRV_PRE_SMOOTH_OFF, &s->smooth, 4);
+        av_log(ctx, AV_LOG_VERBOSE, "preProcess tunables: detail=%g smooth=%g (launch %d)\n",
+               s->detail, s->smooth, pre);
+    }
+
+    /* No sub-Blackwell param-size fix-up.  This filter used to append 8 zero bytes
+     * to the three tex/surf glue kernels' param buffers on cc < 12, on the theory
+     * that their sm_80 build declares a larger cbank than the sm_120 one.  That is
+     * wrong, and vf_dlpp_drv_cuda.c -- the same kernels, driven from the other
+     * plugin -- dropped the identical splice for the same reason: every kernel's
+     * EIATTR_CBANK_PARAM_SIZE is the same across sm_80 and sm_120, so growing the
+     * buffer makes cuLaunchKernel disagree with the cbank and fail
+     * CUDA_ERROR_LAUNCH_OUT_OF_RESOURCES on Ada.  The generator settles it either
+     * way: psize comes from the loaded cubin's own EIATTR, and for every vsr_drv
+     * config it equals the argsize the driver itself launched with. */
+
+    av_log(ctx, AV_LOG_INFO,
+           "driver VSR graph ready: quality %d [%s]  %dx%d -> %dx%d  "
+           "(%d launches, %d buffers)\n",
+           s->quality, c->tag, s->W, s->H, s->oW, s->oH,
+           s->r.nlaunch, s->r.nalloc);
+    return 0;
+}
+
+/* ------------------------------------------------------------------------- *
+ * Per-frame: bind the input frame as a texture, replay the graph, copy out.
+ * ------------------------------------------------------------------------- */
+static int filter_frame(AVFilterLink *inlink, AVFrame *in)
+{
+    VsrDrvCudaContext *s = inlink->dst->priv;
+    /* psize is the kernel's own cbank size, NOT the captured argsize */
+    const FFRtxFrameOp op = {
+        .in_img = s->in_img,  .iW = s->W,  .iH = s->H,  .ibpp = s->inpf->bpp,
+        .out_img = s->out_img, .oW = s->oW, .oH = s->oH, .obpp = s->outpf->bpp,
+        .flags = FF_RTX_OP_PSIZE |
+                 (s->outpf->sel == 2 ? FF_RTX_OP_OPAQUE_ALPHA : 0),
+    };
+
+    return ff_rtx_filter_frame(inlink, in, &s->r, &op, NULL);
+}
+
+static int config_output(AVFilterLink *outlink)
+{
+    AVFilterContext *ctx = outlink->src;
+    AVFilterLink *inlink = ctx->inputs[0];
+    VsrDrvCudaContext *s = ctx->priv;
+    AVHWFramesContext *in_frames_ctx;
+    FFRtxFormats fmts = {
+        .in_tbl  = ff_rtx_packed_rgb_fmts, .n_in  = FF_ARRAY_ELEMS(ff_rtx_packed_rgb_fmts),
+        .out_tbl = ff_rtx_packed_rgb_fmts, .n_out = FF_ARRAY_ELEMS(ff_rtx_packed_rgb_fmts),
+    };
+    int fast, ret;
+
+    ff_rtx_free_graph(ctx, &s->r);
+
+    fmts.out_format = s->out_format;
+    if ((ret = ff_rtx_config_formats(ctx, inlink, &fmts, &in_frames_ctx,
+                                     &s->inpf, &s->outpf)) < 0)
+        return ret;
+
+    s->W = inlink->w;
+    s->H = inlink->h;
+    if ((ret = ff_rtx_eval_dims(ctx, inlink, s->w_expr, s->h_expr, 2,
+                                &s->oW, &s->oH)) < 0)
+        return ret;
+
+    fast = (s->oW == 2 * s->W && s->oH == 2 * s->H);
+    s->cfg = vsrdrv_config_index(s->quality, fast ? 0 : 1);
+    if (s->cfg < 0) {
+        av_log(ctx, AV_LOG_ERROR, "no config for quality %d %s path\n",
+               s->quality, fast ? "fast" : "resample");
+        return AVERROR(ENOSYS);
+    }
+
+    if ((ret = ff_rtx_bind_device(ctx, &s->r, in_frames_ctx)) < 0)
+        return ret;
+    if ((ret = ff_rtx_config_hwframes(ctx, outlink, &s->r, s->oW, s->oH,
+                                      s->outpf->f)) < 0)
+        return ret;
+    return ff_rtx_setup(ctx, &s->r, "driver VSR", setup_graph);
+}
+
+static const AVFilterPad vsr_drv_cuda_inputs[] = {
+    { .name = "default", .type = AVMEDIA_TYPE_VIDEO, .filter_frame = filter_frame },
+};
+
+static const AVFilterPad vsr_drv_cuda_outputs[] = {
+    { .name = "default", .type = AVMEDIA_TYPE_VIDEO, .config_props = config_output },
+};
+
+const FFFilter ff_vf_vsr_drv_cuda = {
+    .p.name        = "vsr_drv_cuda",
+    .p.description = NULL_IF_CONFIG_SMALL("  driver   Super Resolution (CUDA)"),
+    .p.priv_class  = &vsr_drv_cuda_class,
+    .priv_size     = sizeof(VsrDrvCudaContext),
+    .uninit        = ff_rtx_uninit,
+    FILTER_INPUTS(vsr_drv_cuda_inputs),
+    FILTER_OUTPUTS(vsr_drv_cuda_outputs),
+    FILTER_SINGLE_PIXFMT(AV_PIX_FMT_CUDA),
+    .flags_internal = FF_FILTER_FLAG_HWFRAME_AWARE,
+};


________




    avfilter: add dlpp_drv_cuda, the driver DLPP super-resolution network
    
    The third super-resolution network in the driver stack: ppe/features/DLPP,
    driven directly rather than through the AIVP plugin that vsr_drv_cuda uses.  It
    exposes DLPP's own quality levels, which include two high-quality models the
    AIVP path does not reach.
    
    Quality 1 and 2 are the fixed-2x base models and behave like vsr_drv_cuda.
    Quality 3/4 are the high-quality models, which upscale natively at a chosen
    integer factor -- the scale option is the driver's own params[0x38] float, which
    selects the pixel_shuffle2/3/4 super-resolution head.  For both, an output at
    exactly the native factor stores directly and any other size resamples the
    native result to the requested rectangle.
    
    As on vsr_drv_cuda the driver's index 0 is a byte-identical duplicate -- of 1
    here rather than of 4 -- and is likewise not exposed, so quality runs 1-4 and
    defaults to 1.
    
    It shares vsr_drv_cuda's two DLPP quirks: launches are issued with the kernel's
    EIATTR_CBANK_PARAM_SIZE rather than the over-reported driver argsize, and the
    whole graph has just the two bindless slots.
---
 configure                      |   1 +
 doc/filters.texi               |  71 ++++++++
 libavfilter/Makefile           |   1 +
 libavfilter/allfilters.c       |   1 +
 libavfilter/vf_dlpp_drv_cuda.c | 370 +++++++++++++++++++++++++++++++++++++++++
 5 files changed, 444 insertions(+)

diff --git a/configure b/configure
index 32ed6f6836..7403274fbc 100755
--- a/configure
+++ b/configure
@@ -4194,6 +4194,7 @@ derain_filter_select="dnn"
 deshake_filter_select="pixelutils"
 deshake_opencl_filter_deps="opencl"
 dilation_opencl_filter_deps="opencl"
+dlpp_drv_cuda_filter_deps="ffnvcodec nvfdata_dlpp_drv"
 dnn_classify_filter_select="dnn"
 dnn_detect_filter_select="dnn"
 dnn_processing_filter_select="dnn"
diff --git a/doc/filters.texi b/doc/filters.texi
index d7870e6827..1f61ee1185 100644
--- a/doc/filters.texi
+++ b/doc/filters.texi
@@ -27483,6 +27483,77 @@ JPEG (full) range
 
 @end table
 
+@section dlpp_drv_cuda
+
+Upscale video with the   driver's DLPP super-resolution network, running
+it directly on CUDA.
+
+This is one of three super-resolution filters and they drive three different
+networks: @ref{vsr_cuda} runs the NGX SDK's, @ref{vsr_drv_cuda} runs the
+driver's AIVP plugin, and this one drives DLPP directly.  DLPP exposes two
+high-quality models the AIVP path does not reach.  They do not produce the same
+picture, so it is worth trying more than one.
+
+It accepts the following options:
+
+@table @option
+@item quality
+Which model to run: @code{1} base, @code{2} deeper base, @code{3} and @code{4}
+the high-quality models.  Default @code{1}.
+
+@item scale
+Native integer upscale factor for @option{quality} @code{3} and @code{4}:
+@code{2}, @code{3} or @code{4}.  Default @code{2}.  Ignored by the base models,
+which always super-resolve 2x internally.
+
+@item w
+@item h
+Output width and height, as expressions (as in @ref{scale}); the variables
+@var{iw}/@var{in_w} and @var{ih}/@var{in_h} hold the input size.  Unset (the
+default) means the native factor times the input -- @option{scale} for the
+high-quality models, 2x for the base models.  Any other size resamples the
+network's native result to the requested rectangle with a bicubic compose.
+
+@item format
+Output pixel format.  Empty (the default) keeps the input format.
+
+@item wipe
+Split-screen comparison wipe, @code{0} to @code{1}.  Default @code{0}, the real
+full-resolution output.  Above @code{0}, the leftmost fraction of the frame
+shows the plain bicubic reference instead of the network's output -- the
+before/after slider from  's own UI.  A diagnostic control, not a quality
+knob.
+
+@item data
+Directory holding the extracted cubins and the shared @file{weights.bin}.
+
+@item experimental_arch
+Allow GPU architectures whose cubins were matched statically rather than
+exercised.  Ada (sm_89) and Blackwell do not need this.
+@end table
+
+@subsection Supported formats
+
+Packed RGB formats are accepted for both input and output: @code{rgb0},
+@code{rgba}, @code{bgr0}, @code{bgra} (8-bit) and @code{rgba64le} (16-bit).
+Input and output formats are chosen independently (see the @option{format}
+option).  16-bit carries the network's full internal precision and avoids
+banding.
+
+The kernels branch on a format selector that exposes an R@math{<->}B swap only
+on the 8-bit path, so the B-first @code{bgr0}/@code{bgra} are handled natively.
+That swap does not exist on the high-bit-depth path, which packs in array-native
+order, so 16-bit is R-first only (@code{rgba64le}).
+
+This filter does @strong{not} do YUV@math{<->}RGB conversion or tone mapping;
+see @ref{vsr_cuda} for the @code{libplacebo} pipeline that feeds these filters
+from real video and for the hardware decode/encode combinations.
+
+The cubins and weights are extracted from the open-sourced; conference shared   libraries and
+are @emph{not} shipped: the filter is only built when an
+@code{ -video-filters} package carrying the DLPP data is installed, and
+@option{data} defaults to that package's data directory.
+
 @section isr_cuda
 
 Upscale with  's NGX Image Super Resolution network, running it directly
diff --git a/libavfilter/Makefile b/libavfilter/Makefile
index ffba98faca..c7a2504cc4 100644
--- a/libavfilter/Makefile
+++ b/libavfilter/Makefile
@@ -291,6 +291,7 @@ OBJS-$(CONFIG_DILATION_FILTER)               += vf_neighbor.o
 OBJS-$(CONFIG_DILATION_OPENCL_FILTER)        += vf_neighbor_opencl.o opencl.o \
                                                 opencl/neighbor.o
 OBJS-$(CONFIG_DISPLACE_FILTER)               += vf_displace.o framesync.o
+OBJS-$(CONFIG_DLPP_DRV_CUDA_FILTER)          += vf_dlpp_drv_cuda.o rtx_cuda.o
 OBJS-$(CONFIG_DNN_CLASSIFY_FILTER)           += vf_dnn_classify.o
 OBJS-$(CONFIG_DNN_DETECT_FILTER)             += vf_dnn_detect.o
 OBJS-$(CONFIG_DNN_PROCESSING_FILTER)         += vf_dnn_processing.o
diff --git a/libavfilter/allfilters.c b/libavfilter/allfilters.c
index 7e4bc775f5..942818e448 100644
--- a/libavfilter/allfilters.c
+++ b/libavfilter/allfilters.c
@@ -265,6 +265,7 @@ extern const FFFilter ff_vf_detelecine;
 extern const FFFilter ff_vf_dilation;
 extern const FFFilter ff_vf_dilation_opencl;
 extern const FFFilter ff_vf_displace;
+extern const FFFilter ff_vf_dlpp_drv_cuda;
 extern const FFFilter ff_vf_dnn_classify;
 extern const FFFilter ff_vf_dnn_detect;
 extern const FFFilter ff_vf_dnn_processing;
diff --git a/libavfilter/vf_dlpp_drv_cuda.c b/libavfilter/vf_dlpp_drv_cuda.c
new file mode 100644
index 0000000000..9f5e99cf05
--- /dev/null
+++ b/libavfilter/vf_dlpp_drv_cuda.c
@@ -0,0 +1,370 @@
+/*
+ *  
+ *
+ * This file is part of FFmpeg.
+ *
+ * FFmpeg is free software; you can redistribute it and/or
+ * modify it under the terms of the GNU Lesser General Public
+ * License as published by the Free Software Foundation; either
+ * version 2.1 of the License, or (at your option) any later version.
+ *
+ * FFmpeg is distributed in the hope that it will be useful,
+ * but WITHOUT ANY WARRANTY; without even the implied warranty of
+ * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
+ * Lesser General Public License for more details.
+ *
+ * You should have received a copy of the GNU Lesser General Public
+ * License along with FFmpeg; if not, write to the Free Software
+ * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
+ */
+
+/**
+ * @file
+ * Super-resolution filter driving the   *driver* DLPP super-resolution
+ * network (the DXVA/PPE plugin, ppe/features/DLPP) -- distinct from vf_vsr_cuda,
+ * which runs the NGX SDK snippet (nvngx_vsr.dll), and from vf_vsr_drv_cuda,
+ * which runs the AIVP plugin over the same DLPP kernels.  The cubins were
+ * extracted and the forward pass reverse-engineered by running the plugin on
+ * Linux via loader_ppe and intercepting the live CUDA Driver-API launches.
+ * dlpp_drv_cuda_gen.h encodes, per quality and scaling path, how the whole graph
+ * (grids, scratch allocations, packed arg-buffer scalars incl. division-magic
+ * constants and float32 resample steps, weight-upload targets, pointer fixups)
+ * scales with the input W,H and output oW,oH -- derived and validated byte-exact
+ * against the loader (rtx-video-re).  The filter evaluates that at config time
+ * and replays the graph with libcuda; no DLL is needed at run time.  The replay
+ * machinery itself is rtx_cuda.c.
+ *
+ * Base models (quality 1/2) perform a fixed internal 2x super-resolution: exact
+ * isotropic 2x output takes the "fast" path (direct dlpp_postProcess store); any
+ * other factor takes the "resample" path (dlpp_ResampleAndComposeFP16 to the rect).
+ * The high-quality models 5/6 (quality 3/4) instead do NATIVE integer upscaling at
+ * a chosen scale (the `scale` opt = the driver's params[0x38] float, which selects
+ * the pixel_shuffle2/3/4 SR head): exact scale-x output takes the fast path, any
+ * other output size resamples the native-Nx result to the requested rect.
+ *
+ * Like vf_vsr_drv_cuda, each launch is issued with the kernel's
+ * EIATTR_CBANK_PARAM_SIZE rather than the captured driver argsize (the driver
+ * over-reports by 8 bytes for the two DLPP tex/surf kernels, which makes
+ * cuLaunchKernel return CUDA_ERROR_LAUNCH_OUT_OF_RESOURCES), and the graph has
+ * only two bindless slots: the input tex at dlpp_preProcess and the output surf
+ * at dlpp_postProcess / ResampleAndComposeFP16.
+ *
+ * The cubins and the shared weights blob are external files (the "data" option),
+ * extracted from the open-sourced; conference shared driver and not shipped with FFmpeg.
+ */
+
+#include "libavutil/hwcontext.h"
+#include "libavutil/mem.h"
+#include "libavutil/opt.h"
+#include "libavutil/pixdesc.h"
+
+#include "avfilter.h"
+#include "filters.h"
+#include "rtx_cuda.h"
+#include "rtx_dlpp_abi.h"
+#include "video.h"
+
+/* Generated by rtx-video-re from the open-sourced; conference shared   library, and
+ * installed rather than carried here -- located, together with the cubins and
+ * weights it names, through pkg-config (see configure's nvfdata_* checks). */
+#include <dlpp_drv_cuda_gen.h>
+
+FF_RTX_ASSERT_MODULE_LAYOUT(DlppModule);
+FF_RTX_ASSERT_FUNC_LAYOUT(DlppFunc);
+FF_RTX_ASSERT_UPLOAD_LAYOUT(DlppGenUpload);
+FF_RTX_ASSERT_LAUNCH_LAYOUT(DlppGenLaunch);
+
+/* Split-screen comparison wipe (params +0x10). The driver marshals round(oW*wipe)
+ * into the SR-head kernel (conv3x3_fuse_conv1x1_with_pixel_shuffle*..Bicubic*, the
+ * last conv before the output store) at arg offset 0x498: columns [0, oW*wipe)
+ * render the plain bicubic reference, the rest render the SR result -- the RTX-Video
+ * UI "before/after" slider.  0 (default) = full SR everywhere (the real output);
+ * NOT a quality knob (see rtx-video-re + loader_ppe run_process_dlpp). */
+#define DLPPDRV_SRC_HEAD_KERNEL  "conv3x3_fuse_conv1x1_with_pixel_shuffle"
+#define DLPPDRV_WIPE_ARG_OFF     0x498
+/* The format selectors sit on the DLPP glue kernels this filter shares with
+ * vf_vsr_drv_cuda, so their offsets live in rtx_dlpp_abi.h. */
+
+typedef struct DlppDrvCudaContext {
+    const AVClass *class;
+
+    FFRtxCuda   r;
+    FFRtxImage *in_img, *out_img;
+
+    int W, H, oW, oH;                 ///< input / output size
+    int cfg;                          ///< index into dlppdrv_configs
+
+    const FFRtxPixFmt *inpf, *outpf;
+
+    int   quality;
+    int   scale;                      ///< native SR scale for q3/q4 (2/3/4; params +0x38)
+    float wipe;                       ///< split-screen compare wipe (params +0x10)
+    char *w_expr;
+    char *h_expr;
+    char *data_dir;
+    char *out_format;                 ///< output pixel format (empty = same as input)
+    int   experimental_arch;          ///< allow the unverified sub-Blackwell (sm_75/sm_80) path
+} DlppDrvCudaContext;
+
+#define OFFSET(x) offsetof(DlppDrvCudaContext, x)
+#define FLAGS (AV_OPT_FLAG_VIDEO_PARAM | AV_OPT_FLAG_FILTERING_PARAM)
+
+static const AVOption dlpp_drv_cuda_options[] = {
+    /* DLPP quality selects the internal SR network (model index via params +0xc).
+     * q1 -> base model 1; q2 -> deeper model 2 (both do a fixed internal 2x +
+     * resample for other ratios). q3/q4 -> the high-quality models 5/6, which do
+     * NATIVE integer upscaling at the `scale` factor (2/3/4) and require output =
+     * scale x input. Default 1.
+     *
+     * The driver's own index 0 selects the same model 1 as index 1, and produces a
+     * byte-identical graph.  It is not exposed: one model under two numbers only
+     * invites someone to A/B them and find no difference. */
+    { "quality", "DLPP quality (1=base, 2=deeper; 3/4=native-scale high quality)", OFFSET(quality), AV_OPT_TYPE_INT, {.i64=1}, 1, 4, FLAGS },
+    /* Native SR scale for quality 3/4 only (ignored for 1/2): 2/3/4 -> the driver's
+     * pixel_shuffle2/3/4 head (params[0x38]). Exact scale x input output uses the
+     * native fast path; any other output size resamples the native-Nx result. */
+    { "scale", "native integer SR scale for quality 3/4 (2/3/4)", OFFSET(scale), AV_OPT_TYPE_INT, {.i64=2}, 2, 4, FLAGS },
+    /* Split-screen comparison wipe (driver params +0x10).  0 (default) = the real
+     * full-SR output, byte-exact with the DLL.  In (0,1]: the left oW*wipe columns
+     * show the plain bicubic reference instead of SR (the RTX-Video "before/after"
+     * slider).  A diagnostic/demo control, NOT a quality knob. */
+    { "wipe", "compare wipe: left fraction shown as bicubic ref (0=off/full SR)", OFFSET(wipe), AV_OPT_TYPE_FLOAT, {.dbl=0}, 0, 1, FLAGS },
+    /* Output size. Unset (default) = the native integer scale: quality 3/4 -> the
+     * `scale` factor (2/3/4), base quality 1/2 -> 2x. Set either to any expression
+     * for non-integer scaling (the network resamples its native-scale result to the
+     * requested rect), e.g. w=iw*3/2, or w=1920:h=1080. */
+    { "w", "output width expression (default: scale x input)",  OFFSET(w_expr), AV_OPT_TYPE_STRING, {.str=NULL}, 0, 0, FLAGS },
+    { "h", "output height expression (default: scale x input)", OFFSET(h_expr), AV_OPT_TYPE_STRING, {.str=NULL}, 0, 0, FLAGS },
+    { "data", "directory with extracted driver DLPP cubins + the shared weights.bin",
+      OFFSET(data_dir), AV_OPT_TYPE_STRING, {.str=DLPPDRV_DEFAULT_DATA_DIR}, 0, 0, FLAGS },
+    { "format", "output pixel format (empty = same as input); e.g. bgra, rgba64le",
+      OFFSET(out_format), AV_OPT_TYPE_STRING, {.str=NULL}, 0, 0, FLAGS },
+    /* The cubins ship as multi-arch fatbins (sm_75/sm_80/sm_120); cuModuleLoadData
+     * picks the image for the running GPU.  Blackwell (sm_120) is validated byte-
+     * exact; Ada (sm_89) is verified on an RTX 4060 Ti -- the sm_80 slice loaded
+     * there is byte-identical to the driver DLL's own sm_80 cubin for all 94
+     * kernels, with an identical param layout.  Other sub-Blackwell arches run that
+     * same image but were never exercised on real silicon, hence the opt-in.
+     * (Turing/older can't run DLPP at all -- its conv kernels are sm_80+; refused
+     * unconditionally.) */
+    { "experimental_arch", "allow the unverified sub-Blackwell path (sm_89/Ada does not need this)",
+      OFFSET(experimental_arch), AV_OPT_TYPE_BOOL, {.i64=0}, 0, 1, FLAGS },
+    { NULL }
+};
+
+AVFILTER_DEFINE_CLASS(dlpp_drv_cuda);
+
+FF_RTX_ASSERT_PRIV_LAYOUT(DlppDrvCudaContext);
+
+static const FFRtxArchGate dlppdrv_gate = {
+    /* The all_fuse_with_pooling conv kernels use the sm_80+ tensor-core MMA
+     * (m16n8k16 / HMMA.16816), which Turing/Volta/Pascal tensor cores cannot
+     * execute -- so the driver ships no cc<8 image for them and cuModuleLoadData
+     * would fail (CUDA_ERROR_NO_BINARY_FOR_GPU).   's real Turing DLPP path
+     * uses a different (HMMA.1688) kernel set and launch graph, which we captured
+     * only on Blackwell -- so it cannot be driven here.  experimental_arch cannot
+     * help, so this refusal is unconditional. */
+    .hard_min_major = 8,
+    .hard_msg =
+        "dlpp_drv_cuda cannot run on this GPU (cc %d.%d): DLPP's conv kernels "
+        "require sm_80+ (Ampere) tensor cores (the m16n8k16 MMA), so the driver "
+        "ships no image for Turing/Volta/Pascal.   's Turing DLPP uses a "
+        "different kernel set and graph that is not captured here -- needs "
+        "Ampere or newer.\n",
+    .gate_msg =
+        "dlpp_drv_cuda is validated on Blackwell (cc 12.x) and Ada (cc 8.9); this "
+        "GPU is cc %d.%d.  Other Ampere/Ada support is unverified (they run the "
+        "sm_80 image) -- set experimental_arch=1 to attempt it.\n",
+    .warn_msg =
+        "dlpp_drv_cuda: EXPERIMENTAL sub-Blackwell (cc %d.%d) path -- it runs the "
+        "sm_80 image, unverified on real hardware.\n",
+};
+
+/* ------------------------------------------------------------------------- *
+ * One-time graph setup for the selected config + W,H,oW,oH (context current).
+ * ------------------------------------------------------------------------- */
+static void fill_sizes(AVFilterContext *ctx, long long *sz)
+{
+    DlppDrvCudaContext *s = ctx->priv;
+    dlppdrv_fill_allocs(s->cfg, s->W, s->H, s->oW, s->oH, sz);
+}
+
+static int setup_graph(AVFilterContext *ctx)
+{
+    DlppDrvCudaContext *s = ctx->priv;
+    const DlppConfig *c = &dlppdrv_configs[s->cfg];
+    const FFRtxFunc *funcs = (const FFRtxFunc *)c->funcs;
+    DlppGenUpload *up;
+    int ret, nup, pre, srchead;
+
+    if ((ret = ff_rtx_arch_gate(ctx, &s->r, &dlppdrv_gate, s->experimental_arch)) < 0)
+        return ret;
+    if ((ret = ff_rtx_load_modules(ctx, &s->r, s->data_dir,
+                                   (const FFRtxModule *)c->modules, c->nmod, DLPPDRV_MAX_MID,
+                                   funcs, c->nfunc, DLPPDRV_MAX_FID, NULL)) < 0)
+        return ret;
+    if ((ret = ff_rtx_alloc_arena(ctx, &s->r, c->nalloc, fill_sizes, 0)) < 0)
+        return ret;
+
+    up = av_calloc(c->nupload, sizeof(*up));
+    if (!up)
+        return AVERROR(ENOMEM);
+    nup = dlppdrv_fill_uploads(s->cfg, s->W, s->H, s->oW, s->oH,
+                               (const dlppdrv_devptr *)s->r.alloc, up);
+    ret = ff_rtx_upload_weights(ctx, &s->r, s->data_dir, "weights.bin",
+                                (const FFRtxUpload *)up, nup);
+    av_freep(&up);
+    if (ret < 0)
+        return ret;
+
+    /* input array + texture (linear/normalized/clamp; the frame is copied in
+     * each frame), and the output array + surface (the SUST.P target). */
+    s->in_img = ff_rtx_image_array(ctx, &s->r, s->W, s->H, s->inpf->cufmt,
+                                   FF_RTX_TEX | FF_RTX_CLAMP);
+    s->out_img = ff_rtx_image_array(ctx, &s->r, s->oW, s->oH, s->outpf->cufmt,
+                                    FF_RTX_SURF | FF_RTX_LDST);
+    if (!s->in_img || !s->out_img)
+        return AVERROR_EXTERNAL;
+
+    /* Build the graph.  dlppdrv_fill_graph() is generated from the same fit as
+     * the tables above and assigns every field through its named
+     * dlppdrv_*_params struct, so the argument blocks are constructed rather
+     * than patched.  The casts are only `unsigned long long *` vs `uint64_t *`
+     * on LP64. */
+    if ((ret = ff_rtx_alloc_launches(ctx, &s->r, c->nlaunch, sizeof(DlppGenLaunch))) < 0)
+        return ret;
+    if (dlppdrv_fill_graph(s->cfg, s->W, s->H, s->oW, s->oH,
+                           (const dlppdrv_devptr *)s->r.alloc,
+                           (dlppdrv_devptr)s->in_img->tex, (dlppdrv_devptr)s->out_img->surf,
+                           s->r.launches) != c->nlaunch) {
+        av_log(ctx, AV_LOG_ERROR, "generated fill disagrees with the config tables\n");
+        return AVERROR_BUG;
+    }
+
+    /* Format selectors, on the shared DLPP glue kernels. */
+    if ((ret = ff_dlpp_patch_selectors(ctx, &s->r, funcs, c->nfunc,
+                                       s->inpf, s->outpf, c->tag, &pre)) < 0)
+        return ret;
+    srchead = ff_rtx_find_launch_prefix(&s->r, funcs, c->nfunc, DLPPDRV_SRC_HEAD_KERNEL);
+
+    /* Split-screen comparison wipe (params +0x10 -> SR-head kernel arg @0x498 =
+     * round(oW*wipe)).  0 (default) leaves the byte-exact-with-the-DLL full-SR
+     * output; >0 shows the left oW*wipe columns as the bicubic reference. */
+    if (s->wipe > 0) {
+        uint32_t col = (uint32_t)(s->wipe * (float)s->oW + 0.5f);
+        if (srchead < 0) {
+            av_log(ctx, AV_LOG_ERROR,
+                   "no SR-head kernel for config %s; wipe cannot be applied\n", c->tag);
+            return AVERROR_BUG;
+        }
+        memcpy(ff_rtx_launch_at(&s->r, srchead)->params + DLPPDRV_WIPE_ARG_OFF, &col, 4);
+        av_log(ctx, AV_LOG_VERBOSE, "compare wipe: %g -> %u cols bicubic (SR-head launch %d)\n",
+               s->wipe, col, srchead);
+    }
+
+    /* Sub-Blackwell (Ampere/Ada) path.  An earlier build inferred that the sm_75/
+     * sm_80 tex/surf glue kernels took an 8-byte-larger param struct and spliced a
+     * reserved field in.  Verified WRONG on real sm_89 (RTX 4060 Ti): every DLPP
+     * kernel's EIATTR_CBANK_PARAM_SIZE is identical across sm_80 and sm_120
+     * (preProcess 0x38, postProcess 0x48, ResampleAndComposeFP16 0x58, pixelFold
+     * 0x28), and the genuine driver DLL launches them with the sm_120-sized param
+     * buffer on sm_89.  The 8-byte splice made cuLaunchKernel return
+     * OUT_OF_RESOURCES on Ada.  So the sm_120 arg layout is used unchanged on all
+     * architectures -- no fix-up.  (experimental_arch still gates the path only
+     * because the SASS itself is  's own multi-arch cubin, not ours.) */
+
+    av_log(ctx, AV_LOG_INFO,
+           "driver DLPP graph ready: quality %d [%s]  %dx%d -> %dx%d  "
+           "(%d launches, %d buffers)\n",
+           s->quality, c->tag, s->W, s->H, s->oW, s->oH,
+           s->r.nlaunch, s->r.nalloc);
+    return 0;
+}
+
+/* ------------------------------------------------------------------------- *
+ * Per-frame: bind the input frame as a texture, replay the graph, copy out.
+ * ------------------------------------------------------------------------- */
+static int filter_frame(AVFilterLink *inlink, AVFrame *in)
+{
+    DlppDrvCudaContext *s = inlink->dst->priv;
+    /* psize is the kernel's own cbank size, NOT the captured argsize */
+    const FFRtxFrameOp op = {
+        .in_img = s->in_img,  .iW = s->W,  .iH = s->H,  .ibpp = s->inpf->bpp,
+        .out_img = s->out_img, .oW = s->oW, .oH = s->oH, .obpp = s->outpf->bpp,
+        .flags = FF_RTX_OP_PSIZE |
+                 (s->outpf->sel == 2 ? FF_RTX_OP_OPAQUE_ALPHA : 0),
+    };
+
+    return ff_rtx_filter_frame(inlink, in, &s->r, &op, NULL);
+}
+
+static int config_output(AVFilterLink *outlink)
+{
+    AVFilterContext *ctx = outlink->src;
+    AVFilterLink *inlink = ctx->inputs[0];
+    DlppDrvCudaContext *s = ctx->priv;
+    AVHWFramesContext *in_frames_ctx;
+    FFRtxFormats fmts = {
+        .in_tbl  = ff_rtx_packed_rgb_fmts, .n_in  = FF_ARRAY_ELEMS(ff_rtx_packed_rgb_fmts),
+        .out_tbl = ff_rtx_packed_rgb_fmts, .n_out = FF_ARRAY_ELEMS(ff_rtx_packed_rgb_fmts),
+    };
+    int nscale, fast, ret;
+
+    ff_rtx_free_graph(ctx, &s->r);
+
+    fmts.out_format = s->out_format;
+    if ((ret = ff_rtx_config_formats(ctx, inlink, &fmts, &in_frames_ctx,
+                                     &s->inpf, &s->outpf)) < 0)
+        return ret;
+
+    s->W = inlink->w;
+    s->H = inlink->h;
+    /* Default (unset w/h) = the native integer scale: quality 3/4 uses the
+     * `scale` factor, base quality 1/2 uses 2x.  An explicit expression
+     * overrides per-axis (any ratio -> the resample path). */
+    nscale = (s->quality >= 3) ? s->scale : 2;
+    if ((ret = ff_rtx_eval_dims(ctx, inlink, s->w_expr, s->h_expr, nscale,
+                                &s->oW, &s->oH)) < 0)
+        return ret;
+
+    /* Config key = (quality, native-scale, path). Base models (q1/q2) have
+     * scale 0 and a fixed internal 2x: fast when out==2x, else resample. The
+     * high-quality models 5/6 (q3/q4) do NATIVE integer upscaling at 2x/3x/4x
+     * (the `scale` opt -> the driver's params[0x38] head selector, baked into the
+     * captured config); only the exact-Nx fast path is shipped for them. */
+    fast = (s->oW == nscale * s->W && s->oH == nscale * s->H);
+    s->cfg = dlppdrv_config_index(s->quality, s->quality >= 3 ? s->scale : 0,
+                                  fast ? 0 : 1);
+    if (s->cfg < 0) {
+        av_log(ctx, AV_LOG_ERROR, "no config for quality %d scale %d %s path\n",
+               s->quality, s->quality >= 3 ? s->scale : 0, fast ? "fast" : "resample");
+        return AVERROR(ENOSYS);
+    }
+
+    if ((ret = ff_rtx_bind_device(ctx, &s->r, in_frames_ctx)) < 0)
+        return ret;
+    if ((ret = ff_rtx_config_hwframes(ctx, outlink, &s->r, s->oW, s->oH,
+                                      s->outpf->f)) < 0)
+        return ret;
+    return ff_rtx_setup(ctx, &s->r, "driver DLPP", setup_graph);
+}
+
+static const AVFilterPad dlpp_drv_cuda_inputs[] = {
+    { .name = "default", .type = AVMEDIA_TYPE_VIDEO, .filter_frame = filter_frame },
+};
+
+static const AVFilterPad dlpp_drv_cuda_outputs[] = {
+    { .name = "default", .type = AVMEDIA_TYPE_VIDEO, .config_props = config_output },
+};
+
+const FFFilter ff_vf_dlpp_drv_cuda = {
+    .p.name        = "dlpp_drv_cuda",
+    .p.description = NULL_IF_CONFIG_SMALL("  driver   DLPP super-resolution (CUDA)"),
+    .p.priv_class  = &dlpp_drv_cuda_class,
+    .priv_size     = sizeof(DlppDrvCudaContext),
+    .uninit        = ff_rtx_uninit,
+    FILTER_INPUTS(dlpp_drv_cuda_inputs),
+    FILTER_OUTPUTS(dlpp_drv_cuda_outputs),
+    FILTER_SINGLE_PIXFMT(AV_PIX_FMT_CUDA),
+    .flags_internal = FF_FILTER_FLAG_HWFRAME_AWARE,
+};



________




    avfilter: add deepdvc_drv_cuda,   RTX Dynamic Vibrance
    
    Colour and vibrance enhancement with the driver's DeepDVC network (the DXVA/PPE
    plugin nvaidvcx.dll, ppe/features/DeepDVC).  It is an HDRnet-style learned
    enhancer: a small CNN predicts a coefficient grid which applyLUTToSurface then
    applies at full resolution.
    
    It is same-resolution and in-place, which shapes the binding: applyLUTToSurface
    reads and writes one image handle and the downsample kernel reads that same
    frame, so the whole graph binds a single frame texture.  Unified TEXMODE lets
    one texture handle serve both the sample and the surface store -- a surface
    handle there fails the TLD.
    
    Both tunables, vibrance and gain, are a final blend strength inside
    applyLUTToSurface, so vibrance=0 is an exact pass-through rather than an
    approximate one.
---
 configure                         |   1 +
 doc/filters.texi                  |  46 ++++++
 libavfilter/Makefile              |   1 +
 libavfilter/allfilters.c          |   1 +
 libavfilter/vf_deepdvc_drv_cuda.c | 300 ++++++++++++++++++++++++++++++++++++++
 5 files changed, 349 insertions(+)

diff --git a/configure b/configure
index 6b3ca593be..899e5abd40 100755
--- a/configure
+++ b/configure
@@ -4189,6 +4189,7 @@ deinterlace_qsv_filter_deps="libmfx"
 deinterlace_qsv_filter_select="qsvvpp"
 deinterlace_vaapi_filter_deps="vaapi"
 delogo_filter_deps="gpl"
+deepdvc_drv_cuda_filter_deps="ffnvcodec nvfdata_dvc_drv"
 denoise_vaapi_filter_deps="vaapi"
 derain_filter_select="dnn"
 deshake_filter_select="pixelutils"
diff --git a/doc/filters.texi b/doc/filters.texi
index 2f4a8098d2..ac3afebe19 100644
--- a/doc/filters.texi
+++ b/doc/filters.texi
@@ -27483,6 +27483,52 @@ JPEG (full) range
 
 @end table
 
+@section deepdvc_drv_cuda
+
+Enhance colour with   RTX Dynamic Vibrance, running the driver's DeepDVC
+network directly on CUDA.
+
+DeepDVC is a learned enhancer rather than a fixed saturation curve: a small
+convolutional network looks at the whole frame and predicts a grid of colour
+transform coefficients, which a second pass then applies at full resolution.
+It works at the input resolution and does not rescale.
+
+It accepts the following options:
+
+@table @option
+@item vibrance
+Strength of the predicted transform, @code{0} to @code{8}.  Default @code{1}.
+@code{0} is an exact pass-through: the strength is applied inside the final
+kernel, so the output is bit-identical to the input rather than merely close to
+it.
+
+@item gain
+Secondary saturation gain, @code{0} to @code{8}.  Default @code{1}.
+
+@item data
+Directory holding the extracted cubins and @file{weights.bin}.
+
+@item experimental_arch
+Allow GPU architectures whose cubins were matched statically rather than
+exercised.  Ada (sm_89) and Blackwell do not need this.
+@end table
+
+@subsection Supported formats
+
+8-bit R-first packed RGB CUDA frames: @code{rgb0} or @code{rgba}.  The output
+format is always the input format.
+
+Unlike the super-resolution filters this one does not map the network's format
+selectors -- it drives it as raw 4-channel 8-bit in the frame's own byte order,
+so it cannot be told to swap.  A B-first frame would be enhanced as though blue
+were red, so @code{bgr0} and @code{bgra} are rejected rather than silently
+hue-shifted; convert first.
+
+The cubins and weights are extracted from the open-sourced; conference shared   libraries and
+are @emph{not} shipped: the filter is only built when an
+@code{ -video-filters} package carrying the DeepDVC data is installed, and
+@option{data} defaults to that package's data directory.
+
 @section dlpp_drv_cuda
 
 Upscale video with the   driver's DLPP super-resolution network, running
diff --git a/libavfilter/Makefile b/libavfilter/Makefile
index 1222b87eec..b38b80748c 100644
--- a/libavfilter/Makefile
+++ b/libavfilter/Makefile
@@ -274,6 +274,7 @@ OBJS-$(CONFIG_DECIMATE_FILTER)               += vf_decimate.o
 OBJS-$(CONFIG_DERAIN_FILTER)                 += vf_derain.o
 OBJS-$(CONFIG_DECONVOLVE_FILTER)             += vf_convolve.o framesync.o
 OBJS-$(CONFIG_DEDOT_FILTER)                  += vf_dedot.o
+OBJS-$(CONFIG_DEEPDVC_DRV_CUDA_FILTER)       += vf_deepdvc_drv_cuda.o rtx_cuda.o
 OBJS-$(CONFIG_DEFLATE_FILTER)                += vf_neighbor.o
 OBJS-$(CONFIG_DEFLICKER_FILTER)              += vf_deflicker.o
 OBJS-$(CONFIG_DEINTERLACE_D3D12_FILTER)      += vf_deinterlace_d3d12.o
diff --git a/libavfilter/allfilters.c b/libavfilter/allfilters.c
index 6704a9cd06..592b33dfb0 100644
--- a/libavfilter/allfilters.c
+++ b/libavfilter/allfilters.c
@@ -249,6 +249,7 @@ extern const FFFilter ff_vf_deblock;
 extern const FFFilter ff_vf_decimate;
 extern const FFFilter ff_vf_deconvolve;
 extern const FFFilter ff_vf_dedot;
+extern const FFFilter ff_vf_deepdvc_drv_cuda;
 extern const FFFilter ff_vf_deflate;
 extern const FFFilter ff_vf_deflicker;
 extern const FFFilter ff_vf_deinterlace_qsv;
diff --git a/libavfilter/vf_deepdvc_drv_cuda.c b/libavfilter/vf_deepdvc_drv_cuda.c
new file mode 100644
index 0000000000..f442f05249
--- /dev/null
+++ b/libavfilter/vf_deepdvc_drv_cuda.c
@@ -0,0 +1,300 @@
+/*
+ *  
+ *
+ * This file is part of FFmpeg.
+ *
+ * FFmpeg is free software; you can redistribute it and/or
+ * modify it under the terms of the GNU Lesser General Public
+ * License as published by the Free Software Foundation; either
+ * version 2.1 of the License, or (at your option) any later version.
+ *
+ * FFmpeg is distributed in the hope that it will be useful,
+ * but WITHOUT ANY WARRANTY; without even the implied warranty of
+ * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
+ * Lesser General Public License for more details.
+ *
+ * You should have received a copy of the GNU Lesser General Public
+ * License along with FFmpeg; if not, write to the Free Software
+ * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
+ */
+
+/**
+ * @file
+ * Color/vibrance-enhancement filter driving the   *driver* DeepDVC network
+ * (= "RTX Dynamic Vibrance"; the DXVA/PPE plugin nvaidvcx.dll,
+ * ppe/features/DeepDVC).  Sibling of vf_vsr_drv_cuda / vf_truehdr_drv_cuda: the
+ * plugin's cubins were extracted and the forward pass reverse-engineered by
+ * running it on Linux via loader_ppe and intercepting the live CUDA Driver-API
+ * launches.  dvc_drv_cuda_gen.h encodes how the whole graph (grids, scratch
+ * allocations, packed arg-buffer scalars, weight-upload targets, pointer fixups)
+ * scales with the frame W,H -- derived and validated by the rtxv.fit pipeline.
+ * The filter evaluates that at config time and replays the graph with libcuda;
+ * no DLL is needed at run time.  The replay machinery itself is rtx_cuda.c.
+ *
+ * DeepDVC is an HDRnet-style learned enhancer: a small CNN
+ * (surfaceToDownsampleHalfTensor -> instanceNorm2d/k_conv_fp16_nhwc/mean/
+ * finalConv_kernel_temporal) predicts a coefficient grid (mergeLUT_kernel) that
+ * applyLUTToSurface applies at full resolution.  It is SAME-RESOLUTION and
+ * IN-PLACE: applyLUTToSurface reads (TLD) and writes (SUST) one image handle, and
+ * surfaceToDownsampleHalfTensor reads that same frame -- so the whole graph binds
+ * a single frame texture (unified TEXMODE lets one texture handle serve both the
+ * sample and the surface store; a surface handle there fails the TLD).
+ *
+ * Two tunables, both a final blend strength applied in applyLUTToSurface (so
+ * vibrance=0 is an exact identity/pass-through): vibrance (params 0x10 -> arg
+ * 0x20) and gain (params 0x14 -> arg 0x24).  RGBA8 in/out.
+ *
+ * The cubins and the weights blob are external files (the "data" option),
+ * extracted from the open-sourced; conference shared driver and not shipped with FFmpeg.
+ */
+
+#include "libavutil/hwcontext.h"
+#include "libavutil/mem.h"
+#include "libavutil/opt.h"
+#include "libavutil/pixdesc.h"
+
+#include "avfilter.h"
+#include "filters.h"
+#include "rtx_cuda.h"
+#include "video.h"
+
+/* Generated by rtx-video-re from the open-sourced; conference shared   library, and
+ * installed rather than carried here -- located, together with the cubins and
+ * weights it names, through pkg-config (see configure's nvfdata_* checks). */
+#include <dvc_drv_cuda_gen.h>
+
+FF_RTX_ASSERT_MODULE_LAYOUT(DvcModule);
+FF_RTX_ASSERT_FUNC_LAYOUT(DvcFunc);
+FF_RTX_ASSERT_UPLOAD_LAYOUT(DvcGenUpload);
+FF_RTX_ASSERT_LAUNCH_LAYOUT(DvcGenLaunch);
+
+/* applyLUTToSurface arg-buffer offsets of the two tunable floats (params
+ * 0x10/0x14; a final blend strength).  applyLUTToSurface is the last launch. */
+#define DVCDRV_APPLY_VIBRANCE_OFF 0x20
+#define DVCDRV_APPLY_GAIN_OFF     0x24
+
+typedef struct DvcDrvCudaContext {
+    const AVClass *class;
+
+    FFRtxCuda   r;
+    FFRtxImage *frame;                ///< the one in-place frame image
+
+    int W, H;                         ///< frame size (in == out)
+    int cfg;                          ///< index into dvcdrv_configs
+
+    const FFRtxPixFmt *pf;
+
+    float vibrance;                   ///< applyLUTToSurface arg 0x20 (params 0x10)
+    float gain;                       ///< applyLUTToSurface arg 0x24 (params 0x14)
+    int   experimental_arch;          ///< allow the unverified non-Blackwell path
+    char *data_dir;
+} DvcDrvCudaContext;
+
+#define OFFSET(x) offsetof(DvcDrvCudaContext, x)
+#define FLAGS (AV_OPT_FLAG_VIDEO_PARAM | AV_OPT_FLAG_FILTERING_PARAM)
+
+static const AVOption deepdvc_drv_cuda_options[] = {
+    /* Both are a final blend strength in applyLUTToSurface.  1.0 = the driver's
+     * default (byte-exact with the captured graph); 0 = identity/pass-through;
+     * higher = stronger saturation.  vibrance is the primary control. */
+    { "vibrance", "vibrance strength (0=off/identity, 1=default, higher=stronger)",
+      OFFSET(vibrance), AV_OPT_TYPE_FLOAT, {.dbl=1.0}, 0, 8, FLAGS },
+    { "gain", "secondary saturation gain (1=default)",
+      OFFSET(gain), AV_OPT_TYPE_FLOAT, {.dbl=1.0}, 0, 8, FLAGS },
+    /* All cubins are multi-arch fatbins.  The 5 k_conv layers share one name and
+     * couldn't be paired across a major boundary by the fatbin repack's heuristic,
+     * so they originally carried only sm_120+sm_121.  Their genuine sm_86/sm_89
+     * slices were captured on real hardware (loader_ppe RTXV_CAPS) and injected by
+     * load order via `rtxv inject` -- byte-identical to the DLL.
+     * Blackwell (cc 12.x) is validated byte-exact; Ada (cc 8.9) is verified on an
+     * RTX 4060 Ti (all 15 modules load, 27 launches, byte-identical cubins to the
+     * DLL).  Still opt-in since only sm_89 was exercised on real Ada silicon. */
+    { "experimental_arch", "allow other sub-Blackwell arches (sm_89/Ada does not need this; needs injected per-arch k_conv cubins)",
+      OFFSET(experimental_arch), AV_OPT_TYPE_BOOL, {.i64=0}, 0, 1, FLAGS },
+    { "data", "directory with extracted driver DeepDVC cubins + weights.bin",
+      OFFSET(data_dir), AV_OPT_TYPE_STRING,
+      {.str=DVCDRV_DEFAULT_DATA_DIR}, 0, 0, FLAGS },
+    { NULL }
+};
+
+AVFILTER_DEFINE_CLASS(deepdvc_drv_cuda);
+
+FF_RTX_ASSERT_PRIV_LAYOUT(DvcDrvCudaContext);
+
+/* The glue kernels carry sm_75/80/86/89/120/121 (sm_80 serves Ampere/Ada via
+ * minor-version compat); the five k_conv layers carry sm_86/89/120/121, their
+ * sm_86/sm_89 slices captured on real hardware and injected by load order.  An
+ * Ampere/Ada card without those injected slices would fail at module load. */
+static const FFRtxArchGate dvcdrv_gate = {
+    .gate_msg =
+        "deepdvc_drv_cuda is validated on Blackwell (cc 12.x) and Ada (cc 8.9); "
+        "this GPU is cc %d.%d.  Other Ampere/Ada needs per-arch k_conv cubins "
+        "injected and is unverified -- set experimental_arch=1 to attempt it.\n",
+    .warn_msg =
+        "deepdvc_drv_cuda: EXPERIMENTAL sub-Blackwell (cc %d.%d) path -- other "
+        "Ampere/Ada need their k_conv slices injected "
+        "(`rtxv inject`) or module load will fail.\n",
+};
+
+/* ------------------------------------------------------------------------- *
+ * One-time graph setup for the selected config + W,H (context current).
+ * ------------------------------------------------------------------------- */
+static void fill_sizes(AVFilterContext *ctx, long long *sz)
+{
+    DvcDrvCudaContext *s = ctx->priv;
+    dvcdrv_fill_allocs(s->cfg, s->W, s->H, s->W, s->H, sz);
+}
+
+static int setup_graph(AVFilterContext *ctx)
+{
+    DvcDrvCudaContext *s = ctx->priv;
+    const DvcConfig *c = &dvcdrv_configs[s->cfg];
+    DvcGenUpload *up;
+    int ret, nup, li;
+
+    if ((ret = ff_rtx_arch_gate(ctx, &s->r, &dvcdrv_gate, s->experimental_arch)) < 0)
+        return ret;
+    if ((ret = ff_rtx_load_modules(ctx, &s->r, s->data_dir,
+                                   (const FFRtxModule *)c->modules, c->nmod, DVCDRV_MAX_MID,
+                                   (const FFRtxFunc *)c->funcs, c->nfunc, DVCDRV_MAX_FID,
+                                   NULL)) < 0)
+        return ret;
+    if ((ret = ff_rtx_alloc_arena(ctx, &s->r, c->nalloc, fill_sizes, 0)) < 0)
+        return ret;
+
+    up = av_calloc(c->nupload, sizeof(*up));
+    if (!up)
+        return AVERROR(ENOMEM);
+    nup = dvcdrv_fill_uploads(s->cfg, s->W, s->H, s->W, s->H,
+                              (const dvcdrv_devptr *)s->r.alloc, up);
+    ret = ff_rtx_upload_weights(ctx, &s->r, s->data_dir, "weights.bin",
+                                (const FFRtxUpload *)up, nup);
+    av_freep(&up);
+    if (ret < 0)
+        return ret;
+
+    /* Single in-place frame image.  SURFACE_LDST so applyLUTToSurface's SUST
+     * store is valid; the texture (linear/normalized/wrap, matching the loader)
+     * feeds both the sample reads and the surface store via one bindless
+     * handle. */
+    s->frame = ff_rtx_image_array(ctx, &s->r, s->W, s->H, s->pf->cufmt,
+                                  FF_RTX_TEX | FF_RTX_LDST);
+    if (!s->frame)
+        return AVERROR_EXTERNAL;
+
+    if ((ret = ff_rtx_alloc_launches(ctx, &s->r, c->nlaunch, sizeof(DvcGenLaunch))) < 0)
+        return ret;
+    /* DeepDVC is in-place: both I/O fixups are the one frame texture, so it is
+     * passed as both the tex and the surf handle.  The casts are only
+     * `unsigned long long *` vs `uint64_t *` on LP64. */
+    if (dvcdrv_fill_graph(s->cfg, s->W, s->H, s->W, s->H,
+                          (const dvcdrv_devptr *)s->r.alloc,
+                          (dvcdrv_devptr)s->frame->tex, (dvcdrv_devptr)s->frame->tex,
+                          s->r.launches) != c->nlaunch) {
+        av_log(ctx, AV_LOG_ERROR, "generated fill disagrees with the config tables\n");
+        return AVERROR_BUG;
+    }
+
+    /* Tunables: patch the two blend floats on applyLUTToSurface (params 0x10/0x14
+     * -> arg 0x20/0x24).  Default 1.0 == the captured graph (byte-exact); 0 =
+     * identity/pass-through. */
+    li = ff_rtx_find_launch(&s->r, (const FFRtxFunc *)c->funcs, c->nfunc,
+                            "applyLUTToSurface");
+    if (li < 0) {
+        av_log(ctx, AV_LOG_ERROR, "no applyLUTToSurface launch for config %s\n", c->tag);
+        return AVERROR_BUG;
+    }
+    {
+        uint8_t *a = ff_rtx_launch_at(&s->r, li)->params;
+        memcpy(a + DVCDRV_APPLY_VIBRANCE_OFF, &s->vibrance, 4);
+        memcpy(a + DVCDRV_APPLY_GAIN_OFF,     &s->gain,     4);
+        av_log(ctx, AV_LOG_VERBOSE,
+               "applyLUTToSurface tunables: vibrance=%g gain=%g (launch %d)\n",
+               s->vibrance, s->gain, li);
+    }
+
+    av_log(ctx, AV_LOG_INFO,
+           "driver DeepDVC graph ready: %s  %dx%d  (%d launches, %d buffers)\n",
+           c->tag, s->W, s->H, s->r.nlaunch, s->r.nalloc);
+    return 0;
+}
+
+/* ------------------------------------------------------------------------- *
+ * Per-frame: copy the frame into the in-place image, replay the graph, copy out.
+ * ------------------------------------------------------------------------- */
+static int filter_frame(AVFilterLink *inlink, AVFrame *in)
+{
+    DvcDrvCudaContext *s = inlink->dst->priv;
+    /* In place: the graph reads and enhances the one frame image.  psize is the
+     * kernel's own cbank size, NOT the captured argsize. */
+    const FFRtxFrameOp op = {
+        .in_img = s->frame,  .iW = s->W, .iH = s->H, .ibpp = s->pf->bpp,
+        .out_img = s->frame, .oW = s->W, .oH = s->H, .obpp = s->pf->bpp,
+        .flags = FF_RTX_OP_PSIZE,
+    };
+
+    return ff_rtx_filter_frame(inlink, in, &s->r, &op, NULL);
+}
+
+static int config_output(AVFilterLink *outlink)
+{
+    AVFilterContext *ctx = outlink->src;
+    AVFilterLink *inlink = ctx->inputs[0];
+    DvcDrvCudaContext *s = ctx->priv;
+    AVHWFramesContext *in_frames_ctx;
+    /* DeepDVC's format selectors are not mapped, so the network is driven as raw
+     * 4-channel 8-bit in the array's byte order and cannot be told to swap.  It
+     * is a learned per-channel colour enhancer, so a B-first frame would be
+     * enhanced as if blue were red -- accept only the R-first rows and let the
+     * caller insert a conversion, rather than silently hue-shifting.  The output
+     * is always the input format. */
+    const FFRtxFormats fmts = {
+        .in_tbl = ff_rtx_packed_rgb_fmts, .n_in = FF_RTX_N_RGB8_R_FIRST,
+        .hint   = "use rgb0/rgba",
+    };
+    int ret;
+
+    /* This can run again on a link reconfigure or a graph rebuild; drop the
+     * previous graph first so the rebuild neither leaks nor inherits stale
+     * device pointers. */
+    ff_rtx_free_graph(ctx, &s->r);
+
+    if ((ret = ff_rtx_config_formats(ctx, inlink, &fmts, &in_frames_ctx,
+                                     &s->pf, NULL)) < 0)
+        return ret;
+
+    s->W = inlink->w;
+    s->H = inlink->h;
+
+    s->cfg = dvcdrv_config_index(0, 0);
+    if (s->cfg < 0) {
+        av_log(ctx, AV_LOG_ERROR, "no DeepDVC config\n");
+        return AVERROR(ENOSYS);
+    }
+
+    if ((ret = ff_rtx_bind_device(ctx, &s->r, in_frames_ctx)) < 0)
+        return ret;
+    if ((ret = ff_rtx_config_hwframes(ctx, outlink, &s->r, s->W, s->H, s->pf->f)) < 0)
+        return ret;
+    return ff_rtx_setup(ctx, &s->r, "driver DeepDVC", setup_graph);
+}
+
+static const AVFilterPad deepdvc_drv_cuda_inputs[] = {
+    { .name = "default", .type = AVMEDIA_TYPE_VIDEO, .filter_frame = filter_frame },
+};
+
+static const AVFilterPad deepdvc_drv_cuda_outputs[] = {
+    { .name = "default", .type = AVMEDIA_TYPE_VIDEO, .config_props = config_output },
+};
+
+const FFFilter ff_vf_deepdvc_drv_cuda = {
+    .p.name        = "deepdvc_drv_cuda",
+    .p.description  = NULL_IF_CONFIG_SMALL("  driver RTX Dynamic Vibrance / DeepDVC (CUDA)"),
+    .p.priv_class  = &deepdvc_drv_cuda_class,
+    .priv_size     = sizeof(DvcDrvCudaContext),
+    .uninit        = ff_rtx_uninit,
+    FILTER_INPUTS(deepdvc_drv_cuda_inputs),
+    FILTER_OUTPUTS(deepdvc_drv_cuda_outputs),
+    FILTER_SINGLE_PIXFMT(AV_PIX_FMT_CUDA),
+    .flags_internal = FF_FILTER_FLAG_HWFRAME_AWARE,
+};


____

    avfilter/rtx_cuda: clean up comments
---
 libavfilter/rtx_cuda.c             |  57 ++---------
 libavfilter/rtx_cuda.h             | 104 +++----------------
 libavfilter/vf_deepdvc_drv_cuda.c  |  28 +-----
 libavfilter/vf_dlpp_drv_cuda.c     |  31 +-----
 libavfilter/vf_isr_cuda.c          |  51 +++-------
 libavfilter/vf_smoothmotion_cuda.c | 198 +++++++++----------------------------
 libavfilter/vf_truehdr_cuda.c      |  69 ++-----------
 libavfilter/vf_truehdr_drv_cuda.c  |  76 +++-----------
 8 files changed, 112 insertions(+), 502 deletions(-)

diff --git a/libavfilter/rtx_cuda.c b/libavfilter/rtx_cuda.c
index 43784bd7fc..b77e25f7df 100644
--- a/libavfilter/rtx_cuda.c
+++ b/libavfilter/rtx_cuda.c
@@ -36,9 +36,8 @@
 
 #define CHECK_CU(x) FF_CUDA_CHECK_DL(ctx, r->hwctx->internal->cuda_dl, x)
 
-/* Arena sub-buffer alignment (>= cuMemAlloc's own guarantee, which the
- * per-buffer allocations used to rely on) and a trailing guard covering the
- * tile/halo over-read past the final buffer described in the header. */
+/* Arena sub-buffer alignment (>= cuMemAlloc's own guarantee) and a trailing
+ * guard covering the tile/halo over-read past the final buffer. */
 #define RTX_ALLOC_ALIGN 512
 #define RTX_ALLOC_GUARD (1 << 20)
 
@@ -61,11 +60,6 @@ const FFRtxPixFmt *ff_rtx_find_fmt(const FFRtxPixFmt *tbl, int n,
 
 /* ------------------------------------------------------------------------- *
  * cuSurfObjectCreate/Destroy
- *
- * The only pair ffnvcodec's dynlink loader does not export, so it comes
- * straight out of libcuda -- once per process.  libcuda is already loaded (the
- * hwcontext holds it) and lives for the process, so this neither dlcloses nor
- * refcounts.
  * ------------------------------------------------------------------------- */
 typedef CUresult (*tcuSurfObjectCreate)(FFCUsurfObject *, const CUDA_RESOURCE_DESC *);
 typedef CUresult (*tcuSurfObjectDestroy)(FFCUsurfObject);
@@ -128,9 +122,6 @@ int ff_rtx_config_formats(AVFilterContext *ctx, AVFilterLink *inlink,
     if (!outpf)
         return 0;
 
-    /* av_get_pix_fmt() strcmps its argument, so an option cleared to NULL --
-     * av_opt_set(..., "format", NULL, 0) is legal for a string option -- must
-     * not reach it. */
     if (f->out_format && *f->out_format) {
         fmt = av_get_pix_fmt(f->out_format);
         if (fmt == AV_PIX_FMT_NONE) {
@@ -231,8 +222,6 @@ int ff_rtx_arch_gate(AVFilterContext *ctx, FFRtxCuda *r,
         av_log(ctx, AV_LOG_ERROR, gate->hard_msg, cc_major, cc_minor);
         return AVERROR(ENOSYS);
     }
-    /* Blackwell (cc 12.x) and Ada (cc 8.9) are the two the cubins were verified
-     * byte-exact on; everything else needs the opt-in. */
     if (cc_major >= 12 || (cc_major == 8 && cc_minor == 9))
         return 0;
     if (!experimental) {
@@ -274,9 +263,6 @@ int ff_rtx_load_modules(AVFilterContext *ctx, FFRtxCuda *r, const char *dir,
             av_log(ctx, AV_LOG_ERROR, "cannot read cubin %s\n", path);
             return ret;
         }
-        /* Every cubin is a multi-arch fatbin; cuModuleLoadData picks the image
-         * for the running GPU, so a failure here means this data dir carries
-         * none. */
         ret = CHECK_CU(cu->cuModuleLoadData(&r->mod[mods[i].mid], buf));
         av_file_unmap(buf, bsz);
         if (ret < 0) {
@@ -330,8 +316,6 @@ int ff_rtx_alloc_arena(AVFilterContext *ctx, FFRtxCuda *r, int nalloc,
     }
 
     fill_sizes(ctx, sz);
-    /* Lay the arena out in one pass, parking each ordinal's offset in alloc[]
-     * until there is a base address to add it to. */
     for (int a = 0; a < nalloc; a++) {
         r->alloc[a] = total;
         total += FFALIGN(sz[a] > 0 ? (size_t)sz[a] : 1, RTX_ALLOC_ALIGN);
@@ -346,9 +330,6 @@ int ff_rtx_alloc_arena(AVFilterContext *ctx, FFRtxCuda *r, int nalloc,
         r->alloc[a] += r->arena;
 
     if (flags & FF_RTX_ARENA_ZERO) {
-        /* cuMemAlloc does not zero.  Start from a known-zero arena so any
-         * scratch a kernel reads before writing is deterministically 0, as in a
-         * fresh loader process; the weight uploads then fill their buffers. */
         if ((ret = CHECK_CU(cu->cuMemsetD8Async(r->arena, 0, total, r->stream))) < 0)
             return ret;
         if ((ret = CHECK_CU(cu->cuStreamSynchronize(r->stream))) < 0)
@@ -406,22 +387,19 @@ int ff_rtx_upload_weights(AVFilterContext *ctx, FFRtxCuda *r, const char *dir,
             ret = AVERROR_INVALIDDATA;
             break;
         }
-        /* Async: a graph carries hundreds of small uploads (dlpp_drv: 525
-         * averaging 8.8 KiB) and the blocking form pays its round trip on every
-         * one of them.  The source is the mapping below, which has to stay put
-         * until the copies land -- hence the synchronize before it is dropped. */
+        /* Async: a graph carries hundreds of small uploads and the blocking form
+         * pays its round trip on every one.  The source is the mapping below,
+         * which has to stay put until the copies land -- hence the synchronize
+         * before it is dropped. */
         ret = CHECK_CU(cu->cuMemcpyHtoDAsync((CUdeviceptr)up[i].dst,
                                              weights + up[i].file_off, up[i].size,
                                              r->stream));
         if (ret < 0)
             break;
-        /* Track how far into the arena the uploads reach, so a later
-         * ff_rtx_snapshot_arena() only has to preserve that much. */
         end = (size_t)((CUdeviceptr)up[i].dst + up[i].size - r->arena);
         if (end > r->arena_uploaded)
             r->arena_uploaded = end;
     }
-    /* The copies read from the mapping, so they must complete before it goes. */
     if (ret >= 0)
         ret = CHECK_CU(cu->cuStreamSynchronize(r->stream));
     else
@@ -601,16 +579,6 @@ int ff_rtx_find_launch_prefix(const FFRtxCuda *r, const FFRtxFunc *funcs, int nf
 
 /* ------------------------------------------------------------------------- *
  * Per-frame replay
- *
- * None of this synchronizes.  Every op -- the input copy, all the launches, the
- * output copy -- is issued on the shared device stream (hwctx->stream), and
- * every consumer runs on it too: a downstream CUDA filter, or hwcontext_cuda's
- * transfer path, which copies on that same stream and syncs itself.  So stream
- * issue-order already orders our output before any read of it, and orders the
- * next producer's reuse of the freed input buffer after our read.  Blocking per
- * frame would only bound errors to this frame, at the cost of all CPU/GPU
- * overlap.  This relies on the single-shared-stream contract: a consumer on its
- * own context/stream would need an event at that boundary.
  * ------------------------------------------------------------------------- */
 int ff_rtx_filter_frame(AVFilterLink *inlink, AVFrame *in, FFRtxCuda *r,
                         const FFRtxFrameOp *op,
@@ -641,9 +609,6 @@ int ff_rtx_filter_frame(AVFilterLink *inlink, AVFrame *in, FFRtxCuda *r,
     if (ret < 0)
         goto fail;
 
-    /* Restore the arena to its post-upload state for a graph that reads scratch
-     * before writing it: a fresh process gets zeroed pages, a long-running host
-     * recycles dirty memory. */
     if (op->flags & FF_RTX_OP_RESET_ARENA) {
         ret = ff_rtx_reset_arena(ctx, r);
         if (ret < 0)
@@ -682,9 +647,6 @@ int ff_rtx_launch(AVFilterContext *ctx, FFRtxCuda *r, int fnid,
     void *extra[] = { CU_LAUNCH_PARAM_BUFFER_POINTER, params,
                       CU_LAUNCH_PARAM_BUFFER_SIZE, &psize, CU_LAUNCH_PARAM_END };
 
-    /* The tables are the generator's, but the sizes they are indexed against
-     * are the caller's -- ISR has to state them by hand, its header carrying no
-     * MAX_FID -- so an out-of-range id is a bug to report, not to dereference. */
     if (fnid < 0 || fnid > r->max_fid || !r->fn[fnid]) {
         av_log(ctx, AV_LOG_ERROR, "launch of unresolved kernel id %d (max %d)\n",
                fnid, r->max_fid);
@@ -762,11 +724,8 @@ int ff_rtx_fill_opaque_alpha(AVFilterContext *ctx, FFRtxCuda *r, AVFrame *out,
 
     /* Set just the alpha u16 of each pixel, stride = bpp.  A padded row is
      * covered by running over the padding too: it is inside the frame
-     * allocation and nothing reads it (hwframe transfers copy oW*bpp per row),
-     * so one memset does the whole plane instead of one per row -- which at 4K
-     * was over two thousand launches on the critical stream.  The pitch comes
-     * from cuMemAllocPitch and is a multiple of 512, hence of bpp, but fall
-     * back to the row loop rather than assume it. */
+     * allocation and nothing reads it, so one memset does the whole plane
+     * instead of one per row.  Fall back to the row loop if pitch % bpp != 0. */
     if (out->linesize[0] % (int)px == 0) {
         size_t stride_px = (size_t)out->linesize[0] / px;
         return CHECK_CU(cu->cuMemsetD2D16Async(a0, px, 0xFFFF, 1,
diff --git a/libavfilter/rtx_cuda.h b/libavfilter/rtx_cuda.h
index 8acb94a2d5..893c387dfa 100644
--- a/libavfilter/rtx_cuda.h
+++ b/libavfilter/rtx_cuda.h
@@ -70,7 +70,6 @@
 #ifndef CU_AD_FORMAT_UNORM_INT_101010_2
 #define CU_AD_FORMAT_UNORM_INT_101010_2 ((CUarray_format)0x50)
 #endif
-/* cuLaunchKernel packed-argument sentinels. */
 #ifndef CU_LAUNCH_PARAM_END
 #define CU_LAUNCH_PARAM_END            ((void*)0x00)
 #define CU_LAUNCH_PARAM_BUFFER_POINTER ((void*)0x01)
@@ -138,8 +137,7 @@ typedef struct FFRtxLaunch {
  * A frame format the graph can be bound to.  @p sel is the kernel's own format
  * selector where the network has one (VSR/DLPP: 0 = raw 8-bit RGB order,
  * 1 = raw 8-bit with an R<->B swap, 2 = the format-agnostic tex.f32 read /
- * sust.p store that packs any UNORM array in its native order); features
- * without a selector leave it 0, or reuse the field for their own flag.
+ * sust.p store that packs any UNORM array in its native order).
  */
 typedef struct FFRtxPixFmt {
     enum AVPixelFormat f;
@@ -150,10 +148,7 @@ typedef struct FFRtxPixFmt {
 
 /* The packed-RGB formats the VSR-family networks accept.  The R<->B swap only
  * exists on the raw 8-bit path, so B-first formats are 8-bit only; higher bit
- * depths go through the native-order sel-2 path.  A feature whose selector is
- * not mapped cannot honour sel at all, so it takes only the R-first 8-bit rows
- * (FF_RTX_N_RGB8_R_FIRST): feeding it a B-first frame would drive the network
- * with red and blue transposed. */
+ * depths go through the native-order sel-2 path. */
 extern const FFRtxPixFmt ff_rtx_packed_rgb_fmts[5];
 #define FF_RTX_N_RGB8_R_FIRST 2
 
@@ -165,8 +160,7 @@ const FFRtxPixFmt *ff_rtx_find_fmt(const FFRtxPixFmt *tbl, int n,
  * ------------------------------------------------------------------------- */
 /**
  * One image the graph binds: a CUDA array or a linear/pitched allocation, with
- * the bindless texture and/or surface handle over it.  Only the members the
- * requested binding needs are set; the rest stay zero.
+ * the bindless texture and/or surface handle over it.
  */
 typedef struct FFRtxImage {
     CUarray        arr;    ///< set for array-backed images
@@ -210,7 +204,6 @@ typedef struct FFRtxCuda {
     int                  ready;          ///< the graph is built and replayable
 } FFRtxCuda;
 
-/** The launch at index @p i of a graph built by ff_rtx_alloc_launches(). */
 static inline FFRtxLaunch *ff_rtx_launch_at(const FFRtxCuda *r, int i)
 {
     return (FFRtxLaunch *)((uint8_t *)r->launches + (size_t)i * r->launch_size);
@@ -236,9 +229,6 @@ void ff_rtx_uninit(AVFilterContext *ctx);
 /* ------------------------------------------------------------------------- *
  * Device binding and output plumbing
  * ------------------------------------------------------------------------- */
-/**
- * The formats a filter accepts, for ff_rtx_config_formats().
- */
 typedef struct FFRtxFormats {
     const FFRtxPixFmt *in_tbl;
     int                n_in;
@@ -252,24 +242,15 @@ typedef struct FFRtxFormats {
  * The config_output prologue every filter shares: require a CUDA hwframe input,
  * look its sw_format up in the input table, and resolve the output format --
  * the `format` option when set, else the input format -- in the output table.
- * @p outpf may be NULL for a filter whose output format is its input format.
  */
 int ff_rtx_config_formats(AVFilterContext *ctx, AVFilterLink *inlink,
                           const FFRtxFormats *f,
                           AVHWFramesContext **in_frames_ctx,
                           const FFRtxPixFmt **inpf, const FFRtxPixFmt **outpf);
 
-/**
- * Take a reference on the input frames context's device and cache the CUDA
- * context and stream.  Must be called before anything else touches @p r.
- */
 int ff_rtx_bind_device(AVFilterContext *ctx, FFRtxCuda *r,
                        AVHWFramesContext *in_frames_ctx);
 
-/**
- * Set the output link's size and build its CUDA frames context.  Call after
- * ff_rtx_bind_device() and before ff_rtx_setup().
- */
 int ff_rtx_config_hwframes(AVFilterContext *ctx, AVFilterLink *outlink,
                            FFRtxCuda *r, int oW, int oH,
                            enum AVPixelFormat sw_format);
@@ -305,8 +286,6 @@ int ff_rtx_arch_gate(AVFilterContext *ctx, FFRtxCuda *r,
 /**
  * Load every cubin named by @p mods out of @p dir and resolve every kernel in
  * @p funcs, into r->mod[]/r->fn[] sized for @p max_mid / @p max_fid.
- * @p load_hint, if set, is appended to a module-load failure (which is nearly
- * always "this data dir has no image for the running GPU").
  */
 int ff_rtx_load_modules(AVFilterContext *ctx, FFRtxCuda *r, const char *dir,
                         const FFRtxModule *mods, int nmod, int max_mid,
@@ -337,15 +316,8 @@ int ff_rtx_alloc_arena(AVFilterContext *ctx, FFRtxCuda *r, int nalloc,
 
 /**
  * Arrange for ff_rtx_reset_arena() to restore the arena to its post-upload
- * state.  For graphs that read scratch before writing it: a fresh process gets
- * zeroed pages from cuMemAlloc and is byte-exact, but a long-running host
- * recycles dirty memory, so the arena has to be put back between frames.
- *
- * Only the uploaded prefix is snapshotted.  ff_rtx_alloc_arena() zeroed the
- * whole arena and the uploads then wrote a prefix of it, so everything past the
- * last uploaded byte is known to be zero -- the reset can memset it instead of
- * copying it back, which is bit-identical and much cheaper (a device-to-device
- * copy reads and writes, a memset only writes).  Call after the uploads.
+ * state.  Only the uploaded prefix is snapshotted; everything past it is known
+ * to be zero so reset uses memset instead of copy.  Call after the uploads.
  */
 int ff_rtx_snapshot_arena(AVFilterContext *ctx, FFRtxCuda *r);
 int ff_rtx_reset_arena(AVFilterContext *ctx, FFRtxCuda *r);
@@ -370,19 +342,6 @@ int ff_rtx_alloc_launches(AVFilterContext *ctx, FFRtxCuda *r,
 #define FF_RTX_CLAMP (1 << 3)  ///< texture address mode CLAMP (else the default WRAP)
 #define FF_RTX_ZERO  (1 << 4)  ///< zero the backing store (pitched images only)
 
-/**
- * Bind a W x H image the graph can read and/or write.  Textures are always
- * created linear-filtered with normalized coordinates, which is what the
- * captured graphs sample with.
- *
- * ff_rtx_image_array()  -- a CUDA array, the usual input texture / output surface
- * ff_rtx_image_pitch()  -- pitched linear memory bound as a PITCH2D texture
- * ff_rtx_image_linear() -- a plain packed buffer, no texture or surface
- *
- * The returned pointer is owned by @p r and stays valid until
- * ff_rtx_free_graph(); NULL means the image could not be created (the reason is
- * already logged).
- */
 FFRtxImage *ff_rtx_image_array(AVFilterContext *ctx, FFRtxCuda *r, int W, int H,
                                CUarray_format cufmt, unsigned flags);
 FFRtxImage *ff_rtx_image_pitch(AVFilterContext *ctx, FFRtxCuda *r, int W, int H,
@@ -392,19 +351,13 @@ FFRtxImage *ff_rtx_image_linear(AVFilterContext *ctx, FFRtxCuda *r,
 
 /**
  * Bind a texture over pitched memory the caller owns -- an input frame's own
- * plane, say -- rather than over an image this core allocated.  Same descriptor
- * as ff_rtx_image_pitch() gives, so a filter that binds both ways samples both
- * the same; the caller owns the handle and destroys it.
+ * plane, say -- rather than over an image this core allocated.
  */
 int ff_rtx_tex_over_pitch(AVFilterContext *ctx, FFRtxCuda *r, CUdeviceptr ptr,
                           size_t pitch, int W, int H, CUarray_format cufmt,
                           unsigned flags, CUtexObject *tex);
 
-/**
- * Index of the first launch running kernel @p name, or -1.  For the features
- * whose generated config does not yet carry the launch index of a tunable's
- * kernel the way VSR's sel_launch does.
- */
+/** Index of the first launch running kernel @p name, or -1. */
 int ff_rtx_find_launch(const FFRtxCuda *r, const FFRtxFunc *funcs, int nfunc,
                        const char *name);
 /** As ff_rtx_find_launch(), matching a kernel-name prefix. */
@@ -419,10 +372,6 @@ int ff_rtx_find_launch_prefix(const FFRtxCuda *r, const FFRtxFunc *funcs, int nf
 #define FF_RTX_OP_RESET_ARENA  (1 << 1)  ///< restore the pristine arena before each frame
 #define FF_RTX_OP_OPAQUE_ALPHA (1 << 2)  ///< force opaque alpha over the output
 
-/**
- * What one frame through a configured graph consists of.  in_img and out_img
- * are the same image for a filter that works in place.
- */
 typedef struct FFRtxFrameOp {
     const FFRtxImage *in_img, *out_img;
     int iW, iH, ibpp;
@@ -436,8 +385,8 @@ typedef struct FFRtxFrameOp {
 /**
  * One whole frame: take the output buffer, copy the input frame's properties,
  * push the CUDA context, replay the graph over the frame, pop, and forward the
- * result.  @p retag, if set, adjusts the output frame's properties (the TrueHDR
- * filters retag SDR input as HDR) before the graph runs.  Consumes @p in.
+ * result.  @p retag, if set, adjusts the output frame's properties before the
+ * graph runs.  Consumes @p in.
  */
 int ff_rtx_filter_frame(AVFilterLink *inlink, AVFrame *in, FFRtxCuda *r,
                         const FFRtxFrameOp *op,
@@ -450,9 +399,8 @@ int ff_rtx_launch(AVFilterContext *ctx, FFRtxCuda *r, int fnid,
 
 /**
  * Issue the whole launch list in order.  @p use_psize selects the kernel's own
- * EIATTR_CBANK_PARAM_SIZE rather than the captured driver argsize -- the driver
- * over-reports for some DLPP tex/surf kernels, which makes cuLaunchKernel fail
- * with CUDA_ERROR_LAUNCH_OUT_OF_RESOURCES.
+ * EIATTR_CBANK_PARAM_SIZE rather than the captured driver argsize -- needed for
+ * some DLPP tex/surf kernels that over-report and would otherwise fail.
  */
 int ff_rtx_launch_all(AVFilterContext *ctx, FFRtxCuda *r, int use_psize);
 
@@ -465,13 +413,8 @@ int ff_rtx_image_to_frame(AVFilterContext *ctx, FFRtxCuda *r,
                           int W, int H, int bpp);
 
 /**
- * Force opaque alpha over @p out.  The resample store kernel
- * (dlpp_ResampleAndComposeFP16) omits the alpha write in its formatted path --
- * unlike postProcess, which stores 1.0 -- so >= 10-bit output on the resample
- * path would come out fully transparent (RGB is correct; verified in SASS, and
- * the SDK DLL has the same omission).  These networks always produce opaque
- * output, so this runs for any sel-2 output: it fixes the resample case and is
- * a harmless no-op on the fast path.
+ * Force opaque alpha over @p out.  The resample store kernel omits the alpha
+ * write in its formatted path so >= 10-bit output would come fully transparent.
  */
 int ff_rtx_fill_opaque_alpha(AVFilterContext *ctx, FFRtxCuda *r, AVFrame *out,
                              int oW, int oH, int bpp);
@@ -479,30 +422,15 @@ int ff_rtx_fill_opaque_alpha(AVFilterContext *ctx, FFRtxCuda *r, AVFrame *out,
 /* ------------------------------------------------------------------------- *
  * Teardown and helpers
  * ------------------------------------------------------------------------- */
-/**
- * Release everything ff_rtx_* built, against the CUDA context it was built on,
- * and reset @p r so a graph can be built again.  Safe when nothing is
- * configured.  config_output() may run more than once -- a mid-stream
- * reconfigure, or a media player rebuilding its filter graph on seek -- so this
- * must leave no leaked allocation and no stale device pointer baked into a
- * launch argument block.
- */
+/** Release everything ff_rtx_* built and reset @p r so a graph can be rebuilt. Safe when nothing is configured. */
 void ff_rtx_free_graph(AVFilterContext *ctx, FFRtxCuda *r);
 
-/**
- * Evaluate the `w`/`h` output-size expressions over in_w/iw/in_h/ih.  An unset
- * or empty expression means @p defscale x the input.
- */
+/** Evaluate the `w`/`h` output-size expressions over in_w/iw/in_h/ih. An unset or empty expression means @p defscale x the input. */
 int ff_rtx_eval_dims(AVFilterContext *ctx, AVFilterLink *inlink,
                      const char *w_expr, const char *h_expr, int defscale,
                      int *oW, int *oH);
 
-/**
- * TrueHDR's internal network resolution: shorter side -> 544, longer side
- * aspect-scaled and quantized to a multiple of 32.  Must bit-match the float32
- * arithmetic of rtxv.fit.truehdr.nn_dims (verified byte-exact across 28
- * resolutions).
- */
+/** TrueHDR's internal network resolution: shorter side -> 544, longer side aspect-scaled and quantized to a multiple of 32. */
 void ff_rtx_nn_dims(int W, int H, int *NW, int *NH);
 
 #endif /* AVFILTER_RTX_CUDA_H */
diff --git a/libavfilter/vf_deepdvc_drv_cuda.c b/libavfilter/vf_deepdvc_drv_cuda.c
index f442f05249..0ec0ec0f44 100644
--- a/libavfilter/vf_deepdvc_drv_cuda.c
+++ b/libavfilter/vf_deepdvc_drv_cuda.c
@@ -94,9 +94,6 @@ typedef struct DvcDrvCudaContext {
 #define FLAGS (AV_OPT_FLAG_VIDEO_PARAM | AV_OPT_FLAG_FILTERING_PARAM)
 
 static const AVOption deepdvc_drv_cuda_options[] = {
-    /* Both are a final blend strength in applyLUTToSurface.  1.0 = the driver's
-     * default (byte-exact with the captured graph); 0 = identity/pass-through;
-     * higher = stronger saturation.  vibrance is the primary control. */
     { "vibrance", "vibrance strength (0=off/identity, 1=default, higher=stronger)",
       OFFSET(vibrance), AV_OPT_TYPE_FLOAT, {.dbl=1.0}, 0, 8, FLAGS },
     { "gain", "secondary saturation gain (1=default)",
@@ -136,9 +133,6 @@ static const FFRtxArchGate dvcdrv_gate = {
         "(`rtxv inject`) or module load will fail.\n",
 };
 
-/* ------------------------------------------------------------------------- *
- * One-time graph setup for the selected config + W,H (context current).
- * ------------------------------------------------------------------------- */
 static void fill_sizes(AVFilterContext *ctx, long long *sz)
 {
     DvcDrvCudaContext *s = ctx->priv;
@@ -173,10 +167,8 @@ static int setup_graph(AVFilterContext *ctx)
     if (ret < 0)
         return ret;
 
-    /* Single in-place frame image.  SURFACE_LDST so applyLUTToSurface's SUST
-     * store is valid; the texture (linear/normalized/wrap, matching the loader)
-     * feeds both the sample reads and the surface store via one bindless
-     * handle. */
+    /* In-place: one handle serves as both texture (sample reads) and surface
+     * store (applyLUTToSurface). */
     s->frame = ff_rtx_image_array(ctx, &s->r, s->W, s->H, s->pf->cufmt,
                                   FF_RTX_TEX | FF_RTX_LDST);
     if (!s->frame)
@@ -184,9 +176,7 @@ static int setup_graph(AVFilterContext *ctx)
 
     if ((ret = ff_rtx_alloc_launches(ctx, &s->r, c->nlaunch, sizeof(DvcGenLaunch))) < 0)
         return ret;
-    /* DeepDVC is in-place: both I/O fixups are the one frame texture, so it is
-     * passed as both the tex and the surf handle.  The casts are only
-     * `unsigned long long *` vs `uint64_t *` on LP64. */
+    /* In-place: the frame texture is both tex and surf handle. */
     if (dvcdrv_fill_graph(s->cfg, s->W, s->H, s->W, s->H,
                           (const dvcdrv_devptr *)s->r.alloc,
                           (dvcdrv_devptr)s->frame->tex, (dvcdrv_devptr)s->frame->tex,
@@ -195,9 +185,7 @@ static int setup_graph(AVFilterContext *ctx)
         return AVERROR_BUG;
     }
 
-    /* Tunables: patch the two blend floats on applyLUTToSurface (params 0x10/0x14
-     * -> arg 0x20/0x24).  Default 1.0 == the captured graph (byte-exact); 0 =
-     * identity/pass-through. */
+    /* Patch blend floats on applyLUTToSurface. */
     li = ff_rtx_find_launch(&s->r, (const FFRtxFunc *)c->funcs, c->nfunc,
                             "applyLUTToSurface");
     if (li < 0) {
@@ -219,14 +207,9 @@ static int setup_graph(AVFilterContext *ctx)
     return 0;
 }
 
-/* ------------------------------------------------------------------------- *
- * Per-frame: copy the frame into the in-place image, replay the graph, copy out.
- * ------------------------------------------------------------------------- */
 static int filter_frame(AVFilterLink *inlink, AVFrame *in)
 {
     DvcDrvCudaContext *s = inlink->dst->priv;
-    /* In place: the graph reads and enhances the one frame image.  psize is the
-     * kernel's own cbank size, NOT the captured argsize. */
     const FFRtxFrameOp op = {
         .in_img = s->frame,  .iW = s->W, .iH = s->H, .ibpp = s->pf->bpp,
         .out_img = s->frame, .oW = s->W, .oH = s->H, .obpp = s->pf->bpp,
@@ -254,9 +237,6 @@ static int config_output(AVFilterLink *outlink)
     };
     int ret;
 
-    /* This can run again on a link reconfigure or a graph rebuild; drop the
-     * previous graph first so the rebuild neither leaks nor inherits stale
-     * device pointers. */
     ff_rtx_free_graph(ctx, &s->r);
 
     if ((ret = ff_rtx_config_formats(ctx, inlink, &fmts, &in_frames_ctx,
diff --git a/libavfilter/vf_dlpp_drv_cuda.c b/libavfilter/vf_dlpp_drv_cuda.c
index 9f5e99cf05..c9572389bd 100644
--- a/libavfilter/vf_dlpp_drv_cuda.c
+++ b/libavfilter/vf_dlpp_drv_cuda.c
@@ -110,15 +110,8 @@ typedef struct DlppDrvCudaContext {
 #define FLAGS (AV_OPT_FLAG_VIDEO_PARAM | AV_OPT_FLAG_FILTERING_PARAM)
 
 static const AVOption dlpp_drv_cuda_options[] = {
-    /* DLPP quality selects the internal SR network (model index via params +0xc).
-     * q1 -> base model 1; q2 -> deeper model 2 (both do a fixed internal 2x +
-     * resample for other ratios). q3/q4 -> the high-quality models 5/6, which do
-     * NATIVE integer upscaling at the `scale` factor (2/3/4) and require output =
-     * scale x input. Default 1.
-     *
-     * The driver's own index 0 selects the same model 1 as index 1, and produces a
-     * byte-identical graph.  It is not exposed: one model under two numbers only
-     * invites someone to A/B them and find no difference. */
+    /* Driver index 0 selects the same model as index 1 -- not exposed to avoid
+     * confusion. */
     { "quality", "DLPP quality (1=base, 2=deeper; 3/4=native-scale high quality)", OFFSET(quality), AV_OPT_TYPE_INT, {.i64=1}, 1, 4, FLAGS },
     /* Native SR scale for quality 3/4 only (ignored for 1/2): 2/3/4 -> the driver's
      * pixel_shuffle2/3/4 head (params[0x38]). Exact scale x input output uses the
@@ -180,9 +173,6 @@ static const FFRtxArchGate dlppdrv_gate = {
         "sm_80 image, unverified on real hardware.\n",
 };
 
-/* ------------------------------------------------------------------------- *
- * One-time graph setup for the selected config + W,H,oW,oH (context current).
- * ------------------------------------------------------------------------- */
 static void fill_sizes(AVFilterContext *ctx, long long *sz)
 {
     DlppDrvCudaContext *s = ctx->priv;
@@ -217,8 +207,6 @@ static int setup_graph(AVFilterContext *ctx)
     if (ret < 0)
         return ret;
 
-    /* input array + texture (linear/normalized/clamp; the frame is copied in
-     * each frame), and the output array + surface (the SUST.P target). */
     s->in_img = ff_rtx_image_array(ctx, &s->r, s->W, s->H, s->inpf->cufmt,
                                    FF_RTX_TEX | FF_RTX_CLAMP);
     s->out_img = ff_rtx_image_array(ctx, &s->r, s->oW, s->oH, s->outpf->cufmt,
@@ -226,11 +214,7 @@ static int setup_graph(AVFilterContext *ctx)
     if (!s->in_img || !s->out_img)
         return AVERROR_EXTERNAL;
 
-    /* Build the graph.  dlppdrv_fill_graph() is generated from the same fit as
-     * the tables above and assigns every field through its named
-     * dlppdrv_*_params struct, so the argument blocks are constructed rather
-     * than patched.  The casts are only `unsigned long long *` vs `uint64_t *`
-     * on LP64. */
+    /* Build the graph. */
     if ((ret = ff_rtx_alloc_launches(ctx, &s->r, c->nlaunch, sizeof(DlppGenLaunch))) < 0)
         return ret;
     if (dlppdrv_fill_graph(s->cfg, s->W, s->H, s->oW, s->oH,
@@ -241,15 +225,12 @@ static int setup_graph(AVFilterContext *ctx)
         return AVERROR_BUG;
     }
 
-    /* Format selectors, on the shared DLPP glue kernels. */
     if ((ret = ff_dlpp_patch_selectors(ctx, &s->r, funcs, c->nfunc,
                                        s->inpf, s->outpf, c->tag, &pre)) < 0)
         return ret;
     srchead = ff_rtx_find_launch_prefix(&s->r, funcs, c->nfunc, DLPPDRV_SRC_HEAD_KERNEL);
 
-    /* Split-screen comparison wipe (params +0x10 -> SR-head kernel arg @0x498 =
-     * round(oW*wipe)).  0 (default) leaves the byte-exact-with-the-DLL full-SR
-     * output; >0 shows the left oW*wipe columns as the bicubic reference. */
+    /* Split-screen comparison wipe. */
     if (s->wipe > 0) {
         uint32_t col = (uint32_t)(s->wipe * (float)s->oW + 0.5f);
         if (srchead < 0) {
@@ -281,13 +262,9 @@ static int setup_graph(AVFilterContext *ctx)
     return 0;
 }
 
-/* ------------------------------------------------------------------------- *
- * Per-frame: bind the input frame as a texture, replay the graph, copy out.
- * ------------------------------------------------------------------------- */
 static int filter_frame(AVFilterLink *inlink, AVFrame *in)
 {
     DlppDrvCudaContext *s = inlink->dst->priv;
-    /* psize is the kernel's own cbank size, NOT the captured argsize */
     const FFRtxFrameOp op = {
         .in_img = s->in_img,  .iW = s->W,  .iH = s->H,  .ibpp = s->inpf->bpp,
         .out_img = s->out_img, .oW = s->oW, .oH = s->oH, .obpp = s->outpf->bpp,
diff --git a/libavfilter/vf_isr_cuda.c b/libavfilter/vf_isr_cuda.c
index 5aa5458e34..7a49ea619f 100644
--- a/libavfilter/vf_isr_cuda.c
+++ b/libavfilter/vf_isr_cuda.c
@@ -80,16 +80,12 @@
 FF_RTX_ASSERT_MODULE_LAYOUT(IsrModule);
 FF_RTX_ASSERT_FUNC_LAYOUT(IsrFunc);
 
-/* ISR's module tables index modules and kernels densely from 0, and its graph is
- * captured rather than fitted, so the generated header carries no MAX_MID/FID. */
+/* Captured graph has no MAX_MID/FID in the generated header; we define them here. */
 #define ISR_MAX_MID 64
 #define ISR_MAX_FID 128
 
-/* IsrGenLaunch is the odd one out: no psize (every launch uses the captured
- * argsize), and three extra fields carrying the per-tile pointer cursor, which
- * is the one thing that still advances per tile at frame time rather than once
- * at config time.  So this filter drives ff_rtx_launch() itself instead of
- * handing the whole list to ff_rtx_launch_all(). */
+/* IsrGenLaunch: no psize (uses captured argsize), plus per-tile pointer cursor
+ * that advances at frame time, so this filter drives ff_rtx_launch() itself. */
 
 typedef struct IsrCudaContext {
     const AVClass *class;
@@ -110,9 +106,7 @@ typedef struct IsrCudaContext {
 #define FLAGS (AV_OPT_FLAG_VIDEO_PARAM | AV_OPT_FLAG_FILTERING_PARAM)
 
 static const AVOption isr_cuda_options[] = {
-    /* The snippet validates Scale to exactly {2,4,8} (CreateFeature rejects
-     * anything else with 0xBAD00005) and has no resampling path, so the output is
-     * always scale x the input -- there is deliberately no w/h expression here. */
+    /* Snippet only accepts {2,4,8} and has no resampling path. */
     { "scale", "integer upscale factor (2, 4 or 8)", OFFSET(scale),
       AV_OPT_TYPE_INT, {.i64 = 2}, 2, 8, FLAGS },
     { "data", "directory with the extracted ISR cubins, fat binaries and weights",
@@ -125,22 +119,12 @@ AVFILTER_DEFINE_CLASS(isr_cuda);
 
 FF_RTX_ASSERT_PRIV_LAYOUT(IsrCudaContext);
 
-/* The snippet keeps a separate class variant per architecture (sm_75 / _86 /
- * _89 / _120 / _120 PTX), so a capture only ever yields the capturing GPU's
- * images.  `rtxv extract isr` lifts the other arches straight out of the DLL --
- * they are named there, so the correspondence is exact -- and bundles each
- * kernel as a sm_75+86+89+120 fatbin that cuModuleLoadData picks from.  A data
- * dir built that way covers Turing through Blackwell; one that was not still
- * holds bare single-arch cubins, hence this hint. */
+/* Snippet ships per-arch variants; `rtxv extract isr` bundles them as fatbins. */
 #define ISR_LOAD_HINT \
     "Re-run `rtxv extract isr <nvngx_dlisr.dll>` and `rtxv install`: the " \
     "generator bundles the sm_75/86/89/120 images the snippet ships. " \
     "Newer architectures than sm_120 need a capture on that GPU."
 
-/* ------------------------------------------------------------------------- *
- * Resolution model -- the same closed forms rtx-video-re's rtxv.gen.isr verifies
- * against live captures.
- * ------------------------------------------------------------------------- */
 static int isr_tiles_axis(int n)
 {
     return n <= ISR_TILE ? 1 : 1 + (n - ISR_TILE + ISR_STRIDE - 1) / ISR_STRIDE;
@@ -180,8 +164,7 @@ static int setup_graph(AVFilterContext *ctx)
     if ((ret = ff_rtx_alloc_arena(ctx, &s->r, c->nalloc, fill_sizes, 0)) < 0)
         return ret;
 
-    /* Packed RGBA8 staging: the graph's convert kernels read/write a tightly
-     * packed buffer, while AVFrame CUDA planes are pitched. */
+    /* Packed RGBA8 staging: convert kernels need tight buffers, not pitched. */
     s->in_buf  = ff_rtx_image_linear(ctx, &s->r, (size_t)s->W * s->H * 4,
                                      (size_t)s->W * 4);
     s->out_buf = ff_rtx_image_linear(ctx, &s->r, (size_t)s->oW * s->oH * 4,
@@ -189,8 +172,7 @@ static int setup_graph(AVFilterContext *ctx)
     if (!s->in_buf || !s->out_buf)
         return AVERROR_EXTERNAL;
 
-    /* Unlike the fitted features, ISR's uploads are a literal table addressed by
-     * allocation ordinal and byte offset rather than a generated fill. */
+    /* ISR uploads: literal table by allocation ordinal + byte offset. */
     up = av_calloc(c->nupload, sizeof(*up));
     if (!up)
         return AVERROR(ENOMEM);
@@ -204,11 +186,7 @@ static int setup_graph(AVFilterContext *ctx)
     if (ret < 0)
         return ret;
 
-    /* Materialise every launch: template args, scalar patches, pointer fixups.
-     * isr_fill_graph() is generated from the same capture as the tables above and
-     * assigns every field through its named isr_*_params struct, so the argument
-     * blocks are constructed rather than patched by offset.  The casts are only
-     * `unsigned long long` vs `uint64_t` on LP64. */
+    /* Build the graph: isr_fill_graph() assigns fields through named params structs. */
     if ((ret = ff_rtx_alloc_launches(ctx, &s->r, c->nlaunch, sizeof(IsrGenLaunch))) < 0)
         return ret;
     if (isr_fill_graph(s->cfg, s->W, s->H, s->scale, (const isr_devptr *)s->r.alloc,
@@ -229,8 +207,7 @@ static int isr_launch(AVFilterContext *ctx, IsrGenLaunch *r, int tile)
 {
     IsrCudaContext *s = ctx->priv;
 
-    /* The per-tile launches differ only in where they read from / write to in the
-     * tile batch, so point the cursor at this tile rather than rebuilding args. */
+    /* Advance per-tile cursor to this tile's batch slot. */
     if (r->cur_off >= 0) {
         CUdeviceptr p = r->cur_base + r->cur_stride * tile;
         memcpy(r->params + r->cur_off, &p, 8);
@@ -246,19 +223,18 @@ static int isr_run(AVFilterContext *ctx)
     IsrGenLaunch *rl = s->r.launches;
     int ret;
 
-    /* whole-image pre-pass: convert to fp16, split into the tile batch */
+    /* Pre-pass: convert to fp16, split into tile batch. */
     for (int i = 0; i < c->pre_n; i++)
         if ((ret = isr_launch(ctx, &rl[i], 0)) < 0)
             return ret;
 
-    /* the network body runs once per tile, in full, before moving to the next --
-     * every tile reuses the same scratch buffers, so the order matters */
+    /* Network body per tile: tiles reuse scratch buffers, so order matters. */
     for (int t = 0; t < s->tiles; t++)
         for (int i = 0; i < c->body_n; i++)
             if ((ret = isr_launch(ctx, &rl[c->pre_n + i], t)) < 0)
                 return ret;
 
-    /* whole-image post-pass: stitch the tiles, convert back to RGBA8 */
+    /* Post-pass: stitch tiles, convert back to RGBA8. */
     for (int i = 0; i < c->post_n; i++)
         if ((ret = isr_launch(ctx, &rl[c->pre_n + c->body_n + i], 0)) < 0)
             return ret;
@@ -268,8 +244,7 @@ static int isr_run(AVFilterContext *ctx)
 static int filter_frame(AVFilterLink *inlink, AVFrame *in)
 {
     IsrCudaContext *s = inlink->dst->priv;
-    /* isr_run() replaces the plain launch list: the per-tile pointer cursor is
-     * the one thing that still advances at frame time. */
+    /* isr_run() handles per-tile pointer cursor that advances at frame time. */
     const FFRtxFrameOp op = {
         .in_img = s->in_buf,   .iW = s->W,  .iH = s->H,  .ibpp = s->pf->bpp,
         .out_img = s->out_buf, .oW = s->oW, .oH = s->oH, .obpp = s->pf->bpp,
diff --git a/libavfilter/vf_smoothmotion_cuda.c b/libavfilter/vf_smoothmotion_cuda.c
index 68d925caaa..3ce8eed6e9 100644
--- a/libavfilter/vf_smoothmotion_cuda.c
+++ b/libavfilter/vf_smoothmotion_cuda.c
@@ -67,12 +67,7 @@
  * weights it names, through pkg-config (see configure's nvfdata_* checks). */
 #include <smoothmotion_cuda_gen.h>
 
-/* The packed array formats the output surface takes; the rest of what this
- * filter needs (CU_TRSF_NORMALIZED_COORDINATES, cuSurfObjectCreate) comes from
- * rtx_cuda.h, which resolves it once per process rather than per instance.
- * PITCH2D textures only accept the base integer formats (the packed
- * UNORM_INT*X4 are array-only); UNSIGNED_INT8/16 with normalized coords still
- * read as [0,1]. */
+/* Packed array formats for output surface. PITCH2D textures only accept base integer types. */
 #ifndef CU_AD_FORMAT_UNORM_INT8X4
 #define CU_AD_FORMAT_UNORM_INT8X4 ((CUarray_format)0xc2)
 #endif
@@ -85,18 +80,14 @@
 
 #define SM_CH 4
 
-/* One module id past the per-kernel fatbins, for the conversion PTX this filter
- * carries itself: parking it in the shared module table means ff_rtx_free_graph()
- * unloads it with the rest. */
+/* Conversion PTX slot past fatbins; unloaded with the graph by ff_rtx_free_graph(). */
 #define SM_CVT_MID SM_NLAUNCH
 
 typedef struct SmoothMotionContext {
     const AVClass *class;
 
-    /* The shared core owns the device reference, the module table, the arena the
-     * scratch buffers are cut from and every image below, and releases the lot in
-     * ff_rtx_free_graph().  What stays here is what this filter does differently:
-     * a launch list refilled per frame, and its own format conversion. */
+    /* Core owns device/modules/arena/images (freed by ff_rtx_free_graph).
+     * This filter owns per-frame launches and format conversion. */
     FFRtxCuda   r;
 
     int W, H;                           ///< frame size the graph is built for
@@ -105,15 +96,10 @@ typedef struct SmoothMotionContext {
     SMGenLaunch gen[SM_NLAUNCH];
     unsigned long long sb[4];
 
-    /* Inputs are bound as bindless textures DIRECTLY over pitched device memory
-     * (CU_RESOURCE_TYPE_PITCH2D), like vf_bwdif_cuda - no input CUDA arrays/copies.
-     * The warp textures (t_in*) carry the renderable data (RGBA, or packed Y,U,V);
-     * the flow textures (t_fl*) carry what the downscale/optical-flow backbone reads
-     * (== warp textures for RGB, or luma-grey Y,Y,Y for YUV).  The OUTPUT must stay
-     * a CUDA array: the warp writes it via SUST.P and cuSurfObjectCreate requires
-     * an array.  For RGB the input textures are (re)bound per-frame over the source
-     * frames -- the only handles this filter owns rather than the core; for YUV
-     * they are the pack buffers' own persistent textures. */
+    /* Inputs: PITCH2D textures over pitched memory (no arrays/copies). Warp textures
+     * carry renderable data; flow textures are warp aliases for RGB, luma-grey for YUV.
+     * Output must be a CUDA array (SUST.P). RGB input textures rebound per-frame;
+     * YUV uses persistent pack buffer textures. */
     FFRtxImage  *out_img;               ///< network output: array + surface
     FFRtxImage  *warp0, *warp1;         ///< packed input buffers + their textures
     FFRtxImage  *flow0, *flow1;         ///< luma-grey flow buffers + textures (YUV)
@@ -157,34 +143,17 @@ typedef struct SmoothMotionContext {
 #define V AV_OPT_FLAG_VIDEO_PARAM
 #define F AV_OPT_FLAG_FILTERING_PARAM
 
-/* `data` defaults to SM_DEFAULT_DATA_DIR, which the generated header states --
- * the same <FEAT>_DEFAULT_DATA_DIR the other filters' headers here carry.  It
- * names wherever the   tool wrote the files it fitted this table
- * alongside, so the table and the kernels can never silently mismatch.  This
- * file used to rebuild that path itself, from a hardcoded workspace root plus
- * the driver version, which could only be right on one machine.  There is
- * deliberately no fallback: a header lacking the define predates it, and
- * building against it is the very mismatch the define prevents, so it fails
- * here rather than at load time.
- *
- * The layout under it is this feature's own -- the per-kernel fatbins live in a
- * fatbins/ subdirectory rather than loose beside weights.bin as the other
- * features' cubins do -- but that is the data dir's business, not the caller's,
- * so it is derived here and there is one `data` option like everywhere else. */
+/* Data layout: fatbins in subdirectory, weights.bin alongside. No fallback path. */
 #define SM_FATBIN_SUBDIR "fatbins"
 #define SM_WEIGHTS_FILE  "weights.bin"
 
 static const AVOption smoothmotion_cuda_options[] = {
-    /* The network only synthesises the t=0.5 midpoint, so the output rate is
-     * always exactly 2x the input - there is no target-rate option. */
+    /* Network emits t=0.5 midpoint only; output is always 2x input rate. */
     { "interp_start", "point to start interpolation",             OFFSET(interp_start),         AV_OPT_TYPE_INT,    {.i64=15},    0, 255, V|F },
     { "interp_end",   "point to end interpolation",               OFFSET(interp_end),           AV_OPT_TYPE_INT,    {.i64=240},   0, 255, V|F },
     { "data",         "directory with the extracted Smooth Motion kernel fatbins + " SM_WEIGHTS_FILE,
                                                                   OFFSET(data_dir),             AV_OPT_TYPE_STRING, {.str=SM_DEFAULT_DATA_DIR}, 0, 0, V|F },
-    /* Emit the network's native packed buffer instead of de-interleaving it:
-     * RGB/x2rgb10 -> rgba64 (a plain copy, no repack), YUV -> packed 4:4:4
-     * (VUYX 8-bit / XV48LE 16-bit).  Lets a packed-format consumer skip a
-     * redundant unpack+repack round-trip. */
+    /* Emit native packed buffer (rgba64 for RGB/x2rgb10, VUYX/XV48LE for YUV). */
     { "packed",       "emit the network's packed output directly", OFFSET(packed),              AV_OPT_TYPE_BOOL,   {.i64=0},     0, 1,   V|F },
     { NULL }
 };
@@ -193,11 +162,7 @@ AVFILTER_DEFINE_CLASS(smoothmotion_cuda);
 
 FF_RTX_ASSERT_PRIV_LAYOUT(SmoothMotionContext);
 
-/* ------------------------------------------------------------------------- *
- * Kernel loading (table-driven, modules deduplicated by name)
- * ------------------------------------------------------------------------- */
-/* Every fatbin the driver ships carries every architecture it supports, so a
- * module that will not load means this data dir was built without them. */
+/* Kernel loading: table-driven, modules deduplicated by name. */
 #define SM_LOAD_HINT \
     "Re-run `rtxv extract smoothmotion <lib -present.so>` and " \
     "`rtxv install`: the kernels are carved out of the driver as whole " \
@@ -213,9 +178,7 @@ static int load_kernels(AVFilterContext *ctx)
     char        dir[1024];
     int         nmod = 0;
 
-    /* One multi-arch fatbin per kernel, deduplicated by name -- several launches
-     * run the same kernel.  The driver picks the cubin matching the device's arch
-     * (cuModuleLoadData accepts a fatbin image). */
+    /* One multi-arch fatbin per kernel, deduplicated by name. */
     for (int i = 0; i < SM_NLAUNCH; i++) {
         const char *name = sm_kernel_names[i];
         int m;
@@ -244,18 +207,14 @@ static int load_kernels(AVFilterContext *ctx)
 static int format_is_planar444_16(enum AVPixelFormat fmt);
 static int format_is_packed_yuv(enum AVPixelFormat fmt);
 
-/* The element format the input textures read: PITCH2D takes only the base
- * integer types, and UNSIGNED_INT8/16 with normalized coords still read as
- * [0,1], matching the array path byte for byte. */
+/* PITCH2D accepts only base integer types; normalized coords read as [0,1]. */
 static CUarray_format sm_tex_format(const SmoothMotionContext *s)
 {
     return s->elem_bytes == 8 ? CU_AD_FORMAT_UNSIGNED_INT16
                               : CU_AD_FORMAT_UNSIGNED_INT8;
 }
 
-/* Bind a texture over a source frame's own memory (the straight-through RGB
- * path, which the network reads without a pack pass).  Rebound per frame, so
- * unlike every other handle here it is this filter's to destroy. */
+/* Bind texture over source frame memory (RGB path). Rebound per-frame; destroyed by this filter. */
 static int make_input_tex(AVFilterContext *ctx, CUdeviceptr ptr, size_t pitch,
                           CUtexObject *tex)
 {
@@ -265,12 +224,7 @@ static int make_input_tex(AVFilterContext *ctx, CUdeviceptr ptr, size_t pitch,
                                  sm_tex_format(s), FF_RTX_CLAMP, tex);
 }
 
-/* ------------------------------------------------------------------------- *
- * Allocate scratch + weights, generate the graph for WxH, build I/O objects.
- * Must be called with the CUDA context current.
- * ------------------------------------------------------------------------- */
-/* The four scratch buffers the generated graph works over, order {W,sA,sB,sC};
- * the weights land in the first. */
+/* Four scratch buffers {W,sA,sB,sC}; weights land in W buffer. */
 static void fill_sizes(AVFilterContext *ctx, long long *sz)
 {
     SmoothMotionContext *s = ctx->priv;
@@ -281,7 +235,7 @@ static void fill_sizes(AVFilterContext *ctx, long long *sz)
         sz[a] = (long long)v[a];
 }
 
-/* The pack/unpack kernel pair for the input format, out of the conversion PTX. */
+/* Pack/unpack kernels from conversion PTX. */
 static int setup_convert_kernels(AVFilterContext *ctx)
 {
     extern const unsigned char ff_vf_smoothmotion_cuda_ptx_data[];
@@ -291,9 +245,7 @@ static int setup_convert_kernels(AVFilterContext *ctx)
     const char *packfn, *unpackfn;
     int ret;
 
-    /* packed RGB (x2rgb10) unpacks to RGBA16 and repacks (no chroma, and no
-     * separate luma-grey flow buffer since the net derives luma internally);
-     * YUV packs to (Y,U,V) + luma-grey flow and de-interleaves to planar. */
+    /* packed RGB: unpacks to RGBA16, repacks on output; YUV: packs to (Y,U,V) + luma-grey flow. */
     if (s->is_packed_rgb) {
         packfn   = s->format == AV_PIX_FMT_X2BGR10LE ? "Pack_x2bgr10" : "Pack_x2rgb10";
         unpackfn = s->format == AV_PIX_FMT_X2BGR10LE ? "Unpack_x2bgr10" : "Unpack_x2rgb10";
@@ -315,14 +267,11 @@ static int setup_convert_kernels(AVFilterContext *ctx)
                    s->format == AV_PIX_FMT_P212 ||
                    s->format == AV_PIX_FMT_P216    ? "Pack_p216" :
                                                      "Pack_p016";   /* P010/P016 */
-        /* The warp buffer is already interleaved in VUYX / XV48LE order, so
-         * `packed` output is a direct copy (no unpack kernel); only the planar
-         * path needs to de-interleave. */
+    /* VUYX/XV48LE warp buffer is already in output order; `packed` copies directly. */
         unpackfn = s->elem_bytes == 8 ? "Unpack_yuv444p16" : "Unpack_yuv444p";
     }
 
-    /* Loaded into the module table's reserved slot so it is unloaded with the
-     * fatbins rather than needing a teardown of its own. */
+    /* Loaded into reserved slot; unloaded with graph by ff_rtx_free_graph(). */
     ret = ff_cuda_load_module(ctx, s->r.hwctx, &s->r.mod[SM_CVT_MID],
                               ff_vf_smoothmotion_cuda_ptx_data,
                               ff_vf_smoothmotion_cuda_ptx_len);
@@ -345,18 +294,14 @@ static int setup_graph(AVFilterContext *ctx)
     if ((ret = load_kernels(ctx)) < 0)
         return ret;
 
-    /* One contiguous arena for the four scratch buffers, zeroed so any scratch a
-     * kernel reads before writing is deterministically 0.  Contiguity is the
-     * shared core's guarantee against a tile/halo read past a buffer's end
-     * landing in an unmapped hole once the heap fragments. */
+    /* Contiguous zeroed arena: contiguity prevents tile/halo reads crossing into unmapped holes. */
     if ((ret = ff_rtx_alloc_arena(ctx, &s->r, 4, fill_sizes, FF_RTX_ARENA_ZERO)) < 0)
         return ret;
     for (int a = 0; a < 4; a++)
         s->sb[a] = (unsigned long long)s->r.alloc[a];
-    /* the param graph (s->gen) is filled per-frame in interpolate_frame, once the
-     * tex/surf handles for the current frames exist (see sm_fill_params + SMHandles) */
+    /* Graph filled per-frame in interpolate_frame once tex/surf handles exist. */
 
-    /* weights -> sb[0] (the W buffer), which is sized for exactly them */
+    /* Weights -> sb[0] (W buffer), sized for exactly them. */
     fill_sizes(ctx, sz);
     up.file_off = 0;
     up.size     = sz[0];
@@ -365,9 +310,7 @@ static int setup_graph(AVFilterContext *ctx)
                                      &up, 1)) < 0)
         return ret;
 
-    /* OUTPUT array + surface: the warp writes via SUST.P, and cuSurfObjectCreate
-     * requires a CUDA array (no pitch2d/linear surfaces).  Packed UNORM_INT8X4/16X4
-     * makes the (unused) texture path return [0,1]; SURFACE_LDST enables SUST.P. */
+    /* Output array + surface: warp writes via SUST.P; cuSurfObjectCreate needs an array. */
     s->out_img = ff_rtx_image_array(ctx, &s->r, s->W, s->H,
                                     s->elem_bytes == 8 ? CU_AD_FORMAT_UNORM_INT16X4
                                                        : CU_AD_FORMAT_UNORM_INT8X4,
@@ -375,10 +318,7 @@ static int setup_graph(AVFilterContext *ctx)
     if (!s->out_img)
         return AVERROR_EXTERNAL;
 
-    /* YUV and packed RGB: the pack/unpack kernels plus the persistent buffers
-     * both frames are packed into, each carrying its own input texture.  (The
-     * straight-through RGB path binds its textures per frame over the source
-     * frames instead, in interpolate_frame.) */
+    /* YUV/packed-RGB: persistent pack buffers + input textures. RGB path binds per-frame. */
     if (s->is_yuv || s->is_packed_rgb) {
         const CUarray_format tf = sm_tex_format(s);
         const unsigned tex = FF_RTX_TEX | FF_RTX_CLAMP;
@@ -412,10 +352,7 @@ static int setup_graph(AVFilterContext *ctx)
            "(arena %.1f MiB)\n", s->W, s->H, (double)s->r.arena_size / (1 << 20));
     return 0;
 }
-/* ------------------------------------------------------------------------- *
- * Interpolation: replay the generated 25-launch graph.
- * ------------------------------------------------------------------------- */
-/* array->device (output CUDA array -> linear packed buffer for unpack) */
+/* Copy output array to linear packed buffer. */
 static int copy_array_to_lin(AVFilterContext *ctx, CUarray src, const FFRtxImage *dst)
 {
     SmoothMotionContext *s = ctx->priv;
@@ -427,8 +364,7 @@ static int copy_array_to_lin(AVFilterContext *ctx, CUarray src, const FFRtxImage
     return CHECK_CU(cu->cuMemcpy2DAsync(&c, s->r.stream));
 }
 
-/* pack a YUV source frame into the packed warp buffer (Y,U,V,255) and, if flow
- * != 0, the luma-grey flow buffer (Y,Y,Y,255), upsampling 4:2:0 chroma. */
+/* Pack YUV frame into warp + optional luma-grey flow buffers. */
 static int launch_pack(AVFilterContext *ctx, AVFrame *src,
                        const FFRtxImage *warp_img, const FFRtxImage *flow_img)
 {
@@ -476,7 +412,7 @@ static int launch_pack(AVFilterContext *ctx, AVFrame *src,
                                        0, s->r.stream, args, NULL));
 }
 
-/* de-interleave the linear packed buffer into a planar YUV444P frame */
+/* De-interleave packed buffer to planar YUV444P. */
 static int launch_unpack(AVFilterContext *ctx, const FFRtxImage *src_img, AVFrame *dst)
 {
     SmoothMotionContext *s = ctx->priv;
@@ -501,8 +437,7 @@ static int launch_unpack(AVFilterContext *ctx, const FFRtxImage *src_img, AVFram
                                        0, s->r.stream, args, NULL));
 }
 
-/* Emit a source frame through the output hwframe pool (device->device copy) so
- * every frame leaving the filter shares one hwframe context. */
+/* Passthrough: device->device copy to unify hwframe context. */
 static int passthrough_frame(AVFilterContext *ctx, AVFrame *src)
 {
     SmoothMotionContext *s = ctx->priv;
@@ -524,17 +459,12 @@ static int passthrough_frame(AVFilterContext *ctx, AVFrame *src)
             return ret;
         if ((ret = launch_unpack(ctx, s->warp0, s->work)) < 0)
             return ret;
-        /* No sync: the unpack into s->work is stream-ordered w.r.t. any
-         * same-stream downstream consumer, and nothing here depends on the
-         * host observing completion (matches every other CUDA filter). */
+        /* Stream-ordered; no sync needed. */
         return 0;
     }
 
     if (s->packed && (s->is_yuv || s->is_packed_rgb)) {
-        /* packed output: the pack kernel already writes the warp buffer in the
-         * output frame's byte order (VUYX / XV48LE for YUV, RGBA16 for x2rgb10),
-         * so run it into scratch and copy that out - no network, no repack.
-         * lin_warp0 is free here (no interpolation). */
+        /* Packed output: pack kernel writes in output byte order; copy directly. */
         if ((ret = launch_pack(ctx, src, s->warp0, NULL)) < 0)
             return ret;
         c.srcMemoryType = CU_MEMORYTYPE_DEVICE;
@@ -554,12 +484,9 @@ static int passthrough_frame(AVFilterContext *ctx, AVFrame *src)
     c.dstMemoryType = CU_MEMORYTYPE_DEVICE;
     c.dstDevice = (CUdeviceptr)s->work->data[0];
     c.dstPitch = s->work->linesize[0];
-    /* straight-through copy (RGB, rgba64, or x2rgb10 -> x2rgb10): frame_bytes is
-     * the true per-pixel size (4 for x2rgb10; elem_bytes is its internal 8). */
+    /* frame_bytes is the true per-pixel size (4 for x2rgb10; elem_bytes is internal 8). */
     c.WidthInBytes = s->W * s->frame_bytes;
     c.Height = s->H;
-    /* device->device async copy on the stream; no host-side sync needed - the
-     * result is ordered for any same-stream consumer downstream. */
     return CHECK_CU(cu->cuMemcpy2DAsync(&c, s->r.stream));
 }
 
@@ -576,14 +503,11 @@ static int interpolate_frame(AVFilterContext *ctx, int64_t work_pts)
     av_frame_copy_props(s->work, s->f0);
 
     if (s->is_yuv || s->is_packed_rgb) {
-        /* pack both frames into their persistent warp (+ luma-grey flow, YUV
-         * only) buffers; the input textures are already bound over these
-         * (setup_graph).  For packed RGB lin_flow* is unallocated (0) and ignored. */
+        /* Pack frames into persistent buffers; textures already bound. */
         if ((ret = launch_pack(ctx, s->f0, s->warp0, s->flow0)) < 0) return ret;
         if ((ret = launch_pack(ctx, s->f1, s->warp1, s->flow1)) < 0) return ret;
     } else {
-        /* RGB: bind input textures directly over the source frames (no copy).
-         * downscale reads the same RGB textures as the warp (t_fl* == t_in*). */
+        /* RGB: bind textures over source frames directly (no copy). */
         if ((ret = make_input_tex(ctx, (CUdeviceptr)s->f0->data[0],
                                   s->f0->linesize[0], &s->t_in0)) < 0) return ret;
         if ((ret = make_input_tex(ctx, (CUdeviceptr)s->f1->data[0],
@@ -592,9 +516,7 @@ static int interpolate_frame(AVFilterContext *ctx, int64_t work_pts)
         s->t_fl1 = s->t_in1;
     }
 
-    /* fill the graph with the current frames' tex/surf handles; sm_fill_params writes
-     * them into in_tex0/in_tex1/out_surf, so no by-offset patching here.  The flow
-     * (downscale) path uses the luma textures for YUV, == the warp textures for RGB. */
+    /* Fill graph with current frames' handles; sm_fill_params writes by field name. */
     SMHandles h = {
         .flow_tex = { s->t_fl0, s->t_fl1 },
         .warp_tex = { s->t_in0, s->t_in1 },
@@ -614,10 +536,9 @@ static int interpolate_frame(AVFilterContext *ctx, int64_t work_pts)
             return ret;
     }
 
-    /* copy the warp output array back into the work frame */
+    /* Copy warp output to work frame. */
     if (!s->direct_out) {
-        /* packed array -> linear -> planar YUV444P, packed 4:4:4, or repacked
-         * x2rgb10 (whichever fn_unpack selects) */
+        /* Array -> linear -> planar YUV444P / packed 4:4:4 / repacked x2rgb10. */
         if ((ret = copy_array_to_lin(ctx, s->out_img->arr, s->unpack_buf)) < 0)
             return ret;
         if ((ret = launch_unpack(ctx, s->unpack_buf, s->work)) < 0)
@@ -635,13 +556,7 @@ static int interpolate_frame(AVFilterContext *ctx, int64_t work_pts)
             return ret;
     }
 
-    /* RGB input textures are bound per-frame over the source frames; release them
-     * now that the launches have completed (YUV textures are persistent).  This
-     * is the only sync the filter needs: cuTexObjectDestroy is a host call with
-     * no stream ordering, so the downscale/warp launches that read these textures
-     * must be drained first.  The YUV and packed-RGB paths have persistent
-     * textures (no per-frame destroy) and are fully stream-ordered downstream,
-     * so they return without blocking. */
+    /* RGB: sync then destroy per-frame input textures (YUV has persistent textures). */
     if (!s->is_yuv && !s->is_packed_rgb) {
         ret = CHECK_CU(cu->cuStreamSynchronize(s->r.stream));
         if (s->t_in0) CHECK_CU(cu->cuTexObjectDestroy(s->t_in0));
@@ -651,7 +566,7 @@ static int interpolate_frame(AVFilterContext *ctx, int64_t work_pts)
     return ret;
 }
 
-/* cadence: choose / synthesize the next output frame (from vf_nvoffruc) */
+/* Cadence: choose or synthesize next output frame. */
 static int process_work_frame(AVFilterContext *ctx)
 {
     SmoothMotionContext *s = ctx->priv;
@@ -706,11 +621,7 @@ static av_cold int init(AVFilterContext *ctx)
     return 0;
 }
 
-/* Drop the graph.  ff_rtx_free_graph() releases everything the core allocated --
- * the modules, the arena, every image and the device reference -- against the
- * context it was built on; what is left here is the handles this filter owns
- * itself, which alias core-owned textures on the YUV path and so must be
- * dropped rather than destroyed. */
+/* Drop graph: core releases modules/arena/images/device; we null our own handles. */
 static void free_graph(AVFilterContext *ctx)
 {
     SmoothMotionContext *s = ctx->priv;
@@ -913,9 +824,7 @@ retry:
         goto exit;
     }
 
-    /* FF_FILTER_FORWARD_WANTED expanded: the macro returns 0 directly, which
-     * would skip the pop below and leave our context on the thread's stack -- on
-     * the most-taken path through activate(), so it would grow once per frame. */
+    /* Must not return early without popping: leaves CUDA context on thread stack. */
     if (ff_outlink_frame_wanted(outlink)) {
         ff_inlink_request_frame(inlink);
         ret = 0;
@@ -948,10 +857,7 @@ static int config_output(AVFilterLink *outlink)
     enum AVPixelFormat out_format;
     int exact, ret;
 
-    /* This can run again on a link reconfigure or a graph rebuild; drop the
-     * previous graph first so the rebuild neither leaks nor inherits stale
-     * device pointers, and drop the buffered source frames with it -- they are
-     * sized for the old configuration. */
+    /* Reconfigure: drop previous graph + buffered frames (sized for old config). */
     free_graph(ctx);
     av_frame_free(&s->f0);
     av_frame_free(&s->f1);
@@ -990,20 +896,13 @@ static int config_output(AVFilterLink *outlink)
     }
     s->is_yuv = format_is_yuv(s->format);
     s->is_packed_rgb = format_is_packed_rgb(s->format);
-    /* 8 bytes/pixel for any 16-bit 4-channel INTERNAL path: the 16-bit YUV
-     * formats (routed through format_is_16bit), packed 16-bit RGBA (rgba64), and
-     * x2rgb10 (unpacked to RGBA16).  rgba64/x2rgb10 are RGB not YUV, so they are
-     * kept out of format_is_16bit/format_is_yuv. */
+    /* elem_bytes: internal packed pixel size (4 or 8). */
     s->elem_bytes = (format_is_16bit(s->format) ||
                      s->format == AV_PIX_FMT_RGBA64 ||
                      s->is_packed_rgb) ? 2 * SM_CH : SM_CH;
-    /* bytes per pixel of the actual frame; differs from elem_bytes only for
-     * x2rgb10 (a 32-bit packed word that unpacks to 8-byte RGBA16 internally). */
+    /* frame_bytes: actual per-pixel size (x2rgb10 is 4, elem_bytes is 8). */
     s->frame_bytes = s->is_packed_rgb ? 4 : s->elem_bytes;
-    /* output is a plain array->frame copy (no de-interleave kernel) for the
-     * straight-through RGB formats, and for every `packed` request: the network
-     * already writes VUYX / XV48LE (YUV) or RGBA16 (x2rgb10) in the output
-     * frame's byte order, so nothing needs reshuffling. */
+    /* direct_out: plain array->frame copy (RGB or `packed` output). */
     s->direct_out = (!s->is_yuv && !s->is_packed_rgb) || s->packed;
     s->W = inlink->w;
     s->H = inlink->h;
@@ -1014,12 +913,7 @@ static int config_output(AVFilterLink *outlink)
     if ((ret = ff_rtx_bind_device(ctx, &s->r, in_frames_ctx)) < 0)
         return ret;
 
-    /* YUV inputs are emitted as planar 4:4:4 (no output-side chroma downsample);
-     * the network produces packed 4:4:4 and we de-interleave it.  16-bit inputs
-     * (P010/P016) keep full precision via YUV444P16.  With `packed`, the network
-     * buffer is emitted directly: packed 4:4:4 (VUYX / XV48LE) for YUV, and the
-     * native RGBA16 (rgba64) for x2rgb10/x2bgr10.  The size is unchanged: this
-     * filter interpolates in time, not space. */
+    /* YUV -> planar 4:4:4 output; `packed` emits network buffer directly. Size unchanged. */
     if (s->is_yuv)
         out_format = s->packed ?
             (s->elem_bytes == 8 ? AV_PIX_FMT_XV48LE : AV_PIX_FMT_VUYX) :
diff --git a/libavfilter/vf_truehdr_cuda.c b/libavfilter/vf_truehdr_cuda.c
index 6b1b9acee5..b3e017823d 100644
--- a/libavfilter/vf_truehdr_cuda.c
+++ b/libavfilter/vf_truehdr_cuda.c
@@ -83,11 +83,7 @@ FF_RTX_ASSERT_FUNC_LAYOUT(ThdrFunc);
 FF_RTX_ASSERT_UPLOAD_LAYOUT(ThdrGenUpload);
 FF_RTX_ASSERT_LAUNCH_LAYOUT(ThdrGenLaunch);
 
-/* Supported packed frame formats.  The input is read format-agnostically through
- * a texture (normalized to [0,1]); R-first 8-bit (rgb0/rgba) is the standard SDR
- * input (there is no B-first path).  The output is HDR: fp16 rgba (default) or
- * 10-bit x2bgr10le, selected by two flag words in the drtm arg buffer -- carried
- * here in FFRtxPixFmt::sel. */
+/* Input: R-first 8-bit or 10-bit x2bgr10le (no B-first path). Output: HDR fp16 or 10-bit. */
 static const FFRtxPixFmt thdr_in_fmts[] = {
     { AV_PIX_FMT_RGB0,      CU_AD_FORMAT_UNSIGNED_INT8,       4, 0 },
     { AV_PIX_FMT_RGBA,      CU_AD_FORMAT_UNSIGNED_INT8,       4, 0 },
@@ -127,9 +123,7 @@ static const AVOption truehdr_cuda_options[] = {
     { "maxluminance", "peak luminance in nits (400..2000)", OFFSET(maxluminance), AV_OPT_TYPE_DOUBLE, {.dbl=1000}, 400, 2000, FLAGS },
     { "data", "directory with extracted TrueHDR cubins + weights.bin",
       OFFSET(data_dir), AV_OPT_TYPE_STRING, {.str=TRUEHDR_DEFAULT_DATA_DIR}, 0, 0, FLAGS },
-    /* Named rather than left NULL-for-the-default, so `format` reports what it
-     * does: unlike the super-resolution filters there is no same-as-input
-     * output here -- the whole point is the SDR->HDR change. */
+    /* Named default so `format` reports what it does (no same-as-input output here). */
     { "format", "output: rgbaf16le=scRGB linear Rec.709 80nit (default), x2bgr10le=HDR10 PQ Rec.2020",
       OFFSET(out_format), AV_OPT_TYPE_STRING, {.str="rgbaf16le"}, 0, 0, FLAGS },
     { NULL }
@@ -139,20 +133,11 @@ AVFILTER_DEFINE_CLASS(truehdr_cuda);
 
 FF_RTX_ASSERT_PRIV_LAYOUT(TrueHdrCudaContext);
 
-/* As for vsr_cuda: a capture only yields the capturing GPU's images, so
- * `rtxv extract truehdr` replaces each one with the snippet's own fatbin --
- * every architecture the DLL ships, plus the PTX -- and fills the conv backbone
- * in from the sibling ELFs.  A data dir built with --no-fatbins still holds
- * bare single-arch cubins, which is what a module-load failure here usually
- * means.  No arch gate: nothing in an SDK snippet's cubins is a
- * statically-matched guess needing an opt-in. */
+/* Capture yields only one GPU's images; `rtxv extract` repacks as multi-arch fatbins. */
 #define THDR_LOAD_HINT \
     "Re-run `rtxv extract truehdr <nvngx_truehdr.dll>` and `rtxv install`: the " \
     "generator repacks each kernel as the snippet's own multi-arch fatbin."
 
-/* ------------------------------------------------------------------------- *
- * One-time graph setup for W,H.  Must run with the CUDA context current.
- * ------------------------------------------------------------------------- */
 static void fill_sizes(AVFilterContext *ctx, long long *sz)
 {
     TrueHdrCudaContext *s = ctx->priv;
@@ -175,9 +160,7 @@ static int setup_graph(AVFilterContext *ctx)
                                    (const FFRtxFunc *)thdr_funcs, THDR_NFUNC, THDR_MAX_FID,
                                    THDR_LOAD_HINT)) < 0)
         return ret;
-    /* Zero the arena: calculate_pov and k_conv_fp16_nhwc read uninitialised
-     * scratch (compute-sanitizer initcheck), which in a fresh CLI process is
-     * zeroed pages and therefore byte-exact. */
+    /* Zero the arena: conv/pov kernels read scratch before writing. */
     if ((ret = ff_rtx_alloc_arena(ctx, &s->r, THDR_NALLOC, fill_sizes,
                                   FF_RTX_ARENA_ZERO)) < 0)
         return ret;
@@ -192,48 +175,24 @@ static int setup_graph(AVFilterContext *ctx)
     if (ret < 0)
         return ret;
 
-    /* Snapshot the pristine arena (weights + zeroed scratch); every frame resets
-     * it, so the graph always reads the same clean scratch instead of whatever
-     * the previous frame or another host (mpv) left behind. */
+    /* Snapshot pristine arena; reset from it each frame for clean scratch. */
     if ((ret = ff_rtx_snapshot_arena(ctx, &s->r)) < 0)
         return ret;
 
-    /* Input: pitched linear memory read with linear/normalized/clamp sampling
-     * (the texture unit normalizes any 8/10-bit UNORM format to [0,1]). */
     s->in_img = ff_rtx_image_pitch(ctx, &s->r, W, H, s->inpf->cufmt, s->inpf->bpp,
                                    FF_RTX_TEX | FF_RTX_CLAMP);
-    /* Zero texture bound to the graph's stale intermediate-texture handles (the
-     * generator's kind-4 fixups).  A small zeroed buffer read with clamp -> every
-     * sample is 0, exactly reproducing the read from an unbound handle that the
-     * CLI relied on (byte-exact), but as a real, safe object that can never alias
-     * a live texture. */
+    /* Zero texture for stale intermediate handles (kind-4 fixups): clamped read -> always 0. */
     s->zero = ff_rtx_image_pitch(ctx, &s->r, 64, 64, s->inpf->cufmt, s->inpf->bpp,
                                  FF_RTX_TEX | FF_RTX_CLAMP | FF_RTX_ZERO);
-    /* HDR output array + surface: fp16 rgba or 10-bit x2bgr10le. */
     s->out_img = ff_rtx_image_array(ctx, &s->r, W, H, s->outpf->cufmt,
                                     FF_RTX_SURF | FF_RTX_LDST);
-    /* Private scratch surface bound to the graph's stale scratch/clear surface
-     * handles (the generator's kind-3 fixups).  Several kernels write surfaces the
-     * DLL created as extra bindless objects (e.g. truehdr_postprocessing is a pure
-     * clear -- sust {0,0,0,0} over WxH -- and truehdr_debanding writes a scratch
-     * surface); their handles were baked as invariant literals with no fixup because
-     * the capture's PTX analysis only tagged the primary output surface.  In a fresh
-     * process the literals alias nothing (writes dropped, byte-exact), but in a busy
-     * CUDA context (mpv/nvdec, gpu-next's Vulkan interop) they alias LIVE objects --
-     * e.g. our own input texture gets postprocessing's handle -> the clear zeros the
-     * input -> black output.  Route all such writes here; nothing reads them back
-     * (no suld anywhere in the graph), so it is output-irrelevant and matches the
-     * byte-exact reference.  sust.p.v4.b32 -> 4x32-bit. */
+    /* Scratch surface for stale handle writes (kind-3 fixups): nothing reads them back. */
     s->scratch = ff_rtx_image_array(ctx, &s->r, W, H, CU_AD_FORMAT_UNSIGNED_INT32,
                                     FF_RTX_SURF | FF_RTX_LDST);
     if (!s->in_img || !s->zero || !s->out_img || !s->scratch)
         return AVERROR_EXTERNAL;
 
-    /* Build the graph.  thdr_fill_graph() is generated from the same fit as the
-     * tables above and assigns every field through its named thdr_*_params
-     * struct.  Kinds 3 and 4 are the two stale slots the SDK snippet leaves
-     * bound; they are given the private objects above rather than left dangling.
-     * The casts are only `unsigned long long *` vs `uint64_t *` on LP64. */
+    /* Build the graph: kinds 3/4 route stale handles to private objects. */
     if ((ret = ff_rtx_alloc_launches(ctx, &s->r, THDR_NLAUNCH, sizeof(ThdrGenLaunch))) < 0)
         return ret;
     handle[3] = (thdr_devptr)s->scratch->surf;
@@ -245,9 +204,7 @@ static int setup_graph(AVFilterContext *ctx)
         return AVERROR_BUG;
     }
 
-    /* drtm overrides: the 4 tunables (float32, computed in double then cast to
-     * bit-match the DLL) and the output-format flag words.  These sit at fixed
-     * offsets in the truehdr_drtm launch's arg buffer (see rtx-video-re). */
+    /* drtm overrides: tunables and output-format flags at fixed arg offsets. */
     if (THDR_DRTM_LAUNCH < 0 || THDR_DRTM_LAUNCH >= s->r.nlaunch) {
         av_log(ctx, AV_LOG_ERROR, "no drtm launch in graph\n");
         return AVERROR_BUG;
@@ -274,13 +231,7 @@ static int setup_graph(AVFilterContext *ctx)
     return 0;
 }
 
-/* ------------------------------------------------------------------------- *
- * Per-frame: bind the input frame as a texture, replay the graph, copy out.
- * ------------------------------------------------------------------------- */
-/* The output is HDR, not the SDR the input props describe -- retag it so a
- * colour-managed consumer (mpv gpu-next) interprets it correctly and does not
- * see the frame properties "change on the fly".  fp16 = scRGB (linear, Rec.709,
- * full range); x2bgr10le = HDR10 (PQ, Rec.2020).  Both are RGB. */
+/* Retag output as HDR (scRGB or HDR10 PQ/Rec.2020). */
 static void retag_hdr(AVFilterContext *ctx, AVFrame *out)
 {
     TrueHdrCudaContext *s = ctx->priv;
diff --git a/libavfilter/vf_truehdr_drv_cuda.c b/libavfilter/vf_truehdr_drv_cuda.c
index 98a0e76a1f..5837262556 100644
--- a/libavfilter/vf_truehdr_drv_cuda.c
+++ b/libavfilter/vf_truehdr_drv_cuda.c
@@ -72,12 +72,7 @@ FF_RTX_ASSERT_FUNC_LAYOUT(ThdrvFunc);
 FF_RTX_ASSERT_UPLOAD_LAYOUT(ThdrvGenUpload);
 FF_RTX_ASSERT_LAUNCH_LAYOUT(ThdrvGenLaunch);
 
-/* Supported packed frame formats.  Input is read format-agnostically through a
- * texture normalized to [0,1] and there is no B-first path, so it is the shared
- * table's R-first 8-bit rows -- exactly what FF_RTX_N_RGB8_R_FIRST names.
- * Output: scRGB fp16 rgba (linear, drtm arg0x2c=0) or HDR10 x2bgr10le (PQ /
- * SMPTE ST.2084, drtm arg0x2c=1 -> the kernel emits [0,1] PQ values that the
- * SUST.P.2D packs into the 10-bit surface).  See rtx-video-re docs/drtm610/. */
+/* Output: scRGB fp16 rgba or HDR10 x2bgr10le. */
 static const FFRtxPixFmt thdrv_out_fmts[] = {
     { AV_PIX_FMT_RGBAF16LE, CU_AD_FORMAT_HALF,               8, 0 },
     { AV_PIX_FMT_X2BGR10LE, CU_AD_FORMAT_UNORM_INT_101010_2, 4, 0 },
@@ -196,9 +191,6 @@ static const FFRtxArchGate thdrv_gate = {
         "statically matched (sm_75/86/87/89), UNVERIFIED on real hardware.\n",
 };
 
-/* ------------------------------------------------------------------------- *
- * One-time graph setup for W,H.  Must run with the CUDA context current.
- * ------------------------------------------------------------------------- */
 static void fill_sizes(AVFilterContext *ctx, long long *sz)
 {
     TrueHdrDrvCudaContext *s = ctx->priv;
@@ -207,11 +199,7 @@ static void fill_sizes(AVFilterContext *ctx, long long *sz)
     thdrv_fill_allocs(s->W, s->H, NW, NH, sz);
 }
 
-/* One internal graph surface (S1 or S2): a float32 array exposed to its producer
- * kernel as a surface and to its consumer as a texture.  The texture descriptor
- * mirrors the input texture (normalized coords, linear filter) so the producer's
- * pixel-coord SUST and the consumer's normalized TLD line up exactly as they do
- * in loader_ppe. */
+/* Internal surface (S1 or S2): float32 array with both texture and surface. */
 static FFRtxImage *mk_interm(AVFilterContext *ctx, FFRtxCuda *r, int W, int Ha)
 {
     return ff_rtx_image_array(ctx, r, W, Ha, CU_AD_FORMAT_FLOAT,
@@ -238,8 +226,7 @@ static int setup_graph(AVFilterContext *ctx)
                                    (const FFRtxFunc *)thdrv_funcs, THDRV_NFUNC, THDRV_MAX_FID,
                                    NULL)) < 0)
         return ret;
-    /* Zero the arena so any scratch the conv/pov kernels read before writing is
-     * deterministically 0, as in a fresh loader process. */
+    /* Zero the arena: conv/pov kernels read scratch before writing. */
     if ((ret = ff_rtx_alloc_arena(ctx, &s->r, THDRV_NALLOC, fill_sizes,
                                   FF_RTX_ARENA_ZERO)) < 0)
         return ret;
@@ -254,17 +241,12 @@ static int setup_graph(AVFilterContext *ctx)
     if (ret < 0)
         return ret;
 
-    /* Snapshot the pristine arena (weights + zeroed scratch); reset from it each
-     * frame so the graph always reads clean scratch regardless of host memory
-     * reuse. */
+    /* Snapshot pristine arena; reset from it each frame for clean scratch. */
     if ((ret = ff_rtx_snapshot_arena(ctx, &s->r)) < 0)
         return ret;
 
-    /* Input: pitched linear memory, normalized/linear sampling (matches
-     * loader_ppe; the texture unit normalizes the 8-bit UNORM input to [0,1]). */
     s->in_img = ff_rtx_image_pitch(ctx, &s->r, W, H, s->inpf->cufmt, s->inpf->bpp,
                                    FF_RTX_TEX);
-    /* Output array + surface (HDR fp16 rgba = scRGB, or 10-bit PQ). */
     s->out_img = ff_rtx_image_array(ctx, &s->r, W, H, s->outpf->cufmt,
                                     FF_RTX_SURF | FF_RTX_LDST);
     /* Internal surfaces S1 (postprocessing->debanding) and S2 (debanding->drtm). */
@@ -273,11 +255,7 @@ static int setup_graph(AVFilterContext *ctx)
     if (!s->in_img || !s->out_img || !s->s1 || !s->s2)
         return AVERROR_EXTERNAL;
 
-    /* Build the graph.  thdrv_fill_graph() is generated from the same fit as the
-     * tables above and assigns every field through its named thdrv_*_params
-     * struct.  The internal S1/S2 surfaces and textures are passed by fix kind,
-     * which is the index the generated code reads them at.  The casts are only
-     * `unsigned long long *` vs `uint64_t *` on LP64. */
+    /* Build the graph. S1/S2 surfaces and textures are passed by fix kind index. */
     if ((ret = ff_rtx_alloc_launches(ctx, &s->r, THDRV_NLAUNCH, sizeof(ThdrvGenLaunch))) < 0)
         return ret;
     handle[3] = (thdrv_devptr)s->s1->surf;
@@ -297,16 +275,7 @@ static int setup_graph(AVFilterContext *ctx)
     }
     a = ff_rtx_launch_at(&s->r, THDRV_DRTM_LAUNCH)->params;
 
-    /* Resolve the tunables the preset names, before marshalling them below.  The
-     * SDK preset selects the adaptive path and the exposure/middlegray that
-     * emulate the SDK truehdr_cuda curve (middlegray one step lower for PQ
-     * output).  Only tunables left at auto (-1) take a preset value, so an
-     * explicit one passed alongside the preset still wins -- including one that
-     * happens to equal the neutral default, which a compare-against-the-default
-     * test could not tell apart.  The resolved values live in locals: the
-     * AVOption fields stay as the user set them, so a re-run of config_output
-     * resolves from the same starting point and av_opt_get still reports what
-     * was asked for. */
+    /* Resolve preset tunables (auto=-1 takes preset value, explicit wins). */
     sdk        = s->preset == THDRV_PRESET_SDK;
     tonemap    = s->tonemap >= 0 ? s->tonemap : 1;
     exposure   = s->exposure   >= 0 ? s->exposure   : (sdk ? 800.0 : 200.0);
@@ -317,34 +286,20 @@ static int setup_graph(AVFilterContext *ctx)
                "preset=sdk: tonemap=%d exposure=%.0f middlegray=%.0f\n",
                tonemap, exposure, middlegray);
 
-    /* drtm override: peak luminance (float32, computed in double then cast to
-     * bit-match the reference). */
+    /* drtm override: peak luminance. */
     {
         float maxlum = (float)av_clipd(s->maxluminance, 400, 2000);
         memcpy(a + THDRV_OFF_MAXLUMINANCE, &maxlum, 4);
     }
 
-    /* Output format flags (drtm final SUST).  arg0x2c = TRANSFER: 0 = scRGB linear
-     * (rgb*MaxLuminance/80, fp16); 1 = PQ / SMPTE ST.2084 -> normalized [0,1] the
-     * 10-bit x2bgr10le surface packs.  arg0x2b = GAMUT: 1 = Rec.709->Rec.2020 primary
-     * matrix.  x2bgr10le output enables PQ, and (by default) the gamut too == HDR10 /
-     * BT.2100.  arg0x2b is byte 3 of a packed dword, so write a single byte. */
+    /* Output format flags: PQ transfer and Rec.709->Rec.2020 gamut for x2bgr10le. */
     if (s->outpf->f == AV_PIX_FMT_X2BGR10LE) {
         int32_t pq = 1;
         memcpy(a + THDRV_OFF_TRANSFER, &pq, 4);
         a[THDRV_OFF_GAMUT] = s->gamut ? 1 : 0;
     }
 
-    /* Adaptive inverse-tone-map (tonemap>=1, the default).  The captured drtm template
-     * runs ToneMapMode 0 -- a near-linear bypass that reads only MaxLuminance, so
-     * tonemap=0 is byte-exact vs the loader but blows out midtones.  Mode 1 enables the
-     * driver's adaptive curve, which additionally consumes the live calculate_pov
-     * scene stat (drtm arg0x48 = the per-frame bright-pixel fraction; the graph
-     * already produces it and the arena reset zero-inits its atomic accumulator each
-     * frame -- see filter_frame / loader_ppe) and is gated by the tone floats.  Those
-     * MUST be non-zero or the curve divides by zero (NaN), so write the tunable set
-     * with neutral shadow-lift.  Offsets are the drtm610-named arg offsets.  Mode 0
-     * is left entirely untouched. */
+    /* Adaptive inverse-tone-map (mode 1). Shadow lift must be non-zero to avoid NaN. */
     if (tonemap >= 1) {
         float f_contrast   = (float)av_clipd(s->contrast,   0.1, 4.0);
         float f_shadowlift = 1.0f;               /* neutral; curve needs it non-zero */
@@ -358,10 +313,7 @@ static int setup_graph(AVFilterContext *ctx)
         memcpy(a + THDRV_OFF_MIDDLEGRAY,  &f_middlegray, 4);
         memcpy(a + THDRV_OFF_EXPOSURE,    &f_exposure,   4);
         memcpy(a + THDRV_OFF_TONEMAPMODE, &mode,         4);
-        /* Per-channel gamma is a separate opt-in: it needs its enable byte
-         * (arg0x40) set as well as the exponent (arg0x10).  Only touch them when
-         * the user asked for a non-identity gamma, so gamma=1.0 leaves the
-         * (byte-exact) mode-1 arg buffer untouched. */
+        /* Per-channel gamma is opt-in: only enable when non-identity. */
         if (s->gamma != 1.0) {
             float g = (float)av_clipd(s->gamma, 0.25, 4.0);
             memcpy(a + THDRV_OFF_GAMMA, &g, 4);
@@ -380,13 +332,7 @@ static int setup_graph(AVFilterContext *ctx)
     return 0;
 }
 
-/* ------------------------------------------------------------------------- *
- * Per-frame: bind the input frame as a texture, replay the graph, copy out.
- * ------------------------------------------------------------------------- */
-/* The output is HDR, not the SDR the input props describe -- retag so a
- * colour-managed consumer interprets it.  rgbaf16le = scRGB (linear light,
- * Rec.709, full range); x2bgr10le = HDR10 (PQ / SMPTE ST.2084, Rec.2020 primaries
- * when the gamut matrix is on -- the standard -- else Rec.709). */
+/* Retag output as HDR (scRGB or HDR10 PQ/Rec.2020). */
 static void retag_hdr(AVFilterContext *ctx, AVFrame *out)
 {
     TrueHdrDrvCudaContext *s = ctx->priv;

-- 