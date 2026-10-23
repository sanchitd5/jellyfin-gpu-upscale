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

REPO_URL="${REPO_URL:-https://github.com/sanchitd5/jellyfin-plus}"
REPO_DIR="${REPO_DIR:-/opt/jellyfin-gpu-upscale}"
BRANCH="${BRANCH:-main}"
JELLYFIN_BIN="${JELLYFIN_BIN:-/usr/lib/jellyfin/bin}"
DOTNET_ROOT="${DOTNET_ROOT:-/opt/dotnet}"
FFMPEG_PREFIX="${FFMPEG_PREFIX:-/usr/lib/jellyfin-ffmpeg-oidn}"
PLUGIN_VERSION="${PLUGIN_VERSION:-1.0.0.0}"
PATCH_DIR=/usr/lib/jellyfin-plus

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
PLUGIN_DIR="/var/lib/jellyfin/plugins/JellyfinPlus_$PLUGIN_VERSION"

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
    # WITH_MAXINE_VSR (Maxine vsr) is RETIRED: NvVFX_Load hangs and it never produced a frame (VSR.md).
    # Refused before the snapshot, so a stray WITH_MAXINE_VSR=1 never touches the live binary.
    # build-ffmpeg.sh carries the same gate; MAXINE_VSR_UNRETIRE=1 overrides both.
    if [ -n "${WITH_VSR:-}" ]; then
        echo "==> FAILED: WITH_VSR was renamed WITH_MAXINE_VSR (Maxine, retired). RTX VSR will be WITH_RTXCUDA (planned, TASK.md 2.2)." >&2
        exit 1
    fi
    if [ "${WITH_MAXINE_VSR:-0}" = "1" ] && [ "${MAXINE_VSR_UNRETIRE:-0}" != "1" ]; then
        echo "==> FAILED: WITH_MAXINE_VSR=1 but Maxine vsr is retired (set MAXINE_VSR_UNRETIRE=1 to override)" >&2
        exit 1
    fi
    if [ -f "$PATCHED_FFMPEG" ]; then
        cp -a "$PATCHED_FFMPEG" "$PATCHED_FFMPEG.prev"
        echo "    previous binary saved as $PATCHED_FFMPEG.prev"
    fi

    # Every filter switched on, because the check below refuses to deploy a binary missing any of
    # them. Asking for one and then demanding five is how this script spent a build producing a
    # binary it then rejected. build-ffmpeg.sh fails in preflight, in seconds, when an SDK is not
    # where it expects, and each WITH_* and SDK path here can be overridden from the environment.
    # build-ffmpeg.sh's own verify step `die`s on a missing filter, which under this script's
    # `set -e` would abort straight past the restore logic below and leave the broken binary
    # installed - happened twice on this exact VSR task before this guard existed. Capturing the
    # exit status keeps control here, and the restore logic below acts on it.
    # WITH_RTXDLPP/WITH_RTXVSR default on here too: this project only ever builds for an
    # NVIDIA CUDA target (see AGENTS.md), and both filters' prerequisites (the nvdlppx.dll/
    # nvaivpx.dll PE blobs, clang-18 w/ NVPTX) are ordinary standing requirements on that
    # target, same class as OPTIX_SDK below - not gated behind an NGC login like the DLSS
    # runtime or Maxine VSR are. They stay OUT of `required_filters` below deliberately:
    # AGENTS.md is explicit these two are not part of the mandatory five, so a box missing
    # their DLLs still gets a valid deploy, just without dlpp_rtcuda/vsr_rtcuda compiled in.
    PREFIX="$FFMPEG_PREFIX" \
        WITH_OIDN="${WITH_OIDN:-1}" \
        WITH_OPTIX="${WITH_OPTIX:-1}" \
        WITH_ORT="${WITH_ORT:-1}" \
        WITH_FSR2="${WITH_FSR2:-1}" \
        WITH_DLSS="${WITH_DLSS:-1}" \
        WITH_MAXINE_VSR="${WITH_MAXINE_VSR:-0}" \
        WITH_RTXDLPP="${WITH_RTXDLPP:-1}" \
        WITH_RTXVSR="${WITH_RTXVSR:-1}" \
        OPTIX_SDK="${OPTIX_SDK:-/root/gameupscale/optix-dev-8.1.0}" \
        ./scripts/build-ffmpeg.sh || build_rc=$?

    # `|| true` used to swallow this, so a build that bailed out (12G free needed, a held dpkg
    # lock) left the old binary in place, the filter check below passed against it, and the script
    # printed "Deployed" having built nothing. It also fails when build-ffmpeg.sh's own bridge
    # pixel test (scripts/test-hwmap-bridge.sh) rejects the new binary, which is already installed
    # by then, so the previous one has to come back.
    if [ "${build_rc:-0}" -ne 0 ]; then
        echo "==> FAILED: build-ffmpeg.sh exited $build_rc" >&2
        if [ -f "$PATCHED_FFMPEG.prev" ]; then
            mv "$PATCHED_FFMPEG.prev" "$PATCHED_FFMPEG"
            echo "    restored the previous binary; nothing was deployed" >&2
        fi
        exit 1
    fi

    "$PATCHED_FFMPEG" -hide_banner -version >/dev/null 2>&1 || {
        echo "==> FAILED: $PATCHED_FFMPEG will not run at all (check its library paths)" >&2
        [ -f "$PATCHED_FFMPEG.prev" ] && mv "$PATCHED_FFMPEG.prev" "$PATCHED_FFMPEG" && echo "    restored the previous binary" >&2
        exit 1
    }

    required_filters="oidn optix ort fsr2 dlss"
    [ "${WITH_MAXINE_VSR:-0}" = "1" ] && required_filters="$required_filters vsr"
    # Capture the list once. Piping ffmpeg into `grep -q` under pipefail reports failure whenever
    # grep exits on its first match while ffmpeg is still writing (SIGPIPE, status 141), so a
    # filter that is present can be counted as missing.
    filters_rc=0
    filters_out=$("$PATCHED_FFMPEG" -hide_banner -filters 2>/dev/null) || filters_rc=$?
    missing=""
    for f in $required_filters; do
        grep -qE "^ *[TSC.]* *$f " <<<"$filters_out" || missing="$missing $f"
    done
    if [ -n "$missing" ]; then
        echo "==> FAILED: the rebuilt ffmpeg is missing:$missing" >&2
        echo "    -filters exit status $filters_rc, $(printf '%s\n' "$filters_out" | wc -l) lines of output; custom filter lines seen:" >&2
        printf '%s\n' "$filters_out" | grep -E ' (oidn|optix|ort|fsr2|dlss|dlpp_rtcuda|vsr_rtcuda|transpose_cuda) ' | sed 's/^/      /' >&2 || true
        if [ -f "$PATCHED_FFMPEG.prev" ]; then
            mv "$PATCHED_FFMPEG.prev" "$PATCHED_FFMPEG"
            echo "    restored the previous binary; nothing was deployed" >&2
        else
            echo "    no previous binary to restore: $PATCHED_FFMPEG is now degraded" >&2
        fi
        exit 1
    fi
    echo "    all five custom filters present$([ "${WITH_MAXINE_VSR:-0}" = "1" ] && echo ", plus vsr")"
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

