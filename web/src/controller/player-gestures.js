import { log } from '../lib/log.js';
import { createArbiter, THRESHOLDS, toContent } from '../model/player-gesture.js';
import { cssRotation } from './player-rotate.js';
import { ensureHudStyle } from '../view/player-hud.js';
import {
    seekBy, holdStart, holdEnd, swipeStart, swipeMove, swipeEnd, installBrightness
} from './player-actions.js';

/*
 * THE GESTURES OF THE VIDEO PAGE: double-tap seek, hold for 2x, vertical swipe for volume and
 * brightness. One arbiter (model/player-gesture.js, with its thresholds and tests) decides which
 * of them a press is; this module is only the DOM seam around it.
 *
 * WHAT STOCK DOES (jellyfin-web 12.1, apps/legacy/controllers/playback/video/index.js). The view
 * listens for pointerdown (bubble phase, passive): a TOUCH toggles the OSD at once (debounced to
 * one per 300 ms), a MOUSE press arms a 300 ms timer that plays/pauses (a second press inside it
 * cancels the timer, and the dblclick then toggles fullscreen). Both act on the press itself, so a
 * hold or a swipe, which are only known later, could not avoid them by watching.
 *
 * HOW IT FITS. For a press on the video surface this listener runs first (document, capture
 * phase), STOPS the stock pointerdown and watches the press. Whatever it turns out to be:
 *
 *   tap or a pass   the original pointerdown is REPLAYED to its target (a synthetic, untrusted
 *                   PointerEvent with the same type, button and position), so stock handles it
 *                   exactly as before, a moment later: at release for a tap, at the verdict for
 *                   a horizontal move or a refused hold/swipe. Timing differs from stock by the
 *                   length of the press, nothing else does.
 *   double tap      the second tap is ours (seek); the first went through as a tap.
 *   hold, swipe     ours; stock never sees the press, so it neither toggles the OSD nor pauses.
 *
 * Only presses that start on the page and not on a control are tracked (the same exclusions the
 * stock handler makes, plus real controls), only the primary pointer, only touch and the primary
 * mouse button, and never on a TV layout. Anything else is not touched at all. The replay is
 * ignored by this listener (untrusted and flagged), so it cannot loop.
 *
 * If PointerEvent does not exist the stock page falls back to click and none of this attaches.
 * Every handler is in a try/catch that replays the press on failure: a bug here must not cost a
 * tap.
 */

var PAGE = '#videoOsdPage';
// Same exclusion the stock handler makes for the bottom OSD and up-next, plus real controls.
var IGNORE = 'button, a, input, select, textarea, .videoOsdBottom, .upNextContainer, .skinHeader, .osdHeader';

var arb = createArbiter();
var current = null;       // the tracked press: { id, target, page, init, holdTimer, height }
var replaying = false;
var swallowDblUntil = 0;  // performance.now() until which a dblclick is swallowed

function isTv() {
    return document.documentElement.classList.contains('layout-tv');
}

function contentPoint(e) {
    return toContent(cssRotation(), e.clientX, e.clientY, window.innerWidth, window.innerHeight);
}

function snapshot(e) {
    return {
        bubbles: true, cancelable: true, composed: true, view: window,
        pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary,
        button: e.button, buttons: e.buttons,
        clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
        width: e.width, height: e.height, pressure: e.pressure
    };
}

/* Hands the swallowed pointerdown back to stock. */
function replay(cur) {
    try {
        var target = cur.target && cur.target.isConnected ? cur.target : cur.page;
        replaying = true;
        target.dispatchEvent(new window.PointerEvent('pointerdown', cur.init));
    } catch (err) {
        log('player gestures: replay failed', err);
    } finally {
        replaying = false;
    }
}

function clearHold(cur) {
    if (cur && cur.holdTimer) {
        clearTimeout(cur.holdTimer);
        cur.holdTimer = 0;
    }
}

/* Carries out what the arbiter decided. */
function perform(a) {
    if (!a || !current) { return; }
    switch (a.type) {
        case 'replay':
            clearHold(current);
            replay(current);
            break;
        case 'swipe-start':
            clearHold(current);
            if (swipeStart(a.kind)) {
                swipeMove(0, current.height);
            } else {
                perform(arb.refuse());
            }
            break;
        case 'swipe':
            swipeMove(a.dy, current.height);
            break;
        case 'hold-start':
            if (!holdStart()) {
                perform(arb.refuse());
            }
            break;
        case 'hold-end':
            holdEnd();
            break;
        case 'swipe-end':
            swipeEnd();
            break;
    }
}

