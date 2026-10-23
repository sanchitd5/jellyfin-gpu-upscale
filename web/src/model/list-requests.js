import { parts } from './search-census.js';

/*
 * REQUEST REWRITES FOR LIBRARY LIST PAGES (pure; controller/list-requests.js does the wiring).
 *
 * Three small fixes, all done by editing the query string of the page's own /Items request on its
 * way out (token by token, so everything else is byte-for-byte what the client built; a URL that
 * matches nothing comes back as the very same string):
 *
 *  1. SEEDED RANDOM (QOL 11). "Random" + paging re-rolls on every page in stock (the server sorts by
 *     random() per query), so page 2 repeats page 1's items. A list-page request that sorts by Random
 *     gets `jpListSeed=<n>`, and the server (ListSortPatches.cs) then orders by a fixed function of
 *     (item id, n). The seed is remembered per "same list" (the URL minus startIndex / limit), so
 *     every page of one list is one shuffle; a different list, filter or sort direction is its own
 *     shuffle; a page reload or the Shuffle button reshuffles. Requests that are NOT list pages are
 *     left alone and stay truly random: a search (it has searchTerm / jpSeed of its own), the
 *     playback queue (it asks for Chapters), anything without startIndex + limit (home rows,
 *     screensavers) and anything that opted out of the total count.
 *
 *  2. RECENTLY EDITED (QOL 10). The server's sort enum has no DateLastSaved and silently drops a
 *     sortBy name it does not know, so the sort menu entry's value `DateLastSaved` is sent as the
 *     placeholder `DateLastContentAdded` plus `jpSortKey=DateLastSaved`. The server patch swaps the
 *     key; a server without it just orders by name (the placeholder is empty on a Video).
 *
 *  3. FAVOURITES (QOL 43). The Favourites page asks for 20 items per section (Limit=20, no total
 *     count, a signature nothing else sends). That becomes FAV_LIMIT. Not on TV layouts.
 */

export var SEED_PARAM = 'jpListSeed';
export var SORT_KEY_PARAM = 'jpSortKey';
// The sort value the menus use, and the stock sort the server is asked for in its place.
export var RECENT_SORT = 'DateLastSaved';
export var RECENT_PLACEHOLDER = 'DateLastContentAdded';
// Items per Favourites section: a scrolling row, so more only costs cards that are never scrolled to.
export var FAV_LIMIT = 100;
var STOCK_FAV_LIMIT = '20';

/* A repeated request for one list (same filters, same sort), whichever page, shares a shuffle. */
var NOT_PART_OF_THE_LIST = { startindex: 1, limit: 1, jplistseed: 1, enabletotalrecordcount: 1 };

function decode(s) {
    try {
        return decodeURIComponent(s.replace(/\+/g, ' '));
    } catch (e) {
        return s;
    }
}

function first(q, name) {
    return q[name] && q[name].length ? q[name][0] : undefined;
}

/* The comma-separated values of every occurrence of a parameter, flattened. */
function listOf(q, name) {
    var out = [];
    (q[name] || []).forEach(function (v) {
        v.split(',').forEach(function (p) {
            p = p.trim();
            if (p) { out.push(p); }
        });
    });
    return out;
}

function has(list, value) {
    var v = value.toLowerCase();
    return list.some(function (x) { return x.toLowerCase() === v; });
}

/* { head: 'url up to and including ?', tokens: [...], tail: '#...' or '' } or null without a query. */
function split(url) {
    var qi = url.indexOf('?');
    if (qi < 0) {
        return null;
    }

    var hash = url.indexOf('#');
    var end = hash >= 0 ? hash : url.length;
    return { head: url.slice(0, qi + 1), tokens: url.slice(qi + 1, end).split('&'), tail: url.slice(end) };
}

function join(u) {
    return u.head + u.tokens.join('&') + u.tail;
}

function nameOf(token) {
    var eq = token.indexOf('=');
    return decode(eq < 0 ? token : token.slice(0, eq)).toLowerCase();
}

var ITEMS_PATH = /\/items$/;
var OTHER_LIST_PATH = /\/(artists|persons|studios)$/;

/* ---- 2. recently edited ---- */

