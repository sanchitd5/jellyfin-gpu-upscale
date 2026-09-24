# Web panel design: `dlpp_rtcuda` and `vsr_rtcuda` in the Enhance panel

First design pass, for review. Written against the working tree as of this session, which
includes the uncommitted backend wiring in `UpscaleEngine.cs`, `ShaderLibrary.cs`,
`UpscaleSettings.cs`, `PatcherHost.cs` and a comment-only change in `web/gpu-upscale.js`. Nothing
here has been driven against a live server. Items marked **Q:** are questions for the user, not
decisions. Items marked **VERIFY** are claims this document depends on that only a real session
can settle.

Sources read: `web/gpu-upscale.js` (all 3468 lines), `CLAUDE.md`, `AGENTS.md`,
`INTEGRATION_DESIGN.md`, `RTXDLPP.md`, `RTXVSR.md`, `roadmap/driver-features.md`,
`roadmap/gpu-only-filters.md`, `src/patcher/UpscaleEngine.cs`, `src/patcher/ShaderLibrary.cs`,
`src/patcher/PatcherHost.cs`, `src/patcher/UpscaleSettings.cs`,
`src/Configuration/PluginConfiguration.cs`, and the current `git diff` of the concurrent backend
work.

---

## 0. What the backend now does, in one paragraph

Both new filters are levels on the existing `neural` axis: `vsr-rtcuda` and `dlpp-1` to `dlpp-4`.
`UpscaleEngine.Decide` reads `Option(state, "neural")`, and if `ShaderLibrary.IsCudaNeuralLevel`
says yes it takes a separate CUDA hwaccel branch: `decode cuda -> [optix] -> filter -> NVENC`. On
that branch it **forces off** `sr`, `refine`, `chroma`, `deblur`, `game` (and so `jitter`,
`depth`, `reactive`), and drops any denoise that is not `optix`/`optix-temporal`, recording the
dropped level in `DenoiseDroppedForPatchedBinary`. `deband` and `kernel` are libplacebo, which
does not exist on that branch either. The probe (`PatcherHost.Levels()`) lists the two levels
only when `nvaivpx.dll` / `nvdlppx.dll` are on disk and serves per-level wording in
`NeuralLabels`. The `upscale` target still decides the output size; `CudaNeuralFilter` is handed
`plan.Width`/`plan.Height`.

That is the wire truth this panel has to represent. Everything below is constrained by it.

---

## 1. Information architecture

### 1.1 Where the panel puts things today

```
Quality        Automatic / Off / Manual + ladder slider           (always visible)
Upscale to     chips                                     basic:1
Detail (SR)    picker                                    basic:2
Denoise        chips                                     basic:3
Advanced  (one disclosure, closed)
   Sharpness   Unblur
   Noise       Clean up compression
   Detail      Neural super-resolution, Game temporal upscaler [+ jitter/depth/reactive cluster],
               Refine, Chroma
   Picture     Debanding, Scaling kernel
What the server is doing   (live block, outside the disclosure, refreshed every 3 s)
```

Groups are `group:` fields on `CONTROLS`, rendered in first-appearance order. Tiering is
`basic:` (or `atSource:` when nothing can be enlarged). Options for probe-driven axes come whole
from the probe (`fromProbe: true` plus `labelsKey`).

### 1.2 Decision: both stay on the `neural` control, inside Advanced > Detail

Reasons, in order of weight:

1. **The wire has one parameter.** The server reads `neural=`. A second control would need the
   client to compose or arbitrate two preferences into one parameter, which is a new place for
   "stored but never sent" to happen. Every axis the panel sends today is one preference to one
   parameter, and `wireParams()` is auditable because of that. Keep it.
2. **Advanced is where opt-in, DLL-gated, unverified-in-production levels already live.** Game
   upscalers (`fsr2`/`dlss`/`dlaa`) are the precedent: expensive, need a runtime the plugin does
   not ship, self-described as DEGRADED, never chosen by the ladder. `dlpp-*` matches every one of
   those properties. Promoting it to the basic tier would put an unverified level beside the
   ladder that is verified.
3. **The ladder is unaffected.** Quality stages set `sr`, not `neural`. A viewer who never opens
   Advanced never meets these levels, and the ladder keeps working exactly as before.

### 1.3 But the control is mislabelled once `vsr-rtcuda` is on it

`vsr-rtcuda` is not a network, and the brief is right that it must not read as "a weaker DLPP".
Two changes, both cheap and both inside the existing data-driven shape:

**(a) Rename the control.** `label: 'Neural super-resolution'` becomes
`label: 'Detail engine (RTX / neural)'`. Axis labels are client-side today (every `label:` in
`CONTROLS` is), so this does not break the "wording comes from the probe" rule, which governs
*level* names and degraded text. The live row `'Neural SR'` becomes `'Detail engine'` to match.
**Q:** naming is taste; "GPU detail engine" and "Detail (RTX / neural)" were the alternatives.

**(b) Group the options inside the picker.** The neural control renders as a native `<select>`
(`el('select', 'gpuup-sel')`, line 1907), because its wording is too long for chips. A native
select supports `<optgroup>`, which is exactly the tool for "three kinds of thing in one list":

```
Off
── Fast resample (not a network) ──
   RTX VSR resample (...)
── Trained networks ──
   Real-ESRGAN x2 anime (...)
   Real-ESRGAN x4 anime (...)
   Real-ESRGAN x4 general (...)
── RTX DLPP (content-dependent) ──
   RTX DLPP 1 (...)
   RTX DLPP 2 (...)
   RTX DLPP 3 (start here ...)
   RTX DLPP 4 (...)
```

