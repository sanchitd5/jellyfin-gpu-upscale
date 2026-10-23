/*
 * ARTIFACT CLEANUP before upscaling, at SOURCE resolution: deblock, then deband. This project's
 * own code (GPLv2-or-later, like the rest of it); nothing here is ported.
 *
 * Why before, not after: at low bitrate the damage is block edges and banding, and an upscaler
 * cannot tell either from detail - EASU sharpens a block edge into a crisper block edge, RCAS
 * then sharpens it again. Cleaning at source size is also cheap: 640x360 is a twentieth of the
 * pixels of the 1440p output.
 *
 * Both passes are pixel-wise in texture space (row 0 = top of the picture), so they need no
 * orientation handling: whatever goes in comes out the same way up.
 */

import { VERTEX } from './fsr1.js';

export { VERTEX };

/*
 * DEBLOCK. Codecs transform in blocks aligned to the top-left of the coded frame (cropping only
 * ever removes rows and columns at the bottom and right), so in the decoded texture block edges
 * sit between pixel 8n-1 and 8n on both axes - 16x16 macroblock edges included. At each edge,
 * per axis, the filter looks at N pixels per side (N = u_taps, 2 for Low, 3 for High) and acts
 * only when BOTH sides are flat (every step inside a side under u_beta) and the step across the
 * edge is small (under u_alpha). That is the signature of a quantisation step: a real edge is
 * either bigger than alpha or has texture next to it. When it acts it turns the step into a
 * linear ramp across the 2N pixels: the pixel k from the edge (k = 0 adjacent) moves toward the
 * other side by D * (2(N-k)-1) / (4N), where D is the step.
 *
 * The decision is made on luma so the three channels move together (no colour fringes), and the
 * correction is applied per channel.
 */
export var DEBLOCK = [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'uniform sampler2D u_src;',
    'uniform ivec2 u_inSize;',
    'uniform float u_alpha;',
    'uniform float u_beta;',
    'uniform int u_taps;',
    'out vec4 o_color;',
    'vec3 px(ivec2 p) { return texelFetch(u_src, clamp(p, ivec2(0), u_inSize - 1), 0).rgb; }',
    'float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }',
    '',
    '// Correction for the pixel at `pos` along one axis. `axis` is (1,0) for vertical edges',
    '// (stepping in x) or (0,1) for horizontal ones.',
    'vec3 edgeFix(ivec2 p, int pos, int size, ivec2 axis) {',
    '    int m = pos - (pos / 8) * 8;',
    '    int edge;          // index of the first pixel AFTER the edge',
    '    int k;             // distance from the edge, 0 = adjacent',
    '    float side;        // +1 on the before side (moves up toward after), -1 after',
    '    if (m < u_taps) { edge = pos - m; k = m; side = -1.0; }',
    '    else if (m >= 8 - u_taps) { edge = pos - m + 8; k = 7 - m; side = 1.0; }',
    '    else { return vec3(0.0); }',
    '    if (edge <= 0 || edge >= size) { return vec3(0.0); }',
    '    ivec2 base = p + axis * (edge - pos);   // first pixel after the edge',
    '    vec3 p0 = px(base - axis);',
    '    vec3 q0 = px(base);',
    '    vec3 d = q0 - p0;',
    '    if (abs(lum(d)) >= u_alpha) { return vec3(0.0); }',
    '    // both sides flat',
    '    for (int t = 1; t < 3; t++) {',
    '        if (t >= u_taps) { break; }',
    '        float sp = lum(px(base - axis * (t + 1)) - px(base - axis * t));',
    '        float sq = lum(px(base + axis * t) - px(base + axis * (t - 1)));',
    '        if (abs(sp) >= u_beta || abs(sq) >= u_beta) { return vec3(0.0); }',
    '    }',
    '    float n = float(u_taps);',
    '    float w = (2.0 * (n - float(k)) - 1.0) / (4.0 * n);',
    '    return side * d * w;',
    '}',
    '',
    'void main() {',
    '    ivec2 p = ivec2(gl_FragCoord.xy);',
    '    vec3 c = px(p);',
    '    c += edgeFix(p, p.x, u_inSize.x, ivec2(1, 0));',
    '    c += edgeFix(p, p.y, u_inSize.y, ivec2(0, 1));',
    '    o_color = vec4(clamp(c, 0.0, 1.0), 1.0);',
    '}'
].join('\n');

