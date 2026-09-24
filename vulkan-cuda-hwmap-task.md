# Task: patch FFmpeg's hwcontext_vulkan.c to support hwmap Vulkan <-> CUDA

**STATUS: DONE, verified on real GPU hardware, committed and pushed (`origin/main`, commit
`61a7c3d` and the commit immediately before it - `git log --oneline -- ffmpeg/0006-*.patch
ffmpeg/0007-*.patch ffmpeg/0008-*.patch ffmpeg/0009-*.patch` to find the exact hashes). This
section is the orientation a next agent needs before touching anything here again - read this
first, then `livetestbox.md` for the full real-command-and-output log, then `ARCHITECTURE.md`'s
Tier 2 section for the summary. The rest of this file below is the ORIGINAL task spec, kept for
history and because the risk/guardrail sections still apply to any further work in this area -
its own "Steps" describe starting the work, which is now done; don't redo it.**

## What actually shipped, and in what order

Four patches, not one - the original scoping below (step 2, "write the patch as
`ffmpeg/0005-vulkan-cuda-hwmap.patch`") undersold this. What each one does:

- **`ffmpeg/0006-vulkan-to-cuda-hwmap.patch`** - the ORIGINAL scope of this file: adds the
  `AV_PIX_FMT_CUDA` case to `vulkan_map_from()` this doc describes below. Vulkan -> CUDA, one
  direction. This alone was enough for `GpuResidentEncode`'s own chain (`hwmap=derive_device=cuda`
  after libplacebo) and is what `livetestbox.md`'s earlier "GpuResidentEncode (hwmap=
  derive_device=cuda) - FIXED" entry verified, well before the rest of this file's history.
- **`ffmpeg/0007-cuda-to-vulkan-hwmap.patch`** - the REVERSE direction, CUDA -> Vulkan (a
  `vulkan_map_to()` `AV_PIX_FMT_CUDA` case), needed so a CUDA-native filter (`optix`,
  `dlpp_rtcuda`, `vsr_rtcuda`) can reach the Vulkan libplacebo stage in the first place. Also
  carries two fixes needed to make the CHAINED round trip (derive to Vulkan, then immediately
  derive back to CUDA) not segfault: `AV_VK_FRAME_FLAG_DISABLE_MULTIPLANE` forced on for a pool
  derived from CUDA (an unrelated real bug, `disable_multiplane`, found first), and clearing
  `source_frames` on that pool so `av_hwframe_map()`'s generic unmap-shortcut can't misfire and
  read a real Vulkan buffer as an `HWMapDescriptor*` (the actual segfault cause, found second, NOT
  explained by the multiplane fix - confirmed by testing, not assumed).
- **`ffmpeg/0008-hwmap-chain-format.patch`** - `libavfilter/vf_hwmap.c` (not `hwcontext_vulkan.c` -
  first patch in this whole stack to touch that file). Fixes a THIRD bug found only after the
  first two: the derived Vulkan pool's `.format` field gets corrected lazily on first real buffer
  allocation, but `vf_hwmap.c`'s own `hwmap_filter_frame()` was rebuilding `map->format` from a
  permanently-stale link value on every frame, so the fix only stayed correct for exactly one
  frame before every frame after it failed again.
- **`ffmpeg/0009-hwmap-query-formats.patch`** - found later still, once `UpscaleEngine.BuildChain`
  actually used the bridge for a session with NO CUDA-native filter anchoring the format (e.g.
  `dlpp` combined with `chroma`/`deband` but denoise off): `hwmap`'s own `query_formats` was
  totally unconstrained regardless of `derive_device_type`, so negotiation could land on garbage
  (`AV_PIX_FMT_GRAY`) without something upstream pinning it. Pins the output to the one real format
  when `derive_device_type` is `vulkan` or `cuda`.
- **One more real bug, fixed in C# not ffmpeg**: even with all four patches, libplacebo specifically
  needs a Vulkan device attached to the FILTERGRAPH's own `hw_device_ctx` (`-filter_hw_device vk`)
  to negotiate at all - `hwmap`'s own ad hoc device derivation is enough for hwmap<->hwmap round
  trips but not once libplacebo enters the chain. `UpscaleEngine.HwaccelArgs` now always emits
  `-init_hw_device vulkan=vk:0 -filter_hw_device vk` alongside the CUDA hwaccel for a
  `UsesCudaNeural` session (confirmed harmless when the bridge isn't used - declaring a device the
  graph never references costs nothing at run time).

