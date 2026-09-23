/*
 * gu_dlpp_embed.c: promoted from the `rtx-video-re` spike (`ffmpeg-spike/dlpp_embed.c`),
 * renamed on the way in. See gu_dlpp_embed.h. Built as its own translation unit with the
 * loader's flags, so the loader never meets FFmpeg's headers or its poisoned-malloc macros.
 * Mirrors the AIVP-era embed but targets nvdlppx.dll (DLPP) via run_dlpp() and its own
 * 0x50-byte param struct, with the two confirmed fixes baked in as unconditional defaults
 * (see gu_dlpp_embed.h and TASK.md "Track B: DLPP").
 *
 * Added on promotion, not present in the spike: gu_dlpp_embed_selftest(), an init-time
 * self-check (map + CreateInstance already happen in do_init(); this adds one real Process
 * call and a version/hash of the mapped DLL) so vf_dlpp_rtcuda.c can fail cleanly at
 * config_output rather than crash on the first real frame or a driver update that moved
 * internal offsets -- the same fail-at-init discipline as this project's own FFRtxArchGate
 * (ffmpeg-patches/0002).
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
#define PE_MAP_NO_MAIN
#include "gu_dlpp_pe_map.c"

#include <pthread.h>
#include "gu_dlpp_embed.h"

enum { OP_NONE, OP_INIT, OP_PROCESS, OP_SELFTEST, OP_DUMP, OP_QUIT };

static struct {
    pthread_t t;
    pthread_mutex_t m;
    pthread_cond_t c;
    int op, rc, started;
    const char *dll, *path;
    void *ctx, *stream;
    const void *inject;
    unsigned w, h, ow, oh, level;
    float scale;
    Image im;
    void *in_arr, *out_arr;
    uint64_t in_surf, out_surf;
    uint32_t dll_hash;         /* FNV-1a over the raw DLL file, logged at init so a support
                                 * report can show which nvdlppx.dll build this ran against --
                                 * not an allow/deny gate: an unrecognised hash still runs (this
                                 * spike has no reference set to compare against yet), but every
                                 * init logs it and gu_dlpp_embed_selftest() returns it. */
    uint8_t params[0x50];      /* DLPP's Process struct size, confirmed by agent 14's
                                 * AIVP_PSIZE black-box sweep -- AIVP's own 0x44 is
                                 * rejected outright (Process returns 0xffffffff). */
} E = { .m = PTHREAD_MUTEX_INITIALIZER, .c = PTHREAD_COND_INITIALIZER };

/* DLPP's params struct, same field layout as AIVP's for the fields both share
 * (confirmed: +0x00 size, +0x0c level, +0x10 wipe, +0x20/24/28/2c w/h/ow/oh,
 * +0x30/34 pixel fmt in/out, +0x38 native-scale float), plus 0x0c bytes of
 * DLPP-only tail this session leaves zeroed (agent 2's dword sweep found no
 * effect from any of the seven unassigned dwords at level 0).
 *
 * The two fixes are baked in here, unconditionally, not behind env vars:
 *   +0x10 = 0.0f always. This is the split-screen "wipe" field (driver
 *     marshals round(oW*wipe) columns to the un-enhanced side); 1.0 was the
 *     harness's accidental AIVP-era default, and it silently shows 100%
 *     un-enhanced output while looking like "the network is off" (TASK.md
 *     agent 4/5). This filter's whole purpose is showing genuinely enhanced
 *     output, so there is no default other than 0.0 that makes sense here.
 *   +0x38 = E.scale, but ONLY for level >= 3 (levels 1/2 ignore this field;
 *     agent 3 confirmed leaving it unset/stale crashes the DLL at level 3/4,
 *     and any explicit write avoids the crash, with the *correct* integer
 *     scale also giving the best measured quality). */
