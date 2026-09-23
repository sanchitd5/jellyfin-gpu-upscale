/*
 * gu_vsr_aivp_loader.c: brought over from rtx-video-re (loader/aivp.c), renamed on the way in,
 * no behaviour changed. This is the AIVP-family host: run_aivp() drives nvaivpx.dll (RTX VSR)
 * through its PPE export table. Own copy, independent of gu_dlpp_aivp_loader.c (same origin,
 * forked rather than shared).
 * Our own reverse-engineered shim code, no NVIDIA material. See RTXVSR.md.
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
 * aivp: drive nvaivpx.dll (RTX VSR / AIVP) through its PPE export table under
 * the loader, with a host callback table whose every slot logs and returns a
 * configurable value.
 *
 * Included by pe_map.c (needs Image, WINAPI, find_export).
 *
 * Shapes, all read from nvppex.dll / nvaivpx.dll disasm (TASK.md Track B 1.3):
 *   ppeGetVersion(uint32_t *out)            -> 0, *out == 1
 *   ppeGetExportTable(void **ppTable, GUID*) -> 0; *ppTable = 80-byte buffer,
 *       [0] = size 0x50, [0x08..0x48] = 9 fn ptrs. Slot 1 = CreateInstance.
 *   CreateInstance(rcx=hostCb, rdx=hostCtx, r8, r9d, [5] dword, [6] ptr,
 *                  [7] void **outHandle)
 *   hostCb = { u64 size = 0xa0, fn[19] }, each fn called as fn(hostCtx, ...)
 *       through a proxy thunk: mov 0x10(%rcx),%rax; mov 0x8(%rcx),%rcx;
 *       jmp *off(%rax).
 *
 * Nothing here is inferred beyond that. The point of this driver is to learn
 * which host callbacks Init/Process actually use, in what order, with what
 * arguments -- dynamically, instead of tracing each one statically.
 */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define AIVP_NCB 19

static uint64_t g_cb_ret[AIVP_NCB];
static uint64_t g_cb_calls[AIVP_NCB];
static uint64_t g_hostctx[64];
static const uint8_t *g_aivp_base;          /* opaque to the DLL; we log its address */
static int g_aivp_quiet;                    /* set by an embedding host (vf_aivp_spike): no per-call logs */
static void *g_aivp_handle, *g_aivp_procfn; /* left behind by run_aivp for an embedding host */

/* Slot 12 (0x68) instrumentation: per-Process call counter (it fires exactly twice),
 * plus a snapshot of the first call's descriptor bytes so run_aivp can diff them
 * against the same memory after Process returns -- does the DLL write back into it. */
static int g_slot12_calls;
static uint64_t g_slot12_desc_ptr;
static uint8_t g_slot12_desc_snap[128];
static int g_slot12_desc_len;

static void aivp_log(int i, uint64_t a, uint64_t b, uint64_t c, uint64_t d,
                     uint64_t e, uint64_t f)
{
    g_cb_calls[i]++;
    if (g_aivp_quiet) return;
    fprintf(stderr,
            "  [hostCb %2d off 0x%02x] ctx=%s a1=%#lx a2=%#lx a3=%#lx s5=%#lx s6=%#lx -> %#lx\n",
            i, 8 + 8 * i, a == (uint64_t)g_hostctx ? "ok" : "??",
            (unsigned long)b, (unsigned long)c, (unsigned long)d,
            (unsigned long)e, (unsigned long)f, (unsigned long)g_cb_ret[i]);
    /* Peek at what the suspected module-load / get-function pair points at:
     * the blob's magic for 6, the argument as a C string for 7. Read-only. */
    if (i == 6 && b) {
        const uint8_t *m = (const uint8_t *)b;
        fprintf(stderr, "      blob img+%#lx magic %02x %02x %02x %02x '%.12s'\n",
                (unsigned long)(m - g_aivp_base), m[0], m[1], m[2], m[3],
                (m[0] >= 0x20 && m[0] < 0x7f) ? (const char *)m : "");
    }
    if (i == 12 && c > 0x10000) {   /* slot 12 (0x68): peek c (a host pointer) */
        const uint8_t *m = (const uint8_t *)c;
        int n = getenv("AIVP_SLOT12_N") ? atoi(getenv("AIVP_SLOT12_N")) : 48;
        fprintf(stderr, "    slot12 c bytes (%d):", n);
        for (int k = 0; k < n; k++) fprintf(stderr, "%s%02x", k % 16 ? " " : "\n     ", m[k]);
        fprintf(stderr, "\n");
        g_slot12_desc_ptr = c;
        g_slot12_desc_len = n < (int)sizeof g_slot12_desc_snap ? n : (int)sizeof g_slot12_desc_snap;
        memcpy(g_slot12_desc_snap, m, g_slot12_desc_len);
        /* AIVP_SLOT12_WRITE="off:w:val" (hex): before returning, write a w-byte
         * little-endian value into the descriptor at c+off -- tests whether it's
         * an out-param the DLL reads back after the call. */
        if (getenv("AIVP_SLOT12_WRITE")) {
            unsigned long off = 0, w = 0, val = 0;
            if (sscanf(getenv("AIVP_SLOT12_WRITE"), "%lx:%lu:%lx", &off, &w, &val) == 3 &&
                (w == 1 || w == 2 || w == 4 || w == 8)) {
                memcpy((void *)(c + off), &val, w);
                fprintf(stderr, "    slot12 WRITE +0x%lx w%lu -> %#lx\n", off, w, val);
            }
        }
    }
    if (i == 7 && c) {
        const char *n = (const char *)c;
        int k = 0;
        while (k < 80 && n[k] >= 0x20 && n[k] < 0x7f) k++;
        fprintf(stderr, "      a2 str '%.*s'\n", k, n);
    }
}

/* ------------------------------------------------------------------ *
 * Real host callbacks, each identified from live logs of the log-only host
 * (aivp1.log/aivp2.log on CT114), not guessed from names:
 *   0  (0x08) get SM version       -> return major*10+minor; with 0 AIVP
 *                                     refuses (0xfffffc18), with 86 it runs.
 *   1  (0x10) alloc(size, flags, CUdeviceptr *out)
 *   3  (0x20) handle -> device address(handle): AIVP calls it right after
 *             every alloc and uses the *return value* as the buffer's device
 *             pointer (gdb at the call site, aivp+0x...c686: `call *0x20(%rax)`
 *             then `mov %rax,0x68(%rsp)`). Our alloc handle is the CUdeviceptr,
 *             so identity. Returning 0 made every later HtoD dst NULL.
 *   6  (0x38) module load(const void *elf, size, CUmodule *out): a1 is always
 *             an ELF (7f 45 4c 46) inside the image.
 *   7  (0x40) get function(CUmodule, const char *name, CUfunction *out): a2
 *             names real kernels (dlpp_preProcess, all_fuse_with_pooling...).
 *   9  (0x50) copy HtoD(dst, const void *src, size): src inside the image,
 *             sizes 0x8..0x4800 -- the weight upload.
 * Anything else stays log-only, returning g_cb_ret[i].
 * ------------------------------------------------------------------ */

