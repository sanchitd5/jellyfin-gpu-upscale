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

#ifndef AVFILTER_RTX_CUDA_H
#define AVFILTER_RTX_CUDA_H

/**
 * @file
 * Shared CUDA graph-replay core for filters that drive externally-compiled
 * CUDA kernels (cubins/fatbins) plus a weights blob directly through the CUDA
 * driver API, instead of going through a vendor SDK (NGX, OptiX, Maxine VFX).
 *
 * STATUS: scaffolding only, no filter uses this yet and it has not been
 * compiled or run. Written from a pattern document handed to this project,
 * not derived from a working implementation in this repo. It exists to
 * capture the intended contract in code so a real consumer filter can be
 * built and tested against it - do not assume any function here behaves
 * correctly until a filter exercises it end to end. This project's own rule
 * (AGENTS.md/CLAUDE.md: read the actual SDK, never guess an API shape)
 * applies here too: nothing in this header should be treated as verified
 * until real cubins, a real weights.bin, and a real generated per-feature
 * header exist to compile and run it against.
 *
 * Two things this project does NOT yet have, and this header alone does not
 * provide:
 *   - Any actual cubin/fatbin for a real effect (extraction of NVIDIA's RTX
 *     Video Super Resolution kernels was explored and did not turn up a
 *     usable artifact on Linux; see VSR.md).
 *   - Any actual weights.bin for such an effect.
 * Without those, this header has no consumer and cannot be tested. Treat it
 * as a filed contract, not working infrastructure, until both exist.
 *
 * Follows this project's existing CUDA convention (see vf_optix.c): the CUDA
 * driver API is reached through nv-codec-headers' CudaFunctions dynlink
 * table, never linked directly against libcuda.so, and no nvcc/CUDA toolkit
 * is required to build - only a CUcontext and pre-compiled cubins supplied at
 * runtime via a `data` directory option, the same shape vf_ort.c's ONNX
 * Runtime model path and vf_vsr.c's `models=` option already use for
 * runtime-supplied binary assets this repository does not vendor.
 */

#include <stdint.h>

#include <ffnvcodec/dynlink_loader.h>

#include "avfilter.h"

/* ------------------------------------------------------------------------
 * Kernel/module metadata - generator-facing shapes.
 *
 * A per-feature generated header (`<feature>_cuda_gen.h`, not written yet -
 * produced from whatever tool turns extracted cubins/weights into config
 * tables) is expected to define its own typedefs matching these layouts
 * field-for-field (checked at compile time via FF_RTX_ASSERT_*_LAYOUT below)
 * rather than including this header's structs directly, so the generator can
 * emit plain C without depending on FFmpeg's build.
 * ------------------------------------------------------------------------ */

/** One cubin/fatbin file, loaded via cuModuleLoadData. */
typedef struct FFRtxModule {
    int mid;             /**< module id, indexes FFRtxCuda.modules[] */
    const char *file;    /**< filename under the `data` directory */
} FFRtxModule;

/** One kernel entry point inside a loaded module. */
typedef struct FFRtxFunc {
    int fid;              /**< function id, indexes FFRtxCuda.funcs[] */
    int mid;              /**< which module this kernel lives in */
    const char *name;     /**< __global__ symbol name for cuModuleGetFunction */
} FFRtxFunc;

/** One HtoD upload of a weights.bin slice into the arena at build time. */
typedef struct FFRtxUpload {
    long long file_off;   /**< byte offset into weights.bin */
    long long size;       /**< byte length to copy */
    uint64_t dst;          /**< destination CUdeviceptr, cast to uint64_t */
} FFRtxUpload;

/** One kernel launch, pre-built by the generator; replayed as-is per frame
 *  except for any tunable byte ranges patched into params[] at setup time. */
typedef struct FFRtxLaunch {
    int fnid;              /**< which FFRtxFunc to launch */
    int argsize;            /**< byte length of params[] as the driver expects */
    int psize;              /**< EIATTR_CBANK_PARAM_SIZE; see FF_RTX_OP_PSIZE */
    unsigned grid[3];
    unsigned block[3];
    unsigned smem;
    uint8_t params[];       /**< flexible array: raw cuLaunchKernel argument bytes */
} FFRtxLaunch;

/** Compile-time layout assertions a per-feature generated header should use
 *  against its own typedefs, so a generator/header drift is a build error
 *  instead of a silent memory-layout mismatch at cuLaunchKernel time. */