Group membership and group headings are display wording about levels, so they come from the
probe, not from the script: two new probe keys, `NeuralFamilies` (level id to family id) and
`NeuralFamilyLabels` (family id to heading). A server that does not send them yields today's flat
list, so an old server and a new script still agree. Order within the select: Off first, then
families in the order the probe lists them, then any level the probe did not assign a family, flat,
at the end. No level is ever hidden by grouping: `AvailableNeuralLevels` still decides existence.

This answers `INTEGRATION_DESIGN.md` §6's "put VSR first, immediately after Off": agreed on the
position, but position alone does not say *why* it is separate. A heading does, and reads
correctly on a TV remote too, where optgroup headings are announced.

### 1.4 Considered and rejected: one "RTX DLPP" option plus a level sub-row

Modelled on the game cluster (`expert:` + `showWhen`): one option "RTX DLPP" in the picker, and a
"DLPP level: 1 2 3 4" chip row shown only when it is chosen. It reads well and hides the number
from a casual viewer. Rejected because the client would have to build `neural=dlpp-N` from two
preferences, which is composition code in the one path (`wireParams`) that today is a straight
copy of preferences. The `game` cluster is different: its three inputs are three *separate*
parameters the server reads separately. Four flat ids cost the viewer one longer list and cost
the audit chain nothing.

### 1.5 Considered and rejected: `vsr-rtcuda` in the `sr` (Detail) list

Semantically it belongs beside `nvscaler` and `ravu-zoom`. It cannot go there: `sr` is a GLSL hook
list, `SrLevel`/`SrRequested`/`SrBypassed` carry GLSL semantics (`SrMinScaleFactor` gating), and
the server forces `sr` off on the very branch `vsr-rtcuda` runs on. A client that offered it there
would send `sr=vsr-rtcuda`, which nothing reads. That is the dead-control failure by construction.

---

## 2. The level-ranking problem (`dlpp-1` to `dlpp-4`)

### 2.1 What is actually known

Measured gain is positive on everything tested, 2 to 14 dB luma PSNR depending on content;
levels 3 and 4 beat level 1 on most sources; on one source level 1 was ahead. No level is ever
negative. What the four numbers mean inside `nvdlppx.dll` is not documented to us.

So this is not "which is best", it is "which to try first, and how to say that the answer moves".

### 2.2 Decision

1. **Keep the numbers, keep numeric order.** The ids are `dlpp-1`..`dlpp-4` on the wire and in
   the session record, NVIDIA's own material calls them levels 1 to 4, and the live block will
   print "RTX DLPP level 3". Renaming them to words ("Gentle", "Standard") would invent a ladder
   the data says does not exist, and would make the panel and the record disagree with each
   other. Reordering (3, 4, 1, 2) would make the list look broken.
2. **Mark exactly one as the starting point, in the server's wording.** `dlpp-3`'s label carries
   "(start here)". One marked entry is how a casual viewer gets an answer without reading a
   caveat; the other three say nothing more than "content-dependent". **Q:** 3 or 4? The brief
   says "3/4 usually beat 1"; pick whichever won on more sources in your notes. The label lives
   in `ShaderLibrary.NeuralLabel`, so changing the pick is a one-string server change with no
   client work.
3. **One short caveat, shown only when a DLPP level is selected, not in every label.** A
   `gpuup-note` under the picker:

   > RTX DLPP levels are not a strength ladder. Gain depends on the content: try 3 first, and
   > compare 1 if it looks over-processed. The block below reports which level actually ran.

   This is degraded wording about a level, so it is served: new probe key `NeuralNotes`, level id
   to note, and the panel shows `NeuralNotes[selected]` when present. Real-ESRGAN entries get no
   note (their honesty is already in the name: "0.24x realtime - slowest"). `vsr-rtcuda` gets one
   line: "A fast GPU resample, better than bilinear. It adds no detail; pick a trained network for
   that."
4. **No number in the label describes strength.** No "light/strong", no "x2/x4", no PSNR figures.
   The four measured numbers are content-specific and would be read as a ranking.
5. **Do not shorten the labels in a way that drops the caveat.** The neural picker never renders
   as chips (`chipIds` is empty for it because it has no `grade` and more than 4 options), so
   `shortName()`'s "cut at ` (`" never applies here. Keep it that way: do not add `chips: true`
   to this control.

### 2.3 What the server strings should be

The current `ShaderLibrary.NeuralLabel` strings are about 110 characters and repeat the caveat
four times; in a native select on a 1080p TV that truncates to "RTX DLPP level 1 (DEGRADED: con".
Proposed replacements, keeping the id-to-wording ownership exactly where it is:

| level | `NeuralLabels[level]` (picker) |
|---|---|
| `vsr-rtcuda` | `RTX VSR resample (fast; not a neural network, adds no detail)` |
| `dlpp-1` | `RTX DLPP 1 (content-dependent)` |
| `dlpp-2` | `RTX DLPP 2 (content-dependent)` |
| `dlpp-3` | `RTX DLPP 3 (start here; content-dependent)` |
| `dlpp-4` | `RTX DLPP 4 (content-dependent)` |

Headings (`NeuralFamilyLabels`): `resample` -> `Fast resample (not a network)`,
`network` -> `Trained networks`, `dlpp` -> `RTX DLPP (content-dependent, not a ladder)`.

