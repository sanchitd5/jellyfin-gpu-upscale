# Integration design: `dlpp_rtcuda` and `vsr_rtcuda`

**Status update, 2026-09-24: IMPLEMENTED, staged, not activated.** The Phase A risk this doc's own
section 2 and `ARCHITECTURE.md` flagged as never tested -- both hosted DLLs (`nvdlppx.dll`,
`nvaivpx.dll`) alive in the same ffmpeg process -- was verified clean (see `TASK.md`, "Combined
optix + dlpp_rtcuda + vsr_rtcuda chain"). The plugin code below was then written following this
doc's recommendations (section 1: both filters as `neural` axis values; section 2: a separate
CUDA hwaccel branch; section 3: the shim's `PATCHED_FILTERS` tuple; sections 4/6/8: probe-driven
`fromProbe` wording, no hardcoded CONTROLS entries needed after all), with one addition this doc
did not have: dlpp-3/4 chain into `vsr_rtcuda` as a conform-resize rather than ever being asked for
an arbitrary output ratio directly, because Phase A also found dlpp level>=3 segfaults on a
non-integer ratio taken alone. See `TASK.md` for what is built/staged versus what still needs a
production ffmpeg rebuild and a restart before it is live. The design notes below are left as
written at the time; where this session's actual findings differ (mostly section 2's "genuinely
new chain-building logic" now written, and the dlpp-3/4 native-scale risk now concrete rather than
theoretical) TASK.md is the source of truth, not this file.

Design only. No plugin code changed. Every claim about existing behaviour cites the file:line it
came from; anything that would need a live server to confirm is marked UNVERIFIED.

## 1. Where do these two filters fit into the existing axis model?

**Recommendation: both become new values on the existing `neural` axis (query param `neural`,
`UpscaleEngine.Option(state, "neural")`). Neither gets a new axis name, and `vsr_rtcuda` does not
become a `kernel`/`sr` option.**

Reasoning, from the actual mechanism each axis uses, not just its label:

- `sr` is GLSL-only. `ShaderLibrary.Resolve()` (ShaderLibrary.cs:1367-1466) looks up a `.glsl` file
  in `cfg.ShaderDirectory` via `Lookup()` (ShaderLibrary.cs:1468) and hands it to libplacebo as
  `custom_shader_path`. There is no path in that function for a raw ffmpeg filter node. `nvscaler`
  and `ravu-zoom` are GLSL shaders too, not native filters, despite reading like scaler names.
  `dlpp_rtcuda`/`vsr_rtcuda` are compiled `AVFilter`s that need `AV_PIX_FMT_CUDA` hw frames
  (`vf_dlpp_rtcuda.c` and `vf_vsr_rtcuda.c`, `config_props()`: "needs CUDA frames (-hwaccel cuda
  -hwaccel_output_format cuda)"). They cannot be expressed as a shader file. `sr` is mechanically
  the wrong axis regardless of how the label reads.
- `kernel` (`Option(state, "kernel")`, UpscaleEngine.cs:1296) feeds one whitelisted string straight
  into `libplacebo=...:upscaler={kernel}` (UpscaleEngine.cs:2097-2102). It is not a filter-node slot
  either.
- `neural` is the one axis already built exactly this way: `ShaderLibrary.NeuralFilter()`
  (ShaderLibrary.cs:1244-1289) returns a raw filter-node string, `Plan.NeuralFilter` carries it, and
  `BuildChain` inserts it as a CPU-side node (UpscaleEngine.cs:2069-2072). The existing "vsr" level
  placeholder (ShaderLibrary.cs:604-606, `VsrLevel = "vsr"`, `VsrOffered = false`) is the same shape
  of thing this integration needs: a filter reachable through this axis, gated off until it is
  verified. That is a template to follow, not a name to reuse (see the collision note below).

Putting both filters here means zero new entries in `UpscaleEngine._axisNames`
(UpscaleEngine.cs:772-776) and zero new hardcoded lines in the client's `wireParams()`
(gpu-upscale.js:2981-3047, where `params.neural` is already forwarded unconditionally at
gpu-upscale.js:3033). That is not a minor convenience: it is the single biggest lever against the
exact failure this project has already had once — see §5.

