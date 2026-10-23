/*
 * "SELECT ALL N RESULTS", AS PURE FUNCTIONS (QOL_IDEAS #42). No DOM here, so it runs under node
 * (select-all.test.mjs) exactly as it runs in the browser.
 *
 * Stock multi-select only ticks the cards that are drawn. The list a viewer is looking at is one
 * /Items query; controller/select-all.js remembers the recent ones (a "group" = the query without its
 * paging) with the ids each page brought, and when a selection is made it finds the group that holds
 * every ticked id, then re-asks that same query page by page for ids alone. Nothing about the query is
 * rebuilt by hand: it is the request the page itself sent (final url, filters, exclusions and all),
 * with only the paging, the payload size and - for an unseeded Random sort - the sort changed.
 */

// Largest selection offered. Tag edits run 3 at a time with three requests per item.
export var MAX_IDS = 5000;
export var PAGE = 200;
export var MAX_GROUPS = 12;
export var MAX_GROUP_IDS = 20000;

// Paging and payload parameters: not part of what makes two requests "the same list".
var NOT_IDENTITY = {
    startindex: 1, limit: 1, enabletotalrecordcount: 1, jpinf: 1, jppaged: 1,
    fields: 1, enableimages: 1, enableuserdata: 1, enableimagetypes: 1, imagetypelimit: 1
};

// Parameters set by idsPageUrl itself.
var OWNED = ['startindex', 'limit', 'enabletotalrecordcount', 'fields', 'enableimages', 'enableuserdata',
    'enableimagetypes', 'imagetypelimit', 'jpinf'];

function keyOf(piece) {
    var eq = piece.indexOf('=');
    var name = eq === -1 ? piece : piece.slice(0, eq);
    try {
        return decodeURIComponent(name.replace(/\+/g, ' ')).toLowerCase();
    } catch (e) {
        return name.toLowerCase();
    }
}

function valueOf(piece) {
    var eq = piece.indexOf('=');
    if (eq === -1) {
        return '';
    }

    try {
        return decodeURIComponent(piece.slice(eq + 1).replace(/\+/g, ' '));
    } catch (e) {
        return piece.slice(eq + 1);
    }
}

function split(url) {
    var u = String(url);
    var hash = '';
    var h = u.indexOf('#');
    if (h !== -1) {
        hash = u.slice(h);
        u = u.slice(0, h);
    }

    var q = u.indexOf('?');
    return {
        base: q === -1 ? u : u.slice(0, q),
        pieces: q === -1 ? [] : u.slice(q + 1).split('&').filter(function (p) { return p !== ''; }),
        hash: hash
    };
}

function paramOf(parts, name) {
    for (var i = 0; i < parts.pieces.length; i++) {
        if (keyOf(parts.pieces[i]) === name) {
            return valueOf(parts.pieces[i]);
        }
    }

    return null;
}

/* The id format of the DOM (data-id) and of the API: 32 hex, lower case. */
export function normId(id) {
    return String(id || '').replace(/-/g, '').toLowerCase();
}

/*
 * Whether a request is a list query worth remembering: GET .../Items with a real page size, and no
 * explicit id list (those are lookups, such as the favourite and badge ones, not lists).
 */
export function isListUrl(url) {
    if (typeof url !== 'string') {
        return false;
    }

    var p = split(url);
    if (!/\/Items$/i.test(p.base)) {
        return false;
    }

    if (paramOf(p, 'ids') !== null || paramOf(p, 'jptaglimit') !== null) {
        return false;
    }

    var limit = paramOf(p, 'limit');
    return limit === null || Number(limit) >= 2;
}

/* True for a request made by idsPageUrl: such a request must not be recorded as a list page. */
export function isIdsPageUrl(url) {
    var p = split(url);
    return paramOf(p, 'jpinf') === '1' && paramOf(p, 'enableimages') === 'false'
        && paramOf(p, 'enableuserdata') === 'false';
}

