# FSR2 as a video filter, what it costs, and what you have to build yourself

`game=fsr2` runs **AMD FidelityFX Super Resolution 2** over the frame in place of the SR shader.
It is an **advanced, opt-in level**: off by default, not a rung of the generated quality ladder,
never selected automatically, and labelled degraded everywhere it is shown.

Read the next section before enabling it. It is not a caveat, it is the whole point.

## FSR2 is not an image upscaler, and this is not FSR2 working properly

FSR2 is a temporal reconstruction algorithm for a **renderer**. Everything it gains over a plain
resize comes from the renderer handing it four things a camera never records:

| input | what a renderer gives it | what this filter gives it |
|---|---|---|
| motion vectors | exact screen-space vectors, jitter removed, by construction | **NVOFA optical flow**, estimated from the compressed picture |
| depth | the depth buffer it just rendered | **a monocular estimate**, relative and unscaled - or a flat plane |
| jitter | the exact sub-pixel offset it applied to the projection matrix | **a measured global phase-correlation offset** |
| reactive mask | authored per material | **forward/backward flow inconsistency** |

Three of those are approximations. The fourth is fatal, and it was measured here rather than
argued (`the jitter measurements (see What was tried and rejected in the README)`):

* `jitterOffset` in FSR2 is a **single global `float2` per frame**. There is no per-pixel,
  per-tile or texture-based jitter input anywhere in the API, because a renderer never needs one.
* This content's sub-pixel motion is **local**. Only 39.8% (median, 11 clips) of textured 128 px
  blocks move within 0.25 px of the frame's global phase-correlation estimate, and the median
  block deviates **0.29 px** against FSR2's entire **+/-0.5 px** budget.
* AMD's own documentation says the sequence "never generates a null vector; that is value of 0 in
  both the X and Y dimensions". A fixed camera generates exactly that.

With a near-null jitter sequence, `ComputeHrPosFromLrPos` is frame-invariant, `StoreNewLocks`
writes the same subset of display-resolution pixels every frame, the locks never sweep the display
grid, and `fBaseSampleOffset` never moves. What is left is **a temporal denoise plus a fixed
Lanczos upsample**. That is not super-resolution, and the menu says so.

**Expect ghosting.** The reactive mask (`reactive=flow`, the default) is FSR2's own designed control
for it and it is supplied, but from flow inconsistency, which finds occlusion and disocclusion and
not transparency or shading change.

## Options

| option | values | default | note |
|---|---|---|---|
| `w`, `h` | int | 2x input | output size; the plugin passes the session's target |
| `jitter` | `measured`, `cancel`, `zero`, `halton` | `measured` | all four are wrong, differently |
| `depth` | `model`, `model-stable`, `flat` | `model` | falls back to `flat` on its own, see below |
| `dmodel` | path | Depth Anything V2 small | not shipped |
| `reactive` | `flow`, `none` | `flow` | `flow` costs one extra NVOFA pass |
| `sharpness` | 0..1 | `0` | FSR2's own RCAS pass |
| `device` | int | `0` | CUDA/Vulkan device index |

`jitter=cancel` additionally sets `FFX_FSR2_ENABLE_MOTION_VECTORS_JITTER_CANCELLATION`. FSR2's
contract is that motion vectors are jitter-FREE; optical flow between two recorded frames contains
whatever sub-pixel motion there was, including the part handed over separately as `jitterOffset`,
so that flag tells FSR2 to subtract it back out. Which of the two is less wrong is a measurement.

Only the **sub-pixel residual** is passed as `jitterOffset` (`d - nearbyint(d)`). FSR2's contract
puts the integer part, and all local motion, in the motion vector texture, where the flow field
already carries it; passing the whole measured offset would double-count it.

### Depth, and why it turns itself off

`depth=model` runs **Depth Anything V2 small** through ONNX Runtime, loaded with `dlopen` so the
filter links against no inference stack: if the runtime is missing it warns once and uses flat
depth rather than failing the session. The model emits relative **inverse** depth (large = near),
which is exactly FSR2's `FFX_FSR2_ENABLE_DEPTH_INVERTED` convention, so it is passed through
unchanged.

It is **relative, unscaled and renormalised every frame**. FSR2 reads depth for disocclusion
detection and motion vector dilation, both of which compare depth across frames, so the model's
frame-to-frame wander is read by FSR2 as geometry appearing and vanishing - which manufactures the
ghosting the reactive mask is there to suppress. `depth=model-stable` warps the previous depth by
the flow field and blends (EMA, alpha 0.5). That is a smoother, not a fix.

**If ONNX Runtime has no CUDA execution provider, depth falls back to flat and says so.** A
per-frame vision transformer on the CPU measured about 1 fps at 518x518 on this box. That is a
still-image tool, not a transcode filter, so the absence of the CUDA provider is a fallback to
flat depth rather than a fallback to slow depth.

## Where it sits in the chain

CPU side of `hwupload`, after denoise and after neural SR, same routing invariant everything else
obeys (the filter carries no `_vulkan` in its name, so it goes before the upload):

```
format=yuv420p,format=gbrpf32le,fsr2=w=1920:h=1080:jitter=measured:reactive=flow:depth=model:dmodel=...,format=yuv420p,hwupload,libplacebo=w=1920:h=1080,...
```

`fsr2` produces the **target size itself**, so `libplacebo`'s scale becomes a no-op, and the SR
shader and the refinement pass are **dropped** for this level rather than run a second upscaler
against the first.

## Building it - the shader compiler is the hard part

`ffmpeg/vf_fsr2.c` and `ffmpeg/gu_inputs.h` are **our own code**, LGPL-2.1-or-later like the rest
of libavfilter, and are published here. FSR2 itself is MIT but is **not vendored**: you fetch it.

