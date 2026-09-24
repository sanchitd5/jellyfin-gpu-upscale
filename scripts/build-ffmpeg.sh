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
# The build patches stack in order (0001 oidn, 0002 optix, 0003 ort, 0004 fsr2+dlss, 0005 vsr), each
# patching context the previous one added, so the later options require the earlier ones. vf_vsr.c
# itself has no CODE dependency on optix/ort/fsr2/dlss (it is a standalone new file, pure CUDA, no
# shared plumbing) - but its patch (0005) was written against the tree state with 0001-0004 already
# applied, because that is what this project's own production build (proxmox-build.sh) always
# produces: every WITH_* defaults to 1 there. WITH_MAXINE_VSR=1 therefore requires the same four SDKs
# WITH_DLSS already requires, purely as a build-mechanics constraint, not a functional one.
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
#   WITH_MAXINE_VSR    VFXSDK_DIR nvVideoEffects.h,      Headers only, from the NGC SDK Core package and the
#               VFXVSR_DIR nvVFXVideoSuperRes.h,  nvvfxvideosuperres feature package (NGC, gated behind
#                                                  an NVIDIA Developer Program login - not fetchable by
#                                                  this script).  NVIDIA proprietary.
#               VFXLIBS_DIR libVideoFX.so,        The actual runtime: a straight copy of the
#                           libnvinfer.so.10, ...  `nvvfx/libs/` folder inside NVIDIA's own `nvidia-vfx`
#                                                  PyPI wheel - fetchable with no NGC login at all
#                                                  (`pip download --extra-index-url
#                                                  https://pypi.nvidia.com/ nvidia-vfx`).  This is not
#                                                  a shortcut: it is the confirmed-working combination,
#                                                  including TensorRT (libnvinfer.so.10 and friends),
#                                                  which CreateEffect silently requires and the NGC SDK
#                                                  Core download never mentions.  See VSR.md.

set -euo pipefail

FFMPEG_VER="${FFMPEG_VER:-8.1.2}"
PREFIX="${PREFIX:-/usr/lib/jellyfin-ffmpeg-oidn}"
BUILD="${BUILD:-$(mktemp -d)}"
WITH_OIDN="${WITH_OIDN:-1}"
WITH_OPTIX="${WITH_OPTIX:-0}"
WITH_ORT="${WITH_ORT:-0}"
WITH_FSR2="${WITH_FSR2:-0}"
WITH_DLSS="${WITH_DLSS:-0}"
WITH_MAXINE_VSR="${WITH_MAXINE_VSR:-0}"
# Route A of Track B: RTX DLPP hosted live via our own PE loader against a user-supplied
# nvdlppx.dll (see RTXDLPP.md). Off by default like every other opt-in filter here, and
# deliberately NOT added to proxmox-build.sh's mandatory five-filter list -- this is new,
# unverified in a real production build, independent of the OPTIX/ORT/FSR2/DLSS chain (no SDK
# headers, no shared gu_inputs.h), and registers under the name `dlpp_rtcuda`, never the
# `dlpp_drv_cuda` name ffmpeg-patches/0006 already reserves for a different, Route B filter.
WITH_RTXDLPP="${WITH_RTXDLPP:-0}"
# Route A of Track C: RTX VSR bypass resampler (AIVP, nvaivpx.dll) hosted live via our own PE
# loader, the same architecture as WITH_RTXDLPP just above (its own forked copy of the loader
# files, not a shared dependency -- see RTXVSR.md). Off by default, and deliberately NOT added
# to proxmox-build.sh's mandatory five-filter list, same reasoning as WITH_RTXDLPP. Registers
# under the name `vsr_rtcuda`, never `vsr_drv_cuda`, which ffmpeg-patches/0005 already reserves
# for a different, Route B filter (see .agent-briefs/vsr-drv-promote-to-production.md).
WITH_RTXVSR="${WITH_RTXVSR:-0}"
# Old name, renamed so it cannot be mistaken for RTX VSR (`vsr_drv_cuda`, planned as WITH_RTXCUDA).
if [[ -n "${WITH_VSR:-}" ]]; then
    echo "WITH_VSR was renamed WITH_MAXINE_VSR (Maxine, retired). RTX VSR will be WITH_RTXCUDA (planned, TASK.md 2.2). Unset WITH_VSR." >&2
    exit 1
