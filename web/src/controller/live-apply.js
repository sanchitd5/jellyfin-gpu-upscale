import { state } from '../model/state.js';
import { isOff } from '../lib/utils.js';
import { log } from '../lib/log.js';
import { renderPanel, panelEl } from '../view/panel-dom.js';
import { LIVE_ROWS } from './live-block.js';

export function repaintPanel() {
    log('repaintPanel: start');
    try {
        var p = panelEl();
        if (p) {
            renderPanel(p, state.caps || { full: false, failed: true });
            log('repaintPanel: end, re-rendered');
        } else {
            log('repaintPanel: end, no panel element mounted');
        }
    } catch (err) {
        log('repaintPanel: end, threw', err);
        /* the panel is never worth breaking playback for */
    }
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
// NOT logged: called on every module export while webpack boots (thousands of times), so a log
// line here would flood the console. notePlaybackManager()/tryRequireShim() log the one call that
// actually matches.
export function isPlaybackManager(o) {
    return !!o
        && typeof o.setMaxStreamingBitrate === "function"
        && typeof o.getMaxStreamingBitrate === "function"
        && typeof o.currentItem === "function";
}

/*
 * THE PLAYER ARGUMENT currentItem()/currentTime() ACTUALLY WANT.
 *
 * Confirmed live (this session's own diagnostic dump: chunks/modulesWrapped/hasRef all healthy,
 * capture worked) that pm.currentItem() returns nothing during real, active playback -
 * playerPresent() read that as "nothing is playing" and applyNow() refused with exactly that
 * message on a portrait video that WAS playing. jellyfin-web's playbackManager tracks more than
 * one registered player (html video, cast, etc.) and several of its methods, this one included,
 * take the ACTIVE player instance as an argument rather than assuming a single implicit one -
 * calling them with none is a silent wrong answer, not an error, which is exactly the failure
 * shape this project keeps hitting (AGENTS.md). getCurrentPlayer() is the same object's own way
 * of naming which player is active; pass it through when the method carries it, but keep the
 * no-arg call available as a fallback for a build old enough not to need it.
 */
function activePlayer(pm) {
    try {
        var pl = typeof pm.getCurrentPlayer === 'function' ? pm.getCurrentPlayer() : undefined;
        log('activePlayer: end, ' + (typeof pm.getCurrentPlayer === 'function'
            ? 'getCurrentPlayer() -> ' + (pl ? 'a player object' : 'nothing')
            : 'no getCurrentPlayer method, calling without one'));
        return pl;
    } catch (err) {
        log('activePlayer: end, getCurrentPlayer() threw', err);
        return undefined;
    }
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
    log('tryRequireShim: start, alreadyTried=' + requireShimTried + ', alreadyHaveRef=' + !!state.playbackManagerRef);
    if (requireShimTried || state.playbackManagerRef) {
        log('tryRequireShim: end, skipped (nothing to do)');
        return;
    }

    requireShimTried = true;
    try {
        if (typeof window.require !== 'function') {
            log('tryRequireShim: end, window.require is not a function on this build');
            return;
        }

        log('tryRequireShim: calling window.require(["playbackManager"], ...)');
        window.require(['playbackManager'], function (pm) {
            try {
                if (!state.playbackManagerRef && isPlaybackManager(pm)) {
                    state.playbackManagerRef = pm;
                    log('tryRequireShim: require() callback fired, found playbackManager via the module shim');
                } else {
                    log('tryRequireShim: require() callback fired, candidate did not match isPlaybackManager or a ref already existed');
                }
            } catch (err) { /* never worth breaking the shim callback for */ }
        });
        log('tryRequireShim: end, require() call issued (callback is async)');
    } catch (err) {
        log('tryRequireShim: end, require() shim probe threw', err);
    }
}

export function player() {
    if (isPlaybackManager(window.playbackManager)) {
        log('player: end, using window.playbackManager');
        return window.playbackManager;
    }

    if (!state.playbackManagerRef) {
        tryRequireShim();
    }

    log('player: end, returning ' + (state.playbackManagerRef ? 'the captured playbackManagerRef' : 'null (no manager found by any path)'));
    return state.playbackManagerRef;
}

export function playerPresent() {
    log('playerPresent: start');
    try {
        var pm = player();
        if (!pm) {
            log('playerPresent: end, false (player() returned nothing)');
            return false;
        }

        var hasShape = typeof pm.setMaxStreamingBitrate === 'function'
            && typeof pm.getMaxStreamingBitrate === 'function'
            && typeof pm.currentItem === 'function';
        if (!hasShape) {
            log('playerPresent: end, false (captured object does not carry the expected shape)');
            return false;
        }

        var pl = activePlayer(pm);
        var item = pm.currentItem(pl);
        log('playerPresent: end, currentItem(' + (pl ? 'activePlayer' : 'no arg') + ') -> '
            + (item ? ('item ' + (item.Id || item.id || '?')) : 'nothing') + ', result ' + !!item);
        return !!item;
    } catch (err) {
        log('playerPresent: end, threw', err);
        return false;
    }
}

/*
 * The change is finished when a NEW PlaySessionId comes back - which this script learns from
 * the PlaybackInfo response it is already reading, so nothing extra is polled off the server.
 * The timeout exists so the label cannot stick on forever if the negotiation never lands.
 */
export function watchApplied(previousId) {
    log('watchApplied: start, watching for a PlaySessionId different from ' + previousId);
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
                log('watchApplied: poll settled after ' + tries + ' tries, landed=' + landed
                    + ', currentPlaySessionId=' + state.playSessionId);
                // One retry, by the route that works when re-negotiation does not: the stream
                // that would not change is usually one the server is handing over untouched.
                // Only once, because a re-play that also fails to land must not become a loop
                // that restarts the viewer's film every twelve seconds.
                if (!landed && !state.replayTried) {
                    state.replayTried = true;
                    log('watchApplied: timed out without landing, trying one replayHere() as a fallback');
                    if (replayHere()) {
                        state.applyFailed = false;
                        state.applying = APPLY_LABEL;
                        log('watchApplied: end, fallback replayHere() issued, starting a second watch');
                        watchApplied(state.playSessionId);
                        return;
                    }

                    log('watchApplied: fallback replayHere() also failed');
                }

                log('watchApplied: end');
                repaintPanel();
            }
        } catch (err) {
            log('watchApplied: end, threw', err);
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
    log('replayHere: start');
    try {
        var pm = player();
        var pl = activePlayer(pm);
        var item = pm && typeof pm.currentItem === 'function' ? pm.currentItem(pl) : null;
        var id = item && (item.Id || item.id);
        log('replayHere: currentItem -> ' + (item ? ('id ' + id) : 'nothing'));
        if (!id || typeof pm.play !== 'function') {
            log('replayHere: end, false (' + (!id ? 'no current item id' : 'pm.play is not a function') + ')');
            return false;
        }

        var ticks = 0;
        if (typeof pm.currentTime === 'function') {
            var ms = pm.currentTime(pl);
            if (ms > 0) { ticks = Math.floor(ms) * 10000; }
            log('replayHere: currentTime -> ' + ms + 'ms, startPositionTicks ' + ticks);
        } else {
            log('replayHere: no currentTime method, starting from position 0');
        }

        var serverId = item.ServerId || item.serverId;
        log('replayHere: calling pm.play({ ids: [' + id + '], serverId: ' + serverId
            + ', startPositionTicks: ' + ticks + ' })');
        // serverId is required here: pm.play() only skips getItemsForPlayback() when `items`
        // (not `ids`) is passed. Without it, jellyfin-web's async play() throws "serverId
        // required!" before issuing any request - a rejected promise this call never awaits or
        // catches, so it silently ate every replay on a direct-playing session: pm.play()
        // rejected before getPlaybackInfo() ever ran, no new PlaybackInfo request was ever sent,
        // and this function still reported success because it never looked at the promise.
        var playResult = pm.play({ ids: [id], serverId: serverId, startPositionTicks: ticks });
        if (playResult && typeof playResult.catch === 'function') {
            playResult.catch(function (err) {
                log('replayHere: pm.play() promise rejected', err);
            });
        }
        log('replayHere: end, true - pm.play() call returned (does not itself mean the player switched)');
        return true;
    } catch (err) {
        log('replayHere: end, false, threw', err);
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
    var result = !!(s && s.PatchActive !== false && s.Known === false);
    log('directPlaying: start/end, lastServerState=' + (s ? 'present' : 'null') + ', result ' + result);
    return result;
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
    log('doApply: start');
    state.applyTimer = null;
    if (!playerPresent()) {
        log('doApply: end, playerPresent() false, giving up');
        state.applying = null;
        state.applyFailed = true;
        repaintPanel();
        return;
    }

    // Nothing to re-negotiate on a direct play, so go straight to the thing that does work.
    // Doing this first rather than after a 12 second timeout is the difference between a
    // change that lands and a viewer backing out of the video and opening it again.
    if (directPlaying()) {
        log('doApply: direct-playing branch, going straight to replayHere()');
        state.applying = APPLY_LABEL;
        repaintPanel();
        if (replayHere()) {
            log('doApply: end, replayHere() issued, handing off to watchApplied()');
            watchApplied(state.playSessionId);
        } else {
            log('doApply: end, replayHere() failed on the direct-play branch');
            state.applying = null;
            state.applyFailed = true;
            repaintPanel();
        }

        return;
    }

    log('doApply: transcoding branch, will try setMaxStreamingBitrate()');
    var previousId = state.playSessionId;
    try {
        var pm = player();
        var current = pm.getMaxStreamingBitrate();
        log('doApply: getMaxStreamingBitrate() -> ' + current);
        if (!(current > 0)) {
            // Handing back a value that is not a bitrate would overwrite the viewer's own
            // saved setting with nothing. Not worth it: say so and leave playback alone.
            log('doApply: end, no current bitrate to hand back; the change applies on the next playback');
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
        // Tag the OLD session id right before the re-negotiation fires, so the request it
        // triggers can carry it as the "swapfrom" marker (see wireParams() in network.js). This
        // is what lets the server try the A/B swap instead of today's plain tear-down-and-
        // restart - see LIVE_APPLY_DESIGN.md. Cleared once the new PlaySessionId lands.
        state.swapFrom = previousId;
        log('doApply: set state.swapFrom = ' + previousId + ' before renegotiating');
        pm.setMaxStreamingBitrate({ enableAutomaticBitrateDetection: false, maxBitrate: nudged });
        log('doApply: end, asked the player to renegotiate at the current position (nudged bitrate '
            + current + ' -> ' + nudged + '), handing off to watchApplied()');
        watchApplied(previousId);
    } catch (err) {
        log('doApply: end, could not renegotiate; the change applies on the next playback', err);
        state.applying = null;
        state.applyFailed = true;
        repaintPanel();
    }
}

/* Called by every control. Debounced, and a no-op when nothing is playing. */
export function requestRestream() {
    log('requestRestream: start');
    try {
        if (state.applyTimer) {
            log('requestRestream: clearing a pending debounce timer from an earlier call');
            clearTimeout(state.applyTimer);
            state.applyTimer = null;
        }

        if (!playerPresent()) {
            log('requestRestream: end, nothing is playing; the change applies on the next playback');
            return;
        }

        // A fresh attempt, so the last failure is no longer what is being reported, and the
        // one re-play this selection is allowed is available again.
        state.applyFailed = false;
        state.replayTried = false;
        state.applying = APPLY_LABEL;
        state.applyTimer = setTimeout(doApply, APPLY_DEBOUNCE);
        log('requestRestream: end, scheduled doApply() in ' + APPLY_DEBOUNCE + 'ms');
    } catch (err) {
        log('requestRestream: end, could not schedule the change', err);
    }
}

/*
 * THE GUARANTEED PATH, for the viewer who does not trust (or has been burned by) the automatic
 * one above. requestRestream()'s whole mechanism depends on three things that can each go wrong
 * in ways this project has already hit once: finding playbackManager at all (webpack-chunk timing,
 * the require() shim), jellyfin-web's setMaxStreamingBitrate() actually re-negotiating rather than
 * no-op'ing, and the server correctly reading the swapfrom marker. Each has its own fix now, but a
 * viewer who changed a setting mid-play and saw nothing happen has no way to tell "it silently
 * failed" from "it takes a few seconds" - the reported shape of the bug this session keeps
 * surfacing is exactly that ambiguity, not any one of the underlying causes.
 *
 * This button skips all three: it is the same thing backing out of the player and reopening the
 * item already does (proven to work - that is how a viewer's changed preference has always shown
 * up on the NEXT play), just without leaving the page. replayHere() calls pm.play() with the
 * current item and position, which forces a full fresh PlaybackInfo negotiation - no bitrate
 * comparison, no shape-detection dependency beyond what replayHere() itself already checks.
 */
export function applyNow() {
    log('applyNow: start, current playSessionId=' + state.playSessionId);
    try {
        if (!playerPresent()) {
            log('applyNow: end, nothing is playing; the change applies on the next playback');
            return;
        }

        if (state.applyTimer) {
            log('applyNow: clearing a pending debounced auto-apply so it does not fire on top of this');
            clearTimeout(state.applyTimer);
            state.applyTimer = null;
        }

        state.applyFailed = false;
        state.replayTried = true; // this IS the replay; watchApplied must not attempt a second one
        state.applying = APPLY_LABEL;
        repaintPanel();

        var previousId = state.playSessionId;
        log('applyNow: calling replayHere(), previousId=' + previousId);
        if (replayHere()) {
            log('applyNow: end, replayHere() returned true, handing off to watchApplied()');
            watchApplied(previousId);
        } else {
            log('applyNow: end, replayHere() returned false');
            state.applying = null;
            state.applyFailed = true;
            repaintPanel();
        }
    } catch (err) {
        log('applyNow: end, threw', err);
        state.applying = null;
        state.applyFailed = true;
        repaintPanel();
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
    // Logged lightly (one line, no per-branch detail): this runs on every panel repaint,
    // including the ~3s live poll, so a verbose trace here would drown out the one-shot apply
    // chain above, which is what "start to end" instrumentation is actually for.
    log('activeState: start/end, lastServerState=' + (state.lastServerState ? 'present' : 'null'));
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
