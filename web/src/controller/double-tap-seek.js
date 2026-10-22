import { state } from '../model/state.js';
import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';
import { player, activePlayer } from './live-apply.js';

/*
 * DOUBLE-TAP TO SEEK ON THE VIDEO PAGE (TOUCH).
 *
 * jellyfin-web 12.1's video page (apps/legacy/controllers/playback/video/index.js) listens for
 * pointerdown on its view: a touch toggles the on-screen display (debounced to one per 300 ms),
 * a mouse press plays/pauses, and a dblclick toggles fullscreen. Nothing seeks by gesture; its
 * touchHelper is destroyed but never created.
 *
 * A double tap on the left third of the page now seeks back SEEK_SECONDS, on the right third
 * forward; further taps on the same side within the window keep adding, YouTube-style, with a
 * brief hint ("+10 s") over that third. The middle third, the controls and any other pointer
 * type are left entirely to jellyfin.
 *
 * A SINGLE TAP IS UNTOUCHED. This listener runs in the capture phase but only ever observes the
 * first tap of a pair: it records it and lets it through, so the stock handler toggles the OSD
 * exactly as before. Only the second tap (and later ones in a chain) is stopped, which also keeps
 * the stock handler from toggling the OSD a second time on a chain. The stock handler already
 * ignores a pointerdown within 300 ms of a toggling one, so the window here is shorter than that.
 * The dblclick browsers may synthesise from the same two taps would toggle fullscreen (the stock
 * dblclick handler fires when the target is the view itself), so it is swallowed for a moment
 * after a seek.
 *
 * The seek goes through the player's own seek(), the same path the OSD slider and skip buttons
 * take, on the manager found by shape in live-apply.js - window.playbackManager does not exist.
 */

// Two taps closer than this (and within TAP_SLOP_PX of each other) are a double tap. Stays under
// the stock 300 ms OSD debounce on purpose, see above.
var DOUBLE_TAP_MS = 280;
var TAP_SLOP_PX = 60;
var SEEK_SECONDS = 10;
var HINT_MS = 650;
var TICKS_PER_SECOND = 10000000;

var PAGE = '#videoOsdPage';
// Same exclusion the stock handler makes for the bottom OSD and up-next, plus real controls.
var IGNORE = 'button, a, input, select, textarea, .videoOsdBottom, .upNextContainer, .skinHeader, .osdHeader';
var STYLE_ID = 'gpuUpscaleDoubleTapStyle';
var HINT_ID = 'gpuUpscaleSeekHint';

var CSS = [
    // Stops the browser treating the second tap as a page zoom.
    PAGE + ' { touch-action: manipulation; }',
    '#' + HINT_ID + ' { position: fixed; top: 0; bottom: 0; width: 33.34vw; display: flex;'
        + ' align-items: center; justify-content: center; pointer-events: none; z-index: 99998;'
        + ' opacity: 0; transition: opacity 0.15s; }',
    '#' + HINT_ID + '.show { opacity: 1; }',
    '#' + HINT_ID + ' .pill { display: flex; flex-direction: column; align-items: center;'
        + ' padding: 0.6em 1em; border-radius: 1.5em; color: #fff; background: rgba(0,0,0,0.55);'
        + ' font-size: 1.1em; }',
    '#' + HINT_ID + ' .material-icons { font-family: "Material Icons"; font-feature-settings: "liga";'
        + ' font-size: 2em; line-height: 1; }'
].join('\n');

var last = null;          // the previous tap: { third, t, x, y }
var swallowDblUntil = 0;  // performance.now() until which a dblclick is swallowed
// ticks the last seek aimed at. A chain of taps builds on this rather than on the player's
// position, which is still catching up from the previous seek.
var lastTarget = null;
var hintTimer = null;
var hintTotal = 0;

function manager() {
    return state.playbackManagerRef || player();
}

