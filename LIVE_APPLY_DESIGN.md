# Live-apply smoothness: root cause + A/B swap design

Brief: `.agent-briefs/live-apply-smoothness.md`. Investigation against source only, no
CT114 restart/deploy/config change. CT114 checked for active sessions before reading the
production shim: only the Jellyfin daemon (PID 548311) and unrelated ffmpeg build jobs were
running, no live transcode, so read-only `cat`/`ssh` was safe.

**UPDATE (`.agent-briefs/ab-swap-implement.md`, this pass): the A/B swap below is now BUILT, not
just designed.** See "What was implemented vs designed" and "VERIFIED vs ASSUMED" at the end of
this file for what actually shipped, what differed from this document's own assumptions once real
Jellyfin internals were read, and what a real CT114 test proved versus what is still untested.

**See also `RUNTIME_FILTER_CONTROL_DESIGN.md`** (`.agent-briefs/runtime-filter-control.md`): a
complementary design, not a replacement for the A/B swap below. It fixes the stutter at its root
for `optix`'s `blend`/`mode`/`flow` only (same process, no re-negotiation), because that parameter
is already read live per frame with no NVENC dependency. Everything that changes output geometry,
or `dlpp_rtcuda`'s `level` (only read at filter init, not per frame), still needs the A/B swap or
today's restart — NVENC's own `reconfig_encoder()` never reconfigures coded width/height on an
open session, confirmed by reading `nvenc.c`. So the A/B swap's scope narrows to "resolution/level
changes and anything runtime filter control cannot reach," rather than being obsoleted.

## Phase 1: why live-apply stutters today (transcoding session)

Full chain, VERIFIED against source in this repo plus the production shim on CT114:

1. Viewer changes a control -> `requestRestream()` (`web/src/controller/live-apply.js`)
   debounces 700ms, then calls `doApply()`.
2. `doApply()` calls `pm.setMaxStreamingBitrate({ maxBitrate: current })` on jellyfin-web's
   `playbackManager`, handing back the SAME bitrate already in force. This is not a new
   mechanism this project built; it is jellyfin-web's own quality-change path (the code
   comment in `live-apply.js` names it precisely: ends in `changeStream()`, module-private,
   the same function the stock quality menu reaches).
3. `changeStream()` (stock jellyfin-web, not in this repo) does three things per the comment
   this project already verified by reading jellyfin-web's behavior: re-requests
   `PlaybackInfo`, restarts the player at the current position, and calls
   `stopActiveEncodings(oldPlaySessionId)` BOTH before and after the switch.
4. New `PlaybackInfo` request goes through this script's `hookFetch`/`hookXhr`
   (`web/src/controller/network.js`), which rewrites the `TranscodingUrl` with the new axis
   params. Server gets a NEW `PlaySessionId`, builds a new ffmpeg command via the Harmony
   patches (`src/patcher/UpscalePatches.cs`), and Jellyfin's own (stock, unpatched by this
   project) transcode manager starts a new ffmpeg process for it.
5. The player is restarted at `current position -> new stream`, discarding the old buffer.

ASSUMED (not verified this pass, flagged per the brief's own instruction not to guess): the
exact ordering of stock Jellyfin's transcode-job teardown relative to the new job's ffmpeg
reaching first-frame-out. This repo patches `EncodingHelper` (filter/hwaccel/encoder string
building) and reads `HasCapacity()`/`WouldEnhanceSource()`, but never patches Jellyfin's own
`TranscodingJobHelper`/session-stop path -- confirmed by search, zero matches for
`StopEncoding`/`KillTranscodingJob`/`TranscodingJobHelper` anywhere in `src/`. So the old-ffmpeg-
kill-timing question is entirely inside stock Jellyfin, unpatched and unread this pass.

**Root cause, stated plainly:** the interruption is not a server-side gap in encoding so much as
a full re-negotiation cycle deliberately built into jellyfin-web's bitrate-change path and reused
here unmodified: new `PlaySessionId`, new HLS master playlist, new segment sequence starting at
segment 0 of a new sequence, and a player restart at the current tick. Nothing in this project
special-cases "just swap the filter chain, keep the segment sequence" -- it rides the same path a
viewer manually picking 1080p vs 4K from the stock quality menu takes, and that path is a
tear-down-and-restart by design, not a bug in this plugin's own code. The "gap where nothing is
encoded" is real (old ffmpeg process for the old `PlaySessionId` is torn down, a new one has to
start, probe, and produce a first segment before the player has anything new to fetch) but it is
compounded by the player-side restart, which is a second, separate visible interruption (buffer
discard + HLS re-init) even if the server-side gap were zero. Both contribute; this pass cannot
attribute the visible stutter's duration between them without an on-server trace of ffmpeg start
time vs `stopActiveEncodings` timing, which is exactly the "needs a live test" case flagged below.