static int g_aivp_real = 1;
static int g_sm;
static CUresult_ (*p_cuModuleLoadData)(void **, const void *);
static CUresult_ (*p_cuModuleGetFunction)(void **, void *, const char *);
static CUresult_ (*p_cuMemcpyHtoD)(CUdeviceptr_, const void *, size_t);
static CUresult_ (*p_cuDeviceGetAttribute)(int *, int, int);

static int aivp_cuda_up(void)
{
    if (cuda_bring_up()) return -1;
    p_cuModuleLoadData     = cuda_sym("cuModuleLoadData");
    p_cuModuleGetFunction  = cuda_sym("cuModuleGetFunction");
    p_cuMemcpyHtoD         = cuda_sym("cuMemcpyHtoD_v2");
    p_cuDeviceGetAttribute = cuda_sym("cuDeviceGetAttribute");
    if (!p_cuModuleLoadData || !p_cuModuleGetFunction || !p_cuMemcpyHtoD ||
        !p_cuDeviceGetAttribute) {
        fprintf(stderr, "  aivp: libcuda entry points missing\n");
        return -1;
    }
    int maj = 0, min = 0;
    /* CU_DEVICE_ATTRIBUTE_COMPUTE_CAPABILITY_MAJOR/MINOR = 75/76, device 0 */
    if (p_cuDeviceGetAttribute(&maj, 75, 0) || p_cuDeviceGetAttribute(&min, 76, 0))
        return -1;
    g_sm = maj * 10 + min;
    /* AIVP_SM=NN: report a different SM to the DLL (slot 0x08) to see whether it picks
     * another config/weight path by architecture. The device itself is unchanged. */
    if (getenv("AIVP_SM")) g_sm = atoi(getenv("AIVP_SM"));
    printf("  device sm_%d\n", g_sm);
    return 0;
}

/* Every device buffer we know of: slot-1 allocs plus Process's din/dout. Used to
 * decide whether a launch-arg qword is a real device pointer before reading it. */
#define AIVP_NALLOC 4096
static struct { uint64_t p, n; } g_allocs[AIVP_NALLOC];
static int g_nalloc;
static int g_aivp_in_process;
static void aivp_note_alloc(uint64_t p, uint64_t n)
{
    if (g_nalloc < AIVP_NALLOC) { g_allocs[g_nalloc].p = p; g_allocs[g_nalloc].n = n; g_nalloc++; }
}
static int aivp_find_alloc(uint64_t v, uint64_t *rem)
{
    for (int i = g_nalloc - 1; i >= 0; i--)
        if (v >= g_allocs[i].p && v < g_allocs[i].p + g_allocs[i].n) {
            *rem = g_allocs[i].p + g_allocs[i].n - v;
            return i;
        }
    return -1;
}

static uint64_t aivp_real(int i, uint64_t b, uint64_t c, uint64_t d, int *handled)
{
    *handled = 1;
    CUresult_ r;
    switch (i) {
    case 0:
        return (uint64_t)g_sm;
    case 1:
        if (!d) return 1;
        /* AIVP_ARENA=1: carve slot-1 allocs from one big cuMemAlloc, 512 B aligned,
         * contiguous, with a >=1 MiB unused guard at the end. AIVP_ARENA_MB sizes it. */
        if (getenv("AIVP_ARENA")) {
            static CUdeviceptr_ base; static uint64_t used, cap;
            if (!base) {
                const char *e = getenv("AIVP_ARENA_MB");
                cap = (uint64_t)(e ? strtoul(e, NULL, 10) : 1024) << 20;
                r = p_cuMemAlloc(&base, cap);
                fprintf(stderr, "      arena %#lx -> %#llx rc=%d\n", (unsigned long)cap,
                        (unsigned long long)base, r);
                if (r) { base = 0; return (uint64_t)r; }
            }
            uint64_t n = b ? b : 1, at = (used + 511) & ~511ULL;
            if (at + n + (1ULL << 20) > cap) {
                fprintf(stderr, "      arena exhausted %#lx\n", (unsigned long)n);
                return 2; /* CUDA_ERROR_OUT_OF_MEMORY */
            }
            *(CUdeviceptr_ *)d = base + at; used = at + n;
            aivp_note_alloc(base + at, n);
            fprintf(stderr, "      alloc %#lx -> %#llx arena+%#lx\n", (unsigned long)n,
                    (unsigned long long)(base + at), (unsigned long)at);
            return 0;
        }
        r = p_cuMemAlloc((CUdeviceptr_ *)d, b ? b : 1);
        if (!r) aivp_note_alloc(*(CUdeviceptr_ *)d, b ? b : 1);
        /* Poison allocs made once Process has started, so "kernel wrote zeros" and
         * "kernel never wrote" read differently in the probes. */
        if (!r && g_aivp_in_process && getenv("AIVP_POISON")) {
            static CUresult_ (*ms)(CUdeviceptr_, unsigned char, size_t);
            if (!ms) ms = cuda_sym("cuMemsetD8_v2");
            if (ms) fprintf(stderr, "    poison %#llx+%#lx rc=%d\n",
                            (unsigned long long)*(CUdeviceptr_ *)d, (unsigned long)b,
                            ms(*(CUdeviceptr_ *)d, 0x55, b));
        }
        fprintf(stderr, "      alloc %#lx -> %#llx rc=%d\n", (unsigned long)b,
                *(CUdeviceptr_ *)d, r);
        return (uint64_t)r;
    case 3:
        return b;
    case 6:
        if (!b || !d) return 1;
        r = p_cuModuleLoadData((void **)d, (const void *)b);
        fprintf(stderr, "      cuModuleLoadData -> %p rc=%d\n", *(void **)d, r);
        return (uint64_t)r;
    case 7:
        if (!b || !c || !d) return 1;
        r = p_cuModuleGetFunction((void **)d, (void *)b, (const char *)c);
        fprintf(stderr, "      cuModuleGetFunction -> %p rc=%d\n", *(void **)d, r);
        return (uint64_t)r;
    case 9:
        if (!b || !c) return 1;
        r = p_cuMemcpyHtoD((CUdeviceptr_)b, (const void *)c, (size_t)d);
        if (r) fprintf(stderr, "      cuMemcpyHtoD rc=%d\n", r);
        return (uint64_t)r;
    }
    *handled = 0;
    return 0;
}

/* s5/s6 are read whether or not the caller passed them: garbage from the
 * caller's frame when it did not, never written. */
#define CB(i)                                                                   \
    static WINAPI uint64_t aivp_cb##i(uint64_t a, uint64_t b, uint64_t c,       \
                                      uint64_t d, uint64_t e, uint64_t f)       \
    {                                                                           \
        aivp_log(i, a, b, c, d, e, f);                                          \
        if (i == 12 && !g_aivp_quiet)                                           \
            fprintf(stderr, "    slot12 ret img+%#lx\n", (unsigned long)        \
                    ((const uint8_t *)__builtin_return_address(0) - g_aivp_base)); \
        int h = 0;                                                              \
        uint64_t v = g_aivp_real ? aivp_real(i, b, c, d, &h) : 0;               \
        return h ? v : g_cb_ret[i];                                             \
    }
