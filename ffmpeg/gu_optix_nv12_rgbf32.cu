/* semiplanar_to_rgbf32 / planar444_to_rgbf32 / rgbf32_to_nv12 / smooth_luma_dev /
 * expand_flow_dev: OptiX's on-GPU NVDEC-sw_format<->linear-float3 conversion plus the two
 * device-to-device helpers used for the NVOFA temporal flow path. The NVDEC<->RGB(A) BT.709
 * math and sample-format handling are shared with gu_dlpp_nv12_rgba.cu/gu_vsr_nv12_rgba.cu
 * via gu_colorconv.h -- see that header for why (textual, not link-time, sharing: each .cu
 * file is still its own independently-compiled PTX blob). This file keeps only what's
 * actually optix-specific: the RGB float3 buffer read/write (as opposed to dlpp/vsr's RGBA8
 * CUDA surface) and the NVOFA luma-smoothing / flow-grid-expansion kernels.
 */
#include "gu_colorconv.h"

/* Every non-444 NVDEC sw_format, converted straight into OptiX's interleaved float3
 * buffer in [0,1]. */
extern "C" __global__ void semiplanar_to_rgbf32(const unsigned char *y_plane, unsigned yp,
                                                 const unsigned char *uv_plane, unsigned uvp,
                                                 float *dst, unsigned dp, unsigned w, unsigned h,
                                                 int word_bytes, int chroma_vshift)
{
    int x = blockIdx.x * blockDim.x + threadIdx.x;
    int y = blockIdx.y * blockDim.y + threadIdx.y;
    if ((unsigned)x >= w || (unsigned)y >= h) return;

    int Y, U, V, r, g, b;
    gu_read_semiplanar(y_plane, yp, uv_plane, uvp, x, y, word_bytes, chroma_vshift, &Y, &U, &V);
    gu_yuv_to_rgb8(Y, U, V, &r, &g, &b);

    float *p = (float *)((unsigned char *)dst + y * dp) + x * 3;
    p[0] = r * (1.0f / 255.0f);
    p[1] = g * (1.0f / 255.0f);
    p[2] = b * (1.0f / 255.0f);
}

/* yuv444p and its >8-bit siblings, converted straight into OptiX's interleaved float3
 * buffer in [0,1]. */
extern "C" __global__ void planar444_to_rgbf32(const unsigned char *y_plane, unsigned yp,
                                                const unsigned char *u_plane, unsigned up,
                                                const unsigned char *v_plane, unsigned vp,
                                                float *dst, unsigned dp, unsigned w, unsigned h,
                                                int word_bytes)
{
    int x = blockIdx.x * blockDim.x + threadIdx.x;
    int y = blockIdx.y * blockDim.y + threadIdx.y;
    if ((unsigned)x >= w || (unsigned)y >= h) return;

    int Y, U, V, r, g, b;
    gu_read_planar444(y_plane, yp, u_plane, up, v_plane, vp, x, y, word_bytes, &Y, &U, &V);
    gu_yuv_to_rgb8(Y, U, V, &r, &g, &b);

    float *p = (float *)((unsigned char *)dst + y * dp) + x * 3;
    p[0] = r * (1.0f / 255.0f);
    p[1] = g * (1.0f / 255.0f);
    p[2] = b * (1.0f / 255.0f);
}

/* Denoiser output is always 8-bit NV12 regardless of input sw_format. */
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
            int r = gu_clampi((int)(px[0] * 255.0f + 0.5f), 0, 255);
            int g = gu_clampi((int)(px[1] * 255.0f + 0.5f), 0, 255);
            int b = gu_clampi((int)(px[2] * 255.0f + 0.5f), 0, 255);
            sr += r; sg += g; sb += b;
            y_plane[(y0 + j) * yp + (x0 + i)] = gu_rgb_to_y(r, g, b);
        }
    }
    unsigned char u, v;
    gu_rgb_avg_to_uv((sr + 2) >> 2, (sg + 2) >> 2, (sb + 2) >> 2, &u, &v);
    uv_plane[by * uvp + x0]     = u;
    uv_plane[by * uvp + x0 + 1] = v;
}

/* smooth_luma_dev: device-to-device 3x3 box filter over the decoded Y plane, writing
 * straight into NVOFA's own pitched input buffer (temporal mode only). word_bytes handles
 * both 8-bit and 16-bit-word luma the same way semiplanar reads do; yuv444p's Y plane is
 * byte-identical in layout to a semiplanar format's Y plane, so no is_planar444 variant is
 * needed here. */
extern "C" __global__ void smooth_luma_dev(const unsigned char *y_plane, unsigned yp,
                                           unsigned char *dst, unsigned dp,
                                           unsigned w, unsigned h, int word_bytes)
{
    int x = blockIdx.x * blockDim.x + threadIdx.x;
    int y = blockIdx.y * blockDim.y + threadIdx.y;
    if ((unsigned)x >= w || (unsigned)y >= h) return;

    int xm = x > 0 ? x - 1 : 0, xp = x < (int)w - 1 ? x + 1 : (int)w - 1;
    int ym = y > 0 ? y - 1 : 0, ypp = y < (int)h - 1 ? y + 1 : (int)h - 1;

    int sum = 0;
    if (word_bytes == 1) {
        sum += y_plane[ym  * yp + xm] + y_plane[ym  * yp + x] + y_plane[ym  * yp + xp];
        sum += y_plane[y   * yp + xm] + y_plane[y   * yp + x] + y_plane[y   * yp + xp];
        sum += y_plane[ypp * yp + xm] + y_plane[ypp * yp + x] + y_plane[ypp * yp + xp];
    } else {
        const unsigned short *row_ym  = (const unsigned short *)(y_plane + ym  * yp);
        const unsigned short *row_y   = (const unsigned short *)(y_plane + y   * yp);
        const unsigned short *row_ypp = (const unsigned short *)(y_plane + ypp * yp);
        sum += (row_ym[xm]  >> 8) + (row_ym[x]  >> 8) + (row_ym[xp]  >> 8);
        sum += (row_y[xm]   >> 8) + (row_y[x]   >> 8) + (row_y[xp]   >> 8);
        sum += (row_ypp[xm] >> 8) + (row_ypp[x] >> 8) + (row_ypp[xp] >> 8);
    }

    dst[y * dp + x] = (unsigned char)((sum + 4) / 9);
}

/* expand_flow_dev: device-to-device expansion of NVOFA's S10.5 4x4 grid (still in NVOFA's
 * own output buffer, never downloaded) into the dense float2 field OptiX wants. Grid data
 * is NVOFA's own motion-vector format, independent of the decoded frame's pixel format, so
 * this needs no word_bytes/chroma_vshift parameters. */
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
