/*!
 * @license MIT (AMD FidelityFX FSR 1). The "/*!" and @license mark this as a legal comment, so
 * esbuild keeps it in the minified bundle (at its end): the MIT notice must ship with the code.
 *
 * AMD FidelityFX Super Resolution 1 (EASU + RCAS) as WebGL2 / GLSL ES 3.00 fragment shaders.
 *
 * Ported from ffx_fsr1.h, "AMD FidelityFX SUPER RESOLUTION [FSR 1] ::: SPATIAL SCALING & EXTRAS -
 * v1.20210629", https://github.com/GPUOpen-Effects/FidelityFX-FSR (ffx-fsr/ffx_fsr1.h), the
 * NON-PACKED 32-BIT paths FsrEasuF / FsrRcasF and their constant setup FsrEasuCon / FsrRcasCon.
 * What changed in the port, and nothing else:
 *   - GLSL ES 3.00 has no textureGather, so the 12 EASU taps are 12 texelFetch calls (clamped to
 *     the image), not 4 gathers. Tap positions, weights and order are AMD's.
 *   - The ffx_a.h helpers are spelled out: APrxLoRcpF1 / APrxMedRcpF1 / APrxLoRsqF1 become exact
 *     1/x and inversesqrt (guarded where the original bit-trick approximation would have returned
 *     a huge finite number for 0 and plain IEEE would give inf or NaN), ASatF1 becomes clamp.
 *   - The four constant vectors are computed in the shader from the input and output sizes.
 *   - u_flipY / u_origin map gl_FragCoord to AMD's top-down integer output position, because the
 *     last pass draws to a bottom-up default framebuffer and the viewport may overhang the canvas.
 *   - RCAS runs without FSR_RCAS_DENOISE and without alpha passthrough (AMD's defaults).
 *
 * The original copyright and licence, which must stay with this code:
 *
 * Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files(the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and / or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions :
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

/* Shared by every pass: one oversized triangle, no attributes. */
export var VERTEX = [
    '#version 300 es',
    'void main() {',
    '    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));',
    '    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);',
    '}'
].join('\n');

/*
 * Integer output position, top-down, relative to the viewport origin. Every pass uses this so a
 * texture row 0 is always the top of the picture, whichever framebuffer the pass draws into.
 */
var OUTPOS = [
    'uniform ivec2 u_origin;   // viewport origin in the framebuffer',
    'uniform ivec2 u_outSize;  // viewport size',
    'uniform bool u_flipY;     // drawing into the bottom-up default framebuffer',
    'ivec2 outPos() {',
    '    ivec2 p = ivec2(gl_FragCoord.xy) - u_origin;',
    '    if (u_flipY) { p.y = u_outSize.y - 1 - p.y; }',
    '    return p;',
    '}'
].join('\n');

