#!/bin/bash
# One-command build and deploy, run INSIDE the Proxmox LXC that hosts Jellyfin.
#
# Pulls the latest commit from GitHub, builds both assemblies, stages them, and activates. The
# expensive and dangerous parts are opt-in, because they are not what a normal code change needs:
#
#   --with-ffmpeg   rebuild the patched ffmpeg binary carrying the five custom filters (slow)
#   --with-shaders  re-fetch and re-derive the shader set
#   --no-activate   build and stage only, leave the running server alone
#   --force         restart even while transcodes are in flight
#
# The ordering is deliberate. Everything that can fail is done BEFORE anything the running server
# can see, so a failed build leaves the live install untouched rather than half-replaced.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/sanchitd5/jellyfin-gpu-upscale}"
REPO_DIR="${REPO_DIR:-/opt/jellyfin-gpu-upscale}"
BRANCH="${BRANCH:-main}"
JELLYFIN_BIN="${JELLYFIN_BIN:-/usr/lib/jellyfin/bin}"
DOTNET_ROOT="${DOTNET_ROOT:-/opt/dotnet}"
PATCH_DIR=/usr/lib/jellyfin-gpuupscale
STAGE="$PATCH_DIR/staged"
PATCHED_FFMPEG="${PATCHED_FFMPEG:-/usr/lib/jellyfin-ffmpeg-oidn/bin/ffmpeg}"

WITH_FFMPEG=0
WITH_SHADERS=0
ACTIVATE=1
FORCE=0

for arg in "$@"; do
    case "$arg" in
        --with-ffmpeg)  WITH_FFMPEG=1 ;;
        --with-shaders) WITH_SHADERS=1 ;;
        --no-activate)  ACTIVATE=0 ;;
        --force)        FORCE=1 ;;
        -h|--help)      sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

[ "$(id -u)" = "0" ] || { echo "run as root: this writes to /usr/lib and restarts jellyfin" >&2; exit 1; }

export DOTNET_ROOT
export PATH="$DOTNET_ROOT:$PATH"
command -v dotnet >/dev/null || { echo "dotnet not on PATH (set DOTNET_ROOT, currently $DOTNET_ROOT)" >&2; exit 1; }
[ -d "$JELLYFIN_BIN" ] || { echo "$JELLYFIN_BIN missing: the projects reference the server's own assemblies" >&2; exit 1; }

# ---- 1. source ------------------------------------------------------------------------------
if [ -d "$REPO_DIR/.git" ]; then
    git -C "$REPO_DIR" fetch --quiet origin "$BRANCH"
    # Hard reset rather than merge: this checkout is a build tree, not somewhere to edit.
    git -C "$REPO_DIR" reset --quiet --hard "origin/$BRANCH"
else
    git clone --quiet --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
fi
echo "==> building $(git -C "$REPO_DIR" log -1 --format='%h %s')"

cd "$REPO_DIR"

# ---- 2. shaders (optional) ------------------------------------------------------------------
if [ "$WITH_SHADERS" = "1" ]; then
    echo "==> shaders"
    ./scripts/install-shaders.sh
fi

# ---- 3. patched ffmpeg (optional) ------------------------------------------------------------
# All five filters must survive a rebuild. The shim asks the binary what it carries and strips
# nodes it lacks, so a dropped filter degrades silently rather than failing loudly: check here
# instead, while the old binary is still the one in use.
if [ "$WITH_FFMPEG" = "1" ]; then
    echo "==> ffmpeg (slow)"
    ./scripts/build-ffmpeg.sh
    missing=""
    for f in oidn optix ort fsr2 dlss; do
        "$PATCHED_FFMPEG" -hide_banner -filters 2>/dev/null | grep -qE "^ *[TSC.]* *$f " || missing="$missing $f"
    done
    if [ -n "$missing" ]; then
        echo "==> FAILED: the rebuilt ffmpeg is missing:$missing" >&2
        echo "    the previous binary is still in place; do not deploy this build" >&2
        exit 1
    fi
    echo "    all five custom filters present"