## Phase 2: A/B dual-ffmpeg swap design

**Where it lives:** today nothing in this project's Harmony patch set touches transcode job
lifecycle -- only the ffmpeg command string. A true A/B swap (start new ffmpeg while old keeps
serving, cut over, then kill old) requires patching Jellyfin's session/job management more deeply
than today's `EncodingHelper` patches do -- stated plainly per the brief: this is new surface, not
an extension of `UpscalePatches.cs`. It would need to intercept the `PlaybackInfo` re-negotiation
request (already hookable, since the client already rewrites it) and hold the OLD transcode job
alive while starting a second ffmpeg into a new segment directory under the SAME `PlaySessionId`
lineage (or a linked one the player is told to fetch from once ready), rather than letting stock
Jellyfin allocate a wholly new session and kill the old one immediately.

**Headline design decision -- a separate, small "swap" cap, independent of `max_concurrent`:**

- `UpscaleEngine.HasCapacity()` is the cap actually enforced today when Harmony patches are
  active (VERIFIED: `UpscalePatches.BuildVerdict` at `src/patcher/UpscalePatches.cs:338` calls
  it, and it counts live `/proc` processes whose cmdline holds both `ffmpeg` and `libplacebo`).
- The shim's own `take_slot()`/`SLOT_DIR` mechanism (`/usr/local/bin/jellyfin-ffmpeg-upscale` on
  CT114) is currently DEAD for production sessions: `main()` calls
  `if cfg.get("plugin_patch_active"): passthrough(args)` and returns before `take_slot()` is ever
  reached. VERIFIED by reading the script and by `cat /etc/jellyfin-upscale.json` on CT114, which
  shows `"plugin_patch_active": true`. So the brief's framing ("shim enforces the global cap")
  describes the no-Harmony fallback mode, not the mode actually running in production today.
  `max_concurrent` in that same file is 4, not 2 (2 is only the shim script's internal
  `DEFAULTS` fallback, never read when the config file exists and is synced by `ShimBridge.Sync`).
- Given that, the swap's temporary second process should count against
  `UpscaleEngine.HasCapacity()`'s regular slot count (it IS a second real libplacebo ffmpeg
  process and the whole point of that counter is GPU load, which a swap genuinely adds for its
  window), AND additionally be bounded by its own small cap -- e.g. `MaxConcurrentSwaps` (suggest
  default 1, config-driven like `MaxConcurrent`) -- checked before a swap is attempted at all.
  Reasoning: `max_concurrent`/`HasCapacity()` protects the GPU in aggregate; a SEPARATE swap cap
  protects against many viewers changing settings at once each briefly doubling their own load,
  which is a different failure mode (transient GPU spike concentrated in a short window) that a
  shared aggregate cap alone would only catch after the fact, by refusing ordinary new sessions
  collateral to the spike. Counting the swap under both keeps `HasCapacity()`'s accounting honest
  (it should reflect real concurrent GPU-encoding ffmpeg processes) while the swap cap governs
  the specific in-progress-swap resource story on top.

**Degradation when at cap:** a swap request checks `HasCapacity()` for a hypothetical extra slot
AND the swap cap, before starting the new process. If either is exhausted, do NOT attempt the A/B
swap -- fall back to today's behavior (tear down, re-negotiate, restart) exactly as it works now,
and record a status value the session/status reporting can surface honestly (e.g.
`"swap-capacity"` alongside the existing `concurrency-cap`/`subtitle-burn-in`/etc. negative
statuses -- per invariant 7 in `AGENTS.md`, reporting must never overstate: a swap that silently
degraded to tear-down-and-restart must say so, not claim "swapped smoothly"). This never leaves a
session broken because it never touches the OLD process until the fallback path's normal
teardown-then-restart proceeds exactly as today.

