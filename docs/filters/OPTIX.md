# OptiX denoise levels, and what you have to fetch yourself to build them

`denoise=optix` and `denoise=optix-temporal` run the **NVIDIA OptiX AI denoiser** over the frame
before the upscale. Both are **advanced, opt-in levels**: off by default, not rungs of the
generated quality ladder, listed only in the dashboard dropdown and the player's Advanced row.

There is no `optix` filter in FFmpeg, upstream or anywhere else, so this repository carries one:
`ffmpeg/vf_optix.c`. The filter is our own code, LGPL-2.1-or-later like the rest of libavfilter,
and should apply cleanly to any FFmpeg 7.x/8.x tree. **The headers it needs are not in this
repository and cannot be** - see "Licensing" below.

## Why this exists at all, when OIDN already ships

OIDN 2.x is purely **spatial**: it judges each frame on its own. So is `nlmeans_vulkan`. So is the
OptiX LDR/HDR model. None of them can see inter-frame flicker, which is why `atadenoise` - a weak
filter by every quality measure - still holds the light rung: it is the only cheap thing here that
touches the time axis at all.

OptiX has had a **temporal** model for years. It takes the previous denoised frame plus a per-pixel
motion field, reprojects the former through the latter, and blends. That is an axis nothing else in
this plugin can reach, and it is the reason this was built.

Whether it *wins* on that axis is measured below, and the answer is not the flattering one.

## The shape: the same patched binary, one more filter

`vf_optix` is built into the **same** `/usr/lib/jellyfin-ffmpeg-oidn/ffmpeg` that carries
`vf_oidn`. One extra binary on the server, two filters, one thing that can break. The stock
`jellyfin-ffmpeg` is not modified, replaced or patched, and the ffmpeg shim
(`/usr/local/bin/jellyfin-ffmpeg-upscale`) picks between the two per invocation:

* command contains an `oidn` **or** `optix` filter node -> the patched binary,
* anything else -> the stock jellyfin-ffmpeg, untouched,
* either asked for but the patched binary missing or not executable -> the stock binary with the
  node **stripped out of the filter chain**, so that session plays without denoise instead of
  dying on an unknown filter name.

The shim's `PATCHED_FILTERS` tuple is the single list; `pick_binary()` reads it. Adding a third
filter to that build means adding one name there and nothing else.

## Where it sits in the chain

Same slot as `oidn` and `atadenoise`, on the **CPU side of `hwupload`**:

```
format=yuv420p,format=gbrpf32le,optix=mode=temporal,format=yuv420p,hwupload,libplacebo=...,hwdownload,format=yuv420p
```

`ShaderLibrary.DenoiseFilter()` routes on `_vulkan` in the filter string; `optix` carries none, so
the existing routing invariant puts it before `hwupload`, which is also where denoise belongs
because it must run before the upscale. The filter does its own CUDA work internally - it is a GPU
filter that happens to take host frames, exactly like `oidn`.

## The filter

| option | values | default | note |
|---|---|---|---|
| `mode` | `ldr`, `hdr`, `temporal` | `ldr` | `temporal` is the one that uses motion vectors |
| `flow` | `nvof`, `none` | `nvof` | `none` hands the temporal model a zero field, i.e. "nothing moved" |
| `blend` | 0..1 | `0` | 1 is the untouched input |
| `device` | int | `0` | CUDA device index |

Accepted pixel format is `gbrpf32le` only. Pack/unpack, luma extraction and flow expansion are
slice threaded; the denoise and the flow estimate run on the GPU.

### How it reaches OptiX without the SDK, and without the CUDA toolkit

* **OptiX is implemented in the display driver.** `optix_stubs.h` `dlopen()`s `libnvoptix.so.1` and
  pulls the function table out of it. Nothing from the SDK is linked or shipped.
* **The CUDA driver API** is loaded the way FFmpeg's own CUDA code loads it - nv-codec-headers'
  dynlink loader against `libcuda.so.1`. This build has no `nvcc` and needs none, because the
  filter writes no kernels of its own: every per-pixel conversion happens on the CPU, slice
  threaded, and only whole buffers cross the bus.
* The OptiX and Optical Flow headers both `#include <cuda.h>` purely for driver-API *types*.
  `ffmpeg/optix-compat/cuda.h` - our file, no NVIDIA code in it - points that include at
  `ffnvcodec/dynlink_cuda.h`, which removes a multi-gigabyte toolkit dependency from the build.

### How the motion field is produced, and why that way

