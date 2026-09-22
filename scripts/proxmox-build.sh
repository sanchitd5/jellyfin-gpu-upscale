#!/bin/bash
# One-command build and deploy, run INSIDE the Proxmox LXC that hosts Jellyfin.
#
#   --ffmpeg-prefix=DIR  where the patched ffmpeg lives (default /usr/lib/jellyfin-ffmpeg-oidn)
#   --plugin-version=V   plugin directory version (default 1.0.0.0)
#   --repo=URL           git remote (default this project on GitHub)
#   --repo-dir=DIR       build checkout (default /opt/jellyfin-gpu-upscale)
#   --branch=NAME        branch to build (default main)
#   --jellyfin-bin=DIR   Jellyfin's assemblies (default /usr/lib/jellyfin/bin)
#   --dotnet-root=DIR    dotnet SDK (default /opt/dotnet)
#   --with-ffmpeg        rebuild the patched ffmpeg carrying the five custom filters (slow)
#   --with-shaders       re-fetch and re-derive the shader set
#   --no-activate        build and stage only, leave the running server alone
#   --keep-transcodes    refuse to restart while transcodes are in flight, instead of ending them
#
# Ordering is the whole point. Everything that can fail happens before anything the running
# server can see, and the client script is published only after the server half is live, because
# a new client talking to an old plugin sends axes nothing reads and says nothing about it.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/sanchitd5/jellyfin-gpu-upscale}"
REPO_DIR="${REPO_DIR:-/opt/jellyfin-gpu-upscale}"
BRANCH="${BRANCH:-main}"
JELLYFIN_BIN="${JELLYFIN_BIN:-/usr/lib/jellyfin/bin}"
DOTNET_ROOT="${DOTNET_ROOT:-/opt/dotnet}"
FFMPEG_PREFIX="${FFMPEG_PREFIX:-/usr/lib/jellyfin-ffmpeg-oidn}"
PLUGIN_VERSION="${PLUGIN_VERSION:-1.0.0.0}"
PATCH_DIR=/usr/lib/jellyfin-gpuupscale

WITH_FFMPEG=0
WITH_SHADERS=0
ACTIVATE=1
KEEP_TRANSCODES=0

for arg in "$@"; do
    case "$arg" in
        --ffmpeg-prefix=*)  FFMPEG_PREFIX="${arg#*=}" ;;
        --plugin-version=*) PLUGIN_VERSION="${arg#*=}" ;;
        --repo=*)           REPO_URL="${arg#*=}" ;;
        --repo-dir=*)       REPO_DIR="${arg#*=}" ;;
        --branch=*)         BRANCH="${arg#*=}" ;;
        --jellyfin-bin=*)   JELLYFIN_BIN="${arg#*=}" ;;
        --dotnet-root=*)    DOTNET_ROOT="${arg#*=}" ;;
        --with-ffmpeg)      WITH_FFMPEG=1 ;;
        --with-shaders)     WITH_SHADERS=1 ;;
        --no-activate)      ACTIVATE=0 ;;
        --keep-transcodes)  KEEP_TRANSCODES=1 ;;
        -h|--help)          sed -n '2,19p' "$0"; exit 0 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

PATCHED_FFMPEG="$FFMPEG_PREFIX/ffmpeg"
STAGE="$PATCH_DIR/staged"
STAGE_NEW="$PATCH_DIR/staged.new"
PLUGIN_DIR="/var/lib/jellyfin/plugins/GpuUpscale_$PLUGIN_VERSION"

[ "$(id -u)" = "0" ] || { echo "run as root: this writes to /usr/lib and restarts jellyfin" >&2; exit 1; }

export DOTNET_ROOT
export PATH="$DOTNET_ROOT:$PATH"
command -v dotnet >/dev/null || { echo "dotnet not on PATH (--dotnet-root, currently $DOTNET_ROOT)" >&2; exit 1; }
[ -d "$JELLYFIN_BIN" ] || { echo "$JELLYFIN_BIN missing: the projects reference the server's own assemblies" >&2; exit 1; }