CB(0) CB(1) CB(2) CB(3) CB(4) CB(5) CB(6) CB(7) CB(9)
CB(10) CB(11) CB(13) CB(14) CB(15) CB(16) CB(17) CB(18)
#undef CB

/* Slot 12 (0x68) gets its own return path, distinct from the CB() macro above:
 * it fires exactly twice per Process and Task 3 (L17 agent 13) needs each call's
 * return value overridable independently.
 * AIVP_SLOT12_RET="idx:val[,idx:val]" (decimal idx, signed val): idx 0 is the
 * first call this Process (a2 = the descriptor pointer), idx 1 is the second
 * (a2 = 0x2c). Unmatched idx falls back to the shared g_cb_ret[12]/--aivp-ret. */
static WINAPI uint64_t aivp_cb12(uint64_t a, uint64_t b, uint64_t c, uint64_t d,
                                 uint64_t e, uint64_t f)
{
    aivp_log(12, a, b, c, d, e, f);
    if (!g_aivp_quiet)
        fprintf(stderr, "    slot12 ret img+%#lx\n", (unsigned long)
                ((const uint8_t *)__builtin_return_address(0) - g_aivp_base));
    int idx = g_slot12_calls++;
    const char *ov = getenv("AIVP_SLOT12_RET");
    if (ov) {
        char buf[64];
        strncpy(buf, ov, sizeof buf - 1);
        buf[sizeof buf - 1] = 0;
        for (char *tok = strtok(buf, ","); tok; tok = strtok(NULL, ",")) {
            int ti; long long tv;
            if (sscanf(tok, "%d:%lld", &ti, &tv) == 2 && ti == idx) {
                fprintf(stderr, "    slot12 call#%d RET override -> %lld\n", idx, tv);
                return (uint64_t)tv;
            }
        }
    }
    int h = 0;
    uint64_t v = g_aivp_real ? aivp_real(12, b, c, d, &h) : 0;
    return h ? v : g_cb_ret[12];
}

/* 8 (0x48) launch. Shape from gdb at two call sites (aivp+0x2a6d1, a generic
 * launcher at aivp+0x55cc7), not from names:
 *   (ctx, CUfunction, argbuf, argsize, bx, by, bz, gx, gy, gz, s11, s12)
 * e.g. first Process launch: block 8x8x1, grid 120x68x1 for a 960x540 input,
 * argsize 0x48. argbuf is one packed parameter block, so it goes through
 * CU_LAUNCH_PARAM_BUFFER_POINTER. s11/s12 are logged: assumed shared-mem /
 * stream. Low dword of s11 matches per-kernel dynamic smem (0x2880..0x6080 on
 * the conv kernels, 0 on dlpp_*); upper half is caller garbage, so only the low
 * dword is used. s12 looks like a host pointer, not a CUstream: passed NULL. */
