/* nv12_to_rgbf32 / p010_to_rgbf32 / rgbf32_to_nv12 / smooth_luma_dev / p010_smooth_luma_dev
 * / expand_flow_dev: OptiX's on-GPU NV12<->linear-float3 conversion plus the two device-to-
 * device helpers used for the NVOFA temporal flow path, real CUDA C compiled to PTX with
 * clang's NVPTX backend (no NVIDIA SDK, no NVIDIA material -- our own BT.709 limited-range
 * integer conversion and 3x3 box filter). CT114 has no nvcc; clang-18's own bundled
 * __clang_cuda_builtin_vars.h supplies blockIdx/threadIdx/blockDim without a CUDA toolkit
 * install (see scripts/build-ffmpeg.sh for the exact compile command). Everything here is
 * ordinary global-memory reads/writes -- no surface object, so no inline PTX asm needed
 * anywhere in this file.
 *
 * p010_to_rgbf32 and p010_smooth_luma_dev exist because NVDEC decodes 10-bit sources
 * straight to p010le (10-bit samples packed into 16-bit little-endian words, value =
 * sample << 6), not nv12 -- the 8-bit-only kernels' byte reads silently misread that
 * layout. This filter's denoiser output is 8-bit NV12 either way (rgbf32_to_nv12 never
 * varies with input format), so both p010 variants reduce to the 8-bit domain by keeping
 * the top 8 bits of each 16-bit word (word >> 8) before running the *same* math the 8-bit
 * kernels use -- a deliberate, documented downconvert, not a truncation bug.
 */
#define __global__ __attribute__((global))
#define __device__ __attribute__((device))
#include <__clang_cuda_builtin_vars.h>

__device__ static inline int clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

/* BT.709 limited-range YUV->RGB. y/u/v are already 8-bit-domain samples in [0,255] --
 * for p010 the caller has already reduced the 16-bit word to that domain. */
__device__ static inline void yuv_to_rgb8(int y, int u, int v, int *r, int *g, int *b)
{
    int c = y - 16;
    int d = u - 128;
    int e = v - 128;
    int cy = c * 298 + 128;
    *r = clampi((cy + 459 * e) >> 8, 0, 255);
    *g = clampi((cy - 55 * d - 136 * e) >> 8, 0, 255);
    *b = clampi((cy + 541 * d) >> 8, 0, 255);
}

extern "C" __global__ void nv12_to_rgbf32(const unsigned char *y_plane, unsigned yp,
                                          const unsigned char *uv_plane, unsigned uvp,
                                          float *dst, unsigned dp, unsigned w, unsigned h)
{
    int x = blockIdx.x * blockDim.x + threadIdx.x;
    int y = blockIdx.y * blockDim.y + threadIdx.y;
    if ((unsigned)x >= w || (unsigned)y >= h) return;

    int Y = y_plane[y * yp + x];
    const unsigned char *uv = uv_plane + (y / 2) * uvp + (x & ~1);
    int r, g, b;
    yuv_to_rgb8(Y, uv[0], uv[1], &r, &g, &b);

    float *p = (float *)((unsigned char *)dst + y * dp) + x * 3;
    p[0] = r * (1.0f / 255.0f);
    p[1] = g * (1.0f / 255.0f);
    p[2] = b * (1.0f / 255.0f);
}

extern "C" __global__ void p010_to_rgbf32(const unsigned char *y_plane, unsigned yp,
                                          const unsigned char *uv_plane, unsigned uvp,
                                          float *dst, unsigned dp, unsigned w, unsigned h)
{
    int x = blockIdx.x * blockDim.x + threadIdx.x;
    int y = blockIdx.y * blockDim.y + threadIdx.y;
    if ((unsigned)x >= w || (unsigned)y >= h) return;

    const unsigned short *y16 = (const unsigned short *)(y_plane + y * yp);
    int Y = y16[x] >> 8;
    const unsigned short *uv16 = (const unsigned short *)(uv_plane + (y / 2) * uvp) + (x & ~1);
    int r, g, b;
    yuv_to_rgb8(Y, uv16[0] >> 8, uv16[1] >> 8, &r, &g, &b);

    float *p = (float *)((unsigned char *)dst + y * dp) + x * 3;
    p[0] = r * (1.0f / 255.0f);
    p[1] = g * (1.0f / 255.0f);
    p[2] = b * (1.0f / 255.0f);
}

