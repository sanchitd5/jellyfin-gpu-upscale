import { log } from '../lib/log.js';
import { SESSION_KEY, STORE_KEY, seedFor, mirrorFor } from '../model/player-speed.js';

/*
 * PERSISTENT PLAYBACK SPEED.
 *
 * Stock keeps the speed in sessionStorage 'playbackRateSpeed': playbackManager.setPlaybackRate
 * writes it (the speed menu, the remote-control command and the J/L-style shortcuts all go
 * through it) and the video page re-applies it on every player state change
 * (video/index.js updatePlaybackRate). It is gone with the tab. Two small steps keep it:
 *
 *   SEED   at startup, if this tab has not chosen a speed yet (the key is absent), copy the saved
 *          one into sessionStorage. The stock re-apply then picks it up on the first video, with
 *          no change to the player. A speed picked earlier in this tab is never overwritten.
 *   MIRROR on every 'ratechange' of a <video> (capture phase on document: the event does not
 *          bubble), copy sessionStorage's value to localStorage. The session key is what the
 *          viewer CHOSE: the hold-for-2x gesture writes the element's rate directly and leaves it
 *          alone, so a 2x hold is never saved.
 *
 * Storage that throws (private mode, blocked) leaves stock exactly as it was.
 */

function onRateChange(e) {
    try {
        var t = e && e.target;
        if (!t || t.tagName !== 'VIDEO') { return; }
        var act = mirrorFor(window.sessionStorage.getItem(SESSION_KEY), window.localStorage.getItem(STORE_KEY));
        if (!act) { return; }
        if (act.op === 'set') {
            window.localStorage.setItem(STORE_KEY, act.value);
        } else {
            window.localStorage.removeItem(STORE_KEY);
        }

        log('player speed: saved ' + (act.op === 'set' ? act.value : '1 (cleared)'));
    } catch (err) { /* storage refused: nothing to do */ }
}

export function installPlayerSpeed() {
    try {
        var seed = seedFor(window.sessionStorage.getItem(SESSION_KEY), window.localStorage.getItem(STORE_KEY));
        if (seed) {
            window.sessionStorage.setItem(SESSION_KEY, seed);
            log('player speed: seeded ' + seed);
        }
    } catch (err) {
        log('player speed: could not seed', err);
    }

    try {
        document.addEventListener('ratechange', onRateChange, true);
    } catch (err) {
        log('player speed install failed', err);
    }
}