**Five real bugs total across this file's history, none obvious from the previous one's fix, each
found by actually running the chain end to end rather than trusting a patch's own logic.** If
you're about to touch this area again: assume there may be a sixth. Test the real generated
command, not the string shape.

## What this unlocked, concretely

`UpscaleEngine.BuildChain`'s CUDA-native branch (dlpp-1..4/vsr-rtcuda) can now also run
deband/kernel-scale/refine/chroma/unblur (the Vulkan libplacebo stage) in the same session,
bridging `hwmap=derive_device=vulkan` -> libplacebo -> `hwmap=derive_device=cuda` around the CUDA
neural filter, with no system-memory round trip anywhere in the bridge. `web/src/model/conflicts.js`
no longer greys those five controls out for a CUDA-native neural level. Verified: the exact
`UpscaleEngine`-generated command exits 0 with real frame counts, plus a 15-case combinatorial
matrix (individual axes, all five together, both `optix` denoise states, all four `dlpp` levels,
`vsr_rtcuda`) all pass.

**What this did NOT unlock**: `vf_dlss.c`/`vf_fsr2.c` are still `AV_PIX_FMT_GBRPF32LE`-only with no
hardware-frame support at all (confirmed by reading `vf_dlss.c` directly - see
`roadmap/gpu-only-dlss.md`'s own note on this). The bridge is plumbing between two ALREADY
hw-frame-native filters; it does nothing for a filter that isn't hw-frame-native yet. `oidn`/`ort`
are in the same position. Converting any of those four to read/write hardware frames directly is
real, separate, unstarted work - see `roadmap/gpu-only-filters.md` and `roadmap/gpu-only-dlss.md`.

---

## Original task spec (below), kept for history and because the guardrails still apply

Handover doc for a subagent. Read `ARCHITECTURE.md`, `hw-resident-encode-plan.md`, and
`livetestbox.md` in this repo first - they contain the full investigation this task continues.
Read `AGENTS.md` and `CLAUDE.md` for this project's engineering culture before touching anything.

## Confirmed state (2026-09-22, checked twice, most recently against current FFmpeg `master`
fetched fresh today - not a stale finding)

`hwmap=derive_device=cuda` from a Vulkan source fails: `Failed to map frame: -38` (`Function not
implemented`). Root cause read directly from source, not guessed: `libavutil/hwcontext_vulkan.c`'s
`vulkan_map_from()` has a `switch (dst->format)` with cases only for `AV_PIX_FMT_DRM_PRIME` and
`AV_PIX_FMT_VAAPI`. No `AV_PIX_FMT_CUDA` case exists, in the `n8.1.2` tag this project builds or
in current FFmpeg `master`. Falls to `default: return AVERROR(ENOSYS)` - the exact `-38`.

