/*
 * gu_vsr_pe_map.c: brought over from the personal rtx-video-re reverse-engineering checkout
 * (loader/pe_map.c) so vf_vsr_rtcuda.c builds standalone from this repo, no dependency on that
 * checkout existing at build time. Renamed on the way in (was pe_map.c); no behaviour changed.
 * Own copy, independent of the concurrent gu_dlpp_pe_map.c promotion (same origin, forked rather
 * than shared, so neither filter's build depends on the other's files).
 * Our own code, no NVIDIA material: a from-scratch minimal PE32+ loader and Win64-ABI shim.
 * See RTXVSR.md.
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
 * loader_ngx: map a PE32+ image into this process and run it.
 *
 * Stage 1 maps sections, applies base relocations and binds imports.
 * Stage 2 (--run) builds a TEB, sets up PE thread-local storage, calls DllMain
 * and then a chosen export.
 *
 * On the TEB, which looked like the hard part and is not: MSVC reaches thread
 * state through %gs, while Linux/glibc on x86-64 uses %fs. The two do not
 * collide, so arch_prctl(ARCH_SET_GS) can point %gs at a Windows TEB and leave
 * glibc's own TLS, errno and malloc working in the same thread. Measured before
 * relying on it -- a __thread canary, &errno and stdio all survive SET_GS -- so
 * no per-call segment swapping is needed.
 *
 *   cc -O2 -o pe_map pe_map.c -ldl
 *   ./pe_map <file.dll> [--run] [--export NAME] [--isr W H S] [--aivp [--aivp-ret i=v,...] [--aivp-process w,h,ow,oh,fi,fo,lvl]] [-v]
 */

#define _GNU_SOURCE
#include <asm/prctl.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

/*
 * Everything the DLL exports or receives as a callback is Win64 ABI: arguments
 * in RCX/RDX/R8/R9 with 32 bytes of shadow space, not SysV's RDI/RSI/RDX/RCX.
 * Calling one as an ordinary C function pointer puts every argument in the
 * wrong register. ms_abi is the compiler's own translation and is the only
 * correct way to cross that boundary.
 */
#define WINAPI __attribute__((ms_abi))

#define DIR_EXPORT    0
#define DIR_IMPORT    1
#define DIR_BASERELOC 5
#define DIR_TLS       9

#define DLL_PROCESS_ATTACH 1

typedef struct {
    uint8_t  *base;
    size_t    size;
    uint64_t  image_base;
    uint32_t  entry_rva;
    uint32_t  dir_rva[16];
    uint32_t  dir_size[16];
    int       nresolved, nstubbed;
} Image;

static int g_verbose;

static uint16_t rd16(const void *p) { uint16_t v; memcpy(&v, p, 2); return v; }
static uint32_t rd32(const void *p) { uint32_t v; memcpy(&v, p, 4); return v; }
static uint64_t rd64(const void *p) { uint64_t v; memcpy(&v, p, 8); return v; }

/* ------------------------------------------------------------------ *
 * Named stubs.
 *
 * A single shared do-nothing stub makes every unimplemented import look
 * identical, so the first crash says only "it crashed". Instead each unresolved
 * import gets its own 32-byte trampoline that loads its index and tails into a
 * common handler, which can then name it. Turning "segfault" into "it called
 * GetStartupInfoW" is the difference between guessing and knowing.
 * ------------------------------------------------------------------ */

#define MAX_IMPORTS 4096
static const char *g_impname[MAX_IMPORTS];
static int g_impcount;
static int g_called[MAX_IMPORTS];
static uint8_t *g_tramp;

static WINAPI uint64_t stub_named(uint64_t idx)
{
    if (idx < MAX_IMPORTS) {
        if (!g_called[idx]++)
            fprintf(stderr, "  [stub] %s\n", g_impname[idx]);
    }
    return 0;
}

