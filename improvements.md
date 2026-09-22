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
- [ ] L650 `anyEnhancement()` tests only upscale/deblur/denoise, so a Custom pick of sr, neural, game,
  refine, chroma, kernel or deband never forces a transcode: direct play, nothing applied.
- [ ] L1829 the seeding loop writes `effective()` over `state.prefs` and the next save persists it, so
  `stage: off` permanently wipes the viewer's stored sr/neural/game choices.
- [ ] L2248 every axis but upscale is gated on `serverCaps.full`; a failed boot probe is never cached,
  so all axes are silently dropped for the life of the page.
- [ ] L1842 a partial probe answer rewrites stored preferences to `off` on disk.

### Shim (`shim/jellyfin-ffmpeg-upscale`)
- [ ] L435 the upscale path runs ffmpeg via `Popen` with no signal handling. Jellyfin killing the shim
  orphans the child, still writing segments and holding the GPU.
- [ ] L445 the per-pid error file is opened after `Popen`, and a failure there falls through to
  `passthrough()` → `execv`, leaving two ffmpegs writing the same output.
- [ ] L461 `rc != 0` retries the whole transcode even when the child was killed on purpose.
- [ ] L464 `sys.exit(rc)` turns a signal death into exit status 241.
- [ ] L77 a malformed config falls back to defaults that lack `plugin_patch_active`, so the shim
  rewrites a command the plugin is also rewriting. Should fail closed.
- [ ] L101 `wants_patched` rejects `]` as a leading boundary, so a labelled filter_complex node routes
  to the stock binary and fails outright instead of degrading.

### Patcher (`src/patcher/`)
- [ ] `UpscalePatches.cs:83` `_harmony` is assigned after the core patch loop, so a throw mid-loop
  leaves earlier patches installed and unpatchable: the partial core install the file forbids.
- [ ] `UpscalePatches.cs:287` the four postfixes disagree on one session; a burn-in session gets Vulkan
  device args with the stock filter graph.
- [ ] `UpscaleEngine.cs:291` history eviction deletes the live `_bySession` entry for a session that
  was recorded more than once, so the endpoint answers null for a playing session.
- [ ] `UpscaleEngine.cs:750` an unrecognised session value falls back to the dashboard default rather
  than to off, so a typo defeats an explicit Off and forces a transcode. Same at 775, 782, 827, 844, 858.

### ffmpeg filters
- [ ] `gu_inputs.h:548` `dlclose` on ONNX Runtime crashes the process at teardown.
- [ ] `gu_inputs.h:684` the depth output is read as 518x518 with no shape check; `dmodel=` is user-set,
  so a different model is an out-of-bounds read.
- [ ] `vf_dlss.c:361` and `vf_fsr2.c:376` `config_output` is not idempotent: a reconfigure leaks the
  instance, device, pool, fence, every image and the FSR2/NGX context.
- [ ] `vf_dlss.c:672` NGX shutdown is process-wide but called per instance, so two dlss filters in one
  process kill each other.
- [ ] `vf_ort.c:348` a non-float32 model output is read as float32: an out-of-bounds read of megabytes.

## Amber
Seventy-nine, recorded in the agent reports. The themes worth naming: no axis reserves its
concurrency slot at decision time, so the cap is advisory under parallel starts; the shader cache is
keyed on level names and compares mtime ordering, so a rollback that preserves timestamps serves a
stale composition forever; shader downloads are unpinned and verified only by a header grep, so a
truncated or substituted shader installs; several `config_input` paths are not re-entrant; and the
session ownership check added in round one is unverified against a live Jellyfin and fails open on
both sides at once.
