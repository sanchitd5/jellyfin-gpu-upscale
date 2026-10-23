/*
 * PERSISTENT PLAYBACK SPEED (pure).
 *
 * jellyfin-web keeps the speed in sessionStorage 'playbackRateSpeed' (playbackManager
 * .setPlaybackRate) and the video page re-applies it on every player state change. That dies with
 * the tab. These functions decide what to copy to localStorage and what to seed back, so that
 * controller/player-speed.js is only the storage and event plumbing.
 *
 * The session value is the SOURCE of what the viewer chose: the hold-for-2x gesture sets the
 * element's rate directly and never touches it, so a hold can never be mirrored.
 */

export var SESSION_KEY = 'playbackRateSpeed';
export var STORE_KEY = 'jellyfinPlusPlaybackRate';

var MIN_RATE = 0.25;
var MAX_RATE = 4;

/* A usable rate from a stored string, or null. */
export function parseRate(raw) {
    if (raw == null || raw === '') { return null; }
    var r = Number(raw);
    return (isFinite(r) && r >= MIN_RATE && r <= MAX_RATE) ? r : null;
}

/*
 * What to put in sessionStorage at startup. Only when the session has not chosen a speed (key
 * absent: a rate picked earlier in this tab is never overwritten) and the saved one is not plain
 * 1x, which is what an absent key already means.
 */
export function seedFor(sessionRaw, storedRaw) {
    if (sessionRaw !== null && sessionRaw !== undefined) { return null; }
    var r = parseRate(storedRaw);
    return (r !== null && r !== 1) ? String(r) : null;
}

/*
 * What to do with the saved rate after the session's changed: { op: 'set', value }, { op:
 * 'remove' } (back to 1x), or null for nothing to do. An unparsable session value is left alone.
 */
export function mirrorFor(sessionRaw, storedRaw) {
    var r = parseRate(sessionRaw);
    if (r === null) { return null; }
    var saved = parseRate(storedRaw);
    if (r === 1) {
        return (storedRaw !== null && storedRaw !== undefined) ? { op: 'remove' } : null;
    }

    return saved === r ? null : { op: 'set', value: String(r) };
}
