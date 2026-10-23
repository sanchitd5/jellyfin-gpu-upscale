/*
 * Pure logic for syncing a few localStorage preferences to the server (jellyfin-web's
 * DisplayPreferences.CustomPrefs). No DOM, no network: controller/prefs-sync.js does the wiring.
 *
 * WHAT SYNCS. Only choices that should follow the viewer from device to device: the Enhance panel's
 * stage and per-axis picks, the search page size and the paged/infinite choice, and the viewer's quick
 * tag-filter groups. Not the panel's
 * position (device-specific, so it is dropped from the synced value and kept local), not committed
 * search filters or the exclude box (query state), not UI collapse state, debug flag or name caches.
 *
 * ON THE SERVER each key is one CustomPrefs entry holding a small JSON envelope {"t": ms, "v": value}:
 * t is the epoch millisecond of the write on the device that made it, v is the value as the local key
 * holds it (a string, or null for "cleared"). The most recent t wins, key by key. Clocks are the
 * devices' own, so two devices that disagree on the time by more than the gap between two edits can
 * pick the older one; for preferences that is an acceptable failure.
 */

/* One entry per synced key. `drop` names a top-level JSON field that stays on the device. `owned`: the local key is not per-user, so never push a value this user has no write record for. */
export var SYNCED = [
    { local: 'jellyfinPlusPrefs', remote: 'jellyfinPlus.prefs', drop: 'pos' },
    { local: 'jellyfinPlus.searchPageSize', remote: 'jellyfinPlus.searchPageSize' },
    { local: 'jellyfinPlus.searchPaging', remote: 'jellyfinPlus.searchPaging' },
    // The viewer's quick tag-filter groups (model/quick-tags.js keeps the stored form well under MAX_VALUE_LENGTH).
    { local: 'jellyfinPlus.quickTags', remote: 'jellyfinPlus.quickTags', owned: true },
    // Which suggested groups the viewer hid or renamed (small: capped at 50 of each).
    { local: 'jellyfinPlus.quickTagsAuto', remote: 'jellyfinPlus.quickTagsAuto', owned: true }
];

/* localStorage key holding {userId: {localKey: t}}, the time each local value last changed. */
export var META_KEY = 'jellyfinPlus.syncMeta';

/* jellyfin-web stores a CustomPrefs key at most this long (QOL_IDEAS 32: ItemDisplayPreferences key MaxLength 64). */
export var MAX_KEY_LENGTH = 64;
var MAX_VALUE_LENGTH = 20000;

function parseObject(text) {
    var o = JSON.parse(text);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
}

/* The value that is compared and sent: the raw local string minus the device-specific field. null when unset or unusable. */
export function canon(def, raw) {
    if (raw == null) { return null; }
    raw = String(raw);
    if (!def.drop) { return raw; }
    try {
        var o = parseObject(raw);
        if (!o) { return null; }
        delete o[def.drop];
        return JSON.stringify(o);
    } catch (e) {
        return null;
    }
}

export function encode(value, t) {
    return JSON.stringify({ t: t, v: value });
}

/* The envelope, or null when absent or not one of ours (anything else a server holds is ignored, never trusted). */
export function decode(def, text) {
    if (typeof text !== 'string' || text.length > MAX_VALUE_LENGTH + 100) { return null; }
    try {
        var o = JSON.parse(text);
        if (!o || typeof o !== 'object' || typeof o.t !== 'number' || !isFinite(o.t) || o.t <= 0) { return null; }
        if (o.v !== null && typeof o.v !== 'string') { return null; }
        if (typeof o.v === 'string') {
            if (o.v.length > MAX_VALUE_LENGTH) { return null; }
            if (def.drop && !parseObject(o.v)) { return null; }
        }
        return { t: o.t, v: o.v };
    } catch (e) {
        return null;
    }
}

/*
 * What to do about one key: 'adopt' (take the server's value), 'push' (send ours) or 'none'.
 *   - nothing on the server: send ours if we have one; but for a key flagged `owned` (per-viewer content) only when this device
 *     recorded this user writing it (tLocal > 0): an unrecorded value may be another account's on a shared
 *     browser, so it is neither pushed nor removed;
 *   - equal values: nothing, whatever the times;
 *   - we have no value: adopt, unless we removed it after the server's copy was written (then send the removal);
 *   - otherwise the later write wins, and a tie goes to the server (every device then converges on it).
 * tLocal is 0 when this device has no record of when its value was written (a value from before sync existed).
 */
export function decide(localCanon, tLocal, remote, needsRecord) {
    if (!remote) { return localCanon == null || (needsRecord && !tLocal) ? 'none' : 'push'; }
    if (localCanon === remote.v) { return 'none'; }
    // No local value: either never had one (adopt) or removed it after the server's copy was written (send the removal).
    if (localCanon == null) { return tLocal > remote.t ? 'push' : 'adopt'; }
    return remote.t >= tLocal ? 'adopt' : 'push';
}

/* The raw string to store locally when adopting remoteV: the device-specific field of what is there now is kept. null means remove the key. */
export function adopted(def, remoteV, localRaw) {
    if (remoteV === null) { return null; }
    if (!def.drop) { return remoteV; }
    var o = parseObject(remoteV);
    if (!o) { return null; }
    try {
        var mine = localRaw == null ? null : parseObject(String(localRaw));
        if (mine && mine[def.drop] !== undefined) { o[def.drop] = mine[def.drop]; }
    } catch (e) { /* unreadable local value: nothing to keep */ }
    return JSON.stringify(o);
}

export function byLocalKey() {
    var m = {};
    SYNCED.forEach(function (d) { m[d.local] = d; });
    return m;
}
