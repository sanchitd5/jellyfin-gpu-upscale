# Building `rtx-video-re` (`rtxv`): design, from what the patch series says about itself

Status: **design only, nothing built.** Every fact below is quoted or derived from
`ffmpeg-patches/` (patches 0002-0011), which describes the tool that produced it in enough detail
to rebuild. Nothing here has been run.

Read `VSR.md` (REOPENED section) and `rtx-cuda-vsr-task.md` first for why this exists.

## The headline: capture runs on Linux, not Windows

The obvious reading of "extract from a Windows DLL" is static analysis on Windows. **That is not
how this was done.** The patches say so directly, three times:

- `0004` (isr): "The forward pass was reverse-engineered by **running the snippet on Linux via the
  NGX loader** and intercepting the live CUDA Driver-API launches."
- `0005` (vsr_drv): "reverse-engineered by **running the plugin on Linux via `loader_ppe`** and
  intercepting the live CUDA Driver-API launches."
- `0009` (deepdvc): "**running it on Linux via `loader_ppe`** and intercepting the live CUDA
  Driver-API [launches]."

The Windows DLLs are only the *carrier of the code*. A custom PE loader maps them on Linux,
resolves their imports against the Linux `libcuda`, and calls in. The CUDA calls the DLL then makes
are logged. **No Windows machine, no GPU passthrough, no D3D11.** CT114's RTX 3090 is sufficient
hardware for the whole project.

That is the single most important fact in this document and it was not guessable.

## Where each network comes from

| Filter | Source binary | How it is driven |
|---|---|---|
| `vsr_cuda` | `nvngx_vsr.dll` | NGX loader |
| `isr_cuda` | `nvngx_dlisr.dll` | NGX loader |
| `truehdr_cuda` | `nvngx_truehdr.dll` | NGX loader |
| `vsr_drv_cuda` | `nvaivpx.dll`, `ppe/features/AIVP` | `loader_ppe` |
| `dlpp_drv_cuda` | **`nvdlppx.dll`**, `ppe/features/DLPP` | `loader_ppe`, `run_process_dlpp` |
| `truehdr_drv_cuda` | `nvaihdrx.dll`, `ppe/features/TrueHDR` | `loader_ppe` |
| `deepdvc_drv_cuda` | `nvaidvcx.dll`, `ppe/features/DeepDVC` | `loader_ppe` |
| `smoothmotion_cuda` | **`libnvidia-present.so`** | static carve, no loader |

