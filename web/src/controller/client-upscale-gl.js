import { VERTEX, EASU, RCAS, BILINEAR } from '../model/shaders/fsr1.js';
import { DEBLOCK, DEBAND } from '../model/shaders/cleanup.js';

/*
 * THE WEBGL2 PIPELINE for client-side upscaling. GL only: no DOM policy, no decisions (those are
 * model/client-upscale.js and controller/client-upscale.js). Kept separate so the verification
 * harness can drive exactly the code that ships.
 *
 *   video --texImage2D--> SRC
 *   [cleanup] SRC --deblock--> A --deband--> B           (source resolution)
 *   EASU  (SRC or B) --> OUT (output resolution)         or straight to the canvas without RCAS
 *   RCAS  OUT --> canvas
 *
 * Every texture keeps row 0 = top of the picture; only the pass that draws into the canvas
 * flips (u_flipY), because the default framebuffer is bottom-up.
 *
 * Anything that fails throws: the caller turns a throw into "off" and shows the stock video.
 */

function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
        var msg = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error('shader compile failed: ' + msg);
    }
    return s;
}

function program(gl, fragSrc) {
    var vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
    var fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
    var p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
        var msg = gl.getProgramInfoLog(p);
        gl.deleteProgram(p);
        throw new Error('program link failed: ' + msg);
    }
    var cache = {};
    return {
        p: p,
        u: function (name) {
            if (!(name in cache)) { cache[name] = gl.getUniformLocation(p, name); }
            return cache[name];
        }
    };
}

function makeTexture(gl) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
}

/* A render target: texture plus framebuffer, (re)allocated only when the size changes. */
function makeTarget(gl) {
    var tgt = { tex: makeTexture(gl), fb: gl.createFramebuffer(), w: 0, h: 0 };
    tgt.size = function (w, h) {
        if (w === tgt.w && h === tgt.h) { return; }
        gl.bindTexture(gl.TEXTURE_2D, tgt.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, tgt.fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tgt.tex, 0);
        tgt.w = w;
        tgt.h = h;
    };
    tgt.free = function () {
        gl.deleteTexture(tgt.tex);
        gl.deleteFramebuffer(tgt.fb);
    };
    return tgt;
}