static uint64_t g_launches;
static void *g_stream;              /* AIVP_STREAM=1: real CUstream, else NULL */
static uint64_t g_stream_launches;  /* launches that went to g_stream */
static WINAPI uint64_t aivp_cb8(uint64_t a, uint64_t fn, uint64_t args, uint64_t size,
                                uint64_t bx, uint64_t by, uint64_t bz, uint64_t gx,
                                uint64_t gy, uint64_t gz, uint64_t s11, uint64_t s12)
{
    g_cb_calls[8]++;
    static CUresult_ (*launch)(void *, unsigned, unsigned, unsigned, unsigned, unsigned,
                               unsigned, unsigned, void *, void **, void **);
    static CUresult_ (*getname)(const char **, void *);
    if (!launch) {
        launch = cuda_sym("cuLaunchKernel");
        getname = cuda_sym("cuFuncGetName");
    }
    const char *name = "?";
    unsigned b[3] = {(unsigned)bx, (unsigned)by, (unsigned)bz};
    unsigned g[3] = {(unsigned)gx, (unsigned)gy, (unsigned)gz};
    if (!g_aivp_quiet) {
    if (getname && fn) getname(&name, (void *)fn);
    fprintf(stderr, "  [launch %lu] %s grid %ux%ux%u block %ux%ux%u args %#lx "
            "s11=%#lx s12=%#lx ctx=%s\n", (unsigned long)g_launches, name,
            g[0], g[1], g[2], b[0], b[1], b[2], (unsigned long)size,
            (unsigned long)s11, (unsigned long)s12,
            a == (uint64_t)g_hostctx ? "ok" : "??");
    if (args && size && (g_launches < 3 || g_launches >= 17 || getenv("AIVP_ARGALL"))) {
        fprintf(stderr, "    argbuf:");
        for (uint64_t k = 0; k < size && k < 0x600; k += 8)
            fprintf(stderr, "%s%016lx", k % 32 ? " " : "\n      ",
                    (unsigned long)*(const uint64_t *)((const uint8_t *)args + k));
        fprintf(stderr, "\n");
    }
    }
    g_launches++;
    if (!g_aivp_real || !launch) return g_cb_ret[8];
    /* AIVP_SKIP="a-b": do not launch kernels a..b (experiment: does output depend on them?) */
    if (getenv("AIVP_SKIP")) {
        unsigned lo = 0, hi = 0;
        if (sscanf(getenv("AIVP_SKIP"), "%u-%u", &lo, &hi) == 2 &&
            g_launches - 1 >= lo && g_launches - 1 <= hi) {
            fprintf(stderr, "    SKIPPED\n");
            return 0;
        }
    }
    /* AIVP_CLOBBER=N:off:byte: before launch N, memset the device buffer whose
     * pointer sits at argbuf+off (to the end of its alloc, max 64 MiB). Proves
     * whether launch N reads that buffer at all. */
    if (getenv("AIVP_CLOBBER") && args && size) {
        unsigned long n = 0, off = 0, byte = 0;
        if (sscanf(getenv("AIVP_CLOBBER"), "%lu:%lx:%lx", &n, &off, &byte) == 3 &&
            g_launches - 1 == n && off + 8 <= size) {
            uint64_t v = *(const uint64_t *)((const uint8_t *)args + off), rem = 0;
            int ai = aivp_find_alloc(v, &rem);
            static CUresult_ (*ms)(CUdeviceptr_, unsigned char, size_t);
            if (!ms) ms = cuda_sym("cuMemsetD8_v2");
            if (ai >= 0 && ms) {
                size_t len = rem < (64u << 20) ? (size_t)rem : (64u << 20);
                fprintf(stderr, "    CLOBBER L%lu +0x%lx=%#lx len %#zx byte %#lx rc=%d\n",
                        n, off, (unsigned long)v, len, byte, (int)ms(v, (unsigned char)byte, len));
            }
        }
    }
    /* AIVP_ARGCOPY=N:off:M:moff (hex offs): before launch N, copy the qword launch M
     * had at moff into argbuf+off. Device VAs move per run; this rewires by reference. */
    {
        static uint64_t seen[32][0x100];
        unsigned long L = g_launches - 1;
        if (args && size && L < 32)
            memcpy(seen[L], args, size < sizeof seen[L] ? size : sizeof seen[L]);
        unsigned long n = 0, off = 0, m = 0, moff = 0;
        if (getenv("AIVP_ARGCOPY") && args && size &&
            sscanf(getenv("AIVP_ARGCOPY"), "%lu:%lx:%lu:%lx", &n, &off, &m, &moff) == 4 &&
            L == n && m < 32 && m <= n && off + 8 <= size && moff / 8 < 0x100) {
            uint64_t *q = (uint64_t *)((uint8_t *)args + off);
            fprintf(stderr, "    ARGCOPY L%lu +0x%lx %#lx -> %#lx\n", n, off,
                    (unsigned long)*q, (unsigned long)seen[m][moff / 8]);
            *q = seen[m][moff / 8];
        }
    }
    /* AIVP_ARGSET=N:off:val: overwrite the argbuf qword at off before launch N. */
    if (getenv("AIVP_ARGSET") && args && size) {
        unsigned long n = 0, off = 0, val = 0;
        if (sscanf(getenv("AIVP_ARGSET"), "%lu:%lx:%lx", &n, &off, &val) == 3 &&
            g_launches - 1 == n && off + 8 <= size) {
            uint64_t *q = (uint64_t *)((uint8_t *)args + off);
            fprintf(stderr, "    ARGSET L%lu +0x%lx %#lx -> %#lx\n", n, off,
                    (unsigned long)*q, val);
            *q = val;
        }
    }
    /* AIVP_ARGW="N;off:w:val;off:w:val..." (hex): before launch N, write each val
     * as a w-byte (1/2/4/8) little-endian field at argbuf+off. Multi-field sweeps. */
    if (getenv("AIVP_ARGW") && args && size) {
        const char *s = getenv("AIVP_ARGW");
        unsigned long n = strtoul(s, (char **)&s, 10);
        if (g_launches - 1 == n) {
            while (*s == ';') {
                unsigned long off = 0, w = 0, val = 0; int used = 0;
                if (sscanf(s + 1, "%lx:%lu:%lx%n", &off, &w, &val, &used) != 3) break;
                s += 1 + used;
                if ((w == 1 || w == 2 || w == 4 || w == 8) && off + w <= size) {
                    memcpy((uint8_t *)args + off, &val, w);
                    fprintf(stderr, "    ARGW L%lu +0x%lx w%lu -> %#lx\n", n, off, w, val);
                }
            }
        }
    }
    size_t sz = (size_t)size;
    void *extra[] = {(void *)1, (void *)args, (void *)2, &sz, (void *)0};
    /* AIVP_STREAM: launch on a real CUstream the harness owns instead of the legacy
     * default stream (s12 is not a stream, so it stays unused). */
    CUresult_ r = launch((void *)fn, g[0], g[1], g[2], b[0], b[1], b[2], (unsigned)s11, g_stream, NULL, extra);
    if (g_stream) g_stream_launches++;
    if (r) fprintf(stderr, "    cuLaunchKernel rc=%d\n", r);
    /* Probe every launch: sync, then for each argbuf qword that lands inside a known
     * device buffer, read back up to 64 KiB from it and count nonzero bytes. */
    if (!r && args && size >= 8 && getenv("AIVP_PROBE")) {
        static CUresult_ (*sync)(void);
        static CUresult_ (*dtoh)(void *, CUdeviceptr_, size_t);
        static uint8_t *probe;
        static size_t probe_cap = 65536;
        if (!probe) {
            if (getenv("AIVP_PROBE_FULL")) probe_cap = 64u << 20;
            probe = malloc(probe_cap);
            if (!probe) return (uint64_t)r;
        }
        if (!sync) { sync = cuda_sym("cuCtxSynchronize"); dtoh = cuda_sym("cuMemcpyDtoH_v2"); }
        CUresult_ sr = sync ? sync() : -1;
        for (uint64_t k = 0; k + 8 <= size && dtoh; k += 8) {
            uint64_t v = *(const uint64_t *)((const uint8_t *)args + k), rem = 0;
            int ai = aivp_find_alloc(v, &rem);
            if (ai < 0) continue;
            size_t n = rem < probe_cap ? (size_t)rem : probe_cap, nz = 0, p55 = 0;
            CUresult_ cr = dtoh(probe, v, n);
            for (size_t j = 0; !cr && j < n; j++) { nz += probe[j] != 0; p55 += probe[j] == 0x55; }
            if (!cr && getenv("AIVP_DUMP")) {   /* AIVP_DUMP=prefix: write probed bytes */
                char fn[512];
                snprintf(fn, sizeof fn, "%s_L%lu_%lx.bin", getenv("AIVP_DUMP"),
                         (unsigned long)(g_launches - 1), (unsigned long)k);
                FILE *df = fopen(fn, "wb");
                if (df) { fwrite(probe, 1, n, df); fclose(df); }
            }
            uint64_t fnv = 1469598103934665603ull;   /* FNV-1a of the probed bytes */
            for (size_t j = 0; !cr && j < n; j++) fnv = (fnv ^ probe[j]) * 1099511628211ull;
            fprintf(stderr, "    probe L%lu sync=%d +%#lx=%#lx alloc#%d(+%#lx/%#lx) rc=%d "
                    "nz %zu/%zu p55 %zu fnv %016lx [%02x %02x %02x %02x %02x %02x %02x %02x]\n",
                    (unsigned long)(g_launches - 1), sr, (unsigned long)k, (unsigned long)v, ai,
                    (unsigned long)(v - g_allocs[ai].p), (unsigned long)g_allocs[ai].n, cr, nz, n, p55, (unsigned long)fnv,
                    probe[0], probe[1], probe[2], probe[3], probe[4], probe[5], probe[6], probe[7]);
        }
    }
    return (uint64_t)r;
}

static struct { uint64_t size; void *fn[AIVP_NCB]; } g_hostcb = {
    0xa0,
    { aivp_cb0, aivp_cb1, aivp_cb2, aivp_cb3, aivp_cb4, aivp_cb5, aivp_cb6,
      aivp_cb7, aivp_cb8, aivp_cb9, aivp_cb10, aivp_cb11, aivp_cb12, aivp_cb13,
      aivp_cb14, aivp_cb15, aivp_cb16, aivp_cb17, aivp_cb18 }
};

/* The AIVP IID (90850b61-4bdb-805e-3a56-82aa26669574) is taken from the
 * feature's own .rdata at +0x202cd8 rather than retyped, so a transcription
 * slip cannot masquerade as an IID mismatch. */
#define AIVP_IID_RVA 0x202cd8

/* "slot=val,slot=val": override a callback's return value. */
static void aivp_parse_rets(const char *s)
{
    while (s && *s) {
        char *end;
        long i = strtol(s, &end, 0);
        if (*end != '=' || i < 0 || i >= AIVP_NCB) {
            fprintf(stderr, "bad --aivp-ret near '%s'\n", s);
            exit(2);
        }
        g_cb_ret[i] = strtoull(end + 1, &end, 0);
        s = (*end == ',') ? end + 1 : NULL;
    }
}

