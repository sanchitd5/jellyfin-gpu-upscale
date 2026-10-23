/*
 * CLIENT-SIDE UPSCALING (pure).
 *
 * When the stream that arrives is meaningfully smaller than the picture on screen, the browser
 * can upscale it on the viewer's own GPU: artifact cleanup (deblock + deband) at source
 * resolution, then AMD FidelityFX FSR 1 (EASU upscale, RCAS sharpen). Nothing here talks to the
 * server: it adds no request parameter and is not a server axis. The controller
 * (controller/client-upscale.js) owns the GL and the DOM; everything that DECIDES lives here so it
 * can be tested without a browser.
 *
 * Preferences are per device (one localStorage key, never synced): what this device's GPU can
 * do is a property of the device, not of the account.
 */

export var PREFS_KEY = 'jellyfinPlusClientUpscale';

export var MODES = [
    { id: 'off', name: 'Off' },
    { id: 'auto', name: 'Auto' },
    { id: 'always', name: 'Always' }
];

export var CLEANUP_LEVELS = [
    { id: 'off', name: 'Off' },
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' }
];

/*
 * RCAS sharpness is in STOPS and inverted: 0 is AMD's maximum, every +1 halves it. 0.25 is the
 * default the brief asked for, a little under maximum.
 */
export var SHARPNESS_LEVELS = [
    { id: '0', name: 'Strong', stops: 0 },
    { id: '0.25', name: 'Default', stops: 0.25 },
    { id: '0.5', name: 'Gentle', stops: 0.5 },
    { id: '1', name: 'Light', stops: 1 }
];

export var DEFAULT_CLIENT_PREFS = { mode: 'auto', cleanup: 'low', sharpness: '0.25' };

/*
 * THE AUTO THRESHOLD. Auto runs when the picture is shown at 1.15x its decoded size or more.
 *
 *   - Below it EASU's gain over the browser's own bilinear is small: at 1.07x (1280x720 on a
 *     1366x768 laptop, the commonest case) fewer than one output pixel in fourteen is new, and
 *     the cost is still a full extra render of the screen.
 *   - It keeps a stream the server already sent at display size (scale 1.0, or a hair above
 *     from fractional devicePixelRatio rounding) off by itself: Auto never stacks a second
 *     upscale on the server's without a reason.
 *   - 1.15 still catches every real low-bandwidth case: 720p on a 900p screen is 1.25x, 720p on
 *     1080p 1.5x, 540p on 1080p 2x, 360p on 1440p 4x.
 *
 * Always lowers it to "any upscale at all" (> 1.0). Neither mode runs when the picture is shown
 * SMALLER than it decodes: EASU is an upscaler, and minifying with it aliases, which would be a
 * worse picture than stock.
 */
export var AUTO_MIN_SCALE = 1.15;
export var ALWAYS_MIN_SCALE = 1.0;

/* Output is the canvas's device-pixel size, capped at about a 4K frame's pixel count. */
export var MAX_OUTPUT_PIXELS = 3840 * 2160;

function pick(list, id, fallback) {
    return list.some(function (o) { return o.id === id; }) ? id : fallback;
}

/* Prefs from the stored JSON string. Anything unparsable or unknown falls back per field. */
export function parseClientPrefs(raw) {
    var p = {};
    try { p = raw ? JSON.parse(raw) || {} : {}; } catch (e) { p = {}; }
    if (typeof p !== 'object') { p = {}; }
    return {
        mode: pick(MODES, p.mode, DEFAULT_CLIENT_PREFS.mode),
        cleanup: pick(CLEANUP_LEVELS, p.cleanup, DEFAULT_CLIENT_PREFS.cleanup),
        sharpness: pick(SHARPNESS_LEVELS, String(p.sharpness), DEFAULT_CLIENT_PREFS.sharpness)
    };
}

export function sharpnessStops(id) {
    var s = SHARPNESS_LEVELS.filter(function (o) { return o.id === String(id); })[0];
    return s ? s.stops : 0.25;
}

/*
 * Where the picture actually is inside the video element's box (CSS px, relative to the box),
 * for the element's object-fit. 'contain' (stock) letterboxes, 'cover' overflows the box and is
 * cropped by it, 'fill' stretches. Anything else is treated as contain.
 */