export var EASU = [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'uniform sampler2D u_src;',
    'uniform ivec2 u_inSize;',
    OUTPOS,
    'out vec4 o_color;',
    '',
    'vec3 tap(ivec2 p) { return texelFetch(u_src, clamp(p, ivec2(0), u_inSize - 1), 0).rgb; }',
    'float rcpSafe(float x) { return 1.0 / max(x, 1.0 / 65536.0); }',
    '',
    '// FsrEasuTapF',
    'void easuTap(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len, float lob, float clp, vec3 c) {',
    '    vec2 v;',
    '    v.x = (off.x * ( dir.x)) + (off.y * dir.y);',
    '    v.y = (off.x * (-dir.y)) + (off.y * dir.x);',
    '    v *= len;',
    '    float d2 = v.x * v.x + v.y * v.y;',
    '    d2 = min(d2, clp);',
    '    float wB = (2.0 / 5.0) * d2 - 1.0;',
    '    float wA = lob * d2 - 1.0;',
    '    wB *= wB;',
    '    wA *= wA;',
    '    wB = (25.0 / 16.0) * wB - (25.0 / 16.0 - 1.0);',
    '    float w = wB * wA;',
    '    aC += c * w;',
    '    aW += w;',
    '}',
    '',
    '// FsrEasuSetF, with the bilinear weight passed in rather than selected by predicates',
    'void easuSet(inout vec2 dir, inout float len, float w, float lA, float lB, float lC, float lD, float lE) {',
    '    float dc = lD - lC;',
    '    float cb = lC - lB;',
    '    float lenX = max(abs(dc), abs(cb));',
    '    lenX = rcpSafe(lenX);',
    '    float dirX = lD - lB;',
    '    dir.x += dirX * w;',
    '    lenX = clamp(abs(dirX) * lenX, 0.0, 1.0);',
    '    lenX *= lenX;',
    '    len += lenX * w;',
    '    float ec = lE - lC;',
    '    float ca = lC - lA;',
    '    float lenY = max(abs(ec), abs(ca));',
    '    lenY = rcpSafe(lenY);',
    '    float dirY = lE - lA;',
    '    dir.y += dirY * w;',
    '    lenY = clamp(abs(dirY) * lenY, 0.0, 1.0);',
    '    lenY *= lenY;',
    '    len += lenY * w;',
    '}',
    '',
    'float luma2(vec3 c) { return c.b * 0.5 + (c.r * 0.5 + c.g); }',
    '',
    'void main() {',
    '    ivec2 ip = outPos();',
    '    // FsrEasuCon con0: output pixel -> input pixel position',
    '    vec2 inS = vec2(u_inSize);',
    '    vec2 outS = vec2(u_outSize);',
    '    vec2 pp = vec2(ip) * (inS / outS) + (0.5 * inS / outS - 0.5);',
    '    vec2 fpf = floor(pp);',
    '    pp -= fpf;',
    '    ivec2 fp = ivec2(fpf);',
    '    //    b c',
    '    //  e f g h',
    '    //  i j k l',
    '    //    n o',
    '    vec3 b = tap(fp + ivec2( 0, -1));',
    '    vec3 c = tap(fp + ivec2( 1, -1));',
    '    vec3 e = tap(fp + ivec2(-1,  0));',
    '    vec3 f = tap(fp + ivec2( 0,  0));',
    '    vec3 g = tap(fp + ivec2( 1,  0));',
    '    vec3 h = tap(fp + ivec2( 2,  0));',
    '    vec3 i = tap(fp + ivec2(-1,  1));',
    '    vec3 j = tap(fp + ivec2( 0,  1));',
    '    vec3 k = tap(fp + ivec2( 1,  1));',
    '    vec3 l = tap(fp + ivec2( 2,  1));',
    '    vec3 n = tap(fp + ivec2( 0,  2));',
    '    vec3 o = tap(fp + ivec2( 1,  2));',
    '    float bL = luma2(b), cL = luma2(c), eL = luma2(e), fL = luma2(f);',
    '    float gL = luma2(g), hL = luma2(h), iL = luma2(i), jL = luma2(j);',
    '    float kL = luma2(k), lL = luma2(l), nL = luma2(n), oL = luma2(o);',
    '    vec2 dir = vec2(0.0);',
    '    float len = 0.0;',
    '    easuSet(dir, len, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL);',
    '    easuSet(dir, len,        pp.x  * (1.0 - pp.y), cL, fL, gL, hL, kL);',
    '    easuSet(dir, len, (1.0 - pp.x) *        pp.y , fL, iL, jL, kL, nL);',
    '    easuSet(dir, len,        pp.x  *        pp.y , gL, jL, kL, lL, oL);',
    '    vec2 dir2 = dir * dir;',
    '    float dirR = dir2.x + dir2.y;',
    '    bool zro = dirR < (1.0 / 32768.0);',
    '    dirR = zro ? 1.0 : inversesqrt(dirR);',
    '    dir.x = zro ? 1.0 : dir.x;',
    '    dir *= vec2(dirR);',
    '    len = len * 0.5;',
    '    len *= len;',
    '    float stretch = (dir.x * dir.x + dir.y * dir.y) * rcpSafe(max(abs(dir.x), abs(dir.y)));',
    '    vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);',
    '    float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;',
    '    float clp = 1.0 / lob;',
    '    vec3 min4 = min(min(f, g), min(j, k));',
    '    vec3 max4 = max(max(f, g), max(j, k));',
    '    vec3 aC = vec3(0.0);',
    '    float aW = 0.0;',
    '    easuTap(aC, aW, vec2( 0.0, -1.0) - pp, dir, len2, lob, clp, b);',
    '    easuTap(aC, aW, vec2( 1.0, -1.0) - pp, dir, len2, lob, clp, c);',
    '    easuTap(aC, aW, vec2(-1.0,  1.0) - pp, dir, len2, lob, clp, i);',
    '    easuTap(aC, aW, vec2( 0.0,  1.0) - pp, dir, len2, lob, clp, j);',
    '    easuTap(aC, aW, vec2( 0.0,  0.0) - pp, dir, len2, lob, clp, f);',
    '    easuTap(aC, aW, vec2(-1.0,  0.0) - pp, dir, len2, lob, clp, e);',
    '    easuTap(aC, aW, vec2( 1.0,  1.0) - pp, dir, len2, lob, clp, k);',
    '    easuTap(aC, aW, vec2( 2.0,  1.0) - pp, dir, len2, lob, clp, l);',
    '    easuTap(aC, aW, vec2( 2.0,  0.0) - pp, dir, len2, lob, clp, h);',
    '    easuTap(aC, aW, vec2( 1.0,  0.0) - pp, dir, len2, lob, clp, g);',
    '    easuTap(aC, aW, vec2( 1.0,  2.0) - pp, dir, len2, lob, clp, o);',
    '    easuTap(aC, aW, vec2( 0.0,  2.0) - pp, dir, len2, lob, clp, n);',
    '    vec3 pix = min(max4, max(min4, aC / aW));',
    '    o_color = vec4(pix, 1.0);',
    '}'
].join('\n');

