# Working on this codebase

Guidance for AI coding agents (and humans who like their invariants written down). This project
patches a running media server, so mistakes here break other people's playback rather than failing
a test. Read the invariants before changing anything.

## What this is

A Jellyfin plugin that injects a libplacebo/Vulkan filter chain into transcodes for realtime
super-resolution, sharpening and denoising. It works by runtime-patching Jellyfin with Harmony,
because Jellyfin exposes no plugin hook for the video filter graph.

Layout:

```
src/                    plugin assembly (loads into Jellyfin's collectible ALC)
src/patcher/            patcher assembly (loads into the DEFAULT ALC — this is where Harmony lives)
src/Configuration/      settings class + the dashboard page
web/gpu-upscale.js      injected browser script: Enhance menu + request marking
shim/                   standalone ffmpeg wrapper, the no-Harmony fallback
shaders/                CAS shaders (ours, superseded) + the RCAS derivation script
scripts/                install, inject, activate/rollback
```

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

**10. RCAS sharpness is inverted and clamped.** `0.0` is maximum, larger is gentler, and the shader
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

## Things that have already gone wrong

- **Wrong webpack global.** This build uses the bare `webpackChunk`, not `webpackChunkjellyfin_web`.
  The hook attached to a global nobody used, threw no error, and silently did nothing.
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

## Operational care

This runs on live servers, often sharing a GPU with other workloads.

- Restarting Jellyfin kills in-flight transcodes and logs out dashboard sessions. If a user is mid-
  session, ask before restarting.
- Do not kill ffmpeg processes indiscriminately to clean up tests — you may be ending someone's
  playback. Stop your own sessions by id.
- Changing `MaxConcurrent`, `RequireClientOptIn` or `ForceTranscodeForDirectPlay` changes GPU load
  for every viewer, not just yours.

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