/*
 * DEBAND. For each pixel, four samples on a cross at a per-pixel random angle and radius (up to
 * u_radius px). If every sample is within u_thresh of the centre on every channel, the area is a
 * smooth gradient that quantisation has stepped, and the pixel becomes the mean of the samples;
 * otherwise it is detail and is left alone. A tiny dither (under half an 8-bit step) is added
 * only where the pixel was replaced, so the smoothed gradient is not re-quantised into the same
 * bands on the way out.
 *
 * The random pattern is a hash of the pixel position only, so it is the same every frame: no
 * crawling noise in still areas.
 */
export var DEBAND = [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'uniform sampler2D u_src;',
    'uniform ivec2 u_inSize;',
    'uniform float u_thresh;',
    'uniform float u_radius;',
    'out vec4 o_color;',
    'vec3 px(ivec2 p) { return texelFetch(u_src, clamp(p, ivec2(0), u_inSize - 1), 0).rgb; }',
    'float hash(vec2 p) {',
    '    vec3 p3 = fract(vec3(p.xyx) * 0.1031);',
    '    p3 += dot(p3, p3.yzx + 33.33);',
    '    return fract((p3.x + p3.y) * p3.z);',
    '}',
    'void main() {',
    '    ivec2 p = ivec2(gl_FragCoord.xy);',
    '    vec2 fp = vec2(p);',
    '    vec3 c = px(p);',
    '    float a = hash(fp) * 6.2831853;',
    '    float r = u_radius * (0.35 + 0.65 * hash(fp + 17.0));',
    '    vec2 o1 = vec2(cos(a), sin(a)) * r;',
    '    vec2 o2 = vec2(-o1.y, o1.x);',
    '    vec3 s1 = px(p + ivec2(round(o1)));',
    '    vec3 s2 = px(p - ivec2(round(o1)));',
    '    vec3 s3 = px(p + ivec2(round(o2)));',
    '    vec3 s4 = px(p - ivec2(round(o2)));',
    '    vec3 m = max(max(abs(s1 - c), abs(s2 - c)), max(abs(s3 - c), abs(s4 - c)));',
    '    if (max(m.r, max(m.g, m.b)) < u_thresh) {',
    '        vec3 avg = (s1 + s2 + s3 + s4) * 0.25;',
    '        float dither = (hash(fp + 59.0) - 0.5) * (0.9 / 255.0);',
    '        c = avg + dither;',
    '    }',
    '    o_color = vec4(clamp(c, 0.0, 1.0), 1.0);',
    '}'
].join('\n');

/*
 * Strengths. Values are in 0..1 code units (1/255 = one 8-bit step). Chosen by a sweep on
 * synthetic clips at source resolution (smooth content and a gradient, x264 at QP 42 / 38):
 * Low cuts the 8px block-edge ratio of a no-deblock encode from 1.95 to 1.53 (truth 1.18) and
 * leaves a detailed clip at 65.6 dB PSNR against itself uncleaned (i.e. nearly untouched);
 * High cuts it to 1.40 and the gradient's largest blurred band step from 0.31 to 0.20, at
 * 62.8 dB on the detailed clip. Wider deband (thresh 10/255, radius 32) measured worse.
 */
export var CLEANUP_PARAMS = {
    low: { alpha: 10 / 255, beta: 3 / 255, taps: 2, thresh: 5 / 255, radius: 16 },
    high: { alpha: 20 / 255, beta: 5 / 255, taps: 3, thresh: 8 / 255, radius: 24 }
};
