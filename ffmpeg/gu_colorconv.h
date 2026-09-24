/* gu_colorconv.h: shared NVDEC-sw_format<->RGB(A) BT.709 limited-range conversion helpers,
 * real CUDA C compiled to PTX with clang's NVPTX backend (no NVIDIA SDK, no NVIDIA
 * material). CT114 has no nvcc/CUDA toolkit; each .cu file is its own single translation
 * unit compiled with `clang -x cuda --cuda-device-only`, so this header is included
 * source-level into each one rather than linked as a separate device module -- there is no
 * cross-TU device linking anywhere in this build, only textual sharing, which is exactly
 * what removes the triplicated copies this header replaces (gu_optix_nv12_rgbf32.cu,
 * gu_dlpp_nv12_rgba.cu, gu_vsr_nv12_rgba.cu all carried byte-identical copies of this
 * logic before). roadmap/gpu-only-filters.md's "One PTX colour-conversion module" item:
 * ort and oidn are listed there as future consumers too, once either goes GPU-resident --
 * neither has a CUDA color-conversion kernel of its own yet, so this header is scoped to
 * what optix/dlpp_rtcuda/vsr_rtcuda actually use today.
 *
 * Every consumer covers the complete, exhaustive set of sw_format values
 * libavcodec/nvdec.c's ff_nvdec_get_format can produce, via word_bytes (1 or 2 bytes/
 * sample) and chroma_vshift (whether the chroma plane is vertically subsampled) rather
 * than one hard-coded format -- see each filter's own classify_nvdec_format(). Every
 * 16-bit-word format reduces via word >> 8 before the same BT.709 matrix, since NVDEC
 * always MSB-justifies a sub-16-bit sample within its 16-bit container regardless of real
 * bit depth.
 */
#ifndef GU_COLORCONV_H
#define GU_COLORCONV_H

#define __global__ __attribute__((global))
#define __device__ __attribute__((device))
#include <__clang_cuda_builtin_vars.h>

__device__ static inline int gu_clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

/* BT.709 limited-range YUV->RGB, int result in [0,255] (optix's float3 output scales this
 * itself; dlpp/vsr's RGBA8 surface writes it straight). y/u/v are already 8-bit-domain
 * samples -- callers reading a wider word have already reduced it (word >> 8). */
__device__ static inline void gu_yuv_to_rgb8(int y, int u, int v, int *r, int *g, int *b)
{
    int c = y - 16;
    int d = u - 128;
    int e = v - 128;
    int cy = c * 298 + 128;
    *r = gu_clampi((cy + 459 * e) >> 8, 0, 255);
    *g = gu_clampi((cy - 55 * d - 136 * e) >> 8, 0, 255);
    *b = gu_clampi((cy + 541 * d) >> 8, 0, 255);
}

/* BT.709 limited-range RGB->Y, one pixel. Forward half of the same matrix every output
 * kernel here uses (rgbf32_to_nv12 / rgba_to_nv12), regardless of input sw_format -- output
 * is always 8-bit NV12. */
__device__ static inline unsigned char gu_rgb_to_y(int r, int g, int b)
{
    return (unsigned char)(((r * 47 + g * 157 + b * 16 + 128) >> 8) + 16);
}

/* BT.709 limited-range RGB->UV from a 2x2 block's already-summed (not yet averaged)
 * channel totals -- callers pass (sum + 2) >> 2 for each of ar/ag/ab. */
__device__ static inline void gu_rgb_avg_to_uv(int ar, int ag, int ab, unsigned char *u, unsigned char *v)
{
    *u = (unsigned char)(((ar * -26 + ag * -87 + ab * 112 + 128) >> 8) + 128);
    *v = (unsigned char)(((ar * 112 + ag * -102 + ab * -10 + 128) >> 8) + 128);
}

/* Reads one (Y, U, V) sample from a semiplanar NVDEC sw_format at pixel (x, y):
 * nv12/nv16/p010le/p012le/p016le/p210le/p212le/p216le -- one Y plane, one interleaved-
 * chroma plane, differing only in sample width and vertical chroma subsampling. */
__device__ static inline void gu_read_semiplanar(const unsigned char *y_plane, unsigned yp,
                                                   const unsigned char *uv_plane, unsigned uvp,
                                                   int x, int y, int word_bytes, int chroma_vshift,
                                                   int *Y, int *U, int *V)
{
    int cy = chroma_vshift ? (y >> 1) : y;
    if (word_bytes == 1) {
        *Y = y_plane[y * yp + x];
        const unsigned char *uv = uv_plane + cy * uvp + (x & ~1);
        *U = uv[0]; *V = uv[1];
    } else {
        const unsigned short *y16 = (const unsigned short *)(y_plane + y * yp);
        *Y = y16[x] >> 8;
        const unsigned short *uv16 = (const unsigned short *)(uv_plane + cy * uvp) + (x & ~1);
        *U = uv16[0] >> 8; *V = uv16[1] >> 8;
    }
}

/* Reads one (Y, U, V) sample from a planar444 NVDEC sw_format at pixel (x, y):
 * yuv444p and its >8-bit siblings -- three separate full-resolution planes, no chroma
 * subsampling at all, structurally different from semiplanar. */
__device__ static inline void gu_read_planar444(const unsigned char *y_plane, unsigned yp,
                                                  const unsigned char *u_plane, unsigned up,
                                                  const unsigned char *v_plane, unsigned vp,
                                                  int x, int y, int word_bytes,
                                                  int *Y, int *U, int *V)
{
    if (word_bytes == 1) {
        *Y = y_plane[y * yp + x];
        *U = u_plane[y * up + x];
        *V = v_plane[y * vp + x];
    } else {
        *Y = ((const unsigned short *)(y_plane + y * yp))[x] >> 8;
        *U = ((const unsigned short *)(u_plane + y * up))[x] >> 8;
        *V = ((const unsigned short *)(v_plane + y * vp))[x] >> 8;
    }
}

#endif /* GU_COLORCONV_H */
