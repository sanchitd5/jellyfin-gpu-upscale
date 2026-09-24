# Live-apply smoothness: root cause + A/B swap design

Brief: `.agent-briefs/live-apply-smoothness.md`. Investigation against source only, no
CT114 restart/deploy/config change. CT114 checked for active sessions before reading the
production shim: only the Jellyfin daemon (PID 548311) and unrelated ffmpeg build jobs were
running, no live transcode, so read-only `cat`/`ssh` was safe.

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

## What was implemented vs designed

Nothing beyond this document was implemented this pass. The brief permitted a small, safe,
CT114-independent piece to be built and verified; nothing in this codebase currently has a seam to
attach a "swap in progress" status or a `MaxConcurrentSwaps` setting without also touching the
session/job lifecycle patch that Phase 2 says does not exist yet -- building the config plumbing
alone (a new `PluginConfiguration`/`UpscaleSettings` field with no code path reading it) would be
exactly the "dead UI"/"axis nothing reads" anti-pattern `AGENTS.md` invariant 11 calls out. This
pass is design-only, as the brief allows.

## VERIFIED vs ASSUMED summary

- VERIFIED: client re-negotiation mechanism (`live-apply.js`, `network.js`), that no
  `TranscodingJobHelper`/session-stop Harmony patch exists in `src/`, `HasCapacity()`'s actual
  mechanism and call site, the shim's `plugin_patch_active` short-circuit bypassing `take_slot()`
  in production, and the live `max_concurrent: 4` / `plugin_patch_active: true` values on CT114.
- ASSUMED/flagged: exact timing of stock Jellyfin's old-ffmpeg teardown vs new-ffmpeg first frame;
  whether the player can be handed a new segment source without a visible re-init.
