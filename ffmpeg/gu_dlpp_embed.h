/*
 * gu_dlpp_embed.h: promoted from the `rtx-video-re` spike (`ffmpeg-spike/dlpp_embed.h`),
 * renamed on the way in (was `dlpp_embed.h`) to avoid any confusion with the scratch tree.
 * No functional change from the spike: the loader (gu_dlpp_pe_map.c, which itself pulls in
 * gu_dlpp_aivp_loader.c and gu_dlpp_ngx_isr.c) as a library for vf_dlpp_rtcuda.c, targeting
 * nvdlppx.dll (DLPP) via run_dlpp() and DLPP's own 0x50-byte Process param struct. Same
 * worker-thread design as the AIVP-era embed it was copied from: every call into the DLL runs
 * on one thread that owns the fake TEB and PE TLS, so the host's own threads never see %gs
 * change. The host owns the CUDA context and stream.
 *
 * DLPP's Process param struct is 0x50 bytes (vs AIVP's 0x44) -- see TASK.md "Track B: DLPP"
 * agent 14. This embed bakes in the two confirmed fixes as unconditional defaults, not env-var
 * overrides:
 *   +0x10 (wipe/split-screen-preview) = 0.0 always (100% enhanced output; this filter has no
 *     reason to ever show the comparison split).
 *   +0x38 (native-scale float) = the actual output/input width ratio, set only for quality
 *     level >= 3 (levels 1/2 ignore this field and leaving it zero at those levels is
 *     confirmed safe).
 *
 * Our own code (loader shim + glue), no NVIDIA material. See RTXDLPP.md for what you must
 * supply yourself and from where.
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
#ifndef GU_DLPP_EMBED_H
#define GU_DLPP_EMBED_H
#include <stdint.h>

/* Maps the DLL, creates one DLPP instance on ctx/stream, allocates RGBA8
 * surface-backed CUDA arrays for w x h in and ow x oh out. level is DLPP's
 * quality level (params+0x0c); scale is the native-scale value written to
 * params+0x38 when level >= 3 (ignored at level 1/2). inject (optional,
 * w*h*4 bytes RGBA) is uploaded into the input array once. Returns 0 on
 * success and the two CUsurfObject handles. */
int gu_dlpp_embed_init(const char *dll, void *cu_ctx, void *cu_stream,
                       unsigned w, unsigned h, unsigned ow, unsigned oh,
                       unsigned level, float scale,
                       const void *inject, uint64_t *in_surf, uint64_t *out_surf);

/* One Process call, enqueued on the host stream. No sync. */
int gu_dlpp_embed_process(void);

/* Reads the output array back and writes it as P6 PPM (the harness's format).
 * Debug only: this is the one DtoH in the filter. Caller syncs first. */
int gu_dlpp_embed_dump_ppm(const char *path);

/* JIT-loads PTX with the error log on stderr. Context must be current. */
int gu_dlpp_embed_load_ptx(const char *ptx, void **module);

/* Host-callback counters (19 slots: 1 = alloc, 9 = HtoD, 8 = launch). */
void gu_dlpp_embed_cb_calls(uint64_t out[19]);

/* Self-test: after init, run one Process call against a small synthetic
 * frame and report whether the DLL came back cleanly, plus the version
 * string/hash the init-time gate should log. path/version_out sized by
 * caller (>=64 bytes is enough for the digest text). Returns 0 on a clean
 * self-test, nonzero otherwise -- the caller (config_props) treats nonzero
 * as fatal, matching FFRtxArchGate's fail-at-init pattern (ffmpeg-patches/
 * 0002). Safe to call only once, right after gu_dlpp_embed_init succeeds
 * and before the first real frame. */
int gu_dlpp_embed_selftest(char *version_out, size_t version_out_len);

void gu_dlpp_embed_close(void);
#endif
