import { state } from '../model/state.js';
import { isOff } from '../lib/utils.js';
import { log } from '../lib/log.js';
import { renderPanel, panelEl } from '../view/panel-dom.js';
import { LIVE_ROWS } from './live-block.js';

export function repaintPanel() {
    try {
        var p = panelEl();
        if (p) { renderPanel(p, state.caps || { full: false, failed: true }); }
    } catch (err) { /* the panel is never worth breaking playback for */ }
}

/*
 * THE PLAYER, WHICH IS NOT ON WINDOW.
 *
 * jellyfin-web 12.1 exports playbackManager from a webpack module (n.d(t,{f:...})) and never
 * assigns window.playbackManager - grep the bundle: the only file naming it is this script.
 * Reading it off window therefore always gave undefined, playerPresent() was always false, and
 * every live apply logged "nothing is playing" and did nothing. So it is recognised by SHAPE
 * in the module exports this script already wraps for the action sheet, exactly as the action
 * sheet is recognised by shape rather than by module id, and window is kept as a fallback for
 * any build that does export it.
 */
export function isPlaybackManager(o) {
    return !!o
        && typeof o.setMaxStreamingBitrate === "function"
        && typeof o.getMaxStreamingBitrate === "function"
        && typeof o.currentItem === "function";
}

export function notePlaybackManager(exports) {
    if (state.playbackManagerRef || !exports) {
        return;
    }

    try {
        if (isPlaybackManager(exports)) {
            state.playbackManagerRef = exports;
            log("found playbackManager on a module export");
            return;
        }

        Object.keys(exports).forEach(function (k) {
            if (state.playbackManagerRef) {
                return;
            }

            try {
                if (isPlaybackManager(exports[k])) {
                    state.playbackManagerRef = exports[k];
                    log("found playbackManager on module export ." + k);
                }
            } catch (err) { /* a getter that throws is not the player */ }
        });
    } catch (err) { /* never worth breaking a module for */ }
}

/*
 * A THIRD capture path, tried lazily every time player() is asked for the manager and nothing has
 * been captured yet.
 *
 * The webpack-chunk capture in webpack-hook.js only sees a module's factory run AFTER this script
 * has installed its hook. That is fine for a chunk lazy-loaded later, but playbackManager is a
 * core singleton most builds load as part of the initial bundle - already executed, and its result
 * already cached in webpack's own module cache, by the time an injected `<script defer>` runs.
 * Replacing `modules[id]` at that point changes nothing: webpack never calls the factory again.
 * That is a real, silent gap this project's own prior "capture by shape" fix did not close, and
 * the exact shape of THIS bug: playback starts fine (fetch/xhr hooks fire on PlaybackInfo, proven
 * by "source height"/"new item" in the log), but requestRestream() logs "nothing is playing" and
 * does nothing, because playbackManagerRef was never set and window.playbackManager does not
 * exist on this build either.
 *
 * jellyfin-web (and Emby before it) has separately kept an AMD-style module shim for exactly this
 * class of problem - it is the officially documented way a third-party script/plugin reaches a
 * core singleton after the fact: `window.require(['playbackManager'], function (pm) {...})`. If
 * the module is already loaded, the callback fires immediately (synchronously or on a microtask);
 * if not yet loaded, it queues and fires once it is - either way, unlike the webpack-chunk
 * capture, this does not depend on WHEN our script attached relative to WHEN the module first ran.
 * Tried at most once (a failed/absent `window.require` is not worth retrying every call), pure
 * fallback: this changes nothing when the webpack-chunk capture already worked.
 */
var requireShimTried = false;
export function tryRequireShim() {
    if (requireShimTried || state.playbackManagerRef) {
        return;
    }

    requireShimTried = true;
    try {
        if (typeof window.require !== 'function') {
            return;
        }

        window.require(['playbackManager'], function (pm) {
            try {
                if (!state.playbackManagerRef && isPlaybackManager(pm)) {
                    state.playbackManagerRef = pm;
                    log('found playbackManager via the require() module shim');
                }
            } catch (err) { /* never worth breaking the shim callback for */ }
        });
    } catch (err) {
        log('require() shim probe failed', err);
    }
}

export function player() {
    if (isPlaybackManager(window.playbackManager)) {
        return window.playbackManager;
    }

    if (!state.playbackManagerRef) {
        tryRequireShim();
    }

    return state.playbackManagerRef;
}

export function playerPresent() {
    try {
        var pm = player();
        return !!(pm
            && typeof pm.setMaxStreamingBitrate === 'function'
            && typeof pm.getMaxStreamingBitrate === 'function'
            && typeof pm.currentItem === 'function'
            && pm.currentItem());
    } catch (err) {
        return false;
    }
}

/*
 * The change is finished when a NEW PlaySessionId comes back - which this script learns from
 * the PlaybackInfo response it is already reading, so nothing extra is polled off the server.
 * The timeout exists so the label cannot stick on forever if the negotiation never lands.
 */
