# Working on this codebase

Guidance for AI coding agents (and humans who like their invariants written down). This project
patches a running media server, so mistakes here break other people's playback rather than failing
a test. Read the invariants before changing anything.

## What this is

A Jellyfin plugin that injects a filter chain into transcodes for realtime super-resolution,
sharpening and denoising. It works by runtime-patching Jellyfin with Harmony, because Jellyfin
exposes no plugin hook for the video filter graph.

It started as libplacebo GLSL user shaders alone. It is now two things: those shaders, plus **five
mandatory custom ffmpeg video filters** carried by a separately built binary beside the stock one.
Both halves reach the same command line and compose, so a change in one can silently alter the
other. Two more filters, `dlpp_rtcuda` and `vsr_rtcuda`, exist in the same binary and build clean
(commits `82bab39`, `fc999dd`) but are opt-in (`WITH_RTXDLPP`/`WITH_RTXVSR`, off by default), not
part of the mandatory five, and NOT yet wired into the plugin's 5-place checklist below or into
`UpscaleEngine` at all - see `TASK.md` ("Track B: DLPP", "Track C"), `RTXDLPP.md`, `RTXVSR.md`, and
`INTEGRATION_DESIGN.md` for the proposed wiring.

Layout:

```
src/                    plugin assembly (loads into Jellyfin's collectible ALC)
src/patcher/            patcher assembly (loads into the DEFAULT ALC, this is where Harmony lives)
src/Configuration/      settings class + the dashboard page
web/gpu-upscale.js      injected browser script: the Enhance panel + request marking
ffmpeg/vf_*.c           the five custom filters, plus their build patches and gen_perm.py
shim/                   standalone ffmpeg wrapper, the no-Harmony fallback
shaders/                CAS shaders (ours, superseded) + the RCAS derivation script
scripts/                install, inject, activate/rollback, build-ffmpeg.sh
```

Per-filter background lives in [OIDN.md](OIDN.md), [OPTIX.md](OPTIX.md), [NEURAL.md](NEURAL.md),
[FSR2.md](FSR2.md) and [DLSS.md](DLSS.md); deployment in [INSTALL.md](INSTALL.md). The two opt-in
filters live in [RTXDLPP.md](RTXDLPP.md) and [RTXVSR.md](RTXVSR.md); the retired Maxine VSR
investigation (superseded by `vsr_rtcuda`) is in [VSR.md](VSR.md). Active investigation and
findings for both tracks are in `TASK.md`; the retired AIVP neural-path investigation is in
`TASK.L17.md`; the GPU-residency roadmap this filter/backend map feeds is in
[roadmap/](roadmap/driver-features.md) and [roadmap/gpu-only-filters.md](roadmap/gpu-only-filters.md).

## Invariants — do not break these

**1. The patcher assembly must live outside the plugin directory.**
Jellyfin loads plugins into a collectible `AssemblyLoadContext`; Harmony cannot emit detours against
one (`Resolving to a collectible assembly is not supported`). Jellyfin also enumerates plugin DLLs
with `SearchOption.AllDirectories`, so a *subfolder* is not far enough away. The patcher ships to
`/usr/lib/jellyfin-gpuupscale/`. The two sides exchange only primitives — JSON strings and an
`object`-typed logger. Never let a shared type cross that boundary.

**2. Lib.Harmony must be 2.4.2+.** 2.4.1 refuses .NET 10 outright.

**3. The five core `EncodingHelper` patches stay all-or-nothing.**
They are interdependent: the filter patch emits a chain that only works because the hwaccel patch
supplied a Vulkan device and the decoder patches left frames in system memory for `hwupload`. A
partial install produces ffmpeg command lines that *fail*, which is worse than no enhancement. If a
core method cannot be resolved, patch nothing and leave Jellyfin alone. Optional patches install
separately, after the core set is live, each in its own try/catch.

**4. Every patch fails safe.** A throw inside a postfix must leave Jellyfin's own value in place.
Enhancement is a luxury; playback is not.

**5. `/usr/lib/jellyfin-gpuupscale/gpu-upscale.js` is the canonical client script.**
The injector copies it into `/usr/share/jellyfin/web/`. Editing the web copy directly gets silently
reverted on the next inject *while the cache-buster still advances*, so browsers cache the old script
under a new URL. This has already caused one "all the options vanished" incident. Edit the canonical
copy, then run the injector.

Inside that script, **find things by shape, never by name.** `window.playbackManager` does not exist
in jellyfin-web 12.1; the only file in the entire web tree naming it was this script's own code. The
panel's live re-apply and its auto-close on playback stop both silently never ran for a whole session
because of it. Locate the player as an export carrying the methods you need (`setMaxStreamingBitrate`
plus `getMaxStreamingBitrate` plus `currentItem`) inside the modules the script already wraps. Shapes
survive minification and module renumbering; names and ids do not.