What DOES already exist in the same file, confirmed present and apparently actively maintained
(there's a 2025-03-07 upstream commit "hwcontext_vulkan: add support for mapping multiplane images
into CUDA" and a 2026-04-12 fix for a related double-free, both real, checked via `gh api
search/commits` against the FFmpeg/FFmpeg GitHub mirror): `vulkan_transfer_data_to_cuda()` and
`vulkan_transfer_data_from_cuda()`, wired into `vulkan_transfer_data_to`/`vulkan_transfer_data_from`
- the `av_hwframe_transfer_data()` (copy) path, not `av_hwframe_map()` (the `hwmap` filter's path).
This does a real device-to-device `CUDA_MEMCPY2D`/`cuMemcpy2DAsync`, with proper
`CUDA_EXTERNAL_MEMORY_HANDLE_DESC`/`CUDA_EXTERNAL_SEMAPHORE_HANDLE_DESC` import and
wait/signal-params synchronization already implemented and (per the recent upstream commits)
actively maintained upstream - **this is the reference implementation for the sync contract**,
read it closely before writing anything new. `vulkan_frames_derive_to()` (frames-context-level
derive, different from per-frame map) also has no CUDA case as of current master - checked, no
`CUDA` references anywhere in that function.

So: the sync-correct GPU-to-GPU copy machinery exists and is upstream-maintained. The gap is
narrow and specific: `vulkan_map_from()`'s switch has no route to it.

## The task (DONE - see status header above)

Add an `AV_PIX_FMT_CUDA` case to `vulkan_map_from()` in `libavutil/hwcontext_vulkan.c` that reuses
the existing `vulkan_transfer_data_to_cuda`/`_from_cuda` machinery (or the synchronization pattern
those functions already establish) so `hwmap=derive_device=cuda` from a Vulkan source actually
works. This will be copy semantics (device-to-device), not true zero-copy pointer aliasing - that
is architecturally correct and expected: CUDA imports the Vulkan image as a texture array
(`CUDA_EXTERNAL_MEMORY_MIPMAPPED_ARRAY_DESC`), not a linear device pointer, and NVENC wants
linear/pitched memory, so a device-side copy is required regardless of which FFmpeg API expresses
it. It still eliminates the system-RAM round trip that's the actual point of this whole
investigation.

## Why this is the highest-risk task in the investigation so far

`hwcontext_vulkan.c` is shared plumbing under EVERY Vulkan-touching filter in this project:
`vf_oidn.c`'s Vulkan path, `vf_optix.c`, `vf_fsr2.c`, `vf_dlss.c`, `nlmeans_vulkan`, and
libplacebo itself (the SR shader ladder, and the plain resize every single session uses,
enhanced or not). A synchronization bug here - Vulkan semaphore signal/wait ordering vs. CUDA
stream ordering is the classic way this class of patch goes wrong - does not fail loud on the new
code path only. It can silently corrupt frames or hang the GPU across every enhancement session on
the box, including ones that never touch the new CUDA case at all, because they all still execute
other code paths in this same file. Move accordingly.

## Steps (DONE - kept for history)

1. **Read before writing.** `vulkan_map_from()`'s existing DRM_PRIME/VAAPI cases (the pattern to
   follow), `vulkan_transfer_data_to_cuda`, `vulkan_transfer_data_from_cuda`, and however
   `CUexternalMemory`/`CUexternalSemaphore` import and
   `cuWaitExternalSemaphoresAsync`/`cuSignalExternalSemaphoresAsync` are already used in this file.
   Understand the full sync contract before writing the new case - do not reinvent it.
2. **Write the patch** as `ffmpeg/0005-vulkan-cuda-hwmap.patch`, matching the header/format of the
   existing `ffmpeg/0001`-`0004` patches (read one first, e.g. `0002-add-optix-filter-to-build.patch`,
   for this project's exact patch format). *(Shipped as `0006`, not `0005` - four more patches
   followed, see the status header.)*
3. **Wire it into the build.** Read `scripts/build-ffmpeg.sh` to see how 0001-0004 are applied
   (order, `WITH_*` conditionals) and add 0005 correctly - probably unconditional since it's a
   core-file fix, confirm against the script's actual structure rather than assuming.
4. **Push before building.** Commit in the local repo (`/Users/sanchitdang/dev/jellyfin-gpu-upscale`),
   push to `origin/main` FIRST - `scripts/proxmox-build.sh` hard-resets the server checkout
   (`/opt/jellyfin-gpu-upscale` on CT114) to `origin/main` on every build.
5. **Build on CT114**: `pct exec 114 -- bash -c 'cd /opt/jellyfin-gpu-upscale && bash
   scripts/proxmox-build.sh --with-ffmpeg --no-activate'` (ssh via `ssh -p 2298 root@192.168.1.2`
   from this machine, `pct exec 114` from the pve host). Slow, let it run. The script refuses to
   deploy and auto-restores `.prev` if any of the 5 custom filters goes missing from `ffmpeg
   -filters` - necessary but NOT sufficient verification for this patch specifically (see next
   step: the failure mode here passes a `-filters` grep every time).
6. **Verify every filter still works, not just links.** Standalone smoke test (bare `ffmpeg -f
   lavfi -i testsrc=... -f null -`, no Jellyfin involvement) for EACH of `oidn`, `optix`, `ort`,
   `fsr2`, `dlss`, AND the plain libplacebo SR/resize path every session actually uses. Confirm
   real output frames each time. Any regression versus pre-patch behavior in ANY of these = treat
   the whole patch as failed.
7. **Re-run the exact `hwmap=derive_device=cuda` smoke test** already documented in
   `livetestbox.md`. Confirm success AND sane output (rough frame-count/byte-count parity against
   the equivalent `hwdownload,format=yuv420p` path on the same input).