export function watchApplied(previousId) {
    var tries = 0;
    var timer = setInterval(function () {
        try {
            tries++;
            var landed = !!(state.playSessionId && state.playSessionId !== previousId);
            if (landed || tries > 48) {
                clearInterval(timer);
                state.applying = null;
                // A timeout is a FAILURE, not a finish. Clearing the label without recording
                // it left a change that never reached the server looking like one that did.
                state.applyFailed = !landed;
                // One retry, by the route that works when re-negotiation does not: the stream
                // that would not change is usually one the server is handing over untouched.
                // Only once, because a re-play that also fails to land must not become a loop
                // that restarts the viewer's film every twelve seconds.
                if (!landed && !state.replayTried) {
                    state.replayTried = true;
                    if (replayHere()) {
                        state.applyFailed = false;
                        state.applying = APPLY_LABEL;
                        watchApplied(state.playSessionId);
                    }
                }

                repaintPanel();
            }
        } catch (err) {
            clearInterval(timer);
            state.applying = null;
            state.applyFailed = true;
        }
    }, 250);
}

/*
 * Re-play the current item at the position it is at.
 *
 * Needed because the ordinary apply re-negotiates the STREAM, and a session that is direct
 * playing has no stream to re-negotiate: the server hands back the file, nothing asks for a
 * filter chain, and the panel sat saying "applying" until it timed out. Re-playing makes the
 * client ask PlaybackInfo again, which is where this script marks the request for a transcode.
 *
 * Every method is checked before it is called. CLAUDE.md is explicit that reaching for a global
 * that "should" exist is how this project lost a whole session, so a player that does not carry
 * these degrades to the honest message rather than throwing.
 */
export function replayHere() {
    try {
        var pm = player();
        var item = pm && typeof pm.currentItem === 'function' ? pm.currentItem() : null;
        var id = item && (item.Id || item.id);
        if (!id || typeof pm.play !== 'function') {
            return false;
        }

        var ticks = 0;
        if (typeof pm.currentTime === 'function') {
            var ms = pm.currentTime();
            if (ms > 0) { ticks = Math.floor(ms) * 10000; }
        }

        pm.play({ ids: [id], startPositionTicks: ticks });
        log('re-played the item at its current position to apply the change');
        return true;
    } catch (err) {
        log('could not re-play to apply the change', err);
        return false;
    }
}

/*
 * True when the server built no filter chain for this session, which is what direct play looks
 * like from here: a record it does not know. Read from the record rather than guessed, so a
 * session the server simply has not answered for yet is not mistaken for one it refused.
 */
export function directPlaying() {
    var s = state.lastServerState;
    return !!(s && s.PatchActive !== false && s.Known === false);
}

/*
 * APPLYING A CHANGE LIVE - and it is jellyfin-web's own quality-change path, not a new one.
 *
 * playbackManager.setMaxStreamingBitrate() ends in the module-private changeStream(), which is
 * the same function the stock quality menu reaches when a viewer picks a bitrate. That
 * function already does every hard part of this:
 *
 *   - it re-requests PlaybackInfo, so this script's request and response hooks mark the new
 *     negotiation exactly as they mark a fresh playback. That is what makes BOTH direct-play
 *     crossovers work without a special case here: picking a stage while direct playing goes
 *     through the request rewrite that sets EnableDirectPlay/EnableDirectStream false, and
 *     picking Off stops forcing it, so the server is free to hand back a direct-play source.
 *   - it restarts the player at the current position (current ticks plus the transcoding
 *     offset), which discards the stale buffer along with the old stream.
 *   - it calls stopActiveEncodings(oldPlaySessionId) both before and after the switch. That is
 *     what stops the abandoned ffmpeg holding one of the server's MaxConcurrent slots until it
 *     times out - one viewer walking down a slider must not exhaust them.
 *
 * The bitrate handed back is the one already in force, so nothing about the quality changes;
 * the call is only the carrier. It does persist "not automatic" for the bitrate, exactly as
 * picking a quality from the stock menu does, which is why it is not done when the value is
 * not a number we can hand back unchanged.
 *
 * DEBOUNCED, because dragging a slider through five rungs must start one transcode, not five.
 * FAIL SAFE: every failure path leaves playback exactly as it was and says the change will
 * apply on the next playback, rather than taking the player down with it.
 */
var APPLY_DEBOUNCE = 700;

// What is actually about to happen, rather than a bare "applying...": the stream is torn down
// and restarted at this position, which is a second of black the viewer should expect.
export var APPLY_LABEL = 'restarting the stream here…';

// Said in the panel when the re-negotiation never landed. The selection is not lost: it rides
// on the next PlaybackInfo, which is what "next negotiates" means.
export var APPLY_FAILED_TEXT = 'That change did not land: the stream was not renegotiated.'
    + ' It applies when playback next negotiates.';

