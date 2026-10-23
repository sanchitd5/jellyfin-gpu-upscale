import { log } from '../lib/log.js';
import {
    STORE_KEY, AUTO_KEY, encodeGroups, decodeGroups, parseSuggested, decodeAuto, encodeAuto, mergeGroups
} from '../model/quick-tags.js';
import { fetchTagWindow } from './tag-window.js';

/*
 * QUICK TAG GROUPS, DATA SIDE (views: view/quick-tags.js above library lists, view/quick-tags-editor.js
 * for editing, view/search-filter-sheet.js for the search page).
 *
 *  - The groups are the VIEWER'S OWN, kept in localStorage `jellyfinPlus.quickTags` and mirrored to the
 *    server by controller/prefs-sync.js (model/prefs-sync.js SYNCED), so they follow the user across
 *    devices. There is no server-wide setting: the server part is only the `jpTagAnyOf` filter.
 *  - A prefix group's tag names are enumerated with fetchTagWindow (the shipped /Items/Filters window,
 *    jpTagQuery = the prefix, at most 200 tags); chips keep only names that START with the prefix
 *    (model/quick-tags.js chipsFor). Cached per prefix for CACHE_TTL. The full tag list is never fetched.
 */

var CACHE_TTL = 5 * 60 * 1000;
// A prefix is matched as a substring by the server, so a very common one may be cut at this many tags.
export var PREFIX_LIMIT = 200;

var names = {}; // prefix -> { at, tags, promise }
var listeners = [];

/* The viewer's groups, read fresh (another tab or a sync may have changed them). Never null. */
export function groupsNow() {
    try {
        return decodeGroups(window.localStorage.getItem(STORE_KEY));
    } catch (e) {
        return [];
    }
}

export function loadGroups() {
    return Promise.resolve(groupsNow());
}

export function onGroupsChanged(fn) {
    listeners.push(fn);
}

/* Stores the groups (an empty list removes the key) and tells listeners. False when storage refused. */
export function saveGroups(groups) {
    try {
        if (groups.length) {
            window.localStorage.setItem(STORE_KEY, encodeGroups(groups));
        } else {
            window.localStorage.removeItem(STORE_KEY);
        }
    } catch (e) {
        log('quick tag groups: storage refused', e);
        return false;
    }

    listeners.forEach(function (fn) {
        try { fn(); } catch (err) { log('quick tag listener failed', err); }
    });
    return true;
}

/* ---- suggested ("auto") groups: a pluggable source, and the viewer's choices about them ---- */

var sources = [];
var suggestedCache = {}; // parentId -> { at, groups, promise }
var SUGGEST_TTL = 60 * 1000;

/*
 * Plugs in a source of suggested groups: fn(parentId) -> Promise of [{ name, prefix } | { name, tags },
 * id?, kind? ]. Any number of sources; a source that throws or rejects contributes nothing. With none
 * registered (the default) there are no suggestions and everything behaves as the viewer's own groups only.
 */
export function registerGroupSource(fn) {
    if (typeof fn === 'function') {
        sources.push(fn);
        suggestedCache = {};
        listeners.forEach(function (l) { try { l(); } catch (e) { /* a listener must not break registration */ } });
    }
}

function scopeKey(parentId) {
    return parentId ? String(parentId) : '';
}

/* Suggested groups for a scope, synchronously: [] with no source, null while a source has not answered yet. */
export function suggestedNow(parentId) {
    if (!sources.length) {
        return [];
    }

    var e = suggestedCache[scopeKey(parentId)];
    return e && e.groups ? e.groups : null;
}

