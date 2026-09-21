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
shaders/                CAS sharpening shaders (ours) + composer
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

On picking shaders: judge on measurement, not names. A heavier FSRCNN variant measured *no better*
for twice the cost. Anime4K wins at its native 2.0x and falls below plain lanczos at 1.5x. Raw
sharpness metrics are actively misleading — they rank the shader with the worst ringing highest;
compare against ground truth so overshoot counts as error.
