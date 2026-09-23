# RTX VSR bypass resampler as a video filter (`vsr_rtcuda`) — opt-in, unverified in production

`upscale=rtxvsr` (not wired into `UpscaleEngine` yet; today this filter exists and builds in a
scratch prefix, but is **not plumbed into the plugin's 5-place checklist** — same "where this
stands" caveat as `RTXDLPP.md`) would run a fast, GPU-resident resampler hosted live via our own
PE loader against a user-supplied `nvaivpx.dll`. Same architecture family as RTX DLPP
(`dlpp_rtcuda`, see `RTXDLPP.md`): `vf_vsr_rtcuda.c` links nothing NVIDIA at compile time — it
maps the DLL at *run time* through its own copy of the PE32+ loader (`gu_vsr_pe_map.c`,
`gu_vsr_aivp_loader.c`, `gu_vsr_ngx_isr.c` — forked from the same `rtx-video-re` origin as the
DLPP promotion's `gu_dlpp_*` files, but copied independently so neither filter's build depends on
the other's files existing).

This is Route A of the "Track C" work in `TASK.md`. `ffmpeg-patches/0005` reserves the filter
name `vsr_drv_cuda` for a DIFFERENT, unrelated Route B implementation (driving the DXVA/PPE
plugin directly, not through the AIVP export table). The two do not collide and are not the same
project — hence this filter is `vsr_rtcuda`, not `vsr_drv_cuda`.

**Advanced, opt-in, off by default.** `WITH_RTXVSR=0` unless set. Not added to
`scripts/proxmox-build.sh`'s mandatory five-filter list — a rebuild there still only requires
`vf_oidn`, `vf_optix`, `vf_ort`, `vf_fsr2`, `vf_dlss`.

## What it is, and what it is not

`nvaivpx.dll` (AIVP, "RTX VSR" in the driver package) is reached through the same PPE export-
table calling convention as RTX DLPP. **Its role here is fixed: a fast, better-than-bicubic GPU
resampler, NOT a neural upscaler.** Sixteen agent-rounds this session established AIVP's own
network path never contributes real detail regardless of parameters (see `TASK.L17.md`, "Status:
RETIRED as a neural target"). The bypass mode this filter runs unconditionally (params+0x08 flags
= 0x100, network entirely skipped) is what ships: verified 0.08 ms/frame, GPU-resident, and beats
plain bicubic in quality (43.93 dB vs 41.66 dB in an earlier test). There is no option, environment
variable, or code path anywhere in `vf_vsr_rtcuda.c` or `gu_vsr_embed.c` that re-enables the
network path — bypass is hardcoded in `gu_vsr_embed.c`'s `build_params()`.

## What you must fetch yourself

| what | from | licence |
|---|---|---|
| `nvaivpx.dll` | a real NVIDIA GeForce/Studio driver package for Linux or Windows (7z-extractable) | NVIDIA proprietary |

Install it by hand:

```bash
mkdir -p /usr/lib/jellyfin-ffmpeg-oidn/rtxvsr/dll
cp nvaivpx.dll /usr/lib/jellyfin-ffmpeg-oidn/rtxvsr/dll/
```

**Until that file is present, this filter's init-time self-test fails and FFmpeg refuses to build
any chain containing it** — see "Self-test / gate" below.

## Licensing — NOTHING FROM NVIDIA IS IN THIS REPOSITORY

`ffmpeg/vf_vsr_rtcuda.c`, `ffmpeg/gu_vsr_embed.[ch]`, `ffmpeg/gu_vsr_pe_map.c`,
`ffmpeg/gu_vsr_aivp_loader.c`, `ffmpeg/gu_vsr_ngx_isr.c` and `ffmpeg/gu_vsr_nv12_rgba.ptx` are
**our own code**, LGPL-2.1-or-later, and contain no NVIDIA material — the PE loader is a
from-scratch minimal PE32+/Win64-ABI shim, and the PTX is hand-written CUDA assembly for
NV12<->RGBA conversion, not extracted from any SDK or sample. `nvaivpx.dll` itself is NVIDIA
proprietary, **not vendored, and must not be**: it is loaded at run time from a path the user
supplies, exactly the same trust boundary as `<prefix>/dlss` (see `DLSS.md`) and `<prefix>/rtxdlpp`
(see `RTXDLPP.md`). No NVIDIA binary, cubin, weight, or DLL of any kind is ever committed to this
repository.

## Self-test / gate at init

`config_props` (called once, before the first real frame) runs the following before FFmpeg is
allowed to build a chain containing this filter, the same fail-at-init discipline as
`FFRtxArchGate` (`ffmpeg-patches/0002`) and the RTXDLPP promotion:

1. Map `nvaivpx.dll`'s PE32+ image and set up the loader's TEB/TLS shim.
2. Call `CreateInstance` through the DLL's own PPE export table.
3. Run one real `Process` call, in bypass mode, against the already-allocated input/output
   surfaces (`gu_vsr_embed_selftest()`).

If any step fails, `av_log(AV_LOG_ERROR, ...)` names exactly which one, and `config_props` returns
`AVERROR_EXTERNAL` — FFmpeg then refuses to build the filter chain rather than continuing with a
half-initialised filter.

**Driver-version check:** every init computes an FNV-1a-32 hash of the raw `nvaivpx.dll` file and
logs it (`av_log(AV_LOG_INFO, "vsr_rtcuda self-test ok, nvaivpx.dll fnv1a32=%08x", ...)`) on
success, and includes it in the error message on failure. Not an allow/deny gate — a support
report can show exactly which DLL build a run was against.

## Where this stands

This filter builds standalone from this repo and has been smoke-tested in a scratch build (see
`TASK.md` for the exact commands and results). It is **not** wired into `UpscaleEngine.Option()`,
the probe, the dashboard, or the client — none of the plugin's 5-place checklist has been touched.
`WITH_RTXVSR=1` in `scripts/build-ffmpeg.sh` produces a binary that registers and runs the filter
directly with `ffmpeg -vf vsr_rtcuda=...`; it does not yet make `vsr_rtcuda` reachable from a
Jellyfin session. That plumbing is a later step.

## Building it

```bash
WITH_RTXVSR=1 sudo -E ./scripts/build-ffmpeg.sh
# or combined with the mandatory five:
WITH_OPTIX=1 WITH_ORT=1 WITH_FSR2=1 WITH_DLSS=1 WITH_RTXVSR=1 sudo -E ./scripts/build-ffmpeg.sh
```

`WITH_RTXVSR=1` preflights that `<prefix>/rtxvsr/dll/nvaivpx.dll` exists (override with
`RTXVSR_DLL=/path/to/nvaivpx.dll`), then wires the filter into the freshly-fetched FFmpeg tree the
same way `WITH_RTXDLPP` does: no numbered `.patch` file, direct edits to `libavfilter/Makefile`
and `libavfilter/allfilters.c` before `./configure` runs (this is a pristine release tarball,
so `./configure` itself generates `filter_list.c` / `config.mak` / `config_components.h` from
whatever externs it finds — see the comment above the `WITH_RTXDLPP` wiring block in
`build-ffmpeg.sh` for why that matters here too).

Check it:

```bash
<prefix>/ffmpeg -hide_banner -filters | grep vsr_rtcuda
# with the DLL in place:
<prefix>/ffmpeg -hwaccel cuda -hwaccel_output_format cuda -i in.mp4 \
  -vf vsr_rtcuda=w=3840:h=2160 -f null -
```

## Flag naming

`WITH_RTXVSR`, not a shared `WITH_RTXCUDA` covering both this filter and RTXDLPP's `WITH_RTXDLPP`.
Reasoning: the two filters have independent, non-overlapping preflight checks (different DLL,
different loader-file set — each forked rather than shared, see "What it is" above) and each opt-
in flag should fail with a message naming exactly which DLL/file set is missing. A shared flag
would either check both DLLs unconditionally (forcing a VSR-only build to also stage the DLPP DLL)
or need a second variable to say which sub-feature is wanted, which is more surface for no benefit
over two independent `WITH_*` flags following this project's existing per-filter convention
(`WITH_OPTIX`, `WITH_ORT`, `WITH_FSR2`, `WITH_DLSS`, `WITH_RTXDLPP`).