static void build_params(void)
{
    uint8_t *p = E.params;
    uint32_t v = 0x50;
    float wipe = 0.0f;
    unsigned pfmt = 0x20;       /* same CLI-default pixel-format enum as the AIVP-era embed */
    memset(p, 0, sizeof E.params);
    memcpy(p + 0x00, &v, 4);
    v = E.level; memcpy(p + 0x0c, &v, 4);
    memcpy(p + 0x10, &wipe, 4);
    memcpy(p + 0x20, &E.w, 4);  memcpy(p + 0x24, &E.h, 4);
    memcpy(p + 0x28, &E.ow, 4); memcpy(p + 0x2c, &E.oh, 4);
    memcpy(p + 0x30, &pfmt, 4); memcpy(p + 0x34, &pfmt, 4);
    if (E.level >= 3)
        memcpy(p + 0x38, &E.scale, 4);
}

/* FNV-1a-32 over the raw DLL file. Not a security check (nothing here can verify the DLL's
 * signature, and it does not need to -- the user supplied it themselves, same trust boundary
 * as the DLSS runtime blob). Purely so an init-time log line and a support report can name
 * exactly which nvdlppx.dll build a run was against, and so a future driver update that moves
 * the offsets this file hard-codes shows up as a hash change to compare, rather than a silent
 * crash or garbage output. */
static uint32_t fnv1a_file(const char *path)
{
    FILE *f = fopen(path, "rb");
    uint32_t h = 0x811c9dc5u;
    uint8_t buf[65536];
    size_t n;
    if (!f) return 0;
    while ((n = fread(buf, 1, sizeof buf, f)) > 0)
        for (size_t i = 0; i < n; i++) { h ^= buf[i]; h *= 0x01000193u; }
    fclose(f);
    return h;
}

static int do_init(void)
{
    E.dll_hash = fnv1a_file(E.dll);
    if (map_image(&E.im, E.dll)) return -10;
    if (setup_teb()) return -11;
    if (setup_pe_tls(&E.im)) return -12;
    CUresult_ (*setcur)(void *) = cuda_sym("cuCtxSetCurrent");
    if (!setcur || setcur(E.ctx)) return -13;
    if (E.im.entry_rva) {
        WINAPI int (*dllmain)(void *, uint32_t, void *) = (void *)(E.im.base + E.im.entry_rva);
        dllmain(E.im.base, DLL_PROCESS_ATTACH, NULL);
    }
    g_aivp_quiet = 1;
    g_cuda_external = 1;
    g_stream = E.stream;        /* every DLL launch goes to the host's stream */
    g_aivp_process = 0;         /* run_dlpp stops after CreateInstance */
    if (run_dlpp(&E.im) || !g_aivp_handle || !g_aivp_procfn) return -14;
    E.in_arr = aivp_make_array(E.w, E.h, E.inject);
    E.out_arr = aivp_make_array(E.ow, E.oh, NULL);
    if (!E.in_arr || !E.out_arr) return -15;
    E.in_surf = aivp_obj(E.in_arr, 0);
    E.out_surf = aivp_obj(E.out_arr, 0);
    if (!E.in_surf || !E.out_surf) return -16;
    build_params();
    return 0;
}

static int do_process(void)
{
    WINAPI uint32_t (*process)(void *, void *, void *, void *, void *, void *) = g_aivp_procfn;
    return (int)process(g_aivp_handle, (void *)E.in_surf, (void *)E.out_surf,
                        NULL, NULL, E.params);
}

/* Self-test: one real Process call against whatever the input array already holds (the
 * inject buffer if one was given, otherwise the zeroed array do_init just allocated -- DLPP
 * has no documented "this input is garbage" failure mode distinct from a genuine bug, so a
 * zeroed frame is exactly as good a probe as a real one for "does the call chain work at
 * all"). Reuses do_process() rather than a second code path: the whole point is to exercise
 * exactly what filter_frame will call on frame 1, once, before FFmpeg commits to the chain. */
static int do_selftest(void)
{
    return do_process();
}

static int do_dump(void)
{
    size_t n = (size_t)E.ow * E.oh * 4;
    uint8_t *host = malloc(n);
    if (!host) return -1;
    CUresult_ (*cp)(const Copy2D *) = cuda_sym("cuMemcpy2D_v2");
    Copy2D c = {0};
    c.stype = 3; c.sarr = E.out_arr;
    c.dtype = 1; c.dhost = host; c.dpitch = (size_t)E.ow * 4;
    c.wbytes = (size_t)E.ow * 4; c.h = E.oh;
    int rc = cp ? cp(&c) : -1;
    FILE *fp = rc ? NULL : fopen(E.path, "wb");
    if (fp) {
        fprintf(fp, "P6\n%u %u\n255\n", E.ow, E.oh);
        for (size_t i = 0; i < (size_t)E.ow * E.oh; i++) fwrite(host + i * 4, 1, 3, fp);
        fclose(fp);
    } else if (!rc) rc = -2;
    free(host);
    return rc;
}