function recentSort(p, u) {
    if (!ITEMS_PATH.test(p.path) || !has(listOf(p.q, 'sortby'), RECENT_SORT)) {
        return false;
    }

    u.tokens = u.tokens.map(function (t) {
        var eq = t.indexOf('=');
        if (eq < 0 || nameOf(t) !== 'sortby') {
            return t;
        }

        var values = decode(t.slice(eq + 1)).split(',').map(function (v) {
            return v.trim().toLowerCase() === RECENT_SORT.toLowerCase() ? RECENT_PLACEHOLDER : v.trim();
        });
        return t.slice(0, eq + 1) + values.join(',');
    });
    if (!has(listOf(p.q, SORT_KEY_PARAM.toLowerCase()), RECENT_SORT)) {
        u.tokens.push(SORT_KEY_PARAM + '=' + RECENT_SORT);
    }

    return true;
}

/* ---- 1. seeded random ---- */

/* The one list this request is a page of, as a string; same list gives the same string. */
export function listSignature(p) {
    var names = Object.keys(p.q).filter(function (n) { return !NOT_PART_OF_THE_LIST[n]; }).sort();
    return p.path + '?' + names.map(function (n) {
        return n + '=' + p.q[n].slice().sort().join('|');
    }).join('&');
}

/* A list page that is sorted at random and asks for one page of it. */
export function wantsSeed(p) {
    if (!ITEMS_PATH.test(p.path) || !has(listOf(p.q, 'sortby'), 'Random')) {
        return false;
    }

    if (p.q.jplistseed || p.q.jpseed || p.q.searchterm || p.q.ids) {
        return false;
    }

    if (first(p.q, 'enabletotalrecordcount') === 'false' || first(p.q, 'startindex') === undefined) {
        return false;
    }

    var limit = parseInt(first(p.q, 'limit'), 10);
    if (!(limit > 0)) {
        return false;
    }

    // The playback queue (Play all / Shuffle) is the one request here that is MEANT to re-roll.
    return !has(listOf(p.q, 'fields'), 'Chapters');
}

function seeded(p, u, opts) {
    if (!opts || typeof opts.seedFor !== 'function' || !wantsSeed(p)) {
        return false;
    }

    var seed = opts.seedFor(listSignature(p));
    if (!(seed > 0)) {
        return false;
    }

    u.tokens.push(SEED_PARAM + '=' + seed);
    return true;
}

/* ---- 3. favourites ---- */

/* The Favourites page's per-section request: nothing else sends this combination. */
export function isFavouritesSection(p) {
    var q = p.q;
    var sections = ITEMS_PATH.test(p.path) || OTHER_LIST_PATH.test(p.path);
    if (!sections || first(q, 'limit') !== STOCK_FAV_LIMIT || first(q, 'enabletotalrecordcount') !== 'false'
        || q.startindex || q.searchterm) {
        return false;
    }

    if (/\/studios$/.test(p.path)) {
        return first(q, 'isfavorite') === 'true';
    }

    return has(listOf(q, 'filters'), 'IsFavorite')
        && first(q, 'collapseboxsetitems') === 'false'
        && has(listOf(q, 'excludelocationtypes'), 'Virtual')
        && listOf(q, 'sortby').join(',').toLowerCase() === 'seriessortname,sortname';
}

function favourites(p, u, opts) {
    if ((opts && opts.tv) || !isFavouritesSection(p)) {
        return false;
    }

    u.tokens = u.tokens.map(function (t) {
        return nameOf(t) === 'limit' ? t.slice(0, t.indexOf('=') + 1) + FAV_LIMIT : t;
    });
    return true;
}

/*
 * The url to send. opts: { seedFor(signature) -> positive int, tv: bool }. Returns `url` itself
 * when nothing applies. Never throws on a string.
 */
export function rewriteListUrl(url, opts) {
    if (typeof url !== 'string') {
        return url;
    }

    var u = split(url);
    if (!u) {
        return url;
    }

    var p = parts(url);
    var changed = recentSort(p, u);
    changed = seeded(p, u, opts) || changed;
    changed = favourites(p, u, opts) || changed;
    return changed ? join(u) : url;
}

/* ---- the seed store ---- */

/* One seed per list signature, kept for the life of the page; reset() reshuffles every list. */
export function createSeeds(random) {
    var rand = typeof random === 'function' ? random : Math.random;
    var map = Object.create(null);
    return {
        seedFor: function (signature) {
            if (!map[signature]) {
                map[signature] = 1 + Math.floor(rand() * 2147483647);
            }

            return map[signature];
        },
        reset: function () {
            map = Object.create(null);
        }
    };
}