**6. Per-session options travel as lowercase query parameters.**
Jellyfin's `ParseStreamOptions` copies every lowercase-initial query param into `StreamOptions`,
readable with `GetOption(...)`, and nothing clamps them. A *bitrate* would not survive — Jellyfin
clamps it to source bitrate before `EncodingHelper` sees it. An earlier sentinel-bitrate design was
abandoned for exactly that reason. Do not reintroduce it.

**7. Reporting must never overstate.** The session endpoint and playback-info row report what the
server actually did, with explicit negative statuses (`concurrency-cap`, `subtitle-burn-in`,
`stream-copy`, `not-requested`, `ineligible`). A viewer told "Upscaled 4K" while receiving an
untouched copy is worse than being told nothing. If you add a feature, add its honest negative case.

**8. Eligibility logic lives in one place.** `UpscaleEngine.WouldEnhanceSource` is shared by the
decision path and the direct-play override. If they diverge, the override forces expensive transcodes
for material the engine then declines to enhance.

**9. Hook points decide filter order, not file order — know which is which.**
FSRCNNX hooks `LUMA`; Anime4K hooks `MAIN`; RCAS hooks `LUMA`; the old CAS hooks `MAIN`. When two
passes hook the *same* point, concatenation order decides. When they hook different points, the
hook points decide and file order is irrelevant. This is why Anime4K + RCAS sharpens *before*
enlarging regardless of how the file is composed — that pairing was measured and kept because it
still beat CAS-after, but the reasoning must be checked, not assumed, whenever a shader is added.

**10. The patched ffmpeg binary is separate, and all five mandatory filters must survive a
rebuild.** `vf_oidn`, `vf_optix`, `vf_ort`, `vf_fsr2` and `vf_dlss` live in a binary beside the
stock `jellyfin-ffmpeg`, which is never modified. The shim routes a session there only when it
asks for a filter that binary alone provides, and it asks the binary which filters it actually
carries, stripping chain nodes it lacks. So a rebuild that quietly drops a `vf_*.c` degrades to
unenhanced playback rather than failing every session, which means **nothing will tell you it
happened**. Check `-filters` after every rebuild. `scripts/proxmox-build.sh` keeps the previous
binary at `<binary>.prev` on success as well as on failure, so there is something to fall back to
when a build lists all five filters and one of them then fails against the driver. The opt-in
`dlpp_rtcuda`/`vsr_rtcuda` filters build into the same binary but are not in this mandatory set and
not in the shim's own `PATCHED_FILTERS` tuple yet - compiled and present via `-filters` is not the
same as reachable from a real session; see `TASK.md` for that gap. The shim also re-probes the
binary's filter list per invocation, keyed by its mtime/size, and fails open to stock ffmpeg on any
problem - so a binary swap needs no Jellyfin restart to go live, which cuts the other way too: a
broken rebuild degrades every session silently the moment it's staged, restart or not.

**Presence is not capability, and the two binaries differ in BOTH directions.** The probe asks which
filters exist. It cannot ask whether one runs. `nlmeans_vulkan` exists in both binaries and, until
the shaderc fix, compiled its shader only in the stock one, so a session combining a Vulkan denoise
with a patched-only filter routed to the patched binary and died with FFmpeg exit 234. A dead stream,
not a degraded picture. When adding a filter that compiles anything at run time, assume the two
builds disagree until a test on the actual binary says otherwise, and keep the engine's guard that
drops the conflicting pass and reports it.

**11. An axis is only real when `UpscaleEngine.Option(state, ...)` reads it.**
Fourteen parameters reach the command today: `upscale`, `sr`, `deblur`, `denoise`, `deblock`,
`neural`, `game`, `refine`, `chroma`, `deband`, `kernel`, `jitter`, `depth`, `reactive`. A control that renders, stores
a preference and sends a parameter nothing reads is dead UI that reports success. Do not ship one.
The client is data-driven on purpose: a new level is one entry in an options array, a new axis is one
`CONTROLS` entry plus one `LIVE_ROWS` line, and display names come from the probe rather than from
JavaScript. Adding the server side is the part that is easy to forget.

**12. RCAS sharpness is inverted and clamped.** `0.0` is maximum, larger is gentler, and the shader
hard-clamps to `[0, 2]` — a value above 2.0 silently does nothing. Any viewer-facing "low/medium/
high" must map through that inversion or the labels lie.

## Verification standards

**Building is not evidence. Logs are weak evidence. Probe the bytes.**

