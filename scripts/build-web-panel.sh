#!/bin/bash
# Builds web/gpu-upscale.js (the single file the injector actually publishes,
# scripts/jellyfin-gpuupscale-webinject copies exactly this path) from the source modules in
# web/src/. Plain concatenation, no dependency: the runtime script is one global-scope IIFE
# (jellyfin-web's injection context does not support ES module import/export at this stage), and
# the modules are just that IIFE's body pre-split at real seams, in numeric-prefix order, sharing
# one function/variable scope exactly as the unsplit file did.
#
# Usage: scripts/build-web-panel.sh
#   Regenerates web/gpu-upscale.js from web/src/*.js. Does NOT touch VERSION in
#   scripts/jellyfin-gpuupscale-webinject and does NOT publish or copy the output anywhere -
#   that stays a separate, explicit step. Commit the rebuilt web/gpu-upscale.js like any other
#   generated-but-checked-in artifact.
set -euo pipefail

cd "$(dirname "$0")/.."

SRC_DIR=web/src
OUT=web/gpu-upscale.js

shopt -s nullglob
files=("$SRC_DIR"/*.js)
shopt -u nullglob

if [ "${#files[@]}" -eq 0 ]; then
    echo "build-web-panel: no source files found in $SRC_DIR" >&2
    exit 1
fi

# Sorted lexically, which is why every module file carries a numeric prefix: that prefix IS the
# build order, not a naming decoration.
IFS=$'\n' sorted=($(printf '%s\n' "${files[@]}" | sort))
unset IFS

{
    echo "// GENERATED FILE. Do not edit directly."
    echo "// Source lives in web/src/*.js; rebuild with scripts/build-web-panel.sh."
    echo "// See CLAUDE.md, \"Before you change the client\", for the module layout."
    for f in "${sorted[@]}"; do
        cat "$f"
    done
} > "$OUT.tmp"

mv "$OUT.tmp" "$OUT"
echo "build-web-panel: wrote $OUT from ${#sorted[@]} module(s)"