The report string (`UpscaleEngine.NeuralName`, what the live block prints) can stay long: that is
where "DEGRADED: gain is content-dependent across levels, never negative but never large either"
belongs, read after the fact, on one line of its own.

### 2.4 Considered: an A/B affordance

"Try the other level" as a button would be honest UX for a content-dependent choice. It is a
full re-negotiation per press (or a re-play at position on direct play), and there is no way to
show two levels at once. Not in this pass. **Q:** worth a follow-up as "remember the last two
neural picks and offer 'switch back' in the live block"?

---

## 3. The mutual-exclusivity problem

### 3.1 The rule to mirror

The server's rule is one-directional and already decided: **a CUDA-native neural level wins**, and
the Vulkan/libplacebo axes are forced off for that session. The panel must mirror that direction
exactly, or the panel and the record disagree.

Axes affected when `neural` is `vsr-rtcuda` or `dlpp-*`:

| axis | server behaviour on the CUDA branch | panel treatment |
|---|---|---|
| `sr` | forced `off` | inert |
| `refine` | forced `off` | inert |
| `chroma` | forced `off` | inert |
| `deblur` | forced `off` | inert |
| `game`, `jitter`, `depth`, `reactive` | forced `off` | inert (cluster) |
| `deband`, `kernel` | no libplacebo on this branch | inert. **VERIFY** the record reports them off (see 3.5) |
| `denoise` | only `optix`/`optix-temporal` run; anything else dropped and reported | option-level inert (3.3) |
| `deblock` | **VERIFY**: unclear from the diff whether deblock survives the CUDA branch | inert until verified |
| `upscale` | still sets the target size | untouched |

### 3.2 Mechanism: the existing `CONFLICTS` table, driven by probe data

The panel already has the right tool. `CONFLICTS` (line 1724) is a list of `{key, when, why}`
rules; `axisConflict(key)` returns the first `why` that fires; `pick()` renders the row with class
`gpuup-inert`, disables its chips or select, keeps the stored preference, and puts `why` in the
tooltip. It is how "fsr2 owns the output size, so Detail is off" is shown today. Nothing about
that behaviour needs to change; it needs more rules and a data source.

Add **one** rule per affected axis, all sharing one predicate:

```js
function neuralIsCudaNative(p) {
    var cuda = (state.serverCaps && state.serverCaps.levels
        && state.serverCaps.levels.NeuralCudaLevels) || [];
    return cuda.indexOf(p.neural) >= 0;
}
```

`NeuralCudaLevels` is a new probe key: the server's `IsCudaNeuralLevel` set, listed. This is the
same pattern as `GameOptionLevels` driving `showWhen`. **Never** test `p.neural` with a prefix
match in JS (`/^dlpp-/`, `=== 'vsr-rtcuda'`): the pre-existing Maxine placeholder id is `vsr`, a
prefix match on `vsr` would catch both, and a level renamed on the server would silently stop
being recognised as CUDA while the server still treated it as such. That is the drift this
project keeps hitting, in a new coat.

The list of axes to disable should also be data: `NeuralCudaDisables: ['sr','refine','chroma',
'deblur','game','deband','kernel']` from the probe, and the client generates one rule per entry.
Then a backend change to what the branch can reach is one server-side list edit and the panel
follows. The `why` text stays client-side, as every existing `CONFLICTS.why` is:

> "{Level name} runs on the CUDA path, which has no Vulkan stage, so the server turns this off
> for the session."

where `{Level name}` is the probe's `NeuralLabels[p.neural]` cut at the first ` (`.

### 3.3 Denoise is the one axis that is partly available

On the CUDA branch `optix` and `optix-temporal` still run; `atadenoise`/`nlmeans` levels are
dropped and reported in `DenoiseDroppedForPatchedBinary`. Disabling the whole Denoise row would
stop a viewer picking the one denoiser that *does* work there, so this axis gets **option-level**
inertness rather than row-level:

- New probe key `CudaDenoiseLevels: ['off','optix','optix-temporal']` (whatever
  `ShaderLibrary.CudaDenoiseFilter` accepts).
- When `neuralIsCudaNative(p)`: every Denoise chip whose id is not in that list renders disabled
  with title "Not available on the CUDA path; only OptiX denoise runs beside RTX levels." The
  chips in the list stay live.
- If the *current* denoise preference is one of the disabled ones, the row also carries the
  inert class and the tooltip, so the viewer sees that their stored pick is what will be dropped,
  and the live block will confirm it (3.5).

This needs a small addition to `pick()`: an `optionInert(c, id)` hook consulted per chip/option,
alongside the existing row-level `axisConflict(c.key)`. It is the only new rendering code this
design asks for.

### 3.4 The consequence must be stated once, up front, not discovered row by row

Inert rows are scattered inside Advanced, some behind the closed disclosure. A viewer who picks
`dlpp-3` from the Detail group, closes Advanced and watches sees the ladder's Detail (SR) row
greyed and nothing else. So: when `neuralIsCudaNative(p)` and at least one of the disabled axes
holds a non-default preference, render one `gpuup-note` **directly under the neural picker**:

> RTX DLPP 3 runs on the CUDA path. For this session the server will turn off: Detail (FSRCNNX),
> Refine, Debanding. Your picks are kept and come back when you choose Off or a Real-ESRGAN level.

The axis names are the `CONTROLS[].label` strings for the entries in `NeuralCudaDisables` whose
preference differs from their fallback (the same test `changedCount` already uses). If nothing
would be dropped, no note: silence is the correct output when nothing is lost.