# ---- 1. source ------------------------------------------------------------------------------
if [ -d "$REPO_DIR/.git" ]; then
    have="$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null || echo none)"
    [ "$have" = "$REPO_URL" ] || { echo "$REPO_DIR tracks $have, not $REPO_URL" >&2; exit 1; }
    git -C "$REPO_DIR" fetch --quiet origin "$BRANCH"
    # Hard reset and clean: this checkout is a build tree, not somewhere to edit. clean matters
    # because a vf_*.c deleted upstream but left on disk would silently rebuild into the binary.
    git -C "$REPO_DIR" reset --quiet --hard "origin/$BRANCH"
    git -C "$REPO_DIR" clean -qfd
elif [ -e "$REPO_DIR" ]; then
    echo "$REPO_DIR exists but is not a git checkout; move it aside or pass --repo-dir" >&2
    exit 1
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
# build-ffmpeg.sh installs over the live binary, so the check has to be able to put the old one
# back: a rebuild that drops a filter is worse than no rebuild, because the shim strips the node
# it cannot find and the session plays on quietly without it.
if [ "$WITH_FFMPEG" = "1" ]; then
    echo "==> ffmpeg (slow)"
    if [ -f "$PATCHED_FFMPEG" ]; then
        cp -a "$PATCHED_FFMPEG" "$PATCHED_FFMPEG.prev"
        echo "    previous binary saved as $PATCHED_FFMPEG.prev"
    fi

    # Every filter switched on, because the check below refuses to deploy a binary missing any of
    # them. Asking for one and then demanding five is how this script spent a build producing a
    # binary it then rejected. build-ffmpeg.sh fails in preflight, in seconds, when an SDK is not
    # where it expects, and each WITH_* and SDK path here can be overridden from the environment.
    # WITH_VSR is NOT defaulted to 1 like the other five: it is new, unverified beyond "builds and
    # registers" (the SDK's own TensorRT model files are a separate NGC download this project does
    # not have - see VSR.md), so it stays opt-in rather than mandatory-by-default. Pass WITH_VSR=1
    # explicitly to include it.
    # build-ffmpeg.sh's own verify step `die`s on a missing filter, which under this script's
    # `set -e` would abort straight past the restore logic below and leave the broken binary
    # installed - happened twice on this exact VSR task before this guard existed. `|| true`
    # keeps control here so the checks after this always run against whatever got installed.
    PREFIX="$FFMPEG_PREFIX" \
        WITH_OIDN="${WITH_OIDN:-1}" \
        WITH_OPTIX="${WITH_OPTIX:-1}" \
        WITH_ORT="${WITH_ORT:-1}" \
        WITH_FSR2="${WITH_FSR2:-1}" \
        WITH_DLSS="${WITH_DLSS:-1}" \
        WITH_VSR="${WITH_VSR:-0}" \
        OPTIX_SDK="${OPTIX_SDK:-/root/gameupscale/optix-dev-8.1.0}" \
        ./scripts/build-ffmpeg.sh || true

    "$PATCHED_FFMPEG" -hide_banner -version >/dev/null 2>&1 || {
        echo "==> FAILED: $PATCHED_FFMPEG will not run at all (check its library paths)" >&2
        [ -f "$PATCHED_FFMPEG.prev" ] && mv "$PATCHED_FFMPEG.prev" "$PATCHED_FFMPEG" && echo "    restored the previous binary" >&2
        exit 1
    }

    required_filters="oidn optix ort fsr2 dlss"
    [ "${WITH_VSR:-0}" = "1" ] && required_filters="$required_filters vsr"
    missing=""
    for f in $required_filters; do
        "$PATCHED_FFMPEG" -hide_banner -filters 2>/dev/null | grep -qE "^ *[TSC.]* *$f " || missing="$missing $f"
    done
    if [ -n "$missing" ]; then
        echo "==> FAILED: the rebuilt ffmpeg is missing:$missing" >&2
        if [ -f "$PATCHED_FFMPEG.prev" ]; then
            mv "$PATCHED_FFMPEG.prev" "$PATCHED_FFMPEG"
            echo "    restored the previous binary; nothing was deployed" >&2
        else
            echo "    no previous binary to restore: $PATCHED_FFMPEG is now degraded" >&2
        fi
        exit 1
    fi
    echo "    all five custom filters present$([ "${WITH_VSR:-0}" = "1" ] && echo ", plus vsr")"
    # The snapshot STAYS. Deleting it on success left no way back from the case this check cannot
    # see: a binary that builds, installs and lists all five filters, and then fails against the
    # driver on the first frame. OptiX, NGX and NVOFA all negotiate at runtime, so linking proves
    # only that the symbols resolved. AGENTS.md promises rollback copies exist beside the binary;
    # they have to actually exist for that to be true.
    if [ -f "$PATCHED_FFMPEG.prev" ]; then
        echo "    rollback kept at $PATCHED_FFMPEG.prev (mv it back over $PATCHED_FFMPEG to undo)"
    fi