extern "C" __global__ void rgbf32_to_nv12(const float *src, unsigned sp,
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
        const float *row = (const float *)((const unsigned char *)src + (y0 + j) * sp);
        for (int i = 0; i < 2; i++) {
            const float *px = row + (x0 + i) * 3;
            int r = clampi((int)(px[0] * 255.0f + 0.5f), 0, 255);
            int g = clampi((int)(px[1] * 255.0f + 0.5f), 0, 255);
            int b = clampi((int)(px[2] * 255.0f + 0.5f), 0, 255);
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

/* smooth_luma_dev: device-to-device 3x3 box filter over the decoded Y plane, writing
 * straight into NVOFA's own pitched input buffer (temporal mode only). */
extern "C" __global__ void smooth_luma_dev(const unsigned char *y_plane, unsigned yp,
                                           unsigned char *dst, unsigned dp,
                                           unsigned w, unsigned h)
{
    int x = blockIdx.x * blockDim.x + threadIdx.x;
    int y = blockIdx.y * blockDim.y + threadIdx.y;
    if ((unsigned)x >= w || (unsigned)y >= h) return;

    int xm = x > 0 ? x - 1 : 0, xp = x < (int)w - 1 ? x + 1 : (int)w - 1;
    int ym = y > 0 ? y - 1 : 0, ypp = y < (int)h - 1 ? y + 1 : (int)h - 1;

    int sum = 0;
    sum += y_plane[ym  * yp + xm] + y_plane[ym  * yp + x] + y_plane[ym  * yp + xp];
    sum += y_plane[y   * yp + xm] + y_plane[y   * yp + x] + y_plane[y   * yp + xp];
    sum += y_plane[ypp * yp + xm] + y_plane[ypp * yp + x] + y_plane[ypp * yp + xp];

    dst[y * dp + x] = (unsigned char)((sum + 4) / 9);
}

/* p010_smooth_luma_dev: same box filter, reading 16-bit p010le luma samples reduced to
 * the 8-bit domain (word >> 8) first -- same convention as p010_to_rgbf32 above. */
extern "C" __global__ void p010_smooth_luma_dev(const unsigned char *y_plane, unsigned yp,
                                                 unsigned char *dst, unsigned dp,
                                                 unsigned w, unsigned h)
{
    int x = blockIdx.x * blockDim.x + threadIdx.x;
    int y = blockIdx.y * blockDim.y + threadIdx.y;
    if ((unsigned)x >= w || (unsigned)y >= h) return;

    int xm = x > 0 ? x - 1 : 0, xp = x < (int)w - 1 ? x + 1 : (int)w - 1;
    int ym = y > 0 ? y - 1 : 0, ypp = y < (int)h - 1 ? y + 1 : (int)h - 1;

    const unsigned short *row_ym  = (const unsigned short *)(y_plane + ym  * yp);
    const unsigned short *row_y   = (const unsigned short *)(y_plane + y   * yp);
    const unsigned short *row_ypp = (const unsigned short *)(y_plane + ypp * yp);

    int sum = 0;
    sum += (row_ym[xm]  >> 8) + (row_ym[x]  >> 8) + (row_ym[xp]  >> 8);
    sum += (row_y[xm]   >> 8) + (row_y[x]   >> 8) + (row_y[xp]   >> 8);
    sum += (row_ypp[xm] >> 8) + (row_ypp[x] >> 8) + (row_ypp[xp] >> 8);

    dst[y * dp + x] = (unsigned char)((sum + 4) / 9);
}

/* expand_flow_dev: device-to-device expansion of NVOFA's S10.5 4x4 grid (still in NVOFA's
 * own output buffer, never downloaded) into the dense float2 field OptiX wants. Grid
 * data is NVOFA's own motion-vector format, independent of the decoded frame's pixel
 * format, so this needs no p010 variant. */
extern "C" __global__ void expand_flow_dev(const short *grid, unsigned gp, unsigned gw, unsigned gh,
                                           float *dst, unsigned w, unsigned h)
{
    int x = blockIdx.x * blockDim.x + threadIdx.x;
    int y = blockIdx.y * blockDim.y + threadIdx.y;
    if ((unsigned)x >= w || (unsigned)y >= h) return;

    int gy = y >> 2; if (gy > (int)gh - 1) gy = (int)gh - 1;
    int gx = x >> 2; if (gx > (int)gw - 1) gx = (int)gw - 1;

    const short *row = (const short *)((const unsigned char *)grid + gy * gp) + gx * 2;
    float fx = -(row[0] * (1.0f / 32.0f));
    float fy = -(row[1] * (1.0f / 32.0f));

    float *p = dst + (unsigned long)(y * w + x) * 2;
    p[0] = fx;
    p[1] = fy;
}
