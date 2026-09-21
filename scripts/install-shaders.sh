#!/usr/bin/env bash
# Install the shaders GPU Upscale needs.
#
# FSRCNNX is igv's work, released under LGPL-3.0-or-later as part of FSRCNN-TensorFlow. It is NOT
# redistributed here; this script fetches it from the upstream releases so the licence and
# attribution stay with the author:   https://github.com/igv/FSRCNN-TensorFlow
#
# Anime4K is bloc97's work, MIT licensed:   https://github.com/bloc97/Anime4K
# It is likewise fetched rather than vendored.
#
# The CAS sharpening shaders in ../shaders are this project's own work.

set -euo pipefail

SHADER_DIR="${SHADER_DIR:-/usr/share/jellyfin-shaders}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

FSRCNNX_BASE="https://github.com/igv/FSRCNN-TensorFlow/releases/download/1.1"
ANIME4K_BASE="https://raw.githubusercontent.com/bloc97/Anime4K/master/glsl/Upscale-CNN"

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

echo "Installing shaders into ${SHADER_DIR}"
mkdir -p "$SHADER_DIR"

echo "FSRCNNX (igv, LGPL-3.0-or-later):"
fetch "${FSRCNNX_BASE}/FSRCNNX_x2_8-0-4-1.glsl"  "${SHADER_DIR}/FSRCNNX_x2_8-0-4-1.glsl"
fetch "${FSRCNNX_BASE}/FSRCNNX_x2_16-0-4-1.glsl" "${SHADER_DIR}/FSRCNNX_x2_16-0-4-1.glsl"

echo "Anime4K (bloc97, MIT):"
fetch "${ANIME4K_BASE}/Anime4K_Upscale_CNN_x2_S.glsl" "${SHADER_DIR}/Anime4K_Upscale_CNN_x2_S.glsl" || true
fetch "${ANIME4K_BASE}/Anime4K_Upscale_CNN_x2_M.glsl" "${SHADER_DIR}/Anime4K_Upscale_CNN_x2_M.glsl" || true

echo "CAS sharpening (this project):"
for f in "${REPO_ROOT}"/shaders/CAS-*.glsl; do
  echo "  + $(basename "$f")"
  install -m 0644 "$f" "${SHADER_DIR}/$(basename "$f")"
done

chmod 0755 "$SHADER_DIR"
echo
echo "Installed:"
ls -1 "$SHADER_DIR"
echo
echo "Note: the 'fsrcnnx-max' level expects FSRCNN_x2_r1_32-0-2.glsl, deliberately not installed -"
echo "it measured no better than the lighter weights at roughly twice the GPU cost."
