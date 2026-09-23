# TASK.L17: remaining items on the L17 blocker

Split out of `TASK.md` Track B on 2026-09-23. `TASK.md` still has the full history (agents 1-10,
under "L17 agent N"); this file is only the open items, so the next session doesn't have to re-read
ten agent reports to find what's left. Same rules as `TASK.md`: user's own hardware, personal-use
reverse-engineering spike, don't stop over NVIDIA EULA/licence concerns, host-side work only, no
kernel dataflow tracing.

## Where it stands

RTX VSR (`nvaivpx.dll` / AIVP) runs end to end: CreateInstance, Process, 19 kernel launches,
byte-identical and deterministic output. But the network's own contribution is close to useless.
With the network forced on (`AIVP_F10=0`, the harness's own `+0x10` split-fraction field, not an
NVIDIA gate), the output is dominated by a fixed 4px-periodic bias pattern from L17
(`conv3x3_fuse_conv1x1_with_pixel_shuffle4_bilinearAndSRBlockBicubic2...`), not by real detail.

Ten agents (TASK.md, "L17 agent 1" through "L17 agent 10") narrowed the cause without fixing it:

- L17's conv path **is** computed (tensor-core MMAs run on real feature data), not skipped. An
  earlier note saying "not computed" was wrong and has been corrected in TASK.md.
- An offline numpy re-implementation of L17 (agent 8) reproduces the same damage: the noise is
  `W2·relu(b1)+b2`, L17's own constant term, not a layout/permutation/scale error in its input.
  corr 0.93-0.94 against the real residual across every input layout tried.
  - `W1` is at argbuf `+0x8`, `b1` at `+0x20`, `W2` at `+0x250` (48x64), `b2` at `+0x268`, all fp16
    (offsets inferred from buffer sizes, unconfirmed against the DLL's own struct definitions).
- Best single-field fix: `+0x3a8` (default `0x40`) set to `1` gives 29.763/32.424 dB (RGB/Y) vs
  base 29.141/31.202, bicubic 34.699/32.929. Closes about 0.6/1.2 dB of a ~5 dB gap.
- Best two-field fix (agent 10): `+0x3a8=1` plus `+0x44=1` gives 29.809/32.359. No further
  improvement from a greedy search or the pairwise grid over the top 5 fields.
- One contiguous arena for slot 0x10's allocations (guard region, 512B alignment) changes nothing:
  same scores, x=1919 column still wrong. Rules out allocation layout as the cause.
- 114 of 1956 swept dword writes (agent 9) produced no output at all, spanning 26 fields across
  every tested value. Two spot-checked (`+0x1c0:=0`, `+0x3f8:=0xffffffff`) gave rc=0 and rc=716
  respectively on separate re-runs, which is inconsistent with a fixed per-field cause. So this
  looks state-dependent (write order, or memory left over between runs) rather than a bad field
  by itself. Not otherwise investigated.
- Network output is deterministic and not temporal within what the loader's own params can reach
  (agent 7): fresh-process repeats and previous-frame substitution (`AIVP_PREV`) don't change it.
  md5 checks remain valid.
- Frame 3130 was only scored on some of the above; not all findings were cross-checked against it.

Canonical scoring (agent 7, `analysis/t17/score.py` on CT114): candidate = loader's 1920x1080 P6
ppm; ground truth = `frames/gt_00XXXX.rgba` minus alpha; PSNR over all RGB samples at peak 255,
plus Y-PSNR with Rec.709 weights. Frame 1200 bicubic 34.699/32.929, frame 3130 bicubic
35.341/34.705. Bilinear/bypass were not scored under this method on all frames, which is worth
finishing before drawing conclusions from partial numbers.

## Open items, roughly in order of promise

1. **Explain the 114 no-output runs.** Only two of 26 affected fields were spot-checked, and those
   two disagreed with each other on re-run. Get a clean rc/error per field x value (not reused
   process state between writes), and check whether it's write-order-dependent: does the same
   write fail only after certain other fields were touched in the same process?
2. **A second bias/offset term outside the single argbuf dword space.** Agent 8's finding was that
   no single dword cancels `W2·relu(b1)+b2`. Not yet tried: whether that constant is meant to be
   subtracted by a *later* kernel (postProcess, launch 18) rather than by anything in L17 itself.
   Dump postProcess's argbuf and check for a field that looks like an offset or bias-removal term.
3. **Uncommitted arena change.** `~/dev/rtx-video-re/loader/aivp.c` on CT114 has the `AIVP_ARENA=1`
   knob (md5 `6bb2ee60`) not yet committed to the repo. It changed no score, but it's real,
   working code (confirmed network-off byte-identical) and should not be lost. Commit it, or
   explicitly decide to drop it if the arena approach is abandoned.
4. **Cross-check frame 3130** against every finding above that was only run on frame 1200.
5. **Multi-field combinations beyond pairs.** Only single fields (agent 9) and the top-5 pairwise
   grid plus a 6-step greedy search (agent 10) were tried. A 3- or 4-field combination search was
   never run. Low expected value given the greedy search plateaued, but not eliminated.
6. **Slot 12 (host callback `0x68`)** is still functionally unnamed. It fires twice per Process
   with `a1=0`; one call passes a small host descriptor (`06 00 04 00 03 00 01 00 07 00 07 00 ...`).
   Never conclusively shown to affect L17, but never fully decoded either.

## Status: active (2026-09-23)

The user wants a real neural RTX VSR, not the bypass fallback. Not parked. Continue on items 1 and
2 above, in that order, since they are the two with a concrete next action rather than a repeat of
work already done. The bypass fallback (`AIVP_FLAGS=0x100`, GPU-resident, already beats bicubic)
ships in parallel as the interim path, it does not replace this goal. See `TASK.md` Track C / the
GPU-resident preset for the bypass path.

## Access reference (unchanged from TASK.md / lookups)

- CT114: `ssh -o ConnectTimeout=10 -p 2298 root@192.168.1.2 'pct exec 114 -- bash -c "..."'`
- Loader repo (Mac): `~/dev/rtx-video-re/loader/`; edit locally, push to CT114, never the reverse.
- Canonical run: `env -u LD_PRELOAD AIVP_IO=surf AIVP_F10=0 AIVP_INPUT=frames/in_001200.rgba AIVP_OUT=x.ppm ./pe_map ../dll/Display.Driver/nvaivpx.dll --aivp-process 960,540,1920,1080`
- Scorer: `python3 /root/rtxv-spike/analysis/t17/score.py`
- Reference md5 (network on, frame 1200): `25c94c008af271b3b27fdf97f009837c`
