/*
 * THE SEARCH PAGE'S PAGING, AS PURE FUNCTIONS. No DOM here, so it runs under node
 * (search-paging.test.mjs) exactly as it runs in the browser.
 *
 * jellyfin-web 12.1's search page sends two /Items queries that carry results:
 *
 *   'video'  mediaTypes=Video, limit=100: the Videos section.
 *   'all'    includeItemTypes=<many>, limit=800: ONE request that the page then splits into the
 *            Movies / Shows / Episodes / ... sections client-side by item Type.
 *
 * They are paged independently (a flag per kind below). The 'all' query is one unit: a page is the
 * next slice of the relevance-ranked mix, so a page boundary can fall inside a section and a later
 * page can bring more of a section that already showed on the first. The view labels it that way.
 *
 * WIRE CONTRACT with the server half (src/patcher/SearchSortPatches.cs): a paged request carries
 *   startIndex, limit            stock; the slice
 *   enableTotalRecordCount=true  stock; ask for the total
 *   jpPaged=true                 ours; the candidate pool is widened to cover startIndex + limit
 * and the response's TotalRecordCount is the size of the (possibly capped) widened pool.
 */

export var STORE_KEY = 'jellyfinPlus.searchPageSize';

// Page-size choices per kind. The defaults are the page's own stock limits, so an untouched page
// looks and costs what it always did.
export var SIZES = { video: [50, 100, 200], all: [200, 400, 800] };
export var DEFAULT_SIZES = { video: 100, all: 800 };

export var KINDS = ['video', 'all'];

/*
 * PAGED vs INFINITE. Paged shows the pager under the grid. Infinite (the default on a phone, i.e.
 * html.layout-mobile) fetches the next slice as the viewer nears the bottom and appends it. An
 * infinite slice is small, since it is only the first screenfuls plus whatever is scrolled to.
 */
export var MODE_KEY = 'jellyfinPlus.searchPaging';
export var INF_SIZES = { video: 50, all: 200 };
// Cards per virtualised chunk: divisible by 2, 3, 4 and 6 columns, so a chunk is whole rows on a
// phone (2 columns) and on most window widths.
export var CHUNK = 12;

/* 'paged' | 'infinite' | null (null = never chosen: the layout decides). */
export function normalizeMode(v) {
    return v === 'paged' || v === 'infinite' ? v : null;
}

export function loadMode() {
    try {
        return normalizeMode(window.localStorage && window.localStorage.getItem(MODE_KEY));
    } catch (e) {
        return null;
    }
}

export function saveMode(mode) {
    try {
        window.localStorage.setItem(MODE_KEY, normalizeMode(mode) || '');
    } catch (e) { /* storage refused: the choice still holds for this page view */ }
}

/* Splits a list into runs of at most n. */
export function chunkItems(list, n) {
    var out = [];
    for (var i = 0; i < list.length; i += n) {
        out.push(list.slice(i, i + n));
    }

    return out;
}

// English fallbacks for a section jellyfin-web has not drawn yet (a type that only appears on a
// later page). Sections jellyfin-web already drew keep their own translated title.
var TYPE_TITLES = {
    Movie: 'Movies', Series: 'Shows', Episode: 'Episodes', Playlist: 'Playlists', MusicAlbum: 'Albums',
    Audio: 'Songs', TvChannel: 'Channels', PhotoAlbum: 'Photo albums', Photo: 'Photos',
    AudioBook: 'Audiobooks', Book: 'Books', BoxSet: 'Collections'
};

export function typeTitle(type) {
    return TYPE_TITLES[type] || String(type || 'Other');
}

/* The card shape for a section that has no card to read it from yet (jellyfin's own would be median-aspect). */
export function shapeForType(type) {
    if (type === 'Movie' || type === 'Series' || type === 'BoxSet' || type === 'Book') {
        return 'overflowPortrait';
    }

    if (type === 'Episode' || type === 'Video') {
        return 'overflowBackdrop';
    }

    return 'overflowSquare';
}

