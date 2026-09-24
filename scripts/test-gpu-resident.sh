#!/usr/bin/env bash
# test-gpu-resident.sh — regression suite for the GPU-resident ffmpeg patches
# (ffmpeg/0006-vulkan-to-cuda-hwmap.patch and friends) and the GpuResidentEncode
# chain UpscaleEngine.cs builds on top of them.
#
# Run ON the box that has the patched binary (CT114 today): `sudo ./scripts/test-gpu-resident.sh`
# or over SSH: `pct exec 114 -- /opt/jellyfin-gpu-upscale/scripts/test-gpu-resident.sh`.
#
# What this replaces: every case here is a command a human ran by hand on CT114 during the
# 2026-09-24 GPU-resident-encode work (see livetestbox.md, local/gitignored, for the full
# session log) to prove hwmap=derive_device=cuda works from a Vulkan source. This script makes
# that proof re-runnable instead of re-derived from scratch after every ffmpeg rebuild.
#
# What each case asserts, not just "ffmpeg exited 0": exit code, AND a real output-shape check
# (resolution/frame count/bitrate via ffprobe) — exit 0 alone would not have caught a silent
# fallback to the CPU/hwdownload path, which is exactly the failure mode this project has hit
# before (AGENTS.md: "Something renders, is stored, and is never sent").
#
# STUBBED, not tested here: the ffmpeg/0007-cuda-to-vulkan-hwmap.patch bridge and the vf_optix.c
# module-context fix (cuModuleGetFunction ... CUDA_ERROR_NOT_FOUND) are still in flight in a
# separate pass as of this writing — see cases marked SKIP below. Once that work lands, replace
# the SKIP with a real case using its own verified repro command; don't mark it PASS without one.

set -u

FFMPEG=${FFMPEG:-/usr/lib/jellyfin-ffmpeg-oidn/ffmpeg}
# ffprobe isn't built into the patched binary's own directory - it ships with the stock
# jellyfin-ffmpeg8 package this project installs beside. Fall back to PATH if neither exists.
FFPROBE=${FFPROBE:-}
if [ -z "$FFPROBE" ]; then
    for candidate in "$(dirname "$FFMPEG")/ffprobe" /usr/lib/jellyfin-ffmpeg/ffprobe "$(command -v ffprobe 2>/dev/null)"; do
        if [ -n "$candidate" ] && [ -x "$candidate" ]; then
            FFPROBE=$candidate
            break
        fi
    done
fi
SHADER_DIR=${SHADER_DIR:-/usr/share/jellyfin-shaders}
WORKDIR=$(mktemp -d /tmp/gpu-resident-test.XXXXXX)
trap 'rm -rf "$WORKDIR"' EXIT

PASS=0
FAIL=0
SKIP=0

log()  { printf '%s\n' "$*"; }
pass() { PASS=$((PASS + 1)); log "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); log "FAIL: $1"; log "      $2"; }
skip() { SKIP=$((SKIP + 1)); log "SKIP: $1 ($2)"; }

# Runs an ffmpeg command, asserts exit 0, then asserts the output file has the given
# resolution/frame count/nonzero bitrate via ffprobe. $1=case name, $2=output file,
# $3=expected WxH, $4=expected frame count, $5..=ffmpeg args (after $FFMPEG).
run_case() {
    local name="$1" out="$2" want_res="$3" want_frames="$4"
    shift 4
    local logfile="$WORKDIR/${name}.log"

    if ! "$FFMPEG" -y -hide_banner -loglevel warning "$@" "$out" >"$logfile" 2>&1; then
        fail "$name" "ffmpeg exited nonzero, see $logfile: $(tail -n1 "$logfile")"
        return
    fi

    if [ ! -s "$out" ]; then
        fail "$name" "output file missing or empty: $out"
        return
    fi

    # Four separate single-field queries rather than one multi-field CSV row: ffprobe's csv
    # output column order does not reliably follow the order fields are requested in, and
    # getting this wrong silently mis-assigns values (a frame-count check reading a bitrate
    # column still "passes" a plausible-looking number). One field per call has no ordering
    # to get wrong.
    local got_w got_h got_frames got_bitrate
    got_w=$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=width \
        -of csv=p=0 "$out" 2>"$WORKDIR/${name}.ffprobe.log")
    got_h=$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=height \
        -of csv=p=0 "$out" 2>>"$WORKDIR/${name}.ffprobe.log")
    got_frames=$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=nb_read_frames \
        -count_frames -of csv=p=0 "$out" 2>>"$WORKDIR/${name}.ffprobe.log")
    got_bitrate=$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=bit_rate \
        -of csv=p=0 "$out" 2>>"$WORKDIR/${name}.ffprobe.log")
    local got_res="${got_w}x${got_h}"

    if [ "$got_res" != "$want_res" ]; then
        fail "$name" "resolution mismatch: want $want_res got $got_res"
        return
    fi
    if [ -n "$want_frames" ] && [ "$got_frames" != "$want_frames" ]; then
        fail "$name" "frame count mismatch: want $want_frames got $got_frames"
        return
    fi
    if [ -z "$got_bitrate" ] || [ "$got_bitrate" = "N/A" ] || [ "$got_bitrate" -le 0 ] 2>/dev/null; then
        fail "$name" "zero/missing bitrate — likely corrupt or empty encode, got '$got_bitrate'"
        return
    fi

    pass "$name (res=$got_res frames=$got_frames bitrate=$got_bitrate)"
}

