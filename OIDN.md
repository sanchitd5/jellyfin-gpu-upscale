# OIDN denoise level, and the separate ffmpeg build that carries it

`denoise=oidn` runs [Intel Open Image Denoise](https://github.com/RenderKit/oidn) (Apache-2.0,
code and weights) over the frame before the upscale. It is an **advanced, opt-in level**: it is
off by default, it is not a rung of the generated quality ladder, and on ordinary compressed
video it measures as a no-op. Read "When it is worth using" before switching it on.

There is no `oidn` filter in FFmpeg, upstream or anywhere else, and no maintained wrapper - so
this repository carries one: `ffmpeg/vf_oidn.c`. It is published here because it does not exist
elsewhere; it is LGPL-2.1-or-later like the rest of libavfilter and should apply cleanly to any
FFmpeg 7.x/8.x tree.

## The shape: a second binary, never the default one

> That binary now carries a second filter as well, `optix` (the NVIDIA OptiX AI denoiser, spatial
> and temporal) - see `OPTIX.md`. One extra build on the server, two filters. Everything below
> about routing, degradation and what an upgrade can break applies to both; the shim's
> `PATCHED_FILTERS` tuple is the single list of names that reach it.

The stock `jellyfin-ffmpeg` is **not** modified, replaced or patched. A separate build living at
`/usr/lib/jellyfin-ffmpeg-oidn/ffmpeg` carries the filter, and the ffmpeg shim
(`/usr/local/bin/jellyfin-ffmpeg-upscale`, which is already the binary Jellyfin is pointed at with
`--ffmpeg=`) picks between the two per invocation:

* command contains an `oidn` filter node  ->  the patched binary,
* anything else                            ->  the stock jellyfin-ffmpeg, untouched,
* `oidn` asked for but the patched binary missing or not executable  ->  the stock binary with the
  `oidn` node **stripped out of the filter chain**, i.e. that session plays without denoise
  instead of dying on an unknown filter name.

Why this way: a fork in the default path puts every playback on the server at the mercy of a
custom build and of every `jellyfin-ffmpeg` update. Scoped like this, a broken OIDN build costs
one opt-in feature, and nothing else on the server notices.

## Where it sits in the chain, and why not on the GPU

OIDN 2.x has CPU, CUDA, HIP, SYCL and Metal backends and **no Vulkan backend**. The plugin's chain
runs on Vulkan frames for libplacebo, so the filter cannot be handed the frames libplacebo works
on. It therefore runs on the **CPU side of `hwupload`**, in the same slot `atadenoise` uses:

```
format=yuv420p,format=gbrpf32le,oidn=quality=high:srgb=0,format=yuv420p,hwupload,libplacebo=...,hwdownload,format=yuv420p
```

This is decided by `ShaderLibrary.DenoiseFilter()`, which routes a filter string carrying
`_vulkan` to after `hwupload` and everything else to before it - the same routing invariant
`atadenoise` and `nlmeans_vulkan` already obey. Denoise runs before the upscale anyway, so the
CPU side is where it belongs. The alternative - after `hwupload`, with
`hwdownload,format=yuv420p,oidn,hwupload` around it - was built and measured rather than assumed:
three runs each at 720p -> 1440p gave 42/38/36 fps on the CPU side against 39/37/34 fps through the
extra round trip. That is about 5%, inside the run-to-run drift of a shared GPU, so the round trip
is not the reason; simplicity and a single `hwupload` boundary are. (`hwdownload` refuses to output
`gbrpf32le`, so that variant needs its own `format=yuv420p` after the download.)

The `format=gbrpf32le` / `format=yuv420p` nodes are part of the level on purpose: OIDN wants
interleaved float RGB, and writing the conversion explicitly keeps it visible in the built
command instead of leaving it to filter-graph negotiation.

## The filter

`vf_oidn.c` wraps OIDN's `RT` filter. Options:

| option | values | default | note |
|---|---|---|---|
| `quality` | `fast`, `balanced`, `high` | `high` | `balanced` measured indistinguishable from `high`; `fast` costs about 0.1 dB |
| `srgb` | bool | `0` | treats the input as linear. Measured marginally better than `srgb=1` on static content and marginally worse on moving - within noise either way |
| `hdr` | bool | `0` | linear HDR input; forces `srgb` off |
| `input_scale` | float | `0` (auto) | HDR input scale |
| `device` | `default`, `cpu`, `cuda` | `default` | `default` picks the best device present, which is CUDA on an NVIDIA box |

Accepted pixel format is `gbrpf32le` only. Pack/unpack to OIDN's interleaved layout is slice
threaded; the denoise itself runs on the OIDN device. If a non-CPU device cannot be created the
filter warns and falls back to CPU rather than failing the session.

## Building it

Needs the OIDN release tarball (no build, Intel ship an x86_64 Linux binary whose CUDA device
module drives an NVIDIA GPU as-is), a libplacebo new enough for the FFmpeg release, Vulkan headers
new enough for it, and `nv-codec-headers` matching **the installed driver** rather than the newest
tag - the newest one compiles fine and then refuses to open the encoder at runtime.

```bash
# 1. OIDN runtime (official upstream binary, Apache-2.0)
curl -LO https://github.com/RenderKit/oidn/releases/download/v2.5.1/oidn-2.5.1.x86_64.linux.tar.gz
tar xf oidn-2.5.1.x86_64.linux.tar.gz          # -> $OIDN

# 2. build deps
apt-get install -y --no-install-recommends nasm libvulkan-dev libx264-dev \
    libshaderc-dev git meson ninja-build python3-jinja2 python3-glad2

# 3. Vulkan headers >= 1.3.277 (distro ones are often older)
curl -L -o vh.tgz https://github.com/KhronosGroup/Vulkan-Headers/archive/refs/tags/v1.4.321.tar.gz
tar xf vh.tgz && cp -r Vulkan-Headers-*/include/{vulkan,vk_video} /usr/local/include/

# 4. libplacebo v7 (FFmpeg 8.x needs PL_ALPHA_NONE, absent from libplacebo 6.x)
git clone --recursive --depth 1 -b v7.351.0 https://code.videolan.org/videolan/libplacebo.git
meson setup libplacebo/build libplacebo --prefix=/usr/local --libdir=lib/x86_64-linux-gnu \
    --buildtype=release --default-library=static -Ddemos=false -Dvulkan=enabled \
    -Dshaderc=enabled -Dlcms=disabled -Dtests=false
ninja -C libplacebo/build install

# 5. nvenc headers MATCHING THE DRIVER (n13.0.19.1 for a 5xx driver; n13.1 wants 610+)
git clone https://github.com/FFmpeg/nv-codec-headers.git
git -C nv-codec-headers checkout n13.0.19.1
make -C nv-codec-headers install PREFIX=/usr/local

# 6. FFmpeg with the filter
curl -LO https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz && tar xf ffmpeg-8.1.2.tar.xz
cd ffmpeg-8.1.2
cp .../ffmpeg/vf_oidn.c libavfilter/
#   configure : add libopenimagedenoise to EXTERNAL_LIBRARY_LIST,
#               oidn_filter_deps="libopenimagedenoise",
#               enabled libopenimagedenoise && require libopenimagedenoise \
#                   OpenImageDenoise/oidn.h oidnNewDevice -lOpenImageDenoise
#   libavfilter/Makefile   : OBJS-$(CONFIG_OIDN_FILTER) += vf_oidn.o
#   libavfilter/allfilters.c: extern const FFFilter ff_vf_oidn;
PKG_CONFIG_PATH=/usr/local/lib/x86_64-linux-gnu/pkgconfig ./configure \
  --prefix=/usr/lib/jellyfin-ffmpeg-oidn --disable-doc --disable-ffplay --disable-debug \
  --disable-htmlpages --disable-manpages --enable-gpl --enable-version3 \
  --enable-vulkan --enable-libplacebo --enable-libshaderc --enable-libx264 \
  --enable-ffnvcodec --enable-cuda --enable-cuvid --enable-nvdec --enable-nvenc \
  --enable-libopenimagedenoise --extra-libs="-lstdc++" \
  --extra-cflags="-I$OIDN/include" \
  --extra-ldflags="-L$OIDN/lib -Wl,-rpath,/usr/lib/jellyfin-ffmpeg-oidn/oidn/lib"
make -j"$(nproc)"

# 7. install: the binary, plus the OIDN runtime it rpaths to
install -D -m755 ffmpeg /usr/lib/jellyfin-ffmpeg-oidn/ffmpeg
mkdir -p /usr/lib/jellyfin-ffmpeg-oidn/oidn/lib
cp -a $OIDN/lib/libOpenImageDenoise{,_core,_device_cpu,_device_cuda}.so* \
      $OIDN/lib/libtbb{,bind,bind_2_0,bind_2_5}.so* /usr/lib/jellyfin-ffmpeg-oidn/oidn/lib/
```

