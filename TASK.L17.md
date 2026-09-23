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

1. **DONE (L17 agent 11).** The 114 no-output runs are explained: 26 fields, one failing value
   each, 3 fresh-process trials apiece (78 runs total), all fully deterministic. 13 fields give
   `cuCtxSynchronize` rc=700 (`CUDA_ERROR_ILLEGAL_ADDRESS`), 13 give rc=716, split exactly along
   low/high dword of adjacent pointer-sized slots (`+0x1b0..+0x1ec` alternating 716/700). These
   are pointer fields; writing them corrupts a pointer and crashes predictably. No variance
   between trials, unlike agent 9's spot check. See TASK.md "L17 agent 11" for the run script and
   full breakdown. No further action needed unless a future sweep sees non-determinism again.
2. **DONE, negative result (L17 agent 11).** postProcess's argbuf (10 qwords, 0x50 bytes) has no
   unexplained scalar field: pointer, a type/flag dword (`+0x8`=2), dims at `+0x10/0x18/0x20`,
   the rest zero. Byte-identical shape, kernel name, grid and block between network-on and
   network-off. postProcess cannot be cancelling L17's constant term, and doesn't know whether the
   network ran. Ruled out: the bias fix is not at launch 18. Whatever cancels
   `W2·relu(b1)+b2` has to live inside L17 or upstream of it. Next idea worth trying: check L17's
   *input* preprocessing (launch <17, the preProcess stage) for a field that could be biasing what
   L17 sees, rather than continuing to search L17's own or postProcess's argbufs.
3. **Uncommitted arena change.** `~/dev/rtx-video-re/loader/aivp.c` on CT114 has the `AIVP_ARENA=1`
   knob (md5 `6bb2ee60`) not yet committed to the repo. It changed no score, but it's real,
   working code (confirmed network-off byte-identical) and should not be lost. Commit it, or
   explicitly decide to drop it if the arena approach is abandoned.
4. **DONE, negative result (L17 agent 12).** Cross-checked agent 10's pair fix, the Task 5 combo,
   and the top 10 individually-improving fields from `sweep_001200.tsv` on frame 3130. The pair
   (26.165/31.098) and the combo (26.430/31.098) both improve over 3130's base (25.645/30.023) but
   stay ~9 dB short of 3130's bicubic (35.341/34.705). More importantly, the single-field ranking
   does **not** transfer: `+0x150` is 3130's best single field (26.855/30.621), beating `+0x3a8`
   (25.934/30.982), which was the clear best on frame 1200 (29.763 there). So "best fix" is at
   least partly overfit to frame content, not a fixed property of the network. No fix beats
   bicubic on both frames. See TASK.md "L17 agent 12".
5. **DONE, negative result (L17 agent 12).** Combinatorial search over 3- and 4-field subsets of
   every field from `sweep_001200.tsv` that improves the score alone (21 fields), capped at 2000
   runs, plus alternate-seed greedy search. Best combo: `+0xa8=-1 +0xdc=2.0f +0x1e0=L16(0x40)
   +0x3a8=1` at 29.838/32.345, matching (not clearly beating) agent 10's pair (29.809/32.359).
   Alternate greedy seeds converge to the same or a worse local optimum, never a better one. One
   plateau, not several; not worth further multi-field search on this frame. See TASK.md
   "L17 agent 12".
6. **DONE, negative result (L17 agent 13).** Slot 12 (host callback `0x68`) is now fully
   characterized. Both call sites named (`img+0x2ac04`, `img+0x2ac41`); the second call's `a2=0x2c`
   confirmed as a real small integer, not a misread pointer. The first call's descriptor (`a2`
   pointer, `a3=0x7`) decoded to 80 bytes, all small u16 integers, plausibly counts/type tags, no
   further structure identifiable without disassembling the DLL. It is read/write from the DLL's
   side (two fields change between the callback firing and `Process` returning), but that mutation
   happens independent of the callback's return value or of writes made into the descriptor before
   returning: every tested return value (1, -1, 2, 3, 8, per call and combined) and every tested
   pre-return descriptor write scored identical to base, no crash, no change. Slot 12 is ruled out as
   a lever for L17, not by omission but by direct test in both directions. It was the last
   unexplored host<->DLL interaction point; see TASK.md "L17 agent 13" for the full method and data.
   Also negative: testing `+0x3a8`/`+0x44` as small integer "level" codes (3,4,8,15,16,32,64,100)
   rather than gains, prompted by the observation that real Windows sets RTX VSR's quality from the
   NVIDIA Control Panel. No clean ordering found; scores bounce non-monotonically and any local gain
   (e.g. `+0x3a8=3`'s Y-PSNR) fails to transfer to frame 3130. Not a Control-Panel-style lever.

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
