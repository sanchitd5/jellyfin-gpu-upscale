#!/bin/bash
# Migrates a server installed under the old GPU Upscale names to Jellyfin Plus. Run as root ON the
# Jellyfin box (proxmox-build.sh calls it; it is also safe to run by hand). Idempotent: every step
# looks at what exists and does nothing when there is nothing to do, so re-running after a failure
# finishes the job, and running on a migrated or never-installed box is a no-op that exits 0.
#
#   --plugin-version=V   plugin directory version (default: the version of the old directory)
#   --out=DIR            dotnet publish output of src/          (Jellyfin.Plugin.Plus.dll, .deps.json)
#   --out-patcher=DIR    dotnet publish output of src/patcher/  (Jellyfin.Plugin.Plus.Patcher.dll, 0Harmony.dll)
#                        Without both, /usr/lib/jellyfin-plus/staged is used if it holds all four
#                        files. They are needed only when the plugin directory still has to be
#                        swapped, because the new directory must be COMPLETE before the old one goes.
#   --skip-web           leave the web root and index.html alone (webinject strips them on its next run)
#   --rollback           undo a migration from the copy kept in /usr/lib/jellyfin-plus/legacy
#
# What changes (old -> new):
#   /var/lib/jellyfin/plugins/GpuUpscale_V               -> .../JellyfinPlus_V   (meta.json rewritten, GUID kept)
#   plugins/configurations/Jellyfin.Plugin.GpuUpscale.xml -> ...Plus.xml (copied if absent; old kept as .bak)
#   /usr/lib/jellyfin-gpuupscale                         -> /usr/lib/jellyfin-plus (old tree moved into legacy/)
#   /var/cache/jellyfin/gpu-upscale-shaders              -> .../jellyfin-plus-shaders (mv, only if the new is absent)
#   /usr/local/sbin/jellyfin-gpuupscale-{activate,webinject}, /etc/apt/apt.conf.d/99-jellyfin-gpuupscale
#                                                        -> the jellyfin-plus-* equivalents, from this checkout
#   /usr/share/jellyfin/web/gpu-upscale.js + its index.html tag -> removed
#
# staged/ and previous/ in the old tree hold assemblies named Jellyfin.Plugin.GpuUpscale*.dll, which
# a Jellyfin.Plugin.Plus deployment cannot use, so they are not carried into the new tree: the new
# staged/ comes from the next build and previous/ from the next activate. The old client bundle is
# not carried either; the new one is built from web/src/ and published by the injector. Everything
# from the old install that rollback needs is kept under /usr/lib/jellyfin-plus/legacy; delete that
# directory once the new install has proven itself.
#
# Why Jellyfin never sees zero or two copies of the plugin (same GUID in two directories makes
# Jellyfin pick one arbitrarily or drop both). Jellyfin only scans plugins/ at startup, but a crash
# or a package-triggered restart can happen any time, so the on-disk state is kept valid throughout:
#   1. The new plugin directory is built COMPLETE (assemblies, meta.json, carried-over files) in
#      /var/lib/jellyfin/.jellyfin-plus-plugin.new, outside plugins/, where Jellyfin cannot see it.
#   2. It is validated there. Any failure up to this point leaves the old install untouched.
#   3. The swap is two renames inside /var/lib/jellyfin (same filesystem, atomic): old plugin dir ->
#      /var/lib/jellyfin/.gpuupscale-plugin.old (also outside plugins/), then the new dir into
#      plugins/. The only interval is between those two renames, microseconds long and with ZERO
#      copies (the plugin is just absent for that start); there is never a moment with two. If the
#      second rename fails the first is reversed immediately.
#   4. Only afterwards is the displaced old directory moved into legacy/ (outside plugins/).
# If a previous run left both directories in plugins/ (hand-built, for instance), the old one is
# moved out first, which takes the box from two copies to one.
#
# Failure: every step is a separate check with errors fatal (non-zero exit). Up to and including
# step 2 above nothing the running or restarting server depends on has changed. After the swap the
# state is still valid (one copy), but later steps (shader cache, sbin scripts, web) may be
# unfinished: re-run to complete them, or use --rollback. A FULL rollback of the final steps is not
# possible if you delete legacy/, and settings written to Jellyfin.Plugin.Plus.xml after the
# migration are not copied back into the old XML.
set -euo pipefail
shopt -s nullglob

