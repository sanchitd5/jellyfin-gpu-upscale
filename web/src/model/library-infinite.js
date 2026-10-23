import { parts } from './search-census.js';

/*
 * LIBRARY INFINITE SCROLL, THE PURE PART (controller/list-requests.js records the requests and
 * fetches, view/library-infinite.js draws; this decides which request is a library page, what the
 * next one is, which page the viewer is on, and the card options.)
 *
 * The library tabs ask for one page of /Items (StartIndex + Limit, total count on). Infinite scroll
 * keeps that stock request as page 1 and fetches the pages after it by rewriting ONLY the startIndex
 * of the very request the page sent (so sort, filters, tag markers and the Random seed ride along
 * unchanged), marked `jpInf=1` so nothing treats it as the page's own request.
 */

export var INF_PARAM = 'jpInf';
// Cards per `.jpChunk`: a whole number of rows at every common column count (2, 3, 4, 6).
export var CHUNK = 12;

var ITEMS_PATH = /\/items$/;

function first(q, name) {
    return q[name] && q[name].length ? q[name][0] : undefined;
}

function has(q, name, value) {
    var v = value.toLowerCase();
    var found = false;
    (q[name] || []).forEach(function (s) {
        s.split(',').forEach(function (p) {
            if (p.trim().toLowerCase() === v) { found = true; }
        });
    });
    return found;
}

/*
 * A library tab's page request: /Items with a window (startIndex + limit) and the total count on.
 * Not a search, not an id lookup, not the playback queue (it asks for Chapters), not one of our own
 * follow-ups, not the Favourites sections (no total count).
 */
export function isLibraryListUrl(url) {
    if (typeof url !== 'string') {
        return false;
    }

    var p = parts(url);
    if (!ITEMS_PATH.test(p.path) || p.q[INF_PARAM.toLowerCase()]) {
        return false;
    }

    if (p.q.searchterm || p.q.ids || has(p.q, 'fields', 'Chapters') || first(p.q, 'enabletotalrecordcount') === 'false') {
        return false;
    }

    var start = parseInt(first(p.q, 'startindex'), 10);
    var limit = parseInt(first(p.q, 'limit'), 10);
    return start >= 0 && limit > 0;
}

export function startOf(url) {
    return parseInt(first(parts(url).q, 'startindex'), 10) || 0;
}

export function limitOf(url) {
    return parseInt(first(parts(url).q, 'limit'), 10) || 0;
}

/* The same request for another window, marked as ours. Every other token is left byte-for-byte. */
export function nextUrl(url, start) {
    var hash = url.indexOf('#');
    var tail = hash >= 0 ? url.slice(hash) : '';
    var body = hash >= 0 ? url.slice(0, hash) : url;
    var qi = body.indexOf('?');
    var tokens = body.slice(qi + 1).split('&').filter(function (t) {
        var name = t.split('=')[0].toLowerCase();
        return name !== 'startindex' && name !== INF_PARAM.toLowerCase();
    });
    tokens.push('StartIndex=' + start, INF_PARAM + '=1');
    return body.slice(0, qi + 1) + tokens.join('&') + tail;
}

/* 1-based page number and page count for a window; the last page may be short. */
export function pageOf(start, limit) {
    return limit > 0 ? Math.floor(start / limit) + 1 : 1;
}

export function pageCount(total, limit) {
    return limit > 0 && total > 0 ? Math.ceil(total / limit) : 1;
}

/* Nothing left after this response? */
export function reachedEnd(start, limit, total, got) {
    return got < limit || start + got >= total;
}

/* "Page 3 of 12". */
export function pillText(page, pages) {
    return 'Page ' + page + ' of ' + pages;
}

/*
 * The page under the viewer. `pageTops` is [{ page, top }] in document order (top: the element's
 * top edge in viewport px) for the chunks past the stock page; `probe` is the line the viewer is
 * reading at. The last chunk whose top is at or above the line wins; above all of them, the page
 * the stock request showed.
 */
export function currentPage(basePage, pageTops, probe) {
    var page = basePage;
    for (var i = 0; i < pageTops.length; i++) {
        if (pageTops[i].top <= probe) {
            page = pageTops[i].page;
        } else {
            break;
        }
    }

    return page;
}

/*
 * cardBuilder options for an appended card: what ItemsView.getCardOptions (jellyfin-web 12.3) gives
 * the stock React cards, from the tab's saved view settings (`s`, the localStorage blob) and the
 * tab's viewType. `shape` is the one the stock cards already resolved to (read off the DOM by the
 * caller) so a chunk never mixes shapes with the page it extends; '' falls back to the setting.
 */
export function cardOptionsFor(viewType, s, context, shape) {
    s = s || {};
    var image = s.ImageType || 'Primary';
    var showTitle = s.ShowTitle !== false;
    var o = {
        shape: shape || 'auto',
        showTitle: showTitle,
        showYear: s.ShowYear !== false,
        cardLayout: !!s.CardLayout,
        centerText: true,
        context: context || undefined,
        coverImage: true,
        overlayText: !showTitle,
        imageType: image,
        scalable: true,
        allowBottomPadding: false
    };
    if (!shape) {
        if (image === 'Banner') {
            o.shape = 'banner';
        } else if (image === 'Disc') {
            o.shape = 'square';
        } else if (image === 'Logo' || image === 'Thumb') {
            o.shape = 'backdrop';
        }
    }

    if (image === 'Disc') { o.preferDisc = true; }
    if (image === 'Logo') { o.preferLogo = true; }
    if (image === 'Thumb') { o.preferThumb = true; }

    if (viewType === 'songs' || viewType === 'albums' || viewType === 'episodes') {
        o.showParentTitle = showTitle;
        o.overlayPlayButton = true;
    } else if (viewType === 'artists' || viewType === 'authors') {
        o.lines = 1;
        o.showYear = false;
        o.overlayPlayButton = true;
    } else if (viewType === 'movies') {
        o.overlayPlayButton = true;
    } else if (viewType === 'series' || viewType === 'studios') {
        o.overlayMoreButton = true;
    }

    return o;
}

/* Tabs this module will not take over: list mode draws rows, the rest are not item grids. */
export function supportsTab(viewType, settings) {
    if (!viewType || (settings && settings.ViewMode === 'list')) {
        return false;
    }

    return ['channels', 'seriestimers', 'songs'].indexOf(viewType) === -1;
}