Also raise the Advanced disclosure's `changedCount` badge behaviour: an inert-but-set axis should
still count, so the closed summary does not read "0 set" while three picks are being suppressed.
**VERIFY** current `changedCount` semantics; if it already counts them, nothing to do.

### 3.5 The record must say the same thing

The live block is the only honest source. Today `LIVE_ROWS` prints `Detail (SR)` from `SrLevel`
+ `SrRequested`, so a forced-off `sr` with a requested value already prints as "requested X, not
applied". Same for Refine, Chroma, Game via their `applied` fields. Additions, all data lines:

```js
{ label: 'Pipeline', level: 'Pipeline' },                    // 'CUDA (RTX)' or 'Vulkan', see 4.2
{ label: 'Denoise dropped', level: 'DenoiseDroppedForPatchedBinary' },
```

`DenoiseDroppedForPatchedBinary` already exists on the record (it predates this work). A null
row prints nothing, so on a normal session neither line appears.

**VERIFY** on a real session that `SrRequested` is still populated when the branch forces
`srLevel = "off"` (the diff sets the local *after* `plan.SrRequested` is assigned, which is what
we want; confirm by reading the served JSON). **VERIFY** `DebandApplied` and `Upscaler` report
correctly on that branch, since they have no explicit force-off in the diff.

### 3.6 The reverse direction

A viewer with `dlpp-3` chosen cannot pick `fsr2` or an SR level, because those rows are inert. So
there is no "vice versa" to arbitrate: the only way out is changing the neural pick. That is
simpler than a two-way rule and it is what the server does. The inert tooltip already says how to
get the row back.

### 3.7 The Quality ladder while a CUDA level is chosen

Stages set `sr` (always `fsrcnnx`, the known wart) and the size target. With `dlpp-*` chosen the
stage's `sr` is inert and the target still applies, so the slider keeps meaning "how big". The
stage caption already states cost from the cost tables; DLPP's cost is not in `COSTS` (see 6.4),
so the caption would understate it. Acceptable for a first pass; flagged.

---

## 4. Visual and interaction spec

### 4.1 States of the Detail engine row

| state | rendering |
|---|---|
| default, server offers no RTX level | picker shows Off + Real-ESRGAN entries exactly as today; no headings unless probe sends families |
| server offers RTX levels | picker with `<optgroup>` headings from `NeuralFamilyLabels`; each option text is `NeuralLabels[id] + costSuffix` |
| selecting (select open) | native; the 3 s live re-render is already suppressed while a `<select>` inside the panel has focus (line 2706), so the list does not close under the pointer |
| RTX level chosen, nothing else set | row shows pick; `NeuralNotes[id]` under the row in `gpuup-note` |
| RTX level chosen, suppressed picks exist | as above, plus the 3.4 consequence note under the row; affected rows inert with tooltip |
| applied | live block: `Detail engine: RTX DLPP level 3 (nvdlppx.dll), DEGRADED: ...` from `NeuralName`; `Pipeline: CUDA (RTX)` |
| requested, not applied | live block prints "requested dlpp-3, not applied" via existing `requested`/`applied` handling; stale note above the block until the re-negotiation lands (existing `staleNote`) |
| DLL removed since the panel opened | next open re-probes (`openEnhancePanel` always probes); level disappears from the list; stored preference now maps to no option, so the existing fallback path shows Off and the preference is left untouched |

### 4.2 Pipeline row wording

The record needs a plain field for the branch: `Pipeline = "CUDA (RTX)"` when `UsesCudaNeural`,
`"Vulkan"` otherwise. This is the one place I disagree with `INTEGRATION_DESIGN.md` §6: the
*path* should be visible, in the record, because it is the explanation for five rows being off.
What stays invisible is any *control* over it: no toggle, no "GPU-resident" checkbox. The viewer
picks a level; the server reports the path that level implies. `GpuResidentEncode` stays a
dashboard setting with no client surface, as today.

### 4.3 Layout, concretely

- No new rows outside Advanced. No new disclosure. No new section.
- Advanced > Detail order: Detail engine, Game temporal upscaler cluster, Refine, Chroma
  (unchanged; only the label changes).
- Notes use the existing `gpuup-note` style (same as the cost warning). Two notes stacked under
  one row are acceptable; if both fire, the consequence note (3.4) goes first because it is about
  loss, and the level note (2.2) second.
- Inert rows use the existing `gpuup-inert` treatment and tooltip. No new colours, icons or
  badges. **Q:** would a short inline "(off on CUDA path)" text after the inert row's label help on
  TV clients where tooltips do not exist? Cheap to add; not in this pass unless wanted.
- Optgroup headings inherit the select's font; on jellyfin-web's dark theme native optgroups are
  legible in Chromium and Firefox. **VERIFY** on the TV/Android app webview once, since select
  styling is the one thing browsers differ on.

### 4.4 Interaction rules that must not regress

- **Wheel/touch**: notes and optgroups add no new scroll surface; everything is inside the panel
  element whose `wheel`/`touchmove` listeners already stop propagation. Nothing to do, but keep
  any new element inside `#gpuup-panel`.
- **Apply path**: the neural control uses the shared `applyLive` -> re-negotiate -> on direct play,
  re-play at position path. These are values, not a new control, so they take the same path.
  `anyEnhancement()` already tests the whole `wireParams()` object (line 766), so a Custom
  selection carrying only `neural=dlpp-3` forces the transcode. **VERIFY** end to end anyway: this
  is exactly the axis that was once never sent.