GUID=6f2a9c31-4d7b-4e2a-9d15-8a1c0b7e3f44

# MIGRATE_ROOT prefixes every path. It exists only so this can be exercised in a scratch directory
# without root; on the server it is unset and ownership/apt/systemd handling are real.
R="${MIGRATE_ROOT:-}"

PLUGIN_VERSION=""
OUT_DIR=""
OUT_PATCHER=""
SKIP_WEB=0
ROLLBACK=0
for arg in "$@"; do
    case "$arg" in
        --plugin-version=*) PLUGIN_VERSION="${arg#*=}" ;;
        --out=*)            OUT_DIR="${arg#*=}" ;;
        --out-patcher=*)    OUT_PATCHER="${arg#*=}" ;;
        --skip-web)         SKIP_WEB=1 ;;
        --rollback)         ROLLBACK=1 ;;
        -h|--help)          sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

PLUGINS="$R/var/lib/jellyfin/plugins"
JF_DATA="$R/var/lib/jellyfin"
CFG_DIR="$PLUGINS/configurations"
OLD_XML="$CFG_DIR/Jellyfin.Plugin.GpuUpscale.xml"
NEW_XML="$CFG_DIR/Jellyfin.Plugin.Plus.xml"
LIB_OLD="$R/usr/lib/jellyfin-gpuupscale"
LIB_NEW="$R/usr/lib/jellyfin-plus"
LEGACY="$LIB_NEW/legacy"
SH_OLD="$R/var/cache/jellyfin/gpu-upscale-shaders"
SH_NEW="$R/var/cache/jellyfin/jellyfin-plus-shaders"
SBIN="$R/usr/local/sbin"
APTD="$R/etc/apt/apt.conf.d"
WEB="$R/usr/share/jellyfin/web"
HIDDEN_NEW="$JF_DATA/.jellyfin-plus-plugin.new"     # outside plugins/: invisible to Jellyfin
ASIDE="$JF_DATA/.gpuupscale-plugin.old"             # outside plugins/: invisible to Jellyfin
ROLLED="$JF_DATA/.jellyfin-plus-plugin.rolledback"  # outside plugins/: invisible to Jellyfin

PHASE=preflight
say()  { printf '    %s\n' "$*"; }
warn() { printf '    WARNING: %s\n' "$*" >&2; }
fail() { echo "migrate: FAILED: $*" >&2; exit 1; }
own()  { [ -n "$R" ] || chown -R jellyfin:jellyfin "$@"; }
# Copy beside the destination under a temp name, then rename: a reader never sees half a file.
put()  { cp -a "$1" "$2.new.$$" && mv "$2.new.$$" "$2"; }

on_exit() {
    local rc=$?
    [ "$PHASE" = swapped ] || rm -rf "$HIDDEN_NEW"
    [ "$rc" -eq 0 ] && return 0
    case "$PHASE" in
        preflight) echo "migrate: aborted (exit $rc). The plugin swap had not happened; the old install is intact." >&2 ;;
        swapped)   echo "migrate: aborted (exit $rc) AFTER the plugin swap. Jellyfin has exactly one copy of the plugin; some later steps may be unfinished. Re-run this script to finish, or --rollback." >&2 ;;
    esac
}
trap on_exit EXIT

[ -n "$R" ] || [ "$(id -u)" = 0 ] || fail "run as root"
command -v python3 >/dev/null || fail "python3 is required (meta.json and index.html edits)"

# Remove every <script src="NAME.js..."> tag from an HTML file, atomically. Prints 'stripped' if it changed.
strip_tag() {
    python3 - "$1" "$2" <<'PYEOF'
import os
import re
import sys

path, name = sys.argv[1], sys.argv[2]
html = open(path).read()
new = re.sub(r'<script[^>]*src="%s\.js[^"]*"[^>]*></script>' % re.escape(name), '', html)
if new != html:
    tmp = path + '.tmp'
    open(tmp, 'w').write(new)
    os.replace(tmp, path)
    print('stripped')
PYEOF
}

