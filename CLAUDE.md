# CLAUDE.md

Read **[AGENTS.md](AGENTS.md)** first — architecture invariants, verification standards, and the list
of things that have already gone wrong. Everything in it applies.

This file adds what is specific to working on this repo with Claude Code.

## Where the work actually happens

Developed against a **live Jellyfin server**, not locally. There is no meaningful local test suite:
the plugin does nothing without Jellyfin's assemblies, a GPU and a real transcode. Expect to build
on, deploy to and verify against a running server over SSH.

Consequences:

- **A build that compiles proves almost nothing.** Probe the served segment.
- **Deploy atomically.** Half-applied state is visible to whoever is watching. Copying new assemblies
  and only then finding the config page needs a rebuild means a broken dashboard in the meantime.
- **Restarts are expensive and visible.** They kill in-flight transcodes, cancel library scans and log
  dashboard users out. Batch changes that need one; client-side changes need none.
- **Someone may be watching something right now.** Check before restarting. Never kill ffmpeg
  processes indiscriminately to tidy up — stop your own sessions by id.

## What this project is made of now

Five custom ffmpeg filters live in a **separate patched binary** beside the stock one:
`vf_oidn`, `vf_optix`, `vf_ort`, `vf_fsr2`, `vf_dlss`. The shim routes per session and asks the binary
which filters it carries, stripping nodes it lacks — so a rebuild that drops a `vf_*.c` degrades
gracefully instead of failing every session. **If you rebuild that binary, all five must survive.**
Check `-filters` afterwards. Rollback copies exist beside it.

Thirteen axes reach the ffmpeg command: `upscale`, `sr`, `deblur`, `denoise`, `neural`, `game`,
`refine`, `chroma`, `deband`, `kernel`, `jitter`, `depth`, `reactive`. Each travels as a lowercase
query parameter through `StreamOptions`.

## Adding a level or an axis

The client is data-driven by design, because levels and axes keep arriving:

- **A new level** is one entry in an options array — no rendering code.
- **A new axis** is one entry in `CONTROLS` plus one line in `LIVE_ROWS`, with `probeKey` naming what
  the probe returns.
- **Display names and degraded wording come from the probe**, not from JavaScript. The string lives
  beside the level definition on the server on purpose.

Server side, an axis is only real when `UpscaleEngine.Option(state, ...)` reads it. A control whose
parameter nothing reads is dead UI — do not ship one.

## Before you change the config page

`src/Configuration/configPage.html` is an embedded resource compiled into the plugin DLL, so a change
needs a rebuild **and** a restart — not a static file you can edit in place. Fetch the **served** page
through the API when diagnosing; the on-disk source may not be what is running.

Adding a setting means touching all of these together, or the page breaks:

1. `src/Configuration/PluginConfiguration.cs` — the property and its default
2. `src/patcher/UpscaleSettings.cs` — the patcher-side mirror (settings cross the ALC boundary as JSON)
3. `src/Configuration/configPage.html` — **both** the form control and the load/save script lines
4. The probe, so the client can offer it
5. The session/status reporting, if it changes what the server does

## Before you change the client

`/usr/lib/jellyfin-gpuupscale/gpu-upscale.js` is canonical. The injector copies it into the web root
and bumps a cache-buster. **Editing the web copy directly gets silently reverted while the buster
still advances**, so browsers cache the old script under a new URL. Keep `web/gpu-upscale.js` in this
repo in sync — that is what gets published.

**Never reach for a global that "should" exist.** `window.playbackManager` does not exist in
jellyfin-web 12.1; the only file in the whole web tree naming it was this script. Live apply silently
never ran, and the panel never closed on playback stop, for an entire session before anyone noticed.
Find things **by shape** — an export carrying the methods you need — inside the modules the script
already wraps. Shapes survive minification and module renumbering; names and ids do not.

The webpack chunk global here is the bare **`webpackChunk`**, not `webpackChunkjellyfin_web`.

## The failure mode this project keeps hitting

**Something renders, is stored, and is never sent.** It has happened twice:

- `addParams` wrote eight axes and not `neural`. Every neural level picked did nothing, silently, for
  two sessions.
- `window.playbackManager` was undefined, so every selection stayed in the browser. The server then
  fell back to its dashboard default and reported honestly on *that* — which read as three unrelated
  bugs and was one.

So when something "does not work", **prove the whole chain before theorising**:

```
panel selection -> localStorage -> addParams writes the param -> param in TranscodingUrl
  -> server Option() reads it -> the BUILT FFMPEG COMMAND changes -> session record reports it
```

`journalctl -u jellyfin | grep libplacebo` shows the built command. That is the whole audit; it needs
no harness. Check the reverse too — an axis at off must **not** appear in the command.

## Reporting back

State plainly what was verified versus assumed. "Deployed and restarted cleanly" is not "a served
segment came back at 1920x1080". If a verification could not be run, say so rather than implying
coverage. Several bugs here were found only because someone re-checked a claim already reported as
working.

**Prefer shipping to proving.** The user has repeatedly cut benchmarking in favour of working
features, and has been right to: an unverified feature that ships beats a verified harness that does
not. Correctness checks still earn their place — they are what tells you the feature works at all.

If a user's objection contradicts a measurement, take it seriously and design a test that could prove
them right. The Anime4K-versus-FSRCNNX question settled that way: the original benchmark measured
only at the shader's native ratio, and the user's instinct about their own content was correct.

## Known open wart

`effective()` returns a hard-coded `sr: LADDER_SR` (`fsrcnnx`) for every ladder stage, and the panel
re-seeds preferences from it on each render. So while the Quality slider owns the session, the Detail
control is forced back to fsrcnnx, and another SR level only sticks by flipping the stage to Custom.
Deliberate while the ladder *is* an FSRCNNX ladder; worth revisiting now that ratio-agnostic levels
exist.
