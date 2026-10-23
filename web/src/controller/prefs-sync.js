import { log } from '../lib/log.js';
import { reloadPrefs } from '../model/prefs-store.js';
import { SYNCED, META_KEY, canon, encode, decode, decide, adopted, byLocalKey } from '../model/prefs-sync.js';

/*
 * Syncs a few localStorage preferences (model/prefs-sync.js says which) to the server, through
 * jellyfin-web's own settings object, so they follow the viewer across devices.
 *
 * LOCAL FIRST, NEVER BLOCKING. Every module keeps reading and writing localStorage exactly as before,
 * so the page boots with no extra request and no wait. The server copy is reconciled afterwards, in a
 * timer, from what jellyfin-web has already downloaded at login: nothing here goes to the network on
 * its own.
 *
 * WHY THE STOCK SETTINGS OBJECT AND NOT OUR OWN REQUEST. DisplayPreferences is a replace-everything
 * endpoint: POST deletes every CustomPrefs entry and writes back the ones in the body, and jellyfin-web
 * posts its own cached copy on each of its saves. A write we made behind its back would be erased by
 * its next save. Going through userSettings.set() puts our keys in that cached copy, so they survive,
 * and reuses its debounced POST. The object is found by SHAPE (an instance with setUserInfo, get, set
 * and loadQuerySettings), like the player and the query client; if it is not there, nothing syncs and
 * every preference stays in localStorage.
 *
 * CONFLICTS. Each synced key carries the time of its last write in its server value. On reconcile (login,
 * and user switch) the later write wins per key; see model/prefs-sync.js. The device's record of its own
 * write times is per user, so two accounts sharing a browser do not trade each other's prefs.
 */

var byLocal = byLocalKey();
var settings = null;
var installed = false;
var adopting = false;
var known = {};
var pushTimer = null;
var reconcileTimer = null;
var warned = false;

function store() {
    try { return window.localStorage; } catch (e) { return null; }
}

function readLocal(key) {
    try { var s = store(); return s ? s.getItem(key) : null; } catch (e) { return null; }
}

function readMeta() {
    try {
        var o = JSON.parse(readLocal(META_KEY));
        return o && typeof o === 'object' ? o : {};
    } catch (e) {
        return {};
    }
}

function writeMeta(meta) {
    try {
        adopting = true;
        var s = store();
        if (s) { s.setItem(META_KEY, JSON.stringify(meta)); }
    } catch (e) { /* storage refused: sync still works this session, from memory */ } finally { adopting = false; }
}

function userId() {
    return settings && settings.currentUserId ? String(settings.currentUserId) : '';
}

function ready() {
    return !!(settings && settings.displayPrefs && settings.displayPrefs.CustomPrefs && userId());
}

function pushOne(def, value, t) {
    try {
        settings.set(def.remote, encode(value, t), true);
    } catch (err) {
        log('prefs sync: push failed for ' + def.remote, err);
    }
}

/* Sends every key whose local write is newer than the server's. Debounced after a change. */
function pushChanged() {
    pushTimer = null;
    if (!ready()) { return; }
    var uid = userId();
    var all = readMeta();
    var meta = all[uid] || {};
    SYNCED.forEach(function (def) {
        var c = canon(def, readLocal(def.local));
        var remote = decode(def, settings.displayPrefs.CustomPrefs[def.remote]);
        var t = meta[def.local] || 0;
        if (t && decide(c, t, remote) === 'push') {
            pushOne(def, c, t);
        }
    });
}

function onLocalWrite(key) {
    var def = byLocal[key];
    if (!def) { return; }
    var c = canon(def, readLocal(key));
    if (c === known[key]) { return; }
    known[key] = c;
    var uid = userId();
    if (!uid) {
        // Not signed in yet (or settings not found): reconcile will compare against a time of 0, which loses
        // to a server value. Record the write under the pending user once it is known.
        return;
    }
    var all = readMeta();
    var meta = all[uid] = all[uid] || {};
    // A write the viewer has just made beats whatever copy this device last saw, even if the clocks
    // disagree: never earlier than one millisecond after the server's copy.
    var seen = ready() ? decode(def, settings.displayPrefs.CustomPrefs[def.remote]) : null;
    meta[key] = Math.max(Date.now(), seen ? seen.t + 1 : 0);
    writeMeta(all);
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushChanged, 1500);
}