/*
 * The cardBuilder options jellyfin-web's own search page gives a section (utils/search.ts
 * getCardOptionsFromType, plus SearchResults.tsx's common ones), so an appended card is the same
 * card. `shape` is read off the cards already in the section by the caller.
 */
export function cardOptionsFor(kind, type, shape) {
    var o = {
        shape: shape, scalable: true, showTitle: true, overlayText: false, centerText: true,
        allowBottomPadding: false
    };
    if (kind === 'video') {
        o.showParentTitle = true;
    } else if (type === 'Movie' || type === 'Series' || type === 'MusicAlbum') {
        o.showYear = true;
    } else if (type === 'Episode') {
        o.coverImage = true;
        o.showParentTitle = true;
    } else if (type === 'MusicArtist') {
        o.coverImage = true;
    } else if (type === 'Audio') {
        o.showParentTitle = true;
    }

    return o;
}

var IS_ITEMS = /\/items$/i;
var HAS_TERM = /[?&]searchterm=[^&]/i;
var IS_VIDEO_QUERY = /[?&]mediatypes=video(&|$|,)/i;
var HAS_INCLUDE = /[?&]includeitemtypes=/i;

// Every parameter this module writes: removed first so a value is never doubled.
var OWNED = ['startindex', 'limit', 'enabletotalrecordcount', 'jppaged'];

function paramOf(url, name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)', 'i').exec(url);
    if (!m) {
        return null;
    }

    try {
        return decodeURIComponent(m[1].replace(/\+/g, ' '));
    } catch (e) {
        return m[1];
    }
}

function keyOf(piece) {
    var eq = piece.indexOf('=');
    try {
        return decodeURIComponent(eq === -1 ? piece : piece.slice(0, eq)).toLowerCase();
    } catch (e) {
        return piece.toLowerCase();
    }
}

/*
 * Which of the page's two result queries a URL is, or null for anything else.
 *   { kind: 'video' | 'all', discard: false }
 *   { kind, discard: true }  the Sort & filter Type steering cut it to a one-item request whose
 *                            result the page throws away; it must be left alone.
 */
export function kindOf(url) {
    if (typeof url !== 'string' || url.indexOf('?') === -1 || !IS_ITEMS.test(url.split('?')[0])
        || !HAS_TERM.test(url)) {
        return null;
    }

    var kind;
    if (IS_VIDEO_QUERY.test(url)) {
        kind = 'video';
    } else if (HAS_INCLUDE.test(url)) {
        kind = 'all';
    } else {
        return null;
    }

    var limit = parseInt(paramOf(url, 'limit'), 10);
    return { kind: kind, discard: limit === 1 };
}

export function searchTermOf(url) {
    return paramOf(url, 'searchterm') || '';
}

/* The size a stored/typed value means for this kind: one of SIZES[kind], else the default. */
export function normalizeSize(kind, v) {
    var n = Math.floor(Number(v));
    var list = SIZES[kind] || [];
    return list.indexOf(n) !== -1 ? n : DEFAULT_SIZES[kind];
}

export function defaultSizes() {
    return { video: DEFAULT_SIZES.video, all: DEFAULT_SIZES.all };
}

export function normalizeSizes(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    return { video: normalizeSize('video', r.video), all: normalizeSize('all', r.all) };
}

export function loadSizes() {
    try {
        var raw = window.localStorage && window.localStorage.getItem(STORE_KEY);
        return normalizeSizes(raw ? JSON.parse(raw) : null);
    } catch (e) {
        return defaultSizes();
    }
}

export function saveSizes(sizes) {
    try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(normalizeSizes(sizes)));
    } catch (e) { /* storage refused: the choice still holds for this page view */ }
}

/*
 * Applies page + size to one outgoing result request. Anything that is not a paging candidate,
 * and every discard request, comes back as the very same string.
 */
