# Task: the rtx_cuda route to a real VSR, replacing the Maxine SDK dead end

## STATUS: gated on building the extractor ourselves (2026-09-22).

`rtx-video-re` is not obtainable, so Step 0 below is answered: it has to be built. That is now its
own project, designed in **`rtx-video-re-design.md`** - read that before this.

The short version of what changed: the extraction is **not** static analysis on Windows. The
patches say they drove the Windows DLLs **on Linux**, under custom PE loaders (`loader_ppe`, an NGX
loader), and intercepted the live CUDA Driver-API calls. CT114's RTX 3090 is sufficient hardware
for the whole thing, and capturing on it yields **sm_86** images natively - which removes the
`experimental_arch=1` unverified-band caveat further down this document for the one architecture we
care about.

Until `rtxv` produces a data dir, none of the seven filters builds: the per-feature probes in patch
`0001` are pass/fail on the data directory existing, and every filter depends on its own probe.
There is no subset that works without it.

`vf_ort.c` (Real-ESRGAN via ONNX Runtime) remains this project's working neural SR meanwhile.

Everything below stays as written and becomes live the moment a data dir exists.

---

Handover doc. Read `AGENTS.md` and `CLAUDE.md` for this project's engineering culture first, then
`VSR.md` (top section and the REOPENED section - not the retracted verdict), then
`vfx-sdk-vsr-task.md` for what the Maxine attempt cost and why it stopped.

## Why this task exists

`vf_vsr.c` (Maxine VFX SDK) is stuck: `NvVFX_Load` hangs, threads idle in `futex_do_wait`, seven
seconds of CPU across fifteen minutes of wall clock. Even if it were fixed, it might be a
multi-minute first-load compile, which is unusable for live transcoding. It is gated off in the
neural axis (`a0efc0d`) and has never produced a frame.

Meanwhile `ffmpeg-patches/` - 46 patches by Philip Langdale, the FFmpeg NVIDIA filter maintainer -
already sits untracked in this repo and contains three working super-resolution filters over three
different networks, plus four more RTX Video filters. They do not call an NVIDIA SDK at all. They
load extracted cubins, upload a weights blob, and replay a pre-computed CUDA launch list through
the driver API.

This repo's own `VSR.md` previously declared that approach a structural dead end. It was wrong, and
the correction is written up there. Do not re-run that investigation.

## What the series gives you

Seven filters on one shared `rtx_cuda.c`/`rtx_cuda.h` core (patch `0002`):

| Filter | Patch | What it is | Relevant axis here |
|---|---|---|---|
| `vsr_cuda` | 0003 | NGX SDK's VSR network | `sr` / `neural` |
| `vsr_drv_cuda` | 0005 | driver RTX VSR (AIVP), newer + heavier | `sr` / `neural` |
| `dlpp_drv_cuda` | 0006 | driver DLPP, two extra high-quality models | `sr` / `neural` |
| `isr_cuda` | 0004 | NGX Image SR | `sr` |
| `truehdr_cuda` / `truehdr_drv_cuda` | 0007/0008 | SDR->HDR inverse tone mapping | new axis |
| `deepdvc_drv_cuda` | 0009 | RTX Dynamic Vibrance | `chroma` |
| `smoothmotion_cuda` | 0010-0013 | frame doubling, native YUV | new axis |

The three SR networks produce different pictures. They are not three names for one thing.

Patches 0014-0044 are unrelated to the `rtx_cuda` core (`NvOFFRUC`, FRUC Vulkan, misc fixes) and are
not in scope. Take 0001-0013 or nothing.

## Step 0: answer the gating question before anything else

**Do not stage patches, touch `build-ffmpeg.sh`, or open `ffmpeg/` until this is settled.**

The patches are the code half only. Per `0001`, the data half - each feature's `*_cuda_gen.h`
describing the captured kernel graph, plus the cubins and the `weights.bin` it names - comes from an
out-of-tree tool called **`rtx-video-re`**, which installs into a prefix advertising itself with an
`nvidia-video-filters.pc`. `configure` reads `${feature}_datadir` from that `.pc` and probes each
feature independently, so a partial install builds a subset and the rest simply do not get built.

`rtx-video-re` is named twenty-odd times across the series and located nowhere in it. Find it, or
establish that it is not public.

1. Search for it: the FFmpeg devel list thread that carried this series, Langdale's own repos
   (`github.com/philipl`), and whatever the cover letter (patch `0046`, the merge commits) points at.
   The patches were written for people who already had the tool, so the pointer is likely one layer
   out from the series itself.
2. If it exists and runs, it wants the **Windows** driver's PPE plugins as input -
   `nvaivpx.dll` (`ppe/features/AIVP`) for `vsr_drv_cuda`, `ppe/features/DLPP` for `dlpp_drv_cuda`.
   `VSR.md`'s earlier scan of a downloaded Windows driver tree missed these; it searched for
   `__nv_relfatbin`/`__fatbin_reloc` and checked the `*vsr*`-named DLLs, which are UI-resource stubs.
   Extraction is an offline step on any machine. Nothing Windows needs to run at transcode time.
3. **If it is not public, this task stops here and reports that**, exactly as the Maxine task was
   supposed to stop at manual SDK placement. Do not attempt to write a replacement extractor - that
   is a reverse-engineering project, not a filter integration, and it is not what was asked for.