#define FF_RTX_ASSERT_MODULE_LAYOUT(T) \
    static_assert(sizeof(T) == sizeof(FFRtxModule), #T " must match FFRtxModule layout")
#define FF_RTX_ASSERT_FUNC_LAYOUT(T) \
    static_assert(sizeof(T) == sizeof(FFRtxFunc), #T " must match FFRtxFunc layout")
#define FF_RTX_ASSERT_UPLOAD_LAYOUT(T) \
    static_assert(sizeof(T) == sizeof(FFRtxUpload), #T " must match FFRtxUpload layout")
#define FF_RTX_ASSERT_LAUNCH_LAYOUT(T) \
    static_assert(offsetof(T, fnid) == offsetof(FFRtxLaunch, fnid) && \
                  offsetof(T, params) == offsetof(FFRtxLaunch, params), \
                  #T " must match FFRtxLaunch's fixed header layout")
#define FF_RTX_ASSERT_PRIV_LAYOUT(T) \
    static_assert(offsetof(T, r) < sizeof(T), #T " must embed an FFRtxCuda member named r")

/* ------------------------------------------------------------------------
 * Image binding
 * ------------------------------------------------------------------------ */

enum FFRtxImageFlags {
    FF_RTX_TEX   = 1 << 0,  /**< bind a texture object for kernel reads */
    FF_RTX_SURF  = 1 << 1,  /**< bind a surface object for kernel read/write */
    FF_RTX_LDST  = 1 << 2,  /**< surface allows both load and store */
    FF_RTX_CLAMP = 1 << 3,  /**< clamp-to-edge addressing instead of the driver default */
    FF_RTX_ZERO  = 1 << 4,  /**< zero-fill on allocation */
};

enum FFRtxImageKind {
    FF_RTX_IMAGE_ARRAY,   /**< CUDA array backing, for ff_rtx_image_array() */
    FF_RTX_IMAGE_PITCH,   /**< pitched linear backing, for ff_rtx_image_pitch() */
    FF_RTX_IMAGE_LINEAR,  /**< plain linear buffer, for ff_rtx_image_linear() */
};

typedef struct FFRtxImage {
    enum FFRtxImageKind kind;
    int w, h, bpp;
    unsigned flags;
    CUarray array;             /**< FF_RTX_IMAGE_ARRAY only */
    CUdeviceptr ptr;           /**< FF_RTX_IMAGE_PITCH / FF_RTX_IMAGE_LINEAR */
    size_t pitch;              /**< FF_RTX_IMAGE_PITCH only */
    CUtexObject tex;           /**< valid when FF_RTX_TEX was requested */
    CUsurfObject surf;         /**< valid when FF_RTX_SURF was requested */
} FFRtxImage;

/* ------------------------------------------------------------------------
 * Architecture gating
 * ------------------------------------------------------------------------ */

typedef struct FFRtxArchGate {
    int hard_min_major;         /**< reject below this SM major version; 0 = no hard floor */
    const char *hard_msg;       /**< AV_LOG_ERROR format, one %d.%d cc argument pair */
    const char *gate_msg;       /**< AV_LOG_WARNING: running an unvalidated-but-compatible arch */
    const char *warn_msg;       /**< AV_LOG_WARNING: running a lower-arch image via experimental_arch */
} FFRtxArchGate;

/* ------------------------------------------------------------------------
 * The shared core itself - embedded by value as `r` in a filter's private
 * context (see FF_RTX_ASSERT_PRIV_LAYOUT).
 * ------------------------------------------------------------------------ */

typedef struct FFRtxCuda {
    CudaFunctions *cu;
    CUdevice  cu_device;
    CUcontext cu_ctx;
    CUstream  stream;
    int owns_ctx;               /**< set by ff_rtx_bind_device() when it retained the context itself */

    /* Arena: one contiguous cuMemAlloc, sub-allocated at 512B boundaries so
     * kernel tile/halo reads that run slightly past a logical buffer's end
     * stay inside mapped memory instead of crossing into an unrelated
     * allocation once the heap fragments. */
    CUdeviceptr arena;
    long long arena_size;
    CUdeviceptr *alloc;          /**< per-buffer base pointers within arena, nalloc entries */
    int nalloc;
    long long arena_uploaded;    /**< high-water mark written by ff_rtx_upload_weights() */
    CUdeviceptr arena_template;  /**< snapshot target for ff_rtx_reset_arena(), if used */

    CUmodule *modules;
    int nmodules;
    CUfunction *funcs;
    int nfuncs;

    FFRtxLaunch **launches;      /**< nlaunch pointers into a single generator-sized allocation */
    int nlaunch;

    int arch_major, arch_minor;  /**< populated by ff_rtx_arch_gate() */
} FFRtxCuda;

typedef struct FFRtxFrameOp {
    const FFRtxImage *in_img, *out_img;
    int iW, iH, ibpp;
    int oW, oH, obpp;
    unsigned flags;
    /** NULL to replay the whole launch list via ff_rtx_launch_all(); set for
     *  a custom per-tile/ISR loop (see the pattern doc's ISR example). */
    int (*run)(AVFilterContext *ctx);
} FFRtxFrameOp;

enum FFRtxFrameOpFlags {
    FF_RTX_OP_PSIZE        = 1 << 0, /**< launch with EIATTR_CBANK_PARAM_SIZE, not argsize -
                                       *   the driver over-reports argsize by 8 bytes for
                                       *   tex/surf-bound kernels on some DLPP-style drivers,
                                       *   which otherwise faults as
                                       *   CUDA_ERROR_LAUNCH_OUT_OF_RESOURCES */
    FF_RTX_OP_RESET_ARENA  = 1 << 1, /**< restore arena from arena_template before this frame,
                                       *   for graphs whose kernels read scratch before writing it */
    FF_RTX_OP_OPAQUE_ALPHA = 1 << 2, /**< force alpha to fully opaque on the way out */
};

enum FFRtxArenaFlags {
    FF_RTX_ARENA_ZERO = 1 << 0,  /**< zero the whole arena after allocation */
};

/* ------------------------------------------------------------------------
 * Setup-time API (called from config_output, CUDA context current)
 * ------------------------------------------------------------------------ */

typedef struct FFRtxFormats {
    const enum AVPixelFormat *in_tbl;
    int n_in;
    const enum AVPixelFormat *out_tbl;
    int n_out;
    const char *out_format;      /**< AVOption string, NULL = pick in_tbl's default */
    const char *hint;            /**< appended to the error log line on a bad format request */
} FFRtxFormats;

/** Validate the input link's format and any requested output format against
 *  the tables in @p fmts. On success returns the negotiated pixel formats and
 *  the input's AVHWFramesContext (if any) for later use by
 *  ff_rtx_config_hwframes() / ff_rtx_bind_device(). */
int ff_rtx_config_formats(AVFilterContext *ctx, AVFilterLink *inlink,
                           const FFRtxFormats *fmts, AVHWFramesContext **in_frames_ctx,
                           const void **inpf, const void **outpf);

/** Evaluate width/height AVOption expressions (`iw`, `ih`, `in_w`, `in_h`
 *  variables) against the input link, defaulting to @p defscale times the
 *  input size when either expression is unset. */
int ff_rtx_eval_dims(AVFilterContext *ctx, AVFilterLink *inlink,
                      const char *w_expr, const char *h_expr, int defscale,
                      int *out_w, int *out_h);

/** Resolve (and if necessary create) the CUDA device/context/stream this
 *  filter instance will use, from either an upstream hw_frames_ctx or a
 *  device_index AVOption, matching vf_optix.c's own device-selection order. */
int ff_rtx_bind_device(AVFilterContext *ctx, FFRtxCuda *r, AVHWFramesContext *in_frames_ctx);

/** Set up the output link's AVHWFramesContext for AV_PIX_FMT_CUDA passthrough. */
int ff_rtx_config_hwframes(AVFilterContext *ctx, AVFilterLink *outlink, FFRtxCuda *r,
                            int w, int h, enum AVPixelFormat sw_format);

/** Push @p r->cu_ctx current, call @p setup_graph(ctx), pop it - the one
 *  place setup_graph() (module load, arena alloc, weight upload, image bind,
 *  graph build) is allowed to assume the context is current. */
int ff_rtx_setup(AVFilterContext *ctx, FFRtxCuda *r, const char *name,
                  int (*setup_graph)(AVFilterContext *ctx));

/** Reject or warn based on the bound device's compute capability against
 *  @p gate. Populates r->arch_major/arch_minor as a side effect. */
int ff_rtx_arch_gate(AVFilterContext *ctx, FFRtxCuda *r, const FFRtxArchGate *gate,
                      int experimental_arch);

/** Load every module in @p modules from @p data_dir via cuModuleLoadData
 *  (multi-arch fatbin; the driver picks the running GPU's slice), then
 *  resolve every function in @p funcs via cuModuleGetFunction. @p load_hint,
 *  if non-NULL, is appended to the error log line when a data dir has no
 *  image for the running compute capability. */
int ff_rtx_load_modules(AVFilterContext *ctx, FFRtxCuda *r, const char *data_dir,
                         const FFRtxModule *modules, int nmod, int max_mid,
                         const FFRtxFunc *funcs, int nfunc, int max_fid,
                         const char *load_hint);

/** Allocate one contiguous device buffer sized by @p fill_sizes(ctx, sz) into
 *  @p nalloc sub-allocations, 512B-aligned, stored in r->alloc[]. */
int ff_rtx_alloc_arena(AVFilterContext *ctx, FFRtxCuda *r, int nalloc,
                        void (*fill_sizes)(AVFilterContext *ctx, long long *sz),
                        unsigned flags);

/** Snapshot the arena's currently-uploaded prefix (r->arena_uploaded bytes)
 *  into r->arena_template, for graphs that need ff_rtx_reset_arena() before
 *  every frame. Call once, after ff_rtx_upload_weights(), before the first
 *  frame is processed. */
int ff_rtx_snapshot_arena(AVFilterContext *ctx, FFRtxCuda *r);

/** Restore the arena's uploaded prefix from r->arena_template and zero the
 *  rest. Called per frame via FF_RTX_OP_RESET_ARENA, not directly. */
int ff_rtx_reset_arena(AVFilterContext *ctx, FFRtxCuda *r);

/** HtoD-copy every entry in @p uploads from @p data_dir/@p weights_file into
 *  the arena asynchronously, then synchronize once before returning. Updates
 *  r->arena_uploaded to the highest (dst offset + size) seen. */
int ff_rtx_upload_weights(AVFilterContext *ctx, FFRtxCuda *r, const char *data_dir,
                           const char *weights_file, const FFRtxUpload *uploads, int nup);

FFRtxImage *ff_rtx_image_array(AVFilterContext *ctx, FFRtxCuda *r,
                                int w, int h, int cufmt, unsigned flags);
FFRtxImage *ff_rtx_image_pitch(AVFilterContext *ctx, FFRtxCuda *r,
                                int w, int h, int cufmt, int bpp, unsigned flags);
FFRtxImage *ff_rtx_image_linear(AVFilterContext *ctx, FFRtxCuda *r, size_t size, size_t pitch);

/** Allocate r->launches (nlaunch pointers into one block sized
 *  nlaunch * launch_stride, launch_stride being the per-feature generated
 *  FFRtxLaunch-compatible struct's sizeof, since params[] is variable-length
 *  per kernel). The generator's own fill_graph() call writes into this
 *  block afterwards. */
int ff_rtx_alloc_launches(AVFilterContext *ctx, FFRtxCuda *r, int nlaunch, size_t launch_stride);

/** Index of the launch calling function @p name, or -1. Used to locate a
 *  specific launch for tunable patching or DLPP format-selector patching. */
int ff_rtx_find_launch(FFRtxCuda *r, const FFRtxFunc *funcs, int nfunc, const char *name);

FFRtxLaunch *ff_rtx_launch_at(FFRtxCuda *r, int index);

/* ------------------------------------------------------------------------
 * Per-frame API
 * ------------------------------------------------------------------------ */

/** cuLaunchKernel a single pre-built launch. */
int ff_rtx_launch(AVFilterContext *ctx, FFRtxCuda *r, int fnid,
                   const unsigned grid[3], const unsigned block[3], unsigned smem,
                   const uint8_t *params, int argsize);

/** Replay every launch in r->launches, in order, unchanged. The default
 *  FFRtxFrameOp.run. */
int ff_rtx_launch_all(AVFilterContext *ctx, FFRtxCuda *r);

/** Copy @p in's pitched host/hw frame data into @p img (array or pitched,
 *  per its kind), asynchronously on r->stream. */
int ff_rtx_frame_to_image(AVFilterContext *ctx, FFRtxCuda *r, AVFrame *in, const FFRtxImage *img);

/** Copy @p img back out into a newly allocated AVFrame matching @p out's
 *  format/size, asynchronously on r->stream, synchronizing before return. */
int ff_rtx_image_to_frame(AVFilterContext *ctx, FFRtxCuda *r, const FFRtxImage *img, AVFrame *out);

/** The whole per-frame sequence: frame_to_image, run (or launch_all),
 *  image_to_frame. @p retag_fn, if non-NULL, is called on the output frame
 *  before it is returned (e.g. to fix up color metadata). */
int ff_rtx_filter_frame(AVFilterLink *inlink, AVFrame *in, FFRtxCuda *r,
                         const FFRtxFrameOp *op, int (*retag_fn)(AVFilterContext *ctx, AVFrame *out));

/* ------------------------------------------------------------------------
 * Teardown
 * ------------------------------------------------------------------------ */

/** Free modules, arena, images and launches. Safe to call on a
 *  partially-set-up FFRtxCuda (e.g. from a failed setup_graph, or before
 *  reconfiguring on a format change) and safe to call twice. */
void ff_rtx_free_graph(AVFilterContext *ctx, FFRtxCuda *r);

/** ff_rtx_free_graph() plus releasing the CUDA context if ff_rtx_bind_device()
 *  retained it (r->owns_ctx). The filter's own uninit() should do nothing
 *  else CUDA-related once this returns. */
void ff_rtx_uninit(AVFilterContext *ctx);

#endif /* AVFILTER_RTX_CUDA_H */
