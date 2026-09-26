/*
 * Crash log for the patched ffmpeg. LGPL-2.1-or-later, same as the project's other filter code.
 *
 * On SIGSEGV/SIGBUS/SIGFPE/SIGILL/SIGABRT writes a short FFmpeg.Crash-<utc>-<pid>.log: the signal,
 * the crashing instruction and a backtrace (module+offset), the command line, and the last few
 * ffmpeg log lines at ERROR level or worse. Warnings and info are never recorded. Then re-raises
 * so the exit status and any core dump are unchanged.
 *
 * Directory: $GU_CRASHLOG_DIR, else /var/log/jellyfin, else /tmp. GU_CRASHLOG=0 turns it off.
 * The handler runs on an alternate stack and uses only write/open/read plus glibc's backtrace
 * (primed at install so it does not allocate in the handler).
 *
 * Storage: at most MAX_BYTES in total (the hard limit) and MAX_FILES reports. Pruning happens at
 * startup, not in the handler (directory scans allocate), oldest first, and leaves RESERVE_BYTES
 * free for the report a crash is about to write. A report cannot exceed RESERVE_BYTES: command line
 * 32 KiB + ERR_SLOTS * ERR_LEN 6.4 KiB + 32 backtrace frames ~4 KiB + header ~1 KiB.
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <dirent.h>
#include <execinfo.h>
#include <fcntl.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <time.h>
#include <ucontext.h>
#include <unistd.h>

#include "libavutil/log.h"

#define MAX_FILES 5
#define MAX_BYTES (10 * 1024 * 1024)
#define RESERVE_BYTES (64 * 1024)
#define CRASH_PREFIX "FFmpeg.Crash-"
#define ERR_SLOTS 16
#define ERR_LEN 400

static char g_cmdline[32768];
static size_t g_cmdlen;
static char g_dir[512];
static char g_exe[512];
static char g_err[ERR_SLOTS][ERR_LEN];
static volatile unsigned g_err_n;
static char g_altstack[128 * 1024];
static volatile sig_atomic_t g_busy;

static void put(int fd, const char *s)
{
    size_t n = strlen(s);
    while (n) {
        ssize_t w = write(fd, s, n);
        if (w <= 0)
            return;
        s += w;
        n -= (size_t)w;
    }
}

static void put_num(int fd, uint64_t v, unsigned base)
{
    char buf[24];
    int i = sizeof(buf) - 1;
    buf[i] = 0;
    do {
        buf[--i] = "0123456789abcdef"[v % base];
        v /= base;
    } while (v);
    put(fd, buf + i);
}

static void put_hex(int fd, uint64_t v)
{
    put(fd, "0x");
    put_num(fd, v, 16);
}

static const char *sig_name(int sig)
{
    switch (sig) {
    case SIGSEGV: return "SIGSEGV";
    case SIGBUS:  return "SIGBUS";
    case SIGFPE:  return "SIGFPE";
    case SIGILL:  return "SIGILL";
    case SIGABRT: return "SIGABRT";
    }
    return "signal";
}

static void write_report(int fd, int sig, siginfo_t *si, void *uc_v)
{
    void *bt[64];
    int n;
    size_t i, start = 0;
    struct tm tm;
    time_t now = time(NULL);
    char ts[32];

    gmtime_r(&now, &tm);
    strftime(ts, sizeof(ts), "%Y-%m-%d %H:%M:%S UTC", &tm);

    put(fd, "ffmpeg crash report\n===================\ntime:    ");
    put(fd, ts);
    put(fd, "\nexe:     ");
    put(fd, g_exe);
    put(fd, "\npid/tid: ");
    put_num(fd, (uint64_t)getpid(), 10);
    put(fd, "/");
    put_num(fd, (uint64_t)syscall(SYS_gettid), 10);
    put(fd, "\nsignal:  ");
    put(fd, sig_name(sig));
    put(fd, " (");
    put_num(fd, (uint64_t)sig, 10);
    put(fd, ")  si_code=");
    put_num(fd, (uint64_t)(unsigned)si->si_code, 10);
    if (sig == SIGSEGV || sig == SIGBUS || sig == SIGFPE || sig == SIGILL) {
        put(fd, "  fault address=");
        put_hex(fd, (uint64_t)(uintptr_t)si->si_addr);
    }
    put(fd, "\n");

#ifdef __x86_64__
    if (uc_v) {
        ucontext_t *uc = uc_v;
        void *pc = (void *)uc->uc_mcontext.gregs[REG_RIP];
        put(fd, "crashing instruction: ");
        put_hex(fd, (uint64_t)(uintptr_t)pc);
        put(fd, "  sp=");
        put_hex(fd, (uint64_t)uc->uc_mcontext.gregs[REG_RSP]);
        put(fd, "\n");
        backtrace_symbols_fd(&pc, 1, fd);
    }
#else
    (void)uc_v;
#endif

    put(fd, "\nlast ffmpeg errors (error level and worse only, oldest first):\n");
    {
        unsigned total = g_err_n;
        unsigned count = total < ERR_SLOTS ? total : ERR_SLOTS;
        unsigned k;
        if (!count)
            put(fd, "  (none logged)\n");
        for (k = total - count; k < total; k++) {
            if (g_err[k % ERR_SLOTS][0]) {
                put(fd, "  ");
                put(fd, g_err[k % ERR_SLOTS]);
            }
        }
    }

    put(fd, "\ncommand line:\n");
    for (i = 0; i < g_cmdlen; i++) {
        if (g_cmdline[i] == 0) {
            put(fd, "  ");
            put(fd, g_cmdline + start);
            put(fd, "\n");
            start = i + 1;
        }
    }

    put(fd, "\nbacktrace (innermost first, the top frames are this handler):\n");
    n = backtrace(bt, 32);
    backtrace_symbols_fd(bt, n, fd);
}

static void log_cb(void *avcl, int level, const char *fmt, va_list vl)
{
    if (level >= 0 && (level & 0xff) <= AV_LOG_ERROR) {
        char line[ERR_LEN];
        int prefix = 1;
        va_list cp;
        va_copy(cp, vl);
        av_log_format_line2(avcl, level, fmt, cp, line, sizeof(line), &prefix);
        va_end(cp);
        memcpy(g_err[__sync_fetch_and_add(&g_err_n, 1) % ERR_SLOTS], line, sizeof(line));
    }
    av_log_default_callback(avcl, level, fmt, vl);
}

static void on_crash(int sig, siginfo_t *si, void *uc)
{
    char path[640];
    char name[64];
    struct tm tm;
    time_t now = time(NULL);
    int fd;
    static const char *const dirs[] = { g_dir, "/tmp" };
    size_t d;

    if (__sync_lock_test_and_set(&g_busy, 1)) {
        for (;;)
            pause();
    }

    gmtime_r(&now, &tm);
    strftime(name, sizeof(name), "FFmpeg.Crash-%Y-%m-%d_%H-%M-%S", &tm);

    for (d = 0; d < 2; d++) {
        char pid[24];
        int i = sizeof(pid) - 1;
        unsigned v = (unsigned)getpid();
        size_t len;
        pid[i] = 0;
        do {
            pid[--i] = (char)('0' + v % 10);
            v /= 10;
        } while (v);
        len = strlen(dirs[d]);
        if (!len || len + strlen(name) + strlen(pid + i) + 8 > sizeof(path))
            continue;
        memcpy(path, dirs[d], len);
        path[len] = 0;
        strcat(path, "/");
        strcat(path, name);
        strcat(path, "-");
        strcat(path, pid + i);
        strcat(path, ".log");
        fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (fd < 0)
            continue;
        write_report(fd, sig, si, uc);
        close(fd);
        put(2, "ffmpeg crashed (");
        put(2, sig_name(sig));
        put(2, "); crash report written to ");
        put(2, path);
        put(2, "\n");
        break;
    }

    signal(sig, SIG_DFL);
    raise(sig);
}

static int is_crash_log(const struct dirent *e)
{
    size_t n = strlen(e->d_name);
    return !strncmp(e->d_name, CRASH_PREFIX, sizeof(CRASH_PREFIX) - 1)
        && n > 4 && !strcmp(e->d_name + n - 4, ".log");
}

/* Names start with a UTC timestamp, so alphabetical order is oldest first. */
static void prune(const char *dir)
{
    struct dirent **list = NULL;
    long long sizes[1024];
    char path[768];
    long long total = 0;
    int n, i, first = 0;

    n = scandir(dir, &list, is_crash_log, alphasort);
    if (n <= 0)
        return;
    if (n > 1024)
        first = n - 1024;

    for (i = first; i < n; i++) {
        struct stat st;
        snprintf(path, sizeof(path), "%s/%s", dir, list[i]->d_name);
        sizes[i - first] = stat(path, &st) ? 0 : st.st_size;
        total += sizes[i - first];
    }

    for (i = 0; i < n; i++) {
        int remaining = n - i;
        if (i >= first && remaining <= MAX_FILES - 1 && total <= MAX_BYTES - RESERVE_BYTES)
            break;
        snprintf(path, sizeof(path), "%s/%s", dir, list[i]->d_name);
        if (!unlink(path) && i >= first)
            total -= sizes[i - first];
    }

    for (i = 0; i < n; i++)
        free(list[i]);
    free(list);
}