- **Focus**: `<optgroup>` is not focusable and does not appear in `FOCUSABLE`; tab order is
  unaffected. Disabled options are skipped by the native select.
- **Live re-render**: the consequence note is derived from `shownPrefs()` and the probe, not from
  the record, so it renders synchronously with the pick and does not flicker on the 3 s refresh.

### 4.5 Stop rules

Named explicitly, consolidating rules scattered across sections 3-4 above, because "when does the
panel refuse to proceed" is exactly the kind of thing that erodes silently across small edits if
it only exists as scattered prose. Every future change to the panel should be checked against this
list before shipping.

1. **Never show an impossible combination as available.** Picking a CUDA-native `neural` level
   (`vsr-rtcuda`, `dlpp-1..4`) must mark every axis it forces off (section 3.1's list) as
   `gpuup-inert` immediately, via `CONFLICTS`, exact-id match only, never a prefix match (a loose
   match on `vsr` would also catch the retired Maxine placeholder -- see section 3.6/the removed
   entry). The reverse direction holds too: picking any of those axes while a CUDA-native level is
   active must mark the neural row itself as the thing that's about to change, not leave the user
   guessing which side gave way.
2. **Never send a change the server didn't actually honor.** `wireParams()` reflects only real,
   server-confirmed state. The record (section 3.5) is the source of truth for what applied; the
   client's own optimistic state is never substituted for it in what gets displayed as "current."
3. **Never live-apply when there's nothing to renegotiate.** Direct play has no live stream to
   update. A neural-only change takes the same `applyLive` -> re-negotiate -> replay-at-position
   path as every other axis (section 4.4); this must hold for the CUDA-native levels specifically,
   not just be assumed to inherit it, per the **VERIFY** note in 4.4.
4. **Never let a new element create a new scroll surface.** Anything added to the panel stays
   inside `#gpuup-panel`, whose wheel/touch listeners already stop propagation to the player's
   volume control (section 4.4). This is a regression risk on every future addition, not a
   one-time fix.
5. **Never hardcode a name, a level's behavior, or DEGRADED wording client-side.** All of it comes
   from the probe (section 5), every time, including for levels added after this document. If the
   probe hasn't supplied a string for something, show nothing rather than inventing text.
6. **Never bump `VERSION` in the injector ahead of the matching server change going live**, and
   never publish `gpu-upscale.js` to the live web root before the server-side change it depends on
   is actually deployed -- a stale script serves the OLD behavior under a NEW cache-busted URL,
   which reads as nothing changed rather than as a rollback, and is worse than either.

---

## 5. Server-side versus client-side wording

Rule, restated and applied: **anything that names or qualifies a level comes from the probe;
anything that names an axis or explains a client-side rule may live in the script.**

### 5.1 Probe additions (all under `levels`)

| key | shape | example |
|---|---|---|
| `NeuralLabels` | id -> string | exists; strings revised per 2.3 |
| `NeuralFamilies` | id -> family id | `{"vsr-rtcuda":"resample","realesr-anime-x2":"network",...,"dlpp-1":"dlpp",...}` |
| `NeuralFamilyLabels` | family id -> heading | `{"resample":"Fast resample (not a network)","network":"Trained networks","dlpp":"RTX DLPP (content-dependent, not a ladder)"}` |
| `NeuralNotes` | id -> one-line note | `{"dlpp-1":"...","dlpp-3":"RTX DLPP levels are not a strength ladder. Gain depends on the content: try 3 first, and compare 1 if it looks over-processed.","vsr-rtcuda":"A fast GPU resample, better than bilinear. It adds no detail; pick a trained network for that."}` |
| `NeuralCudaLevels` | list of ids | `["vsr-rtcuda","dlpp-1","dlpp-2","dlpp-3","dlpp-4"]` |
| `NeuralCudaDisables` | list of axis keys | `["sr","refine","chroma","deblur","game","deband","kernel"]` |
| `CudaDenoiseLevels` | list of ids | `["off","optix","optix-temporal"]` |

Every one of these is derived on the server from the same functions the transcode uses
(`IsCudaNeuralLevel`, `CudaDenoiseFilter`, the force-off block in `Decide`). If a key is absent,
the client behaves as today (flat list, no CUDA rules), so mixed versions degrade to "no new UI"
rather than to wrong UI.

### 5.2 Session record additions

| field | value |
|---|---|
| `Pipeline` | `"CUDA (RTX)"` or `"Vulkan"` |
| `DenoiseDroppedForPatchedBinary` | exists; ensure it is set on the CUDA branch (the diff does) |

### 5.3 Client-side strings this design adds

- Control label `Detail engine (RTX / neural)`; live row label `Detail engine`; live row labels
  `Pipeline`, `Denoise dropped`.
- `CONFLICTS.why` text for the CUDA rule (3.2) and the denoise option tooltip (3.3).
- The consequence note template (3.4), which interpolates probe strings and control labels.

Nothing else. In particular the script gains no list of which ids are DLPP, no regex on level
ids, and no cost numbers for the new levels (6.4).

---

## 6. Things found in the existing panel while reading it

### 6.1 A comment that references code which does not exist (FIXED)

`web/gpu-upscale.js` line 161 said "see `neuralCudaBypass` in the session-record row wiring".
There is no `neuralCudaBypass` anywhere; the real field is `SessionRecord.CudaNeuralBypass`.
Fixed: comment now says `CudaNeuralBypass`.

### 6.2 The debug log omits the axis that was once never sent (FIXED)

`rewriteBody` recorded `state.marked.push([e.upscale, e.deblur, e.denoise, e.sr].join('/'))`.
`neural` was not in it, nor `game`. The one time this log would have caught the "neural never
sent" bug, it could not have. Fixed: now
`[e.upscale, e.deblur, e.denoise, e.sr, e.neural, e.game].join('/')`.

### 6.3 `ShaderLibrary.NeuralLabel` strings are too long for a select (server, cheap)

Covered in 2.3. Keep the long text in `NeuralName` for the record; shorten the picker label.

### 6.4 `COSTS` has no entry for the new levels (FIXED, provisional)

`costSuffix()` prints `[GPU Nx]` from a client-side table of measured relative costs. There was
no entry for `dlpp-*` or `vsr-rtcuda`. Fixed: added `'vsr-rtcuda': 2` and `'dlpp-1'..'dlpp-4': 3`
to `NEURAL_COST`, derived from RTXDLPP.md's 113 fps at 1080p->4K against a 265 fps off baseline
(~2.3x), not from a matching 960x540->1080p reading like the realesr entries, so the numbers are
provisional and documented as such in the comment above the table. Moving `COSTS` to the probe
(the more consistent answer) is still open and out of scope for this pass.

### 6.5 The Maxine `vsr` placeholder is still an option in the ceiling list (FIXED)

`{ id: 'vsr', name: 'NVIDIA Maxine Video Super Resolution (not yet working - see VSR.md)' }` has
been removed from the `neural` control's `options`. `VSR.md`'s banner now says RETIRED
(2026-09-23, build flag renamed `WITH_VSR` -> `WITH_MAXINE_VSR`, gated behind
`MAXINE_VSR_UNRETIRE=1`), so "not yet working" was stale wording for a permanently gated feature,
and the entry never reached a real viewer anyway (`ShaderLibrary.VsrOffered` is hardcoded
`false`). The server-side gate itself (`VsrLevel`/`VsrOffered`/`IsNeuralLevel("vsr")` in
`ShaderLibrary.cs`) is untouched - its own comment says not to remove it, and that is an engine
change outside this brief's scope.

### 6.6 The known ladder wart gets slightly worse, not broken

`effective()` returns `sr: LADDER_SR` for every stage and the panel re-seeds the Detail preference
from it. With a CUDA level chosen `sr` is inert, so the forced `fsrcnnx` is harmless. But a
viewer who set Detail to `anime4k` under Custom, then picks `dlpp-3`, then goes back to Off, will
find Detail back on `fsrcnnx` if they touched the Quality slider in between. Pre-existing; noted
because the new inert state makes the re-seed less visible while it happens.

### 6.7 Header comment versus tiers

The file header says the three basic axes are "the target, the detail network and denoise". The
`basic:` fields make them `upscale`, `sr` and `denoise`; the "detail network" (neural) is in
Advanced. The code is right and the comment is loose. Trivial.

---

## 7. Audit chain for the two new levels

The chain this project insists on, instantiated for `dlpp-3`, to be run once before calling any
of this done:

```
panel: Detail engine = RTX DLPP 3
  -> localStorage gpuUpscalePrefs.neural === 'dlpp-3'
  -> wireParams().neural === 'dlpp-3'   (and sr/refine/chroma still present in params: the
                                         client sends them; the SERVER forces them off)
  -> TranscodingUrl and the hls1 variant request carry neural=dlpp-3
  -> journalctl -u jellyfin | grep dlpp_rtcuda    shows the node with level=3
  -> served segment size equals the chosen target
  -> /GpuUpscale/Session/{id}: NeuralApplied true, NeuralLevel dlpp-3, Pipeline "CUDA (RTX)",
     SrRequested = whatever the ladder sent, SrLevel off
  -> panel live block prints all of the above; consequence note matches the record
```

And the negative: Detail engine = Off, `neural=off` on the URL, no `dlpp_rtcuda` in the command,
`Pipeline: Vulkan`, every previously inert row live again.

Note the deliberate choice in step 3: the client keeps sending `sr=`, `refine=` etc. alongside a
CUDA level rather than blanking them. The server is the arbiter and records the request honestly
(`SrRequested`); a client that pre-emptively dropped them would make the record read as if the
viewer never asked, which hides the very fact the consequence note is there to state.

---

## 8. Open questions, collected

1. Control name: `Detail engine (RTX / neural)` or an alternative (1.3a).
2. Which DLPP level carries "start here": 3 or 4 (2.2).
3. A/B "switch back" affordance as a follow-up (2.4).
4. Inline "(off on CUDA path)" text for TV clients without tooltips (4.3).
5. Moving `COSTS` to the probe instead of the client-side, provisional `dlpp`/`vsr-rtcuda`
   numbers now in place (6.4).
6. Delete the Maxine `vsr` ceiling entry now or later - RESOLVED, removed (6.5).

### VERIFY list, results (2026-09-24, static code read against CT114's current source, jellyfin
daemon confirmed active, no build/deploy/restart done - see report)

