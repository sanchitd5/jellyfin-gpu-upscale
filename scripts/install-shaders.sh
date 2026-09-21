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
set -eu

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
# Super-resolution shaders. Fetched, never vendored, so each licence stays with its author.
#   FSRCNNX  - igv, LGPL-3.0-or-later, from the FSRCNN-TensorFlow releases
#   Anime4K  - bloc97, MIT
FSRCNNX_BASE=${FSRCNNX_BASE:-https://github.com/igv/FSRCNN-TensorFlow/releases/download/1.1}
ANIME4K_BASE=${ANIME4K_BASE:-https://raw.githubusercontent.com/bloc97/Anime4K/master/glsl/Upscale-CNN}

fetch_sr() {  # $1 = url, $2 = filename
    dest="$DIR/$2"
    if [ -s "$dest" ]; then
        echo "  = $2 (already present)"
        return 0
    fi
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$1" -o "$dest.tmp" || { echo "  !! failed: $1" >&2; rm -f "$dest.tmp"; return 1; }
    else
        wget -qO "$dest.tmp" "$1" || { echo "  !! failed: $1" >&2; rm -f "$dest.tmp"; return 1; }
    fi
    # A truncated shader is worse than an absent one: a missing file degrades cleanly to "level
    # unavailable", a half-written one loads and produces garbage.
    if [ "$(wc -c < "$dest.tmp")" -lt 5000 ]; then
        echo "  !! $2 is implausibly small, refusing to install" >&2
        rm -f "$dest.tmp"
        return 1
    fi
    mv "$dest.tmp" "$dest"
    echo "  + $2"
}

echo "super-resolution shaders:"
fetch_sr "$FSRCNNX_BASE/FSRCNNX_x2_8-0-4-1.glsl"  FSRCNNX_x2_8-0-4-1.glsl
fetch_sr "$FSRCNNX_BASE/FSRCNNX_x2_16-0-4-1.glsl" FSRCNNX_x2_16-0-4-1.glsl
fetch_sr "$ANIME4K_BASE/Anime4K_Upscale_CNN_x2_S.glsl" Anime4K_Upscale_CNN_x2_S.glsl || true
fetch_sr "$ANIME4K_BASE/Anime4K_Upscale_CNN_x2_M.glsl" Anime4K_Upscale_CNN_x2_M.glsl || true

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
ls -1 "$DIR"
echo
echo "deblur levels: low -> RCAS-2.0 (gentlest), medium -> RCAS-1.7, high -> RCAS-1.4 (strongest)."
echo "RCAS SHARPNESS is inverted (0.0 = maximum) and clamped to [0,2]; above 2.0 does nothing."