/* ---------------------------------------------------------------------------
 * Process: outer slot 2 (+0x56fd0) forwards (h->obj, rdx, r8, r9, s5, s6) to
 * obj->vtbl[1] (+0x2a1f0). From its disasm: s6 = params, gated size == 0x44;
 * rdx/r8 are saved and later packed into kernel-arg blocks (in/out, assumed);
 * r9 is overwritten before use; s5 is never read. Params fields read:
 *   +0x08..0x0b u8 flags, +0x0c level (0 -> 4), +0x10 float,
 *   +0x20/+0x24 w/h (w*h checked against 480x360 .. 7680x4320),
 *   +0x28/+0x2c dwords, +0x30/+0x34 format enums (0x20/0x29/0x36 special),
 *   +0x38 float. Values below are guesses to learn from, set by env/flags.
 * ------------------------------------------------------------------------- */
static int g_aivp_process;
static unsigned g_pw = 960, g_ph = 540, g_pow = 1920, g_poh = 1080;
static unsigned g_pfin = 0x20, g_pfout = 0x20, g_plevel = 0;

/* ---------------------------------------------------------------------------
 * Experiment: Process's in/out as CUDA array-backed texture / surface objects
 * instead of raw device pointers (AIVP_IO=tex or AIVP_IO=surf for the input;
 * output is then always a surface). Evidence that motivated it: with raw ptrs,
 * dlpp_preProcess writes the constant (-1,-1,-1,0) for every pixel (it read 0),
 * and dlpp_postProcess leaves a poisoned dout untouched.
 * ------------------------------------------------------------------------- */
typedef struct { size_t w, h, d; unsigned fmt, nch, flags; } Arr3D;
typedef struct {
    size_t sx, sy; unsigned stype; const void *shost; CUdeviceptr_ sdev; void *sarr; size_t spitch;
    size_t dx, dy; unsigned dtype; void *dhost; CUdeviceptr_ ddev; void *darr; size_t dpitch;
    size_t wbytes, h;
} Copy2D;
typedef struct { unsigned type; unsigned pad; union { void *arr; int reserved[32]; } res; unsigned flags; } ResDesc;
typedef struct {
    unsigned addr[3], filter, flags, aniso, mipfilter;
    float bias, minclamp, maxclamp, border[4];
    int reserved[12];
} TexDesc;

static void *aivp_make_array(unsigned w, unsigned hgt, const void *host)
{
    CUresult_ (*mk)(void **, const Arr3D *) = cuda_sym("cuArray3DCreate_v2");
    CUresult_ (*cp)(const Copy2D *) = cuda_sym("cuMemcpy2D_v2");
    if (!mk || !cp) return NULL;
    Arr3D ad = { w, hgt, 0, 0x01 /* UNSIGNED_INT8 */, 4, 0x02 /* SURFACE_LDST */ };
    void *a = NULL;
    CUresult_ r = mk(&a, &ad);
    if (r) { fprintf(stderr, "  cuArray3DCreate rc=%d\n", r); return NULL; }
    if (host) {
        Copy2D c = {0};
        c.stype = 1; c.shost = host; c.spitch = (size_t)w * 4;
        c.dtype = 3; c.darr = a; c.wbytes = (size_t)w * 4; c.h = hgt;
        r = cp(&c);
        if (r) fprintf(stderr, "  HtoA rc=%d\n", r);
    }
    return a;
}

static uint64_t aivp_obj(void *arr, int tex)
{
    ResDesc rd; memset(&rd, 0, sizeof rd);
    rd.type = 0; rd.res.arr = arr;
    uint64_t o = 0;
    CUresult_ r;
    if (tex) {
        CUresult_ (*mk)(uint64_t *, const ResDesc *, const TexDesc *, const void *) =
            cuda_sym("cuTexObjectCreate");
        TexDesc td; memset(&td, 0, sizeof td);
        td.addr[0] = td.addr[1] = td.addr[2] = 1;   /* CLAMP */
        td.filter = getenv("AIVP_TEXLINEAR") ? 1 : 0;
        td.flags = getenv("AIVP_TEXNORMCOORD") ? 0x2 : 0;
        r = mk ? mk(&o, &rd, &td, NULL) : -1;
    } else {
        CUresult_ (*mk)(uint64_t *, const ResDesc *) = cuda_sym("cuSurfObjectCreate");
        r = mk ? mk(&o, &rd) : -1;
    }
    fprintf(stderr, "  %s object %#lx rc=%d\n", tex ? "tex" : "surf", (unsigned long)o, r);
    return r ? 0 : o;
}

