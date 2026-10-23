/*
 * RECENT SEARCHES (pure; controller/search-recent.js does the page wiring).
 *
 * A list of the terms the viewer submitted, newest first, in localStorage `jellyfinPlus.searchRecent`
 * as a JSON array of strings. Terms only: the exclude text and the Sort & filter state have their own
 * keys and are not part of a recent search. Storage is injectable, so this runs under node.
 */

export var STORE_KEY = 'jellyfinPlus.searchRecent';
export var MAX_RECENT = 12;
// A term longer than 200 characters is not worth keeping as a recent search.
export var MAX_TERM = 200;
var MIN_TERM = 2;

/* One term as it is stored: trimmed, inner whitespace collapsed, capped. '' when it is not worth keeping. */
export function cleanTerm(text) {
    if (typeof text !== 'string') {
        return '';
    }

    var t = text.replace(/\s+/g, ' ').trim();
    return t.length < MIN_TERM || t.length > MAX_TERM ? '' : t;
}

function sameTerm(a, b) {
    return a.toLowerCase() === b.toLowerCase();
}

/* Whatever was stored, as a clean list: strings only, de-duplicated (case-insensitive), capped. */
export function normalizeList(raw) {
    var out = [];
    if (!Array.isArray(raw)) {
        return out;
    }

    for (var i = 0; i < raw.length && out.length < MAX_RECENT; i++) {
        var t = cleanTerm(raw[i]);
        if (t && !out.some(function (x) { return sameTerm(x, t); })) {
            out.push(t);
        }
    }

    return out;
}

/* A new list with `text` first (a repeat moves up and takes the new spelling). Unusable text changes nothing. */
export function pushTerm(list, text) {
    var t = cleanTerm(text);
    if (!t) {
        return list;
    }

    return normalizeList([t].concat(list.filter(function (x) { return !sameTerm(x, t); })));
}

export function removeTerm(list, text) {
    return list.filter(function (x) { return !sameTerm(x, String(text)); });
}

export function loadRecent(storage) {
    try {
        var raw = storage && storage.getItem(STORE_KEY);
        return raw ? normalizeList(JSON.parse(raw)) : [];
    } catch (e) {
        return [];
    }
}

export function saveRecent(storage, list) {
    try {
        if (list.length) {
            storage.setItem(STORE_KEY, JSON.stringify(list));
        } else {
            storage.removeItem(STORE_KEY);
        }
    } catch (e) { /* storage refused: the list still works for this page view */ }
}

/* A change signature, so the view re-renders only when the list changed. */
export function listSig(list) {
    return list.join('\u0001');
}