/* FsrRcasF. u_sharp is FsrRcasCon's con.x: exp2(-stops). */
export var RCAS = [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'uniform sampler2D u_src;',
    'uniform ivec2 u_inSize;',
    'uniform float u_sharp;',
    OUTPOS,
    'out vec4 o_color;',
    '#define FSR_RCAS_LIMIT (0.25 - (1.0 / 16.0))',
    'vec3 load(ivec2 p) { return texelFetch(u_src, clamp(p, ivec2(0), u_inSize - 1), 0).rgb; }',
    'float max3(float a, float b, float c) { return max(a, max(b, c)); }',
    'float min3(float a, float b, float c) { return min(a, min(b, c)); }',
    'void main() {',
    '    ivec2 sp = outPos();',
    '    //    b',
    '    //  d e f',
    '    //    h',
    '    vec3 b = load(sp + ivec2( 0, -1));',
    '    vec3 d = load(sp + ivec2(-1,  0));',
    '    vec3 e = load(sp);',
    '    vec3 f = load(sp + ivec2( 1,  0));',
    '    vec3 h = load(sp + ivec2( 0,  1));',
    '    vec3 mn4 = min(min(b, d), min(f, h));',
    '    vec3 mx4 = max(max(b, d), max(f, h));',
    '    vec2 peakC = vec2(1.0, -1.0 * 4.0);',
    '    // AMD asks for high-precision reciprocals here; the guards keep 0 and 1 from making inf/NaN.',
    '    vec3 hitMin = min(mn4, e) / max(4.0 * mx4, vec3(1.0 / 65536.0));',
    '    vec3 hitMax = (peakC.x - max(mx4, e)) / min(4.0 * mn4 + peakC.y, vec3(-1.0 / 65536.0));',
    '    vec3 lobeRGB = max(-hitMin, hitMax);',
    '    float lobe = max(-FSR_RCAS_LIMIT, min(max3(lobeRGB.r, lobeRGB.g, lobeRGB.b), 0.0)) * u_sharp;',
    '    float rcpL = 1.0 / (4.0 * lobe + 1.0);',
    '    vec3 pix = (lobe * b + lobe * d + lobe * h + lobe * f + e) * rcpL;',
    '    o_color = vec4(pix, 1.0);',
    '}'
].join('\n');

/*
 * Plain bilinear at the same geometry, used by the verification harness as the baseline EASU
 * is compared against (it is what the browser itself does to a <video>). Not used for playback.
 */
export var BILINEAR = [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'uniform sampler2D u_src;',
    'uniform ivec2 u_inSize;',
    OUTPOS,
    'out vec4 o_color;',
    'void main() {',
    '    vec2 ip = vec2(outPos()) + 0.5;',
    '    vec2 uv = ip / vec2(u_outSize);',
    '    o_color = vec4(texture(u_src, uv).rgb, 1.0);',
    '}'
].join('\n');