```bash
/usr/lib/jellyfin-ffmpeg/ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height -of csv=p=0 /var/cache/jellyfin/transcodes/<id>0.ts
```

A served segment larger than the source is the only proof that upscaling happened. A Harmony patch
can resolve by name and have changed meaning; no log line will reveal that.

Always test the **negative** cases too: with the feature off, output must take the stock path
untouched. Several real bugs here only appeared as "the fix works but so does the no-op".

**When a viewer-facing option "does not work", prove the whole chain before theorising.** The
recurring bug in this project is something that renders, is stored, and is never sent:

```
panel selection -> localStorage -> addParams writes the param -> param in TranscodingUrl
  -> server Option() reads it -> the BUILT FFMPEG COMMAND changes -> session record reports it
```

`journalctl -u jellyfin | grep libplacebo` prints the built command. That is the entire audit and it
needs no harness. Check the reverse as well: an axis set to off must **not** appear in the command.

When testing the browser script, drive the **real served files** rather than a simulation. A headless
harness that mocks the webpack chunk loader will happily validate your assumptions instead of
checking them — that is precisely how the `webpackChunk` vs `webpackChunkjellyfin_web` bug survived
"verification".

## Measuring image quality here

Objective metrics disagree with each other on this content, and each can be gamed:

- **Raw sharpness (Laplacian) rewards noise and ringing.** It ranked the worst-ringing shader top.
- **Ground-truth-referenced sharpness** (compare against the reference's *own* Laplacian, so
  overshoot counts as error) fixes that — but is still gameable on its own: a tuned sharpener can hit
  the right *total* edge energy by putting it in the wrong places.
- **Use both, plus PSNR/SSIM.** Reconstruction raises fidelity while adding detail; synthesis adds
  detail while lowering it. That difference is the whole question, and only the pair reveals it.
- **For denoising, every sharpness metric is backwards by construction.** Build a synthetically
  degraded source and score recovery against the undegraded original, so removing noise counts as
  gain.
- Always test at **1.5x as well as 2.0x**. Fixed-2x networks look fine at their native ratio and can
  measure *below plain scaling* off it. A benchmark at 2.0x only is how a shader that softens real
  content got recommended once already.
- **These captures are VFR.** ffmpeg's `psnr`/`ssim` framesync pairs frames by PTS, so scoring a CFR
  output against a VFR reference silently compares misaligned frames. It once reported a good model
  at 16-24 dB and the number looked plausible enough to believe. Compute metrics by frame index.
- **libplacebo shifts luma by about -9/255 on untagged clips**, which penalises every libplacebo
  chain against a non-libplacebo reference. `-color_range pc` in, `tv` out; verify DC error is 0.
- **Know which baseline belongs to which method.** If the low-res input was made with swscale, then
  swscale upscaling is its near-inverse and wins PSNR by construction. Compare shaders against a
  libplacebo baseline and neural models against a swscale one, and say so.
- **Temporal artifacts need their own measurement.** Per-frame metrics cannot see flicker, crawl or
  ghosting. Measure still-pixel variation across consecutive frames; a recurrent model can *increase*
  it by carrying sensor noise forward.

## Things that have already gone wrong

- **Wrong webpack global.** This build uses the bare `webpackChunk`, not `webpackChunkjellyfin_web`.
  The hook attached to a global nobody used, threw no error, and silently did nothing.
- **An axis that was never sent.** `addParams` wrote eight axes and omitted `neural`. Every neural
  level a viewer picked did nothing, silently, for two sessions. Nothing threw, nothing logged, and
  the server reported honestly on the level it actually received.
- **A global that does not exist.** `window.playbackManager` is not a thing in jellyfin-web 12.1, so
  every mid-playback selection stayed in the browser and the server fell back to its dashboard
  default. It presented as three unrelated bugs, and was one.
- **Marking the wrong side of PlaybackInfo.** A direct-play response contains no `TranscodingUrl` to
  mark, and clearing `SupportsDirectPlay` on the response leaves the player with no fallback. Direct
  play must be disabled on the *request*.
- **One missing form control.** `configPage.html` read `#Upscaler`, which did not exist in the
  markup. That single throw blanked every field on load *and* silently discarded every save. If you
  add a config field, add its control and its script line together.
- **Shader `//!WHEN` guards.** FSRCNNX needs 1.300x, Anime4K 1.200x. A 1.125x scale fires neither
  shader and looks like a broken plugin. Portrait sources frequently land here.
- **libplacebo treats `shader_cache` as a path prefix, not a directory**, and will litter hundreds of
  scratch files beside it.
