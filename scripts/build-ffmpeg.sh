#!/usr/bin/env bash
# build-ffmpeg.sh — build the patched FFmpeg carrying this project's custom filters.
#
# WHY A SCRIPT AND NOT A BINARY
# The resulting binary cannot be redistributed. It is built --enable-gpl --enable-libx264, so it is
# GPLv2+, and it links Intel Open Image Denoise, which is Apache-2.0 — a licence GPLv2 is not
# compatible with. Building it for your own use carries no such obligation; publishing it would.
# The OptiX path additionally sits under NVIDIA's EULA. So: source and a script, never an artifact.
#
# WHAT IT PRODUCES
#   <prefix>/ffmpeg   — FFmpeg 8.1.2 plus vf_oidn and, each opt-in, vf_optix, vf_ort, vf_fsr2, vf_dlss
#   <prefix>/oidn/    — the OIDN runtime the binary rpaths to, if OIDN was enabled
#   <prefix>/ort/lib  — the ONNX Runtime the binary rpaths to, if ORT was enabled
#
# The stock jellyfin-ffmpeg is never touched. This binary lives beside it and the plugin's shim
# routes to it only for sessions that ask for a filter it alone provides.
#
# Every WITH_* below defaults to OFF except WITH_OIDN, so a machine holding none of the SDKs still
# builds. scripts/proxmox-build.sh refuses to deploy a binary missing any of the five filters, so
# a full deploy needs all five switched on with their SDKs in place.
#
# USAGE
#   sudo ./scripts/build-ffmpeg.sh                     # OIDN only (default)
#   WITH_OPTIX=1 OPTIX_SDK=/path/to/optix-dev \
#        NVOF_SDK=/path/to/NVIDIAOpticalFlowSDK \
#        sudo -E ./scripts/build-ffmpeg.sh             # OIDN + OptiX
#   WITH_OPTIX=1 WITH_ORT=1 WITH_FSR2=1 WITH_DLSS=1 \
#        sudo -E ./scripts/build-ffmpeg.sh             # all five, SDK paths defaulted below
#   PREFIX=/usr/lib/my-ffmpeg sudo -E ./scripts/build-ffmpeg.sh
#
# The build patches stack in order (0001 oidn, 0002 optix, 0003 ort, 0004 fsr2+dlss), each patching
# context the previous one added, so the later options require the earlier ones.
#
# WHAT YOU MUST OBTAIN YOURSELF (nothing proprietary is vendored in this repo, and nothing here
# downloads any of it)
#   WITH_OPTIX  OPTIX_SDK  optix.h                github.com/NVIDIA/optix-dev, tag v8.1.0
#                                                 NVIDIA EULA, not open source.  See OPTIX.md.
#               NVOF_SDK   nvOpticalFlowCuda.h    github.com/NVIDIA/NVIDIAOpticalFlowSDK,
#                                                 branch nvof_2_0_bsd.  BSD-3.  Also needed by
#                                                 WITH_FSR2 and WITH_DLSS.
#   WITH_ORT    ORT_SDK    onnxruntime_c_api.h    ONNX Runtime GPU release tarball, MIT.
#                                                 The CUDA libraries beside it are staged by hand;
#                                                 see NEURAL.md.
#   WITH_FSR2   FSR2_SDK   ffx_fsr2.h             github.com/GPUOpen-Effects/FidelityFX-FSR2, MIT
#               FSR2_LIB   libffx_fsr2_vk.a       built out of tree: upstream's shader compiler is a
#                                                 Windows .exe, so ffmpeg/gen_perm.py replaces it.
#                                                 FSR2.md has the exact steps; they are not run here.
#   WITH_DLSS   NGX_SDK    nvsdk_ngx_vk.h         github.com/NVIDIA/DLSS, NVIDIA proprietary
#               NGX_LIB    libnvsdk_ngx.a         same repo, lib/Linux_x86_64.  The DLSS runtime blob
#                                                 is installed by hand under <prefix>/dlss; see
#                                                 DLSS.md.

set -euo pipefail

FFMPEG_VER="${FFMPEG_VER:-8.1.2}"
PREFIX="${PREFIX:-/usr/lib/jellyfin-ffmpeg-oidn}"
BUILD="${BUILD:-$(mktemp -d)}"
WITH_OIDN="${WITH_OIDN:-1}"
WITH_OPTIX="${WITH_OPTIX:-0}"
WITH_ORT="${WITH_ORT:-0}"
WITH_FSR2="${WITH_FSR2:-0}"
WITH_DLSS="${WITH_DLSS:-0}"