**Naming collision to fix before writing any code:** the neural axis already reserves the literal
value `"vsr"` for NVIDIA Maxine Video Super Resolution (ShaderLibrary.cs:606,
`IsNeuralLevel("vsr")` is true today even though nothing runs — ShaderLibrary.cs:1249-1258). Do not
call the new level `vsr`. Use `vsr-rtcuda` (matches the filter name, avoids any reader — human or
probe — confusing it with the gated Maxine path).

**Labelling tension, not a wiring problem:** `vsr_rtcuda`'s own file header says plainly "this
filter is a fast, better-than-bicubic GPU resampler, NOT a neural upscaler" (vf_vsr_rtcuda.c,
top-of-file comment). Filing it under a control literally labelled "Neural super-resolution"
(gpu-upscale.js CONTROLS entry, `key: 'neural', label: 'Neural super-resolution'`) overclaims
exactly what the file itself warns against. Fix this at the UI layer (§6/§8: distinct wording and
position inside the same control), not by inventing a second axis and taking on the wiring risk
that comes with it.

## 2. How does `Option()`/chain-building need to change, and does a "GPU-resident filter" concept
already exist?

**It does not exist as something reusable. There is exactly one GPU-resident hop in the codebase
today, it is at the very tail of the chain, it is opt-in and undeployed, and the specific direction
it needs is currently broken in ffmpeg itself.**

`UpscaleEngine.HwaccelArgs()` (UpscaleEngine.cs:2013) unconditionally sets up **Vulkan**:
`-init_hw_device vulkan=vk:0 -filter_hw_device vk`. `BuildChain()` (UpscaleEngine.cs:2024-2143)
starts every chain at `format=yuv420p` (system memory), builds CPU-side nodes, then explicitly
`hwupload`s into that Vulkan device (UpscaleEngine.cs:2085) before the libplacebo pass. The only
place the engine ever leaves system memory on GPU is the last step: `GpuResidentEncode` swaps the
normal `hwdownload,format=yuv420p` for `hwmap=derive_device=cuda` (UpscaleEngine.cs:2136-2141), and
`PluginConfiguration.cs`'s own doc comment says why it's off by default: "it needs the patched
binary's Vulkan-CUDA interop confirmed on the server before it can be trusted on a live session."

That confirmation has not happened, and per this repo's own `vulkan-cuda-hwmap-task.md` (root of
repo, dated 2026-09-22, "checked twice, most recently against current FFmpeg master fetched fresh
today"), `hwmap=derive_device=cuda` **from a Vulkan source fails today**: `Failed to map frame: -38`
(`ENOSYS`), because `hwcontext_vulkan.c`'s `vulkan_map_from()` has no `AV_PIX_FMT_CUDA` case. So the
one piece of GPU-resident plumbing this engine has is currently non-functional in the direction
this integration would also need (Vulkan chain → CUDA filter).

