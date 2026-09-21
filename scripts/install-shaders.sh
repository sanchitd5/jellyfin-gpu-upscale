#!/bin/bash
# install-shaders.sh [shader-dir]
#
# Installs the sharpening shaders the plugin's deblur ladder points at.
#
# Nothing upstream is vendored in this repository. The RCAS shaders are DERIVED at install time
# from agyild's mpv port of AMD FidelityFX FSR v1.0.2 (MIT): this script fetches FSR.glsl and runs
# make-rcas.sh on it. That keeps the licence attribution attached to the file it belongs to and
# means a fix upstream is one re-run away.
#
# The CAS shaders that RCAS replaced are left alone if they are already installed: they stay
# reachable under the cas-low / cas-medium / cas-high level names as a rollback path.
set -eu -o pipefail

DIR=${1:-/usr/share/jellyfin-shaders}
HERE=$(cd "$(dirname "$0")" && pwd)
# agyild publishes the mpv ports as gists, not as a repository.
URL=${FSR_GLSL_URL:-https://gist.githubusercontent.com/agyild/82219c545228d70c5604f865ce0b0ce5/raw/FSR.glsl}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# FSR_GLSL=/some/FSR.glsl installs from a local copy instead, for an offline build.
if [ -n "${FSR_GLSL:-}" ]; then
    echo "using local $FSR_GLSL"
    cp "$FSR_GLSL" "$TMP/FSR.glsl"
else
    echo "fetching $URL"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$URL" -o "$TMP/FSR.glsl"
    else
        wget -qO "$TMP/FSR.glsl" "$URL"
    fi
fi

grep -q 'FidelityFX FSR v1.0.2 by AMD' "$TMP/FSR.glsl" \
    || { echo "that is not agyild's FSR.glsl v1.0.2" >&2; exit 1; }
grep -q 'Permission is hereby granted, free of charge' "$TMP/FSR.glsl" \
    || { echo "MIT licence header missing from the fetched file" >&2; exit 1; }

mkdir -p "$DIR"
bash "$HERE/make-rcas.sh" "$TMP/FSR.glsl" "$TMP"
install -m 0644 "$TMP"/RCAS-2.0.glsl "$TMP"/RCAS-1.7.glsl "$TMP"/RCAS-1.4.glsl "$DIR/"

# ---------------------------------------------------------------------------------------------
# NVIDIA Image Scaling v1.0.2 (NVScaler + NVSharpen), agyild's mpv port, MIT licence.
# Fetched, never vendored, exactly like FSR above.
#
# NVSharpen ships with
#     //!WHEN OUTPUT.w OUTPUT.h * LUMA.w LUMA.h * / 1.0 > ! ... 1.0 < ! *
# which fires ONLY when there is no scaling at all in either direction. In this plugin's chain the
# output is always larger than the source, so as published the pass would silently never run - a
# no-op that measures as "no difference" and looks like a result. The guard is removed here, and
# the two sharpness builds are cut from the same file so the licence header travels with them.
NIS_URL=${NIS_GLSL_URL:-https://gist.githubusercontent.com/agyild/7e8951915b2bf24526a9343d951db214/raw}

fetch_nis() {
    name=$1
    if [ -n "${NIS_DIR:-}" ]; then
        cp "$NIS_DIR/$name" "$TMP/$name"
    elif command -v curl >/dev/null 2>&1; then
        curl -fsSL "$NIS_URL/$name" -o "$TMP/$name"
    else
        wget -qO "$TMP/$name" "$NIS_URL/$name"
    fi

    grep -q 'NVIDIA Image Scaling v1.0.2' "$TMP/$name" \
        || { echo "$name is not NVIDIA Image Scaling v1.0.2" >&2; exit 1; }
    grep -q 'Permission is hereby granted, free of charge' "$TMP/$name" \
        || { echo "MIT licence header missing from $name" >&2; exit 1; }
}

fetch_nis NVScaler.glsl
fetch_nis NVSharpen.glsl
install -m 0644 "$TMP/NVScaler.glsl" "$DIR/NVScaler.glsl"

for sharp in 0.25 0.65; do
    sed -e '/^\/\/!WHEN /d' \
        -e "s/^#define SHARPNESS .*/#define SHARPNESS $sharp \/\/ set by install-shaders.sh; 0.0-1.0, larger is sharper/" \
        "$TMP/NVSharpen.glsl" > "$TMP/NVSharpen-$sharp.glsl"
    grep -q '!WHEN' "$TMP/NVSharpen-$sharp.glsl" \
        && { echo "the //!WHEN guard is still in NVSharpen-$sharp" >&2; exit 1; }
    install -m 0644 "$TMP/NVSharpen-$sharp.glsl" "$DIR/NVSharpen-$sharp.glsl"
done

echo
echo "installed into $DIR:"
ls -l "$DIR"/RCAS-*.glsl
echo
echo "deblur levels: low -> RCAS-2.0 (gentlest), medium -> RCAS-1.7, high -> RCAS-1.4 (strongest)."
echo "RCAS SHARPNESS is inverted (0.0 = maximum) and clamped to [0,2]; above 2.0 does nothing."

# =================================================================================================
# SESSION 10. Four more shaders, all FETCHED here and none vendored, exactly as above.
#
# Read the hook points before changing anything in this block. libplacebo runs LUMA hooks before it
# scales, MAIN hooks after, POSTKERNEL after the scaling kernel, and CHROMA on the chroma planes -
# so these four occupy three groups that the existing SR/unblur shaders do not, which is why three
# of the four COMPOSE with the existing levels instead of replacing them.
# -------------------------------------------------------------------------------------------------

# --- SSimSuperRes, by Shiandow, published by igv. LGPL-3.0-or-later. ------------------------------
# A ratio-agnostic REFINEMENT: it adjusts the already-scaled image so that downscaling the result
# reproduces the source. It hooks POSTKERNEL, i.e. it runs AFTER libplacebo's scaling kernel, so it
# composes with every SR level (LUMA or MAIN) and with the sharpener (LUMA) rather than competing
# with one. Its guard is `NATIVE_CROPPED.h OUTPUT.h <` - it fires whenever the output is taller than
# the source, which is every chain this plugin builds, INCLUDING the ones below SrMinScaleFactor
# where the fixed-2x networks are bypassed. Nothing is stripped; the guard is the one we want.
SSSR_URL=${SSSR_GLSL_URL:-https://gist.githubusercontent.com/igv/2364ffa6e81540f29cb7ab4c9bc05b6b/raw/SSimSuperRes.glsl}

if [ -n "${SSSR_GLSL:-}" ]; then
    cp "$SSSR_GLSL" "$TMP/SSimSuperRes.glsl"
elif command -v curl >/dev/null 2>&1; then
    curl -fsSL "$SSSR_URL" -o "$TMP/SSimSuperRes.glsl"
else
    wget -qO "$TMP/SSimSuperRes.glsl" "$SSSR_URL"
fi

grep -q 'SSimSuperRes by Shiandow' "$TMP/SSimSuperRes.glsl" \
    || { echo "that is not Shiandow's SSimSuperRes" >&2; exit 1; }
grep -q 'GNU Lesser General Public' "$TMP/SSimSuperRes.glsl" \
    || { echo "LGPL header missing from SSimSuperRes.glsl" >&2; exit 1; }
grep -q '^//!HOOK POSTKERNEL' "$TMP/SSimSuperRes.glsl" \
    || { echo "SSimSuperRes no longer hooks POSTKERNEL - the composition order assumption is void" >&2; exit 1; }
grep -q '^//!WHEN NATIVE_CROPPED.h OUTPUT.h <' "$TMP/SSimSuperRes.glsl" \
    || { echo "SSimSuperRes guard changed - check it still fires when the output is larger" >&2; exit 1; }
install -m 0644 "$TMP/SSimSuperRes.glsl" "$DIR/SSimSuperRes.glsl"

# --- KrigBilateral, by Shiandow, published by igv. LGPL-3.0-or-later. -----------------------------
# CHROMA upscaling, which is an axis nothing else here touches: these sources are 4:2:0, so chroma
# is stored at a quarter of the luma resolution and every other shader in this plugin is luma-only.
# It hooks CHROMA and guards on `CHROMA.w LUMA.w <`, i.e. it fires exactly when chroma IS
# subsampled - correct as published, nothing stripped. It composes with any SR level rather than
# replacing one, which is why it has its own control and is not in the SR list.
KRIG_URL=${KRIG_GLSL_URL:-https://gist.githubusercontent.com/igv/a015fc885d5c22e6891820ad89555637/raw/KrigBilateral.glsl}

if [ -n "${KRIG_GLSL:-}" ]; then
    cp "$KRIG_GLSL" "$TMP/KrigBilateral.glsl"
elif command -v curl >/dev/null 2>&1; then
    curl -fsSL "$KRIG_URL" -o "$TMP/KrigBilateral.glsl"
else
    wget -qO "$TMP/KrigBilateral.glsl" "$KRIG_URL"
fi

grep -q 'KrigBilateral by Shiandow' "$TMP/KrigBilateral.glsl" \
    || { echo "that is not Shiandow's KrigBilateral" >&2; exit 1; }
grep -q 'GNU Lesser General Public' "$TMP/KrigBilateral.glsl" \
    || { echo "LGPL header missing from KrigBilateral.glsl" >&2; exit 1; }
grep -q '^//!HOOK CHROMA' "$TMP/KrigBilateral.glsl" \
    || { echo "KrigBilateral no longer hooks CHROMA" >&2; exit 1; }
grep -q '^//!WHEN CHROMA.w LUMA.w <' "$TMP/KrigBilateral.glsl" \
    || { echo "KrigBilateral guard changed - check it still fires on subsampled chroma" >&2; exit 1; }
install -m 0644 "$TMP/KrigBilateral.glsl" "$DIR/KrigBilateral.glsl"

# --- RAVU-Zoom r3, by bjin (mpv-prescalers). LGPL-3.0-or-later. -----------------------------------
# The other ratio-agnostic prescaler, and the reason it matters here: it hooks LUMA with
# `//!WIDTH OUTPUT.w` / `//!HEIGHT OUTPUT.h`, so it scales straight to the requested size at ANY
# ratio instead of being a fixed 2x network that libplacebo then shrinks back. Its guard is
# `HOOKED.w OUTPUT.w < HOOKED.h OUTPUT.h < *` - output larger in both axes - and carries no fixed
# ratio threshold, so nothing is stripped. ShaderLibrary marks it ratio-agnostic so the
# SrMinScaleFactor bypass (which exists for the fixed-2x networks) does not disable it.
#
# The gather/ build is taken because upstream says textureGather is faster for luma upscalers, and
# this is Vulkan through libplacebo where it is available.
RAVU_URL=${RAVU_ZOOM_URL:-https://raw.githubusercontent.com/bjin/mpv-prescalers/master/gather/ravu-zoom-r3.hook}

if [ -n "${RAVU_ZOOM_HOOK:-}" ]; then
    cp "$RAVU_ZOOM_HOOK" "$TMP/ravu-zoom-r3.glsl"
elif command -v curl >/dev/null 2>&1; then
    curl -fsSL "$RAVU_URL" -o "$TMP/ravu-zoom-r3.glsl"
else
    wget -qO "$TMP/ravu-zoom-r3.glsl" "$RAVU_URL"
fi

grep -q '^//!DESC RAVU-Zoom (luma, r3)' "$TMP/ravu-zoom-r3.glsl" \
    || { echo "that is not bjin's ravu-zoom-r3 luma shader" >&2; exit 1; }
grep -q 'GNU Lesser General Public' "$TMP/ravu-zoom-r3.glsl" \
    || { echo "LGPL header missing from ravu-zoom-r3" >&2; exit 1; }
grep -q '^//!HOOK LUMA' "$TMP/ravu-zoom-r3.glsl" \
    || { echo "ravu-zoom no longer hooks LUMA" >&2; exit 1; }
grep -q '^//!WHEN HOOKED.w OUTPUT.w < HOOKED.h OUTPUT.h < \*' "$TMP/ravu-zoom-r3.glsl" \
    || { echo "ravu-zoom guard changed - it may no longer be ratio-agnostic" >&2; exit 1; }
# The whole point of this level is that it has no fixed-ratio threshold. If upstream ever adds one,
# stop rather than ship a level that silently no-ops at the ratios it is offered for.
grep -qE '^//!WHEN .*(1\.[0-9]+ >)' "$TMP/ravu-zoom-r3.glsl" \
    && { echo "ravu-zoom has gained a fixed ratio guard - re-check before shipping it" >&2; exit 1; }
install -m 0644 "$TMP/ravu-zoom-r3.glsl" "$DIR/ravu-zoom-r3.glsl"

# --- CuNNy, by funnyplanter. LGPL-3.0. ------------------------------------------------------------
# int8 dp4a builds ("-Q"), which upstream says need gpu-next with the Vulkan API - which is exactly
# what libplacebo gives us, and this GPU has native dp4a. Four sizes are installed, three from the
# SOFT family (trained to anti-alias, the most artifact-free variant, and the safer choice on real
# footage than the sharpening one) plus one DS build for anyone who wants its denoise-and-sharpen
# training.
#
# CuNNy is a fixed-2x network like FSRCNNX and carries the same honest `1.3 >` ratio guard. That is
# NOT stripped: it matches the plugin's own SrMinScaleFactor bypass (1.60), so a CuNNy level is
# never offered as running at a ratio where it would not. The assertion below is that the guard is
# still there, i.e. the opposite of the NVSharpen case above.
CUNNY_BASE=${CUNNY_URL_BASE:-https://raw.githubusercontent.com/funnyplanter/CuNNy/master/mpv}

fetch_cunny() {
    sub=$1
    name=$2
    if [ -n "${CUNNY_DIR:-}" ]; then
        cp "$CUNNY_DIR/$name" "$TMP/$name"
    elif command -v curl >/dev/null 2>&1; then
        curl -fsSL "$CUNNY_BASE/$sub/dp4a/$name" -o "$TMP/$name"
    else
        wget -qO "$TMP/$name" "$CUNNY_BASE/$sub/dp4a/$name"
    fi

    grep -q '(dp4a)' "$TMP/$name" \
        || { echo "$name is not a dp4a (int8) CuNNy build" >&2; exit 1; }
    grep -q 'funnyplanter' "$TMP/$name" \
        || { echo "$name carries no funnyplanter copyright line" >&2; exit 1; }
    grep -q 'GNU Lesser General Public' "$TMP/$name" \
        || { echo "LGPL header missing from $name" >&2; exit 1; }
    grep -q '^//!HOOK LUMA' "$TMP/$name" \
        || { echo "$name no longer hooks LUMA" >&2; exit 1; }
    grep -q '^//!WHEN OUTPUT.w LUMA.w / 1.3 > OUTPUT.h LUMA.h / 1.3 > \*' "$TMP/$name" \
        || { echo "$name lost its 1.3x ratio guard - re-check what it now runs on" >&2; exit 1; }
    install -m 0644 "$TMP/$name" "$DIR/$name"
}

fetch_cunny soft CuNNy-fast-SOFT-Q.glsl
fetch_cunny soft CuNNy-4x16-SOFT-Q.glsl
fetch_cunny soft CuNNy-4x32-SOFT-Q.glsl
fetch_cunny ds   CuNNy-4x16-DS-Q.glsl

echo
echo "session-10 shaders installed into $DIR:"
ls -l "$DIR"/SSimSuperRes.glsl "$DIR"/KrigBilateral.glsl "$DIR"/ravu-zoom-r3.glsl "$DIR"/CuNNy-*.glsl
echo
echo "SSimSuperRes is a POSTKERNEL refinement (the 'refine' control), KrigBilateral a CHROMA"
echo "upscaler (the 'chroma' control); both compose with any SR level. ravu-zoom and the CuNNy"
echo "builds are SR levels. ravu-zoom is ratio-agnostic and is exempt from SrMinScaleFactor."
