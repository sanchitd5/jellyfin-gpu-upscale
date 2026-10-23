import { log } from '../lib/log.js';
import {
    PREFS_KEY, parseClientPrefs, sharpnessStops, layout, decide, clientLine,
    newGovernor, stepGovernor, PERF_WINDOW_FRAMES, PERF_FULL, PERF_NO_CLEANUP
} from '../model/client-upscale.js';
import { CLEANUP_PARAMS } from '../model/shaders/cleanup.js';
import { createPipeline } from './client-upscale-gl.js';

/*
 * CLIENT-SIDE UPSCALING: the GL canvas over jellyfin-web's <video>, and its lifecycle.
 *
 * WHAT IT DOES. While Jellyfin's video element (video.htmlvideoplayer) is playing a stream that
 * is shown meaningfully larger than it decodes (model/client-upscale.js decide()), a WebGL2
 * canvas sits exactly over the picture and draws each decoded frame through cleanup + FSR 1.
 * The video keeps playing and decoding underneath; the opaque canvas covers its picture. That is
 * the whole "hide the video" mechanism, and it was chosen over opacity/visibility on the video
 * because a video the browser considers invisible may stop presenting frames, which would also
 * stop requestVideoFrameCallback - the clock this runs on.
 *
 * WHERE THE CANVAS GOES. Immediately after the <video>, in the same parent, positioned absolute
 * with no z-index. jellyfin-web adds subtitle layers (the custom .videoSubtitles div, the
 * libass canvas parent, the PGS/VobSub canvas) AFTER the video as well, and positioned siblings
 * paint in DOM order, so they stay on top. A layer inserted later directly after the video would
 * land under the canvas, so every evaluation puts the canvas back directly after the video. The
 * OSD lives outside the player container, above all of it.
 *
 * Native (::cue) text tracks render INSIDE the <video>, so the canvas would hide them: while one
 * is showing, this turns itself off and says so. Everything else keeps working.
 *
 * FAIL SOFT. Every path out is "hide the canvas, show the stock video, log once": no WebGL2, a
 * compile error, a lost context, a texImage2D that throws (a cross-origin video taints the
 * canvas), no video, iOS native fullscreen (the canvas cannot follow), the TV layout.
 */

var CANVAS_ID = 'jellyfinPlusClientUpscale';
var STYLE_ID = 'jellyfinPlusClientUpscaleStyle';
var WATCH_MS = 1000;
var CSS = [
    '#' + CANVAS_ID + ' { position: absolute; display: none; pointer-events: none; margin: 0;'
        + ' padding: 0; border: 0; background: #000; }',
    '#' + CANVAS_ID + '.on { display: block; }',
    // The brightness swipe (view/player-hud.js) filters the video element; the canvas is now what
    // is seen, so it takes the same filter from the same variable.
    'html.jp-brightness-on #' + CANVAS_ID + ' { filter: brightness(var(--jp-brightness, 1)); }'
].join('\n');

var prefs = loadPrefs();
var cur = null;                 // the attachment, see attach()
var status = { decision: null, line: null };
var listeners = [];
var loggedOnce = {};

function logOnce(key, msg, err) {
    if (loggedOnce[key]) { return; }
    loggedOnce[key] = true;
    log('client upscale: ' + msg, err || '');
}

function loadPrefs() {
    try { return parseClientPrefs(window.localStorage.getItem(PREFS_KEY)); } catch (e) { return parseClientPrefs(null); }
}

/* ---------------------------------------------------------------- public: prefs and status */

export function clientPrefs() {
    return { mode: prefs.mode, cleanup: prefs.cleanup, sharpness: prefs.sharpness };
}

export function setClientPrefs(change) {
    var next = clientPrefs();
    Object.keys(change || {}).forEach(function (k) { next[k] = change[k]; });
    prefs = parseClientPrefs(JSON.stringify(next));
    try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* this tab only */ }
    if (!wanted()) {
        detach();                       // Off frees the GL context, not just hides the canvas
    } else if (!cur) {
        var v = document.querySelector('video.htmlvideoplayer');
        if (isPlayerVideo(v) && v.readyState >= 1) { attach(v); }
    } else {
        cur.gov = newGovernor();        // new settings, new measurement
        evaluate();
        drawNow();
    }
    notify(true);
}

/* { line, decision } - line is null when there is nothing to tell the viewer. */
export function clientStatus() {
    return { line: status.line, decision: status.decision };
}

export function onClientStatus(fn) {
    listeners.push(fn);
}

function notify(force) {
    listeners.forEach(function (fn) {
        try { fn(status, force); } catch (e) { /* a listener must not stop the others */ }
    });
}