function showHint(dir) {
    var hint = document.getElementById(HINT_ID);
    if (!hint) {
        hint = el('div');
        hint.id = HINT_ID;
        hint.setAttribute('aria-hidden', 'true');
        var pill = el('div', 'pill');
        pill.appendChild(el('span', 'material-icons', ''));
        pill.appendChild(el('span', 'label', ''));
        hint.appendChild(pill);
        document.body.appendChild(hint);
    }

    hintTotal += dir * SEEK_SECONDS;
    hint.style.left = dir < 0 ? '0' : 'auto';
    hint.style.right = dir > 0 ? '0' : 'auto';
    hint.querySelector('.material-icons').textContent = dir < 0 ? 'fast_rewind' : 'fast_forward';
    hint.querySelector('.label').textContent = (hintTotal > 0 ? '+' : '') + hintTotal + ' s';
    hint.classList.add('show');

    if (hintTimer) {
        clearTimeout(hintTimer);
    }

    hintTimer = setTimeout(function () {
        hint.classList.remove('show');
        hintTotal = 0;
        hintTimer = null;
    }, HINT_MS);
}

function seekBy(dir, continuing) {
    try {
        var pm = manager();
        var pl = pm && activePlayer(pm);
        if (!pm || !pl || typeof pm.seek !== 'function' || typeof pm.currentTime !== 'function') {
            log('double-tap seek: no player to seek');
            return false;
        }

        var base = (continuing && lastTarget != null)
            ? lastTarget
            : pm.currentTime(pl) * 10000;
        var target = Math.max(0, base + dir * SEEK_SECONDS * TICKS_PER_SECOND);
        var duration = typeof pm.duration === 'function' ? pm.duration(pl) : 0;
        if (duration > 0) {
            // Just short of the end: seeking past it would end the item as if it had finished.
            target = Math.min(target, Math.max(0, duration - TICKS_PER_SECOND / 2));
        }

        lastTarget = target;
        var result = pm.seek(target, pl);
        if (result && typeof result.catch === 'function') {
            result.catch(function (err) { log('double-tap seek: seek rejected', err); });
        }

        showHint(dir);
        log('double-tap seek: ' + (dir < 0 ? 'back' : 'forward') + ' to ticks ' + target);
        return true;
    } catch (err) {
        log('double-tap seek failed', err);
        return false;
    }
}

function onPointerDown(e) {
    try {
        if (e.pointerType !== 'touch' || e.isPrimary === false) {
            return;
        }

        var target = e.target;
        var page = target && target.closest && target.closest(PAGE);
        if (!page || target.closest(IGNORE)) {
            last = null;
            return;
        }

        var width = page.clientWidth || window.innerWidth;
        var third = e.clientX < width / 3 ? -1 : (e.clientX > width * 2 / 3 ? 1 : 0);
        if (!third) {
            last = null;
            return;
        }

        var now = performance.now();
        if (last && last.third === third && now - last.t <= DOUBLE_TAP_MS
            && Math.abs(e.clientX - last.x) <= TAP_SLOP_PX && Math.abs(e.clientY - last.y) <= TAP_SLOP_PX) {
            // Second (or later) tap of a chain: ours. The first one already went through to the
            // stock handler untouched.
            e.stopPropagation();
            swallowDblUntil = now + 700;
            // Only a tap that continues a chain builds on the previous seek's target; the first
            // seek of a chain starts from where the player actually is.
            var seeked = seekBy(third, last.seeked);
            last = { third: third, t: now, x: e.clientX, y: e.clientY, seeked: seeked };
            return;
        }

        last = { third: third, t: now, x: e.clientX, y: e.clientY, seeked: false };
    } catch (err) {
        log('double-tap seek: pointerdown handler failed', err);
    }
}

function onDblClick(e) {
    if (performance.now() < swallowDblUntil) {
        e.stopPropagation();
        e.preventDefault();
    }
}

export function installDoubleTapSeek() {
    try {
        if (!document.getElementById(STYLE_ID)) {
            var style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = CSS;
            (document.head || document.documentElement).appendChild(style);
        }

        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('dblclick', onDblClick, true);
        log('double-tap seek installed');
    } catch (err) {
        log('double-tap seek install failed', err);
    }
}