function doApply() {
    state.applyTimer = null;
    if (!playerPresent()) {
        state.applying = null;
        state.applyFailed = true;
        repaintPanel();
        return;
    }

    // Nothing to re-negotiate on a direct play, so go straight to the thing that does work.
    // Doing this first rather than after a 12 second timeout is the difference between a
    // change that lands and a viewer backing out of the video and opening it again.
    if (directPlaying()) {
        state.applying = APPLY_LABEL;
        repaintPanel();
        if (replayHere()) {
            watchApplied(state.playSessionId);
        } else {
            state.applying = null;
            state.applyFailed = true;
            repaintPanel();
        }

        return;
    }

    var previousId = state.playSessionId;
    try {
        var pm = player();
        var current = pm.getMaxStreamingBitrate();
        if (!(current > 0)) {
            // Handing back a value that is not a bitrate would overwrite the viewer's own
            // saved setting with nothing. Not worth it: say so and leave playback alone.
            log('no current bitrate to hand back; the change applies on the next playback');
            state.applying = null;
            state.applyFailed = true;
            repaintPanel();
            return;
        }

        state.applying = APPLY_LABEL;
        repaintPanel();
        // Handing back the exact value already in force risks jellyfin-web treating this as a
        // no-op (a bitrate-change path with nothing to change is a reasonable place for an
        // equality guard to live, and we do not control that code). Nudge by 1 bps, alternating
        // direction each call, so the value always differs from what jellyfin-web already holds
        // and changeStream() actually runs - imperceptible to playback, but guarantees the
        // re-negotiation this whole mechanism depends on is not silently dropped.
        var nudged = state.bitrateNudgeUp ? current + 1 : Math.max(1, current - 1);
        state.bitrateNudgeUp = !state.bitrateNudgeUp;
        pm.setMaxStreamingBitrate({ enableAutomaticBitrateDetection: false, maxBitrate: nudged });
        log('asked the player to renegotiate at the current position (nudged bitrate ' + current + ' -> ' + nudged + ')');
        watchApplied(previousId);
    } catch (err) {
        log('could not renegotiate; the change applies on the next playback', err);
        state.applying = null;
        state.applyFailed = true;
        repaintPanel();
    }
}

/* Called by every control. Debounced, and a no-op when nothing is playing. */
export function requestRestream() {
    try {
        if (state.applyTimer) {
            clearTimeout(state.applyTimer);
            state.applyTimer = null;
        }

        if (!playerPresent()) {
            log('nothing is playing; the change applies on the next playback');
            return;
        }

        // A fresh attempt, so the last failure is no longer what is being reported, and the
        // one re-play this selection is allowed is available again.
        state.applyFailed = false;
        state.replayTried = false;
        state.applying = APPLY_LABEL;
        state.applyTimer = setTimeout(doApply, APPLY_DEBOUNCE);
    } catch (err) {
        log('could not schedule the change', err);
    }
}

/* ------------------------------------------------------------------ what the server DID */

/*
 * IS IT ON, RIGHT NOW, ACCORDING TO THE SERVER.
 *
 * Answered from the session record alone, never from what the panel selected. The panel already
 * says what was picked and what the record holds; what it could not say is the one thing a
 * viewer actually wants: is any of this running on the stream playing at this moment. A badge
 * built from the selection would say "on" for a chain the server refused, which is the whole
 * failure class this project keeps hitting.
 *
 * Four states, each from a field the server sends:
 *   unavailable  the patches are not installed, so nothing can run whatever is chosen
 *   waiting      nothing has been negotiated yet, or the server has not answered for it
 *   off          the server answered and built no chain: direct play, a stream copy, or a
 *                session it refused, with its own reason
 *   active       a chain was built and the record names at least one pass that ran
 */
export function activeState() {
    var s = state.lastServerState;
    if (!s) {
        return { key: 'waiting', label: 'Waiting for the server',
            why: state.playSessionId
                ? 'The server has not answered for this session yet.'
                : 'Nothing is playing yet.' };
    }

    if (s.PatchActive === false) {
        return { key: 'unavailable', label: 'Enhancement unavailable',
            why: 'The server-side patches are not active, so nothing can run whatever is chosen here.' };
    }

    if (!s.Known) {
        return { key: 'off', label: 'Not enhancing',
            why: 'The server built no filter chain for this session, so this is a direct play, a'
                + ' stream copy, or a stream it has not started yet.' };
    }

    // "Applied" is not taken on trust either: a record can carry the status while every axis
    // sits at off, which is a transcode this plugin touched and changed nothing in.
    var ran = LIVE_ROWS.some(function (r) {
        if (r.applied) { return !!s[r.applied]; }
        return r.level ? !isOff(s[r.level]) : false;
    });

    if (!ran) {
        return { key: 'off', label: 'Not enhancing',
            why: 'A chain was built for this session but no enhancement pass ran in it.'
                + (s.Status ? ' The server says: ' + s.Status + '.' : '') };
    }

    return { key: 'active', label: 'Enhancing now',
        why: s.Summary || 'The server reports at least one pass running on this stream.' };
}