/* Applies the server's newer values locally and sends our newer ones. Runs after login, never on the page's critical path. */
function reconcile() {
    reconcileTimer = null;
    try {
        if (!installed || !ready()) { return; }
        var uid = userId();
        var all = readMeta();
        var meta = all[uid] = all[uid] || {};
        var adoptedAny = false;
        SYNCED.forEach(function (def) {
            var raw = readLocal(def.local);
            var c = canon(def, raw);
            var remote = decode(def, settings.displayPrefs.CustomPrefs[def.remote]);
            var action = decide(c, meta[def.local] || 0, remote);
            if (action === 'adopt') {
                var next = adopted(def, remote.v, raw);
                try {
                    adopting = true;
                    var s = store();
                    if (s) {
                        if (next === null) { s.removeItem(def.local); } else { s.setItem(def.local, next); }
                    }
                } finally {
                    adopting = false;
                }

                meta[def.local] = remote.t;
                known[def.local] = canon(def, readLocal(def.local));
                adoptedAny = true;
                log('prefs sync: adopted ' + def.remote + ' from the server');
            } else if (action === 'push') {
                var t = meta[def.local] || Date.now();
                meta[def.local] = t;
                pushOne(def, c, t);
                log('prefs sync: pushed ' + def.remote);
            } else if (remote && !meta[def.local]) {
                meta[def.local] = remote.t;
            }
        });
        writeMeta(all);
        if (adoptedAny) { reloadPrefs(); }
    } catch (err) {
        log('prefs sync: reconcile failed', err);
    }
}

function scheduleReconcile() {
    if (reconcileTimer) { return; }
    reconcileTimer = setTimeout(reconcile, 0);
}

function isUserSettings(o) {
    return !!o
        && typeof o === 'object'
        && typeof o.setUserInfo === 'function'
        && typeof o.get === 'function'
        && typeof o.set === 'function'
        && typeof o.loadQuerySettings === 'function';
}

function capture(inst) {
    settings = inst;
    log('prefs sync: found the user settings object');
    var original = inst.setUserInfo;
    inst.setUserInfo = function () {
        var result = original.apply(this, arguments);
        try {
            // After the settings reload for a (new) user, compare against that user's server copy.
            Promise.resolve(result).then(scheduleReconcile, function () { /* the stock caller reports it */ });
        } catch (e) { /* ignore */ }
        return result;
    };

    if (inst.displayPrefs) { scheduleReconcile(); }
}

/* Called with every module's exports (controller/webpack-hook.js); keeps the first user settings object it sees. */
export function noteUserSettings(exports) {
    if (settings || !exports || (typeof exports !== 'object' && typeof exports !== 'function')) {
        return;
    }

    try {
        if (isUserSettings(exports)) {
            capture(exports);
            return;
        }

        var keys = Object.keys(exports);
        for (var i = 0; i < keys.length && !settings; i++) {
            var v;
            try {
                v = exports[keys[i]];
            } catch (e) {
                continue;
            }

            if (isUserSettings(v)) {
                capture(v);
            }
        }
    } catch (err) { /* an exotic export is not a reason to break module loading */ }
}

/*
 * The Storage hook: notices writes to the synced keys without touching the modules that make them.
 * The original runs first and always, so a failure here can only lose a sync, never a write.
 */
function hookStorage() {
    var proto = window.Storage && window.Storage.prototype;
    if (!proto || proto.__jellyfinPlusSync) { return; }
    var set = proto.setItem;
    var remove = proto.removeItem;
    proto.setItem = function (key) {
        var r = set.apply(this, arguments);
        try { if (!adopting && byLocal[key] && this === store()) { onLocalWrite(key); } } catch (e) { /* never block a write */ }
        return r;
    };
    proto.removeItem = function (key) {
        var r = remove.apply(this, arguments);
        try { if (!adopting && byLocal[key] && this === store()) { onLocalWrite(key); } } catch (e) { /* never block a write */ }
        return r;
    };
    proto.__jellyfinPlusSync = true;
}

export function installPrefsSync() {
    SYNCED.forEach(function (def) { known[def.local] = canon(def, readLocal(def.local)); });
    hookStorage();
    installed = true;
    if (settings && settings.displayPrefs) { scheduleReconcile(); }
    setTimeout(function () {
        if (!settings && !warned) {
            warned = true;
            log('prefs sync: the user settings object was not found; preferences stay in localStorage');
        }
    }, 20000);
}