log "== test-gpu-resident.sh: $(date -u +%FT%TZ) =="
log "FFMPEG=$FFMPEG"
log "FFPROBE=${FFPROBE:-<not found>}"
"$FFMPEG" -version 2>&1 | head -n1
if [ -z "$FFPROBE" ]; then
    log "FATAL: no ffprobe found (checked \$(dirname \$FFMPEG)/ffprobe, /usr/lib/jellyfin-ffmpeg/ffprobe, PATH). Set FFPROBE=..."
    exit 2
fi
log ""

# ---------------------------------------------------------------------------
# Case 1: the original hwmap=derive_device=cuda smoke test. Used to fail with
# [Parsed_hwmap_3] Failed to map frame: -38 before ffmpeg/0006-vulkan-to-cuda-hwmap.patch.
# ---------------------------------------------------------------------------
run_case "0006-hwmap-basic" "$WORKDIR/0006.mp4" "1920x1080" "48" \
    -init_hw_device vulkan=vk:0 -filter_hw_device vk \
    -f lavfi -i testsrc=size=960x540:rate=24 -frames:v 48 \
    -vf "format=yuv420p,hwupload,libplacebo=w=1920:h=1080:upscaler=ewa_lanczos,hwmap=derive_device=cuda" \
    -c:v hevc_nvenc

# ---------------------------------------------------------------------------
# Case 2: GpuResidentEncode's actual sharpen-only chain (deblur=RCAS), the only
# pure-GPU-shader axis with no CPU gbrpf32le dependency. Byte-for-byte what
# UpscaleEngine.BuildChain() emits for deblur=<any level> with GpuResidentEncode=true
# and every other axis off.
# ---------------------------------------------------------------------------
if [ -f "$SHADER_DIR/RCAS-2.0.glsl" ]; then
    run_case "gpuresident-deblur-rcas" "$WORKDIR/rcas.mp4" "1280x720" "96" \
        -init_hw_device vulkan=vk:0 -filter_hw_device vk \
        -f lavfi -i testsrc=size=1280x720:rate=24 -frames:v 96 \
        -vf "format=yuv420p,hwupload,libplacebo=w=1280:h=720:upscaler=ewa_lanczos:custom_shader_path=$SHADER_DIR/RCAS-2.0.glsl,hwmap=derive_device=cuda" \
        -c:v hevc_nvenc
else
    skip "gpuresident-deblur-rcas" "shader not found at $SHADER_DIR/RCAS-2.0.glsl"
fi

# ---------------------------------------------------------------------------
# Case 3: chroma axis (KrigBilateral), same libplacebo node, CHROMA hook.
# ---------------------------------------------------------------------------
if [ -f "$SHADER_DIR/KrigBilateral.glsl" ]; then
    run_case "gpuresident-chroma-krigbilateral" "$WORKDIR/chroma.mp4" "1280x720" "48" \
        -init_hw_device vulkan=vk:0 -filter_hw_device vk \
        -f lavfi -i testsrc=size=1280x720:rate=24 -frames:v 48 \
        -vf "format=yuv420p,hwupload,libplacebo=w=1280:h=720:upscaler=ewa_lanczos:custom_shader_path=$SHADER_DIR/KrigBilateral.glsl,hwmap=derive_device=cuda" \
        -c:v hevc_nvenc
else
    skip "gpuresident-chroma-krigbilateral" "shader not found at $SHADER_DIR/KrigBilateral.glsl"
fi

# ---------------------------------------------------------------------------
# Case 4: refine axis (SSimSuperRes, post-scale), run with a real upscale so the
# post-kernel hook has something to refine, not a 1:1 no-op.
# ---------------------------------------------------------------------------
if [ -f "$SHADER_DIR/SSimSuperRes.glsl" ]; then
    run_case "gpuresident-refine-ssimsuperres" "$WORKDIR/refine.mp4" "1920x1080" "48" \
        -init_hw_device vulkan=vk:0 -filter_hw_device vk \
        -f lavfi -i testsrc=size=960x540:rate=24 -frames:v 48 \
        -vf "format=yuv420p,hwupload,libplacebo=w=1920:h=1080:upscaler=ewa_lanczos:custom_shader_path=$SHADER_DIR/SSimSuperRes.glsl,hwmap=derive_device=cuda" \
        -c:v hevc_nvenc
