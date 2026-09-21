#!/usr/bin/env bash
# install-shaders.sh [shader-dir]
#
# Installs every shader the plugin's level ladders point at.
#
# Nothing upstream is vendored in this repository:
#   * the FSRCNNX super-resolution shaders are fetched from igv's releases (LGPL-3.0-or-later)
#   * the Anime4K shaders are fetched from bloc97's repository (MIT)
#   * the RCAS sharpening shaders are DERIVED at install time from agyild's mpv port of AMD
#     FidelityFX FSR v1.0.2 (MIT) by shaders/make-rcas.sh
#
# That keeps each licence attached to the file it belongs to, and means an upstream fix is one
# re-run away. What ships in this repo is the transform, not somebody else's source.
#
# The CAS shaders in shaders/ are this project's own work. They were replaced by RCAS, which
# measured better on every axis, but they are still installed: they remain reachable through the
# API as cas-low / cas-medium / cas-high as a rollback path.

set -euo pipefail

DIR="${1:-/usr/share/jellyfin-shaders}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

FSRCNNX_BASE="https://github.com/igv/FSRCNN-TensorFlow/releases/download/1.1"
ANIME4K_BASE="https://raw.githubusercontent.com/bloc97/Anime4K/master/glsl/Upscale-CNN"
# agyild publishes the mpv ports as gists, not as a repository.
FSR_URL="${FSR_GLSL_URL:-https://gist.githubusercontent.com/agyild/82219c545228d70c5604f865ce0b0ce5/raw/FSR.glsl}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch () {  # $1 = url, $2 = destination
    local url="$1" dest="$2" name
    name="$(basename "$dest")"
    if [[ -s "$dest" ]]; then
        echo "  = ${name} (already present)"
        return 0
    fi
    echo "  + ${name}"
    if ! curl -fsSL "$url" -o "${dest}.tmp"; then
        echo "    !! download failed: ${url}" >&2
        rm -f "${dest}.tmp"
        return 1
    fi
    # A truncated shader is worse than an absent one: the plugin treats a missing file as "level
    # unavailable" and degrades cleanly, but a half-written file would load and produce garbage.
    if [[ "$(wc -c < "${dest}.tmp")" -lt 5000 ]]; then
        echo "    !! downloaded file is implausibly small, refusing to install" >&2
        rm -f "${dest}.tmp"
        return 1
    fi
    mv "${dest}.tmp" "$dest"
}

mkdir -p "$DIR"

echo "FSRCNNX super-resolution (igv, LGPL-3.0-or-later):"
fetch "${FSRCNNX_BASE}/FSRCNNX_x2_8-0-4-1.glsl"  "${DIR}/FSRCNNX_x2_8-0-4-1.glsl"
fetch "${FSRCNNX_BASE}/FSRCNNX_x2_16-0-4-1.glsl" "${DIR}/FSRCNNX_x2_16-0-4-1.glsl"

echo "Anime4K super-resolution (bloc97, MIT):"
fetch "${ANIME4K_BASE}/Anime4K_Upscale_CNN_x2_S.glsl" "${DIR}/Anime4K_Upscale_CNN_x2_S.glsl" || true
fetch "${ANIME4K_BASE}/Anime4K_Upscale_CNN_x2_M.glsl" "${DIR}/Anime4K_Upscale_CNN_x2_M.glsl" || true

echo "RCAS sharpening (derived from AMD FidelityFX FSR v1.0.2, MIT):"
# FSR_GLSL=/some/FSR.glsl installs from a local copy instead, for an offline build.
if [[ -n "${FSR_GLSL:-}" ]]; then
    echo "  using local ${FSR_GLSL}"
    cp "$FSR_GLSL" "$TMP/FSR.glsl"
else
    echo "  fetching ${FSR_URL}"
    curl -fsSL "$FSR_URL" -o "$TMP/FSR.glsl"
fi

grep -q 'FidelityFX FSR v1.0.2 by AMD' "$TMP/FSR.glsl" \
    || { echo "  !! that is not agyild's FSR.glsl v1.0.2" >&2; exit 1; }
grep -q 'Permission is hereby granted, free of charge' "$TMP/FSR.glsl" \
    || { echo "  !! MIT licence header missing from the fetched file" >&2; exit 1; }

bash "${ROOT}/shaders/make-rcas.sh" "$TMP/FSR.glsl" "$TMP"
install -m 0644 "$TMP"/RCAS-2.0.glsl "$TMP"/RCAS-1.7.glsl "$TMP"/RCAS-1.4.glsl "$DIR/"
echo "  + RCAS-2.0.glsl RCAS-1.7.glsl RCAS-1.4.glsl"

echo "CAS sharpening (this project, superseded by RCAS but kept as a rollback path):"
for f in "${ROOT}"/shaders/CAS-*.glsl; do
    echo "  + $(basename "$f")"
    install -m 0644 "$f" "${DIR}/$(basename "$f")"
done

chmod 0755 "$DIR"
echo
echo "Installed into ${DIR}:"
ls -1 "$DIR"
echo
echo "Note: the 'fsrcnnx-max' level expects FSRCNN_x2_r1_32-0-2.glsl, deliberately not installed -"
echo "it measured no better than the lighter weights at roughly twice the GPU cost."
