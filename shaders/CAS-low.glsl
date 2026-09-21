// Contrast Adaptive Sharpening (AMD FidelityFX CAS), mpv/libplacebo user-shader port.
//
// Chosen over a plain unsharp mask because the sharpening amount is scaled by local contrast:
// flat areas (where low-bitrate cam footage keeps its blocking and noise) are left alone, while
// soft edges get the lift. The output is also clamped to the local neighbourhood min/max, which is
// what keeps it from ringing into halos the way unsharp does - important here because FSRCNNX has
// already sharpened the luma on the way up.
//
// Hooked at MAIN, i.e. after scaling, so it operates on the final output pixels.
// SHARPNESS is substituted by the plugin: 0.0 = gentlest, 1.0 = strongest.

//!HOOK MAIN
//!BIND HOOKED
//!DESC contrast adaptive sharpen (strength 0.00)

#define SHARPNESS 0.00

vec4 hook() {
    // 3x3 neighbourhood:  a b c
    //                     d e f
    //                     g h i
    vec3 a = HOOKED_texOff(vec2(-1.0, -1.0)).rgb;
    vec3 b = HOOKED_texOff(vec2( 0.0, -1.0)).rgb;
    vec3 c = HOOKED_texOff(vec2( 1.0, -1.0)).rgb;
    vec3 d = HOOKED_texOff(vec2(-1.0,  0.0)).rgb;
    vec4 ePix = HOOKED_texOff(vec2( 0.0,  0.0));
    vec3 e = ePix.rgb;
    vec3 f = HOOKED_texOff(vec2( 1.0,  0.0)).rgb;
    vec3 g = HOOKED_texOff(vec2(-1.0,  1.0)).rgb;
    vec3 h = HOOKED_texOff(vec2( 0.0,  1.0)).rgb;
    vec3 i = HOOKED_texOff(vec2( 1.0,  1.0)).rgb;

    // Local extremes over the cross, then softened by the diagonals, per FidelityFX CAS.
    vec3 mnRGB = min(min(min(d, e), min(f, b)), h);
    vec3 mnRGB2 = min(mnRGB, min(min(a, c), min(g, i)));
    mnRGB += mnRGB2;

    vec3 mxRGB = max(max(max(d, e), max(f, b)), h);
    vec3 mxRGB2 = max(mxRGB, max(max(a, c), max(g, i)));
    mxRGB += mxRGB2;

    // How much headroom this pixel has before clipping; flat or already-clipped areas get ~0.
    vec3 rcpMRGB = vec3(1.0) / max(mxRGB, vec3(1.0e-5));
    vec3 ampRGB = clamp(min(mnRGB, vec3(2.0) - mxRGB) * rcpMRGB, 0.0, 1.0);
    ampRGB = sqrt(ampRGB);

    // Sharpness -0.125 (subtle) .. -0.2 (strong), scaled by the local amplitude.
    float peak = -1.0 / mix(8.0, 5.0, clamp(SHARPNESS, 0.0, 1.0));
    vec3 wRGB = ampRGB * peak;
    vec3 rcpWeightRGB = vec3(1.0) / (vec3(1.0) + 4.0 * wRGB);

    vec3 outColor = clamp((b * wRGB + d * wRGB + f * wRGB + h * wRGB + e) * rcpWeightRGB, 0.0, 1.0);
    return vec4(outColor, ePix.a);
}