else
    skip "gpuresident-refine-ssimsuperres" "shader not found at $SHADER_DIR/SSimSuperRes.glsl"
fi

# ---------------------------------------------------------------------------
# Case 5: deband axis — AVOptions on the same libplacebo node, no shader file.
# ---------------------------------------------------------------------------
run_case "gpuresident-deband" "$WORKDIR/deband.mp4" "1280x720" "48" \
    -init_hw_device vulkan=vk:0 -filter_hw_device vk \
    -f lavfi -i testsrc=size=1280x720:rate=24 -frames:v 48 \
    -vf "format=yuv420p,hwupload,libplacebo=w=1280:h=720:upscaler=ewa_lanczos:deband=1:deband_threshold=3:deband_grain=0,hwmap=derive_device=cuda" \
    -c:v hevc_nvenc

# ---------------------------------------------------------------------------
# Case 6: all five libplacebo axes combined in one chain (the "full ladder" case).
# RCAS/SSimSuperRes/KrigBilateral compose into one custom_shader_path via
# ShaderLibrary.Compose in the real plugin; this test approximates that by only
# running the shader most likely to reveal a compose-order regression (RCAS, since
# it hooks LUMA and runs first) alongside deband+kernel+refine's upscale together.
# This is NOT a substitute for ShaderLibrary.Compose's actual multi-hook output —
# a true "all five at once" case needs the composed GLSL text, which only the C#
# ShaderLibrary code produces; scope this to a plugin-driven session check later
# (see AGENTS.md's "prove the whole chain" section) rather than faked here.
# ---------------------------------------------------------------------------
if [ -f "$SHADER_DIR/RCAS-2.0.glsl" ]; then
    run_case "gpuresident-combined-approx" "$WORKDIR/combined.mp4" "1920x1080" "300" \
        -init_hw_device vulkan=vk:0 -filter_hw_device vk \
        -f lavfi -i testsrc=size=960x540:rate=30 -frames:v 300 \
        -vf "format=yuv420p,hwupload,libplacebo=w=1920:h=1080:upscaler=ewa_lanczos:deband=1:deband_threshold=3:deband_grain=0:custom_shader_path=$SHADER_DIR/RCAS-2.0.glsl,hwmap=derive_device=cuda" \
        -c:v hevc_nvenc
else
    skip "gpuresident-combined-approx" "shader not found at $SHADER_DIR/RCAS-2.0.glsl"
fi

# ---------------------------------------------------------------------------
# Case 7: all 5 mandatory custom filters present in this binary. proxmox-build.sh
# already refuses to deploy a binary missing any of these; this re-asserts it
# independently so a suite run surfaces a clear pass/fail without needing a build.
# ---------------------------------------------------------------------------
MANDATORY_FILTERS="oidn optix ort fsr2 dlss"
missing=""
filters_out=$("$FFMPEG" -hide_banner -filters 2>&1)
for f in $MANDATORY_FILTERS; do
    if ! printf '%s\n' "$filters_out" | grep -qE "^[[:space:]]*[A-Z.]+[[:space:]]+${f}[[:space:]]"; then
        missing="$missing $f"
    fi
done
if [ -z "$missing" ]; then
    pass "mandatory-five-filters-present ($MANDATORY_FILTERS)"
else
    fail "mandatory-five-filters-present" "missing from '$FFMPEG -filters':$missing"
fi

# ---------------------------------------------------------------------------
# Case 8 (STUB): ffmpeg/0007-cuda-to-vulkan-hwmap.patch — the reverse-direction
# bridge letting a CUDA-native filter (optix/dlpp_rtcuda/vsr_rtcuda) hand a frame
# back to a Vulkan libplacebo stage. Not landed as of this writing (see this
# session's parallel fork, agent a3248aa6436e29020). Do not mark this PASS
# until it has its own real repro command from that work — replace this whole
# block with a run_case() using that command once available.
# ---------------------------------------------------------------------------
skip "0007-cuda-to-vulkan-bridge" "ffmpeg/0007-cuda-to-vulkan-hwmap.patch not landed yet"

# ---------------------------------------------------------------------------
# Case 9 (STUB): vf_optix.c consuming a hwmap-derived (non-decode-native) CUDA
# frame. Currently fails with cuModuleGetFunction(..., "semiplanar_to_rgbf32")
# -> CUDA_ERROR_NOT_FOUND per this session's investigation. Fix in flight in the
# same parallel fork as case 8.
# ---------------------------------------------------------------------------
skip "optix-hwmap-derived-cuda-frame" "vf_optix.c module-context bug not fixed yet"

log ""
log "== summary: $PASS passed, $FAIL failed, $SKIP skipped =="
[ "$FAIL" -eq 0 ]