**NVOFA**, the fixed-function optical flow engine present on Turing and later (this box is an
RTX 3090), reached by `dlopen()`ing `libnvidia-opticalflow.so.1`. Per frame the filter extracts an
8-bit luma plane, uploads it, runs `nvOFExecute` against the previous frame at
`NV_OF_PERF_LEVEL_FAST` on a 4x4 grid, downloads a grid of S10.5 fixed-point vectors, and expands
it to the dense `float2` field OptiX wants.

Why NVOFA and not a software estimator: it is separate silicon, so it costs neither SM time nor CPU
time; it needs no kernel of ours, which matters with no `nvcc`; and a *denoiser* needs only
approximate reprojection - where the flow is wrong the model falls back towards the spatial result
rather than smearing. This is emphatically not the exact sub-pixel jitter an
FSR2-style reconstruction would want, and which a transcoding pipeline cannot supply at all;
approximate flow is the whole requirement here.

Three things in that path were measured rather than assumed:

* **Sign.** NVOFA is run with `inputFrame` = current and `referenceFrame` = previous, so its vector
  points *back*; OptiX defines flow as movement from the previous frame to the current one, so the
  field is negated. Flipping the sign was built and measured: statTD 2.519 against 2.534, i.e. the
  sign does not visibly matter on this material, which is itself evidence that the field is
  contributing little. The correct convention is kept.
* **Perf level.** `NV_OF_PERF_LEVEL_SLOW` measured 2.497 against FAST's 2.519. The expensive
  setting buys nothing here, so FAST is used.
* **Luma prefilter.** A 3x3 box over the luma *before it reaches NVOFA* (the picture is not
  touched). Per-pixel noise is exactly what makes block matching return a wrong-but-confident
  vector. Worth 2.519 -> 2.489. Kept because it is nearly free, but it does not rescue the case.

## The measurement this was built to take

Metrics are the ones sessions 6-7 used, so the numbers are comparable:
**statTD** = mean absolute frame-to-frame change restricted to the pixels the ground truth holds
still. Movement where nothing moves is what flicker *is*, so that is the number.
**TCE** = how far the candidate's motion departs from the true motion; it is the guard against
buying stability by smearing. PSNR/SSIM/lap ride along to prove nothing was bought with blur.

Deployed chain (denoise -> FSRCNNX+RCAS -> 1280x720), 95 frames, scored against a clean 720p
ground truth. The low-resolution inputs are that ground truth downscaled and then degraded, so the
reference really is clean.

**On a grainy high-bitrate source** (`moving_q360n`, the material where any denoiser has something
to do):

| | PSNRy | SSIM | lap %GT | TCE | statTD | flicker |
|---|---|---|---|---|---|---|
| no denoise (control) | 28.41 | 0.7012 | 459% | 6.484 | 6.283 | - |
| `atadenoise` (the light rung) | 28.51 | 0.7108 | 448% | 6.157 | 5.853 | **-7%** |
| `oidn` high (spatial) | 30.28 | 0.9204 | 137% | 2.674 | 2.443 | **-61%** |
| `optix` ldr (spatial) | 30.03 | 0.9250 | 165% | 2.471 | 2.129 | **-66%** |
| `optix` temporal, zero flow | 29.36 | 0.9183 | 166% | 2.456 | 1.626 | **-74%** |
| `optix-temporal` (NVOFA flow) | 29.85 | 0.9079 | 182% | 2.867 | 2.489 | **-60%** |
| `optix-temporal` + `atadenoise` | 29.89 | 0.9093 | 182% | 2.796 | 2.389 | **-62%** |

**On a clean high-bitrate source** (`moving_q360` - no denoiser has anything to do here, which is
why the control wins; the row that matters is flow against no flow):

| | TCE | statTD |
|---|---|---|
| no denoise (control) | 0.686 | 0.321 |
| `atadenoise` | 0.970 | 0.432 |
| `optix` ldr | 0.677 | 0.323 |
| `optix` temporal, zero flow | 0.779 | 0.397 |
| `optix-temporal` (NVOFA flow) | 0.695 | **0.342** |

### What that says, plainly

1. **Against `atadenoise` the OptiX levels are not close.** On grain, `atadenoise` removes 7% of
   the flicker; every OptiX mode removes 60-74%. `atadenoise` keeps the light rung on cost, not on
   merit, and on clean material it *adds* 35% flicker.
2. **The temporal model does not beat the spatial one on this material.** -60% against -66%. The
   reason is visible in the two tables: the flow estimate is computed from the same noisy picture
   the denoiser is removing noise from, so on grain the field is partly garbage. Prefiltering the
   luma and paying for the slow perf level both moved it by about 1%.