# Defaults are where these SDKs were unpacked on the build box. Nothing fetches them; a wrong path
# fails in preflight naming the variable rather than 20 minutes into a compile.
ORT_SDK="${ORT_SDK:-/root/gameupscale}"
# The ONNX Runtime headers and its shared libraries need not sit together, and on the build box
# they do not: only the headers were kept beside the other SDKs, while the runtime was unpacked
# into the prefix the finished binary rpaths to. Pointing -L at $ORT_SDK/lib is what made configure
# report "libonnxruntime not found" after installing every build dependency.
#
# The default therefore links against the prefix, which means linking against this script's own
# install destination. That is not ideal and it is deliberate: the release tarball is no longer on
# that box, so the staged runtime is the only copy there is. Point ORT_LIB at an unpacked tarball's
# lib/ instead wherever you have one, and the install step below will stage it into the prefix as
# it was always meant to.
ORT_LIB="${ORT_LIB:-${PREFIX}/ort/lib}"
FSR2_SDK="${FSR2_SDK:-/root/gameupscale/fsr2/src/ffx-fsr2-api}"
# The archive lands wherever FSR2.md's out-of-tree build put it, which is not beside the sources.
FSR2_LIB="${FSR2_LIB:-/root/gameupscale/lib}"
NGX_SDK="${NGX_SDK:-/root/gameupscale/dlss}"
NGX_LIB="${NGX_LIB:-${NGX_SDK}/lib/Linux_x86_64}"
NVOF_SDK="${NVOF_SDK:-/root/gameupscale/NVIDIAOpticalFlowSDK-nvof_2_0_bsd}"
OIDN_VER="${OIDN_VER:-2.5.1}"
LIBPLACEBO_TAG="${LIBPLACEBO_TAG:-v7.351.0}"
KEEP_BUILD="${KEEP_BUILD:-0}"