7a. **`deblock`/`deband`/`kernel` reporting on the CUDA branch** - FOUND A REAL BUG, FIXED.
    `Decide()` forced `sr`/`refine`/`chroma`/`deblur` off in the `UsesCudaNeural` branch but never
    touched `plan.DeblockApplied`/`plan.DeblockLevel`, and `BuildChain`'s CUDA-native branch
    returns only `CudaDenoiseNode` + `NeuralFilter` - it drops any deblock node silently. So the
    session record would have said `DeblockApplied: true` for a pass that never reached the
    built command: the exact "rendered, stored, never sent" failure class. Fixed: the CUDA branch
    in `Decide()` now resets `DeblockFilter`/`DeblockApplied`/`DeblockLevel`/`DeblockWantsHwFrames`
    the same way it already did for denoise. Deband (`plan.DebandApplied = wantDeband`, and
    `wantDeband` was already forced false on this branch) was already correct. `plan.Upscaler`
    (the scaling kernel) was also unconditionally set from the requested/default kernel string
    regardless of branch, so the record would report a kernel choice that never ran either -
    fixed the same way: null on the CUDA branch.
7b. **`changedCount` counting inert axes** - FOUND A REAL BUG, FIXED. The client's `CONFLICTS`
    table had no rule at all for the CUDA-native neural exclusivity: picking `dlpp-*`/
    `vsr-rtcuda` did not mark `sr`/`refine`/`chroma`/`deblur`/`game`/`deband`/`kernel` as
    `gpuup-inert` in the panel, so those rows stayed fully interactive with no visual indication
    the server was about to force them off - the dead-control failure this project keeps
    hitting, in the new axis. Fixed: added a `neuralIsCudaNative(p)` predicate (exact-id match
    against `['vsr-rtcuda','dlpp-1'..'dlpp-4']`, never a prefix test, per 3.2's own warning about
    the `vsr` placeholder) and one `CONFLICTS` entry per affected axis. This is a provisional,
    literal-id stand-in for the `NeuralCudaLevels`/`NeuralCudaDisables` probe keys 3.2 proposes;
    those are the more consistent long-term answer. `changedCount` itself is unchanged - it
    intentionally still counts an inert axis's non-default stored preference (same as the
    pre-existing `game`-owns-output-size conflicts), which is consistent, not a bug.