function setStatus(d, vh, outH) {
    var line = clientLine(d, vh, outH);
    var changed = line !== status.line;
    status = { decision: d, line: line };
    if (changed) {
        log('client upscale: ' + (line || 'off (' + (d && d.reason) + ')'));
        notify(false);
    }
}

/* ---------------------------------------------------------------- facts */

function nativeCuesShowing(video) {
    try {
        var tracks = video.textTracks || [];
        for (var i = 0; i < tracks.length; i++) {
            if (tracks[i].mode === 'showing') { return true; }
        }
    } catch (e) { /* ignore */ }
    return false;
}

function isTv() {
    return document.documentElement.classList.contains('layout-tv');
}

function geometry(video) {
    var fit = '';
    try { fit = window.getComputedStyle(video).objectFit; } catch (e) { /* contain */ }
    return layout(video.clientWidth, video.clientHeight, video.videoWidth, video.videoHeight,
        fit, window.devicePixelRatio || 1);
}

function governorFloor() {
    return prefs.cleanup === 'off' ? PERF_NO_CLEANUP : PERF_FULL;
}

/* ---------------------------------------------------------------- evaluate and place */

function evaluate() {
    if (!cur) { return; }
    var v = cur.video;
    var geo = geometry(v);
    var d = decide({
        mode: prefs.mode,
        tv: isTv(),
        webgl2: !!cur.pipe,
        failure: cur.failure,
        nativeFullscreen: !!v.webkitDisplayingFullscreen,
        pip: document.pictureInPictureElement === v,
        nativeCues: nativeCuesShowing(v),
        vw: v.videoWidth,
        vh: v.videoHeight,
        geo: geo,
        perf: Math.max(cur.gov.level, governorFloor()),
        cleanup: prefs.cleanup
    });
    cur.decision = d;
    cur.geo = geo;

    var c = cur.canvas;
    if (c && d.active) {
        // Keep the canvas directly after the video (see the header: subtitle layers added
        // later must stay above it).
        if (c.parentNode !== v.parentNode || v.nextSibling !== c) {
            v.parentNode.insertBefore(c, v.nextSibling);
        }
        var key = [v.offsetLeft, v.offsetTop, geo.css.x, geo.css.y, geo.css.w, geo.css.h,
            geo.canvasW, geo.canvasH].join(',');
        if (key !== cur.placed) {
            cur.placed = key;
            c.style.left = (v.offsetLeft + geo.css.x) + 'px';
            c.style.top = (v.offsetTop + geo.css.y) + 'px';
            c.style.width = geo.css.w + 'px';
            c.style.height = geo.css.h + 'px';
            if (c.width !== geo.canvasW || c.height !== geo.canvasH) {
                c.width = geo.canvasW;          // clears the canvas: redrawn below
                c.height = geo.canvasH;
            }
            cur.needDraw = true;
        }
        if (!c.classList.contains('on')) {
            c.classList.add('on');
            cur.needDraw = true;
        }
        if (cur.pipe) { cur.pipe.trim(d.cleanup, d.rcas); }
    } else if (c) {
        c.classList.remove('on');
        cur.placed = null;
    }
    setStatus(d, v.videoHeight, geo ? geo.outH : 0);
    if (cur.needDraw) { drawNow(); }
}

/* ---------------------------------------------------------------- drawing */

function drawNow() {
    if (!cur) { return; }
    cur.needDraw = false;
    var d = cur.decision;
    if (!d || !d.active || !cur.pipe || !cur.geo) { return false; }
    var v = cur.video;
    if (v.readyState < 2) { return false; }       // HAVE_CURRENT_DATA
    try {
        cur.pipe.upload(v);
    } catch (err) {
        // A tainted video throws SecurityError. Either way it will throw again next frame.
        cur.failure = (err && err.name === 'SecurityError') ? 'unreadable' : 'gl-error';
        logOnce('upload-' + cur.failure, 'texImage2D failed, showing the stock video', err);
        evaluate();
        return false;
    }
    try {
        cur.pipe.render({
            canvasW: cur.canvas.width,
            canvasH: cur.canvas.height,
            viewport: cur.geo.viewport,
            cleanup: d.cleanup ? CLEANUP_PARAMS[prefs.cleanup] : null,
            rcas: d.rcas,
            sharp: Math.pow(2, -sharpnessStops(prefs.sharpness))
        });
    } catch (err) {
        cur.failure = 'gl-error';
        logOnce('render', 'render failed, showing the stock video', err);
        evaluate();
        return false;
    }
    return true;
}

/*
 * GOVERNOR WINDOW. presentedFrames from requestVideoFrameCallback counts frames the compositor
 * showed; a callback that runs late skips some, and those are frames the canvas never drew (the
 * previous one stayed up). Big jumps (seek, resume, a background tab) are discontinuities, not
 * slowness, and are not counted.
 */