# nv-codec-headers must match the INSTALLED DRIVER, not the newest tag. A newer tag compiles and then
# refuses to open the encoder at runtime. n13.0.19.1 is correct for driver 595.x; check the upstream
# README's driver table if yours differs.
NVCODEC_TAG="${NVCODEC_TAG:-n13.0.19.1}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say () { printf '\n== %s\n' "$*"; }
die () { printf '!! %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root: it installs build deps and writes to ${PREFIX}"

# --- preflight ------------------------------------------------------------------------------------
free_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
(( free_gb >= 12 )) || die "need ~12G free for the build tree, have ${free_gb}G"
say "disk: ${free_gb}G free"

if [[ "$WITH_OPTIX" == "1" ]]; then
    [[ -n "${OPTIX_SDK:-}" && -f "$OPTIX_SDK/include/optix.h" ]] \
        || die "WITH_OPTIX=1 needs OPTIX_SDK=/path/to/optix-dev (see OPTIX.md)"
    [[ -n "${NVOF_SDK:-}" ]] \
        || die "WITH_OPTIX=1 needs NVOF_SDK=/path/to/NVIDIAOpticalFlowSDK (see OPTIX.md)"
fi

# The patches stack: 0003 patches lines 0002 added, 0004 patches lines 0003 added. Enforced here
# because `patch` would otherwise fail after the dependencies were already installed.
if [[ "$WITH_FSR2" == "1" || "$WITH_DLSS" == "1" ]]; then
    [[ "$WITH_ORT" == "1" ]] \
        || die "WITH_FSR2/WITH_DLSS need WITH_ORT=1: patch 0004 applies on top of 0003"
fi
if [[ "$WITH_ORT" == "1" ]]; then
    [[ "$WITH_OPTIX" == "1" ]] \
        || die "WITH_ORT=1 needs WITH_OPTIX=1: patch 0003 applies on top of 0002"
    [[ -f "$ORT_SDK/include/onnxruntime_c_api.h" ]] \
        || die "WITH_ORT=1: no onnxruntime_c_api.h under ORT_SDK=$ORT_SDK/include (see NEURAL.md)"
    # The library, not merely a directory: the headers and the runtime are unpacked separately,
    # and a lib/ holding something else entirely still passed this check while configure went on
    # to fail with "libonnxruntime not found" twenty lines later.
    [[ -f "$ORT_LIB/libonnxruntime.so" ]] \
        || die "WITH_ORT=1: no libonnxruntime.so under ORT_LIB=$ORT_LIB (see NEURAL.md)"
fi

# vf_fsr2 and vf_dlss both pull in gu_inputs.h, which includes the Optical Flow headers.
if [[ "$WITH_FSR2" == "1" || "$WITH_DLSS" == "1" ]]; then
    [[ -n "${NVOF_SDK:-}" ]] \
        || die "WITH_FSR2/WITH_DLSS need NVOF_SDK=/path/to/NVIDIAOpticalFlowSDK (see FSR2.md)"
fi

# The headers sit in NvOFInterface/ in a git checkout and at the root of an unpacked release, so
# resolve it once here rather than guessing one layout and failing the compile on the other.
NVOF_INC=""
if [[ -n "${NVOF_SDK:-}" ]]; then
    if [[ -f "$NVOF_SDK/NvOFInterface/nvOpticalFlowCuda.h" ]]; then
        NVOF_INC="$NVOF_SDK/NvOFInterface"
    elif [[ -f "$NVOF_SDK/nvOpticalFlowCuda.h" ]]; then
        NVOF_INC="$NVOF_SDK"
    elif [[ "$WITH_OPTIX" == "1" || "$WITH_FSR2" == "1" || "$WITH_DLSS" == "1" ]]; then
        die "no nvOpticalFlowCuda.h under NVOF_SDK=$NVOF_SDK, in the root or in NvOFInterface/"
    fi
fi
if [[ "$WITH_FSR2" == "1" ]]; then
    [[ -f "$FSR2_SDK/ffx_fsr2.h" ]] \
        || die "WITH_FSR2=1: no ffx_fsr2.h under FSR2_SDK=$FSR2_SDK (see FSR2.md)"
    [[ -f "$FSR2_LIB/libffx_fsr2_vk.a" ]] \
        || die "WITH_FSR2=1: no libffx_fsr2_vk.a under FSR2_LIB=$FSR2_LIB; build it first, FSR2.md has the steps"
fi
if [[ "$WITH_DLSS" == "1" ]]; then
    [[ -f "$NGX_SDK/include/nvsdk_ngx_vk.h" ]] \
        || die "WITH_DLSS=1: no nvsdk_ngx_vk.h under NGX_SDK=$NGX_SDK/include (see DLSS.md)"
    [[ -f "$NGX_LIB/libnvsdk_ngx.a" ]] \
        || die "WITH_DLSS=1: no libnvsdk_ngx.a under NGX_LIB=$NGX_LIB (see DLSS.md)"
fi

say "installing build dependencies"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
    build-essential git curl ca-certificates pkg-config nasm yasm meson ninja-build \
    python3 libx264-dev libxcb1-dev libvulkan-dev libshaderc-dev glslang-tools >/dev/null

cleanup () { [[ "$KEEP_BUILD" == "1" ]] || rm -rf "$BUILD"; }
trap cleanup EXIT

# mktemp -d already made its own directory; this is here for a caller-supplied BUILD.
mkdir -p "$BUILD"
cd "$BUILD"

# --- vulkan headers -------------------------------------------------------------------------------
# FFmpeg 8.x wants >= 1.3.277; Ubuntu noble ships 1.3.275.
say "vulkan headers"
git clone --depth 1 -b v1.3.280 https://github.com/KhronosGroup/Vulkan-Headers.git >/dev/null 2>&1
cp -r Vulkan-Headers/include/vulkan /usr/local/include/
cp -r Vulkan-Headers/include/vk_video /usr/local/include/ 2>/dev/null || true

# --- libplacebo -----------------------------------------------------------------------------------
# FFmpeg 8.x needs PL_ALPHA_NONE, absent from libplacebo 6.x (which is what distros ship).
say "libplacebo ${LIBPLACEBO_TAG} (static)"
git clone --recursive --depth 1 -b "$LIBPLACEBO_TAG" \
    https://code.videolan.org/videolan/libplacebo.git >/dev/null 2>&1
meson setup libplacebo/build libplacebo --prefix=/usr/local --libdir=lib/x86_64-linux-gnu \
    --default-library=static -Dvulkan=enabled -Dshaderc=enabled -Ddemos=false >/dev/null
ninja -C libplacebo/build install >/dev/null

# --- nv-codec-headers -----------------------------------------------------------------------------
say "nv-codec-headers ${NVCODEC_TAG} (must match the installed driver)"
git clone -q https://github.com/FFmpeg/nv-codec-headers.git
git -C nv-codec-headers checkout -q "$NVCODEC_TAG"
make -C nv-codec-headers install PREFIX=/usr/local >/dev/null

# --- OIDN runtime ---------------------------------------------------------------------------------
OIDN_FLAGS=()
if [[ "$WITH_OIDN" == "1" ]]; then
    say "Intel Open Image Denoise ${OIDN_VER} (Apache-2.0, official binary with the CUDA module)"
    oidn_tar="oidn-${OIDN_VER}.x86_64.linux.tar.gz"
    curl -fsSL -o "$oidn_tar" \
        "https://github.com/RenderKit/oidn/releases/download/v${OIDN_VER}/${oidn_tar}"
    tar xzf "$oidn_tar"
    oidn_dir="$BUILD/oidn-${OIDN_VER}.x86_64.linux"
    [[ -f "$oidn_dir/include/OpenImageDenoise/oidn.h" ]] || die "OIDN unpacked unexpectedly"
    export PKG_CONFIG_PATH="/usr/local/lib/x86_64-linux-gnu/pkgconfig:${PKG_CONFIG_PATH:-}"
    export CFLAGS="-I${oidn_dir}/include ${CFLAGS:-}"
    export LDFLAGS="-L${oidn_dir}/lib -Wl,-rpath,${PREFIX}/oidn/lib ${LDFLAGS:-}"
    OIDN_FLAGS=(--enable-libopenimagedenoise)
fi

# --- ffmpeg ---------------------------------------------------------------------------------------
say "FFmpeg ${FFMPEG_VER}"
curl -fsSL -o "ffmpeg-${FFMPEG_VER}.tar.xz" "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VER}.tar.xz"
tar xf "ffmpeg-${FFMPEG_VER}.tar.xz"
cd "ffmpeg-${FFMPEG_VER}"

say "applying filter patches"
cp "$HERE/ffmpeg/vf_oidn.c" libavfilter/
patch -p1 < "$HERE/ffmpeg/0001-add-oidn-filter-to-build.patch"

OPTIX_FLAGS=()
if [[ "$WITH_OPTIX" == "1" ]]; then
    cp "$HERE/ffmpeg/vf_optix.c" libavfilter/
    mkdir -p libavfilter/optix-compat
    cp "$HERE"/ffmpeg/optix-compat/* libavfilter/optix-compat/
    patch -p1 < "$HERE/ffmpeg/0002-add-optix-filter-to-build.patch"
    # OptiX and NVOFA are dlopen()ed from the display driver at runtime; only headers are needed to
    # build, and no CUDA toolkit is required because the filter writes no kernels.
    export CFLAGS="-I${OPTIX_SDK}/include -I${NVOF_INC} -Ilibavfilter/optix-compat ${CFLAGS:-}"
    OPTIX_FLAGS=(--enable-libnvoptix)
fi

ORT_FLAGS=()
if [[ "$WITH_ORT" == "1" ]]; then
    cp "$HERE/ffmpeg/vf_ort.c" libavfilter/
    patch -p1 < "$HERE/ffmpeg/0003-add-ort-filter-to-build.patch"
    # rpath, not -L, decides what the installed binary loads: the runtime tree is staged under
    # PREFIX and the build copy of it may not survive this script.
    export CFLAGS="-I${ORT_SDK}/include ${CFLAGS:-}"
    export LDFLAGS="-L${ORT_LIB} -Wl,-rpath,${PREFIX}/ort/lib ${LDFLAGS:-}"
    ORT_FLAGS=(--enable-libonnxruntime)
fi

GAME_FLAGS=()
if [[ "$WITH_FSR2" == "1" || "$WITH_DLSS" == "1" ]]; then
    cp "$HERE/ffmpeg/gu_inputs.h" libavfilter/
    if [[ "$WITH_FSR2" == "1" ]]; then cp "$HERE/ffmpeg/vf_fsr2.c" libavfilter/; fi
    if [[ "$WITH_DLSS" == "1" ]]; then cp "$HERE/ffmpeg/vf_dlss.c" libavfilter/; fi
    patch -p1 < "$HERE/ffmpeg/0004-add-fsr2-and-dlss-filters-to-build.patch"
    export CFLAGS="-I${NVOF_INC} ${CFLAGS:-}"
    if [[ "$WITH_FSR2" == "1" ]]; then
        # Without -DFFX_GCC, ffx_types.h defines FFX_API as __declspec(dllexport) and every FSR2
        # header fails to parse.
        export CFLAGS="-DFFX_GCC -I${FSR2_SDK} ${CFLAGS:-}"
        export LDFLAGS="-L${FSR2_LIB} ${LDFLAGS:-}"
        GAME_FLAGS+=(--enable-libffxfsr2)
    fi
    if [[ "$WITH_DLSS" == "1" ]]; then
        # libnvsdk_ngx.a is static, so no rpath: only the DLSS feature blob is loaded at runtime,
        # and that is installed by hand under PREFIX/dlss.
        export CFLAGS="-I${NGX_SDK}/include ${CFLAGS:-}"
        export LDFLAGS="-L${NGX_LIB} ${LDFLAGS:-}"
        GAME_FLAGS+=(--enable-libngx)
    fi
fi

say "configure"
PKG_CONFIG_PATH="/usr/local/lib/x86_64-linux-gnu/pkgconfig:${PKG_CONFIG_PATH:-}" ./configure \
    --prefix="$PREFIX" \
    --disable-doc --disable-htmlpages --disable-manpages \
    --enable-gpl --enable-version3 \
    --enable-vulkan --enable-libplacebo --enable-libshaderc --enable-libx264 \
    --enable-ffnvcodec --enable-cuda --enable-cuvid --enable-nvdec --enable-nvenc \
    "${OIDN_FLAGS[@]}" "${OPTIX_FLAGS[@]}" "${ORT_FLAGS[@]}" "${GAME_FLAGS[@]}" \
    --extra-libs="-lstdc++"

say "make -j$(nproc)"
make -j"$(nproc)" >/dev/null

# --- install ----------------------------------------------------------------------------------------
say "installing to ${PREFIX}"
mkdir -p "$PREFIX"
install -m 0755 ffmpeg "$PREFIX/ffmpeg"

if [[ "$WITH_OIDN" == "1" ]]; then
    mkdir -p "$PREFIX/oidn"
    cp -r "$oidn_dir/lib" "$PREFIX/oidn/"
fi

if [[ "$WITH_ORT" == "1" ]]; then
    # Only the ONNX Runtime libraries themselves, and only if absent: the CUDA and cuDNN libraries
    # beside them come from NVIDIA's wheels by hand, and libonnxruntime_providers_cuda.so gets a
    # patchelf rpath fix there which overwriting would undo. NEURAL.md has both.
    mkdir -p "$PREFIX/ort/lib"
    # Nothing to stage when the runtime is already the thing we linked against, which is the case
    # on a box where the release tarball was unpacked straight into the prefix and only its headers
    # were kept beside the other SDKs.
    if [[ "$(cd "$ORT_LIB" && pwd -P)" != "$(cd "$PREFIX/ort/lib" && pwd -P)" ]]; then
        for lib in "$ORT_LIB"/libonnxruntime*; do
            [[ -e "$lib" ]] || continue
            [[ -e "$PREFIX/ort/lib/$(basename "$lib")" ]] || cp -a "$lib" "$PREFIX/ort/lib/"
        done
    fi
fi

if [[ "$WITH_DLSS" == "1" && ! -d "$PREFIX/dlss" ]]; then
    say "note: $PREFIX/dlss is missing, so the dlss and dlaa levels will not be offered (DLSS.md)"
fi

say "verifying"
"$PREFIX/ffmpeg" -hide_banner -filters 2>/dev/null | grep -E "\boidn\b" \
    && echo "  oidn: present" || die "oidn filter missing from the build"
if [[ "$WITH_OPTIX" == "1" ]]; then
    "$PREFIX/ffmpeg" -hide_banner -filters 2>/dev/null | grep -E "\boptix\b" \
        && echo "  optix: present" || die "optix filter missing from the build"
fi
if [[ "$WITH_ORT" == "1" ]]; then
    "$PREFIX/ffmpeg" -hide_banner -filters 2>/dev/null | grep -E "\bort\b" \
        && echo "  ort: present" || die "ort filter missing from the build"
fi
if [[ "$WITH_FSR2" == "1" ]]; then
    "$PREFIX/ffmpeg" -hide_banner -filters 2>/dev/null | grep -E "\bfsr2\b" \
        && echo "  fsr2: present" || die "fsr2 filter missing from the build"
fi
if [[ "$WITH_DLSS" == "1" ]]; then
    "$PREFIX/ffmpeg" -hide_banner -filters 2>/dev/null | grep -E "\bdlss\b" \
        && echo "  dlss: present" || die "dlss filter missing from the build"
fi

cat <<EOF

Built: ${PREFIX}/ffmpeg

The plugin's shim routes to this binary only for sessions requesting a filter it alone provides;
everything else keeps using the stock jellyfin-ffmpeg. If this binary is deleted the plugin strips
the affected filter from the chain, so those sessions play unenhanced rather than failing.

Re-run this after an NVIDIA driver change if the OptiX, FSR2 or DLSS levels stop working: OptiX,
NVOFA and NGX all negotiate against the driver at runtime, which no rebuild here controls.
EOF
