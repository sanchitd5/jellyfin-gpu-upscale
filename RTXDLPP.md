# RTX DLPP super-resolution as a video filter (`dlpp_rtcuda`) — opt-in, unverified in production

`upscale=rtxdlpp` (once wired into `UpscaleEngine`; today this filter exists and builds, but is
**not yet plumbed into the plugin's 5-place checklist** — see "Where this stands" below) would run
**RTX DLPP**, hosted live via our own PE loader against a user-supplied `nvdlppx.dll`. This is a
genuinely different architecture from every other filter in this repo: `vf_oidn.c`, `vf_optix.c`,
`vf_ort.c`, `vf_fsr2.c` and `vf_dlss.c` all link an NVIDIA-published SDK at compile time.
`vf_dlpp_rtcuda.c` links nothing NVIDIA at all — it maps a Windows DLL the user places themselves,
at *run time*, through `gu_dlpp_pe_map.c` (our own from-scratch PE32+ loader), and calls into it
directly. This is Route A of the "Track B: DLPP" work in `TASK.md`; a separate, unrelated Route B
(capture + codegen) is reserved under the filter name `dlpp_drv_cuda` in `ffmpeg-patches/0006`. The
two do not collide and are not the same project.

**Advanced, opt-in, off by default.** `WITH_RTXDLPP=0` unless set. Not added to
`scripts/proxmox-build.sh`'s mandatory five-filter list — a rebuild there still only requires
`vf_oidn`, `vf_optix`, `vf_ort`, `vf_fsr2`, `vf_dlss`.

## What it is

DLPP is an NVIDIA neural super-resolution network shipped inside the display driver package as
`nvdlppx.dll`, reached through the same PPE export-table calling convention as RTX VSR/AIVP
(`nvaivpx.dll`). `gu_dlpp_pe_map.c` maps the DLL's PE32+ image, sets up a fake Windows TEB and PE
thread-local storage so the DLL's own `%gs`-relative code works on Linux, resolves `ppeGetVersion`
and `ppeGetExportTable`, and calls `CreateInstance` and `Process` through the DLL's own function
pointers — never disassembling or copying anything out of the DLL itself into this repository.

Two harness bugs (found and fixed during the spike, see `TASK.md` "Track B: DLPP" agents 3–5) are
baked into `gu_dlpp_embed.c` as unconditional defaults: the split-screen "wipe" field is always
0.0 (100% enhanced output, never the comparison split), and the native-scale field is auto-derived
from the actual output/input ratio for quality levels 3 and 4 (levels 1/2 ignore it).

Verified end to end on real library content (Rick and Morty S09E06, native 1080p): GPU-resident
(zero per-frame host↔device copies across 10,790 frames), 113 fps at 1080p→4K, PSNR within 0.5 dB
of the standalone harness's own measurement for the same content/level. **The gain is real but
content-dependent and modest** — never negative across the six frames tested, but not a dramatic
jump either. See `TASK.md` for the numbers; do not restate them from memory when tuning defaults.

## What you must fetch yourself

| what | from | licence |
|---|---|---|
| `nvdlppx.dll` | a real NVIDIA GeForce/Studio driver package for Linux or Windows (7z-extractable; `Display.Driver/nvdlppx.dll` in the package this was verified against) | NVIDIA proprietary |

Nothing else. No headers, no SDK, no import library — the loader resolves everything it needs from
the DLL's own PE export table and a 16-byte interface IID this project already found
(`90850b61-4bdb-5e80-3a56-82aa26669574`, in `gu_dlpp_aivp_loader.c`'s `run_dlpp()`), the same way
`ppeGetExportTable` is called for RTX VSR/AIVP.

Verified here against driver **617.14** on an RTX 3090 (Ampere), CT114.

Install it by hand:

```bash
mkdir -p /usr/lib/jellyfin-ffmpeg-oidn/rtxdlpp/dll
cp nvdlppx.dll /usr/lib/jellyfin-ffmpeg-oidn/rtxdlpp/dll/
```

**Until that file is present, this filter's init-time self-test fails and FFmpeg refuses to build
any chain containing it** — see "Self-test / gate" below. There is no availability probe wired into
the plugin yet (see "Where this stands"); today this is a build-and-smoke-test-only filter.

## Licensing — NOTHING FROM NVIDIA IS IN THIS REPOSITORY

`ffmpeg/vf_dlpp_rtcuda.c`, `ffmpeg/gu_dlpp_embed.[ch]`, `ffmpeg/gu_dlpp_pe_map.c`,
`ffmpeg/gu_dlpp_aivp_loader.c`, `ffmpeg/gu_dlpp_ngx_isr.c` and `ffmpeg/gu_dlpp_nv12_rgba.ptx` are
**our own code**, LGPL-2.1-or-later, and contain no NVIDIA material — the PE loader is a from-
scratch minimal PE32+/Win64-ABI shim, and the PTX is hand-written CUDA assembly for NV12↔RGBA
conversion, not extracted from any SDK or sample. `nvdlppx.dll` itself is NVIDIA proprietary,
**not vendored, and must not be**: it is loaded at run time from a path the user supplies, exactly
the same trust boundary as `<prefix>/dlss` for the DLSS runtime blob (see `DLSS.md`). No NVIDIA
binary, cubin, weight, or DLL of any kind is ever committed to this repository.

## Self-test / gate at init

`config_props` (called once, before the first real frame) runs the following before FFmpeg is
allowed to build a chain containing this filter, mirroring this project's own `FFRtxArchGate`
(`ffmpeg-patches/0002`) fail-at-init discipline rather than crashing mid-stream or running
degraded silently:

1. Map `nvdlppx.dll`'s PE32+ image and set up the loader's TEB/TLS shim.
2. Call `CreateInstance` through the DLL's own PPE export table.
3. Run one real `Process` call against the already-allocated input/output surfaces
   (`gu_dlpp_embed_selftest()`).

If any step fails, `av_log(AV_LOG_ERROR, ...)` names exactly which one, and `config_props` returns
`AVERROR_EXTERNAL` — FFmpeg then refuses to build the filter chain rather than continuing with a
half-initialised filter.

**Driver-version check:** exact-match against a single verified DLL would be too strict for real
deployments (this loader has been checked against exactly one driver release so far). Instead,
every init computes an FNV-1a-32 hash of the raw `nvdlppx.dll` file and logs it
(`av_log(AV_LOG_INFO, "dlpp_rtcuda self-test ok, nvdlppx.dll fnv1a32=%08x", ...)`) on success, and
includes it in the error message on failure. A support report can show exactly which DLL build a
run was against; nothing here allowlists or blocks a hash today, since there is no second verified
build yet to compare against. Revisit if a driver update changes the hard-coded struct offsets
(`+0x10`, `+0x38`, the 0x50-byte param size) — the self-test's `Process` call is the thing that
would actually catch that at init rather than corrupting output mid-stream.

The `-filters` description string carries the honest `DEGRADED` note this project's convention
requires (see `vf_dlss.c`): content-dependent, modest gain, and the levels 3/4 native-scale path
verified only at exact integer ratios so far.

## Where this stands

This filter builds standalone from this repo and has been smoke-tested in a scratch build (see
`TASK.md` "Track B: DLPP" for the exact commands and results). It is **not** wired into
`UpscaleEngine.Option()`, the probe, the dashboard, or the client — none of the plugin's 5-place
checklist has been touched. `WITH_RTXDLPP=1` in `scripts/build-ffmpeg.sh` produces a binary that
registers and runs the filter directly with `ffmpeg -vf dlpp_rtcuda=...`; it does not yet make
`dlpp_rtcuda` reachable from a Jellyfin session. That plumbing is the next step.

## Building it

```bash
WITH_RTXDLPP=1 sudo -E ./scripts/build-ffmpeg.sh
# or combined with the mandatory five:
WITH_OPTIX=1 WITH_ORT=1 WITH_FSR2=1 WITH_DLSS=1 WITH_RTXDLPP=1 sudo -E ./scripts/build-ffmpeg.sh
```

`WITH_RTXDLPP=1` preflights that `<prefix>/rtxdlpp/dll/nvdlppx.dll` exists (override with
`RTXDLPP_DLL=/path/to/nvdlppx.dll`), then wires the filter into the freshly-fetched FFmpeg tree the
same way the spike's own `build.sh` wires `dlpp_spike` into its scratch tree: no numbered `.patch`
file, direct edits to `libavfilter/Makefile`, `libavfilter/allfilters.c`,
`libavfilter/filter_list.c` (the actual array `av_filter_iterate()` walks — the `allfilters.c`
extern alone never runs a filter without an entry here too), and `ffbuild/config.mak` /
`config_components.h` for the `CONFIG_DLPP_RTCUDA_FILTER` define `./configure` does not know how to
generate for a filter it was never told about.

Check it:

```bash
<prefix>/ffmpeg -hide_banner -filters | grep dlpp_rtcuda
# with the DLL in place:
<prefix>/ffmpeg -hwaccel cuda -hwaccel_output_format cuda -i in.mp4 \
  -vf dlpp_rtcuda=level=1 -f null -
```
