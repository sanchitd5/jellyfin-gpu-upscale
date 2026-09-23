# Hints from `GPU_COMPUTE_GRAPH_FILTER_PATTERN.md`

Everything reusable from a generic "GPU compute graph replay for media filters" design note the user
supplied on 2026-09-23. The note itself is not in this repo.

**None of it is verified against our code or DLL.** Its author, and whether its specifics match
driver 616.92, are unknown. Treat each item as a design reference or a lead to test, not a fact.
Its licensing and "publishing" sections do not change this project's rules: no NVIDIA binaries,
cubins or weights go in any repo.

---

## 1. The pattern in one paragraph

Precompute each kernel graph offline: grid and block sizes, dynamic shared memory, argument buffers,
buffer sizes. At config time, load the kernel modules, allocate one arena, upload the weights, bind
the images, build the launch list from tables and patch the tunables. Per frame, move input in,
optionally reset the arena, replay the launches on one stream, and move output out. Nothing is JIT
compiled, and results are reproducible.

## 2. Lifecycle

**Config time** (once per input size and quality change):

1. Architecture gate
2. Load kernel modules
3. Allocate a contiguous arena
4. Upload weights, async
5. Bind input, output and internal images
6. Build the launch sequence from the tables
7. Patch tunables and format selectors
8. Optional arena snapshot

**Per frame:**

1. Input to the GPU image (async)
2. Optional arena reset from the snapshot
3. Replay `cuLaunchKernel` for each launch on the stream
4. Output from the GPU image (async)

The stream orders everything, so there is no explicit sync per frame.

## 3. Memory: contiguous arena

- **Why:** conv and tiled kernels read past logical buffer edges (halo reads). With scattered
  allocations, an over-read can land in an unmapped hole after fragmentation, which gives an illegal
  access or garbage. In one arena it lands in the next buffer, which is mapped.
- **Layout:** `[buf0][buf1]...[guard]`, sub-buffers aligned to at least 512 B, a guard region at the
  end (`RTX_ALLOC_GUARD`). Computed once and never resized per frame.
- **Cost:** every buffer size must be known up front, which is what the precomputed tables provide.

## 4. Snapshot and reset (stateful or "clean slate" kernels)

- Many learned kernels read scratch before writing it and assume it starts zeroed. A fresh process
  gets zeroed pages; a long-running host sees stale data from earlier frames.
- **Pattern:** after the weight upload, snapshot the uploaded prefix of the arena. Per frame, restore
  it with `cuMemcpyDtoDAsync(arena, snapshot, prefix)` and zero the rest with
  `cuMemsetD8(arena + prefix, 0, total - prefix)`. That is one device-to-device copy per frame with
  no host traffic, and output stays byte-exact across thousands of frames.
- **Use it for:** conv networks and some optimisation kernels. The note uses it in its TrueHDR filter.

## 5. Weights

- One serialized blob (`weights.bin`) indexed by buffer id, with file offset and size metadata.
- Hundreds of small uploads (8 to 100 KiB) issued as `cuMemcpyHtoDAsync` with a single sync at the
  end, tracking the "uploaded prefix" for the snapshot.

## 6. Kernel modules

- Multi-architecture images (sm_75, sm_80, sm_86, sm_89, sm_120). `cuModuleLoadData` picks the image
  for the running GPU. An architecture mismatch is a load failure and should be handled cleanly.

## 7. Image binding

Three image types:

1. **CUDA array** (`cuArray3DCreate`) with an optional texture (read) and surface (write).
2. **Pitched linear** (`cuMemAllocPitch`) with optional `cuTexObjectCreatePitch2D` /
   `cuSurfObjectCreatePitch2D`.
3. **Plain linear** (`cuMemAlloc`) for pack/unpack staging.

Recommended bindings:

- **Input:** pitched texture, **linear filtering, normalized coordinates, clamp addressing**.
- **Output:** array plus surface.
- **Internal scratch:** array with a texture for the producer and a surface for the consumer.
- **In-place filters:** one array with both a texture and a surface, passed as both input and output.

## 8. Architecture gate

- Query `CU_DEVICE_ATTRIBUTE_COMPUTE_CAPABILITY_MAJOR/MINOR`.
- **Hard minimum:** refuse outright.
- **Soft gate:** a list of verified architectures (the note lists cc 8.9 and >= 12). Anything else
  needs an `experimental_arch=1` override and logs a warning.

## 9. Tables and tunables

```c
struct KernelLaunch  { int kernel_id, argsize; unsigned grid[3], block[3], shared_memory;
                       uint8_t params[MAX_ARG_SIZE]; };
struct ComputeConfig { const char *description; KernelLaunch *launches; int num_launches;
                       int *arena_allocations; int num_buffers; };
```

