# Task: patch FFmpeg's hwcontext_vulkan.c to support hwmap Vulkan -> CUDA

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

## The task

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

## Steps

1. **Read before writing.** `vulkan_map_from()`'s existing DRM_PRIME/VAAPI cases (the pattern to
   follow), `vulkan_transfer_data_to_cuda`, `vulkan_transfer_data_from_cuda`, and however
   `CUexternalMemory`/`CUexternalSemaphore` import and
   `cuWaitExternalSemaphoresAsync`/`cuSignalExternalSemaphoresAsync` are already used in this file.
   Understand the full sync contract before writing the new case - do not reinvent it.
2. **Write the patch** as `ffmpeg/0005-vulkan-cuda-hwmap.patch`, matching the header/format of the
   existing `ffmpeg/0001`-`0004` patches (read one first, e.g. `0002-add-optix-filter-to-build.patch`,
   for this project's exact patch format).
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
   whole investigation (`improvements.md`'s own "Measure first" discipline).
9. **Do not flip `GpuResidentEncode`'s default, touch the live plugin config XML, or restart
   jellyfin.service, under any circumstance** - that decision belongs to the user once they see the
   measurement, not to you. If everything passes, the setting simply becomes real and usable rather
   than a documented dead end.

## Guardrails, non-negotiable

- Never restart jellyfin.service on CT114. Never touch the live plugin config XML. Always
  `--no-activate`. All verification is standalone `ffmpeg` invocations, never through Jellyfin.
- If step 6 finds ANY regression in ANY filter or the plain libplacebo path: immediately restore
  `.prev` over the live binary, re-verify with the same smoke tests that the box is back to
  known-good, report this as a failed patch. Do not leave the box degraded, even temporarily,
  longer than it takes to detect and revert.
- If the Vulkan/CUDA semaphore sync contract isn't fully understood and correctness under
  concurrent/repeated use can't be reasoned about with confidence - say so plainly and stop. A
  smoke test that worked once does not prove sync correctness under load. State this distinction
  explicitly in the report either way.

## Docs to update when done

Same dense style already used throughout:

1. `ARCHITECTURE.md` - items 1 and 3 under "GPU residency gaps", and the Tier 2 section.
2. `hw-resident-encode-plan.md` - "Real fix" and "What it would take" sections, with what actually
   happened and the step-8 measurement.
3. `improvements.md` item 3 (`GpuResidentEncode`) - outcome and the measured number.
4. `livetestbox.md` (local only, gitignored, NOT committed) - full command log and output, same
   pattern as the two prior investigations already recorded there.
5. If the patch works and is verified safe: commit and push `ffmpeg/0005-vulkan-cuda-hwmap.patch`,
   the `build-ffmpeg.sh` change, and doc updates to `origin/main` (check `git log` for message
   style, include `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`). If it failed or was
   reverted: commit and push the doc updates recording why, not the non-working patch itself unless
   clearly marked non-functional.

## Report back

Concisely: did the patch work, did every existing filter survive verification (not just linking),
what's the measured throughput delta, what state is CT114's ffmpeg binary in right now.