fi
# RETIRED 2026-09-23: Maxine VFX `vsr` (vf_vsr.c, patch 0005). NvVFX_Load hangs and NVIDIA ships no
# TensorRT models for it, so it never produced a frame; a stuck test process held the GPU for days.
# The source and every WITH_MAXINE_VSR block below stay in the tree, but this gate refuses to build it.
# RTX VSR (`vsr_drv_cuda`, nvaivpx.dll) is the replacement target, see TASK.md Track B.
# Override only to work on the hang itself: MAXINE_VSR_UNRETIRE=1 WITH_MAXINE_VSR=1.
if [[ "$WITH_MAXINE_VSR" == "1" && "${MAXINE_VSR_UNRETIRE:-0}" != "1" ]]; then
    echo "WITH_MAXINE_VSR=1: Maxine vsr is retired (NvVFX_Load hangs, see VSR.md). Set MAXINE_VSR_UNRETIRE=1 to build it anyway." >&2
    exit 1
fi

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
# The DLL is a runtime data file, not a build-time SDK -- no headers to point at, same as
# <prefix>/dlss for the DLSS runtime blob. Default matches the path RTXDLPP.md tells the user
# to populate by hand.
RTXDLPP_DLL="${RTXDLPP_DLL:-${PREFIX}/rtxdlpp/dll/nvdlppx.dll}"
# Same shape as RTXDLPP_DLL just above: a runtime data file, not a build-time SDK. Default
# matches the path RTXVSR.md tells the user to populate by hand.
RTXVSR_DLL="${RTXVSR_DLL:-${PREFIX}/rtxvsr/dll/nvaivpx.dll}"
# Headers only, from the NGC SDK Core package and the nvvfxvideosuperres feature package - see
# VSR.md for where these downloads come from and why they are not fetched here.
VFXSDK_DIR="${VFXSDK_DIR:-/root/gameupscale/vfx/VideoFX}"
VFXVSR_DIR="${VFXVSR_DIR:-/root/gameupscale/vfx/nvvfxvideosuperres}"
# The actual runtime .so's - libVideoFX.so, libnvVFXVideoSuperRes.so, libnvidia-ngx-vsr.so.1.8.2,
# plus every one of THEIR OWN dependencies (NPP, cuDNN 9, and critically TensorRT: libnvinfer.so.10,
# libnvinfer_plugin.so.10, libnvonnxparser.so.10 - CreateEffect returns "not yet implemented"
# without TensorRT present, which the NGC SDK Core download does not mention needing at all). This
# whole directory is a straight copy of the `nvvfx/libs/` folder inside NVIDIA's own `nvidia-vfx`
# PyPI wheel (`pip download --no-deps --extra-index-url https://pypi.nvidia.com/ nvidia-vfx`, no
# NGC login - see VSR.md), confirmed self-contained (`ldd` against nothing but itself resolves
# clean) and confirmed to get CreateEffect+Load further than the NGC SDK Core + hand-fetched
# CUDA/NPP/cuDNN combination this project assembled first.
VFXLIBS_DIR="${VFXLIBS_DIR:-/root/gameupscale/vfx/pywheel-libs}"
OIDN_VER="${OIDN_VER:-2.5.1}"
LIBPLACEBO_TAG="${LIBPLACEBO_TAG:-v7.351.0}"
# Pinned, like every other source build here. 2026.4 knows GL_EXT_expect_assume; the distro 2023.8
# does not, which is the whole reason this is built rather than installed.
SHADERC_TAG="${SHADERC_TAG:-v2026.4}"
KEEP_BUILD="${KEEP_BUILD:-0}"

