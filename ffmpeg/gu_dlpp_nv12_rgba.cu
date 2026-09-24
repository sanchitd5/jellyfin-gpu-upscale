/* nv12_to_rgba / p010_to_rgba / rgba_to_nv12: NV12<->RGBA8 CUDA surface conversion for
 * dlpp_rtcuda, real CUDA C compiled to PTX with clang's NVPTX backend (no NVIDIA SDK,
 * no NVIDIA material -- our own BT.709 limited-range integer conversion). CT114 has no
 * nvcc; clang-18's own bundled __clang_cuda_builtin_vars.h supplies blockIdx/threadIdx/
 * blockDim without a CUDA toolkit install (see scripts/build-ffmpeg.sh for the exact
 * compile command). The two `sust`/`suld` bindless-surface accesses stay inline PTX asm
 * because CUDA's surface intrinsics live in headers this build deliberately doesn't pull
 * in; everything else here is ordinary, auditable C.
 *
 * p010_to_rgba exists because NVDEC decodes 10-bit sources straight to p010le (10-bit
 * samples packed into 16-bit little-endian words, value = sample << 6), not nv12 --
 * nv12_to_rgba's byte reads silently misread that layout. This filter's whole pipeline
 * (DLPP SDK call, rgba_to_nv12 below) is 8-bit only regardless of input, so p010_to_rgba
 * reduces to the 8-bit domain by keeping the top 8 bits of each 16-bit word (word >> 8)
 * before running the *same* BT.709 matrix nv12_to_rgba uses -- a deliberate, documented
 * downconvert, not a truncation bug.
 */
#define __global__ __attribute__((global))
#define __device__ __attribute__((device))
#include <__clang_cuda_builtin_vars.h>

typedef unsigned long long cudaSurfaceObject_t;

__device__ static inline int clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

__device__ static inline void surf_write_rgba8(cudaSurfaceObject_t s, int x, int y,
                                                unsigned char r, unsigned char g,
                                                unsigned char b, unsigned char a)
{
    asm volatile("sust.b.2d.v4.b8.trap [%0, {%1,%2}], {%3,%4,%5,%6};"
        :: "l"(s), "r"(x * 4), "r"(y),
           "h"((unsigned short)r), "h"((unsigned short)g),
           "h"((unsigned short)b), "h"((unsigned short)a));
}

__device__ static inline void surf_read_rgba8(cudaSurfaceObject_t s, int x, int y,
                                               unsigned char *r, unsigned char *g,
                                               unsigned char *b, unsigned char *a)
{
    unsigned short rr, gg, bb, aa;
    asm volatile("suld.b.2d.v4.b8.clamp {%0,%1,%2,%3}, [%4, {%5,%6}];"
        : "=h"(rr), "=h"(gg), "=h"(bb), "=h"(aa)
        : "l"(s), "r"(x * 4), "r"(y));
    *r = (unsigned char)rr; *g = (unsigned char)gg; *b = (unsigned char)bb; *a = (unsigned char)aa;
}

/* BT.709 limited-range YUV->RGB. y/u/v are already 8-bit-domain samples in [0,255] --
 * for p010 the caller has already reduced the 16-bit word to that domain. */
__device__ static inline void yuv_to_rgb8(int y, int u, int v,
                                           unsigned char *r, unsigned char *g, unsigned char *b)
{
    int c = y - 16;
    int d = u - 128;
    int e = v - 128;
    int cy = c * 298 + 128;
    *r = (unsigned char)clampi((cy + 459 * e) >> 8, 0, 255);
    *g = (unsigned char)clampi((cy - 55 * d - 136 * e) >> 8, 0, 255);
    *b = (unsigned char)clampi((cy + 541 * d) >> 8, 0, 255);
}

extern "C" __global__ void nv12_to_rgba(const unsigned char *y_plane, unsigned yp,
                                        const unsigned char *uv_plane, unsigned uvp,
                                        cudaSurfaceObject_t dst, unsigned w, unsigned h)
{
    int x = blockIdx.x * blockDim.x + threadIdx.x;
    int y = blockIdx.y * blockDim.y + threadIdx.y;
    if ((unsigned)x >= w || (unsigned)y >= h) return;

    int Y = y_plane[y * yp + x];
    const unsigned char *uv = uv_plane + (y / 2) * uvp + (x & ~1);

    unsigned char r, g, b;
    yuv_to_rgb8(Y, uv[0], uv[1], &r, &g, &b);
    surf_write_rgba8(dst, x, y, r, g, b, 255);
}

extern "C" __global__ void p010_to_rgba(const unsigned char *y_plane, unsigned yp,
                                        const unsigned char *uv_plane, unsigned uvp,
                                        cudaSurfaceObject_t dst, unsigned w, unsigned h)
{
    int x = blockIdx.x * blockDim.x + threadIdx.x;
    int y = blockIdx.y * blockDim.y + threadIdx.y;
    if ((unsigned)x >= w || (unsigned)y >= h) return;

    const unsigned short *y16 = (const unsigned short *)(y_plane + y * yp);
    int Y = y16[x] >> 8;

    const unsigned short *uv16 = (const unsigned short *)(uv_plane + (y / 2) * uvp) + (x & ~1);
    int U = uv16[0] >> 8, V = uv16[1] >> 8;

    unsigned char r, g, b;
    yuv_to_rgb8(Y, U, V, &r, &g, &b);
    surf_write_rgba8(dst, x, y, r, g, b, 255);
}

extern "C" __global__ void rgba_to_nv12(cudaSurfaceObject_t src,
                                        unsigned char *y_plane, unsigned yp,
                                        unsigned char *uv_plane, unsigned uvp,
                                        unsigned w, unsigned h)
{
    int bx = blockIdx.x * blockDim.x + threadIdx.x;
    int by = blockIdx.y * blockDim.y + threadIdx.y;
    int x0 = bx * 2, y0 = by * 2;
    if ((unsigned)x0 >= w || (unsigned)y0 >= h) return;

    int sr = 0, sg = 0, sb = 0;
    for (int j = 0; j < 2; j++) {
        for (int i = 0; i < 2; i++) {
            unsigned char r, g, b, a;
            surf_read_rgba8(src, x0 + i, y0 + j, &r, &g, &b, &a);
            sr += r; sg += g; sb += b;
            int yv = ((r * 47 + g * 157 + b * 16 + 128) >> 8) + 16;
            y_plane[(y0 + j) * yp + (x0 + i)] = (unsigned char)yv;
        }
    }
    int ar = (sr + 2) >> 2, ag = (sg + 2) >> 2, ab = (sb + 2) >> 2;
    int u = ((ar * -26 + ag * -87 + ab * 112 + 128) >> 8) + 128;
    int v = ((ar * 112 + ag * -102 + ab * -10 + 128) >> 8) + 128;
    uv_plane[by * uvp + x0]     = (unsigned char)u;
    uv_plane[by * uvp + x0 + 1] = (unsigned char)v;
}
