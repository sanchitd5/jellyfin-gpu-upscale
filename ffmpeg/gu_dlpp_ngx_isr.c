/*
 * gu_dlpp_ngx_isr.c: promoted from the `rtx-video-re` spike (`loader/ngx_isr.c`), renamed on
 * the way in, no behaviour changed. Unused by vf_dlpp_rtcuda.c (DLPP's own path never calls
 * into this file's ngx_isr feature) but pe_map.c #includes it unconditionally, so it has to
 * build clean alongside the rest. Our own reverse-engineered shim code, no NVIDIA material.
 * See RTXDLPP.md.
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

/*
 * ngx_isr: drive nvngx_dlisr.dll's CUDA feature path under the loader.
 *
 * Included by pe_map.c, not built on its own -- it needs the mapped Image and
 * the ms_abi plumbing from there.
 *
 * Every constant, signature and vtable slot below was read out of the NGX SDK
 * headers installed on the capture box (/root/gameupscale/dlss/include), never
 * guessed. The parameter object in particular is a C++ class reached through a
 * vtable: get the slot order wrong and the DLL calls Set(float) believing it is
 * Set(void*), which does not fail cleanly.
 *
 *   nvsdk_ngx_defs.h      NVSDK_NGX_Result_Success = 0x1
 *                         NVSDK_NGX_Feature_ImageSuperResolution = 3
 *                         NVSDK_NGX_VERSION_API_MACRO = 0x15
 *                         parameter name strings
 *   nvsdk_ngx_params.h    the 17-slot NVSDK_NGX_Parameter vtable, Set(ull) first
 *   nvsdk_ngx_standalone_cuda.h   the CUDA entry point signatures
 */

#define NGX_SUCCESS            0x1
#define NGX_FEATURE_ISR        3
#define NGX_VERSION_API        0x0000015
#define NGX_FMT_RGBA8UI        4

/* ------------------------------------------------------------------ *
 * NVSDK_NGX_Parameter, implemented by us.
 *
 * We loaded the snippet directly, so we stand in for nvngx.dll and have to
 * supply the parameter object the snippet reads its configuration out of.
 * Layout is MSVC's: one vtable pointer, then our own fields. The class declares
 * no virtual destructor, so slot 0 really is Set(const char*, unsigned long long).
 * ------------------------------------------------------------------ */

#define NGX_MAXPARAM 128

typedef struct {
    char     name[80];
    int      kind;           /* 0 ull, 1 float, 2 double, 3 uint, 4 int, 5 ptr */
    uint64_t u;
    double   d;
    float    f;
    void    *p;
} NgxKV;

typedef struct {
    void  **vtable;
    NgxKV   kv[NGX_MAXPARAM];
    int     n;
} NgxParams;

static NgxParams g_params;

static NgxKV *kv_find(NgxParams *s, const char *name, int create)
{
    for (int i = 0; i < s->n; i++)
        if (!strcmp(s->kv[i].name, name))
            return &s->kv[i];
    if (!create || s->n >= NGX_MAXPARAM)
        return NULL;
    NgxKV *e = &s->kv[s->n++];
    snprintf(e->name, sizeof(e->name), "%s", name);
    return e;
}

static int g_trace_params = 1;

#define SETTER(sfx, ctype, field, kindno, fmt)                                  \
static WINAPI void ngx_set_##sfx(NgxParams *s, const char *n, ctype v)          \
{                                                                               \
    NgxKV *e = kv_find(s, n, 1);                                                \
    if (e) { e->kind = kindno; e->field = v; }                                   \
    if (g_trace_params) fprintf(stderr, "    [param] set %-34s " fmt "\n", n, v);\
}

SETTER(ull,  unsigned long long, u, 0, "%llu")
SETTER(flt,  float,              f, 1, "%f")
SETTER(dbl,  double,             d, 2, "%f")
SETTER(uint, unsigned int,       u, 3, "%u")
SETTER(int,  int,                u, 4, "%d")
SETTER(ptr,  void *,             p, 5, "%p")