## If the data half is obtainable

### Formats and where this lands in the chain

Confirmed from `0005` rather than assumed: `vsr_drv_cuda` is `FILTER_SINGLE_PIXFMT(AV_PIX_FMT_CUDA)`
- genuinely hw-frame-native, which is what `hw-resident-encode-plan.md`'s Tier 1 wanted and what
`vf_vsr.c` never settled. Its sw formats are **packed RGB only** (`rgb0` and friends) on both sides.

That has a direct consequence worth planning for before writing any C#: NVENC takes `nv12`/`p010`,
so this filter's output **cannot feed the encoder directly**. The chain needs a `scale_cuda` back to
`nv12` after it. That is still fully GPU-resident, so it is a cost in one extra pass, not a system
memory round trip - but it is not free and the chain builder has to emit it.

### Arch gate: read this before promising anything on CT114

`hard_min_major = 8`. CT114's RTX 3090 is sm_86, so it clears the floor - but the graphs were
validated byte-exact on Ada (sm_89) and Blackwell (cc 12.x) only, and sm_86 runs the sm_80 image.
It requires `experimental_arch=1`, and the output is nobody's verified reference.

Treat that as a real finding, not a formality. "It ran" and "it produced the right picture" are
different claims here and this project has been burned by conflating them. If it ships, it ships
off by default with the unverified-arch status in its `-filters` description string, the same way
`vf_dlss.c` honestly says DEGRADED.

### Build wiring

Five filters must survive. `scripts/proxmox-build.sh --with-ffmpeg` already refuses to deploy an
ffmpeg missing any of them and keeps `<binary>.prev` - do not weaken that check to make room, add
to it. After a rebuild, `-filters` must show the original five plus whatever landed here.

- Patches 0001-0013 apply to FFmpeg upstream, not to this repo's `ffmpeg/000N-*.patch` series. Work
  out the ordering against the vendored tree before staging; do not assume they commute with 0001-0005.
- New `WITH_RTXCUDA` flag in `build-ffmpeg.sh` following `WITH_OPTIX`/`WITH_ORT`/`WITH_DLSS`: a
  `pkg-config nvidia-video-filters` existence check up front, failing in seconds rather than twenty
  minutes in. The per-feature `nvfdata_*` probes are `configure`'s job, not the script's.
- **Delete `ffmpeg/rtx_cuda.h`.** It is a hand-written approximation of the contract in `0002`,
  written before the real one was on disk, and keeping both invites someone to build against the
  wrong one. Its file header already says so.

### Plugin wiring

Standard checklist from `CLAUDE.md` - `PluginConfiguration.cs`, the `UpscaleSettings.cs` mirror,
`configPage.html` control **and** its load/save lines, the probe, and `UpscaleEngine.Option()`
actually reading the parameter. A control whose parameter nothing reads is dead UI.

Then prove the whole chain before believing any of it, because this project's recurring failure is
something that renders, is stored, and is never sent:

```
panel selection -> localStorage -> addParams writes the param -> param in TranscodingUrl
  -> Option() reads it -> the BUILT FFMPEG COMMAND changes -> session record reports it
```

`journalctl -u jellyfin | grep vsr_drv` is the whole audit. Check the reverse too: at off, the
filter must **not** appear in the command.

Whether this is a new `sr` level or a new axis is a real decision, not a formality. Three networks
with different pictures under one `sr` level would be a lie; one axis with three levels is probably
right. Justify whichever you pick.

## Guardrails

- Never restart `jellyfin.service` on CT114. Never touch the live plugin config XML. Always
  `--no-activate`. Verification is standalone `ffmpeg` invocations.
- Someone may be watching something. Check before anything that ends transcodes. Stop your own
  sessions by id; never kill ffmpeg indiscriminately.
- If a rebuild regresses any of the five existing filters: restore `.prev`, re-verify with smoke
  tests, report as failed. Do not leave the box degraded.
- The extracted cubins and weights are proprietary NVIDIA artifacts. They are a runtime dependency
  placed by hand, the same shape as the DLSS `.so` blob (see `DLSS.md`) - **not vendored into this
  GPL tree**, not committed, not redistributed. Read whatever licence ships with them before
  shipping anything built against them.
- Do not fabricate a data directory, substitute another feature's weights, or stub a graph to make
  something pass. That is the exact failure mode `vf_dlss.c`'s CUDA investigation refused.

## Docs to update when done

1. `VSR.md` - the REOPENED section becomes a status section once there is a status.
2. `ARCHITECTURE.md` - per-filter backend table row, CUDA and hw-frame-native, plus the Tier 1 note
   and the `scale_cuda`-to-`nv12` requirement.
3. `NEURAL.md` - an fps number at a representative resolution. Minimum bar, not optional; this
   project's `improvements.md` keeps warning about the pile of unmeasured additions.
4. `improvements.md` - an entry if it becomes shippable.
5. `livetestbox.md` - full command log (local only, gitignored, not committed).

## Report back

Concisely: is `rtx-video-re` obtainable, did the data half extract for which features, did the
filters build, did the five existing ones survive, did a frame actually come out at the right
dimensions, what is the fps, and what state is CT114's ffmpeg binary in right now. "Deployed and
restarted cleanly" is not "a served segment came back at 1920x1080".
