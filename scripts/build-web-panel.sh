#!/bin/bash
# Builds web/gpu-upscale.js (the single file the injector actually publishes,
# scripts/jellyfin-gpuupscale-webinject copies exactly this path) from the real ES modules in
# web/src/. The source is honest modules with real import/export (web/src/bootstrap.js is the
# entry point; web/src/{lib,model,controller,view}/*.js are the modules it pulls in); esbuild
# bundles that module graph into ONE plain IIFE with no runtime module system, because
# jellyfin-web's injection context does not support ES module import/export at this stage.
#
# esbuild is a BUILD-TIME-ONLY dependency, installed under web/node_modules (gitignored) from
# web/package-lock.json, which IS checked in. It never appears in the runtime output and is never
# needed on the server/CT114 - only on whichever machine runs this script. Node.js (and thus npm)
# is required on that build machine to install and run esbuild; nothing else is.
#
# Usage: scripts/build-web-panel.sh
#   Regenerates web/gpu-upscale.js from web/src/bootstrap.js and everything it imports. Does NOT
#   touch VERSION/the cache-buster in scripts/jellyfin-gpuupscale-webinject and does NOT publish
#   or copy the output anywhere - that stays a separate, explicit step. web/gpu-upscale.js is
#   gitignored, NOT committed: run this script (after `npm install` in web/, once per build
#   machine) wherever the output is actually needed - scripts/proxmox-build.sh and INSTALL.md's
#   manual steps both do this before publishing.
set -euo pipefail

cd "$(dirname "$0")/.."

WEB_DIR=web
ENTRY=web/src/bootstrap.js
OUT=web/gpu-upscale.js
BANNER=web/src/banner.txt

if [ ! -f "$ENTRY" ]; then
    echo "build-web-panel: entry point $ENTRY not found" >&2
    exit 1
fi

if [ ! -d "$WEB_DIR/node_modules/esbuild" ]; then
    echo "build-web-panel: esbuild not installed under $WEB_DIR/node_modules; run 'npm install' in $WEB_DIR first" >&2
    exit 1
fi

(
    cd "$WEB_DIR"
    ./node_modules/.bin/esbuild src/bootstrap.js \
        --bundle \
        --format=iife \
        --target=es2018 \
        --banner:js="$(cat src/banner.txt)" \
        --outfile=gpu-upscale.js.tmp
)

mv "$OUT.tmp" "$OUT"
echo "build-web-panel: wrote $OUT from $ENTRY (esbuild, bundled)"