8. **Measure.** Time both paths - current `hwdownload,format=yuv420p` vs new
   `hwmap=derive_device=cuda` - at 1080p output (the dashboard default `TargetHeight`) over a few
   hundred frames. Report the wall-clock/throughput delta. This number is what's been missing this
   whole investigation (`improvements.md`'s own "Measure first" discipline). *(Not yet done for the
   final shipped state - the four-patch stack was verified for correctness and real GPU execution,
   not for throughput delta. Still open if anyone wants it.)*
9. **Do not flip `GpuResidentEncode`'s default, touch the live plugin config XML, or restart
   jellyfin.service, under any circumstance** - that decision belongs to the user once they see the
   measurement, not to you. If everything passes, the setting simply becomes real and usable rather
   than a documented dead end.

## Guardrails, non-negotiable (still apply to any further work here)

- Never restart jellyfin.service on CT114 without the user's explicit go-ahead. Never touch the
  live plugin config XML without it either. Prefer `--no-activate` for exploratory builds. All
  verification should default to standalone `ffmpeg` invocations, never through Jellyfin, unless
  the user has asked for a live deploy.
- If a regression is found in ANY filter or the plain libplacebo path: immediately restore
  `.prev` over the live binary if one was installed, re-verify with the same smoke tests that the
  box is back to known-good, report this as a failed patch. Do not leave the box degraded, even
  temporarily, longer than it takes to detect and revert.
- If the Vulkan/CUDA semaphore sync contract isn't fully understood and correctness under
  concurrent/repeated use can't be reasoned about with confidence - say so plainly and stop. A
  smoke test that worked once does not prove sync correctness under load. State this distinction
  explicitly in the report either way. **As shipped, this stack has real-GPU functional
  verification (many repeated runs, a 15-case combinatorial matrix, regression checks against
  earlier fixes) but no dedicated stress/concurrency/long-run test - worth knowing before treating
  it as bulletproof under production load.**

## Docs to update when done (DONE - see status header; keep this list current if you touch this again)

Same dense style already used throughout:

1. `ARCHITECTURE.md` - items 1 and 3 under "GPU residency gaps", and the Tier 2 section. *(Done.)*
2. `hw-resident-encode-plan.md` - "Real fix" and "What it would take" sections, with what actually
   happened. *(Not yet done this pass - worth checking before relying on that file being current.)*
3. `improvements.md` item 3 (`GpuResidentEncode`) - outcome. *(Not yet done this pass.)*
4. `livetestbox.md` (local only, gitignored, NOT committed) - full command log and output, same
   pattern as the two prior investigations already recorded there. *(Done, extensively - this is
   the primary source of truth for exactly what was tried, found, and verified.)*
5. `roadmap/gpu-only-filters.md`, `roadmap/gpu-only-dlss.md` - both corrected to stop describing
   this gap as blocking/unstarted, with an honest note on what the fix does and doesn't unlock for
   each. *(Done.)*
6. This file (`vulkan-cuda-hwmap-task.md`) - status header added, keep it current. *(Done, this
   edit.)*
7. Commit and push (`ffmpeg/0006`-`0009`, `UpscaleEngine.cs`, `conflicts.js`, `build-ffmpeg.sh`,
   and all doc updates) to `origin/main`, `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
   *(Done.)*

## Report back (for the ORIGINAL task - answered here, for history)

Did the patch work: yes, real GPU verification, see above. Did every existing filter survive: yes
- all 7 (`oidn`/`optix`/`ort`/`fsr2`/`dlss`/`dlpp_rtcuda`/`vsr_rtcuda`) confirmed present via
`-filters` on every build in this stack's history, plus the 15-case combinatorial matrix. Measured
throughput delta: not done (see step 8 above - open if wanted). CT114's ffmpeg binary state: last
confirmed deployed for the THREE-bug fix (commit before `61a7c3d`); the two-more-bugs-plus-C#/web
work in `61a7c3d` was verified on a standalone debug prefix on CT114 but had not been through a
real production deploy as of that commit landing - check `git -C /opt/jellyfin-gpu-upscale log -1`
against `origin/main` and `/usr/lib/jellyfin-ffmpeg-oidn/ffmpeg`'s own mtime/behavior before
assuming it's live.