#define GETTER(sfx, ctype, field, fmt)                                          \
static WINAPI uint32_t ngx_get_##sfx(NgxParams *s, const char *n, ctype *out)   \
{                                                                               \
    NgxKV *e = kv_find(s, n, 0);                                                \
    if (!e || !out) {                                                           \
        if (g_trace_params) fprintf(stderr, "    [param] get %-34s MISS\n", n);  \
        return 0xBAD00000 | 5;   /* FAIL_InvalidParameter */                     \
    }                                                                           \
    *out = (ctype)e->field;                                                     \
    if (g_trace_params) fprintf(stderr, "    [param] get %-34s " fmt "\n", n, *out);\
    return NGX_SUCCESS;                                                         \
}

GETTER(ull,  unsigned long long, u, "%llu")
GETTER(flt,  float,              f, "%f")
GETTER(dbl,  double,             d, "%f")
GETTER(uint, unsigned int,       u, "%u")
GETTER(int,  int,                u, "%d")
GETTER(ptr,  void *,             p, "%p")

static WINAPI void ngx_reset(NgxParams *s) { s->n = 0; }

/* NVSDK_NGX_AppLogCallback, from nvsdk_ngx_defs.h:376. Called by the snippet,
 * so it is Win64 ABI like everything else it calls into. */
static WINAPI void ngx_log_cb(const char *msg, int level, int component)
{
    if (!msg) return;
    size_t n = strlen(msg);
    while (n && (msg[n - 1] == '\n' || msg[n - 1] == '\r')) n--;
    fprintf(stderr, "    [ngx L%d c%d] %.*s\n", level, component, (int)n, msg);
}

/* Slot order is the header's declaration order, exactly. */
static void *g_param_vtable[17];

static void ngx_params_init(NgxParams *s)
{
    memset(s, 0, sizeof(*s));
    g_param_vtable[0]  = (void *)ngx_set_ull;
    g_param_vtable[1]  = (void *)ngx_set_flt;
    g_param_vtable[2]  = (void *)ngx_set_dbl;
    g_param_vtable[3]  = (void *)ngx_set_uint;
    g_param_vtable[4]  = (void *)ngx_set_int;
    g_param_vtable[5]  = (void *)ngx_set_ptr;   /* ID3D11Resource*, unused here */
    g_param_vtable[6]  = (void *)ngx_set_ptr;   /* ID3D12Resource*, unused here */
    g_param_vtable[7]  = (void *)ngx_set_ptr;
    g_param_vtable[8]  = (void *)ngx_get_ull;
    g_param_vtable[9]  = (void *)ngx_get_flt;
    g_param_vtable[10] = (void *)ngx_get_dbl;
    g_param_vtable[11] = (void *)ngx_get_uint;
    g_param_vtable[12] = (void *)ngx_get_int;
    g_param_vtable[13] = (void *)ngx_get_ptr;
    g_param_vtable[14] = (void *)ngx_get_ptr;
    g_param_vtable[15] = (void *)ngx_get_ptr;
    g_param_vtable[16] = (void *)ngx_reset;
    s->vtable = g_param_vtable;
}

/* Convenience wrappers so the driver below reads like the SDK's own examples. */
static void P_setu(const char *n, unsigned int v) { ngx_set_uint(&g_params, n, v); }
static void P_setp(const char *n, void *v)        { ngx_set_ptr(&g_params, n, v); }

/* ------------------------------------------------------------------ *
 * CUDA, reached directly -- this is our own SysV code, not the DLL's.
 * ------------------------------------------------------------------ */

typedef int CUresult_;
typedef unsigned long long CUdeviceptr_;