# ---- 4b. migrate a pre-rename install ------------------------------------------------------------
# A box still on the GPU Upscale layout (GpuUpscale_* plugin dir, /usr/lib/jellyfin-gpuupscale, the
# old sbin scripts and apt hook, gpu-upscale.js in the web root) is converted here, BEFORE staging
# and before anything below creates a JellyfinPlus_* directory. That ordering is the point: the
# first-install block further down would otherwise drop a second copy of the same plugin GUID
# beside the old one. The freshly built assemblies are handed over so the migration can put a
# complete plugin directory in place; it never leaves Jellyfin with zero or two copies, and it is a
# no-op (exit 0) on a box that is already migrated or was never installed. It changes files on
# disk only: the running server is not touched until step 7, so --no-activate is still safe.
# --skip-web: the old client script and its index.html tag keep serving the still-running old
# plugin until the restart; step 8's webinject strips them (it does so on every run) once the new
# server half is live, which is the same "client last" rule as everything else here.
echo "==> migrate (if the box predates the rename)"
./scripts/migrate-to-jellyfin-plus.sh --skip-web --plugin-version="$PLUGIN_VERSION" \
    --out="$REPO_DIR/out" --out-patcher="$REPO_DIR/out-patcher"

# ---- 5. stage --------------------------------------------------------------------------------
# Into a new directory that replaces the old one in one move, so an interrupted run cannot leave
# a new plugin DLL staged beside the previous run's patcher DLL for a later activate to deploy.
echo "==> staging"
rm -rf "$STAGE_NEW"
mkdir -p "$STAGE_NEW"
cp -a out/Jellyfin.Plugin.Plus.dll                  "$STAGE_NEW/"
cp -a out/Jellyfin.Plugin.Plus.deps.json            "$STAGE_NEW/"
cp -a out-patcher/Jellyfin.Plugin.Plus.Patcher.dll  "$STAGE_NEW/"
cp -a out-patcher/0Harmony.dll                      "$STAGE_NEW/"
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
  "name": "Jellyfin Plus",
  "version": "$PLUGIN_VERSION",
  "targetAbi": "12.3.0.0",
  "owner": "",
  "overview": "GPU video enhancement plus search, filtering and library quality-of-life improvements for Jellyfin.",
  "category": "General"
}
META
    cp -a "$STAGE/Jellyfin.Plugin.Plus.dll" "$STAGE/Jellyfin.Plugin.Plus.deps.json" "$PLUGIN_DIR/"
    cp -a "$STAGE/Jellyfin.Plugin.Plus.Patcher.dll" "$STAGE/0Harmony.dll" "$PATCH_DIR/"
    chown -R jellyfin:jellyfin "$PLUGIN_DIR"
