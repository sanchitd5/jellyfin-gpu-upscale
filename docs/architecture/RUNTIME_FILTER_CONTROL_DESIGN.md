# Runtime filter control (zmq/sendcmd) as an alternative to the A/B swap

Brief: `.agent-briefs/runtime-filter-control.md`. Investigation and design only, no CT114
restart/deploy/config change. A concurrent agent was found mid production ffmpeg build on CT114
(`ssh -p 2298 root@192.168.1.2 pct exec 114 -- tail /root/ffmpeg-build-prod.log` running during
this pass), so nothing was checked live against the running binary: every finding below comes
from this repo's source and a local upstream ffmpeg checkout (`~/dev/ffmpeg`), not from CT114.

## Q1: is zmq/azmq or sendcmd/asendcmd actually built into the patched ffmpeg?

**zmq/azmq: not built. sendcmd/asendcmd: built by default, not disabled.**

VERIFIED by reading `scripts/build-ffmpeg.sh`'s `./configure` invocation and the whole file: no
`--enable-libzmq` flag anywhere, no `libzmq` dependency install step, and no
`--disable-filter=sendcmd` or any other filter-disabling flag. `zmq`/`azmq` require
`--enable-libzmq` plus a linked `libzmq`; neither is present, so those two filters are absent from
both the stock and patched binaries built by this script. `sendcmd`/`asendcmd` are generic
filters with no external dependency and ship enabled unless explicitly disabled, which this
script never does, so they should be present. Not confirmed against the live `-filters` output
this pass (see header) — this is VERIFIED-from-source, not VERIFIED-on-binary. To add zmq:
`--enable-libzmq` in the configure line plus `libzmq3-dev` (or equivalent) on the build host.

## Q2: do our three filters implement process_command today?

**None do.** VERIFIED by reading `vf_optix.c`, `vf_dlpp_rtcuda.c`, `vf_vsr_rtcuda.c` in full:
none defines a `process_command` field on its `FFFilter`, and no function anywhere in the three
files matches that callback signature. All three were written this session with no runtime-control
path, as the brief expected.

