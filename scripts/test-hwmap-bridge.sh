#!/bin/bash
# Pixel-correctness test for the CUDA <-> Vulkan hwmap bridge (ffmpeg/0006-0012).
#
#   scripts/test-hwmap-bridge.sh /path/to/ffmpeg
#
# Exit status: 0 all cases correct, 1 corrupted frames (a bridge bug), 2 the test could not run
# (no GPU, device init failed, binary missing).
#
# Exit codes and frame counts prove nothing here: the bridge once passed every such check while
# handing Vulkan scrambled frames. Each case pushes a synthetic testsrc2 picture across the bridge
# and compares the bytes that come back with a plain software decode of the same picture.
# Copies must be bit-exact. The libplacebo case is compared by PSNR because it filters the picture.
#
# CUDA->Vulkan was scrambled at 1280x720 and 1920x1080 but exact at 512x288, and the garbage
# changed from run to run, so the sizes below are deliberate: the small control case proves the
# harness works, the large ones are the ones that used to fail.
set -uo pipefail

FF="${1:-}"
[ -x "$FF" ] || { echo "test-hwmap-bridge: ffmpeg binary '$FF' not executable" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hwmap-bridge-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

FRAMES=3
MIN_PSNR_FILTERED=40
failed=0
broken_setup=0

run_ff() { "$FF" -nostdin -hide_banner -loglevel error "$@"; }

# psnr A B WxH -> prints the average PSNR ("inf" when identical)
psnr() {
    "$FF" -nostdin -hide_banner -loglevel info \
        -f rawvideo -pix_fmt nv12 -s "$3" -i "$1" \
        -f rawvideo -pix_fmt nv12 -s "$3" -i "$2" \
        -lavfi psnr -f null - 2>&1 | grep -o 'average:[^ ]*' | tail -1 | cut -d: -f2
}

# report NAME WxH RESULT_FILE REF_FILE MODE   (MODE: exact | psnr)
report() {
    local name="$1" size="$2" out="$3" ref="$4" mode="$5" val
    if [ ! -s "$out" ]; then
        printf '  %-44s NO OUTPUT\n' "$name"; broken_setup=1; return
    fi
    val="$(psnr "$out" "$ref" "$size")"
    if [ -z "$val" ]; then
        printf '  %-44s could not measure PSNR\n' "$name"; broken_setup=1; return
    fi
    if [ "$mode" = exact ]; then
        if [ "$val" = inf ]; then printf '  %-44s ok (bit-exact)\n' "$name"
        else printf '  %-44s CORRUPTED (PSNR %s dB, must be exact)\n' "$name" "$val"; failed=1; fi
    else
        if [ "$val" = inf ] || awk -v v="$val" -v m="$MIN_PSNR_FILTERED" 'BEGIN{exit !(v>=m)}'; then
            printf '  %-44s ok (PSNR %s dB)\n' "$name" "$val"
        else
            printf '  %-44s CORRUPTED (PSNR %s dB, need %s)\n' "$name" "$val" "$MIN_PSNR_FILTERED"; failed=1
        fi
    fi
}

SRC() { echo "-f lavfi -i testsrc2=size=$1:rate=24 -frames:v $FRAMES"; }
VK="-init_hw_device vulkan=vk:0,disable_multiplane=1 -filter_hw_device vk"
CU="-init_hw_device cuda=cu:0 -filter_hw_device cu"

# case NAME WxH DEVICE_ARGS FILTER MODE [REFERENCE_FILTER]
case_run() {
    local name="$1" size="$2" dev="$3" vf="$4" mode="$5" reffilter="${6:-format=nv12}" tag
    tag="$(echo "$name" | tr -c 'A-Za-z0-9' _)"
    run_ff $dev $(SRC "$size") -vf "$reffilter" -f rawvideo -y "$WORK/ref_$tag.nv12" 2>/dev/null
    run_ff $dev $(SRC "$size") -vf "$vf" -f rawvideo -y "$WORK/out_$tag.nv12" 2>"$WORK/err_$tag.txt"
    local rc=$?
    if [ $rc -ne 0 ]; then
        printf '  %-44s ffmpeg exit %s: %s\n' "$name" "$rc" "$(head -c 160 "$WORK/err_$tag.txt" | tr '\n' ' ')"
        # a crash on the bridge is a bridge failure, not a harness problem
        failed=1; return
    fi
    report "$name" "$size" "$WORK/out_$tag.nv12" "$WORK/ref_$tag.nv12" "$mode"
}

echo "hwmap bridge pixel test: $FF"

# Harness sanity: system memory through Vulkan and back, no CUDA involved. If this is not exact the
# GPU or driver is unusable and the rest says nothing about the bridge.
run_ff $VK $(SRC 512x288) -vf "format=nv12,hwupload,hwdownload,format=nv12" -f rawvideo -y "$WORK/sanity.nv12" 2>"$WORK/sanity.err"
if [ $? -ne 0 ]; then
    echo "  cannot run: Vulkan device unusable: $(head -c 200 "$WORK/sanity.err" | tr '\n' ' ')" >&2
    exit 2
fi

case_run "CUDA->Vulkan 512x288 (control)"        512x288   "$VK" "format=nv12,hwupload_cuda,hwmap,hwdownload,format=nv12" exact
case_run "CUDA->Vulkan 1280x720"                 1280x720  "$VK" "format=nv12,hwupload_cuda,hwmap,hwdownload,format=nv12" exact
case_run "CUDA->Vulkan 1920x1080"                1920x1080 "$VK" "format=nv12,hwupload_cuda,hwmap,hwdownload,format=nv12" exact
case_run "CUDA->Vulkan 1920x1080 derived device" 1920x1080 "$CU" "format=nv12,hwupload_cuda,hwmap=derive_device=vulkan,hwdownload,format=nv12" exact
case_run "Vulkan->CUDA 1920x1080"                1920x1080 "$VK" "format=nv12,hwupload,hwmap=derive_device=cuda,hwdownload,format=nv12" exact
case_run "libplacebo between bridges 1920x1080"  1920x1080 "$VK" \
    "format=nv12,hwupload_cuda,hwmap,libplacebo=w=1920:h=1080:deband=1,hwmap=derive_device=cuda,hwdownload,format=nv12" psnr \
    "format=nv12,hwupload,libplacebo=w=1920:h=1080:deband=1,hwdownload,format=nv12"

# Output SIZE cases. A rotated portrait picture came out landscape once the neural chain was
# handed a width worked out from stream metadata instead of from the frame that arrived after
# transpose_cuda, so these check the shape of what comes out, in bytes of raw nv12.
# size_case NAME EXPECTED_WxH DEV_ARGS SOURCE_WxH FILTER
size_case() {
    local name="$1" want="$2" dev="$3" src="$4" vf="$5" tag w h expect got
    tag="$(echo "$name" | tr -c 'A-Za-z0-9' _)"
    w="${want%x*}"; h="${want#*x}"; expect=$((w * h * 3 / 2 * FRAMES))
    run_ff $dev $(SRC "$src") -vf "$vf" -f rawvideo -y "$WORK/size_$tag.nv12" 2>"$WORK/size_$tag.err"
    local rc=$?
    if [ $rc -ne 0 ]; then
        printf '  %-44s ffmpeg exit %s: %s\n' "$name" "$rc" "$(head -c 160 "$WORK/size_$tag.err" | tr '\n' ' ')"
        failed=1; return
    fi
    got="$(stat -c %s "$WORK/size_$tag.nv12" 2>/dev/null || echo 0)"
    if [ "$got" -eq "$expect" ]; then printf '  %-44s ok (%s)\n' "$name" "$want"
    else printf '  %-44s WRONG SHAPE (%s bytes, wanted %s for %s)\n' "$name" "$got" "$expect" "$want"; failed=1; fi
}

size_case "libplacebo w=iw:h=ih keeps the size"  640x360  "$VK" 640x360 \
    "format=nv12,hwupload_cuda,hwmap,libplacebo=w=iw:h=ih,hwmap=derive_device=cuda,hwdownload,format=nv12"

BIN_DIR="$(dirname "$FF")"
VSR_DLL="$BIN_DIR/rtxvsr/dll/nvaivpx.dll"
DLPP_DLL="$BIN_DIR/rtxdlpp/dll/nvdlppx.dll"
if [ -f "$VSR_DLL" ]; then
    size_case "portrait via transpose_cuda, vsr w=-2" 720x1280 "$CU" 640x360 \
        "format=nv12,hwupload_cuda,transpose_cuda=dir=clock,vsr_rtcuda=dll=$VSR_DLL:w=-2:h=1280,hwdownload,format=nv12"
    if [ -f "$DLPP_DLL" ]; then
        # dlpp doubles 360x640 to 720x1280 and vsr resizes that to 1920 high, so the resize is not
        # an identity and the expected width has to come out of the aspect ratio: 1080.
        size_case "portrait via dlpp then vsr w=-2" 1080x1920 "$CU" 640x360 \
            "format=nv12,hwupload_cuda,transpose_cuda=dir=clock,dlpp_rtcuda=dll=$DLPP_DLL:level=1,vsr_rtcuda=dll=$VSR_DLL:w=-2:h=1920,hwdownload,format=nv12"
    fi
else
    echo "  portrait size cases skipped: $VSR_DLL not present"
fi

if [ $failed -ne 0 ]; then
    echo "FAILED: the CUDA<->Vulkan bridge or the resize chain returned wrong frames" >&2
    exit 1
fi
if [ $broken_setup -ne 0 ]; then
    echo "FAILED: the test could not measure every case" >&2
    exit 2
fi
echo "all bridge cases correct"