fi

# An existing install keeps its meta.json. Raise a 12.1-era targetAbi to the version these assemblies
# are built against (targetAbi is the OLDEST server that loads the plugin, so 12.1.0.0 would still load
# on 12.3; this keeps a 12.3 build from being offered to a 12.1 server).
if [ -f "$PLUGIN_DIR/meta.json" ]; then
    sed -i 's/"targetAbi": *"12\.1\.0\.0"/"targetAbi": "12.3.0.0"/' "$PLUGIN_DIR/meta.json"
fi

# Keep the previous activate script: it is what a rollback runs, so installing a new one and
# immediately executing it should not be the only copy on the box.
[ -f /usr/local/sbin/jellyfin-plus-activate ] && \
    cp -a /usr/local/sbin/jellyfin-plus-activate /usr/local/sbin/jellyfin-plus-activate.prev
install -m 0755 scripts/jellyfin-plus-webinject /usr/local/sbin/jellyfin-plus-webinject
install -m 0755 scripts/jellyfin-plus-activate  /usr/local/sbin/jellyfin-plus-activate

# An unparseable fragment here breaks every apt operation on the box, not just this project.
if [ -f /etc/apt/apt.conf.d/99-jellyfin-plus ]; then
    cp -a /etc/apt/apt.conf.d/99-jellyfin-plus /etc/apt/apt.conf.d/99-jellyfin-plus.prev
fi
install -m 0644 scripts/99-jellyfin-plus /etc/apt/apt.conf.d/99-jellyfin-plus
if ! apt-config dump >/dev/null 2>&1; then
    echo "==> apt.conf fragment is invalid; restoring the previous one" >&2
    if [ -f /etc/apt/apt.conf.d/99-jellyfin-plus.prev ]; then
        mv /etc/apt/apt.conf.d/99-jellyfin-plus.prev /etc/apt/apt.conf.d/99-jellyfin-plus
    else
        rm -f /etc/apt/apt.conf.d/99-jellyfin-plus
    fi
    exit 1
fi
rm -f /etc/apt/apt.conf.d/99-jellyfin-plus.prev

if [ "$ACTIVATE" = "0" ]; then
    echo "==> staged in $STAGE, not activated, client script left as it was."
    echo "    activate when ready: jellyfin-plus-activate"
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
        echo "    the build is staged in $STAGE. Activate later with: jellyfin-plus-activate" >&2
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
/usr/local/sbin/jellyfin-plus-activate

# ---- 8. client -------------------------------------------------------------------------------
# Only now. A client published ahead of the server sends axes the running plugin does not read,
# silently, which is this project's oldest failure and the hardest to see.
#
# web/jellyfin-plus.js is a BUILD OUTPUT, not checked in (see web/src/ - real ES modules, bundled
# by esbuild). It has to be built here, fresh, from whatever web/src/ this checkout just fetched -
# there is no committed copy to fall back to.
echo "==> building the client script"
command -v npm >/dev/null || { echo "npm not on PATH: install Node.js on this machine to build web/jellyfin-plus.js" >&2; exit 1; }
[ -d web/node_modules/esbuild ] || (cd web && npm install --no-audit --no-fund)
./scripts/build-web-panel.sh

echo "==> publishing the client script"
install -m 0644 web/jellyfin-plus.js "$PATCH_DIR/jellyfin-plus.js.tmp.$$"
mv "$PATCH_DIR/jellyfin-plus.js.tmp.$$" "$PATCH_DIR/jellyfin-plus.js"
# The selectable jellyfin-web theme's stylesheet; the injector installs it and adds the config.json entry.
install -m 0644 web/theme/jellyfinplus.css "$PATCH_DIR/jellyfinplus-theme.css.tmp.$$"
mv "$PATCH_DIR/jellyfinplus-theme.css.tmp.$$" "$PATCH_DIR/jellyfinplus-theme.css"
/usr/local/sbin/jellyfin-plus-webinject

# ---- 9. what actually happened ---------------------------------------------------------------
echo "==> patch status"
journalctl -u jellyfin --since "-2 min" --no-pager | grep -i 'jellyfinplus' | tail -8 || \
    echo "    no JellyfinPlus lines in the log yet; check journalctl -u jellyfin"
echo
echo "Deployed. Still unproven: play something and probe the served segment."
echo "  journalctl -u jellyfin | grep libplacebo"
