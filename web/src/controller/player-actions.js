import { state } from '../model/state.js';
import { log } from '../lib/log.js';
import { player, activePlayer } from './live-apply.js';
import {
    HOLD_RATE, swipeLevel, brightnessToLevel, levelToBrightness, parseBrightness
} from '../model/player-gesture.js';
import {
    ensureHudStyle, showSeekHint, showHoldPill, hideHoldPill, showLevelBar, hideLevelBar, applyBrightness
} from '../view/player-hud.js';

/*
 * WHAT THE VIDEO PAGE GESTURES DO (the arbiter in model/player-gesture.js decides WHICH one).
 *
 * Everything reaches the player the way live-apply.js and the old double-tap seek do: the
 * playbackManager is found by shape (window.playbackManager does not exist in jellyfin-web 12.1),
 * every method is checked before it is called, and a player that lacks one refuses the gesture,
 * which the controller then hands back to stock. Nothing here throws into the page.
 */

var SEEK_SECONDS = 10;
var TICKS_PER_SECOND = 10000000;
// A chain of double taps builds on the previous seek's target. Taps in a chain are under 300 ms
// apart, so anything older than this is a fresh chain.
var CHAIN_MS = 1500;
var BRIGHTNESS_KEY = 'jellyfinPlusBrightness';

function manager() {
    return state.playbackManagerRef || player();
}

/* ------------------------------------------------------------------ double-tap seek */

// ticks the last seek aimed at: the player's own position is still catching up from it.
var lastTarget = null;
var lastSeekAt = 0;

export function seekBy(dir, continuing) {
    try {
        var pm = manager();
        var pl = pm && activePlayer(pm);
        if (!pm || !pl || typeof pm.seek !== 'function' || typeof pm.currentTime !== 'function') {
            log('player gestures: no player to seek');
            return false;
        }

        var now = performance.now();
        var base = (continuing && lastTarget != null && now - lastSeekAt < CHAIN_MS)
            ? lastTarget
            : pm.currentTime(pl) * 10000;
        var target = Math.max(0, base + dir * SEEK_SECONDS * TICKS_PER_SECOND);
        var duration = typeof pm.duration === 'function' ? pm.duration(pl) : 0;
        if (duration > 0) {
            // Just short of the end: seeking past it would end the item as if it had finished.
            target = Math.min(target, Math.max(0, duration - TICKS_PER_SECOND / 2));
        }

        lastTarget = target;
        lastSeekAt = now;
        var result = pm.seek(target, pl);
        if (result && typeof result.catch === 'function') {
            result.catch(function (err) { log('player gestures: seek rejected', err); });
        }

        showSeekHint(dir, SEEK_SECONDS);
        log('player gestures: seek ' + (dir < 0 ? 'back' : 'forward') + ' to ticks ' + target);
        return true;
    } catch (err) {
        log('player gestures: seek failed', err);
        return false;
    }
}

/* ------------------------------------------------------------------ hold for 2x */

var hold = null; // { pl, prev }

export function holdActive() {
    return !!hold;
}

/*
 * The rate is written on the PLAYER, not through playbackManager.setPlaybackRate, which also
 * stores it in sessionStorage 'playbackRateSpeed'. That keeps the 2x out of the saved speed
 * (controller/player-speed.js mirrors that key and nothing else) and out of the stock re-apply.
 * Returns false (so the press goes back to stock) for a paused video or a player without the
 * rate API.
 */
export function holdStart() {
    try {
        var pm = manager();
        var pl = pm && activePlayer(pm);
        if (!pm || !pl || typeof pl.setPlaybackRate !== 'function'
            || typeof pm.getPlaybackRate !== 'function' || typeof pm.paused !== 'function') {
            log('player gestures: hold refused, no rate API');
            return false;
        }

        if (pm.paused(pl)) {
            return false;
        }

        var prev = Number(pm.getPlaybackRate(pl));
        if (!(prev > 0)) {
            return false;
        }

        pl.setPlaybackRate(HOLD_RATE);
        hold = { pl: pl, prev: prev };
        showHoldPill(HOLD_RATE);
        log('player gestures: hold 2x started, previous rate ' + prev);
        return true;
    } catch (err) {
        log('player gestures: hold failed', err);
        hold = null;
        return false;
    }
}

