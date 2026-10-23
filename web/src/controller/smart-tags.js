import { log } from '../lib/log.js';
import { toGroups, withPrimary } from '../model/smart-tags.js';

/*
 * SMART TAG CATEGORIES, NETWORK PART. Fetches GET /JellyfinPlus/Tags/Categories?parentId=.. once per scope
 * (a library id, or '' for everything the viewer can see) and caches the answer for the page's lifetime,
 * ten minutes at most. Fail soft: a missing route, an old server or any error is an empty list, cached for a
 * minute so a page full of cards does not retry it once per card.
 *
 *   getSmartGroups(parentId)  -> Promise of quick tag group suggestions (model/quick-tags.js parseSuggested shape),
 *                                for controller/quick-tags.js registerGroupSource. Never rejects.
 *   getCategories(parentId)   -> Promise of the parsed categories, primary facet resolved. Never rejects.
 *   categoriesNow(parentId)   -> the cached categories, or null while not fetched yet (starts the fetch).
 */

var TTL_MS = 10 * 60 * 1000;
var FAIL_TTL_MS = 60 * 1000;
var cache = {}; // userId|scope ->{ at, ttl, list, promise }

function client() {
    var c = window.ApiClient;
    return c && typeof c.getUrl === 'function' && typeof c.ajax === 'function' ? c : null;
}

function userId() {
    try {
        var c = window.ApiClient;
        return c && typeof c.getCurrentUserId === 'function' ? String(c.getCurrentUserId() || '') : '';
    } catch (e) {
        return '';
    }
}

/* The cache key: the user too, so a user switch without a page reload never shows the previous user's answer. */
function keyOf(parentId) {
    return userId() + '|' + scopeOf(parentId);
}

function scopeOf(parentId) {
    return typeof parentId === 'string' && /^[0-9a-fA-F-]{32,36}$/.test(parentId) ? parentId.replace(/-/g, '').toLowerCase() : '';
}

export function getCategories(parentId) {
    var key = keyOf(parentId);
    var e = cache[key];
    if (e && !e.promise && Date.now() - e.at < e.ttl) {
        return Promise.resolve(e.list);
    }

    // Stale-while-revalidate: past the TTL the old list stays in use while the refetch runs.
    if (e && e.promise) {
        return e.list ? Promise.resolve(e.list) : e.promise;
    }

    var c = client();
    if (!c) {
        return Promise.resolve(e && e.list ? e.list : withPrimary([]));
    }

    var scope = scopeOf(parentId);
    var entry = { at: 0, ttl: TTL_MS, list: e ? e.list : null, promise: null };
    cache[key] = entry;
    var params = scope ? { parentId: scope } : {};
    entry.promise = Promise.resolve(c.ajax({ type: 'GET', url: c.getUrl('JellyfinPlus/Tags/Categories', params), dataType: 'json' }))
        .then(function (body) {
            return withPrimary(body);
        }, function (err) {
            log('smart tags: categories unavailable', err);
            entry.ttl = FAIL_TTL_MS;
            return entry.list || withPrimary([]);
        })
        .then(function (list) {
            entry.list = list;
            entry.at = Date.now();
            entry.promise = null;
            return list;
        });
    return entry.list && e ? Promise.resolve(entry.list) : entry.promise;
}

export function categoriesNow(parentId) {
    var e = cache[keyOf(parentId)];
    if (e && e.list) {
        if (!e.promise && Date.now() - e.at >= e.ttl) {
            getCategories(parentId);
        }

        return e.list;
    }

    getCategories(parentId);
    return null;
}

export function getSmartGroups(parentId) {
    return getCategories(parentId).then(toGroups, function () { return []; });
}
