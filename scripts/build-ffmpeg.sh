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
#   <prefix>/ffmpeg   — FFmpeg 8.1.2 plus vf_oidn and (optionally) vf_optix
#   <prefix>/oidn/    — the OIDN runtime the binary rpaths to, if OIDN was enabled
#
# The stock jellyfin-ffmpeg is never touched. This binary lives beside it and the plugin's shim
# routes to it only for sessions that ask for a filter it alone provides.
#
# USAGE
#   sudo ./scripts/build-ffmpeg.sh                     # OIDN only (default)
#   WITH_OPTIX=1 OPTIX_SDK=/path/to/optix-dev \
#        NVOF_SDK=/path/to/NVIDIAOpticalFlowSDK \
#        sudo -E ./scripts/build-ffmpeg.sh             # OIDN + OptiX
#   PREFIX=/usr/lib/my-ffmpeg sudo -E ./scripts/build-ffmpeg.sh
#
# WHAT YOU MUST OBTAIN YOURSELF (nothing proprietary is vendored in this repo)
#   OptiX headers            github.com/NVIDIA/optix-dev, tag v8.1.0   NVIDIA EULA, not open source
#   Optical Flow SDK headers github.com/NVIDIA/NVIDIAOpticalFlowSDK, branch nvof_2_0_bsd   BSD-3
# Both are only needed with WITH_OPTIX=1. See OPTIX.md.

set -euo pipefail

FFMPEG_VER="${FFMPEG_VER:-8.1.2}"
PREFIX="${PREFIX:-/usr/lib/jellyfin-ffmpeg-oidn}"
BUILD="${BUILD:-/tmp/ffbuild.$$}"
WITH_OIDN="${WITH_OIDN:-1}"
WITH_OPTIX="${WITH_OPTIX:-0}"
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

say "installing build dependencies"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
    build-essential git curl ca-certificates pkg-config nasm yasm meson ninja-build \
    python3 libx264-dev libxcb1-dev libvulkan-dev libshaderc-dev glslang-tools >/dev/null

mkdir -p "$BUILD"
cleanup () { [[ "$KEEP_BUILD" == "1" ]] || rm -rf "$BUILD"; }
trap cleanup EXIT

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
    export CFLAGS="-I${OPTIX_SDK}/include -I${NVOF_SDK}/NvOFInterface -Ilibavfilter/optix-compat ${CFLAGS:-}"
    OPTIX_FLAGS=(--enable-liboptix)
fi

say "configure"
PKG_CONFIG_PATH="/usr/local/lib/x86_64-linux-gnu/pkgconfig:${PKG_CONFIG_PATH:-}" ./configure \
    --prefix="$PREFIX" \
    --disable-doc --disable-htmlpages --disable-manpages \
    --enable-gpl --enable-version3 \
    --enable-vulkan --enable-libplacebo --enable-libshaderc --enable-libx264 \
    --enable-ffnvcodec --enable-cuda --enable-cuvid --enable-nvdec --enable-nvenc \
    "${OIDN_FLAGS[@]}" "${OPTIX_FLAGS[@]}" \
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

say "verifying"
"$PREFIX/ffmpeg" -hide_banner -filters 2>/dev/null | grep -E "\boidn\b" \
    && echo "  oidn: present" || die "oidn filter missing from the build"
if [[ "$WITH_OPTIX" == "1" ]]; then
    "$PREFIX/ffmpeg" -hide_banner -filters 2>/dev/null | grep -E "\boptix\b" \
        && echo "  optix: present" || die "optix filter missing from the build"
fi

cat <<EOF

Built: ${PREFIX}/ffmpeg

The plugin's shim routes to this binary only for sessions requesting a filter it alone provides;
everything else keeps using the stock jellyfin-ffmpeg. If this binary is deleted the plugin strips
the affected filter from the chain, so those sessions play unenhanced rather than failing.

Re-run this after an NVIDIA driver change if the OptiX levels stop working: OptiX negotiates an ABI
against the driver at runtime, which no rebuild here controls.
EOF