Upstream's build does not work on Linux. `src/ffx-fsr2-api/CMakeLists.txt` sets

```
set(FFX_SC_EXECUTABLE ${CMAKE_CURRENT_SOURCE_DIR}/../../tools/sc/FidelityFX_SC.exe)
```

a **Windows binary**, and the repository ships no compiled shader permutations. The root
`CMakeLists.txt` is MSVC-only besides (`add_compile_options(/MP)`, a VS2019 toolset check).

`ffmpeg/gen_perm.py` in this repository replaces that tool. It compiles each of the eight FSR2
compute passes with `glslangValidator` once per permutation, reflects the resulting SPIR-V for the
descriptor bindings, and emits the `<pass>_permutations.h` headers that
`vk/shaders/ffx_fsr2_shaders_vk.cpp` includes. Measured on this box: **1008 permutations in
2m17s**, deduplicating to 109 unique SPIR-V blobs, zero fp16 fallbacks.

```bash
# 1. FSR2 itself (MIT) - fetched, not vendored
git clone --depth 1 https://github.com/GPUOpen-Effects/FidelityFX-FSR2.git fsr2
# verified against HEAD 1680d1edd5c034f88ebbbb793d8b88f8842cf804

# 2. the shader permutation headers, in place of FidelityFX_SC.exe
apt-get install -y glslang-tools
python3 ffmpeg/gen_perm.py          # edit SRC/OUT at the top

# 3. the Vulkan backend as a static library.  ffx_compat.h is ours: it supplies
#    _countof and the two wcscpy_s overloads MSVC has and g++ does not.
for f in fsr2/src/ffx-fsr2-api/*.cpp fsr2/src/ffx-fsr2-api/vk/*.cpp \
         fsr2/src/ffx-fsr2-api/vk/shaders/*.cpp; do
    g++ -O2 -fPIC -std=c++17 -DFFX_GCC -include ffmpeg/fsr2compat.h \
        -I<permutation-header-dir> -c "$f" -o "$(basename "$f" .cpp).o"
done
ar rcs libffx_fsr2_vk.a *.o
```

Then add to the same patched binary `OIDN.md`, `OPTIX.md` and `NEURAL.md` describe, applying the
patches **in order** - `0001` oidn, `0002` optix, `0003` ort, `0004` fsr2 and dlss together:

```bash
cp ffmpeg/vf_fsr2.c ffmpeg/gu_inputs.h ffmpeg-8.1.2/libavfilter/
patch -p1 < ffmpeg/0004-add-fsr2-and-dlss-filters-to-build.patch
./configure ... --enable-libffxfsr2 --enable-libngx \
  --extra-cflags="-DFFX_GCC -I.../fsr2/src/ffx-fsr2-api ..." \
  --extra-ldflags="-L<dir holding libffx_fsr2_vk.a> ..."
```

`-DFFX_GCC` is **required**: without it `ffx_types.h` defines `FFX_API` as
`__declspec(dllexport)` and every FSR2 header fails to parse.

`0004-add-fsr2-and-dlss-filters-to-build.patch` adds `libffxfsr2` to `EXTERNAL_LIBRARY_LIST`,
`fsr2_filter_deps="libffxfsr2 ffnvcodec vulkan"`, a header-presence check, the link flags, the
`vf_fsr2.o` Makefile rule and the `allfilters.c` declaration.

### What you must fetch yourself

| what | from | licence |
|---|---|---|
| FidelityFX-FSR2 | `https://github.com/GPUOpen-Effects/FidelityFX-FSR2` | MIT |
| NVIDIA Optical Flow SDK headers | `https://github.com/NVIDIA/NVIDIAOpticalFlowSDK`, branch `nvof_2_0_bsd` | 3-clause BSD |
| nv-codec-headers | `https://github.com/FFmpeg/nv-codec-headers`, tag matching your driver | LGPL-2.1 |
| Depth Anything V2 small, ONNX | `https://huggingface.co/onnx-community/depth-anything-v2-small` | Apache-2.0 (the small/ViT-S model) |
| ONNX Runtime with the CUDA EP | see `NEURAL.md` | MIT |
| glslang | `apt install glslang-tools` | Apache-2.0 / BSD |

The depth weights go in `/usr/lib/jellyfin-ffmpeg-oidn/models/depth_anything_v2_vits.onnx`. A
level whose weights are absent still runs, with flat depth.

## Own Vulkan device, and why

`vf_fsr2` creates its **own** `VkInstance`/`VkDevice` rather than borrowing FFmpeg's Vulkan
hwcontext. FSR2's backend picks its fp16 shader permutations from the **physical** device's
capability (`VkPhysicalDeviceShaderFloat16Int8Features.shaderFloat16`), not from what was actually
enabled at device creation, so `VK_KHR_shader_float16_int8` and `VK_KHR_16bit_storage` must be
enabled here or roughly half the pipelines fail to create. It also needs
`shaderStorageImageReadWithoutFormat` / `WriteWithoutFormat`, because the RCAS pass declares
`GL_EXT_shader_image_load_formatted`.

## What breaks it

* A **driver change**: NVOFA negotiates `NV_OF_API_VERSION` with the display driver, exactly as
  `OPTIX.md` describes. Re-run a 30-frame encode after any driver change.
* **Deleting `/usr/lib/jellyfin-ffmpeg-oidn`**: the shim strips the node and the session plays
  unenhanced. Verified.
* **A FidelityFX-FSR2 update** that changes the permutation key order would silently mismatch
  `gen_perm.py`'s bit layout against `ffx_fsr2_shaders_vk.cpp`'s `POPULATE_PERMUTATION_KEY`. The
  bit order is asserted in a comment in `gen_perm.py`; check it against that macro after any bump.