static CUresult_ (*p_cuInit)(unsigned);
static CUresult_ (*p_cuDeviceGet)(int *, int);
static CUresult_ (*p_cuCtxCreate)(void **, unsigned, int);
static CUresult_ (*p_cuMemAlloc)(CUdeviceptr_ *, size_t);
static CUresult_ (*p_cuMemsetD8)(CUdeviceptr_, unsigned char, size_t);
static CUresult_ (*p_cuCtxSynchronize)(void);
static int g_cuda_external;

static int cuda_bring_up(void)
{
    p_cuInit           = cuda_sym("cuInit");
    p_cuDeviceGet      = cuda_sym("cuDeviceGet");
    p_cuCtxCreate      = cuda_sym("cuCtxCreate_v2");
    p_cuMemAlloc       = cuda_sym("cuMemAlloc_v2");
    p_cuMemsetD8       = cuda_sym("cuMemsetD8_v2");
    p_cuCtxSynchronize = cuda_sym("cuCtxSynchronize");
    if (!p_cuInit || !p_cuCtxCreate || !p_cuMemAlloc) {
        fprintf(stderr, "  libcuda missing entry points\n");
        return -1;
    }
    /* An embedding host (vf_aivp_spike) owns the context and has made it current. */
    if (g_cuda_external) return 0;
    int dev; void *ctx;
    if (p_cuInit(0) || p_cuDeviceGet(&dev, 0)) {
        fprintf(stderr, "  CUDA init failed\n");
        return -1;
    }
    /* AIVP_PRIMARY=1: the device's primary context, which is what ffmpeg's
     * AVCUDADeviceContext retains, instead of a private one. */
    if (getenv("AIVP_PRIMARY")) {
        CUresult_ (*retain)(void **, int) = cuda_sym("cuDevicePrimaryCtxRetain");
        CUresult_ (*setcur)(void *) = cuda_sym("cuCtxSetCurrent");
        if (!retain || !setcur || retain(&ctx, dev) || setcur(ctx)) {
            fprintf(stderr, "  CUDA primary ctx retain failed\n");
            return -1;
        }
        printf("  CUDA primary context retained %p\n", ctx);
        return 0;
    }
    if (p_cuCtxCreate(&ctx, 0, dev)) {
        fprintf(stderr, "  CUDA init failed\n");
        return -1;
    }
    printf("  CUDA context created\n");
    return 0;
}

/* ------------------------------------------------------------------ */