Result: one ~32 MB binary plus ~56 MB of OIDN runtime. The build tree is a few hundred MB and can
be deleted afterwards - libplacebo is linked statically, so nothing under `/usr/local` is needed at
run time. The binary does still need these shared libraries from the distribution, which must stay
installed: `libshaderc1`, `libvulkan1`, `libx264-164`, `libxcb1`, plus the OIDN runtime it rpaths
to. `ldd` on the binary is the authority.

Check it:

```bash
/usr/lib/jellyfin-ffmpeg-oidn/ffmpeg -h filter=oidn
```

## When it is worth using

Honestly: rarely.

* On a **genuinely grainy, high-bitrate** source OIDN is the best denoiser measured on this
  project by a wide margin - it recovers 74-86% of the fidelity lost to noise where
  `nlmeans_vulkan=s=2.0` recovers 34-53% and `atadenoise` 4-6%, and it does that **without
  over-smoothing**: detail energy lands within a few points of the clean-source ceiling, where
  nlmeans and hqdn3d visibly eat real detail.
* On **ordinary compressed video** it does nothing, because there is nothing left to remove. On a
  CRF-26 source it measured within 0.01 dB of a no-op control; on a native capture it changed
  detail energy by 0.8%. Every other denoiser measures the same way on that material.

Measured in the deployed chain on a real 1280x720 source, 47 fps, three upscale targets:

| target | denoise off | atadenoise | nlmeans_vulkan | **oidn high** | oidn fast |
|---|---|---|---|---|---|
| 1920x1080 | 266 fps | 189 | 67 | **42** | - |
| 2560x1440 | 200 fps | 149 | 65 | **36** | 46 |
| 3840x2160 | 94 fps  | 88  | 51 | **34** | - |

A separate control run proves the second binary is not itself a regression: with denoise off it
measured 264/200/96 fps against the stock binary's 266/200/94.

So OIDN sustains roughly 34-46 output fps whatever the target - it is the filter, not the scale,
that sets the rate. Against these 47-60 fps webcam sources that is **below realtime for a single
session** (0.78-0.95x). Against ordinary 24-30 fps material it would clear realtime with no room
for a second session. It is also the most expensive level offered by a wide margin. That combination - large cost, zero measured benefit
on typical content, real benefit on atypical content - is exactly why it is reachable by name and
in Advanced, and never selected for anyone automatically.

## What breaks it

* **A `jellyfin-ffmpeg` upgrade** does not break it: the patched binary is separate and is not
  touched by the package. What an upgrade can do is move Jellyfin's generated command on to
  options this build does not have, in which case OIDN sessions fail while every other session is
  fine. Re-test `denoise=oidn` after a major Jellyfin or jellyfin-ffmpeg upgrade.
* **A Jellyfin upgrade** that changes the Harmony patch targets disables the plugin's enhancement
  entirely, OIDN included; that is the plugin's existing failure mode, not a new one.
* **An NVIDIA driver downgrade** below what the `nv-codec-headers` used at build time require
  makes the patched binary refuse to open the encoder. Rebuild with the matching tag.
* **Deleting `/usr/lib/jellyfin-ffmpeg-oidn`** degrades gracefully: the shim strips the filter and
  those sessions play without denoise.