/* Promise of the suggested groups for a scope (cached for a minute). Never rejects. */
export function loadSuggested(parentId) {
    if (!sources.length) {
        return Promise.resolve([]);
    }

    var key = scopeKey(parentId);
    var e = suggestedCache[key];
    if (e && e.groups && Date.now() - e.at < SUGGEST_TTL) {
        return Promise.resolve(e.groups);
    }

    if (e && e.promise) {
        return e.promise;
    }

    var entry = { at: 0, groups: e ? e.groups : null, promise: null };
    entry.promise = Promise.all(sources.map(function (fn) {
        return Promise.resolve().then(function () { return fn(parentId || ''); }).then(function (r) { return r; }, function (err) {
            log('quick tag group source failed', err);
            return [];
        });
    })).then(function (lists) {
        entry.groups = parseSuggested([].concat.apply([], lists.map(function (l) { return Array.isArray(l) ? l : []; })));
        entry.at = Date.now();
        entry.promise = null;
        return entry.groups;
    });
    suggestedCache[key] = entry;
    return entry.promise;
}

export function autoPrefs() {
    try {
        return decodeAuto(window.localStorage.getItem(AUTO_KEY));
    } catch (e) {
        return decodeAuto(null);
    }
}

/* Stores the viewer's hide / rename choices (nothing to remember removes the key) and tells listeners. */
export function saveAutoPrefs(prefs) {
    try {
        var raw = encodeAuto(prefs);
        if (raw === null) {
            window.localStorage.removeItem(AUTO_KEY);
        } else {
            window.localStorage.setItem(AUTO_KEY, raw);
        }
    } catch (e) {
        log('quick tag auto prefs: storage refused', e);
        return false;
    }

    listeners.forEach(function (fn) {
        try { fn(); } catch (err) { log('quick tag listener failed', err); }
    });
    return true;
}

/*
 * What to show for a scope right now: { groups, ready, all }. `groups` is the viewer's own plus the
 * suggestions they have not hidden; `ready` is false while a source has yet to answer (the caller must
 * not prune picks against an incomplete list); `all` is every suggestion, hidden flagged, for the editor.
 */
export function groupsFor(parentId) {
    var user = groupsNow();
    var s = suggestedNow(parentId);
    if (s === null) {
        loadSuggested(parentId).then(function () {
            listeners.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
        });
        return { groups: user, ready: false, all: [] };
    }

    var m = mergeGroups(user, s, autoPrefs());
    return { groups: m.visible, ready: true, all: m.all };
}

/* Promise of the groups to show for a scope once every source has answered. */
export function loadVisible(parentId) {
    return loadSuggested(parentId).then(function () { return groupsFor(parentId).groups; });
}

/* The tag names already enumerated for a prefix group, or null while they are not (call resolveNames). */
export function namesNow(group) {
    if (group.tags.length) {
        return [];
    }

    var e = names[group.prefix];
    return e && e.tags && Date.now() - e.at < CACHE_TTL ? e.tags : null;
}

/* Promise of the tag names to filter into chips for a group: [] for a fixed group, never rejects. */
export function resolveNames(group) {
    if (group.tags.length || !group.prefix) {
        return Promise.resolve([]);
    }

    var hit = namesNow(group);
    if (hit) {
        return Promise.resolve(hit);
    }

    var e = names[group.prefix];
    if (e && e.promise) {
        return e.promise;
    }

    var entry = { at: 0, tags: null, promise: null };
    entry.promise = fetchTagWindow({ query: group.prefix, limit: PREFIX_LIMIT }).then(function (w) {
        entry.tags = w.tags;
        entry.at = Date.now();
        entry.promise = null;
        return entry.tags;
    }, function (err) {
        // Remembered as empty for 30 s, so a persistent failure is not retried on every page change.
        entry.tags = [];
        entry.at = Date.now() - CACHE_TTL + 30 * 1000;
        entry.promise = null;
        log('quick tag prefix list failed', err);
        return [];
    });
    if (Object.keys(names).length >= 50) {
        names = {};
    }

    names[group.prefix] = entry;
    return entry.promise;
}

/* The editor's tag picker: up to `limit` tag names containing `query` (server-side), never the whole list. */
export function searchTags(query, limit) {
    return fetchTagWindow({ query: query, limit: limit }).then(function (w) { return w; }, function (err) {
        log('quick tag search failed', err);
        return { tags: [], total: 0 };
    });
}
