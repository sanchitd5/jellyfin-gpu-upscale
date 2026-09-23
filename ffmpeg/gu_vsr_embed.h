/*
 * gu_vsr_embed.h: promoted from the personal `rtx-video-re` spike (`ffmpeg-spike/aivp_embed.h`),
 * renamed on the way in (was `aivp_embed.h`). The loader (gu_vsr_pe_map.c, which itself pulls in
 * gu_vsr_aivp_loader.c and gu_vsr_ngx_isr.c) as a library for vf_vsr_rtcuda.c, targeting
 * nvaivpx.dll (RTX VSR / AIVP) via run_aivp() and AIVP's own 0x44-byte Process param struct.
 * Every call into the DLL runs on one worker thread that owns the fake TEB and PE TLS, so the
 * host's own threads never see %gs change. The host owns the CUDA context and stream.
 *
 * This filter's role is fixed to the bypass (fast-resampler) path only: AIVP's network path
 * (params+0x08 flags) never contributed real detail regardless of parameters -- sixteen
 * agent-rounds of this session's own testing retired it, see TASK.L17.md "Status: RETIRED as a
 * neural target". Bypass (flags = 0x100, which skips the network entirely) is verified faster
 * than and better-quality than plain bicubic (0.08 ms/frame, 43.93 dB vs 41.66 dB). gu_vsr_embed.c
 * hardcodes flags = 0x100 unconditionally -- there is no env var or option anywhere in this file
 * or vf_vsr_rtcuda.c that can turn the network path back on. See RTXVSR.md.
 *
 * Our own code (loader shim + glue), no NVIDIA material. See RTXVSR.md for what you must supply
 * yourself and from where.
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
#ifndef GU_VSR_EMBED_H
#define GU_VSR_EMBED_H
#include <stdint.h>

/* Maps the DLL, creates one AIVP instance on ctx/stream in the fixed bypass mode (see the file
 * header above -- there is no parameter here to ask for the network path), allocates RGBA8
 * surface-backed CUDA arrays for w x h in and ow x oh out. inject (optional, w*h*4 bytes RGBA)
 * is uploaded into the input array once. Returns 0 on success and the two CUsurfObject
 * handles. */
int gu_vsr_embed_init(const char *dll, void *cu_ctx, void *cu_stream,
                      unsigned w, unsigned h, unsigned ow, unsigned oh,
                      const void *inject, uint64_t *in_surf, uint64_t *out_surf);

/* One Process call, enqueued on the host stream. No sync. */
int gu_vsr_embed_process(void);

/* Reads the output array back and writes it as P6 PPM (the harness's format).
 * Debug only: this is the one DtoH in the filter. Caller syncs first. */
int gu_vsr_embed_dump_ppm(const char *path);

/* JIT-loads PTX with the error log on stderr. Context must be current. */
int gu_vsr_embed_load_ptx(const char *ptx, void **module);

/* Host-callback counters (19 slots: 1 = alloc, 9 = HtoD, 8 = launch). */
void gu_vsr_embed_cb_calls(uint64_t out[19]);

/* Self-test: after init, run one Process call against a small synthetic frame and report
 * whether the DLL came back cleanly, plus the version string/hash the init-time gate should
 * log. version_out sized by caller (>=64 bytes is enough for the digest text). Returns 0 on a
 * clean self-test, nonzero otherwise -- the caller (config_props) treats nonzero as fatal,
 * matching FFRtxArchGate's fail-at-init pattern (ffmpeg-patches/0002). Safe to call only once,
 * right after gu_vsr_embed_init succeeds and before the first real frame. */
int gu_vsr_embed_selftest(char *version_out, size_t version_out_len);

void gu_vsr_embed_close(void);
#endif