3. **The reprojection is nevertheless wired up correctly, and that is proved on the clean source**,
   where the flow *is* estimable: statTD 0.342 with NVOFA flow against 0.397 with a zero field, and
   TCE 0.695 against 0.779. Flow helps whenever flow can be measured. It is the noise, not the
   plumbing, that defeats it.
4. **Zero flow is not the answer even though it wins one column.** -74% flicker at 29.36 dB and the
   worst TCE-per-dB of the set is the `tmix` trap recorded in `ShaderLibrary`: stability bought by
   averaging across motion. `flow=none` stays available for diagnosis and is not the default.

So: the level ships, named honestly, costed honestly, off by default and out of the ladder. It is
not promoted as a flicker cure, because on this library's material it is not one.

## Throughput

Deployed chain, 300 frames, 1280x720 CRF-20 source, shared GPU:

| target | off | atadenoise | **optix** | **optix-temporal** | oidn high |
|---|---|---|---|---|---|
| 1920x1080 | 120.5 fps | 107.8 | **49.9** | **39.6** | 35.7 |
| 2560x1440 | 107.4 fps | 100.1 | **49.4** | **38.1** | 34.7 |
| 3840x2160 | 64.5 fps | 65.1 | **40.9** | **33.1** | 29.7 |

OptiX spatial is about **1.4x faster than OIDN** and the temporal model about **1.1x**, at every
target. Like OIDN, it is the filter and not the scale that sets the rate. Against ordinary 24-30
fps material both OptiX levels clear realtime with room for one more session; against 47-60 fps
sources they do not. The menu's cost hints (`DENOISE_COST`) carry 3.6 and 4.5 against OIDN's 5.0,
placed on the same scale as the existing entries.

Denoiser working-set on the GPU, which matters on a card shared with a production pipeline: at
640x360, LDR is 11 MiB state + 31 MiB scratch; temporal is 18 + 57 MiB. It scales with pixel count,
so a 1280x720 source in temporal mode is roughly 4x that.

## Licensing - READ THIS, IT IS NOT LIKE OIDN

OIDN was Apache-2.0, code and weights, so `OIDN.md` could tell you to download a tarball and be
done. OptiX is **NVIDIA proprietary**.

* `ffmpeg/vf_optix.c` and `ffmpeg/optix-compat/cuda.h` are **our own code**, LGPL-2.1-or-later,
  and contain no NVIDIA material. They are published here.
* **No NVIDIA headers, binaries or SDK material are vendored into this repository, and none should
  be.** The OptiX headers are covered by the NVIDIA "Software Developer Kits, Samples and Tools
  License Agreement", which is not an open-source licence. You must obtain them yourself and accept
  that agreement yourself.
* The runtime is the NVIDIA display driver you already installed (`libnvoptix.so.1`,
  `libnvidia-opticalflow.so.1`). Nothing extra is installed or redistributed at run time.

### What you must fetch yourself

| what | from | licence |
|---|---|---|
| OptiX headers (`optix.h` and friends) | `https://github.com/NVIDIA/optix-dev`, tag `v8.1.0` | NVIDIA SDK/Samples/Tools EULA (`LICENSE.txt` in that repo). Publicly downloadable, **not** open source. Also obtainable from the OptiX SDK at `https://developer.nvidia.com/designworks/optix/download` |
| NVIDIA Optical Flow SDK headers (`nvOpticalFlowCommon.h`, `nvOpticalFlowCuda.h`) | `https://github.com/NVIDIA/NVIDIAOpticalFlowSDK`, branch `nvof_2_0_bsd` | 3-clause BSD on that branch. Still not vendored here, for consistency |
| nv-codec-headers | `https://github.com/FFmpeg/nv-codec-headers`, tag matching **your installed driver** | LGPL-2.1 |
| NVIDIA driver 450.51+ (Turing or later GPU) | you already have it | proprietary |

Everything else this build needs is already listed in `OIDN.md` (libplacebo, Vulkan headers, x264,
shaderc, and the OIDN runtime for the `oidn` filter in the same binary).

## Building it

Do `OIDN.md`'s steps 1-5 first; this adds to that same build. Then:

```bash
# OptiX headers - you fetch these, under NVIDIA's terms, and they stay out of the source tree
curl -LO https://codeload.github.com/NVIDIA/optix-dev/tar.gz/refs/tags/v8.1.0
tar xf v8.1.0                                   # -> optix-dev-8.1.0/include

# Optical Flow SDK headers (3-clause BSD branch)
curl -L -o nvof.tgz https://codeload.github.com/NVIDIA/NVIDIAOpticalFlowSDK/tar.gz/refs/heads/nvof_2_0_bsd
tar xf nvof.tgz                                 # -> NVIDIAOpticalFlowSDK-nvof_2_0_bsd/

cd ffmpeg-8.1.2
cp .../ffmpeg/vf_oidn.c  libavfilter/
cp .../ffmpeg/vf_optix.c libavfilter/
patch -p1 < .../ffmpeg/0001-add-oidn-filter-to-build.patch
patch -p1 < .../ffmpeg/0002-add-optix-filter-to-build.patch   # apply AFTER 0001

PKG_CONFIG_PATH=/usr/local/lib/x86_64-linux-gnu/pkgconfig ./configure \
  --prefix=/usr/lib/jellyfin-ffmpeg-oidn --disable-doc --disable-ffplay --disable-debug \
  --disable-htmlpages --disable-manpages --enable-gpl --enable-version3 \
  --enable-vulkan --enable-libplacebo --enable-libshaderc --enable-libx264 \
  --enable-ffnvcodec --enable-cuda --enable-cuvid --enable-nvdec --enable-nvenc \
  --enable-libopenimagedenoise --enable-libnvoptix --extra-libs="-lstdc++" \
  --extra-cflags="-I$OIDN/include \
                  -I.../ffmpeg/optix-compat \
                  -I$PWD/../optix-dev-8.1.0/include \
                  -I$PWD/../NVIDIAOpticalFlowSDK-nvof_2_0_bsd" \
  --extra-ldflags="-L$OIDN/lib -Wl,-rpath,/usr/lib/jellyfin-ffmpeg-oidn/oidn/lib"
make -j"$(nproc)"
install -D -m755 ffmpeg /usr/lib/jellyfin-ffmpeg-oidn/ffmpeg
```

The `optix-compat` include directory must come **before** any real CUDA toolkit include path, since
its whole job is to satisfy `#include <cuda.h>` without one.

`0002-add-optix-filter-to-build.patch` adds `libnvoptix` to `EXTERNAL_LIBRARY_LIST`,
`optix_filter_deps="libnvoptix ffnvcodec"`, a header-presence check (there is nothing to link -
both libraries are `dlopen()`ed), `-ldl`, the `vf_optix.o` Makefile rule and the `allfilters.c`
declaration.

Check it:

```bash
/usr/lib/jellyfin-ffmpeg-oidn/ffmpeg -h filter=optix
/usr/lib/jellyfin-ffmpeg-oidn/ffmpeg -v verbose -i in.mkv -frames:v 30 \
    -vf format=yuv420p,format=gbrpf32le,optix=mode=temporal,format=yuv420p -f null -
# expect: "NVOFA flow WxH on a ... grid" and "OptiX denoiser WxH mode=temporal flow=nvofa"
```

If NVOFA cannot be reached the filter logs a warning, falls back to a zero flow field and keeps
going; it does not fail the session.

## What breaks it

* **A `jellyfin-ffmpeg` upgrade** does not break it - the patched binary is separate and untouched
  by the package. What an upgrade can do is move Jellyfin's generated command on to options this
  build does not have, in which case OptiX and OIDN sessions fail while every other session is
  fine. Re-test `denoise=optix-temporal` after a major Jellyfin or jellyfin-ffmpeg upgrade.
* **A Jellyfin upgrade** that changes the Harmony patch targets disables the plugin's enhancement
  entirely, OptiX included. That is the plugin's existing failure mode, not a new one.
* **A driver upgrade is the new risk, and it is larger than OIDN's.** OptiX lives *in* the driver,
  so the filter's behaviour can change without anything here being rebuilt. `optixInit()` negotiates
  an ABI version against the driver; headers 8.1 are accepted by driver 595.84, but a driver old
  enough to predate that ABI will refuse, and the filter will log the OptiX error and fail
  `config_input`. NVOFA has its own version handshake (`NV_OF_API_VERSION`) with the same property.
  After a driver change, run the `-h filter=optix` and 30-frame temporal checks above.
* **A driver downgrade** below what the `nv-codec-headers` used at build time require makes the
  patched binary refuse to open the *encoder* - the same failure OIDN already has. Rebuild with the
  matching tag.
* **Deleting `/usr/lib/jellyfin-ffmpeg-oidn`** degrades gracefully: the shim strips the filter and
  those sessions play without denoise. Verified by moving the binary aside and replaying both
  levels.