# ============================================================================================
# --rollback
# ============================================================================================
if [ "$ROLLBACK" = "1" ]; then
    echo "==> rolling back to the pre-rename install from $LEGACY"
    lp=("$LEGACY"/GpuUpscale_*)
    [ "${#lp[@]}" -eq 1 ] || fail "need exactly one $LEGACY/GpuUpscale_* directory, found ${#lp[@]}; nothing changed"
    [ -d "$LEGACY/jellyfin-gpuupscale" ] || fail "$LEGACY/jellyfin-gpuupscale missing; nothing changed"
    OLD_NAME="${lp[0]##*/}"

    # Plugin: the same two-rename swap as forward, in reverse. The new dir goes out of plugins/
    # first, then the old one comes back; never two copies.
    PHASE=swapped
    nps=("$PLUGINS"/JellyfinPlus_*)
    if [ ! -d "$PLUGINS/$OLD_NAME" ]; then
        rm -rf "$ROLLED"
        if [ "${#nps[@]}" -gt 0 ]; then mv "${nps[0]}" "$ROLLED"; fi
        if ! mv "${lp[0]}" "$PLUGINS/$OLD_NAME"; then
            [ ! -d "$ROLLED" ] || mv "$ROLLED" "${nps[0]}"
            fail "could not restore $OLD_NAME; the new plugin directory was put back"
        fi
        say "plugin directory: restored $OLD_NAME, removed the JellyfinPlus one"
    fi
    rm -rf "$ROLLED"
    [ -d "$LIB_OLD" ] || { mv "$LEGACY/jellyfin-gpuupscale" "$LIB_OLD"; say "restored $LIB_OLD"; }
    if [ -f "$OLD_XML.bak" ] && [ ! -f "$OLD_XML" ]; then mv "$OLD_XML.bak" "$OLD_XML"; say "restored $OLD_XML"; fi
    if [ -d "$SH_NEW" ] && [ ! -d "$SH_OLD" ]; then mv "$SH_NEW" "$SH_OLD"; say "shader cache moved back to $SH_OLD"; fi
    if [ -d "$LEGACY/sbin" ]; then
        mkdir -p "$SBIN" "$APTD"
        for f in "$LEGACY"/sbin/*; do
            case "${f##*/}" in 99-*) put "$f" "$APTD/${f##*/}" ;; *) put "$f" "$SBIN/${f##*/}" ;; esac
        done
        rm -f "$SBIN/jellyfin-plus-activate" "$SBIN/jellyfin-plus-activate.prev" "$SBIN/jellyfin-plus-webinject" "$APTD/99-jellyfin-plus"
        say "sbin scripts and apt hook restored, jellyfin-plus ones removed"
    fi
    if [ "$SKIP_WEB" != "1" ] && [ -f "$WEB/index.html" ]; then
        [ "$(strip_tag "$WEB/index.html" jellyfin-plus)" != stripped ] || say "removed the jellyfin-plus.js tag from index.html"
        rm -f "$WEB/jellyfin-plus.js"
        if [ -f "$WEB/index.html.jellyfin-plus-orig" ] && [ ! -f "$WEB/index.html.gpuupscale-orig" ]; then
            mv "$WEB/index.html.jellyfin-plus-orig" "$WEB/index.html.gpuupscale-orig"
        fi
        if [ -x "$SBIN/jellyfin-gpuupscale-webinject" ] && [ -z "$R" ]; then
            "$SBIN/jellyfin-gpuupscale-webinject" || warn "old webinject failed; run it by hand"
        fi
    fi
    echo "==> rolled back on disk. Restart Jellyfin to load the old plugin: systemctl restart jellyfin"
    echo "    ($LEGACY is left in place; the new Jellyfin.Plugin.Plus.xml is left beside the old XML)"
    exit 0
fi

# ============================================================================================
# forward migration
# ============================================================================================
echo "==> migrate to Jellyfin Plus"

# ---- 1. preflight: look, decide, build the new plugin dir out of sight ------------------------
olds=("$PLUGINS"/GpuUpscale_*)
[ "${#olds[@]}" -le 1 ] || fail "more than one GpuUpscale_* directory in $PLUGINS (${olds[*]}); resolve by hand"
OLD_PLUGIN="${olds[0]:-}"
[ -z "$PLUGIN_VERSION" ] && [ -n "$OLD_PLUGIN" ] && PLUGIN_VERSION="${OLD_PLUGIN##*_}"
PLUGIN_VERSION="${PLUGIN_VERSION:-1.0.0.0}"
NEW_PLUGIN="$PLUGINS/JellyfinPlus_$PLUGIN_VERSION"

web_old=0
if [ "$SKIP_WEB" != "1" ] && [ -f "$WEB/index.html" ] && { [ -e "$WEB/gpu-upscale.js" ] || grep -q 'gpu-upscale\.js' "$WEB/index.html"; }; then web_old=1; fi
old_sbin=0
for f in "$SBIN"/jellyfin-gpuupscale-* "$APTD"/99-jellyfin-gpuupscale*; do old_sbin=1; done

if [ -z "$OLD_PLUGIN" ] && [ ! -d "$ASIDE" ] && [ ! -d "$LIB_OLD" ] && [ ! -f "$OLD_XML" ] && [ ! -d "$SH_OLD" ] \
    && [ "$old_sbin" = 0 ] && [ "$web_old" = 0 ]; then
    echo "    nothing to migrate"
    exit 0
fi

SWAP_PENDING=0
if [ -n "$OLD_PLUGIN" ]; then
    [ ! -d "$ASIDE" ] || fail "$ASIDE already exists beside a live $OLD_PLUGIN; resolve by hand"
    if [ -d "$NEW_PLUGIN" ]; then
        [ -f "$NEW_PLUGIN/Jellyfin.Plugin.Plus.dll" ] || fail "$NEW_PLUGIN exists without Jellyfin.Plugin.Plus.dll; remove it or finish its install by hand"
    else
        SWAP_PENDING=1
    fi
fi

if [ "$SWAP_PENDING" = 1 ]; then
    if [ -n "$OUT_DIR" ] && [ -n "$OUT_PATCHER" ]; then
        ASM_PLUGIN="$OUT_DIR"; ASM_PATCHER="$OUT_PATCHER"
    else
        ASM_PLUGIN="$LIB_NEW/staged"; ASM_PATCHER="$LIB_NEW/staged"
    fi
    for f in "$ASM_PLUGIN/Jellyfin.Plugin.Plus.dll" "$ASM_PLUGIN/Jellyfin.Plugin.Plus.deps.json" \
             "$ASM_PATCHER/Jellyfin.Plugin.Plus.Patcher.dll" "$ASM_PATCHER/0Harmony.dll"; do
        [ -f "$f" ] || fail "new assembly missing: $f (pass --out and --out-patcher, or stage a build first). Nothing changed."
    done
    for f in jellyfin-plus-activate jellyfin-plus-webinject 99-jellyfin-plus; do
        [ -f "$SCRIPT_DIR/$f" ] || fail "$SCRIPT_DIR/$f missing (run this from a repo checkout). Nothing changed."
    done

    # Build the new plugin dir out of sight. Carry over everything in the old dir except the old
    # assemblies and meta.json (regenerated).
    rm -rf "$HIDDEN_NEW"
    mkdir -p "$HIDDEN_NEW"
    for f in "$OLD_PLUGIN"/* "$OLD_PLUGIN"/.[!.]*; do
        case "${f##*/}" in Jellyfin.Plugin.GpuUpscale.*|meta.json) continue ;; esac
        cp -a "$f" "$HIDDEN_NEW/"
    done
    cp -a "$ASM_PLUGIN/Jellyfin.Plugin.Plus.dll" "$ASM_PLUGIN/Jellyfin.Plugin.Plus.deps.json" "$HIDDEN_NEW/"
    meta_src=-
    [ ! -f "$OLD_PLUGIN/meta.json" ] || meta_src="$OLD_PLUGIN/meta.json"
    python3 - "$meta_src" "$HIDDEN_NEW/meta.json" "$PLUGIN_VERSION" "$GUID" <<'PYEOF'