function measure(meta) {
    var w = cur.win;
    var now = window.performance.now();
    if (!meta || document.hidden || cur.video.paused) { cur.win = null; return; }
    if (!w) {
        cur.win = { frames: 0, drawn: 0, last: meta.presentedFrames, t0: now,
            dropped0: droppedFrames(cur.video) };
        return;
    }
    var delta = meta.presentedFrames - w.last;
    w.last = meta.presentedFrames;
    if (delta <= 0) { return; }
    if (delta > 8) { cur.win = null; return; }
    w.frames += delta;
    w.drawn += 1;
    if (w.frames < PERF_WINDOW_FRAMES) { return; }
    var sample = {
        frames: w.frames,
        missed: Math.max(0, w.frames - w.drawn),
        dropped: Math.max(0, droppedFrames(cur.video) - w.dropped0),
        gpuMs: cur.pipe ? cur.pipe.gpuMs : null,
        budgetMs: (now - w.t0) / w.frames
    };
    cur.win = null;
    var before = cur.gov.level;
    cur.gov = stepGovernor(cur.gov, sample, governorFloor());
    if (cur.gov.level !== before) {
        log('client upscale: governor ' + before + ' -> ' + cur.gov.level + ' ' + JSON.stringify(sample));
        evaluate();
    }
}

function droppedFrames(v) {
    try {
        var q = v.getVideoPlaybackQuality && v.getVideoPlaybackQuality();
        return q ? q.droppedVideoFrames || 0 : 0;
    } catch (e) { return 0; }
}

function startLoop() {
    var a = cur;
    var v = a.video;
    if (typeof v.requestVideoFrameCallback === 'function') {
        var onFrame = function (now, meta) {
            if (cur !== a) { return; }
            a.rvfc = v.requestVideoFrameCallback(onFrame);
            if (a.decision && a.decision.active && drawNow()) {
                measure(meta);
            } else {
                a.win = null;
            }
        };
        a.rvfc = v.requestVideoFrameCallback(onFrame);
        return;
    }
    // Fallback: requestAnimationFrame, drawing only when currentTime moved. Runs only while
    // playing; 'play' and 'seeked' restart it, so a paused video costs nothing.
    a.rafTick = function () {
        a.raf = 0;
        if (cur !== a) { return; }
        if (v.currentTime !== a.lastTime) {
            a.lastTime = v.currentTime;
            drawNow();
        }
        if (!v.paused && !v.ended) { a.raf = window.requestAnimationFrame(a.rafTick); }
    };
    a.raf = window.requestAnimationFrame(a.rafTick);
}

function kickLoop() {
    if (cur && cur.rafTick && !cur.raf) { cur.raf = window.requestAnimationFrame(cur.rafTick); }
}

/* ---------------------------------------------------------------- attach / detach */

function makeGl(a) {
    try {
        var gl = a.canvas.getContext('webgl2', {
            alpha: false, antialias: false, depth: false, stencil: false,
            premultipliedAlpha: false, preserveDrawingBuffer: false,
            powerPreference: 'high-performance'
        });
        if (!gl) {
            logOnce('no-webgl2', 'no WebGL2 context, showing the stock video');
            return;
        }
        a.gl = gl;
        a.pipe = createPipeline(gl);
        log('client upscale: WebGL2 pipeline ready', gl.getParameter(gl.VERSION),
            a.pipe.hasTimer ? '(GPU timer available)' : '(no GPU timer)');
    } catch (err) {
        a.pipe = null;
        a.failure = 'gl-error';
        logOnce('gl-init', 'WebGL2 pipeline failed, showing the stock video', err);
    }
}

