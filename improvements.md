# Improvements

Findings from the multi-agent code review. One line per finding: location, problem, fix.
Severity: 🔴 bug (broken behavior) · 🟡 risk (works but fragile) · 🔵 nit · ❓ q (question, not a suggestion).

Status: `[ ]` open · `[x]` done · `[~]` accepted as-is (decision recorded on the line).

## Plugin host (C#)

- [x] `src/UpscaleController.cs:34` 🟡 risk: `GetSession` is `[Authorize]` only, with no check that `playSessionId` belongs to the caller. Any signed-in Viewer can guess a PlaySessionId and read another Viewer's session status. Scope the lookup to the caller's own sessions, or document the leak.
- [x] `src/ShimBridge.cs:60` 🟡 risk: `/etc/jellyfin-upscale.json` is written with a plain `File.WriteAllText`. A shim invocation reading mid-write gets truncated JSON while sessions are live. Write to a temp file in the same directory, then `File.Move(..., overwrite: true)`.
- [x] `src/PatcherLoader.cs:72-83` 🟡 risk: `Configure` swallows every exception with no logging, unlike `Load`. A failed config push leaves stale settings while the dashboard reports the new ones. Log the exception.
- [x] `src/PatcherLoader.cs:59-61` 🟡 risk: static `Status`/`Active` are written without synchronization and read from a request thread. Mark `volatile` or guard with a lock.
- [x] `src/Configuration/PluginConfiguration.cs` ❓ q: no range validation on `TargetHeight`, `MaxConcurrent`, `MinScaleFactor`, `MaxSourceHeight` before they reach the ffmpeg command. Caught downstream in `Option()`, or nowhere?
- [x] `src/PatcherLoader.cs:50-51` ❓ q: `_host != null` short-circuits to `Configure`, so a second `Plugin` construction keeps the old ALC assembly even when the DLL on disk changed. Intentional?

Verified clean: `PluginConfiguration.cs` and `src/patcher/UpscaleSettings.cs` mirror each other 1:1 — no desynced or dead setting.

## Patcher engine

- [x] `src/patcher/UpscalePatches.cs:408` 🔴 bug: `explicitlyAsked = plan.ClientOptIn || plan.DeblurApplied || plan.DenoiseApplied` omits `NeuralApplied`, `GameApplied`, `RefineApplied`, `ChromaApplied`. A session asking only for `neural=`/`game=`/`refine=`/`chroma=` (no upscale/deblur/denoise, `ForceTranscode` off) keeps the `copy` encoder, so `-vf` never applies and the filter is silently dropped. Add the four flags to `explicitlyAsked`.
- [x] `src/patcher/UpscaleEngine.cs:706` 🟡 risk: `refine` and `chroma` have no master-enable gate, unlike `DeblurAllowed`/`DenoiseAllowed`/`NeuralAllowed`/`GameAllowed`, and `UpscaleSettings.cs` has no matching property. Any session overrides dashboard policy. Add `RefineAllowed`/`ChromaAllowed`, or document them as intentionally ungated.
- [ ] (open: test on the server) `src/patcher/UpscaleEngine.cs:825` 🟡 risk: `plan.GameApplied && GameScalesOutput(...)` forces `srLevel`/`refineLevel` off to avoid double-upscaling but leaves `chromaLevel` on, though KrigBilateral runs in the same libplacebo `custom_shader_path` and composes against whatever luma pass ran. Confirm intent or exempt chroma explicitly like sr/refine.
- [x] `src/patcher/UpscaleEngine.cs:848` 🔵 nit: `deband` treats only `"off"/"0"/"false"` as disabling, so any other string (`"no"`) reads as deband-on instead of falling back to the dashboard default. Other axes (kernel, jitter, depth, reactive) reject unknown values via whitelist; match that.

Verified clean: all 13 axes are read via `Option(state, ...)` in `Decide`/`GameFilter` — nothing dropped at the read stage. No shell or arg injection: `kernel` goes through `ShaderLibrary.CanonicalUpscaler`; `jitter`/`depth`/`reactive` through `GameOption()` whitelists; `sr`/`deblur`/`refine`/`chroma`/`denoise`/`neural`/`game` level names validate against fixed dictionaries before any path lookup or string concat, and `ShaderLibrary.Compose` builds cache filenames from those validated names, so no path traversal.

## Client (`web/gpu-upscale.js`, `configPage.html`)

- [x] `src/Configuration/configPage.html:507-513` 🔴 bug: `loadStatus` string-concatenates `a.Timestamp`, `a.Source`, `a.Summary`, `a.EncoderReason`, `a.Encoder`, `a.Status` into HTML and assigns via `innerHTML`, unescaped. `a.Source` is a media filename; a file named with `<script>` or an `onerror` attribute executes in the admin dashboard. Build rows as DOM nodes with `textContent`, or run every field through an HTML-escape helper.
- [x] `web/gpu-upscale.js:1148-1164` 🔴 bug: the `kernel` axis (probeKey `Upscalers`, sent at L2251) has no `LIVE_ROWS` entry, unlike every other axis. The scaling-kernel pick is rendered, stored and sent but never confirmed against what the server ran. Add a row.
- [x] `web/gpu-upscale.js:1822` 🟡 risk: `axisControls(caps)` computes `showWhen` visibility for `jitter`/`depth`/`reactive` from `state.prefs.game` before the L1826-1832 block that can overwrite `state.prefs.game` (e.g. to `off` when `state.stage === 'off'`). First render shows those rows against a stale value until the 3s live-poll repaint corrects it. Sync `effective()` into `state.prefs` before calling `axisControls`.
- [x] `web/gpu-upscale.js:2144-2158` ❓ q: `wrapChunkModules` only inspects the `exports` param (`exports.Ay`, `exports.default`, `exports`). A module doing `module.exports = {...}` after entry replaces that object and would be missed. Can that happen in the targeted build?

Verified clean: all 13 axes in `CONTROLS` are written by `addParams`/`wireParams`; `webpackChunk` bare global is the primary lookup with a source-name fallback; probe display strings all go through `el()`/`textContent`, so no XSS in the panel itself; localStorage parse at L392-425 is already try/catched; every `configPage.html` control has its load/save pair against `PluginConfiguration.cs` (no `RefineAllowed`/`ChromaAllowed` pair because no such server property exists — see the patcher finding above).