import json
import sys

src, dst, version, guid = sys.argv[1:5]
OLD_OVERVIEW = "Realtime GPU super-resolution upscaling"
NEW_OVERVIEW = "GPU video enhancement plus search, filtering and library quality-of-life improvements for Jellyfin."

def fix(v):
    if isinstance(v, str):
        return (v.replace("Jellyfin.Plugin.GpuUpscale", "Jellyfin.Plugin.Plus")
                 .replace("GPU Upscale", "Jellyfin Plus")
                 .replace("GpuUpscale", "JellyfinPlus"))
    if isinstance(v, list):
        return [fix(x) for x in v]
    if isinstance(v, dict):
        return {k: fix(x) for k, x in v.items()}
    return v

if src == "-":
    m = {"targetAbi": "12.3.0.0", "owner": "", "category": "General"}
else:
    m = fix(json.load(open(src)))
if str(m.get("guid", guid)).lower() != guid:
    sys.exit("meta.json guid %r is not the Jellyfin Plus plugin GUID %s" % (m.get("guid"), guid))
m["guid"] = guid          # unchanged: a new GUID would make Jellyfin treat this as a new plugin
m["name"] = "Jellyfin Plus"
m["version"] = version
if m.get("overview") in (None, "", OLD_OVERVIEW):
    m["overview"] = NEW_OVERVIEW
