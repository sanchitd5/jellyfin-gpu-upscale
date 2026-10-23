import { log } from '../lib/log.js';

/*
 * ROTATE THE VIDEO, FOR WHEN THE PHONE'S AUTO-ROTATE IS OFF. One OSD button (view/portrait-osd.js)
 * cycles portrait -> landscape -> landscape the other way -> portrait, per play session only: the
 * state is a variable in this module, never stored, and reset() runs when the video page goes
 * away, the item changes or the viewer leaves fullscreen.
 *
 * TWO MECHANISMS, tried in this order for every step:
 *   1. screen.orientation.lock(name). Works in fullscreen on Chrome / Android. Rejected or absent
 *      on iOS Safari and on pages that are not fullscreen.
 *   2. A CSS rotation of <body> (the whole page: player container, OSD, subtitles, the client
 *      upscale canvas, the plugin's overlays and any dialog all rotate together, because a
 *      transformed body is the containing block of its position:fixed children). Only meaningful
 *      while the physical viewport is portrait: landscape = rotate(+90deg), the other landscape =
 *      rotate(-90deg), portrait = none. The body is sized to the swapped viewport in px
 *      (--jp-rot-*), recomputed on resize. html[data-jp-rot] carries 90 or -90 so the gesture
 *      controller can map pointer coordinates (model/player-gesture.js toContent).
 *
 * Fail soft: if neither mechanism can do a step (native refused and the viewport is already
 * landscape, so a CSS rotation would be wrong), the button is hidden for the session
 * (available() false) and everything is reset.
 */

var STYLE_ID = 'jellyfinPlusRotateStyle';
var MODES = ['portrait', 'landscape', 'landscape-secondary'];
var CSS_ROT = [0, 90, -90];

var P = 'html[data-jp-rot]:not(.jp-theme-off):not(.layout-tv)';
var CSS = [
    P + ' body { position: fixed; top: 0; left: 0; width: var(--jp-rot-w); height: var(--jp-rot-h);'
        + ' overflow: hidden; transform-origin: 0 0; margin: 0; }',
    P + '[data-jp-rot="90"] body { transform: translateX(var(--jp-rot-vw)) rotate(90deg); }',
    P + '[data-jp-rot="-90"] body { transform: translateY(var(--jp-rot-vh)) rotate(-90deg); }'
].join('\n');

var mode = 0;
var native = false;
var broken = false;
var forItem = null;
var busy = false;

function root() { return document.documentElement; }

function ensureStyle() {
    if (document.getElementById(STYLE_ID)) { return; }
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
}

function portraitViewport() { return window.innerHeight > window.innerWidth; }

/* The CSS rotation now in force: 0, 90 or -90. */
export function cssRotation() {
    var v = parseInt(root().getAttribute('data-jp-rot') || '0', 10);
    return v === 90 || v === -90 ? v : 0;
}

function setCss(rot) {
    var r = root();
    if (!rot) {
        r.removeAttribute('data-jp-rot');
        ['--jp-rot-w', '--jp-rot-h', '--jp-rot-vw', '--jp-rot-vh'].forEach(function (n) { r.style.removeProperty(n); });
        return;
    }

    ensureStyle();
    r.style.setProperty('--jp-rot-w', window.innerHeight + 'px');
    r.style.setProperty('--jp-rot-h', window.innerWidth + 'px');
    r.style.setProperty('--jp-rot-vw', window.innerWidth + 'px');
    r.style.setProperty('--jp-rot-vh', window.innerHeight + 'px');
    r.setAttribute('data-jp-rot', String(rot));
}

function tryNative(name) {
    try {
        var o = window.screen && window.screen.orientation;
        if (!o || typeof o.lock !== 'function') { return Promise.resolve(false); }
        return o.lock(name).then(function () { return true; }, function () { return false; });
    } catch (err) {
        return Promise.resolve(false);
    }
}

function unlockNative() {
    try {
        if (native && window.screen.orientation && typeof window.screen.orientation.unlock === 'function') {
            window.screen.orientation.unlock();
        }
    } catch (err) { /* nothing to release */ }
    native = false;
}

/* Back to stock: no rotation, no lock. */
export function resetRotation() {
    mode = 0;
    forItem = null;
    unlockNative();
    if (cssRotation()) { setCss(0); }
}

/* False once neither mechanism worked this session: the button hides. */
export function rotationAvailable() { return !broken; }

export function rotationMode() { return MODES[mode]; }

/* Keeps the CSS rotation sized to the viewport; drops it if the viewport turned landscape by itself. */
export function refreshRotation() {
    var rot = cssRotation();
    if (!rot) { return; }
    if (!portraitViewport()) {
        resetRotation();
    } else {
        setCss(rot);
    }
}

/* Ties the rotation to one item: another item (or none) resets it. */
export function rotationFollowsItem(id) {
    if (mode !== 0 && forItem !== id) { resetRotation(); }
}

/* The OSD button: the next step. itemId is the item playing now. */
export function cycleRotation(itemId) {
    if (busy || broken) { return Promise.resolve(); }
    busy = true;
    var next = (mode + 1) % MODES.length;
    return tryNative(MODES[next]).then(function (ok) {
        if (ok) {
            native = true;
            setCss(0);
        } else if (portraitViewport() || cssRotation()) {
            // CSS mechanism. A previous native lock (if any) is released first.
            unlockNative();
            setCss(CSS_ROT[next]);
        } else {
            // Native refused and the viewport is already landscape: nothing honest to do.
            log('player rotate: no mechanism available, hiding the button');
            broken = true;
            resetRotation();
            return;
        }

        mode = next;
        forItem = itemId;
        if (mode === 0) { forItem = null; if (!ok) { setCss(0); } }
    }).catch(function (err) {
        log('player rotate: failed', err);
        broken = true;
        resetRotation();
    }).then(function () { busy = false; });
}

export function installRotateListeners() {
    document.addEventListener('fullscreenchange', function () {
        // Leaving fullscreen releases the browser's own orientation lock.
        if (native && !document.fullscreenElement) { resetRotation(); }
    });
}