## Shim and scripts

- [x] `shim/jellyfin-ffmpeg-upscale:46-48,119` 🔴 bug: `PATCHED_NODE_RE` has no word boundary, unlike the regex in `wants_patched`, so `strip_patched`'s `re.sub` matches `ort`/`oidn`/`optix`/`fsr2`/`dlss` as bare substrings anywhere in an arg. A `drawtext` overlay containing "sort"/"transport"/"distort" gets chewed out, corrupting the chain for a session that never asked for a patched filter. Anchor with the same `(^|,|\[)...(=|,|\]|$)` boundaries, or strip node-by-node off `split_filters()` with exact name match.
- [ ] `scripts/99-jellyfin-gpuupscale:3` 🟡 risk: the apt `Post-Invoke` hook fires on every dpkg operation, not just jellyfin-web changes, running `jellyfin-gpuupscale-webinject` as root each time with errors swallowed by `|| true`. If that script or its source `/usr/lib/jellyfin-gpuupscale/gpu-upscale.js` is ever group- or other-writable, every apt run on the box becomes a root code-exec path — far broader than "reapply after a jellyfin-web upgrade". Scope the hook to jellyfin-web, and pin ownership/perms to root:root 0755 with no group/other write on both the script and its source.
- [x] `shim/jellyfin-ffmpeg-upscale:330-343` 🟡 risk: `take_slot` is check-then-act — two shims started close together both read `live < max_concurrent` before either creates a slot file, so the concurrency cap is exceeded. Create the slot first with `os.open(slot, O_CREAT|O_EXCL)`, count after, unlink on overflow.
- [x] `shim/jellyfin-ffmpeg-upscale:421` 🟡 risk: `/tmp/upscale-last.err` is a fixed path in world-writable `/tmp` opened without `O_EXCL`/`O_NOFOLLOW`. Concurrent transcodes stomp each other's diagnostics, and a pre-planted symlink lets a local user make the jellyfin process truncate any file it can write. Name it per-slot (SLOT_DIR already does) or use `tempfile`.
- [x] `shim/jellyfin-ffmpeg-upscale:247-250` 🟡 risk: `target_from_filter` takes `MIN_CONST.findall(...)[0]`/`[1]` as width/height while scanning the whole filter string. Any other `min(...)` in the chain shifts the indices and silently targets the wrong resolution. Anchor to the scale node.
- [x] `scripts/jellyfin-gpuupscale-webinject:24` 🟡 risk: `install -m 0644` overwrites the live `gpu-upscale.js` in place, so a request mid-write gets a truncated script. Install to a temp name in the same directory, then `mv`.
- [x] `scripts/jellyfin-gpuupscale-webinject:46` 🟡 risk: the python heredoc does `open(path,'w').write(html)` on the live `index.html`, truncating before rewriting. Write a temp file in the same directory and `os.replace()`.
- [x] `scripts/jellyfin-gpuupscale-activate:17-19,28-33` 🟡 risk: activation, backup and rollback copy four assemblies via four separate `cp -a` calls. A crash between them leaves a mismatched plugin/patcher pair that the next restart loads — the half-applied state AGENTS.md warns about. Stage to temp names in the destination dirs and `mv` each into place, or stop jellyfin first.
- [x] `scripts/build-ffmpeg.sh:33,71,75` 🟡 risk: `BUILD="/tmp/ffbuild.$$"` + `mkdir -p` is a predictable path in `/tmp` that silently reuses a pre-existing directory or symlink, letting a local user steer where this root-run build tree lands. Use `BUILD=$(mktemp -d)`.
- [x] `scripts/install-shaders.sh:13`, `scripts/jellyfin-gpuupscale-activate:8`, `scripts/jellyfin-gpuupscale-webinject:9` 🔵 nit: `set -eu` without `pipefail`, inconsistent with `build-ffmpeg.sh`. Add `-o pipefail`.
- [x] `scripts/jellyfin-gpuupscale-activate:17-19,28-33` 🔵 nit: `$PLUGIN_DIR`/`$PATCH_DIR`/`$BACKUP`/`$STAGE` unquoted in every `cp -a`/`chown`. Harmless while they are fixed constants; quote them.
- [x] `shim/jellyfin-ffmpeg-upscale:139-160` ❓ q: `patched_has` falls back to "assume it has everything" in a try/except, but `pick_binary` already gated on `os.access(..., X_OK)`. Which race is the inner except for — binary deleted between the access check and the subprocess call? If so, say so in a comment.

Note: the repo ships no sudoers file; `scripts/99-jellyfin-gpuupscale` is the apt hook and is the actual privilege-broadening surface.

## ffmpeg filters (C)

- [x] `ffmpeg/vf_dlss.c:665` 🔴 bug: `NVSDK_NGX_VULKAN_Shutdown1` in `uninit()` is gated on `s->ngx_ready`, set only after the whole pipeline succeeds. `Init_with_ProjectID` (L428) can succeed while a later step fails and returns early (L441, 446, 451-455, 480, 486) — Shutdown1 then never runs, leaking NGX per-process state including its file lock under `XDG_RUNTIME_DIR`. Track init separately (`ngx_inited`) and shut down whenever Init succeeded.
- [x] `ffmpeg/vf_optix.c:407` 🔴 bug: after `cuCtxPushCurrent(s->cu_ctx)`, every `CHECK_CU`/`CHECK_OPTIX` up to L458 returns without popping. Any `config_input` failure leaves the CUDA context stack unbalanced for the thread, corrupting `uninit()`'s own push/pop (L674-702) and any other CUDA use on it. Use a single `fail:` label that pops, or push/pop only the minimal region.
- [x] `ffmpeg/vf_ort.c:273` 🟡 risk: `run_session(...)` can populate `ov` from a successful `Run()` and then fail in the shape checks; the caller does `if (ret < 0) return ret;` without releasing `ov`, leaking the output tensor. Release it before returning, like the `fail:` path in `filter_frame` already does.
- [x] `ffmpeg/gu_inputs.h:597-598` 🟡 risk: `SetIntraOpNumThreads` and `SetSessionGraphOptimizationLevel` discard the returned `OrtStatus*` unchecked and unfreed. Wrap both in `GU_ORT_CHECK` like the surrounding calls.
- [x] `ffmpeg/gu_inputs.h:427` 🔵 nit: `op.outputBuffer = dst == g->grid_bwd ? g->nvof_out : g->nvof_out;` — both branches identical, condition is dead. Safe only because forward/backward NVOF runs are sequential. Reduce to `g->nvof_out`.