- **Measuring a no-op and believing it.** In stock `FSR.glsl`, EASU writes to a scratch texture and
  only RCAS writes back to `LUMA`. Stripping RCAS to measure "EASU alone" returns exactly the
  plain-scaling number, which looks like a real result. Remove the `//!SAVE` line so the pass writes
  back.
- **Trusting a level name over a measurement.** The shader shipped as `CAS-low` was, at its gentlest
  setting, already a strong sharpener that overshot ground-truth detail by 15%.
- **A doc-side instance of "renders, is stored, and is never sent."** `ARCHITECTURE.md` said
  optix's CUDA-hw-frame conversion (Tier 1) was "not yet scoped" for a full day after commit
  `61d6798` actually did it and verified it. The work was real and committed; the reference doc
  describing it was not updated in the same commit and nobody re-read it before relying on it. Same
  failure shape as the missing `neural` param - the change was correct, the audit trail was not, and
  it would have read as three unrelated confusions to anyone diagnosing "why does ARCHITECTURE.md
  disagree with what the code does." Re-read the doc, not a summary of it, before trusting a
  "not yet done" claim in this repo.

## Operational care

This runs on live servers, often sharing a GPU with other workloads.

- Restarting Jellyfin kills in-flight transcodes and logs out dashboard sessions. If a user is mid-
  session, ask before restarting.
- Do not kill ffmpeg processes indiscriminately to clean up tests — you may be ending someone's
  playback. Stop your own sessions by id.
- Changing `MaxConcurrent`, `RequireClientOptIn` or `ForceTranscodeForDirectPlay` changes GPU load
  for every viewer, not just yours.

**Prefer shipping to proving.** Benchmarking has repeatedly been cut here in favour of working
features, and rightly: an unverified feature that ships beats a measured harness that does not.
Correctness checks still earn their place, because they are what tells you a feature runs at all.
Measurement is for deciding between options, not for gating delivery.

## Shaders and licensing

FSRCNNX is igv's work under **LGPL-3.0-or-later**; Anime4K is bloc97's under **MIT**. Neither is
vendored — `scripts/install-shaders.sh` fetches them so the licences stay with their authors. Do not
commit them. The CAS shaders in `shaders/` are this project's own.

RCAS is derived at install time from AMD FidelityFX FSR v1.0.2 (MIT, via agyild's mpv port) by
`shaders/make-rcas.sh`. The transform is documented in that script; the upstream file is not vendored.

On picking shaders: judge on measurement, not names. A heavier FSRCNN variant measured *no better*
for twice the cost. Anime4K wins at its native 2.0x and falls below plain scaling at 1.5x. FSR's EASU
measured worse than plain scaling outright. Only RCAS survived, and it won on cost as well as quality
because of where it hooks.

## Reuse before reinvention, and what the licence allows

Prefer copying a working implementation over writing one. Where an upstream project already solves a
problem this one is about to solve, take its code, keep its licence header, record where it came from
and at which revision, and say in the commit what was changed. A vendored file that names its origin
is maintainable; a reimplementation of the same idea from memory is not, and it carries the bugs the
original already fixed.

This project is **GPLv2 or later**, which decides what can be taken:

- **MIT and BSD-3** code can be copied directly. Keep the original copyright and licence text in the
  file, and attribute it in the docs beside the feature.
- **Apache-2.0** code is usable only because this is GPLv2-OR-LATER: the combined work ships as
  GPLv3. Note that in the file, because it changes the licence of what is distributed.
- **AGPL-3.0** code is not taken. It would place its obligations on the whole server. Ultralytics
  YOLO is the live example: use a differently licensed detector rather than pulling that in.
- **Non-commercial or research-only licences** are not taken at any quality. CodeFormer's S-Lab
  licence is the live example. GFPGAN, being Apache-2.0, is the route that works.
- **Proprietary SDKs** stay unvendored, fetched by the operator at build time, exactly as OptiX, DLSS
  and the FSR2 shader compiler already are.

Model weights carry their own licences, separate from the code that runs them. Record the licence and
the origin beside each model the way the model catalogue does, and verify a hash before a downloaded
model is used, so what ran can be identified later.

## The source file is never touched

Enhancement happens inside the transcode. This plugin reads a file and writes nothing back: no
pre-upscaled copies, no sidecar renditions, no library it has altered. Remove it and the library is
exactly as it was.

A batch pre-upscale pass was planned and then dropped for this reason. It would have bought the
expensive models - the neural levels measure 24, 15 and 10 fps, and frame interpolation, face
restoration and region-selective upscaling are all far below realtime - and the price was a second
copy of every processed item and a library this plugin had written into. The property was worth more
than the features.

So a feature that only works by writing files first does not belong here, however good it looks. If
that changes, the shape to revisit is a cache outside the library served through the plugin, never
a file written beside the original.