fi

# ---- 4. assemblies ---------------------------------------------------------------------------
# Built into the repo tree. Nothing has touched the live install yet, so a compile error costs
# only time.
echo "==> assemblies"
rm -rf ./out ./out-patcher
dotnet publish src         -c Release -p:JellyfinBin="$JELLYFIN_BIN" -o ./out         --nologo -v q
dotnet publish src/patcher -c Release -p:JellyfinBin="$JELLYFIN_BIN" -o ./out-patcher --nologo -v q

# ---- 5. stage --------------------------------------------------------------------------------
# Into a new directory that replaces the old one in one move, so an interrupted run cannot leave
# a new plugin DLL staged beside the previous run's patcher DLL for a later activate to deploy.
echo "==> staging"
rm -rf "$STAGE_NEW"
mkdir -p "$STAGE_NEW"
cp -a out/Jellyfin.Plugin.GpuUpscale.dll                  "$STAGE_NEW/"
cp -a out/Jellyfin.Plugin.GpuUpscale.deps.json            "$STAGE_NEW/"
cp -a out-patcher/Jellyfin.Plugin.GpuUpscale.Patcher.dll  "$STAGE_NEW/"
cp -a out-patcher/0Harmony.dll                            "$STAGE_NEW/"
rm -rf "$STAGE"
mv "$STAGE_NEW" "$STAGE"

# First run on a clean box: the plugin directory and its meta.json have to exist before activate
# can back anything up, and Jellyfin will not load a plugin whose meta.json is absent.
if [ ! -d "$PLUGIN_DIR" ]; then
    echo "==> first install: creating $PLUGIN_DIR"
    mkdir -p "$PLUGIN_DIR"
    cat > "$PLUGIN_DIR/meta.json" <<META
{
  "guid": "6f2a9c31-4d7b-4e2a-9d15-8a1c0b7e3f44",
  "name": "GPU Upscale",
  "version": "$PLUGIN_VERSION",
  "targetAbi": "12.1.0.0",
  "owner": "",
  "overview": "Realtime GPU super-resolution upscaling",
  "category": "General"
}
META
    cp -a "$STAGE/Jellyfin.Plugin.GpuUpscale.dll" "$STAGE/Jellyfin.Plugin.GpuUpscale.deps.json" "$PLUGIN_DIR/"
    cp -a "$STAGE/Jellyfin.Plugin.GpuUpscale.Patcher.dll" "$STAGE/0Harmony.dll" "$PATCH_DIR/"
    chown -R jellyfin:jellyfin "$PLUGIN_DIR"
fi

# Keep the previous activate script: it is what a rollback runs, so installing a new one and
# immediately executing it should not be the only copy on the box.
[ -f /usr/local/sbin/jellyfin-gpuupscale-activate ] && \
    cp -a /usr/local/sbin/jellyfin-gpuupscale-activate /usr/local/sbin/jellyfin-gpuupscale-activate.prev
install -m 0755 scripts/jellyfin-gpuupscale-webinject /usr/local/sbin/jellyfin-gpuupscale-webinject
install -m 0755 scripts/jellyfin-gpuupscale-activate  /usr/local/sbin/jellyfin-gpuupscale-activate

