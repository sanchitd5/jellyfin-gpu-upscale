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

## Review (agent 14, fresh eyes)

Reviewed TASK.L17.md and TASK.md's full "L17 agent 1" through "L17 agent 13" entries, plus the
earlier CreateInstance/PPE-interface work and the ffmpeg-hosting shortcut, and read `aivp.c`'s
`aivp_process()` directly on the Mac loader checkout. No new CT114 runs. Nine points below (1-6
from the original brief, 7-9 added after a scope correction mid-review to cover the full
vsr_drv_cuda effort, not just the L17 bias sweeps).

1. **Bilinear-baseline contradiction: confirmed gap, not resolved, only noted.** The "external
   design note" entry (TASK.md ~line 1506) flags the PSNR script reading bilinear at 48.80 dB
   against an earlier 41.66 dB, and says to reconcile before scoring. No later agent entry
   reconciles it by name; agent 7 instead defines a new canonical scorer
   (`analysis/t17/score.py`) and reports fresh bicubic numbers (34.699/32.929 frame 1200,
   35.341/34.705 frame 3130) without explaining the earlier 48.80-vs-41.66 discrepancy. The
   canonical-scoring paragraph in this file's "Where it stands" section admits "Bilinear/bypass
   were not scored under this method on all frames" — i.e. the gap was carried forward, not
   closed. Next test: re-run whichever script produced 48.80 dB against the same
   `in_001200.rgba`/GT pair `score.py` now uses, and diff the two scorers line by line (crop,
   channel weights, clipping) until the numbers agree or the discrepancy is explained.

2. **Untested integer-range/value gaps: confirmed gap.** The full `[3..16]` integer sweep (agent
   13) was run on only `+0x3a8`/`+0x44`, the two fields that showed the largest single-field gain
   on frame 1200. It was never run on the other fields agent 9/12 found to move the score at all
   (`+0x150`, `+0x40`, `+0x48`, `+0x58`, `+0x68`, `+0x1a4`, `+0x200`, `+0xa8`, `+0xdc`, `+0x1e0`,
   etc. — the 21-field list in `analysis/b6/improving_fields.tsv`), including `+0x150`, which
   agent 12 found is actually the *best single field on frame 3130*, better than `+0x3a8` there.
   So the one field with the best cross-frame signal never got the level-code sweep at all. Also,
   no agent dumped AIVP's internal per-level weight-select table (the `this+0x70+8*L` model
   pointer array from the CreateInstance-era disassembly) to find a real non-round constant used
   internally; every tested value was one we chose (0/1/-1/0.5/2/3/4/8/15/16/32/64/100), not one
   read out of the DLL's own tables. Next test: `[3..16]` (and beyond) on `+0x150` specifically,
   on both frames, before ruling out a level-code interpretation.

3. **Assumptions never independently re-verified: confirmed gap, two instances.** (a) `fmt=0x20`
   for RGBA8 is flagged "Assumed, not verified... colours come out right, so plausible" at the
   first real-output milestone and was never revisited by later agents — no one tried a different
   format code as a sweep value the way `+0x10` eventually was. (b) The level-0-remaps-to-4
   `cmove` was read once from one disassembly pass; combined with "all 5 levels give
   byte-identical output," no agent checked whether the per-level model-select path
   (`this+0x70+8*L`) is itself short-circuited (e.g. always resolving to the same cached model
   pointer) versus genuinely loading different weights that just happen to produce identical
   pixels for this content. Both are treated as settled fact downstream (level sweeps, "level"
   framing in agent 13) without a second look.