function finish(a) {
    try {
        clearHold(current);
        perform(a);
    } catch (err) {
        log('player gestures: finish failed', err);
    }

    current = null;
}

function onPointerDown(e) {
    try {
        if (replaying || !e.isTrusted || e.isPrimary === false) {
            return;
        }

        var touch = e.pointerType === 'touch';
        var mouse = e.pointerType === 'mouse' && e.button === 0;
        if ((!touch && !mouse) || isTv()) {
            return;
        }

        if (current) {
            // A release never arrived (the window lost focus, a cancelled capture). End it first.
            finish(arb.cancel());
        }

        var target = e.target;
        var page = target && target.closest && target.closest(PAGE);
        if (!page || target.closest(IGNORE)) {
            arb.forgetTaps();
            return;
        }

        // The player lock (view/portrait-osd.js) turns every gesture off for pocketing the phone.
        if (document.documentElement.classList.contains('jp-player-locked')) {
            arb.forgetTaps();
            return;
        }

        var now = performance.now();
        // Rotate video (player-rotate.js): the page is turned, so map the screen point to the
        // picture's own axes. The page's client size is already in those axes.
        var c = contentPoint(e);
        var r = arb.down({
            t: now, x: c.x, y: c.y, sx: e.clientX, swidth: window.innerWidth,
            width: page.clientWidth || window.innerWidth, touch: touch
        });
        if (r.edge) {
            // The OS back-swipe starts here. Not swallowed: stock sees the press as it always did.
            current = null;
            return;
        }

        current = {
            id: e.pointerId, target: target, page: page, init: snapshot(e), holdTimer: 0,
            height: page.clientHeight || window.innerHeight
        };

        // From here the press is ours until the arbiter says otherwise.
        e.stopPropagation();

        if (r.doubleTap) {
            swallowDblUntil = now + 700;
            seekBy(r.doubleTap, r.continuing);
        } else {
            current.holdTimer = setTimeout(onHoldTimer, THRESHOLDS.HOLD_MS);
        }
    } catch (err) {
        log('player gestures: pointerdown handler failed', err);
        // Never cost a tap: if the press was swallowed, give it back.
        if (current) {
            var cur = current;
            current = null;
            replay(cur);
        }
    }
}

function onHoldTimer() {
    try {
        if (!current) { return; }
        current.holdTimer = 0;
        perform(arb.holdTimeout());
    } catch (err) {
        log('player gestures: hold timer failed', err);
    }
}

function mine(e) {
    return !!current && e.pointerId === current.id;
}

function onPointerMove(e) {
    try {
        if (!mine(e)) { return; }
        var c = contentPoint(e);
        perform(arb.move({ t: performance.now(), x: c.x, y: c.y }));
        // While a hold plays at 2x a moving mouse must not pop the OSD (stock shows it on a
        // 10 px move), and a swipe is ours alone.
        var ph = arb.phase();
        if (ph === 'hold' || ph === 'swipe') {
            e.stopPropagation();
        }
    } catch (err) {
        log('player gestures: pointermove handler failed', err);
    }
}

function onPointerUp(e) {
    if (!mine(e)) { return; }
    finish(arb.up());
}

function onPointerCancel(e) {
    if (!mine(e)) { return; }
    finish(arb.cancel());
}

/* The window lost the pointer without telling us: end whatever was running. */
function onAbort() {
    if (current) { finish(arb.cancel()); }
}

function onContextMenu(e) {
    // A long press fires the context menu on touch browsers, over the hold or the swipe.
    var ph = arb.phase();
    if (current && (ph === 'hold' || ph === 'swipe')) {
        e.preventDefault();
    }
}

function onDblClick(e) {
    if (performance.now() < swallowDblUntil) {
        e.stopPropagation();
        e.preventDefault();
    }
}

export function installPlayerGestures() {
    try {
        if (typeof window.PointerEvent !== 'function') {
            log('player gestures: no PointerEvent, not installed');
            return;
        }

        ensureHudStyle();
        installBrightness();

        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('pointermove', onPointerMove, true);
        document.addEventListener('pointerup', onPointerUp, true);
        document.addEventListener('pointercancel', onPointerCancel, true);
        document.addEventListener('contextmenu', onContextMenu, true);
        document.addEventListener('dblclick', onDblClick, true);
        window.addEventListener('blur', onAbort);
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) { onAbort(); }
        });
        log('player gestures installed');
    } catch (err) {
        log('player gestures install failed', err);
    }
}