7c. **`anyEnhancement` forcing a transcode for a neural-only pick on direct play** - CONFIRMED
    CLEAN, no bug. `anyEnhancement()` already iterates every key in `wireParams()` including
    `neural` (the comment at gpu-upscale.js:775-777 documents this was already fixed generally).
    `requestRestream()` is called by every control with no axis-specific logic, and
    `doApply()`/`directPlaying()`/`replayHere()` are axis-agnostic: a neural-only pick on a
    direct-play session takes the identical re-play-at-position path as any other axis.
8. **Optgroup rendering in a TV webview** - STILL COULD NOT VERIFY on real TV hardware (none
   available this session either), but 1.3(b) is now BUILT (see section 9) rather than only
   proposed, so there is something to render-test on real hardware next time this ships.

---

## 9. Client restructuring and the open items this pass implemented (2026-09-24,
   `.agent-briefs/modularize-web-panel.md`)

`web/gpu-upscale.js` is no longer hand-edited. It is now a generated, committed build output.

**Superseded 2026-09-24** (`.agent-briefs/real-es-modules.md`): the numeric-prefix, `cat`-based
split described below (one paragraph, kept for history) was replaced with real ES modules and a
real bundler. Source now lives in `web/src/{lib,model,controller,view}/*.js` plus the entry point
`web/src/bootstrap.js`, using real `import`/`export`; `scripts/build-web-panel.sh` runs esbuild
(installed under `web/node_modules` from `web/package-lock.json`, gitignored, build-time only) to
bundle that module graph into one IIFE, banner-prefixed from `web/src/banner.txt`, with no
`import`/`export` surviving into the output and no runtime module system needed. See `CLAUDE.md`'s
"Before you change the client" section for the current file-by-file layout, and `context-map.md`
at the repo root for the full module list with what each one exports and imports.
`scripts/jellyfin-gpuupscale-webinject` copies the same one file, `web/gpu-upscale.js`, unchanged
in that respect; its cache-buster derivation changed separately (see its own header comment).

*(History, superseded above.)* The numbered-file split concatenated `web/src/*.js` in one shared
function scope, one file per real seam, numeric prefix fixing the concatenation order, with
`scripts/build-web-panel.sh` (`cat`, at the time) writing a three-line generated-file banner on
top. The split was done as literal line-range slices of the working file at the time, so the first
build was diffed byte-for-byte against the pre-split file (identical past the banner) before any of
the changes below were made.

Client-side items from sections 1-4 implemented this pass, all tolerant of an older server that
does not send the new probe keys (same "degrades to no new UI, not wrong UI" rule as every other
probe-driven field in this file):