4. **preProcess-input-biasing lead: confirmed gap, never followed up.** Agent 11 explicitly named
   this as the next idea ("check L17's *input* preprocessing... for a field that could be biasing
   what L17 sees, rather than continuing to search L17's own or postProcess's argbufs"). Agents 12
   and 13 both stayed inside L17's own argbuf (combo search, frame cross-check) or moved to
   postProcess/slot 12/level-code framing. Neither touches `dlpp_preProcess`'s argbuf (launch 1)
   at all past agent 6's tail-decode, which only characterized two dimension fields, not a sweep
   for a bias-injecting field. This is a real, unexplored gap, not a dead end — it is the one
   suggested next step from the L17-specific rounds that was never attempted.

5. **Harness's own hardcoded Process-param fields: confirmed gap, one new concrete instance.**
   Read `aivp_process()` in `~/dev/rtx-video-re/loader/aivp.c` in full. Every top-level Process
   param write: `+0x00=0x44` (struct size, structural), `+0x0c=g_plevel` (level, already swept
   1-4), `+0x10=1.0f` (the known split-fraction scaffolding bug, `AIVP_F10` overrides it),
   `+0x20/+0x24/+0x28/+0x2c` = input/output W/H (structural, independently confirmed live by
   agent 6), `+0x30=g_pfin`, `+0x34=g_pfout` (pixel format in/out), `+0x38` only written if
   `AIVP_F38` env is set (else stays 0 from zero-init, already tested by agent 4). `g_pfin`/
   `g_pfout` are the same class of bug as `+0x10`: values **we** hardcode from a CLI default,
   never reverse-engineered from the DLL, never swept as a candidate the way `+0x10` eventually
   was — they are exactly the "assumed fmt=0x20" from point 3, and the harness write of them was
   never flagged as a candidate field in its own right. Next test: sweep `+0x30`/`+0x34` (i.e.
   `g_pfin`/`g_pfout`) across other plausible DXGI/CUDA format codes with network on, the same way
   `+0x10` was swept once someone noticed it was our own scaffolding.

   **2026-09-23 (L17 agent 15), tested.** Added `AIVP_PFIN`/`AIVP_PFOUT` env overrides in `aivp.c`
   (previously the fields were only settable by editing the `g_pfin`/`g_pfout` C defaults). Swept
   `0, 1, 0x2, 0x3, 0x8, 0x1c, 0x20 (current default), 0x21, 0x29, 0x36` together on `+0x30`/`+0x34`,
   network on (`AIVP_F10=0`), frame 1200. Launch count stays 19 for every value (host-side-visible
   behavior: the DLL branches on the format field without changing which/how many kernels run),
   and the outputs collapse into exactly three md5 buckets — confirming the `0x20/0x29/0x36
   special` comment in `aivp.c` really is observable black-box behavior, not a guess. `0x29`/`0x36`
   corrupt the image outright (1.48 dB). The rest of the tested values (`0, 1, 0x2, 0x3, 0x8, 0x1c,
   0x21`) share one bucket, and it beats our own `0x20` default: frame 1200 `0x1c` gives
   29.171/32.430 RGB/Y vs `0x20`'s 29.141/31.202 (Y +1.23 dB); frame 3130 `0x1c` gives
   26.372/30.920 vs `0x20`'s 25.645/30.023 (RGB +0.73 dB, Y +0.90 dB) — same direction on both
   frames, not a frame-1200 overfit. Also confirmed with `AIVP_F10=0` vs `1` under `0x1c` that
   format choice doesn't gate whether the network's contribution matters (md5s still differ,
   same as under `0x20`). Still well short of bicubic on both frames. **Verdict: real, modest,
   cross-frame gain from fixing our own hardcoded default — closes this gap positive, though not
   enough on its own to beat bicubic.** No DLL disassembly was needed or done; the branch was
   found purely from black-box md5/score differences across the swept values.

6. **Frame/content choice: not a gap, a valid methodology flag.** Both CT114 test frames come
   from one already-decent 1080p library source downscaled to 960x540, then compared against that
   same 1080p as GT. Agent 8 found bicubic itself scores 47.20 dB with a 16px border cropped vs
   34.70 dB full-frame uncropped, i.e. the canonical score is border-dominated — a real
   demonstration that this scoring setup is noisy/dominated by edge effects, which supports the
   concern. No new run needed to say this, but it is a real risk: a genuinely-working but *small*
   residual could be sitting below this setup's noise floor on this specific content, and would
   show up more clearly on synthetic high-frequency patterns or genuinely low-quality/compressed
   source, which is also closer to VSR's real intended use case. Worth raising before concluding
   "the network never helps" rather than "the network doesn't help *measurably, on this content*."

7. **Early pipeline (pre-L17) work: mostly solid, one real gap found, confirmed via
   independent-check evidence.** The CreateInstance/`ppeGetExportTable`/`ppeGetVersion` chain was
   reversed against the *host's own* binary (`nvppex.dll`) disassembly, not guessed from the
   feature DLL alone, and cross-checked with a byte-identical 16-byte GUID match on both sides —
   this is about as verified as reverse engineering gets and was not just assumed. Slots 1
   (CreateInstance) and 2 (Process) are confirmed by direct disassembly; slots 3 and others are
   explicitly still marked "weakly characterized... not confirmed," which is honest, not
   overclaimed, and those slots don't feed frame data to L17 so they're not implicated in the bias
   problem regardless. The surface/texture-object fix (step 1.4 part 2) was verified with a
   synthetic test card (correct geometry/colour, ~bilinear on a flat card) and *re-verified* on
   real content afterward (preProcess probe showing correctly-decoded real pixel values, not the
   earlier broken all-`-1.0` raw-pointer read). Agent 8's numpy re-implementation of L17, fed
   L16's *actual dumped output* from the real DLL run, independently supports that upstream data
   (through L16) is real and non-degenerate. **The actual gap:** launches 3-15 — `dlpp_pixelFold`,
   `all_fuse_with_pooling_fp16_*`, `conv2d_v4_fp16_*`, `hfuse_with_pooling_*`,
   `upsampling_with_conv2d_fp16_*`, the entire conv-chain body between preProcess and L16 — were
   never individually dumped or plausibility-checked at any point across all 13 agents. Only
   preProcess, L16 (agent 8's dump target), L17, and postProcess were ever probed. If something in
   that middle stretch is subtly wrong (wrong channel order, a saturated intermediate, a layer
   silently no-op'd the way L17's conv path initially looked skipped), it would look exactly like
   "L17 ignores good input," and nobody has ruled it out layer-by-layer. Concrete next test: dump
   one intermediate buffer per launch 3-15 (DtoH on the first pointer-shaped arg, same method
   agent 8's L16 dump and the early per-launch probes already used) and sanity-check each for
   non-degenerate statistics (nonzero fraction, range, not-all-identical), the same bar already
   applied to preProcess/L16/L17/postProcess.

   **2026-09-23 (L17 agent 15), tested.** Dumped every launch 3-15's output buffer with
   `AIVP_PROBE=1 AIVP_PROBE_FULL=1 AIVP_DUMP=...`, network on, frame 1200, matched to kernel names
   via `cuFuncGetName` (`all_fuse_with_pooling_fp16_*` at launches 3-5/12/14/16,
   `conv2d_v4_fp16_*` at 6/9, `hfuse_with_pooling_fp16_*` at 7/10, `upsampling_with_conv2d_fp16_*`
   at 8/11/13/15). Output-address chaining across consecutive launches (this launch's write
   address feeding the next launch's read address) identified which of each launch's several
   pointer args is its own output. All 13 are fully finite (zero NaN/Inf), non-constant (50/50
   sampled distinct values every time), not saturated (`absmax` 1.004-1.037, consistent with a
   clamped/tanh-style activation range) and not degenerate (nonzero fraction 0.81-0.95, mean/std
   vary smoothly stage to stage, e.g. mean drifts from -0.31 at launch 3 to -0.05 at launch 15).
   **Every stage between preProcess and L16 is real, non-degenerate feature data. Closes this
   gap negative: nothing upstream of L17 is silently broken; the "L17 ignores good input" framing
   from agents 1-13 still holds.**

8. **`vf_aivp_spike` ffmpeg-hosting shortcut: confirmed gap — the actual neural-on path was never
   run through the filter.** Every `vf_aivp_spike`/shortcut-assumption verification
   (`AIVP_THREAD`, `AIVP_PRIMARY`, `AIVP_STREAM`, real-stream, no-LD_PRELOAD, the 400/440 fps
   numbers, the zero-alloc-after-init proof) checked md5 against either `AIVP_FLAGS=0x100`
   (explicit bypass, md5 `6d9a012a`) or default "flags 0" (md5 `b3c5094c`). `b3c5094c` is the same
   md5 reported elsewhere as the **network-off** baseline (e.g. the `AIVP_ARENA` test: "network-off
   md5 unchanged (`b3c5094c`)") — it is the default-`+0x10=1.0` case where the network covers zero
   columns, not `AIVP_F10=0` (md5 `25c94c00`), which is what every L17 bias-hunting agent actually
   used as "network on." So the filter integration and the actual (broken) neural path have never
   been run together: nobody has confirmed the filter's threading/context/stream setup behaves
   identically with `AIVP_F10=0` set, where the network's 19 launches actually feed into the split
   region. Given the launch sequence and count are the same regardless of the split value, this is
   probably fine, but it is asserted, not verified — flag it before treating the filter shortcut
   as validated for a genuinely-fixed neural path later.

9. **GPU-resident preset requirements: same gap as #8, one level up.** All of the GPU-resident
   proof categories (zero per-frame `cuMemcpyHtoD`/`DtoH`, `journalctl` command check, PCIe
   near-zero, flat CPU/RSS) were measured under the same `flags 0`/bypass runs as #8, never with
   `AIVP_F10=0`. The `AIVP_ARENA` contiguous-buffer change (agent 10, committed by agent 13) was
   tested only in the standalone `pe_map` harness, never inside `vf_aivp_spike` or under the
   GPU-resident preset's pooled-buffer requirement (Track C item 4). If a future L17 fix needs
   `AIVP_ARENA`-style contiguous allocation to matter, or changes which buffers Process touches per
   frame, the current zero-alloc/zero-HtoD numbers measured under bypass are not guaranteed to
   hold once the network genuinely contributes. Not urgent (no working neural fix exists yet to
   re-measure against) but worth re-proving once one does, not assumed to carry over.

10. **2026-09-23 (L17 agent 16), re-swept the prioritised argbuf list under the point-5 pixel-format
    fix: closed, no new lead.** Point 5's `0x1c` fix was found and verified only against the
    `0x20`-format baseline; every argbuf field/pair/combo sweep from agents 9, 10 and 12 was still
    run under the old, wrong `0x20`. Re-ran the ~20 individually-improving fields
    (`analysis/b6/improving_fields.tsv`), the best pair (`+0x3a8=1,+0x44=1`), and agent 12's best
    3/4-field combo (`+0xa8=-1,+0xdc=2.0f,+0x1e0=0x40,+0x3a8=1`) under `AIVP_PFIN=AIVP_PFOUT=0x1c`,
    both test frames. Result: the ranking is unchanged and the gains are additive, not
    interacting — `0x1c` and the argbuf fixes each add roughly their own independent margin.
    Best combined result, combo under `0x1c`: frame 1200 RGB/Y 29.873/33.473 (bicubic
    34.699/32.929 — RGB still ~4.8 dB short, but Y now edges past bicubic for the first time);
    frame 3130 27.992/32.467 (bicubic 35.341/34.705 — RGB ~7.3 dB short, Y ~2.2 dB short). Not a
    cross-frame win. Also tried asymmetric pfin/pfout (`0x1c` on one side, `0x1/0x2/0x3/0x8/0x21`
    on the other, both directions): every combination is md5-identical to symmetric `0x1c/0x1c`,
    confirming point 5's three-bucket finding holds at the pair level too — asymmetry inside one
    bucket carries no information. Did not reach a fresh sweep of previously-inert fields under
    `0x1c` (time budget); that remains open if a future agent wants it. **Closes negative: `0x1c`
    is confirmed the better default everywhere it was checked, but no combination found here, old
    or new, beats bicubic on both frames.** No loader code changed this session (reused agent 15's
    `AIVP_PFIN`/`AIVP_PFOUT` knobs); outputs at `/root/rtxv-spike/analysis/b9/resweep_pf1c.json`
    on CT114 (not version-controlled there).

**Most promising concrete gap:** point 4 (preProcess never swept for a bias-injecting field) and
point 7 (launches 3-15 never dumped/plausibility-checked) are the two live, unexplored leads —
point 7 is the deeper one, since it questions whether "L17 ignores good input" is even the right
frame, versus "something upstream of L16 is already degenerate and L17 is just the layer where it
became visible."

## Access reference (unchanged from TASK.md / lookups)

- CT114: `ssh -o ConnectTimeout=10 -p 2298 root@192.168.1.2 'pct exec 114 -- bash -c "..."'`
- Loader repo (Mac): `~/dev/rtx-video-re/loader/`; edit locally, push to CT114, never the reverse.
- Canonical run: `env -u LD_PRELOAD AIVP_IO=surf AIVP_F10=0 AIVP_INPUT=frames/in_001200.rgba AIVP_OUT=x.ppm ./pe_map ../dll/Display.Driver/nvaivpx.dll --aivp-process 960,540,1920,1080`
- Scorer: `python3 /root/rtxv-spike/analysis/t17/score.py`
- Reference md5 (network on, frame 1200): `25c94c008af271b3b27fdf97f009837c`