`dlpp_rtcuda` and `vsr_rtcuda` both need `AV_PIX_FMT_CUDA` frames *in*, and produce
`AV_PIX_FMT_CUDA` frames *out* (both `config_props()` allocate a CUDA `out_frames` context; neither
touches system memory per frame — this matches `optix`'s own recent conversion,
`roadmap/gpu-only-filters.md`: "optix... takes AV_PIX_FMT_CUDA frames directly, reuses ffmpeg's own
AVCUDADeviceContext"). Feeding them from this project's Vulkan-based decode/upload path is blocked
by the same unfixed gap.

**Concrete recommendation:** treat a session that asks for `neural=dlpp-*` or
`neural=vsr-rtcuda` as its own hwaccel branch, not an insertion into the existing Vulkan
`cpuNodes` list:

1. `HwaccelArgs()` needs a second mode: `-hwaccel cuda -hwaccel_output_format cuda` instead of the
   Vulkan init line, selected per-session (`Plan` needs a field for which hwaccel this session
   uses; today it's a single global default).
2. `BuildChain()` needs a CUDA-native branch that runs the filter node directly on the decoded CUDA
   frames — no `hwupload` at all, because decode already produced CUDA frames.
3. Reuse the pattern already in `Decide()` for `fsr2`/`dlss` (UpscaleEngine.cs:1250-1258): "fsr2 and
   dlss produce the OUTPUT size themselves... srLevel = 'off'; refineLevel = 'off';" — i.e. when
   `dlpp_rtcuda`/`vsr_rtcuda` run, force `sr`, `refine`, `chroma`, `deband` and `kernel` off for that
   session (they're libplacebo/Vulkan-only axes and the bridge to reach them is broken today), and
   go straight from the filter's CUDA output to NVENC (which already accepts CUDA frames natively,
   no Vulkan involved). This is also the path both filters were actually measured on
   (`vf_dlpp_rtcuda.c`/`vf_vsr_rtcuda.c` comments: "NVDEC -> ... -> DLL Process -> ... -> NVENC...
   verified at 400+ fps... no host copies per frame").
4. Do **not** attempt to compose these with the libplacebo axes by routing through
   `hwmap=derive_device=cuda` until `vulkan-cuda-hwmap-task.md` is actually fixed and reverified on
   CT114 — that path is confirmed broken today, not merely untested.

This is genuinely new chain-building logic, not an extension of the existing "insert a CPU node
before hwupload" pattern the neural/game/denoise axes use today.

## 3. The shim's `PATCHED_FILTERS`

Read from `/usr/local/bin/jellyfin-ffmpeg-upscale` on CT114 (read-only, via SSH, not modified).

```python
PATCHED_FILTERS = ("oidn", "optix", "ort", "fsr2", "dlss")
PATCHED_NODE_RE = re.compile(
    r"(?:format=gbrpf32le,)?(?:%s)(?:=[^,]*)?(?:,format=yuv420p)?"
    % "|".join(PATCHED_FILTERS))
```

**Minimal correct change: add the two names to the tuple.**

```python
PATCHED_FILTERS = ("oidn", "optix", "ort", "fsr2", "dlss", "dlpp_rtcuda", "vsr_rtcuda")
```

`PATCHED_NODE_RE`'s format-stripping does **not** need to change. Its `format=gbrpf32le,` prefix and
`,format=yuv420p` suffix are both optional groups (`(?:...)?`), specifically because not every
patched filter needs that CPU-float wrapper — and confirmed here, neither `dlpp_rtcuda` nor
`vsr_rtcuda` uses it (both take/emit `AV_PIX_FMT_CUDA` directly per §2). The regex already degrades
correctly to stripping just the bare `dlpp_rtcuda(=...)?` / `vsr_rtcuda(=...)?` node with nothing
around it. `wants_patched()`'s name-boundary check (`re.search(r"(^|,|\[)%s(=|,|\]|$)" % name, a)`)
also works unchanged against either name.

One thing worth flagging, not fixing here (read-only task): `pick_binary()` routes to
`PATCHED_FFMPEG` for *any* filter in `PATCHED_FILTERS`, and `patched_has()` caches which filters
that binary actually reports via `-filters`. Since §2 concludes these two need a **different
hwaccel setup** than the rest of the patched-binary chain (CUDA decode, no Vulkan), whatever code
builds the actual command line for these two sessions must not also be handed the Vulkan
`-init_hw_device`/`-filter_hw_device` args the rest of this shim's pipeline assumes. That's a
plugin-side (`HwaccelArgs`) concern per §2, not a shim regex concern, but it's the same
integration seam and worth remembering when this is implemented.

## 4. Honest status / DEGRADED reporting

**`dlpp_rtcuda`:** the filter already ships its own honest line, verbatim in the AVOption help
text (`vf_dlpp_rtcuda.c`, the `level` option): *"DEGRADED: gain is content-dependent across levels,
never negative but never large either."* Surface that string (or a close paraphrase) in the probe,
the same way `vf_dlss.c` puts its own DEGRADED sentence in `config_output` (vf_dlss.c:611,
`"%s %dx%d -> %dx%d DEGRADED: motion vectors are NVOFA optical flow, ..."`) and the plugin's own
`NeuralName()`/`Summarise()` (UpscaleEngine.cs:527-540, 619-755) carry per-level wording server-side
rather than in JavaScript. Do not present the four levels as a ladder ("higher = better"): the
comment is explicit that level ranking is content-dependent, so the probe text for each level
should say what it costs, not imply an ordering the filter itself disclaims.

**`vsr_rtcuda`:** the honest framing is the opposite kind of caveat — not "modest gain," but "not a
network at all." Its own header: *"this filter is a fast, better-than-bicubic GPU resampler, NOT a
neural upscaler... AIVP's own network path never contributed real detail regardless of parameters
(TASK.L17.md, 'Status: RETIRED as a neural target')."* The one measured number that exists
(`roadmap/driver-features.md`, item 2): 43.93 dB vs 41.66 dB against bilinear, 0.08 ms/frame. Probe
text should say "fast GPU resample, not super-resolution — measured better than bilinear, no
detail added" and must not use language ("enhance," "detail," "upscale quality") that implies a
network ran. This matters here more than usual because the CONTROLS group it will sit inside is
literally labelled "Neural super-resolution" (§1/§6).

## 5. The failure mode this project keeps hitting — where would this integration silently drop a
param?

**Biggest concrete risk, if these had been given new axis/param names instead of new `neural`
values: `wireParams()` in the client hardcodes each axis by name.**

```js
params.deblur = e.deblur || 'off';
params.denoise = e.denoise || 'off';
params.sr = e.sr || 'off';
...
params.deblock = e.deblock != null ? e.deblock : (state.prefs.deblock || 'off');
params.neural = e.neural != null ? e.neural : (state.prefs.neural || 'off');
params.game = e.game != null ? e.game : (state.prefs.game || 'off');
```
(gpu-upscale.js:3001-3034)

This is not derived from `CONTROLS` — it is a hand-maintained list, and AGENTS.md records that this
exact list is what went wrong before: *"An axis that was never sent. addParams wrote eight axes and
omitted neural. Every neural level a viewer picked did nothing, silently, for two sessions."* A new
axis name for `vsr_rtcuda` would need a new line here or repeat that bug precisely.

**Second concrete risk, same shape, server side:** `UpscaleEngine._axisNames`
(UpscaleEngine.cs:772-776) is the list `RememberOrRestoreOptions()` uses to survive the HLS
variant-playlist hop — the documented reason axes exist at all past the first request
(UpscaleEngine.cs:784-797: *"THE PARAMETERS DO NOT SURVIVE THE HLS MASTER PLAYLIST... PlaySessionId
does survive that hop, so the axes are remembered against it."*). A new axis name left out of this
array would work on the very first request and then silently vanish on every subsequent segment
request — the same "renders, is stored, and is never sent" shape, one hop later than the client-side
version of the bug.

**Because this design keeps both filters as values of the existing `neural` param, neither list
needs to change** — `neural` is already in both (gpu-upscale.js:3033, UpscaleEngine.cs:774). That
removes this specific risk class for this integration, which is the strongest practical argument
for §1's recommendation, not just a tidiness one.

**What would still need a live check, not guessed:** confirming `neural` genuinely does survive to
the *n*th HLS segment request for a live session choosing `dlpp-1` or `vsr-rtcuda` — the mechanism
should hold (the axis is already remembered), but this project has been burned before by "should
hold" without checking. Proof: `journalctl -u jellyfin | grep -E "dlpp_rtcuda|vsr_rtcuda"` across at
least two consecutive segment requests of the same session, plus the reverse check (axis left at
`off` must not appear in the command). UNVERIFIED without that.

## 6. UI/UX treatment

**`dlpp_rtcuda`'s four levels:** do not use the `grade` array shape (`grade: ['off','low',...]`,
e.g. the `denoise`/`deblock` controls) — `grade` visually and semantically implies a ladder, and
levels 1-4 are explicitly not one (§4). Use a flat `options` list with no `grade` key, the same
shape `game` and `refine` already use for non-ladder choices (gpu-upscale.js CONTROLS: `game`
control has `options: [{id:'off',name:'Off'}]` populated from the probe, no `grade`). Each option's
`name` should come from the probe carrying the DEGRADED framing from §4 per level (e.g. "Level 1 —
most validated" rather than "Low"), exactly as `GameLabels`/`GameOptionLevels` already drive wording
from the server rather than from this script (gpu-upscale.js comment at the `game` control: "The
options and their names are taken whole from the probe... nothing here decides which of them
exists, and nothing here writes their wording").

**`vsr_rtcuda` vs. existing non-neural scalers:** the honest place for it, if the codebase had one
list mixing GLSL scalers and CUDA filters, would be right beside `nvscaler`/`ravu-zoom` — all three
are "this isn't a trained network, it's a different way to make the picture bigger." It cannot
physically be in that list (§1, `sr` is GLSL-only). Given it must live in the `neural` control for
wiring reasons, put it **first** in that control's option list, immediately after "Off" and before
any real network entry, with a name that says up front it isn't one: `"VSR resample (RTX, fast —
not a neural network)"`. Do not group it under the same visual weight as the Real-ESRGAN entries.

**Should "GPU-resident" be user-visible?** **No — keep it invisible, consistent with existing
precedent.** `GpuResidentEncode` is already a dashboard-only, advanced, off-by-default setting with
no client-facing control (`PluginConfiguration.cs`), specifically because it is not yet verified
safe (§2). A per-session GPU-resident toggle for these two filters would expose an implementation
detail a viewer cannot reason about and, per §2, might currently silently do nothing anyway (the
Vulkan→CUDA bridge these levels would need for anything beyond the filter itself is broken).
What *should* be user-visible, matching this project's "report the negative" rule (AGENTS.md
invariant #7), is that choosing `dlpp-*`/`vsr-rtcuda` turns off Detail/Refine/Chroma/Debanding for
that session (§2 point 3) — that's a real, felt consequence, not an internal detail, and it belongs
in the session record the same way `SrOwnsSharpening` already reports NVScaler dropping the
separate sharpen pass (UpscaleEngine.cs:1391-1401).

## 7. Interaction with the two known UX traps

**Scroll-wheel-controls-volume:** orthogonal. That bug is about an event listener on the panel
overlay stealing wheel events from the player underneath (project CLAUDE.md, "the panel sits over
the player, which binds the wheel to volume"). It has nothing to do with which axis values exist;
adding two more `neural` options does not change the panel's DOM structure or its event handling.
No new risk here.

**Direct-play live-apply bug:** not new, but the same surface applies. That bug is "a direct-playing
session has nothing to re-negotiate, so picking an enhancement did nothing until it timed out," and
the fix already in place is to re-play the item at its position (project CLAUDE.md). Choosing
`dlpp-1` or `vsr-rtcuda` while a file is direct-playing is exactly this scenario, no differently
than choosing any other existing level — **as long as** the same re-play-at-position live-apply
code path is what runs for the `neural` control's `applyLive` handling, which it already is (it's
one shared mechanism, not per-axis). **UPDATE (2026-09-24, `.agent-briefs/fix-panel-bugs.md`):
confirmed by static code read, still not a live playback test.** `requestRestream()` is called
generically by every control; `doApply()`/`directPlaying()`/`replayHere()` read only server/player
state, never the axis that changed; and `anyEnhancement()` already iterates every `wireParams()`
key including `neural` (gpu-upscale.js:775-777 documents this was fixed generally, not per-axis).
No special-casing anywhere would exclude a neural-only pick. A real playback session on CT114 to
confirm end to end is still outstanding - this task's hard limits (no restart, no plugin
activation) kept that out of scope again this pass, same as before.

## 8. Concrete CONTROLS/LIVE_ROWS spec

**No new `CONTROLS` entry.** Extend the existing `neural` entry (gpu-upscale.js, `key: 'neural'`):

```js
{
    key: 'neural', label: 'Neural super-resolution', fallback: 'off', group: 'Detail',
    probeKey: 'Neural', costKey: 'neural',
    options: [
        { id: 'off', name: 'Off' },
        // NEW — first, and named to disclaim "neural" up front (§1, §6):
        { id: 'vsr-rtcuda', name: 'VSR resample (RTX, fast — not a neural network)' },
        { id: 'realesr-anime-x2', name: 'Real-ESRGAN x2 anime (0.56x realtime - slow)' },
        { id: 'realesr-anime-x4', name: 'Real-ESRGAN x4 anime (0.34x realtime - very slow)' },
        { id: 'realesr-general-x4', name: 'Real-ESRGAN x4 general (0.24x realtime - slowest)' },
        // NEW — four flat, non-ladder entries, wording driven by probe per §4/§6, NOT
        // hardcoded here (these strings are illustrative placeholders, not final copy):
        { id: 'dlpp-1', name: 'RTX DLPP level 1 (most validated)' },
        { id: 'dlpp-2', name: 'RTX DLPP level 2' },
        { id: 'dlpp-3', name: 'RTX DLPP level 3' },
        { id: 'dlpp-4', name: 'RTX DLPP level 4' },
        { id: 'vsr', name: 'NVIDIA Maxine Video Super Resolution (not yet working - see VSR.md)' }
    ]
}
```

(`vsr` id kept last, untouched — it's the pre-existing, still-gated Maxine placeholder; do not let
the new `vsr-rtcuda` id collide with it, per §1.)

**No new `LIVE_ROWS` line.** The existing row already reads whatever the record carries:

```js
{ label: 'Neural SR', level: 'NeuralLevel', applied: 'NeuralApplied', requested: 'NeuralRequested' }
```

That's `NeuralLevel`/`NeuralApplied`/`NeuralRequested` on `SessionRecord` (UpscaleEngine.cs:96-117),
already populated the same way for every other neural value — no server-side field additions needed
for the row itself to work, only for `ShaderLibrary.NeuralName()` (UpscaleEngine.cs:527-540) to
grow two more `if` branches so the summary text says "RTX DLPP level N" / "RTX VSR resample" instead
of falling through to a generic label.

**What the probe needs to add**, mirroring how `AvailableNeuralLevels()` (ShaderLibrary.cs:1136-1170)
already filters `_neuralMenu` down to what's actually installed:
- Availability for `dlpp-*`: not a model-file check like Real-ESRGAN (`NeuralModelPath` +
  `File.Exists`) — these need "is `nvdlppx.dll` mapped and did the init-time self-test pass," which
  is a DLL-presence-plus-selftest check, structurally closer to how `VsrOffered`/`VsrLevel` are
  gated today (ShaderLibrary.cs:604-606) than to the Real-ESRGAN file-existence check. A new
  constant pair (e.g. `DlppOffered`, gated the same defensive way as `VsrOffered`) is the template
  to copy, not the Real-ESRGAN path.
- Availability for `vsr-rtcuda`: same shape, gated on `nvaivpx.dll` being mapped and its own
  init-time self-test (`gu_vsr_embed_selftest()`, `vf_vsr_rtcuda.c`) passing.
- Per-level DEGRADED text for `dlpp-*` (§4) and the "not neural" framing for `vsr-rtcuda` (§4),
  both server-supplied strings the way `GameLabels` already supplies wording for the `game`
  control, not literals in this script.
- Whatever the probe reports for "this session will lose Detail/Refine/Chroma/Debanding if you pick
  this" (§6), so the panel/session record can say it plainly rather than the viewer discovering it
  by comparing two runs.

---

**Everything above marked UNVERIFIED needs a live server check before this ships** — most
importantly §2's CUDA hwaccel branch (nothing like it exists to test against yet) and §5's
"does the neural axis really survive to segment N" question (should hold on paper, not yet proven
for these two values on a real session).