export function createPipeline(gl) {
    var progs = {
        easu: program(gl, EASU),
        rcas: program(gl, RCAS),
        deblock: program(gl, DEBLOCK),
        deband: program(gl, DEBAND),
        bilinear: null      // harness only, compiled on first use
    };
    var vao = gl.createVertexArray();
    var src = makeTexture(gl);
    var srcW = 0;
    var srcH = 0;
    var tA = makeTarget(gl);
    var tB = makeTarget(gl);
    var tOut = makeTarget(gl);

    // GPU time per frame, where the browser exposes it (EXT_disjoint_timer_query_webgl2 is off
    // in many browsers). One query in flight; its answer arrives a frame or two later.
    var timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    var query = null;
    var gpuMs = null;

    function pollTimer() {
        if (!timerExt || !query) { return; }
        var ready = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE);
        var disjoint = gl.getParameter(timerExt.GPU_DISJOINT_EXT);
        if (ready) {
            if (!disjoint) { gpuMs = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6; }
            gl.deleteQuery(query);
            query = null;
        }
    }

    function draw(prog, fb, vx, vy, vw, vh, inTex, inW, inH, flip, outW, outH, setup) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.viewport(vx, vy, vw, vh);
        gl.useProgram(prog.p);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, inTex);
        gl.uniform1i(prog.u('u_src'), 0);
        gl.uniform2i(prog.u('u_inSize'), inW, inH);
        gl.uniform2i(prog.u('u_origin'), vx, vy);
        gl.uniform2i(prog.u('u_outSize'), outW, outH);
        gl.uniform1i(prog.u('u_flipY'), flip ? 1 : 0);
        if (setup) { setup(prog); }
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    return {
        get srcW() { return srcW; },
        get srcH() { return srcH; },
        get gpuMs() { return gpuMs; },
        hasTimer: !!timerExt,

        /* Upload the current frame. Throws on a tainted (cross-origin) video: SecurityError. */
        upload: function (video) {
            gl.bindTexture(gl.TEXTURE_2D, src);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
            srcW = video.videoWidth || video.naturalWidth || video.width;
            srcH = video.videoHeight || video.naturalHeight || video.height;
        },

        /*
         * o.canvasW/H   drawing-buffer size
         * o.viewport    {x,y,w,h} where the whole picture lands (GL coords, may overhang)
         * o.cleanup     CLEANUP_PARAMS entry or null
         * o.rcas        bool, o.sharp = exp2(-stops)
         * o.method      'fsr' (default) or 'bilinear' (harness baseline)
         */
        render: function (o) {
            if (!srcW || !srcH) { return; }
            pollTimer();
            var timing = false;
            if (timerExt && !query) {
                query = gl.createQuery();
                gl.beginQuery(timerExt.TIME_ELAPSED_EXT, query);
                timing = true;
            }
            gl.bindVertexArray(vao);
            gl.disable(gl.BLEND);
            gl.disable(gl.DEPTH_TEST);

            var input = src;
            if (o.cleanup) {
                tA.size(srcW, srcH);
                tB.size(srcW, srcH);
                draw(progs.deblock, tA.fb, 0, 0, srcW, srcH, src, srcW, srcH, false, srcW, srcH, function (p) {
                    gl.uniform1f(p.u('u_alpha'), o.cleanup.alpha);
                    gl.uniform1f(p.u('u_beta'), o.cleanup.beta);
                    gl.uniform1i(p.u('u_taps'), o.cleanup.taps);
                });
                draw(progs.deband, tB.fb, 0, 0, srcW, srcH, tA.tex, srcW, srcH, false, srcW, srcH, function (p) {
                    gl.uniform1f(p.u('u_thresh'), o.cleanup.thresh);
                    gl.uniform1f(p.u('u_radius'), o.cleanup.radius);
                });
                input = tB.tex;
            }

            var vp = o.viewport;
            // Letterbox / anything outside the viewport is black, like the stock player's.
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, o.canvasW, o.canvasH);
            gl.clearColor(0, 0, 0, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);

            if (o.method === 'bilinear') {
                if (!progs.bilinear) { progs.bilinear = program(gl, BILINEAR); }
                draw(progs.bilinear, null, vp.x, vp.y, vp.w, vp.h, input, srcW, srcH, true, vp.w, vp.h);
            } else if (o.rcas) {
                tOut.size(vp.w, vp.h);
                draw(progs.easu, tOut.fb, 0, 0, vp.w, vp.h, input, srcW, srcH, false, vp.w, vp.h);
                draw(progs.rcas, null, vp.x, vp.y, vp.w, vp.h, tOut.tex, vp.w, vp.h, true, vp.w, vp.h, function (p) {
                    gl.uniform1f(p.u('u_sharp'), o.sharp);
                });
            } else {
                draw(progs.easu, null, vp.x, vp.y, vp.w, vp.h, input, srcW, srcH, true, vp.w, vp.h);
            }
            if (timing) { gl.endQuery(timerExt.TIME_ELAPSED_EXT); }
        },

        /* Frees what is not needed any more, e.g. after cleanup or RCAS is switched off. */
        trim: function (keepCleanup, keepRcas) {
            if (!keepCleanup) { tA.size(1, 1); tB.size(1, 1); }
            if (!keepRcas) { tOut.size(1, 1); }
        },

        destroy: function () {
            try {
                if (query) { gl.deleteQuery(query); }
                [tA, tB, tOut].forEach(function (t) { t.free(); });
                gl.deleteTexture(src);
                gl.deleteVertexArray(vao);
                Object.keys(progs).forEach(function (k) { if (progs[k]) { gl.deleteProgram(progs[k].p); } });
            } catch (e) { /* context already gone */ }
        }
    };
}