static void *worker(void *arg)
{
    (void)arg;
    pthread_mutex_lock(&E.m);
    for (;;) {
        while (E.op == OP_NONE) pthread_cond_wait(&E.c, &E.m);
        int op = E.op, rc = 0;
        pthread_mutex_unlock(&E.m);
        if (op == OP_INIT) rc = do_init();
        else if (op == OP_PROCESS) rc = do_process();
        else if (op == OP_SELFTEST) rc = do_selftest();
        else if (op == OP_DUMP) rc = do_dump();
        fflush(stdout);
        pthread_mutex_lock(&E.m);
        E.rc = rc;
        E.op = OP_NONE;
        pthread_cond_broadcast(&E.c);
        if (op == OP_QUIT) break;
    }
    pthread_mutex_unlock(&E.m);
    return NULL;
}

static int submit(int op)
{
    pthread_mutex_lock(&E.m);
    E.op = op;
    pthread_cond_broadcast(&E.c);
    while (E.op != OP_NONE) pthread_cond_wait(&E.c, &E.m);
    int rc = E.rc;
    pthread_mutex_unlock(&E.m);
    return rc;
}

int gu_dlpp_embed_init(const char *dll, void *cu_ctx, void *cu_stream,
                       unsigned w, unsigned h, unsigned ow, unsigned oh,
                       unsigned level, float scale,
                       const void *inject, uint64_t *in_surf, uint64_t *out_surf)
{
    if (E.started) return -1;          /* one instance per process: the loader is global */
    E.dll = dll; E.ctx = cu_ctx; E.stream = cu_stream; E.inject = inject;
    E.w = w; E.h = h; E.ow = ow; E.oh = oh; E.level = level; E.scale = scale;
    if (pthread_create(&E.t, NULL, worker, NULL)) return -2;
    E.started = 1;
    int rc = submit(OP_INIT);
    E.inject = NULL;
    if (!rc) { *in_surf = E.in_surf; *out_surf = E.out_surf; }
    return rc;
}

int gu_dlpp_embed_process(void) { return E.started ? submit(OP_PROCESS) : -1; }

int gu_dlpp_embed_selftest(char *version_out, size_t version_out_len)
{
    int rc;
    if (!E.started) return -1;
    rc = submit(OP_SELFTEST);
    if (version_out && version_out_len)
        snprintf(version_out, version_out_len, "nvdlppx.dll fnv1a32=%08x", E.dll_hash);
    return rc;
}

int gu_dlpp_embed_dump_ppm(const char *path)
{
    if (!E.started) return -1;
    E.path = path;
    return submit(OP_DUMP);
}

int gu_dlpp_embed_load_ptx(const char *ptx, void **module)
{
    CUresult_ (*ld)(void **, const void *, unsigned, int *, void **) = cuda_sym("cuModuleLoadDataEx");
    if (!ld) return -1;
    static char log[8192];
    /* CU_JIT_ERROR_LOG_BUFFER = 5, CU_JIT_ERROR_LOG_BUFFER_SIZE_BYTES = 6 */
    int opt[2] = {5, 6};
    void *val[2] = {log, (void *)(uintptr_t)sizeof log};
    log[0] = 0;
    CUresult_ r = ld(module, ptx, 2, opt, val);
    if (r) fprintf(stderr, "gu_dlpp_embed: PTX JIT rc=%d\n%s\n", r, log);
    return r;
}

void gu_dlpp_embed_cb_calls(uint64_t out[19])
{
    for (int i = 0; i < 19 && i < AIVP_NCB; i++) out[i] = g_cb_calls[i];
}

void gu_dlpp_embed_close(void)
{
    if (!E.started) return;
    submit(OP_QUIT);
    pthread_join(E.t, NULL);
    E.started = 0;
}