static int aivp_process(void **buf, void *h)
{
    CUresult_ (*memcpyDtoH)(void *, CUdeviceptr_, size_t) = cuda_sym("cuMemcpyDtoH_v2");
    CUresult_ (*ctxSync)(void) = cuda_sym("cuCtxSynchronize");
    if (!memcpyDtoH || !ctxSync || !p_cuMemAlloc || !p_cuMemcpyHtoD) {
        fprintf(stderr, "  aivp: process needs libcuda entry points\n");
        return -1;
    }
    /* AIVP_STREAM=1: every launch goes to one real CUstream; the loop drops its
     * per-frame sync and syncs that stream once at the end. */
    CUresult_ (*streamSync)(void *) = NULL;
    if (getenv("AIVP_STREAM")) {
        CUresult_ (*streamCreate)(void **, unsigned) = cuda_sym("cuStreamCreate");
        streamSync = cuda_sym("cuStreamSynchronize");
        if (!streamCreate || !streamSync || streamCreate(&g_stream, 1 /* NON_BLOCKING */)) {
            fprintf(stderr, "  aivp: AIVP_STREAM: cuStreamCreate failed\n");
            return -1;
        }
        printf("  AIVP_STREAM: stream %p\n", g_stream);
    }
    size_t isz = (size_t)g_pw * g_ph * 4, osz = (size_t)g_pow * g_poh * 4;
    CUdeviceptr_ din = 0, dout = 0;
    if (p_cuMemAlloc(&din, isz) || p_cuMemAlloc(&dout, osz)) {
        fprintf(stderr, "  aivp: frame alloc failed\n");
        return -1;
    }
    aivp_note_alloc(din, isz);
    aivp_note_alloc(dout, osz);
    printf("  din=%#llx dout=%#llx\n", (unsigned long long)din, (unsigned long long)dout);
    uint8_t *host = malloc(osz > isz ? osz : isz);
    if (!host) return -1;
    /* Test card: diagonal gradient plus a hard-edged checker, RGBA. */
    for (unsigned y = 0; y < g_ph; y++)
        for (unsigned x = 0; x < g_pw; x++) {
            uint8_t *px = host + ((size_t)y * g_pw + x) * 4;
            int chk = ((x / 16) ^ (y / 16)) & 1;
            px[0] = (uint8_t)(x * 255 / g_pw);
            px[1] = (uint8_t)(y * 255 / g_ph);
            px[2] = chk ? 230 : 25;
            px[3] = 255;
        }
    /* AIVP_INPUT: raw RGBA8 file of exactly w*h*4 bytes replaces the test card. */
    if (getenv("AIVP_INPUT")) {
        FILE *in = fopen(getenv("AIVP_INPUT"), "rb");
        size_t got = in ? fread(host, 1, isz, in) : 0;
        if (in) fclose(in);
        if (got != isz) {
            fprintf(stderr, "  AIVP_INPUT: read %zu of %zu bytes\n", got, isz);
            free(host);
            return -1;
        }
        printf("  input from %s\n", getenv("AIVP_INPUT"));
    }
    if (p_cuMemcpyHtoD(din, host, isz)) { free(host); return -1; }
    /* Poison the output so "kernel wrote zeros" and "kernel never wrote" differ. */
    if (p_cuMemsetD8) p_cuMemsetD8(dout, 0x55, osz);

    /* Buffer sized 0x50, not AIVP's native 0x44, so an AIVP_PSIZE=0x50 probe
     * (DLPP task 2: black-box AIVP_PSIZE sweep found DLPP's own Process gate
     * at +0x00 wants 0x50, not AIVP's 0x44) reads defined zero bytes past
     * +0x44 instead of stack garbage. Default stays 0x44 so AIVP's own
     * canonical repro is unaffected. */
    uint8_t params[0x50] = {0};
    uint32_t v;
    v = getenv("AIVP_PSIZE") ? (uint32_t)strtoul(getenv("AIVP_PSIZE"), NULL, 0) : 0x44;
    memcpy(params + 0x00, &v, 4);
    v = g_plevel; memcpy(params + 0x0c, &v, 4);
    float f = 1.0f; memcpy(params + 0x10, &f, 4);
    memcpy(params + 0x20, &g_pw, 4);  memcpy(params + 0x24, &g_ph, 4);
    memcpy(params + 0x28, &g_pow, 4); memcpy(params + 0x2c, &g_poh, 4);
    /* AIVP_PFIN/AIVP_PFOUT -> +0x30/+0x34 (u32 pixel-format enum, default g_pfin=g_pfout=0x20,
     * our own CLI-default hardcode, never reverse-engineered from the DLL - same bug class as
     * the old +0x10=1.0f scaffolding). Set on the globals, not just params, so the stage-4
     * printf below reports the actual value used. */
    if (getenv("AIVP_PFIN"))  g_pfin  = (unsigned)strtoul(getenv("AIVP_PFIN"),  NULL, 0);
    if (getenv("AIVP_PFOUT")) g_pfout = (unsigned)strtoul(getenv("AIVP_PFOUT"), NULL, 0);
    memcpy(params + 0x30, &g_pfin, 4); memcpy(params + 0x34, &g_pfout, 4);
    /* Unknown fields, settable for experiments: AIVP_FLAGS -> +0x08 (u32 over the four u8
     * flags), AIVP_F38 -> +0x38 (float), AIVP_F10 -> +0x10 (float). */
    if (getenv("AIVP_FLAGS")) { v = (uint32_t)strtoul(getenv("AIVP_FLAGS"), NULL, 0); memcpy(params + 0x08, &v, 4); }
    if (getenv("AIVP_F38")) { f = strtof(getenv("AIVP_F38"), NULL); memcpy(params + 0x38, &f, 4); }
    /* AIVP_SET="off=float,..." writes floats at arbitrary params offsets (+0x3c/+0x40 are
     * read by Process at aivp+0x2a673 and packed into preProcess's arg block). */
    for (const char *q = getenv("AIVP_SET"); q && *q;) {
        char *e;
        unsigned long off = strtoul(q, &e, 0);
        if (*e != '=' || off + 4 > sizeof params) break;
        f = strtof(e + 1, &e);
        memcpy(params + off, &f, 4);
        q = (*e == ',') ? e + 1 : NULL;
    }
    if (getenv("AIVP_F10")) { f = strtof(getenv("AIVP_F10"), NULL); memcpy(params + 0x10, &f, 4); }
    /* AIVP_SETI="off=int,..." -- same as AIVP_SET but writes an int32 bit pattern instead of a
     * float, for DLPP task 1's level/enable-code sweep (3,4,8,15,16,32,64,100) on the ~10
     * dwords past AIVP's own 0x44-byte layout that no float sweep would represent correctly. */
    for (const char *q = getenv("AIVP_SETI"); q && *q;) {
        char *e;
        unsigned long off = strtoul(q, &e, 0);
        if (*e != '=' || off + 4 > sizeof params) break;
        int32_t iv = (int32_t)strtol(e + 1, &e, 0);
        memcpy(params + off, &iv, 4);
        q = (*e == ',') ? e + 1 : NULL;
    }

    WINAPI uint32_t (*process)(void *, void *, void *, void *, void *, void *) =
        (void *)buf[2];
    memset(g_cb_calls, 0, sizeof g_cb_calls);
    printf("--- stage 4: AIVP Process %ux%u -> %ux%u fmt %#x/%#x level %u ---\n",
           g_pw, g_ph, g_pow, g_poh, g_pfin, g_pfout, g_plevel);
    printf("  Process(h=%p, in=%#llx, out=%#llx, 0, 0, params)\n", h,
           (unsigned long long)din, (unsigned long long)dout);
    /* AIVP_PDUMP: dump the full params[0x50] buffer as sent, dword by dword. DLPP task 1's
     * struct-sweep needs to see every field, not just the ones this loader already names. */
    if (getenv("AIVP_PDUMP")) {
        fprintf(stderr, "  params[0x%zx]:", sizeof params);
        for (size_t k = 0; k < sizeof params; k += 4) {
            uint32_t dw; memcpy(&dw, params + k, 4);
            fprintf(stderr, "%s+%02zx=%08x", k % 16 ? " " : "\n    ", k, dw);
        }
        fprintf(stderr, "\n");
    }
    fflush(stdout);
    g_aivp_in_process = 1;
    g_slot12_calls = 0;
    const char *io = getenv("AIVP_IO");
    void *ain = NULL, *aout = NULL;
    uint64_t pin = din, pout = dout;
    if (io) {
        ain = aivp_make_array(g_pw, g_ph, host);
        aout = aivp_make_array(g_pow, g_poh, NULL);
        if (!ain || !aout) return -1;
        pin = aivp_obj(ain, !strcmp(io, "tex"));
        pout = aivp_obj(aout, 0);
        if (!pin || !pout) return -1;
        printf("  AIVP_IO=%s: in obj %#lx, out surf %#lx\n", io, (unsigned long)pin,
               (unsigned long)pout);
    }
    /* AIVP_PREV=file (needs AIVP_IO): the first Process call sees this RGBA frame instead
     * of AIVP_INPUT; AIVP_LOOP calls then see AIVP_INPUT. Tests carry-over between calls. */
    uint64_t pfirst = pin;
    if (getenv("AIVP_PREV")) {
        uint8_t *pb = malloc(isz);
        FILE *pf = fopen(getenv("AIVP_PREV"), "rb");
        size_t got = (pb && pf) ? fread(pb, 1, isz, pf) : 0;
        if (pf) fclose(pf);
        void *aprev = (io && got == isz) ? aivp_make_array(g_pw, g_ph, pb) : NULL;
        free(pb);
        if (!aprev || !(pfirst = aivp_obj(aprev, !strcmp(io, "tex")))) {
            fprintf(stderr, "  AIVP_PREV: failed (read %zu of %zu, needs AIVP_IO)\n", got, isz);
            return -1;
        }
        printf("  AIVP_PREV: first call input from %s\n", getenv("AIVP_PREV"));
    }
    uint32_t r = process(h, (void *)pfirst, (void *)pout, NULL, NULL, params);
    g_aivp_in_process = 0;
    CUresult_ sr = ctxSync();
    printf("  Process -> %#x, cuCtxSynchronize rc=%d\n", r, sr);
    /* L17 agent 13, slot 12 Task 2: diff the first call's descriptor bytes against the
     * same host memory now that Process has fully returned -- is it read-only, or does
     * the DLL write back into it (in/out param)? Black-box (no DLL disassembly): a diff
     * here is decisive either way without needing to step through the DLL's own code. */
    if (g_slot12_desc_ptr && g_slot12_desc_len) {
        const uint8_t *m = (const uint8_t *)g_slot12_desc_ptr;
        int changed = memcmp(m, g_slot12_desc_snap, g_slot12_desc_len) != 0;
        fprintf(stderr, "    slot12 descriptor post-Process: %s\n",
                changed ? "CHANGED (DLL wrote back)" : "unchanged (read-only from DLL's side)");
        if (changed) {
            fprintf(stderr, "      before:");
            for (int k = 0; k < g_slot12_desc_len; k++)
                fprintf(stderr, "%s%02x", k % 16 ? " " : "\n       ", g_slot12_desc_snap[k]);
            fprintf(stderr, "\n      after: ");
            for (int k = 0; k < g_slot12_desc_len; k++)
                fprintf(stderr, "%s%02x", k % 16 ? " " : "\n       ", m[k]);
            fprintf(stderr, "\n");
        }
    }
    /* AIVP_LOOP=N: N more Process calls on the same instance and buffers, one sync each
     * (the harness's, not per launch), timed; host-callback deltas show per-frame allocs
     * (slot 1) and uploads (slot 9). Output below is from the last call. */
    if (!r && getenv("AIVP_LOOP")) {
        unsigned n = (unsigned)strtoul(getenv("AIVP_LOOP"), NULL, 0);
        uint64_t c0[AIVP_NCB];
        memcpy(c0, g_cb_calls, sizeof c0);
        double tot = 0, mn = 1e9, mx = 0;
        g_aivp_in_process = 1;
        for (unsigned i = 0; i < n && !r; i++) {
            struct timespec a, b;
            clock_gettime(CLOCK_MONOTONIC, &a);
            r = process(h, (void *)pin, (void *)pout, NULL, NULL, params);
            sr = g_stream ? 0 : ctxSync();
            if (g_stream && i + 1 == n) sr = streamSync(g_stream);
            clock_gettime(CLOCK_MONOTONIC, &b);
            double ms = (b.tv_sec - a.tv_sec) * 1e3 + (b.tv_nsec - a.tv_nsec) / 1e6;
            tot += ms; if (ms < mn) mn = ms; if (ms > mx) mx = ms;
            if (r || sr) printf("  loop %u: Process -> %#x sync rc=%d\n", i, r, sr);
        }
        g_aivp_in_process = 0;
        printf("  loop x%u: ms/frame avg %.3f min %.3f max %.3f%s\n", n, n ? tot / n : 0, mn, mx,
               g_stream ? " (stream: no per-frame sync, one sync at end; avg is the meaningful figure)" : "");
        if (g_stream)
            printf("  AIVP_STREAM: %lu of %lu launches on stream %p\n",
                   (unsigned long)g_stream_launches, (unsigned long)g_launches, g_stream);
        printf("  loop callback deltas:");
        for (int i = 0; i < AIVP_NCB; i++)
            if (g_cb_calls[i] != c0[i])
                printf(" %d(+%lu)", i, (unsigned long)(g_cb_calls[i] - c0[i]));
        printf("\n");
    }
    printf("  host callbacks used:");
    for (int i = 0; i < AIVP_NCB; i++)
        if (g_cb_calls[i]) printf(" %d(x%lu)", i, (unsigned long)g_cb_calls[i]);
    printf("\n");

    CUresult_ rb;
    if (aout) {
        CUresult_ (*cp)(const Copy2D *) = cuda_sym("cuMemcpy2D_v2");
        Copy2D c = {0};
        c.stype = 3; c.sarr = aout;
        c.dtype = 1; c.dhost = host; c.dpitch = (size_t)g_pow * 4;
        c.wbytes = (size_t)g_pow * 4; c.h = g_poh;
        memset(host, 0x55, osz);
        rb = cp ? cp(&c) : -1;
        printf("  AtoH rc=%d\n", rb);
    } else {
        rb = memcpyDtoH(host, dout, osz);
    }
    if (!rb) {
        const char *op = getenv("AIVP_OUT") ? getenv("AIVP_OUT") : "aivp_out.ppm";
        FILE *fp = fopen(op, "wb");
        size_t nz = 0, poison = 0;
        for (size_t i = 0; i < osz; i++) { nz += host[i] != 0; poison += host[i] == 0x55; }
        printf("  output: %zu/%zu nonzero, %zu still poison 0x55, written %s\n",
               nz, osz, poison, op);
        printf("  first px: %02x %02x %02x %02x | %02x %02x %02x %02x\n", host[0], host[1],
               host[2], host[3], host[4], host[5], host[6], host[7]);
        if (fp) {
            fprintf(fp, "P6\n%u %u\n255\n", g_pow, g_poh);
            for (size_t i = 0; i < (size_t)g_pow * g_poh; i++) fwrite(host + i * 4, 1, 3, fp);
            fclose(fp);
        }
    }
    free(host);
    return r ? -1 : 0;
}