function attach(video) {
    if (cur && cur.video === video) { return; }
    detach();
    var canvas = document.createElement('canvas');
    canvas.id = CANVAS_ID;
    canvas.setAttribute('aria-hidden', 'true');
    var a = {
        video: video, canvas: canvas, gl: null, pipe: null, failure: null,
        gov: newGovernor(), decision: null, geo: null, placed: null, needDraw: false,
        win: null, rvfc: 0, raf: 0, rafTick: null, lastTime: -1, ro: null, watch: 0, off: []
    };
    cur = a;
    video.parentNode.insertBefore(canvas, video.nextSibling);
    makeGl(a);

    var on = function (target, type, fn, opts) {
        target.addEventListener(type, fn, opts);
        a.off.push(function () { target.removeEventListener(type, fn, opts); });
    };
    on(canvas, 'webglcontextlost', function (e) {
        e.preventDefault();             // without this the context is never restored
        a.failure = 'context-lost';
        logOnce('lost', 'WebGL context lost, showing the stock video');
        if (cur === a) { evaluate(); }
    });
    on(canvas, 'webglcontextrestored', function () {
        a.failure = null;
        a.pipe = null;
        makeGl(a);
        log('client upscale: WebGL context restored');
        loggedOnce.lost = false;
        if (cur === a) { a.placed = null; evaluate(); }
    });
    on(window, 'resize', function () { if (cur === a) { evaluate(); } });
    try {
        on(video.textTracks, 'change', function () { if (cur === a) { evaluate(); } });
    } catch (e) { /* no textTracks: the watchdog still checks */ }
    try {
        a.ro = new window.ResizeObserver(function () { if (cur === a) { evaluate(); } });
        a.ro.observe(video);
        if (video.parentNode) { a.ro.observe(video.parentNode); }
    } catch (e) { /* the window resize listener and the watchdog cover it, a second late */ }

    // The watchdog: detach once the video leaves the page (navigation away, player destroyed),
    // and re-evaluate what has no event of its own here (the TV layout class, a subtitle layer
    // inserted after the canvas, a layout change the observer did not see).
    a.watch = window.setInterval(function () {
        if (cur !== a) { return; }
        if (!video.isConnected || !wanted()) { detach(); return; }
        evaluate();
    }, WATCH_MS);

    startLoop();
    evaluate();
    log('client upscale: attached to the video');
}

function detach() {
    var a = cur;
    if (!a) { return; }
    cur = null;
    try {
        if (a.rvfc && a.video.cancelVideoFrameCallback) { a.video.cancelVideoFrameCallback(a.rvfc); }
        if (a.raf) { window.cancelAnimationFrame(a.raf); }
        if (a.watch) { window.clearInterval(a.watch); }
        if (a.ro) { a.ro.disconnect(); }
        a.off.forEach(function (f) { f(); });
        if (a.pipe) { a.pipe.destroy(); }
        if (a.gl) {
            var lose = a.gl.getExtension('WEBGL_lose_context');
            if (lose) { lose.loseContext(); }
        }
        if (a.canvas.parentNode) { a.canvas.parentNode.removeChild(a.canvas); }
    } catch (err) {
        log('client upscale: detach failed', err);
    }
    status = { decision: null, line: null };
    notify(false);
    log('client upscale: detached');
}

/* ---------------------------------------------------------------- install */

function isPlayerVideo(t) {
    return !!(t && t.tagName === 'VIDEO' && t.classList.contains('htmlvideoplayer') && t.isConnected);
}

/* Off by choice, or the TV layout: nothing is attached at all, so nothing is allocated. */
function wanted() {
    return prefs.mode !== 'off' && !isTv();
}

/*
 * Media events do not bubble, but they do go through the capture phase on document - the same
 * seam controller/player-speed.js uses for 'ratechange'. So one set of listeners here sees
 * every <video> jellyfin-web ever makes, with no player module access at all.
 */
function onMedia(e) {
    try {
        var v = e.target;
        if (!isPlayerVideo(v)) { return; }
        if (!wanted()) { detach(); return; }
        switch (e.type) {
        case 'loadedmetadata':
            attach(v);
            // A new source on this element: new item or stream switch. Start measuring afresh
            // and give a previously unreadable source another chance.
            cur.gov = newGovernor();
            if (cur.failure === 'unreadable') { cur.failure = null; }
            evaluate();
            break;
        case 'playing':
        case 'resize':              // videoWidth/videoHeight changed (quality switch, live apply)
            attach(v);
            evaluate();
            kickLoop();
            break;
        case 'play':
            kickLoop();
            break;
        case 'seeked':
            if (cur && cur.video === v) { drawNow(); kickLoop(); }
            break;
        case 'emptied':
            if (cur && cur.video === v) { evaluate(); }
            break;
        default:                    // fullscreen and PiP enter/leave
            if (cur && cur.video === v) { evaluate(); }
        }
    } catch (err) {
        log('client upscale: media event failed', err);
    }
}

export function installClientUpscale() {
    if (!document.getElementById(STYLE_ID)) {
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);
    }
    ['loadedmetadata', 'playing', 'resize', 'play', 'seeked', 'emptied',
        'webkitbeginfullscreen', 'webkitendfullscreen',
        'enterpictureinpicture', 'leavepictureinpicture'].forEach(function (type) {
        document.addEventListener(type, onMedia, true);
    });
    // Already playing when the script installs (unlikely, but cheap to cover).
    var v = document.querySelector('video.htmlvideoplayer');
    if (wanted() && isPlayerVideo(v) && v.readyState >= 1) { attach(v); }
    log('client upscale: installed, mode ' + prefs.mode);
}