Verified clean: NULL checks after `av_malloc`/`av_frame_alloc` are paired with their frees in all five filters; `uninit()` null-checks every resource including on partial-init paths (Vulkan `image_create` in vf_fsr2.c/vf_dlss.c stores handles incrementally, so a mid-function `VK_CHECK` failure still gets cleaned up); fixed-size buffers (`fsr2_msg`'s `buf[512]`, dlss's `wpath[512]`, `devs[16]`, `qprops[16]`) are bounds-checked; AVOption ranges match their domains apart from a cosmetic `device_type` "metal" log mislabel in vf_oidn.c. No overflow or off-by-one in the size math.

All five fixed together in one change set — they share a single ffmpeg rebuild on the Proxmox host. Compiles unverified locally (no ffmpeg tree here); build on the host and confirm all five `vf_*` filters survive in `-filters`.

## Still open

- `scripts/99-jellyfin-gpuupscale` — scoping the apt hook to jellyfin-web is not a one-line edit, and the other half of the fix (root:root 0755, no group/other write on the injector and on `/usr/lib/jellyfin-gpuupscale/gpu-upscale.js`) is host-side.
- `src/patcher/UpscaleEngine.cs:825` — chroma with a game upscaler: run a session with chroma on and off against the same source and compare the served segment before changing anything.

## Verification state

Syntax-checked here: `bash -n` on all four shell scripts, `python3 -m py_compile` on the shim. Nothing else is proven.

The local `dotnet build` fails with 25 x CS0246 on `EncodingJobInfo` / `EncodingOptions`: the Jellyfin reference assemblies exist only on the server. That is pre-existing and unrelated to these changes, so no C# change here has been compiled.

The ffmpeg filters have not been compiled at all. Build them on the host and confirm `-filters` still lists all five (`vf_oidn`, `vf_optix`, `vf_ort`, `vf_fsr2`, `vf_dlss`).