/* AIVP_THREAD: run Process (and the loop) on a second pthread, the way ffmpeg's
 * filter thread would, after init ran on the main one.
 *   AIVP_THREAD=none  worker gets no %gs setup at all (does it need one?)
 *   AIVP_THREAD=teb   worker builds its own TEB (own stack bounds) and reuses the
 *                     main thread's PE TLS array (TEB+0x58)
 * CUDA: the worker binds the same context the main thread made current. */
#include <pthread.h>
static uint8_t *g_teb;          /* tentative: defined in pe_map.c */
static int setup_teb(void);     /* pe_map.c */
struct aivp_job { void **buf; void *h; void *ctx; const char *mode; int rc; };
static void *aivp_worker(void *p)
{
    struct aivp_job *j = p;
    if (!strcmp(j->mode, "teb")) {
        uint64_t tls; memcpy(&tls, g_teb + 0x58, 8);
        if (setup_teb()) { j->rc = -2; return NULL; }
        memcpy(g_teb + 0x58, &tls, 8);
        printf("  AIVP_THREAD=teb: worker TEB %p, TLS array reused\n", (void *)g_teb);
    } else {
        printf("  AIVP_THREAD=%s: worker without TEB setup\n", j->mode);
    }
    CUresult_ (*setcur)(void *) = cuda_sym("cuCtxSetCurrent");
    if (!setcur || setcur(j->ctx)) { j->rc = -3; return NULL; }
    fflush(stdout);
    j->rc = aivp_process(j->buf, j->h);
    return NULL;
}
static int aivp_process_threaded(void **buf, void *h, const char *mode)
{
    CUresult_ (*getcur)(void **) = cuda_sym("cuCtxGetCurrent");
    struct aivp_job j = { buf, h, NULL, mode, -1 };
    if (!getcur || getcur(&j.ctx) || !j.ctx) { fprintf(stderr, "  aivp: no current ctx\n"); return -1; }
    pthread_t t;
    if (pthread_create(&t, NULL, aivp_worker, &j)) return -1;
    pthread_join(t, NULL);
    printf("  AIVP_THREAD: worker rc=%d\n", j.rc);
    return j.rc;
}