static void *make_tramp(int idx)
{
    if (!g_tramp) {
        g_tramp = mmap(NULL, MAX_IMPORTS * 32, PROT_READ | PROT_WRITE | PROT_EXEC,
                       MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (g_tramp == MAP_FAILED) { perror("mmap tramp"); exit(3); }
    }
    uint8_t *t = g_tramp + (size_t)idx * 32;
    uint64_t handler = (uint64_t)stub_named;
    uint64_t i64 = (uint64_t)idx;
    /* mov rcx, idx ; mov r11, handler ; jmp r11
     * rcx is the first ms_abi argument and r11 is volatile in both ABIs, so
     * this clobbers nothing the handler needs. The real arguments are lost,
     * which is fine: the handler only reports and returns 0. */
    t[0] = 0x48; t[1] = 0xB9; memcpy(t + 2, &i64, 8);
    t[10] = 0x49; t[11] = 0xBB; memcpy(t + 12, &handler, 8);
    t[20] = 0x41; t[21] = 0xFF; t[22] = 0xE3;
    return t;
}

/* ------------------------------------------------------------------ *
 * Win32 shim: the handful with behaviour that matters.
 * ------------------------------------------------------------------ */

static WINAPI uint32_t sh_GetLastError(void) { return 0; }
static WINAPI void     sh_SetLastError(uint32_t e) { (void)e; }
static WINAPI void    *sh_GetProcessHeap(void) { return (void *)0x1; }
static WINAPI void    *sh_HeapCreate(uint32_t a, size_t b, size_t c)
{ (void)a; (void)b; (void)c; return (void *)0x1; }
static WINAPI int      sh_HeapDestroy(void *h) { (void)h; return 1; }
static WINAPI void    *sh_HeapAlloc(void *h, uint32_t f, size_t n)
{
    (void)h;
    void *p = malloc(n ? n : 1);
    if (p && (f & 0x8))      /* HEAP_ZERO_MEMORY */
        memset(p, 0, n);
    return p;
}
static WINAPI int      sh_HeapFree(void *h, uint32_t f, void *p) { (void)h; (void)f; free(p); return 1; }
static WINAPI void    *sh_HeapReAlloc(void *h, uint32_t f, void *p, size_t n)
{ (void)h; (void)f; return realloc(p, n); }
static WINAPI size_t   sh_HeapSize(void *h, uint32_t f, void *p) { (void)h; (void)f; (void)p; return 0; }
static WINAPI uint32_t sh_GetCurrentThreadId(void) { return 1; }
static WINAPI uint32_t sh_GetCurrentProcessId(void) { return 1; }
static WINAPI void    *sh_GetCurrentProcess(void) { return (void *)-1; }
static WINAPI void    *sh_EncodePointer(void *p) { return p; }
static WINAPI void    *sh_DecodePointer(void *p) { return p; }
static WINAPI int      sh_IsProcessorFeaturePresent(uint32_t f) { (void)f; return 0; }
static WINAPI int      sh_IsDebuggerPresent(void) { return 0; }
static WINAPI void     sh_InitializeSListHead(void *p) { if (p) memset(p, 0, 16); }

/* Critical sections: a recursive no-op is correct for single-threaded bring-up
 * and cannot deadlock, which a stub that silently never locks also cannot. */
static WINAPI void sh_InitializeCriticalSection(void *p) { if (p) memset(p, 0, 40); }
static WINAPI int  sh_InitializeCriticalSectionAndSpinCount(void *p, uint32_t s)
{ (void)s; if (p) memset(p, 0, 40); return 1; }
static WINAPI int  sh_InitializeCriticalSectionEx(void *p, uint32_t s, uint32_t f)
{ (void)s; (void)f; if (p) memset(p, 0, 40); return 1; }
static WINAPI void sh_EnterCriticalSection(void *p) { (void)p; }
static WINAPI void sh_LeaveCriticalSection(void *p) { (void)p; }
static WINAPI void sh_DeleteCriticalSection(void *p) { (void)p; }
static WINAPI int  sh_TryEnterCriticalSection(void *p) { (void)p; return 1; }
static WINAPI void sh_InitializeSRWLock(void *p) { if (p) memset(p, 0, 8); }
static WINAPI void sh_AcquireSRWLockExclusive(void *p) { (void)p; }
static WINAPI void sh_ReleaseSRWLockExclusive(void *p) { (void)p; }

/* Tls and Fls slots on one flat table; bring-up is single-threaded. */
#define NSLOT 1088
static void    *g_slot[NSLOT];
static uint32_t g_nextslot = 1;
static WINAPI uint32_t sh_TlsAlloc(void) { return g_nextslot < NSLOT ? g_nextslot++ : 0xFFFFFFFF; }
static WINAPI void    *sh_TlsGetValue(uint32_t i) { return i < NSLOT ? g_slot[i] : NULL; }
static WINAPI int      sh_TlsSetValue(uint32_t i, void *v) { if (i < NSLOT) g_slot[i] = v; return 1; }
static WINAPI int      sh_TlsFree(uint32_t i) { (void)i; return 1; }
static WINAPI uint32_t sh_FlsAlloc(void *cb) { (void)cb; return sh_TlsAlloc(); }
static WINAPI void    *sh_FlsGetValue(uint32_t i) { return sh_TlsGetValue(i); }
static WINAPI int      sh_FlsSetValue(uint32_t i, void *v) { return sh_TlsSetValue(i, v); }
static WINAPI int      sh_FlsFree(uint32_t i) { (void)i; return 1; }

static WINAPI void sh_GetSystemTimeAsFileTime(uint64_t *ft) { if (ft) *ft = 0x01D000000000000ULL; }
static WINAPI int  sh_QueryPerformanceCounter(uint64_t *c)
{ static uint64_t t; if (c) *c = ++t; return 1; }
static WINAPI uint32_t sh_GetTickCount(void) { return 1; }
static WINAPI void *sh_GetModuleHandleW(const void *n) { (void)n; return (void *)0x10000; }
static WINAPI void *sh_GetModuleHandleA(const void *n) { (void)n; return (void *)0x10000; }
/* NVSDK_NGX_CUDA_Init (nvngx_dlisr.dll+0x614e0) calls this to identify its
 * caller's module, then string-checks the result for "nvngx.dll" and refuses
 * with 0xbad00002 ("Not called from nvngx.dll") otherwise. Returning 0 here
 * always took the earlier "unable to determine calling module" branch before
 * the name was ever compared -- confirmed by disasm and the rdata strings.
 * The path only needs to end in nvngx.dll; the DLL does not check it exists. */
static uint16_t g_fake_module_path[] = {
    'C', ':', '\\', 'n', 'v', 'n', 'g', 'x', '.', 'd', 'l', 'l', 0
};
static WINAPI uint32_t sh_GetModuleFileNameW(void *m, uint16_t *buf, uint32_t n)
{
    (void)m;
    uint32_t len = sizeof(g_fake_module_path) / sizeof(uint16_t) - 1;
    if (!buf || !n) return 0;
    uint32_t copy = len < n ? len : n - 1;
    memcpy(buf, g_fake_module_path, copy * sizeof(uint16_t));
    buf[copy] = 0;
    return copy;
}
static WINAPI void sh_GetStartupInfoW(void *si) { if (si) memset(si, 0, 104); }
static WINAPI void *sh_GetStdHandle(uint32_t n) { (void)n; return (void *)-11; }
static WINAPI void  sh_ExitProcess(uint32_t c) { fprintf(stderr, "  [dll called ExitProcess(%u)]\n", c); exit((int)c); }
static WINAPI void *sh_SetUnhandledExceptionFilter(void *f) { (void)f; return NULL; }
static WINAPI void  sh_RaiseException(uint32_t code, uint32_t f, uint32_t n, void *a)
{ (void)f; (void)n; (void)a; fprintf(stderr, "  [dll raised exception 0x%08x]\n", code); exit(9); }

/*
 * Second batch, chosen from what the first --run actually called rather than
 * from guesswork: the named trampolines reported LoadLibraryExW, GetFileType,
 * GetCommandLineA/W, GetACP, GetProcAddress and CreateEventW, in that order,
 * before the CRT gave up into its exception path. Returning 0 from these is
 * what made it give up -- a NULL command line or a code page of 0 is not a
 * value the CRT can start from.
 */
static char    g_cmdA[] = "rtxv";
static uint16_t g_cmdW[] = { 'r', 't', 'x', 'v', 0 };
static uint16_t g_envW[] = { 0, 0 };

static WINAPI void    *sh_LoadLibraryExW(const void *n, void *h, uint32_t f)
{ (void)n; (void)h; (void)f; return (void *)0x10000; }
static WINAPI void    *sh_LoadLibraryExA(const void *n, void *h, uint32_t f)
{ (void)n; (void)h; (void)f; return (void *)0x10000; }
static WINAPI int      sh_FreeLibrary(void *h) { (void)h; return 1; }
static WINAPI uint32_t sh_GetFileType(void *h) { (void)h; return 2; }  /* FILE_TYPE_CHAR */
/* No real filesystem behind this loader. Fail cleanly rather than falling
 * through the generic arg-blind stub, which left *lpNumberOfBytesRead
 * untouched (garbage) on a call whose real args we never forwarded --
 * that produced a Trace/breakpoint trap downstream once ISR CreateFeature
 * started reading a resource. */
static WINAPI int sh_ReadFile(void *h, void *buf, uint32_t n, uint32_t *read, void *ov)
{ (void)h; (void)buf; (void)n; (void)ov; if (read) *read = 0; sh_SetLastError(2 /* ERROR_FILE_NOT_FOUND */); return 0; }
static WINAPI void *sh_CreateFileW(const void *n, uint32_t a, uint32_t s, void *sa, uint32_t d, uint32_t f, void *t)
{ (void)n; (void)a; (void)s; (void)sa; (void)d; (void)f; (void)t; sh_SetLastError(2); return (void *)-1; }
static WINAPI char    *sh_GetCommandLineA(void) { return g_cmdA; }
static WINAPI uint16_t *sh_GetCommandLineW(void) { return g_cmdW; }
static WINAPI uint32_t sh_GetACP(void) { return 1252; }
static WINAPI uint32_t sh_GetOEMCP(void) { return 437; }
static WINAPI int      sh_IsValidCodePage(uint32_t cp) { (void)cp; return 1; }
static WINAPI int      sh_GetCPInfo(uint32_t cp, void *info)
{ (void)cp; if (info) { memset(info, 0, 20); *(uint32_t *)info = 1; } return 1; }
static WINAPI void    *sh_CreateEventW(void *a, int b, int c, const void *d)
{ (void)a; (void)b; (void)c; (void)d; return (void *)0x2000; }
static WINAPI int      sh_SetEvent(void *h) { (void)h; return 1; }
static WINAPI int      sh_ResetEvent(void *h) { (void)h; return 1; }
static WINAPI uint32_t sh_WaitForSingleObjectEx(void *h, uint32_t ms, int a)
{ (void)h; (void)ms; (void)a; return 0; }
static WINAPI int      sh_CloseHandle(void *h) { (void)h; return 1; }
static WINAPI uint16_t *sh_GetEnvironmentStringsW(void) { return g_envW; }
static WINAPI int      sh_FreeEnvironmentStringsW(void *p) { (void)p; return 1; }
static WINAPI uint32_t sh_GetEnvironmentVariableA(const void *n, void *b, uint32_t c)
{ (void)n; (void)b; (void)c; return 0; }
static WINAPI int      sh_SetEnvironmentVariableW(const void *n, const void *v)
{ (void)n; (void)v; return 1; }
static WINAPI uint32_t sh_GetUserDefaultLCID(void) { return 0x409; }
static WINAPI int      sh_IsValidLocale(uint32_t l, uint32_t f) { (void)l; (void)f; return 1; }
static WINAPI int      sh_EnumSystemLocalesW(void *cb, uint32_t f) { (void)cb; (void)f; return 1; }
static WINAPI int      sh_GetLocaleInfoW(uint32_t l, uint32_t t, uint16_t *b, int n)
{ (void)l; (void)t; if (b && n) b[0] = 0; return 0; }
static WINAPI int      sh_GetStringTypeW(uint32_t t, const uint16_t *s, int n, uint16_t *out)
{ (void)t; (void)s; if (out) for (int i = 0; i < n; i++) out[i] = 0; return 1; }
static WINAPI int      sh_CompareStringW(uint32_t l, uint32_t f, const uint16_t *a, int na,
                                         const uint16_t *b, int nb)
{ (void)l; (void)f; (void)a; (void)na; (void)b; (void)nb; return 2; }  /* CSTR_EQUAL */

/* Just enough of the ANSI<->wide pair for CRT locale setup: this bring-up is
 * ASCII-only and never sees a non-Latin path. */
static WINAPI int sh_MultiByteToWideChar(uint32_t cp, uint32_t f, const char *in, int nin,
                                         uint16_t *out, int nout)
{
    (void)cp; (void)f;
    if (nin < 0) nin = in ? (int)strlen(in) + 1 : 0;
    if (!out || !nout) return nin;
    int n = nin < nout ? nin : nout;
    for (int i = 0; i < n; i++) out[i] = (unsigned char)in[i];
    return n;
}
static WINAPI int sh_WideCharToMultiByte(uint32_t cp, uint32_t f, const uint16_t *in, int nin,
                                         char *out, int nout, const void *d, void *u)
{
    (void)cp; (void)f; (void)d; (void)u;
    if (nin < 0) { nin = 0; if (in) while (in[nin]) nin++; nin++; }
    if (!out || !nout) return nin;
    int n = nin < nout ? nin : nout;
    for (int i = 0; i < n; i++) out[i] = in[i] < 256 ? (char)in[i] : '?';
    return n;
}
static WINAPI int sh_LCMapStringW(uint32_t l, uint32_t f, const uint16_t *s, int n,
                                  uint16_t *d, int nd)
{
    (void)l; (void)f;
    if (n < 0) { n = 0; if (s) while (s[n]) n++; n++; }
    if (!d || !nd) return n;
    int c = n < nd ? n : nd;
    memcpy(d, s, (size_t)c * 2);
    return c;
}
static WINAPI int sh_LCMapStringEx(const void *loc, uint32_t f, const uint16_t *s, int n,
                                   uint16_t *d, int nd, void *a, void *b, intptr_t c)
{ (void)loc; (void)a; (void)b; (void)c; return sh_LCMapStringW(0, f, s, n, d, nd); }

static WINAPI int sh_WriteFile(void *h, const void *buf, uint32_t n, uint32_t *wrote, void *ov)
{ (void)h; (void)buf; (void)ov; if (wrote) *wrote = n; return 1; }
static WINAPI int sh_WriteConsoleW(void *h, const void *buf, uint32_t n, uint32_t *wrote, void *r)
{ (void)h; (void)buf; (void)r; if (wrote) *wrote = n; return 1; }
static WINAPI int sh_GetConsoleMode(void *h, uint32_t *m) { (void)h; if (m) *m = 0; return 0; }
static WINAPI int sh_TerminateProcess(void *h, uint32_t c)
{ (void)h; fprintf(stderr, "  [dll called TerminateProcess(%u)]\n", c); exit((int)c); }
static WINAPI uint32_t sh_UnhandledExceptionFilter(void *info)
{
    (void)info;
    fprintf(stderr, "  [UnhandledExceptionFilter reached -- the DLL threw and nothing caught it]\n");
    return 0;  /* EXCEPTION_CONTINUE_SEARCH */
}

/* GetProcAddress has to search our own table: the CRT probes for optional APIs
 * by name and adapts to what it finds, so handing back 0 for everything is a
 * statement that the OS has no API at all. */
static void *shim_lookup(const char *name);
static void *cuda_sym(const char *name);
static WINAPI void *sh_GetProcAddress(void *mod, const char *name)
{
    (void)mod;
    if (!name || ((uintptr_t)name >> 16) == 0)   /* by ordinal */
        return NULL;
    void *p = shim_lookup(name);
    if (!p && !strncmp(name, "cu", 2)) {
        /* Not just cuGetProcAddress itself: CreateFeature also probes for
         * plain driver-API names (cuInit, cuDeviceGet, ...) through
         * GetProcAddress directly, same as it does through the resolver it
         * gets back from cuGetProcAddress. Route both the same way real
         * libcuda would answer them. */
        p = cuda_sym(name);
        if (p)
            fprintf(stderr, "  [GetProcAddress -> real libcuda: %s]\n", name);
    }
    if (!p)
        fprintf(stderr, "  [GetProcAddress miss: %s]\n", name);
    return p;
}

/*
 * Third batch, from what NVSDK_NGX_CUDA_Init called before returning
 * FAIL_PlatformError.
 *
 * One of these is a trap in the default stub rather than a missing feature.
 * Win32 is not consistent about what 0 means: for a BOOL-returning function it
 * is failure, but for the Reg* family it is ERROR_SUCCESS. So a stub returning
 * 0 told the DLL that RegOpenKeyExW had succeeded, after which it read a key
 * that was never opened and trusted whatever came back. These return
 * ERROR_FILE_NOT_FOUND so the snippet takes its own default path, which is the
 * honest answer: there is no registry here.
 */
#define ERROR_FILE_NOT_FOUND 2

static WINAPI int32_t sh_RegOpenKeyExW(void *k, const void *sub, uint32_t o, uint32_t sam, void **out)
{ (void)k; (void)sub; (void)o; (void)sam; if (out) *out = NULL; return ERROR_FILE_NOT_FOUND; }
static WINAPI int32_t sh_RegQueryValueExW(void *k, const void *n, uint32_t *r, uint32_t *t,
                                          void *data, uint32_t *cb)
{ (void)k; (void)n; (void)r; (void)t; (void)data; (void)cb; return ERROR_FILE_NOT_FOUND; }
static WINAPI int32_t sh_RegCloseKey(void *k) { (void)k; return 0; }

/* The snippet gates itself on an OS version check. There is no Windows here to
 * report, and saying "version too old" is a guaranteed PlatformError, so the
 * answer that lets it proceed is the one that is also true of the environment
 * we are emulating: new enough. */
static WINAPI uint64_t sh_VerSetConditionMask(uint64_t mask, uint32_t type, uint8_t cond)
{ (void)type; (void)cond; return mask; }
static WINAPI int      sh_VerifyVersionInfoW(void *vi, uint32_t type, uint64_t mask)
{ (void)vi; (void)type; (void)mask; return 1; }

static WINAPI void    *sh_LocalAlloc(uint32_t f, size_t n)
{ void *p = malloc(n ? n : 1); if (p && (f & 0x40)) memset(p, 0, n); return p; }
static WINAPI void    *sh_LocalFree(void *p) { free(p); return NULL; }
static WINAPI uint32_t sh_GetSystemDirectoryW(uint16_t *buf, uint32_t n)
{
    static const char s[] = "C:\\Windows\\System32";
    uint32_t len = (uint32_t)strlen(s);
    if (buf && n > len) { for (uint32_t i = 0; i <= len; i++) buf[i] = (unsigned char)s[i]; return len; }
    return len + 1;
}
static WINAPI uint32_t sh_GetModuleFileNameA(void *m, char *buf, uint32_t n)
{
    static const char s[] = "C:\\rtxv\\rtxv.exe";
    (void)m;
    uint32_t len = (uint32_t)strlen(s);
    if (buf && n > len) { memcpy(buf, s, len + 1); return len; }
    return 0;
}
static WINAPI int sh_GetModuleHandleExA(uint32_t f, const void *n, void **out)
{ (void)f; (void)n; if (out) *out = (void *)0x10000; return 1; }
static WINAPI int sh_GetModuleHandleExW(uint32_t f, const void *n, void **out)
{ (void)f; (void)n; if (out) *out = (void *)0x10000; return 1; }
static WINAPI uint32_t sh_GetFullPathNameW(const uint16_t *in, uint32_t n, uint16_t *out, uint16_t **part)
{
    (void)in;
    if (part) *part = NULL;
    if (out && n) out[0] = 0;
    return 0;
}

/*
 * Fourth batch: the 31 imports nvaivpx.dll (AIVP / RTX VSR) needs that ISR
 * never touched -- apiset-named (api-ms-win-core-*) KERNEL32/USER32 surface
 * plus USER32 itself. No real Windows filesystem/registry/console/window
 * exists here, so these follow the project's established honesty rule: return
 * the true answer for the environment we are ("no window has focus", "no
 * token", "no files") rather than a fabricated success that would let the
 * caller trust state that was never set up. Not yet confirmed any of these
 * are on AIVP's actual init path -- unlike ISR, this DLL has not been run yet.
 */
static WINAPI void sh_OutputDebugStringW(const uint16_t *s) { (void)s; }
static WINAPI void sh_OutputDebugStringA(const char *s) { (void)s; }
static WINAPI int  sh_SetStdHandle(uint32_t n, void *h) { (void)n; (void)h; return 1; }
static WINAPI int  sh_QueryPerformanceFrequency(uint64_t *f)
{ if (f) *f = 10000000ULL; /* QPC's usual 100ns tick, matches sh_QueryPerformanceCounter's fake counter */ return 1; }

/* No real access token exists. Fail honestly rather than hand back a token
 * object nothing populated -- same reasoning as sh_RegOpenKeyExW. */
#define ERROR_NO_TOKEN 1008
static WINAPI int   sh_OpenProcessToken(void *proc, uint32_t access, void **tok)
{ (void)proc; (void)access; if (tok) *tok = NULL; sh_SetLastError(ERROR_NO_TOKEN); return 0; }
static WINAPI void *sh_GetCurrentThread(void) { return (void *)(intptr_t)-2; }  /* real pseudo-handle value */
static WINAPI int   sh_IsValidSid(void *sid) { (void)sid; return 0; }
static WINAPI int   sh_GetTokenInformation(void *tok, uint32_t cls, void *buf, uint32_t n, uint32_t *ret)
{ (void)tok; (void)cls; (void)buf; (void)n; if (ret) *ret = 0; sh_SetLastError(ERROR_NO_TOKEN); return 0; }
static WINAPI int   sh_ConvertSidToStringSidW(void *sid, uint16_t **out)
{ (void)sid; if (out) *out = NULL; return 0; }

/*
 * SEH/unwind machinery (Rtl*). This loader runs the DLL's normal-path code
 * only -- nothing here generates or catches a real Windows exception, so
 * these are stubbed inert rather than modeled. If a real capture run ever
 * shows one of these actually taken (not just imported), it needs a real
 * implementation, not this stub -- flagged, not solved.
 */
static WINAPI void *sh_RtlPcToFileHeader(void *pc, void **base) { (void)pc; if (base) *base = NULL; return NULL; }
static WINAPI void *sh_RtlLookupFunctionEntry(uint64_t pc, uint64_t *imgbase, void *hist)
{ (void)pc; (void)hist; if (imgbase) *imgbase = 0; return NULL; }
static WINAPI void  sh_RtlUnwind(void *target, void *handler, void *rec, void *retval)
{ (void)target; (void)handler; (void)rec; (void)retval; }
static WINAPI void  sh_RtlCaptureContext(void *ctx) { if (ctx) memset(ctx, 0, 1232); }  /* sizeof(CONTEXT) on x64 */
static WINAPI void  sh_RtlUnwindEx(void *target, void *handler, void *rec, void *retval, void *ctx)
{ (void)target; (void)handler; (void)rec; (void)retval; (void)ctx; }
static WINAPI void *sh_RtlVirtualUnwind(uint32_t htype, uint64_t imgbase, uint64_t pc, void *fe,
                                        void *ctx, void **hdata, uint64_t *frame, void *ctxptrs)
{ (void)htype; (void)imgbase; (void)pc; (void)fe; (void)ctx; (void)frame; (void)ctxptrs;
  if (hdata) *hdata = NULL; return NULL; }

/* SLIST primitives: InitializeSListHead already zeros the header (a no-op
 * empty list). Push/flush follow the same "list stays empty" model rather
 * than implementing the real lock-free layout, which is opaque/undocumented
 * and not worth reversing unless a capture shows it actually matters. */
static WINAPI void *sh_InterlockedFlushSList(void *head) { (void)head; return NULL; }
static WINAPI void *sh_InterlockedPushEntrySList(void *head, void *entry) { (void)head; (void)entry; return NULL; }

static WINAPI uint32_t sh_GetTempPathW(uint32_t n, uint16_t *buf)
{
    static const char s[] = "C:\\Temp\\";
    uint32_t len = (uint32_t)strlen(s);
    if (buf && n > len) { for (uint32_t i = 0; i <= len; i++) buf[i] = (unsigned char)s[i]; return len; }
    return len + 1;
}
static WINAPI int sh_GetTimeFormatW(uint32_t lcid, uint32_t f, const void *t, const uint16_t *fmt,
                                    uint16_t *buf, int n)
{
    (void)lcid; (void)f; (void)t; (void)fmt;
    static const char s[] = "00:00:00";
    uint32_t len = (uint32_t)strlen(s);
    if (!buf || !n) return (int)len + 1;
    uint32_t c = len < (uint32_t)n - 1 ? len : (uint32_t)n - 1;
    for (uint32_t i = 0; i <= c; i++) buf[i] = (unsigned char)s[i];
    return (int)c + 1;
}
static WINAPI int sh_GetDateFormatW(uint32_t lcid, uint32_t f, const void *t, const uint16_t *fmt,
                                    uint16_t *buf, int n)
{
    (void)lcid; (void)f; (void)t; (void)fmt;
    static const char s[] = "01/01/2026";
    uint32_t len = (uint32_t)strlen(s);
    if (!buf || !n) return (int)len + 1;
    uint32_t c = len < (uint32_t)n - 1 ? len : (uint32_t)n - 1;
    for (uint32_t i = 0; i <= c; i++) buf[i] = (unsigned char)s[i];
    return (int)c + 1;
}

/* No real filesystem -- CreateFileW already always fails with
 * ERROR_FILE_NOT_FOUND, so every handle-consuming call here fails the same
 * honest way rather than pretending a file was ever open. */
#define ERROR_NO_MORE_FILES 18
static WINAPI int  sh_FindClose(void *h) { (void)h; return 1; }
static WINAPI int  sh_SetFilePointerEx(void *h, int64_t dist, int64_t *newp, uint32_t method)
{ (void)h; (void)dist; (void)method; if (newp) *newp = 0; sh_SetLastError(ERROR_FILE_NOT_FOUND); return 0; }
static WINAPI void *sh_FindFirstFileExW(const void *pat, uint32_t lvl, void *data, uint32_t search,
                                        void *filter, uint32_t flags)
{ (void)pat; (void)lvl; (void)data; (void)search; (void)filter; (void)flags;
  sh_SetLastError(ERROR_FILE_NOT_FOUND); return (void *)(intptr_t)-1; }
static WINAPI int  sh_GetFileSizeEx(void *h, int64_t *size)
{ (void)h; if (size) *size = 0; sh_SetLastError(ERROR_FILE_NOT_FOUND); return 0; }
static WINAPI int  sh_FindNextFileW(void *h, void *data)
{ (void)h; (void)data; sh_SetLastError(ERROR_NO_MORE_FILES); return 0; }
static WINAPI int  sh_FlushFileBuffers(void *h) { (void)h; return 1; }

/* Console I/O: GetStdHandle hands back a pseudo-handle, not a real console --
 * ReadConsoleW answers with zero characters (EOF-like) instead of blocking. */
static WINAPI int  sh_ReadConsoleW(void *h, void *buf, uint32_t n, uint32_t *read, void *ctrl)
{ (void)h; (void)buf; (void)n; (void)ctrl; if (read) *read = 0; return 1; }
static WINAPI int  sh_SetConsoleCtrlHandler(void *handler, int add) { (void)handler; (void)add; return 1; }
static WINAPI uint32_t sh_GetConsoleOutputCP(void) { return 437; }

/* USER32: no real window ever exists here, so the honest answer for both is
 * "no window" -- 0 (invalid HWND) for the thread/process lookup, NULL for the
 * foreground window query, both legitimate real-Windows answers on a
 * windowless/headless desktop. */
static WINAPI uint32_t sh_GetWindowThreadProcessId(void *hwnd, uint32_t *pid)
{ (void)hwnd; if (pid) *pid = 0; return 0; }
static WINAPI void *sh_GetForegroundWindow(void) { return NULL; }

struct shim { const char *name; void *fn; };
static const struct shim g_shims[] = {
    { "RegOpenKeyExW", sh_RegOpenKeyExW }, { "RegQueryValueExW", sh_RegQueryValueExW },
    { "RegCloseKey", sh_RegCloseKey },
    { "VerSetConditionMask", sh_VerSetConditionMask },
    { "VerifyVersionInfoW", sh_VerifyVersionInfoW },
    { "LocalAlloc", sh_LocalAlloc }, { "LocalFree", sh_LocalFree },
    { "GetSystemDirectoryW", sh_GetSystemDirectoryW },
    { "GetModuleFileNameA", sh_GetModuleFileNameA },
    { "GetModuleHandleExA", sh_GetModuleHandleExA },
    { "GetModuleHandleExW", sh_GetModuleHandleExW },
    { "GetFullPathNameW", sh_GetFullPathNameW },
    { "LoadLibraryExW", sh_LoadLibraryExW }, { "LoadLibraryExA", sh_LoadLibraryExA },
    { "FreeLibrary", sh_FreeLibrary }, { "GetFileType", sh_GetFileType },
    { "ReadFile", sh_ReadFile }, { "CreateFileW", sh_CreateFileW },
    { "GetCommandLineA", sh_GetCommandLineA }, { "GetCommandLineW", sh_GetCommandLineW },
    { "GetACP", sh_GetACP }, { "GetOEMCP", sh_GetOEMCP },
    { "IsValidCodePage", sh_IsValidCodePage }, { "GetCPInfo", sh_GetCPInfo },
    { "GetProcAddress", sh_GetProcAddress },
    { "CreateEventW", sh_CreateEventW }, { "SetEvent", sh_SetEvent },
    { "ResetEvent", sh_ResetEvent }, { "WaitForSingleObjectEx", sh_WaitForSingleObjectEx },
    { "CloseHandle", sh_CloseHandle },
    { "GetEnvironmentStringsW", sh_GetEnvironmentStringsW },
    { "FreeEnvironmentStringsW", sh_FreeEnvironmentStringsW },
    { "GetEnvironmentVariableA", sh_GetEnvironmentVariableA },
    { "SetEnvironmentVariableW", sh_SetEnvironmentVariableW },
    { "GetUserDefaultLCID", sh_GetUserDefaultLCID }, { "IsValidLocale", sh_IsValidLocale },
    { "EnumSystemLocalesW", sh_EnumSystemLocalesW }, { "GetLocaleInfoW", sh_GetLocaleInfoW },
    { "GetStringTypeW", sh_GetStringTypeW }, { "CompareStringW", sh_CompareStringW },
    { "MultiByteToWideChar", sh_MultiByteToWideChar },
    { "WideCharToMultiByte", sh_WideCharToMultiByte },
    { "LCMapStringW", sh_LCMapStringW }, { "LCMapStringEx", sh_LCMapStringEx },
    { "WriteFile", sh_WriteFile }, { "WriteConsoleW", sh_WriteConsoleW },
    { "GetConsoleMode", sh_GetConsoleMode },
    { "TerminateProcess", sh_TerminateProcess },
    { "UnhandledExceptionFilter", sh_UnhandledExceptionFilter },
    { "GetLastError", sh_GetLastError }, { "SetLastError", sh_SetLastError },
    { "GetProcessHeap", sh_GetProcessHeap }, { "HeapCreate", sh_HeapCreate },
    { "HeapDestroy", sh_HeapDestroy }, { "HeapAlloc", sh_HeapAlloc },
    { "HeapFree", sh_HeapFree }, { "HeapReAlloc", sh_HeapReAlloc },
    { "HeapSize", sh_HeapSize },
    { "GetCurrentThreadId", sh_GetCurrentThreadId },
    { "GetCurrentProcessId", sh_GetCurrentProcessId },
    { "GetCurrentProcess", sh_GetCurrentProcess },
    { "EncodePointer", sh_EncodePointer }, { "DecodePointer", sh_DecodePointer },
    { "IsProcessorFeaturePresent", sh_IsProcessorFeaturePresent },
    { "IsDebuggerPresent", sh_IsDebuggerPresent },
    { "InitializeSListHead", sh_InitializeSListHead },
    { "InitializeCriticalSection", sh_InitializeCriticalSection },
    { "InitializeCriticalSectionAndSpinCount", sh_InitializeCriticalSectionAndSpinCount },
    { "InitializeCriticalSectionEx", sh_InitializeCriticalSectionEx },
    { "EnterCriticalSection", sh_EnterCriticalSection },
    { "LeaveCriticalSection", sh_LeaveCriticalSection },
    { "DeleteCriticalSection", sh_DeleteCriticalSection },
    { "TryEnterCriticalSection", sh_TryEnterCriticalSection },
    { "InitializeSRWLock", sh_InitializeSRWLock },
    { "AcquireSRWLockExclusive", sh_AcquireSRWLockExclusive },
    { "ReleaseSRWLockExclusive", sh_ReleaseSRWLockExclusive },
    { "TlsAlloc", sh_TlsAlloc }, { "TlsGetValue", sh_TlsGetValue },
    { "TlsSetValue", sh_TlsSetValue }, { "TlsFree", sh_TlsFree },
    { "FlsAlloc", sh_FlsAlloc }, { "FlsGetValue", sh_FlsGetValue },
    { "FlsSetValue", sh_FlsSetValue }, { "FlsFree", sh_FlsFree },
    { "GetSystemTimeAsFileTime", sh_GetSystemTimeAsFileTime },
    { "QueryPerformanceCounter", sh_QueryPerformanceCounter },
    { "GetTickCount", sh_GetTickCount },
    { "GetModuleHandleW", sh_GetModuleHandleW },
    { "GetModuleHandleA", sh_GetModuleHandleA },
    { "GetModuleFileNameW", sh_GetModuleFileNameW },
    { "GetStartupInfoW", sh_GetStartupInfoW },
    { "GetStdHandle", sh_GetStdHandle },
    { "ExitProcess", sh_ExitProcess },
    { "SetUnhandledExceptionFilter", sh_SetUnhandledExceptionFilter },
    { "RaiseException", sh_RaiseException },
    { "OutputDebugStringW", sh_OutputDebugStringW }, { "OutputDebugStringA", sh_OutputDebugStringA },
    { "SetStdHandle", sh_SetStdHandle },
    { "QueryPerformanceFrequency", sh_QueryPerformanceFrequency },
    { "OpenProcessToken", sh_OpenProcessToken }, { "GetCurrentThread", sh_GetCurrentThread },
    { "IsValidSid", sh_IsValidSid }, { "GetTokenInformation", sh_GetTokenInformation },
    { "ConvertSidToStringSidW", sh_ConvertSidToStringSidW },
    { "RtlPcToFileHeader", sh_RtlPcToFileHeader },
    { "RtlLookupFunctionEntry", sh_RtlLookupFunctionEntry },
    { "RtlUnwind", sh_RtlUnwind }, { "RtlCaptureContext", sh_RtlCaptureContext },
    { "RtlUnwindEx", sh_RtlUnwindEx }, { "RtlVirtualUnwind", sh_RtlVirtualUnwind },
    { "InterlockedFlushSList", sh_InterlockedFlushSList },
    { "InterlockedPushEntrySList", sh_InterlockedPushEntrySList },
    { "GetTempPathW", sh_GetTempPathW },
    { "GetTimeFormatW", sh_GetTimeFormatW }, { "GetDateFormatW", sh_GetDateFormatW },
    { "FindClose", sh_FindClose }, { "SetFilePointerEx", sh_SetFilePointerEx },
    { "FindFirstFileExW", sh_FindFirstFileExW }, { "GetFileSizeEx", sh_GetFileSizeEx },
    { "FindNextFileW", sh_FindNextFileW }, { "FlushFileBuffers", sh_FlushFileBuffers },
    { "ReadConsoleW", sh_ReadConsoleW },
    { "SetConsoleCtrlHandler", sh_SetConsoleCtrlHandler },
    { "GetConsoleOutputCP", sh_GetConsoleOutputCP },
    { "GetWindowThreadProcessId", sh_GetWindowThreadProcessId },
    { "GetForegroundWindow", sh_GetForegroundWindow },
    { NULL, NULL }
};

static void *shim_lookup(const char *name)
{
    for (const struct shim *s = g_shims; s->name; s++)
        if (!strcmp(s->name, name))
            return s->fn;
    return NULL;
}

static void *cuda_sym(const char *name)
{
    static void *h;
    if (!h)
        h = dlopen("libcuda.so.1", RTLD_NOW | RTLD_GLOBAL);
    return h ? dlsym(h, name) : NULL;
}

/* CreateFeature does not use nvcuda.dll's *static* imports for the CUDA
 * driver surface -- it calls the dynamic resolver cuGetProcAddress itself,
 * once, then walks ~440 more symbols through the pointer that call returns.
 * shim_lookup() never saw those names (they never appear in an import
 * table), so every one of them silently came back NULL, which is what
 * actually drove CreateFeature into its own fail path -- not a missing
 * cudaGetDevice/cudaSetDevice call as first suspected. Handing the DLL the
 * real libcuda cuGetProcAddress makes every downstream symbol it asks for
 * resolve through the driver's own logic, no per-symbol shim needed. */

static void *resolve(Image *im, const char *dll, const char *sym)
{
    /* nvcuda goes to the host's real libcuda, so under the rtxv interposer the
     * DLL's own launches are captured exactly as a native caller's would be --
     * which is the whole reason the loader exists. */
    if (!strcasecmp(dll, "nvcuda.dll")) {
        void *p = cuda_sym(sym);
        if (p) { im->nresolved++; return p; }
    }
    for (const struct shim *s = g_shims; s->name; s++) {
        if (!strcmp(s->name, sym)) { im->nresolved++; return s->fn; }
    }
    im->nstubbed++;
    int idx = g_impcount < MAX_IMPORTS ? g_impcount++ : MAX_IMPORTS - 1;
    g_impname[idx] = strdup(sym);
    if (g_verbose)
        fprintf(stderr, "  stub: %s!%s\n", dll, sym);
    return make_tramp(idx);
}

/* ------------------------------------------------------------------ */

static int map_image(Image *im, const char *path)
{
    int fd = open(path, O_RDONLY);
    if (fd < 0) { perror(path); return -1; }
    struct stat st;
    fstat(fd, &st);
    uint8_t *file = mmap(NULL, st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
    close(fd);
    if (file == MAP_FAILED) { perror("mmap file"); return -1; }

    if (rd16(file) != 0x5A4D) { fprintf(stderr, "not MZ\n"); return -1; }
    uint32_t peo = rd32(file + 0x3C);
    if (memcmp(file + peo, "PE\0\0", 4)) { fprintf(stderr, "no PE sig\n"); return -1; }

    uint32_t coff = peo + 4;
    uint16_t nsec = rd16(file + coff + 2);
    uint16_t optsz = rd16(file + coff + 16);
    uint32_t opt = coff + 20;
    if (rd16(file + opt) != 0x20B) { fprintf(stderr, "not PE32+\n"); return -1; }

    im->entry_rva  = rd32(file + opt + 16);
    im->image_base = rd64(file + opt + 24);
    im->size       = rd32(file + opt + 56);

    uint32_t ndirs = rd32(file + opt + 108);
    for (uint32_t i = 0; i < ndirs && i < 16; i++) {
        im->dir_rva[i]  = rd32(file + opt + 112 + 8 * i);
        im->dir_size[i] = rd32(file + opt + 112 + 8 * i + 4);
    }

    im->base = mmap(NULL, im->size, PROT_READ | PROT_WRITE | PROT_EXEC,
                    MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (im->base == MAP_FAILED) { perror("mmap image"); return -1; }

    uint32_t sbase = opt + optsz;
    for (uint16_t i = 0; i < nsec; i++) {
        const uint8_t *s = file + sbase + 40 * i;
        uint32_t vaddr = rd32(s + 12), rawsz = rd32(s + 16), rawoff = rd32(s + 20);
        if (rawsz && (uint64_t)vaddr + rawsz <= im->size)
            memcpy(im->base + vaddr, file + rawoff, rawsz);
    }

    int64_t delta = (int64_t)((uint64_t)im->base - im->image_base);
    uint32_t rr = im->dir_rva[DIR_BASERELOC], rsz = im->dir_size[DIR_BASERELOC];
    uint32_t done = 0, nrel = 0;
    while (rr && done < rsz) {
        uint8_t *blk = im->base + rr + done;
        uint32_t page = rd32(blk), blksz = rd32(blk + 4);
        if (blksz < 8) break;
        for (uint32_t o = 8; o < blksz; o += 2) {
            uint16_t e = rd16(blk + o);
            if ((e >> 12) == 10) {
                uint8_t *t = im->base + page + (e & 0xFFF);
                uint64_t v = rd64(t) + delta;
                memcpy(t, &v, 8);
                nrel++;
            }
        }
        done += blksz;
    }

    uint32_t ir = im->dir_rva[DIR_IMPORT];
    for (uint8_t *d = im->base + ir; ir && rd32(d + 12); d += 20) {
        const char *dll = (const char *)(im->base + rd32(d + 12));
        uint32_t oft = rd32(d + 0), ft = rd32(d + 16);
        uint64_t *lookup = (uint64_t *)(im->base + (oft ? oft : ft));
        uint64_t *addr   = (uint64_t *)(im->base + ft);
        for (int i = 0; lookup[i]; i++) {
            uint64_t v = lookup[i];
            const char *sym = (v & (1ULL << 63))
                              ? "#ordinal"
                              : (const char *)(im->base + (v & 0x7FFFFFFF) + 2);
            addr[i] = (uint64_t)resolve(im, dll, sym);
        }
    }

    printf("mapped %s\n", path);
    printf("  preferred base 0x%llx -> actual %p (delta %+lld)\n",
           (unsigned long long)im->image_base, im->base, (long long)delta);
    printf("  image size %zu, %u relocations applied\n", im->size, nrel);
    printf("  imports: %d resolved, %d stubbed\n", im->nresolved, im->nstubbed);
    printf("  TLS directory: %s\n", im->dir_rva[DIR_TLS] ? "present" : "none");
    return 0;
}

static void *find_export(Image *im, const char *want)
{
    uint32_t er = im->dir_rva[DIR_EXPORT];
    if (!er) return NULL;
    uint8_t *e = im->base + er;
    uint32_t n = rd32(e + 0x18);
    uint32_t funcs = rd32(e + 0x1C), names = rd32(e + 0x20), ords = rd32(e + 0x24);
    for (uint32_t i = 0; i < n; i++) {
        const char *nm = (const char *)(im->base + rd32(im->base + names + 4 * i));
        if (!strcmp(nm, want)) {
            uint16_t idx = rd16(im->base + ords + 2 * i);
            return im->base + rd32(im->base + funcs + 4 * idx);
        }
    }
    return NULL;
}

/* Needs Image, WINAPI, find_export and cuda_sym, so it is included here rather
 * than compiled separately. */
#include "gu_vsr_ngx_isr.c"
#include "gu_vsr_aivp_loader.c"

/* ------------------------------------------------------------------ *
 * TEB, PE TLS, and entry.
 * ------------------------------------------------------------------ */

static uint8_t *g_teb;

static int setup_teb(void)
{
    g_teb = calloc(1, 8192);
    uint8_t *peb = calloc(1, 4096);
    if (!g_teb || !peb) return -1;

    /* Stack bounds: __chkstk probes these on any large frame. Generous and
     * wrong-but-safe beats absent -- an unset StackLimit reads as 0 and every
     * probe then looks like an overflow. */
    uintptr_t sp = (uintptr_t)&peb;
    uint64_t stack_base  = (sp + (1u << 20)) & ~0xFFFULL;
    uint64_t stack_limit = (sp - (8u << 20)) & ~0xFFFULL;

    memcpy(g_teb + 0x08, &stack_base, 8);
    memcpy(g_teb + 0x10, &stack_limit, 8);
    uint64_t self = (uint64_t)g_teb;
    memcpy(g_teb + 0x30, &self, 8);
    uint64_t pebv = (uint64_t)peb;
    memcpy(g_teb + 0x60, &pebv, 8);

    if (syscall(SYS_arch_prctl, ARCH_SET_GS, (unsigned long)g_teb) != 0) {
        perror("arch_prctl(ARCH_SET_GS)");
        return -1;
    }
    uint64_t back = 0;
    __asm__ volatile("movq %%gs:0x30, %0" : "=r"(back));
    if (back != self) { fprintf(stderr, "TEB self readback mismatch\n"); return -1; }
    return 0;
}

static int setup_pe_tls(Image *im)
{
    uint32_t tr = im->dir_rva[DIR_TLS];
    if (!tr) return 0;

    uint8_t *t = im->base + tr;
    /* These are virtual addresses, and relocations have already been applied,
     * so they point into our mapping rather than at the preferred base. */
    uint64_t raw_start = rd64(t + 0x00), raw_end = rd64(t + 0x08);
    uint64_t idx_addr  = rd64(t + 0x10), cb_addr = rd64(t + 0x18);
    uint32_t zerofill  = rd32(t + 0x20);

    size_t tpl = (raw_end > raw_start) ? (size_t)(raw_end - raw_start) : 0;
    size_t total = tpl + zerofill + 64;
    uint8_t *block = calloc(1, total);
    if (!block) return -1;
    if (tpl)
        memcpy(block, (const void *)raw_start, tpl);

    static void *tls_array[128];
    tls_array[0] = block;
    uint64_t arr = (uint64_t)tls_array;
    memcpy(g_teb + 0x58, &arr, 8);   /* TEB.ThreadLocalStoragePointer */

    if (idx_addr)
        *(uint32_t *)idx_addr = 0;   /* we hand it slot 0 */

    printf("  PE TLS: template %zu + zerofill %u bytes, slot 0\n", tpl, zerofill);

    int ncb = 0;
    if (cb_addr) {
        uint64_t *cb = (uint64_t *)cb_addr;
        for (int i = 0; cb[i]; i++) {
            WINAPI void (*f)(void *, uint32_t, void *) = (void *)cb[i];
            f(im->base, DLL_PROCESS_ATTACH, NULL);
            ncb++;
        }
    }
    if (ncb)
        printf("  PE TLS: ran %d callback(s)\n", ncb);
    return 0;
}

#ifndef PE_MAP_NO_MAIN   /* vf_aivp_spike.c includes this file as a library */
int main(int argc, char **argv)
{
    if (argc < 2) {
        fprintf(stderr, "usage: pe_map <file.dll> [--run] [--export NAME] [-v]\n");
        return 1;
    }
    const char *path = argv[1], *want_export = NULL;
    int run = 0, want_aivp = 0, want_dlpp = 0, want_dlpp_scan = 0, g_isr_w = 0, g_isr_h = 0, g_isr_scale = 2;
    for (int i = 2; i < argc; i++) {
        if (!strcmp(argv[i], "--run")) run = 1;
        else if (!strcmp(argv[i], "-v")) g_verbose = 1;
        else if (!strcmp(argv[i], "--export") && i + 1 < argc) want_export = argv[++i];
        else if (!strcmp(argv[i], "--aivp")) { want_aivp = 1; run = 1; }
        else if (!strcmp(argv[i], "--aivp-logonly")) { g_aivp_real = 0; want_aivp = 1; run = 1; }
        else if (!strcmp(argv[i], "--aivp-ret") && i + 1 < argc) aivp_parse_rets(argv[++i]);
        else if (!strcmp(argv[i], "--aivp-process") && i + 1 < argc) {
            /* w,h,ow,oh,fmt_in,fmt_out,level -- trailing fields optional */
            sscanf(argv[++i], "%u,%u,%u,%u,%i,%i,%u", &g_pw, &g_ph, &g_pow, &g_poh,
                   (int *)&g_pfin, (int *)&g_pfout, &g_plevel);
            g_aivp_process = 1; want_aivp = 1; run = 1;
        }
        else if (!strcmp(argv[i], "--dlpp")) { want_dlpp = 1; run = 1; }
        else if (!strcmp(argv[i], "--dlpp-scan-iid")) { want_dlpp_scan = 1; run = 1; }
        else if (!strcmp(argv[i], "--dlpp-logonly")) { g_aivp_real = 0; want_dlpp = 1; run = 1; }
        else if (!strcmp(argv[i], "--dlpp-process") && i + 1 < argc) {
            sscanf(argv[++i], "%u,%u,%u,%u,%i,%i,%u", &g_pw, &g_ph, &g_pow, &g_poh,
                   (int *)&g_pfin, (int *)&g_pfout, &g_plevel);
            g_aivp_process = 1; want_dlpp = 1; run = 1;
        }
        else if (!strcmp(argv[i], "--isr") && i + 3 < argc) {
            g_isr_w = atoi(argv[++i]); g_isr_h = atoi(argv[++i]); g_isr_scale = atoi(argv[++i]);
            run = 1;
        }
    }

    Image im = {0};
    if (map_image(&im, path))
        return 2;

    static const char *want[] = {
        "NVSDK_NGX_CUDA_Init", "NVSDK_NGX_CUDA_CreateFeature",
        "NVSDK_NGX_CUDA_EvaluateFeature", "NVSDK_NGX_CUDA_GetScratchBufferSize",
        "NVSDK_NGX_PopulateParameters", "NVSDK_NGX_GetSnippetVersion",
        "ppeGetExportTable", "ppeGetVersion", NULL
    };
    printf("  exports:\n");
    for (int i = 0; want[i]; i++) {
        void *p = find_export(&im, want[i]);
        if (p)
            printf("    %-38s %p (+0x%lx)\n", want[i], p, (long)((uint8_t *)p - im.base));
    }

    if (!run) {
        printf("RESULT: mapped and resolved, nothing executed\n");
        return 0;
    }

    printf("--- stage 2: executing ---\n");
    if (setup_teb()) return 3;
    printf("  TEB at %p, %%gs set\n", g_teb);
    if (setup_pe_tls(&im)) return 3;

    if (im.entry_rva) {
        WINAPI int (*dllmain)(void *, uint32_t, void *) = (void *)(im.base + im.entry_rva);
        printf("  calling DllMain(+0x%x, DLL_PROCESS_ATTACH)...\n", im.entry_rva);
        fflush(stdout);
        int r = dllmain(im.base, DLL_PROCESS_ATTACH, NULL);
        printf("  DllMain returned %d\n", r);
    }

    if (want_aivp) {
        printf("--- stage 3: AIVP (nvaivpx) CreateInstance ---\n");
        fflush(stdout);
        int rc = run_aivp(&im);
        printf("RESULT: %s\n", rc == 0 ? "instance created" : "aivp path failed");
        return rc == 0 ? 0 : 5;
    }
    if (want_dlpp) {
        printf("--- stage 3: DLPP (nvdlppx) CreateInstance ---\n");
        fflush(stdout);
        int rc = run_dlpp(&im);
        printf("RESULT: %s\n", rc == 0 ? "instance created" : "dlpp path failed");
        return rc == 0 ? 0 : 5;
    }
    if (want_dlpp_scan) {
        printf("--- stage 3: DLPP IID scan ---\n");
        fflush(stdout);
        int rc = run_dlpp_scan_iid(&im);
        printf("RESULT: %s\n", rc == 0 ? "iid found" : "no iid found");
        return rc == 0 ? 0 : 5;
    }
    if (g_isr_w) {
        printf("--- stage 3: NGX ImageSuperResolution ---\n");
        int rc = run_ngx_isr(&im, g_isr_w, g_isr_h, g_isr_scale);
        printf("RESULT: %s\n", rc == 0 ? "evaluated" : "feature path failed");
        return rc == 0 ? 0 : 5;
    }

    if (want_export) {
        void *fp = find_export(&im, want_export);
        if (!fp) { fprintf(stderr, "no such export: %s\n", want_export); return 4; }
        printf("  calling %s()...\n", want_export);
        fflush(stdout);
        WINAPI uint32_t (*f)(void) = fp;
        uint32_t r = f();
        printf("  %s returned 0x%x (%u)\n", want_export, r, r);
    }

    printf("RESULT: executed\n");
    return 0;
}
#endif /* PE_MAP_NO_MAIN */