# nv-codec-headers must match the INSTALLED DRIVER, not the newest tag. A newer tag compiles and then
# refuses to open the encoder at runtime. n13.0.19.1 is correct for driver 595.x; check the upstream
# README's driver table if yours differs.
NVCODEC_TAG="${NVCODEC_TAG:-n13.0.19.1}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say () { printf '\n== %s\n' "$*"; }
die () { printf '!! %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root: it installs build deps and writes to ${PREFIX}"

# --- CUDA C -> PTX ----------------------------------------------------------------------------
# gu_optix_nv12_rgbf32.cu / gu_dlpp_nv12_rgba.cu / gu_vsr_nv12_rgba.cu are ordinary CUDA C,
# compiled to PTX with clang's own NVPTX backend plus clang's bundled
# __clang_cuda_builtin_vars.h (blockIdx/threadIdx/blockDim) -- no nvcc, no CUDA toolkit
# install; CT114 has neither. -nocudainc/-nocudalib skip the search for an actual CUDA SDK.
# The handful of bindless-surface (`sust`/`suld`) accesses inside those .cu files stay
# inline PTX asm because CUDA's own surface intrinsics live in headers this deliberately
# doesn't pull in -- everything else in them is ordinary, auditable C. Never hand-write PTX
# for a new or modified kernel: write real C and compile it here instead.
CLANG_CUDA="${CLANG_CUDA:-$(command -v clang-18 || command -v clang || true)}"
compile_cuda_to_header () {
    local cu="$1" sym="$2" out_h="$3" ptx="${1%.cu}.ptx.generated"
    "$CLANG_CUDA" -x cuda --cuda-device-only -nocudainc -nocudalib \
        -S -O2 --cuda-gpu-arch=sm_52 -o "$ptx" "$cu" \
        || die "clang (\$CLANG_CUDA=$CLANG_CUDA) failed to compile $cu to PTX"
    { echo "static const char ${sym}[] ="
      sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/^/"/' -e 's/$/\\n"/' "$ptx"
      echo ';'; } > "$out_h"
}

# --- preflight ------------------------------------------------------------------------------------
free_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
(( free_gb >= 12 )) || die "need ~12G free for the build tree, have ${free_gb}G"
say "disk: ${free_gb}G free"

if [[ "$WITH_OPTIX" == "1" ]]; then
    [[ -n "${OPTIX_SDK:-}" && -f "$OPTIX_SDK/include/optix.h" ]] \
        || die "WITH_OPTIX=1 needs OPTIX_SDK=/path/to/optix-dev (see OPTIX.md)"
    [[ -n "${NVOF_SDK:-}" ]] \
        || die "WITH_OPTIX=1 needs NVOF_SDK=/path/to/NVIDIAOpticalFlowSDK (see OPTIX.md)"
    # nv12_to_rgbf32/p010_to_rgbf32/rgbf32_to_nv12/smooth_luma_dev/p010_smooth_luma_dev/
    # expand_flow_dev are real CUDA C (gu_optix_nv12_rgbf32.cu), compiled to PTX below with
    # clang's NVPTX backend -- no nvcc needed, but a clang built with NVPTX support is.
    [[ -n "$CLANG_CUDA" ]] \
        || die "WITH_OPTIX=1 needs a clang with NVPTX support to compile gu_optix_nv12_rgbf32.cu (apt-get install clang-18); set CLANG_CUDA=/path/to/clang to override"
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

# No SDK headers to check -- the loader resolves everything from the DLL's own PE export table
# at run time. The one thing that has to exist before the smoke test at the end of this script
# means anything is the DLL itself.
if [[ "$WITH_RTXDLPP" == "1" ]]; then
    [[ -f "$RTXDLPP_DLL" ]] \
        || die "WITH_RTXDLPP=1: no nvdlppx.dll at RTXDLPP_DLL=$RTXDLPP_DLL (see RTXDLPP.md)"
    for f in gu_dlpp_pe_map.c gu_dlpp_aivp_loader.c gu_dlpp_ngx_isr.c gu_dlpp_embed.h \
             gu_dlpp_embed.c gu_dlpp_nv12_rgba.cu vf_dlpp_rtcuda.c; do
        [[ -f "$HERE/ffmpeg/$f" ]] || die "WITH_RTXDLPP=1: $HERE/ffmpeg/$f missing"
    done
    [[ -n "$CLANG_CUDA" ]] \
        || die "WITH_RTXDLPP=1 needs a clang with NVPTX support to compile gu_dlpp_nv12_rgba.cu (apt-get install clang-18); set CLANG_CUDA=/path/to/clang to override"
fi

# Same reasoning as WITH_RTXDLPP just above: no SDK headers, the loader resolves everything from
# the DLL's own PE export table at run time. Independent flag, independent file set -- see
# RTXVSR.md "Flag naming" for why this is not folded into a shared WITH_RTXCUDA.
if [[ "$WITH_RTXVSR" == "1" ]]; then
    [[ -f "$RTXVSR_DLL" ]] \
        || die "WITH_RTXVSR=1: no nvaivpx.dll at RTXVSR_DLL=$RTXVSR_DLL (see RTXVSR.md)"
    for f in gu_vsr_pe_map.c gu_vsr_aivp_loader.c gu_vsr_ngx_isr.c gu_vsr_embed.h \
             gu_vsr_embed.c gu_vsr_nv12_rgba.cu vf_vsr_rtcuda.c; do
        [[ -f "$HERE/ffmpeg/$f" ]] || die "WITH_RTXVSR=1: $HERE/ffmpeg/$f missing"
    done
    [[ -n "$CLANG_CUDA" ]] \
        || die "WITH_RTXVSR=1 needs a clang with NVPTX support to compile gu_vsr_nv12_rgba.cu (apt-get install clang-18); set CLANG_CUDA=/path/to/clang to override"
fi

# 0005's patch context assumes 0001-0004 all applied (see the note above this script's header) -
# enforced here for the same reason 0004's own chain is: failing in seconds beats failing after the
# SDKs are already staged and the build is 20 minutes in.
if [[ "$WITH_MAXINE_VSR" == "1" ]]; then
    [[ "$WITH_OPTIX" == "1" && "$WITH_ORT" == "1" && "$WITH_FSR2" == "1" && "$WITH_DLSS" == "1" ]] \
        || die "WITH_MAXINE_VSR=1 needs WITH_OPTIX=1 WITH_ORT=1 WITH_FSR2=1 WITH_DLSS=1: patch 0005 applies on top of 0001-0004"
    [[ -f "$VFXSDK_DIR/include/nvVideoEffects.h" ]] \
        || die "WITH_MAXINE_VSR=1: no nvVideoEffects.h under VFXSDK_DIR=$VFXSDK_DIR/include (see VSR.md)"
    [[ -f "$VFXVSR_DIR/include/nvVFXVideoSuperRes.h" ]] \
        || die "WITH_MAXINE_VSR=1: no nvVFXVideoSuperRes.h under VFXVSR_DIR=$VFXVSR_DIR/include (see VSR.md)"
    [[ -f "$VFXLIBS_DIR/libVideoFX.so" ]] \
        || die "WITH_MAXINE_VSR=1: no libVideoFX.so under VFXLIBS_DIR=$VFXLIBS_DIR (see VSR.md)"
    [[ -f "$VFXLIBS_DIR/libnvinfer.so.10" ]] \
        || die "WITH_MAXINE_VSR=1: no libnvinfer.so.10 (TensorRT) under VFXLIBS_DIR=$VFXLIBS_DIR - CreateEffect" \
               "returns \"not yet implemented\" without it, confirmed the hard way (see VSR.md)"
    command -v patchelf >/dev/null || die "WITH_MAXINE_VSR=1: patchelf not found (apt install patchelf) - needed to fix libVideoFX.so's own rpath, see VSR.md"
    say "note: WITH_MAXINE_VSR builds and registers the filter, and CreateEffect works against VFXLIBS_DIR's" \
        "exact library set (which this build stages). NvVFX_Load does NOT - it hangs, and no frame" \
        "has ever come out of this filter. See VSR.md 'Round 3'. Build it if you are working on that" \
        "hang; it is not a working upscaler."
fi

say "installing build dependencies"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# NOT libshaderc-dev. The distro package is what broke nlmeans_vulkan: see the shaderc build
# below. cmake is here because that build needs it.
apt-get install -y -qq --no-install-recommends \
    build-essential git curl ca-certificates pkg-config nasm yasm meson ninja-build cmake \
    python3 libx264-dev libxcb1-dev libvulkan-dev glslang-tools >/dev/null

# The distro shaderc, if some earlier run installed it, would still be found by pkg-config and
# would win on include order. Remove it rather than hope /usr/local sorts first.
apt-get remove -y -qq libshaderc-dev libshaderc1 >/dev/null 2>&1 || true

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

# --- shaderc --------------------------------------------------------------------------------------
# BUILT FROM SOURCE, AND THIS IS NOT OPTIONAL POLISH.
#
# Vulkan filters compile their shaders at run time through shaderc. Ubuntu noble ships 2023.8, which
# does not know GL_EXT_expect_assume, and FFmpeg 8.x's nlmeans_vulkan shader uses it. Against the
# distro build that filter fails with "extension not supported" and takes the whole transcode with
# it, while the same filter works in the stock jellyfin-ffmpeg, which builds its own shaderc. That
# left the two binaries with different capabilities in opposite directions and killed any session
# combining a Vulkan denoise with a filter only this build carries.
#
# It comes BEFORE libplacebo on purpose: libplacebo is configured with -Dshaderc=enabled and links
# whichever it finds, so building it first would leave libplacebo on the old one.
#
# Both this and libplacebo below are skipped when a stamp file says the same tag is already
# installed at /usr/local. Neither depends on which WITH_* flags are set, so every WITH_MAXINE_VSR
# iteration was rebuilding them from source unconditionally - minutes of wasted C++ compilation per
# run during exactly the kind of rapid rebuild-and-test loop this filter needed. Bump the tag (or
# delete the stamp) to force a rebuild.
STAMP_DIR="/usr/local/share/jellyfin-gpu-upscale-build-stamps"
mkdir -p "$STAMP_DIR"

say "shaderc ${SHADERC_TAG} (from source: the distro build cannot compile FFmpeg 8's Vulkan shaders)"
if [[ "$(cat "$STAMP_DIR/shaderc.tag" 2>/dev/null)" == "$SHADERC_TAG" ]] \
        && pkg-config --exists shaderc 2>/dev/null; then
    say "shaderc ${SHADERC_TAG} already installed at /usr/local, skipping rebuild"
else
    git clone -q --depth 1 -b "$SHADERC_TAG" https://github.com/google/shaderc.git
    # Fetches the glslang and SPIRV-Tools revisions this tag was tested against, which is the whole
    # reason to use upstream's own script rather than distro packages of each.
    ( cd shaderc && ./utils/git-sync-deps >/dev/null )
    cmake -S shaderc -B shaderc/build -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX=/usr/local \
        -DSHADERC_SKIP_TESTS=ON -DSHADERC_SKIP_EXAMPLES=ON -DSHADERC_SKIP_COPYRIGHT_CHECK=ON >/dev/null
    cmake --build shaderc/build --target install -j"$(nproc)" >/dev/null
    ldconfig
    echo "$SHADERC_TAG" > "$STAMP_DIR/shaderc.tag"
fi

# Prove it before anything links against it: a version that still predates the extension would
# otherwise surface twenty minutes later as the same runtime failure this build exists to remove.
shaderc_ver="$(pkg-config --modversion shaderc 2>/dev/null || echo unknown)"
say "shaderc in use: ${shaderc_ver}"

# --- libplacebo -----------------------------------------------------------------------------------
# FFmpeg 8.x needs PL_ALPHA_NONE, absent from libplacebo 6.x (which is what distros ship).
say "libplacebo ${LIBPLACEBO_TAG} (static)"
if [[ "$(cat "$STAMP_DIR/libplacebo.tag" 2>/dev/null)" == "$LIBPLACEBO_TAG" ]] \
        && [[ -f /usr/local/lib/x86_64-linux-gnu/libplacebo.a ]]; then
    say "libplacebo ${LIBPLACEBO_TAG} already installed at /usr/local, skipping rebuild"
else
    git clone --recursive --depth 1 -b "$LIBPLACEBO_TAG" \
        https://code.videolan.org/videolan/libplacebo.git >/dev/null 2>&1
    meson setup libplacebo/build libplacebo --prefix=/usr/local --libdir=lib/x86_64-linux-gnu \
        --default-library=static -Dvulkan=enabled -Dshaderc=enabled -Ddemos=false >/dev/null
    ninja -C libplacebo/build install >/dev/null
    echo "$LIBPLACEBO_TAG" > "$STAMP_DIR/libplacebo.tag"
fi

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
    # vf_optix.c takes AV_PIX_FMT_CUDA frames directly (both nv12 and p010le sw_format) and
    # embeds a small CUDA C module for the on-GPU NV12/P010<->RGB conversion (roadmap step 1,
    # GPU-resident conversion), compiled to PTX below the same way the DLPP/VSR modules are.
    cp "$HERE/ffmpeg/gu_optix_nv12_rgbf32.cu" libavfilter/
    compile_cuda_to_header libavfilter/gu_optix_nv12_rgbf32.cu \
        gu_optix_nv12_rgbf32_ptx libavfilter/gu_optix_nv12_rgbf32_ptx.h
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

VSR_FLAGS=()
if [[ "$WITH_MAXINE_VSR" == "1" ]]; then
    cp "$HERE/ffmpeg/vf_vsr.c" libavfilter/
    patch -p1 < "$HERE/ffmpeg/0005-add-vsr-filter-to-build.patch"
    # Pure CUDA, no Vulkan/ffnvcodec involvement (see the file's own header comment) - just the SDK's
    # own shared libraries. rpath, not -L, decides what the installed binary loads at runtime, same
    # reasoning as ORT above: the build tree may not survive this script.
    export CFLAGS="-I${VFXSDK_DIR}/include -I${VFXVSR_DIR}/include ${CFLAGS:-}"
    export LDFLAGS="-L${VFXLIBS_DIR} -Wl,-rpath,${PREFIX}/vfx/lib ${LDFLAGS:-}"
    VSR_FLAGS=(--enable-libvfxsdk)
fi

# Route A of Track B (RTXDLPP.md). No configure --enable-libX flag: nothing NVIDIA is linked at
# build time, so there's no library for configure to detect.
#
# This tree is a pristine FFmpeg 8.1.2 RELEASE TARBALL, not the rtx-video-re spike's own scratch
# git checkout -- confirmed directly: that scratch tree carries a libavfilter/filter_list.c the
# spike's build.sh hand-edits, but the release tarball has no such file at all until configure
# creates one. configure's own `find_filters_extern` scans allfilters.c's `extern const
# FFFilter ff_*;` lines to build its filter list, then `print_enabled_components` GENERATES
# filter_list.c (and the matching CONFIG_*_FILTER lines in config.mak/config_components.h) from
# whatever it finds enabled at that point. So in this layout the only manual edits a new filter
# needs are the source files, the Makefile OBJS line, and the allfilters.c extern -- all of them
# BEFORE ./configure runs, which is the mechanism mirrored below (config.mak and
# config_components.h are configure's output here, not something to hand-edit afterward).
EXTRA_LIBS="-lstdc++"
if [[ "$WITH_RTXDLPP" == "1" ]]; then
    say "wiring dlpp_rtcuda into the build"
    cp "$HERE/ffmpeg/gu_dlpp_pe_map.c" "$HERE/ffmpeg/gu_dlpp_aivp_loader.c" \
       "$HERE/ffmpeg/gu_dlpp_ngx_isr.c" "$HERE/ffmpeg/gu_dlpp_embed.h" \
       "$HERE/ffmpeg/gu_dlpp_embed.c" "$HERE/ffmpeg/vf_dlpp_rtcuda.c" \
       "$HERE/ffmpeg/gu_dlpp_nv12_rgba.cu" libavfilter/

    # gu_dlpp_nv12_rgba_ptx.h is generated, not committed: real CUDA C compiled to PTX with
    # clang's NVPTX backend (compile_cuda_to_header, defined above), then the same
    # sed-to-C-string transform the spike's build.sh uses for its own PTX-as-header file.
    compile_cuda_to_header libavfilter/gu_dlpp_nv12_rgba.cu \
        gu_dlpp_nv12_rgba_ptx libavfilter/gu_dlpp_nv12_rgba_ptx.h

    grep -q vf_dlpp_rtcuda libavfilter/Makefile ||
        sed -i '/^OBJS-\$(CONFIG_SCALE_CUDA_FILTER)/i OBJS-$(CONFIG_DLPP_RTCUDA_FILTER)          += vf_dlpp_rtcuda.o gu_dlpp_embed.o' \
            libavfilter/Makefile
    grep -q ff_vf_dlpp_rtcuda libavfilter/allfilters.c ||
        sed -i '/^extern const FFFilter ff_vf_scale_cuda;/i extern const FFFilter ff_vf_dlpp_rtcuda;' \
            libavfilter/allfilters.c

    EXTRA_LIBS="$EXTRA_LIBS -ldl -lpthread"
fi
if [[ "$WITH_RTXVSR" == "1" ]]; then
    say "wiring vsr_rtcuda into the build"
    cp "$HERE/ffmpeg/gu_vsr_pe_map.c" "$HERE/ffmpeg/gu_vsr_aivp_loader.c" \
       "$HERE/ffmpeg/gu_vsr_ngx_isr.c" "$HERE/ffmpeg/gu_vsr_embed.h" \
       "$HERE/ffmpeg/gu_vsr_embed.c" "$HERE/ffmpeg/vf_vsr_rtcuda.c" \
       "$HERE/ffmpeg/gu_vsr_nv12_rgba.cu" libavfilter/

    # gu_vsr_nv12_rgba_ptx.h is generated, not committed: same compile_cuda_to_header path
    # WITH_RTXDLPP uses for its own PTX-as-header file.
    compile_cuda_to_header libavfilter/gu_vsr_nv12_rgba.cu \
        gu_vsr_nv12_rgba_ptx libavfilter/gu_vsr_nv12_rgba_ptx.h

    grep -q vf_vsr_rtcuda libavfilter/Makefile ||
        sed -i '/^OBJS-\$(CONFIG_SCALE_CUDA_FILTER)/i OBJS-$(CONFIG_VSR_RTCUDA_FILTER)           += vf_vsr_rtcuda.o gu_vsr_embed.o' \
            libavfilter/Makefile
    grep -q ff_vf_vsr_rtcuda libavfilter/allfilters.c ||
        sed -i '/^extern const FFFilter ff_vf_scale_cuda;/i extern const FFFilter ff_vf_vsr_rtcuda;' \
            libavfilter/allfilters.c

    EXTRA_LIBS="$EXTRA_LIBS -ldl -lpthread"
fi

say "configure"
PKG_CONFIG_PATH="/usr/local/lib/x86_64-linux-gnu/pkgconfig:${PKG_CONFIG_PATH:-}" ./configure \
    --prefix="$PREFIX" \
    --disable-doc --disable-htmlpages --disable-manpages \
    --enable-gpl --enable-version3 \
    --enable-vulkan --enable-libplacebo --enable-libshaderc --enable-libx264 \
    --enable-ffnvcodec --enable-cuda --enable-cuvid --enable-nvdec --enable-nvenc \
    "${OIDN_FLAGS[@]}" "${OPTIX_FLAGS[@]}" "${ORT_FLAGS[@]}" "${GAME_FLAGS[@]}" "${VSR_FLAGS[@]}" \
    --extra-libs="$EXTRA_LIBS"

# By this point configure has already generated config.mak, config_components.h and
# filter_list.c itself from the allfilters.c extern added above -- confirm it actually picked
# the new filter up rather than silently building without it.
if [[ "$WITH_RTXDLPP" == "1" ]]; then
    grep -q CONFIG_DLPP_RTCUDA_FILTER ffbuild/config.mak \
        || die "WITH_RTXDLPP=1: configure did not enable dlpp_rtcuda_filter -- check libavfilter/allfilters.c got the new extern before configure ran"
fi
if [[ "$WITH_RTXVSR" == "1" ]]; then
    grep -q CONFIG_VSR_RTCUDA_FILTER ffbuild/config.mak \
        || die "WITH_RTXVSR=1: configure did not enable vsr_rtcuda_filter -- check libavfilter/allfilters.c got the new extern before configure ran"
fi

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

if [[ "$WITH_MAXINE_VSR" == "1" ]]; then
    # Stage VFXLIBS_DIR wholesale where the rpath above points. No separate features/<name>
    # subdirectory is needed - confirmed directly: CreateEffect finds libnvVFXVideoSuperRes.so and
    # libnvidia-ngx-vsr.so.1.8.2 from plain LD_LIBRARY_PATH/rpath resolution alone, sitting flat
    # beside libVideoFX.so, same as every other shared library here (VSR.md).
    # Wiped first, not merged into: a stale libVideoFX.so left over as a *.so.1.3.0 symlink from an
    # older VFXSDK_DIR-based build makes `cp -a` write through the symlink into the old versioned
    # file instead of replacing it, so the plain-named file stays a symlink and the patchelf loop
    # below (which deliberately skips symlinks) silently patches the wrong file. Hit exactly this
    # building this filter (VSR.md).
    rm -rf "$PREFIX/vfx/lib"
    mkdir -p "$PREFIX/vfx/lib"
    cp -a "$VFXLIBS_DIR"/. "$PREFIX/vfx/lib/"
    # ffmpeg's own rpath (set above) is not transitive: it resolves ffmpeg's direct NEEDED entries
    # but not libVideoFX.so's own NEEDED entries (NPP, cuDNN, TensorRT, staged beside it), the same
    # RUNPATH-non-transitivity NEURAL.md already documents and fixes for ORT's CUDA provider.
    # Without this, ffmpeg fails to start at all with "error while loading shared libraries" - hit
    # twice building this filter before this fix existed (VSR.md).
    for lib in "$PREFIX/vfx/lib"/libVideoFX.so "$PREFIX/vfx/lib"/libVideoFXLocal.so \
               "$PREFIX/vfx/lib"/libNVCVImage.so "$PREFIX/vfx/lib"/libnvVFXVideoSuperRes.so; do
        [[ -e "$lib" && ! -L "$lib" ]] && patchelf --set-rpath '$ORIGIN' "$lib"
    done
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
if [[ "$WITH_MAXINE_VSR" == "1" ]]; then
    "$PREFIX/ffmpeg" -hide_banner -filters 2>/dev/null | grep -E "\bvsr\b" \
        && echo "  vsr: present (registered - NOT confirmed to run, see VSR.md)" \
        || die "vsr filter missing from the build"
fi
if [[ "$WITH_RTXDLPP" == "1" ]]; then
    "$PREFIX/ffmpeg" -hide_banner -filters 2>/dev/null | grep -E "\bdlpp_rtcuda\b" \
        && echo "  dlpp_rtcuda: present (registered - see RTXDLPP.md for what's verified vs assumed)" \
        || die "dlpp_rtcuda filter missing from the build"
fi
if [[ "$WITH_RTXVSR" == "1" ]]; then
    "$PREFIX/ffmpeg" -hide_banner -filters 2>/dev/null | grep -E "\bvsr_rtcuda\b" \
        && echo "  vsr_rtcuda: present (registered - see RTXVSR.md for what's verified vs assumed)" \
        || die "vsr_rtcuda filter missing from the build"
fi

cat <<EOF

Built: ${PREFIX}/ffmpeg

The plugin's shim routes to this binary only for sessions requesting a filter it alone provides;
everything else keeps using the stock jellyfin-ffmpeg. If this binary is deleted the plugin strips
the affected filter from the chain, so those sessions play unenhanced rather than failing.

Re-run this after an NVIDIA driver change if the OptiX, FSR2 or DLSS levels stop working: OptiX,
NVOFA and NGX all negotiate against the driver at runtime, which no rebuild here controls.
EOF