export function contentRect(boxW, boxH, vw, vh, fit) {
    if (!(boxW > 0 && boxH > 0 && vw > 0 && vh > 0)) { return null; }
    if (fit === 'fill') { return { x: 0, y: 0, w: boxW, h: boxH }; }
    var sx = boxW / vw;
    var sy = boxH / vh;
    var s = fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
    var w = vw * s;
    var h = vh * s;
    return { x: (boxW - w) / 2, y: (boxH - h) / 2, w: w, h: h };
}

/* The part of the content rect that is visible inside the box (cover crops; contain does not). */
export function visibleRect(rect, boxW, boxH) {
    if (!rect) { return null; }
    var x0 = Math.max(0, rect.x);
    var y0 = Math.max(0, rect.y);
    var x1 = Math.min(boxW, rect.x + rect.w);
    var y1 = Math.min(boxH, rect.y + rect.h);
    if (x1 <= x0 || y1 <= y0) { return null; }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/*
 * The GL geometry for one layout: canvas backing size (device px, capped), and where the whole
 * picture lands in it (the viewport - larger than the canvas under 'cover', clipped by GL).
 * `scale` is the factor between the backing store and CSS px, i.e. devicePixelRatio unless the
 * cap kicked in. Returns null when there is nothing to draw.
 */
export function layout(boxW, boxH, vw, vh, fit, dpr) {
    var rect = contentRect(boxW, boxH, vw, vh, fit);
    var vis = visibleRect(rect, boxW, boxH);
    if (!vis) { return null; }
    var scale = dpr > 0 ? dpr : 1;
    var px = vis.w * scale * vis.h * scale;
    if (px > MAX_OUTPUT_PIXELS) { scale *= Math.sqrt(MAX_OUTPUT_PIXELS / px); }
    var cw = Math.max(1, Math.round(vis.w * scale));
    var ch = Math.max(1, Math.round(vis.h * scale));
    var outW = Math.max(1, Math.round(rect.w * scale));
    var outH = Math.max(1, Math.round(rect.h * scale));
    return {
        css: vis,                                  // canvas position/size in the box, CSS px
        canvasW: cw,
        canvasH: ch,
        viewport: {                                // whole picture, canvas device px, GL origin
            x: Math.round((rect.x - vis.x) * scale),
            y: Math.round((vis.y + vis.h - (rect.y + rect.h)) * scale),
            w: outW,
            h: outH
        },
        outW: outW,
        outH: outH,
        scaleX: outW / vw,
        scaleY: outH / vh
    };
}

/* Steps of the performance governor: what to give up, in this order, when the GPU cannot keep up. */
export var PERF_FULL = 0;      // cleanup + EASU + RCAS
export var PERF_NO_CLEANUP = 1;
export var PERF_NO_RCAS = 2;   // EASU alone
export var PERF_OFF = 3;

/*
 * THE ONE DECISION. Inputs are facts the controller gathered; the answer is whether to draw and,
 * if so, which passes. `reason` is the machine key for why not (or why reduced); the wording is
 * clientLine()'s.
 *
 *   f.mode           'off' | 'auto' | 'always'
 *   f.tv             TV layout
 *   f.webgl2         a WebGL2 context could be made
 *   f.failure        sticky failure key ('context-lost', 'unreadable', ...) or null
 *   f.nativeFullscreen  iOS native fullscreen: the canvas cannot follow
 *   f.pip            Picture-in-Picture: the PiP window shows the raw video, so drawing the
 *                    in-page canvas would be work nobody sees
 *   f.nativeCues     a native (::cue) text track is showing: it renders INSIDE the <video>, so
 *                    covering the video would hide the subtitles
 *   f.vw, f.vh       decoded size (0 until metadata)
 *   f.geo            layout() result, or null
 *   f.perf           governor level (PERF_*)
 *   f.cleanup        'off' | 'low' | 'high'
 */
export function decide(f) {
    var off = function (reason) { return { active: false, reason: reason, cleanup: false, rcas: false }; };
    if (!f || f.mode === 'off') { return off('mode-off'); }
    if (f.tv) { return off('tv'); }
    if (!f.webgl2) { return off('no-webgl2'); }
    if (f.failure) { return off(f.failure); }
    if (f.nativeFullscreen) { return off('native-fullscreen'); }
    if (f.pip) { return off('pip'); }
    if (f.nativeCues) { return off('native-cues'); }
    if (!(f.vw > 0 && f.vh > 0) || !f.geo) { return off('no-video'); }
    var scale = Math.max(f.geo.scaleX, f.geo.scaleY);
    var min = f.mode === 'always' ? ALWAYS_MIN_SCALE : AUTO_MIN_SCALE;
    var enough = f.mode === 'always' ? scale > min : scale >= min;
    if (!enough) { return off('full-size'); }
    var perf = f.perf || PERF_FULL;
    if (perf >= PERF_OFF) { return off('gpu-slow'); }
    return {
        active: true,
        reason: perf > PERF_FULL ? 'gpu-slow' : null,
        cleanup: f.cleanup !== 'off' && perf < PERF_NO_CLEANUP,
        rcas: perf < PERF_NO_RCAS
    };
}

var OFF_WORDS = {
    'full-size': 'stream already full size',
    'gpu-slow': 'GPU too slow',
    'no-webgl2': 'no WebGL2',
    'context-lost': 'graphics context lost',
    'gl-error': 'graphics error',
    'pip': 'picture-in-picture',
    'unreadable': 'video not readable by the page',
    'native-fullscreen': 'native fullscreen',
    'native-cues': 'native subtitles showing',
    'no-video': 'waiting for video'
};

function heightLabel(h) {
    return Math.round(h) + 'p';
}

/*
 * The badge / panel line for this device, or null when there is nothing to say (the viewer
 * turned it off, or the TV layout where none of this runs). Always prefixed "This device:" so
 * it can never be read as something the server did.
 */
export function clientLine(d, vh, outH) {
    if (!d || d.reason === 'mode-off' || d.reason === 'tv') { return null; }
    if (!d.active) {
        return 'This device: off (' + (OFF_WORDS[d.reason] || d.reason) + ')';
    }
    var parts = [];
    if (d.cleanup) { parts.push('cleanup'); }
    parts.push(d.rcas ? 'FSR 1' : 'FSR 1 (EASU only)');
    var line = 'This device: ' + parts.join(' + ') + ' · ' + heightLabel(vh) + ' → ' + heightLabel(outH);
    if (d.reason === 'gpu-slow') { line += ' (reduced: GPU too slow)'; }
    return line;
}

/*
 * PERFORMANCE GOVERNOR, with hysteresis. Fed one window at a time (about two seconds of frames):
 *   frames   video frames presented in the window
 *   missed   of those, frames the render loop never drew (requestVideoFrameCallback reports
 *            presentedFrames; a callback that comes back late skips some)
 *   dropped  increase in getVideoPlaybackQuality().droppedVideoFrames over the window
 *   gpuMs    mean GPU time per output frame when a timer query is available, else null
 *   budgetMs frame interval (1000 / fps) for the gpuMs test
 *
 * A window is BAD when more than 8% of its frames were missed or dropped, or the GPU alone took
 * more than 85% of the frame interval. Two bad windows in a row step one level down (cleanup
 * goes first, then RCAS, then the whole thing). Twenty good windows in a row (about forty
 * seconds) step one level back up - never from OFF, because once off nothing is being measured;
 * a new item or a new playback starts fresh.
 */
export var PERF_WINDOW_FRAMES = 48;
var BAD_RATIO = 0.08;
var GPU_BUDGET = 0.85;
var DOWN_AFTER = 2;
var UP_AFTER = 20;

export function newGovernor() {
    return { level: PERF_FULL, bad: 0, good: 0, floor: PERF_FULL };
}

export function windowIsBad(w) {
    if (!w || !(w.frames > 0)) { return false; }
    var lost = (w.missed || 0) + (w.dropped || 0);
    if (lost / w.frames > BAD_RATIO) { return true; }
    return !!(w.gpuMs != null && w.budgetMs > 0 && w.gpuMs > w.budgetMs * GPU_BUDGET);
}

/*
 * `floor` is the lowest level that is meaningful for the current settings: with cleanup off,
 * PERF_FULL and PERF_NO_CLEANUP draw the same thing, so stepping between them would be a wasted
 * window. The governor starts there and never climbs above it.
 */
export function stepGovernor(g, w, floor) {
    var n = { level: g.level, bad: g.bad, good: g.good, floor: floor || PERF_FULL };
    if (n.level < n.floor) { n.level = n.floor; }
    if (n.level >= PERF_OFF) { return n; }
    if (windowIsBad(w)) {
        n.bad += 1;
        n.good = 0;
        if (n.bad >= DOWN_AFTER) {
            n.level = Math.min(PERF_OFF, n.level + 1);
            n.bad = 0;
        }
    } else {
        n.good += 1;
        n.bad = 0;
        if (n.good >= UP_AFTER && n.level > n.floor) {
            n.level -= 1;
            n.good = 0;
        }
    }
    return n;
}