static int run_ngx_isr(Image *im, int W, int H, int scale)
{
    /* Windows wchar_t is 16-bit; Linux's is 32. A native L"" literal here would
     * hand the DLL a string it reads as garbage. */
    static uint16_t datapath[] = { '.', 0 };

    /* Real export takes 4 args -- (appid, path, InFeatureInfo, version) -- per
     * nvsdk_ngx_standalone_cuda.h. Calling with 3 shifted every arg after the
     * missing InFeatureInfo slot and fed the version value where a pointer was
     * expected; NULL here is valid, the SDK only dereferences it for an extra
     * search-path list we don't have. */
    WINAPI uint32_t (*ngx_init)(unsigned long long, const uint16_t *, const void *, uint32_t) =
        find_export(im, "NVSDK_NGX_CUDA_Init");
    WINAPI uint32_t (*ngx_scratch)(uint32_t, const void *, size_t *) =
        find_export(im, "NVSDK_NGX_CUDA_GetScratchBufferSize");
    WINAPI uint32_t (*ngx_create)(uint32_t, const void *, void **) =
        find_export(im, "NVSDK_NGX_CUDA_CreateFeature");
    WINAPI uint32_t (*ngx_eval)(const void *, const void *, void *) =
        find_export(im, "NVSDK_NGX_CUDA_EvaluateFeature");

    if (!ngx_init || !ngx_scratch || !ngx_create || !ngx_eval) {
        fprintf(stderr, "  missing NGX CUDA exports\n");
        return -1;
    }

    /* Ask the snippet to explain itself before driving it. A bare
     * FAIL_PlatformError says only that something about the environment was
     * unacceptable; the log callback says which thing, and NVIDIA already built
     * that channel for us. Signature from nvsdk_ngx_defs.h. */
    WINAPI void (*set_log)(void *) = find_export(im, "NVSDK_NGX_SetInfoCallback");
    if (set_log) {
        set_log((void *)ngx_log_cb);
        printf("  NGX log callback installed\n");
    }
    if (cuda_bring_up())
        return -1;

    ngx_params_init(&g_params);

    printf("  NVSDK_NGX_CUDA_Init(appid=0x1337, version=0x%x)...\n", NGX_VERSION_API);
    fflush(stdout);
    uint32_t r = ngx_init(0x1337ULL, datapath, NULL, NGX_VERSION_API);
    printf("  -> 0x%x %s\n", r, r == NGX_SUCCESS ? "(Success)" : "(FAIL)");
    if (r != NGX_SUCCESS)
        return -1;

    int oW = W * scale, oH = H * scale;
    P_setu("Width", W);
    P_setu("Height", H);
    P_setu("OutWidth", oW);
    P_setu("OutHeight", oH);
    P_setu("Scale", scale);
    P_setu("CreationNodeMask", 1);
    P_setu("VisibilityNodeMask", 1);
    P_setu("Color.Format", NGX_FMT_RGBA8UI);
    P_setu("Output.Format", NGX_FMT_RGBA8UI);
    P_setu("Color.SizeInBytes", (unsigned)(W * H * 4));
    P_setu("Output.SizeInBytes", (unsigned)(oW * oH * 4));

    size_t scratch_bytes = 0;
    printf("  NVSDK_NGX_CUDA_GetScratchBufferSize(ISR)...\n");
    fflush(stdout);
    r = ngx_scratch(NGX_FEATURE_ISR, &g_params, &scratch_bytes);
    printf("  -> 0x%x, scratch = %zu bytes\n", r, scratch_bytes);

    CUdeviceptr_ scratch = 0, in = 0, out = 0;
    if (scratch_bytes) {
        if (p_cuMemAlloc(&scratch, scratch_bytes)) { fprintf(stderr, "  scratch alloc failed\n"); return -1; }
        if (p_cuMemsetD8) p_cuMemsetD8(scratch, 0, scratch_bytes);
        P_setp("Scratch", (void *)scratch);
        P_setu("Scratch.SizeInBytes", (unsigned)scratch_bytes);
    }

    if (p_cuMemAlloc(&in, (size_t)W * H * 4) || p_cuMemAlloc(&out, (size_t)oW * oH * 4)) {
        fprintf(stderr, "  image alloc failed\n");
        return -1;
    }
    if (p_cuMemsetD8) { p_cuMemsetD8(in, 0x80, (size_t)W * H * 4); p_cuMemsetD8(out, 0, (size_t)oW * oH * 4); }
    P_setp("Color", (void *)in);
    P_setp("Output", (void *)out);

    void *handle = NULL;
    printf("  NVSDK_NGX_CUDA_CreateFeature(ISR)...\n");
    fflush(stdout);
    r = ngx_create(NGX_FEATURE_ISR, &g_params, &handle);
    printf("  -> 0x%x %s handle=%p\n", r, r == NGX_SUCCESS ? "(Success)" : "(FAIL)", handle);
    if (r != NGX_SUCCESS)
        return -1;

    printf("  NVSDK_NGX_CUDA_EvaluateFeature(%dx%d -> %dx%d)...\n", W, H, oW, oH);
    fflush(stdout);
    g_trace_params = 0;   /* evaluate re-reads everything; the log is noise by now */
    r = ngx_eval(handle, &g_params, NULL);
    printf("  -> 0x%x %s\n", r, r == NGX_SUCCESS ? "(Success)" : "(FAIL)");
    if (p_cuCtxSynchronize)
        p_cuCtxSynchronize();
    return r == NGX_SUCCESS ? 0 : -1;
}
