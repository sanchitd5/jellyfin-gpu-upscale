#!/bin/bash
# make-rcas.sh <path-to-FSR.glsl> [outdir]
#
# Derives standalone RCAS user-shaders from AMD FidelityFX FSR v1.0.2 (MIT), mpv port by agyild
# (https://github.com/agyild/shaders -> FSR.glsl). The upstream file is NOT vendored in this
# repository: install-shaders.sh fetches it and runs this transform locally, so what ships here is
# the transform, not somebody else's source.
#
# The transform, exactly:
#   1. take the second //!HOOK block (the RCAS pass) onward - the first is EASU, the upscaler,
#      which this project does not use because libplacebo and the SR networks do that job
#   2. //!BIND EASUTEX -> //!BIND HOOKED, so the pass reads the current LUMA plane instead of
#      EASU's scratch texture and therefore works as a standalone sharpener
#   3. drop //!WIDTH EASUTEX.w / //!HEIGHT EASUTEX.h, so the pass runs at the native size of
#      whatever produced the plane - i.e. at the SR shader's output size, not at full output size
#   4. rewrite the EASUTEX_* texture accessors to HOOKED_*
#   5. substitute SHARPNESS
#
# SHARPNESS IS INVERTED AND CLAMPED. 0.0 is MAXIMUM sharpening, larger is gentler, and AMD's
# shader hard-clamps it into [0, 2] - a value above 2.0 is silently identical to 2.0.
set -eu

SRC=${1:?usage: make-rcas.sh <FSR.glsl> [outdir]}
OUT=${2:-.}

L=$(grep -n '^//!HOOK' "$SRC" | sed -n 2p | cut -d: -f1)
[ -n "$L" ] || { echo "second //!HOOK not found in $SRC - is this agyild's FSR.glsl?" >&2; exit 1; }

BASE=$(sed -n "${L},\$p" "$SRC" \
  | sed -e 's|^//!BIND EASUTEX$|//!BIND HOOKED|' \
        -e '/^\/\/!WIDTH EASUTEX\.w$/d' \
        -e '/^\/\/!HEIGHT EASUTEX\.h$/d' \
        -e 's/EASUTEX_/HOOKED_/g')

case "$BASE" in
  *HOOKED_tex*) : ;;
  *) echo "derived shader has no HOOKED_ accessors - upstream FSR.glsl has changed shape" >&2; exit 1 ;;
esac

# low / medium / high as the plugin's deblur ladder sees them: 2.0 gentlest, 1.4 strongest.
for s in 2.0 1.7 1.4; do
  printf '%s\n' "$BASE" \
    | sed "s/^#define SHARPNESS 0.2 /#define SHARPNESS ${s} /" \
    > "$OUT/RCAS-${s}.glsl"
  grep -q "^#define SHARPNESS ${s} " "$OUT/RCAS-${s}.glsl" \
    || { echo "SHARPNESS substitution failed for ${s}" >&2; exit 1; }
done

ls -l "$OUT"/RCAS-*.glsl