**Player side -- flagged as unverified, needs a live test, not guessed:** even with a perfectly
seamless server-side handoff (new ffmpeg ready, serving new segments before old is killed), it is
NOT verified here whether hls.js / the jellyfin-web player can be handed a new segment source
without itself doing a visible re-init. The client-side comments in `live-apply.js` establish that
`changeStream()` currently ALWAYS restarts playback at the current tick as part of its own
contract; an A/B design that wants a truly invisible cut would need either (a) a jellyfin-web
code path this project has not found yet that swaps the HLS source without restarting the
`<video>` element, or (b) a client-side buffer/handoff of its own. Per `AGENTS.md`'s prior lesson
about `window.playbackManager` not existing where "it should," this must be found by shape in a
real served page and tested live, not assumed from behavior alone. Flagging rather than guessing.

## What was implemented vs designed (original pass)

Nothing beyond this document was implemented in the original pass; see below for the build.

## What was implemented vs designed (`ab-swap-implement.md` pass - THE BUILD)

**Built, not just designed:**

- The real seam. `TranscodingJobHelper` (this document's assumed name for the class to patch) does
  not exist on this Jellyfin build (12.1) - confirmed by decompiling the actual assemblies this
  project builds against. The real owner is `MediaBrowser.MediaEncoding.Transcoding.TranscodeManager`
  (`MediaBrowser.MediaEncoding.dll`), a public sealed class implementing
  `MediaBrowser.Controller.MediaEncoding.ITranscodeManager`. It is the class stock Jellyfin's
  `PlaystateController.ReportPlaybackStopped` (`Sessions/Playing/Stopped` - the server side of
  jellyfin-web's `stopActiveEncodings(oldPlaySessionId)`) and `DynamicHlsController.GetDynamicSegment`
  call into to kill a transcode job, and the class whose `StartFfMpeg` starts a new one.
- New Harmony patch surface, `src/patcher/SwapPatches.cs`, patching
  `TranscodeManager.KillTranscodingJobs` (Prefix: defers the kill while a swap is admitted, replaying
  it later) and `TranscodeManager.StartFfMpeg` (Postfix: fires once the new process is ready).
  **`StartFfMpeg` already does not return until its own first segment file exists (or the job
  exits)** - stock Jellyfin's own wait loop. This is exactly the "detect new process ready" signal
  item 3 of the brief asked for; no separate filesystem/process watch was needed, because Jellyfin
  already does that waiting internally and this patch just rides its completion.
- The transport for "this is a live-apply swap, not a new session": the client
  (`web/src/model/state.js`'s `swapFrom`, set in `live-apply.js`'s `doApply()` right before the
  re-negotiation, read in `network.js`'s `wireParams()`) sends the OLD `PlaySessionId` as a
  `swapfrom` query parameter on the re-negotiation and the HLS requests it produces - the exact
  same lowercase-query-parameter transport the other 14 axes already use, per the brief's own
  instruction not to invent a new one. Read server-side in `UpscalePatches.BuildVerdict` via a new
  `UpscaleEngine.OptionValue` wrapper.
- Admission and bookkeeping in `UpscaleEngine.cs`: `TryAdmitSwap` (checks `HasCapacity()` for the
  extra process AND the new `MaxConcurrentSwaps` cap), `TryDeferKill` (called from the
  `KillTranscodingJobs` prefix), `OnNewJobReady` (called from the `StartFfMpeg` postfix, matches the
  pending swap by `DeviceId` - old and new `PlaySessionId`s differ, `DeviceId` does not - and replays
  the deferred kill for real), and `SweepExpiredSwaps` (a 15s timeout that still fires the deferred
  kill even if the new job never arrives, so a swap that stalls does not orphan the old process or
  hold `MaxConcurrentSwaps` capacity forever).
- `MaxConcurrentSwaps`, default **4** (the brief's instruction, not this document's earlier
  suggestion of 1), wired through the five-place checklist: `PluginConfiguration.cs`,
  `UpscaleSettings.cs` (JSON property names match, so no extra ALC-boundary plumbing was needed),
  `configPage.html` (control + load/save), and `UpscaleEngine.TryAdmitSwap` (the code path that
  actually reads it - the fifth place, no probe-key needed since this is not a viewer-facing axis).
- `SessionRecord.SwapStatus`, surfaced through the existing per-session JSON (`Record` is already
  serialized whole): `swapping` (admitted), `swap-capacity` (refused, degrades to the old
  tear-down-and-restart exactly as this document specified), `swapped` (cut over for real),
  `swap-timeout` (the new job never arrived; the old one was still torn down, just not smoothly).

**Not done this pass:** a live test of the swap-cap-exhaustion fallback under real concurrent load
(would need 4+ simultaneous live-apply changes on CT114 at once to force the refusal branch) - the
admission and degradation code paths were read, not exercised at the cap boundary. See
`.agent-briefs/ab-swap-implement.md`'s own report for what was VERIFIED versus ASSUMED in this pass.

## VERIFIED vs ASSUMED summary (original pass)

- VERIFIED: client re-negotiation mechanism (`live-apply.js`, `network.js`), that no
  `TranscodingJobHelper`/session-stop Harmony patch exists in `src/`, `HasCapacity()`'s actual
  mechanism and call site, the shim's `plugin_patch_active` short-circuit bypassing `take_slot()`
  in production, and the live `max_concurrent: 4` / `plugin_patch_active: true` values on CT114.
- ASSUMED/flagged: exact timing of stock Jellyfin's old-ffmpeg teardown vs new-ffmpeg first frame;
  whether the player can be handed a new segment source without a visible re-init.

## VERIFIED vs ASSUMED summary (`ab-swap-implement.md` build pass)

- VERIFIED, on a real transcode against real production CT114 hardware (not simulated, not
  mocked): a real PlaybackInfo negotiation + HLS master/variant/segment fetch sequence against the
  live server, using an existing admin API key, started a real ffmpeg transcode
  (`libplacebo=w=1920:h=1080:upscaler=ewa_lanczos...`). A second negotiation carrying `swapfrom=`
  the first session's id and a different `upscale` target, fetched the same way, started a SECOND
  real ffmpeg process (`w=2560:h=1440`, `fsrcnnx`) while the first was still running -
  **`ps aux` showed both PIDs simultaneously**. `Sessions/Playing/Stopped` was then sent for the OLD
  session (the exact call `stopActiveEncodings()` makes) and returned 204, but **the old ffmpeg
  process was still running immediately afterward** - the deferred-kill prefix worked, not a stock
  no-op. Once the new segment fetch completed (new process ready), the old ffmpeg process was gone
  from `ps aux` and only the new one remained - the real cutover, not a timeout or a leak. Both
  sessions' own status records (`GpuUpscale/Session/{id}`) reported `"SwapStatus":"swapped"`. An
  unrelated real viewer session on the same box throughout was undisturbed.
- VERIFIED from source (re-confirmed, not re-observed live in a browser this pass): jellyfin-web's
  `changeStream()` restarts playback at the current position as part of its own contract - this
  document's Phase 1 investigation already read that from the served jellyfin-web bundle. The
  server-side gap (old process torn down before the new one has anything to serve) is what this
  build closes; the player-side restart (buffer discard, brief visible re-init) is a SEPARATE
  interruption this build does not remove, because it happens inside jellyfin-web, not this plugin.
  **Verdict: not fully seamless end to end** - the player still restarts - but the encoding gap
  that used to sit inside that restart (nothing being encoded while the old process was already
  dead and the new one was still probing) is gone, which is a real, measurable improvement over
  today even though the originally-hoped-for fully invisible cut was not achieved.
- NOT tested live: the swap-cap-exhaustion fallback (would need 4+ concurrent live-apply changes to
  force `MaxConcurrentSwaps` to refuse one) and a swap whose new job genuinely never arrives (the
  15s `SweepExpiredSwaps` timeout path) - both were read, not exercised, this pass.