Session ownership is fail-open: an empty id on either side answers as before. Both ids come from unverified sources (reflection for the record's user, the `Jellyfin-UserId` claim for the caller). Check it by playing as one viewer, then requesting `/GpuUpscale/Session/<id>` with a second viewer's token: expected `Known: false`, and the real record with the first viewer's own token.

---

# Round two: whole-codebase review (Opus)

Eight agents, whole files rather than diffs. 21 red, 79 amber. Nothing below is applied unless
marked, and nothing below has been run against a server.

Fixed immediately, because it was a regression introduced by round one:

- [x] `src/patcher/UpscalePatches.cs` 🔴 `explicitlyAsked` read `plan.*Applied`, which are true for a
  dashboard default as well as a session request. A default of `chroma=krigbilateral` would have
  turned every stream-copy-eligible playback into a full GPU transcode. Now gated on
  `UpscaleEngine.SessionNamedEnhancement(state)`, which asks whether the session named an axis.
- [x] `ffmpeg/vf_optix.c` 🟡 `uninit()` pushed the CUDA context unchecked and popped unconditionally,
  the same defect round one fixed one function up. Pop is now gated on the push having succeeded.

## Red, unfixed

### Client sends nothing (`web/gpu-upscale.js`)
- [x] L650 `anyEnhancement()` tests only upscale/deblur/denoise, so a Custom pick of sr, neural, game,
  refine, chroma, kernel or deband never forces a transcode: direct play, nothing applied.
- [x] L1829 the seeding loop writes `effective()` over `state.prefs` and the next save persists it, so
  `stage: off` permanently wipes the viewer's stored sr/neural/game choices.
- [x] L2248 every axis but upscale is gated on `serverCaps.full`; a failed boot probe is never cached,
  so all axes are silently dropped for the life of the page.
- [x] L1842 a partial probe answer rewrites stored preferences to `off` on disk.

### Shim (`shim/jellyfin-ffmpeg-upscale`)
- [x] L435 the upscale path runs ffmpeg via `Popen` with no signal handling. Jellyfin killing the shim
  orphans the child, still writing segments and holding the GPU.
- [x] L445 the per-pid error file is opened after `Popen`, and a failure there falls through to
  `passthrough()` → `execv`, leaving two ffmpegs writing the same output.
- [x] L461 `rc != 0` retries the whole transcode even when the child was killed on purpose.
- [x] L464 `sys.exit(rc)` turns a signal death into exit status 241.
- [x] L77 a malformed config falls back to defaults that lack `plugin_patch_active`, so the shim
  rewrites a command the plugin is also rewriting. Should fail closed.
- [x] L101 `wants_patched` rejects `]` as a leading boundary, so a labelled filter_complex node routes
  to the stock binary and fails outright instead of degrading.

### Patcher (`src/patcher/`)
- [x] `UpscalePatches.cs:83` `_harmony` is assigned after the core patch loop, so a throw mid-loop
  leaves earlier patches installed and unpatchable: the partial core install the file forbids.
- [x] `UpscalePatches.cs:287` the four postfixes disagree on one session; a burn-in session gets Vulkan
  device args with the stock filter graph.
- [x] `UpscaleEngine.cs:291` history eviction deletes the live `_bySession` entry for a session that
  was recorded more than once, so the endpoint answers null for a playing session.
- [x] `UpscaleEngine.cs:750` an unrecognised session value falls back to the dashboard default rather
  than to off, so a typo defeats an explicit Off and forces a transcode. Same at 775, 782, 827, 844, 858.

### ffmpeg filters
- [x] `gu_inputs.h:548` `dlclose` on ONNX Runtime crashes the process at teardown.
- [x] `gu_inputs.h:684` the depth output is read as 518x518 with no shape check; `dmodel=` is user-set,
  so a different model is an out-of-bounds read.
- [x] `vf_dlss.c:361` and `vf_fsr2.c:376` `config_output` is not idempotent: a reconfigure leaks the
  instance, device, pool, fence, every image and the FSR2/NGX context.
- [x] `vf_dlss.c:672` NGX shutdown is process-wide but called per instance, so two dlss filters in one
  process kill each other.
- [x] `vf_ort.c:348` a non-float32 model output is read as float32: an out-of-bounds read of megabytes.

## Amber
Seventy-nine, recorded in the agent reports. The themes worth naming: no axis reserves its
concurrency slot at decision time, so the cap is advisory under parallel starts; the shader cache is
keyed on level names and compares mtime ordering, so a rollback that preserves timestamps serves a
stale composition forever; shader downloads are unpinned and verified only by a header grep, so a
truncated or substituted shader installs; several `config_input` paths are not re-entrant; and the
session ownership check added in round one is unverified against a live Jellyfin and fails open on
both sides at once.

---

# Round three: improvements (Opus, four agents)

Not defects. What would make the pipeline better on one RTX 3090 shared with its encoder.
`[M]` means settle it with a measurement, not an argument. Nothing here is applied.

Two agents arrived independently at the same first item, from opposite ends of the chain.

## The one to do first

- [ ] `src/patcher/UpscalePatches.cs:387` **The encoder undoes the work.** The plugin sets the
  encoder name and nothing else, so Jellyfin computes `-b:v`/`-maxrate` from the SOURCE resolution
  and clamps to the source bitrate. The chain then ships four times the pixels at 540p bitrate and
  the quantiser removes exactly the detail the shaders added. Nothing in the repo touches `cq`,
  `preset` or `aq`. Every measured shader gain in README.md may be dying here, unmeasured. `[M]`
  same clip 540p to 1080p, stock rate control against `-rc vbr -cq N` with a pixel-scaled floor,
  served segment scored against ground truth.

## Throughput

- [ ] `src/patcher/UpscaleEngine.cs:1468` `hwdownload,format=yuv420p` sends every output frame
  Vulkan to system memory and back into NVENC: about 12 MB per frame at 2160p, paid at output size.
  `hwmap=derive_device=cuda` hands NVENC device frames. Touches the encoder args too. `[M]`
- [x] `src/patcher/UpscaleEngine.cs:1408-1441` each CPU-side filter carries its own
  `format=gbrpf32le,X,format=yuv420p`, so denoise plus neural round-trips through 4:2:0 8-bit
  BETWEEN two neural passes. One convert before the group, one after. No measurement needed.
- [x] `ffmpeg/gu_inputs.h:874` `gu_inputs_frame` is entirely single-threaded, and neither
  `vf_fsr2` nor `vf_dlss` sets `AVFILTER_FLAG_SLICE_THREADS`, while `vf_optix.c` already
  slice-threads the identical passes. Biggest item on the game path.
- [~] `ffmpeg/gu_inputs.h:243` phase correlation re-FFTs the previous frame every frame. REFUSED as
  specified: the cached spectrum and the recomputed one are not bit-identical, because the
  windowing multiplies in a different order (`cur*wgt` against `(cur*win_y)*win_x`), and `A` is
  overwritten in place by the cross-power spectrum before the inverse transform. Still worth doing,
  but it changes output, so it needs the cross spectrum written elsewhere plus an A/B swap and a
  measurement.
- [ ] `src/patcher/UpscalePatches.cs:344,360` hwaccel and the hw decoder are suppressed for every
  acted-on session, but system-memory frames are only needed when a CPU-side node exists. The
  common case (sr plus deblur) could keep NVDEC. `[M]`
- [ ] `ffmpeg/vf_optix.c:432` pageable host memory with blocking copies; `cuMemAllocHost` plus
  async copies on the existing stream roughly doubles PCIe rate. `[M]`
- [ ] `ffmpeg/gu_inputs.h:948` run the depth model every Nth frame and warp between, reusing the
  flow-warp EMA that already exists. The ViT at 518x518 is probably the dominant cost of the whole
  game path. `[M]` cost split first, then ghosting at N=2,3,4.

## Quality

- [ ] 10-bit output (`p010le` plus `hevc_nvenc main10`). The pipeline is 8-bit in and out, so the
  deband pass is requantised to 8 bit on exit and most of its gain is thrown away. Effectively free
  on Ampere. Gate on what `SupportedCodecs` already knows. `[M]`
- [x] `ffmpeg/vf_fsr2.c:624` `frameTimeDelta` is hard-coded to 1000/24, so 60 fps material is told
  it is 24 fps and FSR2 scales lock lifetime and accumulation from that. Three lines.
- [ ] `ffmpeg/vf_oidn.c:280` default quality is BALANCED though OIDN.md measured balanced as
  indistinguishable from high; high is the only cost ever measured. `[M]` balanced fps was never
  taken.
- [ ] `ffmpeg/gu_inputs.h:458` `gu_grid_sample` is nearest, so one 4x4 NVOFA cell is replicated to
  16 pixels and the motion field is blocky at every motion edge. Bilinear is a few lines, no new
  data. `[M]`
- [x] `ffmpeg/vf_optix.c:410` `mode=hdr` never sets `params.hdrIntensity`, which the OptiX HDR
  model expects from `optixDenoiserComputeIntensity`. HDR output is off-scale without it.
- [x] `src/patcher/ShaderLibrary.cs:967` the `ort` level is not matched to the session ratio:
  `realesr-anime-x4` at a 2x target makes 4x pixels that libplacebo then halves. These levels are
  sub-realtime, so the wasted work is the entire cost.
- [x] `shim/jellyfin-ffmpeg-upscale:59,323,441` the fallback path contradicts the measurements:
  the 16-weight FSRCNNX (measured no better at double cost), no RCAS, no deband, and it runs the
  fixed-2x network down to 1.15x, the band the plugin bypasses as worthless.

## Honesty, and being able to judge a change later

- [ ] **The record describes intent, and the shim then changes what ran.** `Describe` writes the
  record at command-build time; the shim afterwards picks the binary and strips nodes the patched
  build lacks. So `denoise=oidn` reports oidn when oidn never ran. Fix: shim writes a per-session
  JSON (binary chosen, nodes stripped, exit status) that the plugin folds in before the panel reads
  it. This also covers a session whose ffmpeg failed and was retried unenhanced but still reports
  applied.
- [ ] `NeuralApplied` exists on both `SessionRecord` and `Plan` and is never serialised, and the
  neural row carries no `applied` key, so a neural level that did not run reads as on. One key.
- [ ] `OutputWidth`/`OutputHeight` exist but only nested inside `Record`, and the "Upscaled" row
  prints `Upscaler`, a kernel name that reads as a size claim. Emit them flat and print
  "1920x1080 from 960x540": the only end-to-end proof of the size axis.
- [ ] Nothing records throughput. Append one JSONL line per session at transcode end: source and
  output size, the built chain verbatim, encoder and rate-control args, encode fps from ffmpeg
  progress, exit status, live-slot count at admission. Today `_history` is 50 in-memory records of
  intent, lost on restart, which is why every performance claim here gets re-argued instead of
  looked up. This is what makes the items above settleable.

## Shape of the thing

- [ ] **The ladder wart, properly.** `effective()` returns a constant `sr: LADDER_SR` and the panel
  writes it over `state.prefs`. Fix: the stage carries `sr: 'ladder'`, the server resolves the
  family per ratio (ratio-agnostic below `SrMinScaleFactor`, fsrcnnx above), and `state.prefs`
  holds viewer overrides only, never written from `effective()`. That also fills the 1.15 to 1.60
  band the ladder has no rung for. `[M]` whether ravu-zoom beats plain plus RCAS at 1.5x.
- [ ] **Threshold arithmetic lives in three places** (`Decide`, `WouldEnhanceSource`, and the
  client's `eligibleTargets`/`srWouldRun`), so the probe ships raw numbers and the client re-derives
  the rules. A `GET /GpuUpscale/Plan?w=&h=` answering from the same `Decide` code would leave the
  client deciding nothing.
- [ ] **13 axes is not quite the problem: 12 of them are cost knobs and none is a statement about
  the content.** Add one viewer-facing axis (photographic / animation / grainy) that the server maps
  to a recipe, seeded from the library or genre the server already knows. Everything existing stays
  under Advanced. Panel then describes in one sentence: say how much GPU to spend and what the
  source looks like, the server picks the filters. `[M]`
- [ ] Collapse the panel to the Quality slider plus four rows, everything else behind one closed
  disclosure; the game group's four rows become one that opens its three inputs.
- [ ] Replace the `MaxConcurrent` headcount with a cost budget. `HasCapacity()` counts processes
  carrying libplacebo, so a dlss session and a sharpen-only session each consume one of two, and
  foreign libplacebo transcodes count too. The plan knows its own cost once the cost table moves
  server-side; refuse or DOWNGRADE rather than dropping to a stock transcode. `[M]`
- [ ] The client hard-codes `FPS`, `DENOISE_COST`, `NEURAL_COST`, `GAME_COST` and the ladder recipe:
  measurements of the server living in the browser, stale on any GPU change and uncorrectable
  without republishing the script. Serve them in the probe, as the display names already are.
- [ ] `stageCost` costs filters only, though NVENC shares the same GPU, so the ladder under-costs
  high targets exactly where the cap bites. `[M]`
- [ ] Accessibility: chips are bare buttons with no `role="radiogroup"` and no `aria-checked`, the
  live block has no `aria-live`, and the `role="dialog"` panel has no focus trap. A screen reader
  hears eleven unlabelled buttons per row.
- [ ] The admin page: the Upscaler kernel is free text and a typo fails the whole job while the
  probe already serves the valid list; the five interacting thresholds need a worked line; the
  activity table should show sizes, ratio, user and `SrBypassed`, and `EncoderReason` should be text
  rather than a `title` attribute invisible to touch and keyboard.
- [ ] `Levels()` is re-serialised into every 3s session poll. Split it into a capabilities endpoint.

## Measure first

1. Encoder rate control against ground truth. If the shader gain does not survive the encoder,
   everything else is second order.
2. Per-stage wall clock inside `gu_inputs_frame` at 720p: depth model against phase correlation
   against the serial CPU loops. The ranking of the whole game path turns on that split and nobody
   has taken it.
3. Concurrency curve: fps per session at 1, 2, 3, 4 concurrent, sharpen-only against oidn. Turns
   `MaxConcurrent` from a guess into a budget.

Already tested and deliberately not re-proposed: OIDN on the GPU side of hwupload, NVOFA
`PERF_LEVEL_SLOW`, dropping the NVOFA luma prefilter, fp32 ORT models, the TensorRT EP, EASU,
NVScaler as default, Anime4K below 2.0x, tmix, hqdn3d, FSR3/FSR4, and the Anime4K, FSRCNNX weight
and CAS/RCAS questions.

---

# Applied so far, and what is still open

## Applied (commit df8b745), none of it compiled

Filter chain: one float conversion around the whole CPU-side group instead of one per node (the
single-node string is byte-identical); libplacebo `shader_cache` wired to a per-combination prefix,
after confirming the option exists on the server's own binary; output width aligned to 8.

Filters: `AVFILTER_FLAG_SLICE_THREADS` plus threaded pack and unpack passes in `vf_fsr2` and
`vf_dlss`; FSR2's frame time from the link rate or the PTS delta rather than a hard-coded 24 fps;
ONNX input and output names hoisted out of the per-frame path; a dead per-frame memcpy and an
unused buffer removed; OptiX HDR intensity computed and passed, matching the SDK header read on the
build server; OIDN's CPU fallback no longer pins a thread per core.

Reporting: `NeuralApplied` and a new `NeuralRequested` serialised, so a network that was asked for
and did not run no longer reads like one nobody chose; source and output sizes sent flat, with the
Upscaled row printing them instead of a kernel name that read as a size claim.

## Refused rather than guessed

- the phase-correlation FFT cache, for the reason recorded above
- `libavutil/float2half.h`: no ffmpeg tree here to confirm the API, and the names have moved between
  versions, so a guess costs a build round trip on the server
- the OptiX work was refused once for the same reason and only landed after the header was read on
  the container

## Still open, needing a measurement or a decision

The encoder rate control (the item two reviewers independently ranked first), the GPU-resident
NVENC handoff, 10-bit output, the cost-budget admission, depth every Nth frame, bilinear flow
sampling, the panel restructure, the ladder rework, and the apt hook.

## Verification state

`bash -n` on the shell scripts and `py_compile` on the shim are the only checks that have run. No
C# and no C in this repository has been compiled: the Jellyfin reference assemblies and the ffmpeg
tree both live on the server. The next ffmpeg build is the first compile of every C change here,
and a build failure on the first attempt is the expected outcome rather than a surprise.

---

# Round four: theory review (Opus, no measurements)

Judged against signal-processing and imaging first principles rather than a benchmark.
Sequencing came back sound: denoise strictly before SR, deband before the LUMA hooks. The errors
are in colour spaces, scale ratios and a missing artefact model.

- [x] **No colour range was ever declared.** libplacebo guessed on untagged sources and lifted black
  by about 9/255, larger than every shader delta in README.md's own table. README recorded it as a
  measurement trap and corrected it only in the benchmark harness, so the served segment carried a
  shift the measurements did not. Sampled this server: 3 of 25 files untagged. Fixed: an untagged
  source is told it is limited range, a file declaring full range is left alone.
- Settled and closed, no action: chroma siting. Every sampled file reports `chroma_location=left`,
  so libplacebo has the right siting and KrigBilateral's luma guide is aligned.

## Pending

Rewritten after the defect and settings rounds shipped. Everything below is genuinely open today.
Ordered by what is at stake.

### Blocked on a measurement

1. **Encoder rate control.** The plugin sets the encoder name and never the bitrate, so Jellyfin
   sizes `-b:v`/`-maxrate` from the SOURCE resolution and clamps to source bitrate: four times the
   pixels at 540p bitrate, and the quantiser removes what the shaders added. Two review agents and
   the theory pass all put this first. Measure the served segment against ground truth at Jellyfin's
   bitrate, at a pixel-scaled bitrate, and at `-cq`.
2. **Source degradation is modelled nowhere.** Every network here was trained on bicubic
   downsampling of clean images and is fed DCT blocking and ringing. No deblock or dering pass
   exists, and no decision reads `state.VideoStream.BitRate` though it is in scope. The evidence is
   already in the repo, read as something else: Anime4K below plain lanczos at 1.5x, EASU losing
   outright because it locks onto compression-noise gradients. Measure one source at two CRFs.
3. **GPU-resident NVENC handoff.** `hwdownload,format=yuv420p` sends every output frame through
   system memory, about 12 MB per frame at 2160p, paid at output size.
4. **10-bit output.** Deband is requantised to 8 bit on exit, throwing away most of what it did.
5. **Cost-budget admission.** `HasCapacity()` counts processes, so a dlss session and a sharpen-only
   session each consume one of two, and foreign libplacebo transcodes count too. The `/proc` walk is
   now memoised, but the model is still a headcount.
6. **Depth every Nth frame**, warping between with the flow-warp EMA that exists. Take the per-stage
   split inside `gu_inputs_frame` first: that one number reorders this whole list.
7. **Above 2x the top octave gets no network**: a 2x network, then `ewa_lanczos` across the second
   octave. 540p to 2160p is reachable and offered.
8. **RCAS runs at 2x-source, not at output size**, which is what it was designed for, then is
   resampled.
9. **Sharpen-before-enlarge for the MAIN-hook families was never tested.** The comparison defending
   it changed the sharpener and its position at once.
10. **The float group exits to 8-bit 4:2:0 before libplacebo**, so a 4x network's output is decimated
    before the scaler sees it.
11. **OIDN is told `srgb=0`** while being handed gamma-encoded float.
12. **Anti-ringing is never set**, and the kernel whitelist has no low-ringing default for degraded
    material.
13. **Phase-correlation FFT cache**: real, but not bit-exact, for the reason recorded above.
14. **Bilinear flow sampling** instead of nearest; Rec.709 luma weights instead of 601 for the NVOFA
    input, plus a clamp on the cast.
15. **OIDN quality default**: OIDN.md never measured `balanced`, only `high` and `fast`.

### Blocked on a decision

- One content axis (photographic / animation / grainy) the server maps to a recipe, seeded from the
  library the server already knows.
- The server half of the ladder: the stage carrying `sr: 'ladder'` and the server resolving the
  family per ratio. The client half shipped, so this is now a question about what the ladder is.
- A plan-preview endpoint, so threshold arithmetic stops living in three places.
- The cost tables moving server-side: they are measurements of the server living in the browser.
- `scripts/99-jellyfin-gpuupscale`: the apt hook fires on every dpkg operation, and the other half of
  the fix is host-side file ownership.

### Worth doing as one piece, and bigger than it looks

- **The session record carries no throughput, and the shim never says what it stripped.** The record
  is written at command-build time; the shim afterwards picks the binary and drops nodes the patched
  build lacks, so `denoise=oidn` can be reported for a session where oidn never ran. Both need the
  same plumbing from the shim back into the plugin. That plumbing is also what would let every
  measurement above be settled by looking rather than by hand-running a bench, which is why it is
  worth doing deliberately rather than bundling into a cleanup.

### Small and genuinely not done

- `Levels()` is still re-serialised into the probe response on every panel open, which is fine, but
  the per-session poll no longer carries it. Nothing further owed here unless the probe itself gets
  chatty.
- The `Deband` help text was corrected, but several other help texts still quote numbers that are now
  editable settings. Worth one pass over the page's copy.
- `Ready.Or.Not.2.Here.I.Come.2026...mkv` in the library fails `ffprobe` with an EBML parse error.
  Unrelated to this plugin, found while sampling colour tags, but somebody should know.

# Shipped since the pending list was written

Commits a185003 (defects), 11378c4 (settings, panel, playback info).

## Defects, all applied

Client, four of one family: `anyEnhancement` tested three axes of thirteen so most Custom picks
never forced a transcode; the render loop persisted `effective()` over stored prefs; a failed probe
dropped every axis for the page's life; a partial probe rewrote prefs to off on disk. `state.prefs`
is viewer overrides only now, `state.shown` is render-only.

Patch layer: `_harmony` published before the loop so a mid-loop throw can roll back; one memoised
verdict per session, so a burn-in session no longer gets Vulkan device args with Jellyfin's own
filter graph; `"copy"` compared exactly rather than by substring.

Engine: eviction no longer deletes the live record for a session recorded twice; an unrecognised
value falls back to the computed default, so a typo cannot defeat an explicit Off; the encoder probe
drains both pipes, kills on timeout and caches failure.

Shim: `flock` slot liveness replacing the /proc-plus-24h guess; no more slot or `.err` leaks; target
scan reads every scale node; the fallback chain now matches the measurements (8-weight FSRCNNX, RCAS
composed in, and it stops firing the fixed-2x network across the 1.15 to 1.60 band).

Neural: a level is matched to the ratio, so `realesr-anime-x4` at a 2x target no longer makes four
times the pixels for libplacebo to halve. The substitution is reported, not silent.

## Everything is controllable

All 36 configuration properties have a control, a load line and a save line, verified id by id.
Five values that lived only in code became settings: the deband threshold and grain, and the three
directories for the neural weights, the DLSS runtime and the depth model. `ShaderDirectory` and
`ShaderCacheDirectory` had existed on both mirrors with no control at all. The probe reads the
configured paths too, so the panel cannot offer levels whose weights are not where the filter looks.

## The panel, and saying what ran

Slider plus three rows, everything else behind one disclosure that counts what is changed inside it,
the game cluster collapsed to one row that opens its own three inputs. Driven by a tier on each
CONTROLS entry, so a new axis is still one entry plus one line.

Jellyfin's own Playback Info dialog now reports the enhancement: source and output size, each axis as
requested against ran, the SR bypass reason, the kernel, the encoder and why. It reads the same
`liveLines()` the panel does, so the two cannot drift, and it finds the dialog structurally, so it
annotates nothing rather than the wrong dialog.

Accessibility: chips are a radiogroup with `aria-checked`, the live block is `aria-live="polite"`,
the panel traps Tab and restores focus on close.

Honesty: an apply that does not land says so instead of looking like one that did, and a failed probe
is worded as a failed probe rather than as "this server only understands the target axis".

`ShimSync` reaches the dashboard, which had been printing `undefined` since it was written.

## What is still pending

See the Pending section above, which was rewritten after this work landed rather than left to
describe a state that no longer exists.

## Verification state

`node --check` on the client, `py_compile` on the shim, `bash -n` on the shell scripts. That is all.
No C and no C# in this repository has ever been compiled: the Jellyfin reference assemblies and the
ffmpeg tree both live on the server. The next deployment is the first compile of everything written
today, and a first-attempt build failure is the expected outcome rather than a surprise.

---

# What another project does: Kuschel-code/JellyfinUpscalerPlugin

Read read-only from source, not from its README. MIT, actively maintained, ~30 releases in 2026,
built for Jellyfin 10.11.8. Its own docs say 12.0 was checked by static analysis only, so against
12.1 it is unverified by its author.

Architecturally the opposite of this project. No Harmony, no `EncodingHelper` patch, nothing in the
live transcode. A thin plugin DLL talks to a FastAPI Docker service; the realtime path is browser
scripts, or JPEG frames posted over HTTP and painted over the video element.

What that costs it: the browser paths reach web clients only, and the server path captures at
`RealtimeCaptureWidth`, default 480 px, JPEG q85 in and out, then draws the result over a native
1920 frame. Above roughly 480 times the scale factor that is a downgrade. Its README calls that path
"highest live quality" and never states the capture width. Worth knowing as a warning, not as a
criticism to repeat: much of that README is unusually honest, including calling its WebGL tier "not
AI" and its Anime4K tier a shader.

## Worth taking, ranked for this server

1. **Client-side tiers.** WebGL Lanczos2 plus CAS, and Anime4K in the browser. Every time this
   plugin honestly says no - the concurrency cap, a direct-play session, a ratio below the threshold
   - the viewer gets nothing. A browser-GPU tier costs the 3090 zero and turns each honest negative
   into a fallback. Highest payoff per watt here.
2. **Batch pre-upscale as a scheduled task.** Recorded video is static: upscale once overnight with
   models far too slow for realtime, then direct-play forever. It is also what would make `vf_ort`
   and `vf_optix` affordable, because the frame budget stops mattering. Their frame coordinator's
   COMPLETE-versus-FAILED asymmetry, so a half-written last frame is never consumed, is correct and
   worth copying exactly.
3. **Serve the client script as a plugin page rather than copying it into the web root.** An
   embedded resource served at a versioned URL deletes this project's whole cache-buster failure
   class, the one CLAUDE.md warns about twice and AGENTS.md carries an invariant for.
4. **A deblock or dejpg pass at 1x before super-resolution.** The same gap the theory review ranked
   second: nothing here models the source's own compression, and the networks amplify exactly what
   nothing removes.
5. **Model catalogue discipline for the neural axis**: sha256 pins, licence and attribution per
   entry, hash verified before a model is activated, and rejected candidates recorded so nobody
   re-evaluates them. Today `neural=` effectively means "export the weights yourself", which nobody
   will.
6. **Hardware budget bands with substitution-and-reason**, which fits the honest-reporting contract
   already in place.
7. **Drift-lock tests** asserting that the server-side registry equals the page's own option list
   and that the client payload shape matches. That is a static test for this project's recurring
   failure: something rendered, stored, and never sent.
8. **Plugin repository manifest install** for the plugin half, leaving the patched ffmpeg build
   optional as it is today.

Deliberately not taking: face restoration, object masking, frame interpolation, poster upscaling and
camera-style colour presets. Fun, and irrelevant to reconstruction quality on recorded video.

## What this project has that it does not

Being inside the transcode, so every client benefits rather than only browsers. libplacebo user
shaders on Vulkan. Five custom ffmpeg filters. Thirteen composable per-session axes, live
switchable. A capability probe that strips what the binary lacks. Honest negative reporting per
session. Ground-truth-referenced measurement rather than model reputation: their own model
evaluation doc says VMAF scoring on real clips is still pending.

---

# Planned: the media enhancement programme

Agreed order. Item 1 shipped; the rest are planned, not built. Each says what gets copied rather
than written, under which licence, and what has to be decided before code.

The licence rule that governs all of it is in AGENTS.md: this project is GPLv2-or-later, so MIT and
BSD-3 copy straight in with their headers, Apache-2.0 works but ships the result as GPLv3, and AGPL
and non-commercial licences are out whatever their quality.

## 1. Deblock and dering — DONE

Shipped. libavfilter `deblock` at two strengths, plus `fspp` and `pp7` from libpostproc which also
remove ringing. Runs at source resolution before any enlargement, because a network trained on clean
downsampled images treats a block edge as real detail. Availability probed against the running
binary, unknown counting as missing. Default off until measured. Nothing to copy: ffmpeg had it.

## 2. Batch pipeline — the unlock

Upscale overnight, direct-play forever. Recorded video is static, so the expensive models do not
belong on the playback path at all. It is also what makes `vf_ort` and `vf_optix` usable: NEURAL.md
measures them at 24, 15 and 10 fps, hopeless live and fine at 3 AM.

VENDOR, MIT, from Kuschel-code/JellyfinUpscalerPlugin at commit
6cd2aa390c7f0abde796106ed95ed02b978ec4be:
- `Services/FrameStreamCoordinator.cs` entire. 110 lines, zero Jellyfin types, pure BCL. It encodes
  a correctness argument that would be got wrong from memory: frame N is proven complete only when
  frame N+1 appears, only a CLEAN extractor exit promotes the final frame, and a failure still hands
  out every proven frame before reporting. Keep its XML doc verbatim, because the doc is the spec.
- Its `MaxFrameNumber` helper, which is the half of the invariant living outside the class: a
  high-water number rather than a file count, so a consumer deleting what it consumed is safe.
- The producer/watcher/consumer skeleton as a documented reference, retyped against our own types.
- One free lesson: `CultureInfo.InvariantCulture` on every number reaching a filtergraph string.
  Their `fps=23,976` under a German locale killed every job with "No such filter: '976'". Our chain
  has the same landmine.

WRITE OURSELVES, because their assumptions do not hold here:
- The scheduled task. Theirs carries six constructor dependencies we do not have, and it judges
  eligibility itself with a private resolution check. AGENTS.md invariant 8 says eligibility lives
  in one place, `UpscaleEngine.WouldEnhanceSource`. A batch task with its own threshold IS a second
  eligibility site.
- All ffmpeg command building. We patch `EncodingHelper` and run a shim that asks the patched binary
  which filters it carries. A vendored executor with a bare ffmpeg path would route batch work to
  the STOCK binary and silently produce unenhanced output, which invariant 10 says nothing will tell
  you about.
- The library refresh. Theirs has none: it writes `name_upscaled.ext` into the library and never
  triggers a scan, so the library is stale and the next natural scan produces a duplicate item
  rather than an alternate version.
- Colour handling. Their round trip is 8-bit PNG with `yuv420p` forced on reconstruct, one audio
  track, subtitles and chapters dropped. That would eat the colour-range work above.

DECIDE FIRST:
- How eligibility crosses the load-context boundary. `WouldEnhanceSource` lives in the patcher
  assembly and invariant 1 forbids the plugin referencing patcher types, so it is either a primitive
  JSON call like `PatcherLoader.StatusJson()` or one source file compiled into both. Not a fork.
- Where output goes, and whether it is a duplicate item or an alternate version.
- Whether we need the PNG round trip at all, given our inference already runs inside the filter
  graph.

VERIFIED PRESENT in our 12.1 assemblies: `IScheduledTask`, `IConfigurableScheduledTask`,
`TaskTriggerInfo`, `TaskTriggerInfoType`, `IPluginServiceRegistrator`, `VirtualFolderInfo`,
`InternalItemsQuery`, `ValidateMediaLibrary`, `QueueLibraryScan`, `GetMediaStreams`. Still to check
by compiler rather than by `strings`: the member shapes, and which namespace carries `MediaType`
now that both `Jellyfin.Data.Enums` and `Jellyfin.Database.Implementations.Enums` exist.

We have no `IPluginServiceRegistrator` today, so registering a scheduled task is a new file.

## 3. Interpolation, batch and opt-in

RIFE, MIT, via rife-ncnn-vulkan rather than written from scratch.

Batch only, opt-in per library, never a default, and NEVER on animation: animation is drawn on twos
and threes, and interpolating it destroys the cadence the animators chose. Our library is heavy with
it. On live action it produces the soap-opera effect, which people either want or hate with no
middle ground, so it is a preference and must be presented as one.

Realtime is not on the table: it costs more than the upscale and competes with NVENC on the same
card for something that is not reconstruction.

## 4. Camera-style presets, dashboard only

`eq`, `curves`, `vignette`, `colortemperature`, already in ffmpeg, effectively free.

Dashboard only and off by default, because this is grading rather than reconstruction: it changes
colour away from what the source intended, which cuts against everything else here. Offered because
it is nearly free and somebody may want it, not because it improves the picture.

## 5. Face restoration, batch and live-action

GFPGAN, Apache-2.0, so the combined work ships as GPLv3. NOT CodeFormer, whose S-Lab licence is
research and non-commercial only: it is the better-looking restorer and it cannot go in a GPL
project at any quality.

Batch only: restoring each frame independently flickers and drifts identity across a shot. Live
action only, since the weights are trained on real faces and do nothing for animation. Worth it for
genuinely poor sources and nothing else.

## 6. Region-selective upscaling, last

Spend the expensive network only where it matters. The appealing idea and the hardest to fit: our
chain is libplacebo shaders over the whole frame, with no seam for "spend here, not there", and
unstable masks pulse visibly between frames.

Only meaningful once the batch pipeline exists, where detection cost stops mattering and masks can
be smoothed across time. Not a realtime feature for us.

Detector must NOT be Ultralytics YOLO: AGPL-3.0 would place its obligations on the whole server.
Their tiny-YOLOv3 route, or another permissively licensed detector.

## What this programme does not include

Poster and image upscaling, frame interpolation as a realtime path, object masking outside batch,
and the client-side browser tiers. The client tiers are worth revisiting separately: they are the
answer to every honest negative this plugin gives a viewer, they cost the GPU nothing, and the
WebGL and Anime4K implementations are MIT and ready to copy.