/* A stable identity for the list a request belongs to: path and every parameter but the paging. */
export function groupKey(url) {
    var p = split(url);
    var kept = p.pieces.filter(function (piece) { return !NOT_IDENTITY[keyOf(piece)]; });
    kept.sort();
    return p.base + '?' + kept.join('&');
}

/*
 * The same list as `url`, asking for ids only: page [start, start + limit), no images, no user data,
 * no extra fields. `jpInf=1` marks it as ours so the search page's own rewrite and response watchers
 * leave it alone, exactly as search-pager's fetchMore does. A Random sort with no `jpSeed` would
 * reshuffle between pages and drop or repeat items, so it becomes SortName (the SET of results is the
 * same; only the order differs); a seeded one is stable and is kept.
 */
export function idsPageUrl(url, start, limit) {
    var p = split(url);
    var seeded = paramOf(p, 'jpseed') !== null;
    var kept = p.pieces.filter(function (piece) { return OWNED.indexOf(keyOf(piece)) === -1; });
    kept = kept.map(function (piece) {
        if (keyOf(piece) === 'sortby' && !seeded && /random/i.test(valueOf(piece))) {
            return piece.slice(0, piece.indexOf('=') + 1) + 'SortName';
        }

        return piece;
    });
    var add = [
        'startIndex=' + Math.max(0, Math.floor(start)),
        'limit=' + Math.max(1, Math.floor(limit)),
        'enableTotalRecordCount=false',
        'enableImages=false',
        'enableUserData=false',
        'jpInf=1'
    ];
    return p.base + '?' + kept.concat(add).join('&') + p.hash;
}

/*
 * Records one list response. `groups` is a Map(key -> { key, url, ids: Set, total, touched }), kept
 * to MAX_GROUPS by dropping the least recently touched. Returns the group.
 */
export function noteResponse(groups, url, items, total, now) {
    var key = groupKey(url);
    var g = groups.get(key);
    if (!g) {
        g = { key: key, url: url, ids: new Set(), total: 0, touched: 0 };
    }

    // Re-insert so Map iteration order is least- to most-recently touched.
    groups.delete(key);
    groups.set(key, g);
    g.url = url;
    g.touched = now;
    (items || []).forEach(function (it) {
        if (it && it.Id && g.ids.size < MAX_GROUP_IDS) {
            g.ids.add(normId(it.Id));
        }
    });
    // A response without a count (enableTotalRecordCount=false) says 0: that is not the list's size.
    if (typeof total === 'number' && total > 0) {
        g.total = total;
    }

    while (groups.size > MAX_GROUPS) {
        groups.delete(groups.keys().next().value);
    }

    return g;
}

/* The most recently touched group that holds every one of `ids` (and at least one id), or null. */
export function pickGroup(groups, ids) {
    var want = (ids || []).map(normId).filter(Boolean);
    if (!want.length) {
        return null;
    }

    var best = null;
    groups.forEach(function (g) {
        if (want.every(function (id) { return g.ids.has(id); }) && (!best || g.touched >= best.touched)) {
            best = g;
        }
    });
    return best;
}

/* "1,234". */
export function countText(n) {
    return String(Math.max(0, Math.floor(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/* The row label, or '' when a selection should not be offered (nothing beyond what is ticked). */
export function offerLabel(group, tickedCount) {
    if (!group || !(group.total > tickedCount)) {
        return '';
    }

    return 'Select all ' + countText(group.total) + ' results';
}

/*
 * Page starts to fetch to cover `total` items. [] when total is over MAX_IDS: a partial selection
 * presented as "all" would be worse than none.
 */
export function pageStarts(total, size) {
    var n = Math.floor(Number(total));
    var s = Math.floor(Number(size)) || PAGE;
    if (!(n > 0) || n > MAX_IDS) {
        return [];
    }

    var out = [];
    for (var i = 0; i < n; i += s) {
        out.push(i);
    }

    return out;
}