- Configs are indexed by (quality, scaling path). Example lookup: `configs[quality * 2 + path]`.
- **Tunables are argbuf patches:** find the launch by kernel name (`ff_rtx_find_launch`), then
  `memcpy(params + OFFSET, &value, 4)` at config time.
- **Why precompute:** no JIT, every combination can be verified offline, results are reproducible,
  grid sizes can be tuned per architecture, and divisions and scale factors are resolved offline.

## 10. Filter shapes from the note's portfolio

| Shape | Example | What it shows |
|---|---|---|
| Multi-path SR | `vsr_drv_cuda` | 4 quality levels, detail/smooth tunables, 2 graphs ("fast 2x" and "resample") |
| Multi-path SR, native scales | `dlpp_drv_cuda` | 4 graphs: a 2x base plus 3 high-quality native 2/3/4x paths |
| Exact-scale SR | `vsr_cuda` (NGX) | 2/4/8x, one graph |
| Tiled SR | `isr_cuda` | pre / body-per-tile / post phases; a per-tile pointer cursor patched into params (`cur_base + cur_stride * tile` at `cur_off`) |
| In-place | `deepdvc_drv_cuda` | Same image as input and output; vibrance/gain tunables |
| Size-invariant | `truehdr_cuda` | Output format selector (scRGB or HDR10); uses the snapshot |
| Temporal | `smoothmotion_cuda` | YUV/RGB/packed path selection, persistent textures across frames, 2x output rate |

The note's VSR config selection:

```c
int nscale = (quality >= 3) ? quality - 2 : 2;
int fast   = (oW == nscale * W && oH == nscale * H);
cfg = vsr_config_index(quality, nscale, fast ? 0 : 1);
```

Its VSR tunable patch writes `detail` and `smooth` into the **`dlpp_preProcess` launch's** argbuf at
`+0x38` and `+0x3c`. That is not the 0x44-byte Process params struct.

## 11. Filter template

- **Context:** graph core, in/out sizes, `config_id`, in/out images, `quality`, `intensity`,
  `output_format`, `kernel_data_dir`, `allow_unverified_arch`.
- **Options:** `quality` (int), `intensity` (float 0-1), `w`/`h` expressions, a data directory with a
  default path, `format`, `experimental_arch` (bool, default 0).

## 12. Assets

- Kernel modules and weights live in a user data directory outside the repo (the note uses
  `~/.local/share/rtx-video-re/`), and are loaded at run time by path. That keeps the GPL host
  code free of proprietary binaries. It matches our existing guardrail.

## 13. Testing strategy

1. Unit tests for arena layout and offset arithmetic.
2. The same operation on several GPU generations should give byte-identical output.
3. A 10,000-frame stress run to catch memory corruption and drift.
4. Precomputed tables checked against a reference run (for us, the loader running the real DLL).

## 14. Implementation checklist

- Offline tool that computes every (size, quality, path) combination
- Conservative arena size taken from the tables
- A single weight blob indexed by buffer id
- Multi-arch module loading
- Architecture gate
- Image binding as in section 7
- Launch patching by kernel name and offset
- Batched async upload with one sync
- Snapshot only where kernels read scratch before writing
- Reset: restore the snapshot and memset the remainder

---

## Leads for our current work (untested)

**L17 blocker** (TASK.md Track B): the DLL writes the full width into L17 `+0x498`, so no column
takes the network path, and forcing it gives noise.

1. **Config selection.** Every test so far was an exact 2x, which is the note's "fast" path. Retry
   at 1280x720 -> 1920x1080 and 960x540 -> 2880x1620, per level, and watch L17 `+0x498`.
2. **Tunables.** `dlpp_preProcess` argbuf `+0x38`/`+0x3c` (detail/smooth) were never set by us.
3. **Zeroed scratch (section 4).** `cuMemsetD8` every Process allocation to 0 before forcing
   `split = 0`, to test whether the noise is uninitialised scratch.
4. **Contiguous arena (section 3).** Our slot 0x10 backs each DLL allocation with its own
   `cuMemAlloc`, so halo reads can fall off a buffer's edge. That could explain the noise and also
   the wrong x=1919 column. Test: serve slot 0x10 from one arena with a guard region.
5. **Input binding (section 7).** We bind the input with point filtering. The note binds input as a
   pitched texture with linear filtering, normalized coordinates and clamp addressing. Try it, and
   watch the edge column too.
6. **Architecture gate (section 8).** The note's verified list is cc 8.9 and >= 12, and our GPU is
   cc 8.6. If the DLL chooses its path by the SM version we report through slot 0x08 (currently 86),
   test reporting 89 and watch L17 `+0x498`.

**Also for the GPU-only work** (roadmap/): the arena plus snapshot/reset pattern and the input
binding apply to any replayed or DLL-hosted filter. The tiled-SR cursor patch applies to the NGX
DLISR track.