fi

# ---- 4. assemblies ---------------------------------------------------------------------------
# Built into the repo tree first. Nothing has touched the live install at this point, so a
# compile error costs nothing but time.
echo "==> assemblies"
rm -rf ./out ./out-patcher
dotnet publish src         -c Release -p:JellyfinBin="$JELLYFIN_BIN" -o ./out         --nologo -v q
dotnet publish src/patcher -c Release -p:JellyfinBin="$JELLYFIN_BIN" -o ./out-patcher --nologo -v q

# ---- 5. stage --------------------------------------------------------------------------------
# jellyfin-gpuupscale-activate swaps these four files into place atomically and keeps a rollback
# copy, so staging is all this script does with them.
echo "==> staging"
mkdir -p "$STAGE"
cp -a out/Jellyfin.Plugin.GpuUpscale.dll                  "$STAGE/Jellyfin.Plugin.GpuUpscale.dll"
cp -a out/Jellyfin.Plugin.GpuUpscale.deps.json            "$STAGE/Jellyfin.Plugin.GpuUpscale.deps.json"
cp -a out-patcher/Jellyfin.Plugin.GpuUpscale.Patcher.dll  "$STAGE/Jellyfin.Plugin.GpuUpscale.Patcher.dll"
cp -a out-patcher/0Harmony.dll                            "$STAGE/0Harmony.dll"

# The canonical client script. The web copy is written from this one by the injector, so this is
# the one that has to be current; editing the web copy gets reverted while the cache-buster still
# advances. Temp-then-rename for the same reason the injector does it: it is read by a live server.
install -m 0644 web/gpu-upscale.js "$PATCH_DIR/gpu-upscale.js.tmp.$$"
mv "$PATCH_DIR/gpu-upscale.js.tmp.$$" "$PATCH_DIR/gpu-upscale.js"

# Keep the deployed helper scripts in step with the checkout. Client-side only, no restart needed.
install -m 0755 scripts/jellyfin-gpuupscale-webinject /usr/local/sbin/jellyfin-gpuupscale-webinject
install -m 0755 scripts/jellyfin-gpuupscale-activate  /usr/local/sbin/jellyfin-gpuupscale-activate
install -m 0644 scripts/99-jellyfin-gpuupscale        /etc/apt/apt.conf.d/99-jellyfin-gpuupscale

# ---- 6. client -------------------------------------------------------------------------------
# Safe while the server runs: it replaces a static file and an index.html tag, nothing loaded.
echo "==> web injector"
/usr/local/sbin/jellyfin-gpuupscale-webinject

if [ "$ACTIVATE" = "0" ]; then
    echo "==> staged in $STAGE, not activated. Run jellyfin-gpuupscale-activate when ready."
    exit 0
fi

# ---- 7. activate -----------------------------------------------------------------------------
# A restart kills in-flight transcodes, cancels library scans and logs dashboard users out. Someone
# may be watching something right now, so look before doing it.
live=$(pgrep -fc 'jellyfin-ffmpeg.*transcode' || true)
if [ "${live:-0}" -gt 0 ] && [ "$FORCE" = "0" ]; then
    echo "==> $live transcode(s) in flight; not restarting." >&2
    echo "    the build is staged in $STAGE. Re-run with --force, or activate later with:" >&2
    echo "    jellyfin-gpuupscale-activate" >&2
    exit 3
fi

echo "==> activating"
/usr/local/sbin/jellyfin-gpuupscale-activate

# ---- 8. what actually happened ---------------------------------------------------------------
# A clean restart is not proof. This says whether the patches resolved; only a served segment says
# whether upscaling works, and that needs someone to play something.
echo "==> patch status"
journalctl -u jellyfin --since "-2 min" --no-pager | grep -i 'gpuupscale' | tail -8 || \
    echo "    no GpuUpscale lines in the log yet; check journalctl -u jellyfin"
echo
echo "Deployed. Still unproven: play something and probe the served segment."
echo "  journalctl -u jellyfin | grep libplacebo"