void gu_crashlog_install(void);
void gu_crashlog_install(void)
{
    static const int sigs[] = { SIGSEGV, SIGBUS, SIGFPE, SIGILL, SIGABRT };
    const char *off = getenv("GU_CRASHLOG");
    const char *dir = getenv("GU_CRASHLOG_DIR");
    struct sigaction sa;
    stack_t ss;
    void *prime[1];
    ssize_t r;
    int fd, k;

    if (off && off[0] == '0')
        return;

    snprintf(g_dir, sizeof(g_dir), "%s", dir && dir[0] ? dir : "/var/log/jellyfin");
    prune(g_dir);
    prune("/tmp");

    r = readlink("/proc/self/exe", g_exe, sizeof(g_exe) - 1);
    g_exe[r > 0 ? r : 0] = 0;

    fd = open("/proc/self/cmdline", O_RDONLY);
    if (fd >= 0) {
        while (g_cmdlen < sizeof(g_cmdline) - 1 &&
               (r = read(fd, g_cmdline + g_cmdlen, sizeof(g_cmdline) - 1 - g_cmdlen)) > 0)
            g_cmdlen += (size_t)r;
        close(fd);
        if (g_cmdlen && g_cmdline[g_cmdlen - 1] != 0)
            g_cmdline[g_cmdlen++] = 0;
    }

    av_log_set_callback(log_cb);

    backtrace(prime, 1);

    ss.ss_sp = g_altstack;
    ss.ss_size = sizeof(g_altstack);
    ss.ss_flags = 0;
    sigaltstack(&ss, NULL);

    memset(&sa, 0, sizeof(sa));
    sa.sa_sigaction = on_crash;
    sa.sa_flags = SA_SIGINFO | SA_ONSTACK | SA_RESETHAND | SA_NODEFER;
    sigemptyset(&sa.sa_mask);
    for (k = 0; k < (int)(sizeof(sigs) / sizeof(sigs[0])); k++)
        sigaction(sigs[k], &sa, NULL);
}