export function rewritePagedUrl(url, page, size) {
    var k = kindOf(url);
    if (!k || k.discard) {
        return url;
    }

    var p = Math.max(1, Math.floor(Number(page)) || 1);
    var s = Math.floor(Number(size));
    if (!(s > 0)) {
        return url;
    }

    var q = url.indexOf('?');
    var base = url.slice(0, q);
    var rest = url.slice(q + 1);
    var hash = '';
    var h = rest.indexOf('#');
    if (h !== -1) {
        hash = rest.slice(h);
        rest = rest.slice(0, h);
    }

    var kept = rest.split('&').filter(function (piece) {
        return piece !== '' && OWNED.indexOf(keyOf(piece)) === -1;
    });
    var add = [
        ['startIndex', String((p - 1) * s)],
        ['limit', String(s)],
        ['enableTotalRecordCount', 'true'],
        ['jpPaged', 'true']
    ];
    return base + '?' + kept.concat(add.map(function (kv) { return kv[0] + '=' + kv[1]; })).join('&') + hash;
}

/* The slice a (rewritten) request asked for: { start, size, page }, or null when it was not paged. */
export function pagingOf(url) {
    if (paramOf(url, 'jpPaged') !== 'true') {
        return null;
    }

    var start = parseInt(paramOf(url, 'startIndex'), 10);
    var size = parseInt(paramOf(url, 'limit'), 10);
    if (!(size > 0) || !(start >= 0)) {
        return null;
    }

    return { start: start, size: size, page: Math.floor(start / size) + 1 };
}

export function pageCount(total, size) {
    return Math.max(1, Math.ceil((total > 0 ? total : 0) / size));
}

/*
 * What a response means for the pager. `req` is pagingOf(url), `body` the parsed response.
 * Returns null when the response is not a list. The total never reads lower than what was seen, so
 * a server that ignores enableTotalRecordCount (a stock one answers with the page's own count)
 * degrades to "no more pages" rather than to a wrong "Page 1 of 0".
 */
export function summarize(req, body) {
    if (!req || !body || !Array.isArray(body.Items)) {
        return null;
    }

    var count = body.Items.length;
    var total = typeof body.TotalRecordCount === 'number' ? body.TotalRecordCount : 0;
    total = Math.max(total, req.start + count);
    var ids = {};
    body.Items.forEach(function (it) {
        if (it && it.Id) {
            ids[String(it.Id).toLowerCase()] = true;
        }
    });
    return {
        page: req.page, size: req.size, start: req.start, count: count, total: total,
        pages: pageCount(total, req.size), ids: ids
    };
}

/* Whether a pager is worth showing for this summary: more than one page, or not on the first. */
export function worthShowing(s) {
    return !!s && (s.total > s.size || s.page > 1);
}

/* Whether an infinite list has loaded everything: the last slice came back short, or reached the total. */
export function reachedEnd(loaded, size, total, lastCount) {
    return lastCount < size || loaded >= total;
}

/* "101-200 of 342". */
/*
 * The server's search candidate pool cap (SearchSortPatches.MaxPagedCandidates). A total equal to it
 * is a lower bound - "matches among the first N relevance candidates" - not an exact count, so it
 * is shown as "N+". Keep in step with the server constant.
 */
export var POOL_CAP = 5000;

export function totalText(total) {
    return total >= POOL_CAP ? POOL_CAP + '+' : String(total);
}

export function rangeText(s) {
    if (!s || s.count === 0) {
        return '0 of ' + totalText(s ? s.total : 0);
    }

    return (s.start + 1) + '-' + (s.start + s.count) + ' of ' + totalText(s.total);
}

/* The page to land on after an empty response past the end: the last one that can have items. */
export function pageAfterEmpty(s) {
    return Math.max(1, Math.min(s.page - 1, pageCount(s.total, s.size)));
}