json.dump(m, open(dst, "w"), indent=2)
PYEOF
    own "$HIDDEN_NEW"
    [ -s "$HIDDEN_NEW/meta.json" ] && [ -f "$HIDDEN_NEW/Jellyfin.Plugin.Plus.dll" ] || fail "new plugin directory incomplete"
    say "built $NEW_PLUGIN out of sight in $HIDDEN_NEW"
fi

# ---- 2. additive steps: nothing here is visible to the old plugin ------------------------------
if [ "$SWAP_PENDING" = 1 ]; then
    mkdir -p "$LIB_NEW"
    for f in Jellyfin.Plugin.Plus.Patcher.dll 0Harmony.dll; do put "$ASM_PATCHER/$f" "$LIB_NEW/$f"; done
    chmod 644 "$LIB_NEW"/*.dll
    say "patcher assemblies installed in $LIB_NEW"
fi

if [ -f "$OLD_XML" ]; then
    if [ ! -f "$NEW_XML" ]; then
        put "$OLD_XML" "$NEW_XML"
        own "$NEW_XML"
        say "settings: copied $OLD_XML -> $NEW_XML"
        if grep -q 'GpuUpscale' "$NEW_XML"; then warn "$NEW_XML still mentions GpuUpscale; check that the plugin loads the settings"; fi
    else
        say "settings: $NEW_XML already exists, not overwritten"
    fi
fi

# ---- 3. the plugin swap --------------------------------------------------------------------------
if [ -n "$OLD_PLUGIN" ]; then
    PHASE=swapped
    if [ "$SWAP_PENDING" = 1 ]; then
        mv "$OLD_PLUGIN" "$ASIDE"
        if ! mv "$HIDDEN_NEW" "$NEW_PLUGIN"; then
            mv "$ASIDE" "$OLD_PLUGIN"
            PHASE=preflight
            fail "could not move the new plugin directory into place; the old one was put back"
        fi
        say "plugin: ${OLD_PLUGIN##*/} -> ${NEW_PLUGIN##*/} (swapped; exactly one copy in plugins/)"
    else
        mv "$OLD_PLUGIN" "$ASIDE"
        say "plugin: $NEW_PLUGIN already present; moved the stale ${OLD_PLUGIN##*/} out of plugins/"
    fi
fi
PHASE=swapped

# ---- 4. everything else is independent of the swap -------------------------------------------
mkdir -p "$LEGACY"
if [ -d "$ASIDE" ]; then
    dest="$LEGACY/$(basename "${OLD_PLUGIN:-GpuUpscale_$PLUGIN_VERSION}")"
    rm -rf "$dest"
    mv "$ASIDE" "$dest"
    say "old plugin directory kept at $dest (outside plugins/, not loaded)"
fi

# Shader cache: a move, only when the new one is absent. An empty new one (activate creates it) is
# replaced; a populated one is never touched.
if [ -d "$SH_OLD" ]; then
    rmdir "$SH_NEW" 2>/dev/null || true
    if [ ! -d "$SH_NEW" ]; then
        mv "$SH_OLD" "$SH_NEW"
        own "$SH_NEW"
        say "shader cache: $SH_OLD -> $SH_NEW"
    else
        warn "both shader caches exist and $SH_NEW is not empty; left $SH_OLD alone"
    fi
fi

# sbin scripts and apt hook. Copies of the old ones go to legacy/ first (rollback uses them).
mkdir -p "$SBIN" "$APTD"
for f in activate webinject; do
    [ -f "$SCRIPT_DIR/jellyfin-plus-$f" ] || fail "$SCRIPT_DIR/jellyfin-plus-$f missing"
done
[ -f "$SCRIPT_DIR/99-jellyfin-plus" ] || fail "$SCRIPT_DIR/99-jellyfin-plus missing"
if [ "$old_sbin" = 1 ]; then
    mkdir -p "$LEGACY/sbin"
    for f in "$SBIN"/jellyfin-gpuupscale-* "$APTD"/99-jellyfin-gpuupscale*; do cp -a "$f" "$LEGACY/sbin/"; done
fi
install -m 0755 "$SCRIPT_DIR/jellyfin-plus-webinject" "$SBIN/jellyfin-plus-webinject"
install -m 0755 "$SCRIPT_DIR/jellyfin-plus-activate"  "$SBIN/jellyfin-plus-activate"
# An unparseable fragment here breaks every apt operation on the box, not just this project.
[ ! -f "$APTD/99-jellyfin-plus" ] || cp -a "$APTD/99-jellyfin-plus" "$APTD/99-jellyfin-plus.prev"
install -m 0644 "$SCRIPT_DIR/99-jellyfin-plus" "$APTD/99-jellyfin-plus"
if [ -z "$R" ] && ! apt-config dump >/dev/null 2>&1; then
    if [ -f "$APTD/99-jellyfin-plus.prev" ]; then mv "$APTD/99-jellyfin-plus.prev" "$APTD/99-jellyfin-plus"; else rm -f "$APTD/99-jellyfin-plus"; fi
    fail "the new apt.conf fragment is invalid; restored the previous state (old hook untouched)"
fi
rm -f "$APTD/99-jellyfin-plus.prev"
# Old ones go only after the new ones are installed and the apt config validated.
rm -f "$SBIN"/jellyfin-gpuupscale-* "$APTD"/99-jellyfin-gpuupscale*
say "sbin scripts and apt hook: jellyfin-plus-* installed, jellyfin-gpuupscale-* removed"

# Web root: drop the old bundle and its tag (the webinject does the same on every run), and keep
# the existing pristine index.html backup under the new suffix. It must never be lost.
if [ "$SKIP_WEB" != "1" ] && [ -f "$WEB/index.html" ]; then
    if [ -f "$WEB/index.html.gpuupscale-orig" ] && [ ! -f "$WEB/index.html.jellyfin-plus-orig" ]; then
        mv "$WEB/index.html.gpuupscale-orig" "$WEB/index.html.jellyfin-plus-orig"
        say "web: pristine index.html backup kept as index.html.jellyfin-plus-orig"
    fi
    [ "$(strip_tag "$WEB/index.html" gpu-upscale)" != stripped ] || say "web: removed the gpu-upscale.js tag from index.html"
    rm -f "$WEB/gpu-upscale.js" "$WEB"/gpu-upscale.js.tmp.* "$WEB/index.html.gpuupscale-bak"
fi

# Settings XML: the old file is kept as .bak, but only once the new one exists.
if [ -f "$OLD_XML" ] && [ -f "$NEW_XML" ]; then
    mv -f "$OLD_XML" "$OLD_XML.bak"
    say "settings: old XML kept as $OLD_XML.bak"
fi

# Old install tree last: it was the "keep until the end" part. Its staged/previous hold old-named
# assemblies and are only useful to --rollback.
if [ -d "$LIB_OLD" ]; then
    rm -rf "$LEGACY/jellyfin-gpuupscale"
    mv "$LIB_OLD" "$LEGACY/jellyfin-gpuupscale"
    say "old install tree: $LIB_OLD -> $LEGACY/jellyfin-gpuupscale"
fi

echo "==> migrated. Restart Jellyfin to load the new plugin (proxmox-build.sh / jellyfin-plus-activate does that)."
echo "    Nothing has been restarted. Undo with: $0 --rollback; free the space with: rm -rf $LEGACY"