- **1.3(a)** - the `neural` control's label is now `Detail engine (RTX / neural)` (`web/src/model/
  controls-data.js`); the matching live-block row (`web/src/controller/live-block.js`) is now `Detail engine`.
  **JUDGMENT CALL, not the user's**: the doc's own two alternatives were "GPU detail engine" and
  "Detail (RTX / neural)" - this pass picked the latter. Flag for revisit.
- **1.3(b)** - `<optgroup>` rendering in the neural picker (`controlRow()`, `web/src/view/panel-
  dom.js`), driven by two new optional probe keys the control now declares (`familiesKey:
  'NeuralFamilies'`, `familyLabelsKey: 'NeuralFamilyLabels'`, `web/src/model/controls-data.js`) and threaded
  through by `axisControls()` (`web/src/controller/probe.js`). Off and any ungrouped id render flat (Off
  first, ungrouped ids last); everything else groups in first-seen order. A server that sends
  neither key gets today's flat list, unchanged.
- **2.2/2.3** - a one-line, server-worded note for the CURRENT level (`notesKey: 'NeuralNotes'`),
  rendered under the picker when the probe supplies one for the selected id. No number, no ranking
  language - the note is whatever the probe sends, verbatim.
- **3.2** - `neuralIsCudaNative()`/`CONFLICTS` (`web/src/model/conflicts.js`) now read `NeuralCudaLevels`
  and `NeuralCudaDisables` from the probe when present, falling back to the exact literal lists
  `ef083b9` shipped (still an exact-match test, never a prefix test, per that commit's own warning
  about the `vsr` placeholder). The seven CUDA-native `CONFLICTS` entries are generated from the
  disables list rather than hand-written per axis, and their `why` text was generalised to name any
  axis the list carries (a small wording simplification from `ef083b9`'s per-axis sentences).
- **3.3** - denoise gets OPTION-level inertness rather than row-level: a new `optionInert(c, id)`
  hook (`web/src/model/conflicts.js`), consulted per chip and per `<select>` option in `controlRow()`,
  reads `CudaDenoiseLevels` (probe key, fallback `['off','optix','optix-temporal']`) and disables
  only the denoise levels not on it, leaving `optix`/`optix-temporal` live exactly as the server
  does on that branch.
- **3.4** - the consequence note: when a CUDA-native `neural` level is picked and at least one
  disabled axis is set away from its own default, one note renders directly under the `neural` row
  naming which axes will be turned off, in `CONTROLS[].label` wording (`cudaSuppressedLabels()`,
  `web/src/view/panel-dom.js`). Silent when nothing would be lost, per the design's own rule.
- **3.5** - `Pipeline` and `Denoise dropped` rows added to `LIVE_ROWS` (`web/src/controller/live-block.js`).
  Both are read straight off the session record like every other row here and print nothing until a
  server actually sends `Pipeline`/`DenoiseDroppedForPatchedBinary` - the server-side half of 3.5
  (deciding what `Pipeline` should say, confirming `DenoiseDroppedForPatchedBinary`'s shape) is a
  backend change and stayed out of scope for a client-restructuring brief.
- **4.3 ordering** - when both the section 3.4 consequence note and a section 2.2 level note fire
  on the same row, the consequence note renders first, per the design's own stated order.

Not implemented, and not silently dropped either - each is a design item this pass left alone on
purpose:
- **1.4/1.5, 2.4** - considered-and-rejected alternatives; nothing to build.
- **5.1's actual probe keys** (`NeuralFamilies`, `NeuralFamilyLabels`, `NeuralNotes`,
  `NeuralCudaLevels`, `NeuralCudaDisables`, `CudaDenoiseLevels`) - a server-side (`PatcherHost.cs`/
  `ShaderLibrary.cs`) change. The client is now written to consume every one of them the day they
  exist; none of them exist on the server yet.
- **5.2's `Pipeline` value and confirming `DenoiseDroppedForPatchedBinary`** - same reason: backend.
- **6.4** - moving `COSTS` to the probe. Noted as still open in section 8's own list; untouched.
- Section 8, item 4 (inline "(off on CUDA path)" text for TV clients without tooltips) - the design
  doc itself says "cheap to add; not in this pass unless wanted." Still not wanted this pass either.

**VERIFIED** (for this pass, against the `cat`-based build that existed at the time): `node --check`
on the built `web/gpu-upscale.js` (valid syntax); the pre-improvement build is byte-identical to the
prior single file past the added three-line generated banner (`diff` against a saved copy).
**ASSUMED, not verified**: the new rendering paths (optgroup construction, option-level inertness,
the two new notes) were reviewed by reading, not by driving a browser - this environment has no
jsdom or browser available, and the task's own hard limits keep this pass off any live server.
Whoever opens the Advanced disclosure on `dlpp-3`/`vsr-rtcuda` next, on a real server that sends the
new probe keys, is the actual test.

### 9.1 Real ES modules rebuild (2026-09-24, `.agent-briefs/real-es-modules.md`)

The `web/src/NN-name.js` / `cat`-concatenation mechanism described above is retired. See the
superseding note at the top of section 9 for what replaced it, and `context-map.md` for the full
module list. **VERIFIED**: `node --check` on the rebuilt `web/gpu-upscale.js` (valid syntax); a
Node smoke run of the bundled IIFE against stubbed `document`/`window`/`localStorage`/
`MutationObserver` completes `install()` with `state.installed === true` and both webpack chunk
globals hooked, i.e. every top-level hook (`hookWebpack`, `hookFetch`, `hookXhr`,
`watchPlaybackInfoDialog`, `probeServer`) runs to completion with no thrown error; a function-name
census of the bundle (103 `function` declarations, before and after) matches 1:1 against the
`726cbc5` build modulo comment-text false positives, esbuild's `function`-to-`let` rewrite of one
nested closure (`makeDraggable`'s `end()`), and this pass's own small, intentional additions (the
`install()` entry wrapper, a named `loadPrefs()` IIFE, one duplicated `isOff`-shaped predicate kept
local to avoid an extra import edge). **ASSUMED, not verified**: no live browser or Jellyfin server
was driven this pass either (same hard limits as 9's own pass) - the rendering paths themselves are
unchanged from what 9 already reviewed, and the new risk surface is the module boundaries and the
bundler, which the syntax check, function census and smoke run cover, not a real playback session.