Note the last row: SmoothMotion is carved out of the **Linux** driver
(`rtxv extract smoothmotion <libnvidia-present.so>`, "the kernels are carved out of the driver as
whole [fatbins]"). It needs no PE loader at all and is therefore the cheapest thing in the series
to reproduce, though it is a frame doubler rather than an upscaler.

`VSR.md`'s original scan concluded the Linux driver ships no kernels. For VSR that is right. For
SmoothMotion it is wrong, and the scan's marker set (`__nv_relfatbin`/`__fatbin_reloc`) is the
likely reason it read as empty.

## The tool's own command surface, as the patches use it

```
rtxv extract <feature> <binary>     # pull per-arch cubins out of the DLL/.so
rtxv fatbins --cross-major          # pair per-arch images across a major-version boundary
rtxv inject                         # fix module load order (0009: "or module load will fail")
rtxv install                        # lay out the data dir + nvidia-video-filters.pc
rtxv.gen.<feature>                  # the per-feature codegen module
docs/FINDINGS-<feature>.md          # per-feature write-up
```

`rtxv install` must emit a `nvidia-video-filters.pc` carrying a `<feature>_datadir` variable per
feature, because that is exactly what `configure` in patch `0001` reads.

## What has to be built

### 1. PE loader for Linux (the hard part)

Two host shapes, sharing one PE loader:

- **`loader_ngx`** — loads an NGX snippet (`nvngx_*.dll`), supplies whatever NGX host interface it
  expects, drives one frame.
- **`loader_ppe`** — loads a DXVA/PPE plugin (`nvai*x.dll`), supplies the PPE host interface, drives
  one frame. Needs a per-feature entry (`run_process_dlpp` is named in `0006`).

The PE loader itself is well-trodden: map sections, apply base relocations, resolve imports, and —
the part people get wrong — set up MSVC's TLS and the `GS`-relative TEB, because NVIDIA's DLLs are
MSVC-built and will touch `gs:[0x58]` for `__declspec(thread)` data. Imports split three ways:

- `nvcuda.dll` → **our logging thunks** (see 2). This is why no Windows-side proxy DLL is needed:
  we control the import table, so interposition is free.
- `kernel32`/`msvcrt`/etc. → a small shim. Heap, TLS, critical sections, `LoadLibrary`/
  `GetProcAddress`, some synchronization. Implement on demand, by running and seeing what it calls.
- The PPE/NGX host interface → us, as the "driver" hosting the plugin.

**The undocumented host interface is the real risk in this project**, not the PE loading. The
plugin expects to be called by NVIDIA's own user-mode driver with structures nobody has published.
Recovering that shape is the work `docs/FINDINGS-*.md` presumably records.

### 2. CUDA Driver-API interposer

Log, with payloads:

| Call | What to record |
|---|---|
| `cuModuleLoadData(Ex)` | dump the fatbin image → this *is* the cubin, no PE parsing needed |
| `cuModuleGetFunction` | name ↔ handle, so launches resolve to names |
| `cuMemAlloc` | ordinal + size → arena layout (`0002`: take "largest size asked for each ordinal, as the driver's own allocator does") |
| `cuMemcpyHtoD(Async)` | payload + destination → `weights.bin` + the upload table |
| `cuLaunchKernel` | function, grid, block, smem, **full param bytes**, argsize |
| `cuTexObjectCreate` / `cuSurfObjectCreate` | handle → bindless slot, so params can be patched later |

Two captured quirks the patches already warn about, both observable only here: the driver
over-reports argsize by 8 bytes for the two DLPP tex/surf kernels (hence `FF_RTX_OP_PSIZE`, using
`EIATTR_CBANK_PARAM_SIZE` instead), and DLPP's format-selector offsets "were captured once" as one
shared ABI (`rtx_dlpp_abi.h`).

### 3. Capture driver

Run each feature across a sweep: many resolutions × each quality level × each scale. The sweep is
not optional — see 4.

### 4. Fitter and codegen (`rtxv.gen.<feature>`)

This is what turns traces into `<feature>_cuda_gen.h`. It must, per launch and per allocation,
classify every value as constant, device pointer (→ arena ordinal), bindless handle (→ slot),
tunable (→ patched at runtime), or **a function of resolution** — and for the last, fit a closed
form and verify it against held-out captures.

The difficulty is per feature, and the patches rank it for us:

- **`isr_cuda` is the easy one**: "ISR's network is RESOLUTION-INDEPENDENT: it runs on fixed
  256x256 tiles, so all of its per-tile launches carry identical grids, blocks and argument bytes at
  every input size and only device pointers differ. **Nothing has to be fitted.**"
- The VSR graphs do need fitting, "verified against captures at many resolutions and all three
  scales".

### 5. Static per-arch extraction

A capture only ever yields the capturing GPU's images — `0004`: "the snippet keeps a separate class
variant per architecture (sm_75 / _86 / _89 / _120 / _120 PTX), so a capture only ever yields the
capturing GPU's images. `rtxv extract isr` lifts the other arches straight out of the DLL — they
are named there, so the correspondence is exact — and bundles each kernel as a sm_75+86+89+120
fatbin that `cuModuleLoadData` picks from."

So static PE work is still needed, but only for *additional* architectures, and it is name-matched
rather than inferred. `rtxv fatbins --cross-major` handles the case where naming does not line up
across a major-version boundary (`0008` pairs them "by three [properties]").

**The upside for this box specifically:** capturing on CT114's RTX 3090 yields **sm_86** images
natively. That removes the `experimental_arch=1` unverified-band problem noted in
`rtx-cuda-vsr-task.md` for the one architecture we actually care about. A capture on our own GPU is
better than the upstream data dir for our purposes, not worse.

## Suggested build order

1. **`smoothmotion` first, as a spike.** No PE loader, no host interface — `libnvidia-present.so` is
   an ELF already on the box, and the kernels are carved whole. It exercises `rtxv extract`,
   `rtxv install`, the `.pc`, and the `configure` probe end to end, and proves the whole data-dir
   contract with none of the hard parts. If this cannot be made to work, nothing else will.
2. **`isr` next, as the first real capture.** Needs the NGX loader, but "nothing has to be fitted",
   so the codegen stays trivial and the loader gets debugged in isolation.
3. **`vsr_drv` / `dlpp_drv` last.** These need `loader_ppe`, the undocumented PPE host interface,
   *and* the resolution fitter. They are also the ones actually wanted.

Resisting the urge to start at step 3 is the whole point of the ordering.

## Prerequisites

- The Windows driver package, for the DLLs. `VSR.md` records GeForce 616.92 being downloaded and
  inspected once; it is not on any box now. The `nvai*x.dll` PPE plugins and `nvngx_*.dll` snippets
  both come out of it.
- `libnvidia-present.so` from the installed Linux driver (595.84) — already on CT114.
- A GPU to capture on: RTX 3090, sm_86. Present.
- Somewhere to build that is not CT114. CT114 is 4 cores / 4 GiB and runs live Jellyfin; a PE
  loader bring-up loop does not belong on it. The capture itself must run there (or anywhere with
  the GPU), but the edit/compile loop should not.

## Licensing boundary, stated once

Loading NVIDIA's own libraries against NVIDIA's own driver, on hardware we own, to make a media
pipeline interoperate, is the same category of work as Wine, DXVK and nouveau. That is not the
part to worry about.

The part to worry about is **redistribution**. The extracted cubins and weights are NVIDIA's
copyrighted artifacts. They must be treated exactly as this project already treats the DLSS `.so`
blob and the Maxine libraries: a runtime dependency produced or placed by hand on the box, **never
committed to this GPL tree, never published, never shipped in a plugin release**. `rtxv` itself —
our code — is ours. Its output is not. The `.pc`-and-data-dir design in patch `0001` exists
precisely to keep that line clean, and it should be kept clean for the same reason.

## What is still unknown

- The PPE and NGX host interfaces. This is the bulk of the unknown work and the main schedule risk.
- Whether `nvngx_*.dll` snippets need a licence/allowlist check satisfied before they will run.
- What `rtxv inject` actually fixes about module load order (`0009` says module load fails without
  it, but not why).
- Whether the 616.92-era DLLs and the installed 595.84 Linux driver are close enough to interoperate
  for the PPE path, or whether a matching Windows driver version is required.