# An unparseable fragment here breaks every apt operation on the box, not just this project.
if [ -f /etc/apt/apt.conf.d/99-jellyfin-gpuupscale ]; then
    cp -a /etc/apt/apt.conf.d/99-jellyfin-gpuupscale /etc/apt/apt.conf.d/99-jellyfin-gpuupscale.prev
fi
install -m 0644 scripts/99-jellyfin-gpuupscale /etc/apt/apt.conf.d/99-jellyfin-gpuupscale
if ! apt-config dump >/dev/null 2>&1; then
    echo "==> apt.conf fragment is invalid; restoring the previous one" >&2
    if [ -f /etc/apt/apt.conf.d/99-jellyfin-gpuupscale.prev ]; then
        mv /etc/apt/apt.conf.d/99-jellyfin-gpuupscale.prev /etc/apt/apt.conf.d/99-jellyfin-gpuupscale
    else
        rm -f /etc/apt/apt.conf.d/99-jellyfin-gpuupscale
    fi
    exit 1
fi
rm -f /etc/apt/apt.conf.d/99-jellyfin-gpuupscale.prev

if [ "$ACTIVATE" = "0" ]; then
    echo "==> staged in $STAGE, not activated, client script left as it was."
    echo "    activate when ready: jellyfin-gpuupscale-activate"
    exit 0
fi

# ---- 6. end what is playing ------------------------------------------------------------------
# The restart ends these anyway. Doing it here, scoped to the processes inside jellyfin's own
# service cgroup, means nothing else on the box is touched and the count is reported rather
# than discovered afterwards in a support question.
transcode_pids() {
    local cg=/sys/fs/cgroup/system.slice/jellyfin.service/cgroup.procs
    [ -r "$cg" ] || return 0
    local pid
    while read -r pid; do
        [ -r "/proc/$pid/comm" ] || continue
        case "$(cat "/proc/$pid/comm")" in *ffmpeg*) echo "$pid" ;; esac
    done < "$cg"
}

pids="$(transcode_pids || true)"
count="$(printf '%s' "$pids" | grep -c . || true)"
if [ "${count:-0}" -gt 0 ]; then
    if [ "$KEEP_TRANSCODES" = "1" ]; then
        echo "==> $count transcode(s) in flight and --keep-transcodes given; not restarting." >&2
        echo "    the build is staged in $STAGE. Activate later with: jellyfin-gpuupscale-activate" >&2
        exit 3
    fi
    echo "==> ending $count transcode(s) before the restart"
    # shellcheck disable=SC2086
    kill -TERM $pids 2>/dev/null || true
    for _ in 1 2 3 4 5; do
        sleep 1
        still="$(transcode_pids || true)"
        [ -z "$still" ] && break
    done
    still="$(transcode_pids || true)"
    if [ -n "$still" ]; then
        # shellcheck disable=SC2086
        kill -KILL $still 2>/dev/null || true
    fi
fi

# ---- 7. activate -----------------------------------------------------------------------------
echo "==> activating"
/usr/local/sbin/jellyfin-gpuupscale-activate

# ---- 8. client -------------------------------------------------------------------------------
# Only now. A client published ahead of the server sends axes the running plugin does not read,
# silently, which is this project's oldest failure and the hardest to see.
echo "==> publishing the client script"
install -m 0644 web/gpu-upscale.js "$PATCH_DIR/gpu-upscale.js.tmp.$$"
mv "$PATCH_DIR/gpu-upscale.js.tmp.$$" "$PATCH_DIR/gpu-upscale.js"
/usr/local/sbin/jellyfin-gpuupscale-webinject

# ---- 9. what actually happened ---------------------------------------------------------------
echo "==> patch status"
journalctl -u jellyfin --since "-2 min" --no-pager | grep -i 'gpuupscale' | tail -8 || \
    echo "    no GpuUpscale lines in the log yet; check journalctl -u jellyfin"
echo
echo "Deployed. Still unproven: play something and probe the served segment."
echo "  journalctl -u jellyfin | grep libplacebo"