Candidate options per filter, found in each `AVOption` table:
- `vf_optix.c`: `mode` (ldr/hdr/temporal), `flow` (nvof/none), `blend` (float 0-1, "0 is fully
  denoised, 1 is the untouched input" — a genuine strength knob). `blend` is read directly inside
  `filter_frame` (`params.blendFactor = s->blend`, line 521) on every call, not cached at init, so
  changing the field between frames already takes effect with no other code change — the cleanest
  candidate in the whole set.
- `vf_dlpp_rtcuda.c`: `level` (1-4, quality/gain tradeoff), `w`/`h` (output geometry). `level` is
  **only read once**, inside `config_props`, and passed into `gu_dlpp_embed_init(..., s->level,
  scale, ...)` to build the DLPP instance — it is not re-read per frame. Changing `s->level` alone
  at runtime would do nothing until the embed instance is torn down and reinitialized.
- `vf_vsr_rtcuda.c`: only `w`/`h` (geometry) and test-harness-only options (`inject`/`dump`); no
  strength-like knob exists to control live at all.

## Q3: what would adding process_command take, per filter?

Reference pattern read from this machine's local upstream ffmpeg checkout (`~/dev/ffmpeg/
libavfilter/af_volume.c:307-321`, `vf_eq.c:284-299`): `process_command` is a `strcmp` on `cmd`,
parses `args` into the existing priv struct field (`av_opt_set`/a bespoke setter), and returns.
No locking, no thread hand-off — ffmpeg's own filters do a plain field write because
`process_command` is invoked from the same graph-processing call path as frame delivery, not a
concurrent thread, for these single-input/single-output GPU-resident filters.

- **`optix` `blend` (and `mode`/`flow`): small.** A ~10-15 line `process_command` that parses a
  float/enum and writes `s->blend`/`s->mode`/`s->flow` — same shape as `af_volume.c`'s pattern,
  since `blend` is already read fresh every frame. No new locking needed.
- **`dlpp_rtcuda` `level`: large.** Because `level` only matters at `gu_dlpp_embed_init` time,
  `process_command` would have to tear down and rebuild the whole embed instance
  (`gu_dlpp_embed_close` + `gu_dlpp_embed_init` again) mid-stream — new synchronization against
  `filter_frame` running concurrently on frames already in flight, and a real chance of a visible
  glitch or dropped frame at the swap instant. Scope is closer to "new state machine" than
  "wire an existing setter."
- **`vsr_rtcuda`: not applicable** — no strength knob exists to control this way; only geometry,
  which Q4 covers.

## Q4: does a live resolution change work with NVENC, or does it need a real re-init regardless?

**Needs a real re-init; not achievable via runtime filter control alone.** VERIFIED by reading
`~/dev/ffmpeg/libavcodec/nvenc.c`'s `reconfig_encoder()` (~line 2840-2920): it calls
`nvEncReconfigureEncoder` (`NV_ENC_RECONFIGURE_PARAMS`), but the only fields it ever changes are
`darWidth`/`darHeight` (display aspect ratio signaling — for anamorphic content, not actual coded
size) and bitrate/VBV parameters. There is no branch that changes `encodeWidth`/`encodeHeight` on
an open encoder session. So even if a filter fed NVENC a differently-sized frame mid-stream,
ffmpeg's own nvenc wrapper has no path to reconfigure the encoder to accept it — this would need a
new encoder session (new `avcodec_open2`), i.e. the process-level swap the A/B design already
covers, not something process_command reaches.

## Q5: what plumbing would the plugin side need (for the achievable subset)?

`UpscaleEngine.cs` already keys per-session state by `PlaySessionId` in two dictionaries:
`_bySession` (`ConcurrentDictionary<string, SessionRecord>`) and `_encoderBySession`
(`ConcurrentDictionary<string, Tuple<string,string>>`), both written where the encoder/filter
decision is made and read back by the per-session status endpoint (`SessionKey`,
around lines 174-410). This is the obvious existing seam — no new architecture needed:

1. Filter-chain construction (`UpscaleEngine`, the `StringBuilder sb` chain built around line
   2189-2300) would append one `,sendcmd=f=<path>` node (or name each control-relevant filter
   instance, e.g. `optix@sess123`, so `sendcmd`/a control socket can target it) per session that
   uses `optix`.
2. A third small dictionary or a new field on `SessionRecord`, `ControlChannel` (a per-session
   command-file path or socket address), written at the same point the filter string is built and
   removed on the same cleanup path that already drops `_bySession`/`_encoderBySession` entries.
3. The panel's live-apply POST, instead of always re-negotiating the stream, would for a
   blend/strength-only change look up the session's control channel and write a `sendcmd`-format
   command instead — same process, same `PlaySessionId`, same segment sequence, nothing for the
   player to re-initialize.
4. A resolution or level change still falls through to the existing restart / the A/B swap design,
   since Q3 and Q4 rule those out for this route.

## Recommendation

Pursue runtime control for **`optix`'s `blend` only** (and, with the same small effort, `mode`/
`flow`) — this is the one parameter in the whole filter set that is already read live per frame,
needs no new locking, and has no NVENC-side resolution dependency. Everything else stays on the
existing path:

- `dlpp_rtcuda`'s `level` needs an embed-instance rebuild mid-stream — scope that separately if
  it is ever wanted; it is not a small addition.
- `vsr_rtcuda` has no live-controllable parameter at all today.
- Any resolution/target-size change (`w`/`h` on any of the three, or a ladder-stage swap) needs a
  real encoder re-init — NVENC cannot reconfigure coded size on an open session — so it keeps
  today's restart behavior or the A/B swap.

**Relationship to the A/B swap design:** complementary, not a replacement, and it narrows the A/B
swap's scope rather than obsoleting it. This route fixes the stutter at its root for the
strength/level-only subset of changes (same process, no re-negotiation at all) — better than
making the A/B handoff fast, for the cases it covers. The A/B swap (or the existing restart)
remains the only path for anything that changes output geometry, since that requires a new NVENC
session regardless of how the filter side is controlled.

## VERIFIED vs ASSUMED

VERIFIED: no `--enable-libzmq` in `build-ffmpeg.sh`; no `process_command` in any of the three
filters; `optix`'s `blend` is read per-frame while `dlpp_rtcuda`'s `level` is read only at
`config_props`/init; the `af_volume.c`/`vf_eq.c` `process_command` pattern (upstream ffmpeg
source read directly); nvenc.c's `reconfig_encoder()` never reconfigures coded width/height;
`UpscaleEngine.cs`'s existing per-session dictionaries.

ASSUMED/not checked this pass: whether `sendcmd`/`azmq` actually appear in `-filters` on the real
CT114 binary (deferred — a build was in progress on CT114 during this pass, so the live binary
was not queried, to avoid any race with that build); exact behavior of `nvEncReconfigureEncoder`
if `encodeWidth`/`encodeHeight` were force-set outside what `reconfig_encoder()` does today (not
attempted, and not recommended without NVIDIA's own reconfigure docs in hand).
