# Hints for RTX VSR (`vsr_drv_cuda`, nvaivpx.dll / AIVP)

These hints come from `GPU_COMPUTE_GRAPH_FILTER_PATTERN.md`, a generic "compute graph replay"
design note that the user supplied on 2026-09-23. It is not in this repo.

**None of it has been checked against our DLL.** The note's author, and whether its offsets match
driver 616.92, are unknown. Treat every item as a lead to test, not a fact. Its licensing section
does not change this project's rules: no NVIDIA binaries, cubins or weights go in any repo.

Current blocker these hints aim at: L17's `+0x498` is an output-column split, the DLL writes the full
width (1920), so no column takes the network path. Forcing it to 0 turns the network on but gives
noise (29.14 dB vs 37.47 base). See TASK.md Track B, "L17 agent 3".

## Lead 1: config selection by quality and scaling path (most promising)

The note's `vf_vsr_drv_cuda` picks a precomputed config like this:

```c
int nscale = (quality >= 3) ? quality - 2 : 2;
int fast   = (oW == nscale * W && oH == nscale * H);
cfg = vsr_config_index(quality, nscale, fast ? 0 : 1);
```

Every test so far has been 960x540 -> 1920x1080, an exact 2x. At level 0 (remapped to 4) that is
`nscale = 2`, so the "fast" config. If "fast" means bicubic-only, that would explain:

- the split at full width
- why all five levels gave byte-identical output (while launch counts differed: 17/8/17/19)

**Test:** run sizes that are not an exact multiple (1280x720 -> 1920x1080), and a native 3x at level 4
(960x540 -> 2880x1620). For each level, check whether the DLL writes a value below the output width
to L17 `+0x498` (`AIVP_ARGALL=1`). No new code needed.

## Lead 2: `detail` / `smooth` tunables in `dlpp_preProcess`

The note patches two floats into the **`dlpp_preProcess` launch's** argument buffer. This is not the
0x44-byte Process params struct.

```c
memcpy(a + 0x38, &detail, 4);   // preProcess argbuf +0x38
memcpy(a + 0x3c, &smooth, 4);   // preProcess argbuf +0x3c
```

We have never set these. If `detail` defaults to 0, the network's contribution may be off from there.

**Test:** dump preProcess argbuf `+0x38`/`+0x3c` as floats, then set detail to 0.5 and 1.0 with
`AIVP_ARGW="0;38:4:<float bits>"`. Watch L17's split and the output.

## Lead 3: uninitialised scratch explains the noise

The note's "Snapshot + Reset" decision says many learned kernels assume their scratch starts zeroed
("clean slate"). A fresh process gets zeroed pages, but a long-running host sees stale data.

Our loader allocates with `cuMemAlloc`, which does not zero, and `AIVP_POISON` even fills buffers with
0x55. If the DLL skipped initialising buffers because it believed the network was off, forcing
`split = 0` reads garbage.

**Test:** `cuMemsetD8` every Process allocation to 0 before Process, force `split = 0`, and check
whether the noise drops (PSNR vs GT, HF energy vs GT 2.28).

## Design points worth reusing

- **Precomputed launch tables.** `KernelLaunch { kernel_id, argsize, grid[3], block[3],
  shared_memory, params[] }`, grouped into `ComputeConfig` per (quality, scaling path) with the arena
  buffer sizes. This is the shape for the capture-and-codegen route (step 1.5/1.6) if we ever drop the
  DLL.
- **Tunables as argbuf patches.** User-facing knobs become `memcpy` into a known launch's argbuf at
  config time.
- **One contiguous arena** for scratch plus weights instead of scattered allocations.
- **Batched async weight upload, sync once.** Our loader already does 333 uploads at CreateInstance.
- **Per-frame arena snapshot and reset** (one device-to-device copy per frame). Keeps output
  byte-exact over thousands of frames, which matters for the GPU-resident preset and long transcodes.
- **Architecture gate** with an `experimental_arch` override, consistent with our planned self-test
  and driver hash gate.

## Not used

- The note's licensing and "publishing" sections.
- The generic 2-path blur example.
- Its claims about other filters (`isr_cuda`, `deepdvc_drv_cuda`) until we reach them. See
  `roadmap/driver-features.md`.