/* Shared PPE bring-up: ppeGetVersion -> ppeGetExportTable(iid) -> CreateInstance.
 * Feature-agnostic; `label` is only for the printfs. Used by both run_aivp
 * (AIVP, IID read from the image's own .rdata at AIVP_IID_RVA) and run_dlpp
 * (DLPP, IID supplied by the caller since no DLPP-side RVA has been found --
 * see the DLPP_IID env override in run_dlpp). */
static int run_ppe_instance(Image *im, const uint8_t *iid, const char *label)
{
    WINAPI uint32_t (*get_ver)(uint32_t *) = find_export(im, "ppeGetVersion");
    WINAPI uint32_t (*get_tbl)(void **, const void *) = find_export(im, "ppeGetExportTable");
    if (!get_ver || !get_tbl) { fprintf(stderr, "%s: ppe exports missing\n", label); return -1; }

    g_aivp_base = im->base;
    if (g_aivp_real && aivp_cuda_up()) return -1;
    uint32_t ver = 0;
    uint32_t r = get_ver(&ver);
    printf("  ppeGetVersion -> %#x, out=%u\n", r, ver);
    if (r || ver != 1) return -1;

    /* The host passes a pointer to its own buffer pointer; buffer pre-sized
     * 0x50 in the first qword (nvppex.dll+0x4b9c0 path). */
    uint64_t *buf = calloc(1, 0x50);
    if (!buf) return -1;
    buf[0] = 0x50;
    void *bp = buf;
    printf("  IID bytes:");
    for (int i = 0; i < 16; i++) printf(" %02x", iid[i]);
    printf("\n");
    r = get_tbl(&bp, iid);
    printf("  ppeGetExportTable -> %#x, size=%#lx\n", r, (unsigned long)buf[0]);
    if (r) { free(buf); return -1; }
    for (int i = 1; i <= 9; i++)
        printf("    slot %d  +0x%lx\n", i, (unsigned long)((uint8_t *)buf[i] - im->base));

    WINAPI uint32_t (*create)(void *, void *, uint64_t, uint32_t, uint32_t,
                              void *, void **) = (void *)buf[1];
    void *h = NULL;
    printf("  CreateInstance(hostCb=%p, hostCtx=%p, 0, 0, 0, NULL, &h)\n",
           (void *)&g_hostcb, (void *)g_hostctx);
    fflush(stdout);
    r = create(&g_hostcb, g_hostctx, 0, 0, 0, NULL, &h);
    printf("  CreateInstance -> %#x, handle=%p\n", r, h);
    printf("  host callbacks used:");
    for (int i = 0; i < AIVP_NCB; i++)
        if (g_cb_calls[i]) printf(" %d(x%lu)", i, (unsigned long)g_cb_calls[i]);
    printf("\n");
    g_aivp_handle = h;
    g_aivp_procfn = (void *)buf[2];
    if (r || !h || !g_aivp_process) return r ? -1 : 0;
    if (getenv("AIVP_THREAD")) return aivp_process_threaded((void **)buf, h, getenv("AIVP_THREAD"));
    return aivp_process((void **)buf, h);
}

static int run_aivp(Image *im)
{
    return run_ppe_instance(im, im->base + AIVP_IID_RVA, "aivp");
}

/* Brute-force locate DLPP's own IID: ppeGetExportTable() rejects any 16 bytes
 * that aren't the feature's own interface IID (confirmed above -- the shared
 * AIVP-family guess got 0xfffffc18, not 0). The IID is a compile-time
 * constant sitting somewhere in nvdlppx.dll's own .rdata, the same place
 * AIVP's was found (comment above AIVP_IID_RVA). Rather than disassemble
 * ppeGetExportTable to find the compare, walk 4-byte-aligned offsets across
 * the mapped image and ask the DLL's own export whether each 16-byte window
 * is its IID. This is calling an export with different argument bytes, not
 * disassembly of the DLL's compiled code. */
static int run_dlpp_scan_iid(Image *im)
{
    WINAPI uint32_t (*get_ver)(uint32_t *) = find_export(im, "ppeGetVersion");
    WINAPI uint32_t (*get_tbl)(void **, const void *) = find_export(im, "ppeGetExportTable");
    if (!get_ver || !get_tbl) { fprintf(stderr, "dlpp-scan: ppe exports missing\n"); return -1; }
    if (g_aivp_real && aivp_cuda_up()) return -1;
    uint32_t ver = 0;
    if (get_ver(&ver) || ver != 1) { fprintf(stderr, "dlpp-scan: ppeGetVersion failed\n"); return -1; }

    size_t n = im->size;
    int found = 0;
    uint64_t buf[16];
    for (size_t off = 0; off + 16 <= n; off += 4) {
        memset(buf, 0, sizeof buf);
        buf[0] = 0x50;
        void *bp = buf;
        uint32_t r = get_tbl(&bp, im->base + off);
        if (r == 0) {
            printf("  MATCH at RVA +0x%zx: IID", off);
            for (int i = 0; i < 16; i++) printf(" %02x", im->base[off + i]);
            printf("\n");
            for (int i = 1; i <= 9; i++)
                printf("    slot %d  +0x%lx\n", i, (unsigned long)((uint8_t *)buf[i] - im->base));
            found++;
            if (found >= 5) break; /* enough to be confident, keep scanning cheap */
        }
    }
    printf("  scan done: %d match(es) over %zu positions\n", found, n / 4);
    return found ? 0 : -1;
}

/* DLPP's own IID, found by run_dlpp_scan_iid above (RVA +0xde50e8, 1 match in
 * 6.26M 4-byte-aligned positions tried): 90850b61-4bdb-5e80-3a56-82aa26669574.
 * One field off from AIVP's 90850b61-4bdb-805e-3a56-82aa26669574 (Data3 0x5e80
 * vs 0x805e) -- same family, distinct per-feature interface variant, not a
 * shared IID (confirmed: trying AIVP's own IID against nvdlppx.dll's
 * ppeGetExportTable returned 0xfffffc18, not 0). DLPP_IID=<32 hex chars>
 * overrides for further probing. */
static int run_dlpp(Image *im)
{
    static const uint8_t dlpp_iid[16] = {
        0x61, 0x0b, 0x85, 0x90, 0xdb, 0x4b, 0x80, 0x5e,
        0x3a, 0x56, 0x82, 0xaa, 0x26, 0x66, 0x95, 0x74
    };
    uint8_t iid[16];
    memcpy(iid, dlpp_iid, 16);
    const char *ov = getenv("DLPP_IID");
    if (ov && strlen(ov) == 32) {
        for (int i = 0; i < 16; i++) sscanf(ov + i * 2, "%2hhx", &iid[i]);
    }
    return run_ppe_instance(im, iid, "dlpp");
}