export function holdEnd() {
    var h = hold;
    hold = null;
    hideHoldPill();
    if (!h) { return; }
    try {
        // Only undo our own change: a rate the viewer set meanwhile is theirs.
        if (Number(h.pl.getPlaybackRate()) === HOLD_RATE) {
            h.pl.setPlaybackRate(h.prev);
        }

        log('player gestures: hold ended, rate back to ' + h.prev);
    } catch (err) {
        log('player gestures: could not restore the rate', err);
    }
}

/* ------------------------------------------------------------------ swipe: volume / brightness */

var swipe = null;           // { kind, base, pm, pl }
var volumeBroken = false;   // setting the volume does not stick on this device

// iOS keeps the media volume under the hardware buttons: assigning it is silently ignored.
var volumeSettable = null;
function canSetVolume() {
    if (volumeSettable === null) {
        try {
            var probe = document.createElement('audio');
            probe.volume = 0.5;
            volumeSettable = probe.volume === 0.5;
        } catch (err) {
            volumeSettable = false;
        }

        if (!volumeSettable) { log('player gestures: volume is not settable on this device, swipe volume off'); }
    }

    return volumeSettable;
}

var brightness = 1;

function loadBrightness() {
    try {
        brightness = parseBrightness(window.localStorage.getItem(BRIGHTNESS_KEY));
    } catch (err) {
        brightness = 1;
    }
}

function saveBrightness() {
    try {
        if (brightness === 1) {
            window.localStorage.removeItem(BRIGHTNESS_KEY);
        } else {
            window.localStorage.setItem(BRIGHTNESS_KEY, String(brightness));
        }
    } catch (err) { /* a device that refuses storage just forgets */ }
}

/* Restores the saved brightness at startup. Does nothing at 1, so stock is untouched. */
export function installBrightness() {
    ensureHudStyle();
    loadBrightness();
    if (brightness !== 1) { applyBrightness(brightness); }
}

/* Returns false to hand the touch back to stock (no player, no volume API, volume not settable). */
export function swipeStart(kind) {
    try {
        if (kind === 'brightness') {
            swipe = { kind: kind, base: brightnessToLevel(brightness) };
            return true;
        }

        if (volumeBroken || !canSetVolume()) { return false; }
        var pm = manager();
        var pl = pm && activePlayer(pm);
        if (!pm || !pl || typeof pm.getVolume !== 'function' || typeof pm.setVolume !== 'function') {
            log('player gestures: swipe volume refused, no volume API');
            return false;
        }

        var current = Number(pm.getVolume(pl));
        if (!isFinite(current)) { return false; }
        swipe = { kind: kind, base: Math.max(0, Math.min(1, current / 100)), pm: pm, pl: pl };
        return true;
    } catch (err) {
        log('player gestures: swipe start failed', err);
        swipe = null;
        return false;
    }
}

export function swipeMove(dy, height) {
    var s = swipe;
    if (!s) { return; }
    try {
        var level = swipeLevel(s.base, dy, height);
        if (s.kind === 'brightness') {
            brightness = levelToBrightness(level);
            applyBrightness(brightness);
            showLevelBar('brightness', brightnessToLevel(brightness), Math.round(brightness * 100) + '%', 'brightness_6');
            return;
        }

        var v = Math.round(level * 100);
        s.pm.setVolume(v, s.pl);
        if (v > 0 && typeof s.pm.isMuted === 'function' && typeof s.pm.setMute === 'function' && s.pm.isMuted(s.pl)) {
            s.pm.setMute(false, s.pl);
        }

        // A device that ignores the assignment (the iOS test above missed it) would show a bar
        // that lies. Check once the change is big enough to rule out rounding.
        if (Math.abs(v - s.base * 100) >= 15 && Math.abs(Number(s.pm.getVolume(s.pl)) - v) > 3) {
            volumeBroken = true;
            swipe = null;
            log('player gestures: volume did not stick, swipe volume off for this page');
            return;
        }

        showLevelBar('volume', level, v + '%', v === 0 ? 'volume_off' : (v < 50 ? 'volume_down' : 'volume_up'));
    } catch (err) {
        log('player gestures: swipe move failed', err);
    }
}

export function swipeEnd() {
    var s = swipe;
    swipe = null;
    if (!s) { return; }
    if (s.kind === 'brightness') { saveBrightness(); }
    hideLevelBar();
}
