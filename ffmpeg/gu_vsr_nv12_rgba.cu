/* semiplanar_to_rgba / planar444_to_rgba / rgba_to_nv12: NVDEC-sw_format<->RGBA8 CUDA
 * surface conversion for vsr_rtcuda. The NVDEC<->RGB(A) BT.709 math and sample-format
 * handling are shared with gu_optix_nv12_rgbf32.cu/gu_dlpp_nv12_rgba.cu via gu_colorconv.h
 * -- see that header for why (textual, not link-time, sharing: each .cu file is still its
 * own independently-compiled PTX blob). This file keeps only what's actually
 * vsr_rtcuda-specific: the bindless CUDA surface read/write. The two `sust`/`suld`
 * accesses stay inline PTX asm because CUDA's surface intrinsics live in headers this
 * build deliberately doesn't pull in.
 */
#include "gu_colorconv.h"

typedef unsigned long long cudaSurfaceObject_t;

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

extern "C" __global__ void semiplanar_to_rgba(const unsigned char *y_plane, unsigned yp,
                                              const unsigned char *uv_plane, unsigned uvp,
                                              cudaSurfaceObject_t dst, unsigned w, unsigned h,
                                              int word_bytes, int chroma_vshift)
{
    int x = blockIdx.x * blockDim.x + threadIdx.x;
    int y = blockIdx.y * blockDim.y + threadIdx.y;
    if ((unsigned)x >= w || (unsigned)y >= h) return;

    int Y, U, V, r, g, b;
    gu_read_semiplanar(y_plane, yp, uv_plane, uvp, x, y, word_bytes, chroma_vshift, &Y, &U, &V);
    gu_yuv_to_rgb8(Y, U, V, &r, &g, &b);
    surf_write_rgba8(dst, x, y, (unsigned char)r, (unsigned char)g, (unsigned char)b, 255);
}

extern "C" __global__ void planar444_to_rgba(const unsigned char *y_plane, unsigned yp,
                                             const unsigned char *u_plane, unsigned up,
                                             const unsigned char *v_plane, unsigned vp,
                                             cudaSurfaceObject_t dst, unsigned w, unsigned h,
                                             int word_bytes)
{
    int x = blockIdx.x * blockDim.x + threadIdx.x;
    int y = blockIdx.y * blockDim.y + threadIdx.y;
    if ((unsigned)x >= w || (unsigned)y >= h) return;

    int Y, U, V, r, g, b;
    gu_read_planar444(y_plane, yp, u_plane, up, v_plane, vp, x, y, word_bytes, &Y, &U, &V);
    gu_yuv_to_rgb8(Y, U, V, &r, &g, &b);
    surf_write_rgba8(dst, x, y, (unsigned char)r, (unsigned char)g, (unsigned char)b, 255);
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
            y_plane[(y0 + j) * yp + (x0 + i)] = gu_rgb_to_y(r, g, b);
        }
    }
    unsigned char u, v;
    gu_rgb_avg_to_uv((sr + 2) >> 2, (sg + 2) >> 2, (sb + 2) >> 2, &u, &v);
    uv_plane[by * uvp + x0]     = u;
    uv_plane[by * uvp + x0 + 1] = v;
}
