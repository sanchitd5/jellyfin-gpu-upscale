import { log } from '../lib/log.js';
import {
    kindOf, searchTermOf, rewritePagedUrl, pagingOf, summarize, pageAfterEmpty, pageCount,
    loadSizes, saveSizes, normalizeSize, KINDS, SIZES, INF_SIZES, loadMode, saveMode, normalizeMode,
    reachedEnd
} from '../model/search-paging.js';
import { getQueryClient, excludeText } from './search-exclude.js';
import { onFiltersChanged, searchParentId } from './search-filters.js';

/*
 * THE SEARCH PAGE'S PAGING, CONTROLLER SIDE (view/search-pager.js is the DOM side, model/
 * search-paging.js the pure part and the wire contract).
 *
 *  - markSearchPaging() is called from the fetch/XHR hooks in network.js, last in the chain after
 *    the exclude box and Sort & filter: it rewrites the page's two result queries (Videos, and the
 *    all-types one) to carry the page the viewer is on. The Sort & filter Type steering turns a
 *    query it wants discarded into a one-item request; those are left alone.
 *  - watchPagedXhr()/watchPagedFetch() read the response (items + TotalRecordCount), which is what
 *    the pager shows. The page displays what was actually fetched (`stats`), never what was merely
 *    asked for (`want`), so React Query serving a cached page can never put the label out of step.
 *  - goTo()/setSize() change `want` and re-run the queries. The React Query keys do not include the
 *    paging parameters, the same constraint as the sheet and the exclude box, so the re-run is a
 *    targeted version of search-exclude.js's two-phase refetch (see refetchKind()).
 *
 * Page state resets to page 1 on a new search term, library scope or exclude text (noticed on the
 * request itself, see markSearchPaging) and on every Sort & filter commit (a listener). It is not
 * kept in the URL: Back/Forward and reload start from page 1.
 *
 * INFINITE MODE (the phone default, a toggle on the results). React's own two queries then ask for
 * a small first slice (INF_SIZES) and stay on page 1 for good; everything after it is fetched here
 * by fetchMore(), kept in `inf[kind].items` (our own cache, in order, de-duplicated) and drawn by
 * view/search-infinite.js. fetchMore() rebuilds nothing by hand: it takes the LAST url React's
 * query went out with - already carrying sort, filters, exclude and jpSeed from the markers - and
 * changes only startIndex/limit, then sends it with `jpInf=1` so markSearchPaging and the response
 * watchers leave it alone. A new term, a Sort & filter commit, an exclude change, a mode switch or
 * a different first slice from the server (React replaced the cards, wiping what was appended)
 * resets the cache and starts over from the first slice; the view redraws from the cache whenever
 * the DOM it appended to was thrown away but the data is still current (navigating back).
 */

var sizes = loadSizes();
var mode = loadMode();
var want = { video: 1, all: 1 };
var stats = { video: null, all: null };
var pending = { video: false, all: false };
var userNav = { video: false, all: false };
var lastUrl = { video: null, all: null };
var inf = { video: freshInf(), all: freshInf() };
var lastKey = null;
var listeners = [];
var generation = 0;

function freshInf() {
    return { epoch: 0, items: [], seen: {}, loadedPages: 1, loading: false, done: false, error: false, baseSig: '' };
}

function resetInf(kind) {
    var st = inf[kind];
    var epoch = st.epoch + 1;
    var fresh = freshInf();
    Object.keys(fresh).forEach(function (k) { st[k] = fresh[k]; });
    st.epoch = epoch;
}

function resetAll() {
    want = { video: 1, all: 1 };
    KINDS.forEach(resetInf);
}

/* Infinite when chosen; when never chosen, on a phone layout. */
export function isInfinite() {
    return mode ? mode === 'infinite' : document.documentElement.classList.contains('layout-mobile');
}

function sizeOf(kind) {
    return isInfinite() ? INF_SIZES[kind] : sizes[kind];
}

/* The infinite state for a kind: { epoch, items, loading, done, error }. Read-only for the view. */
export function infOf(kind) {
    return inf[kind];
}

// Our own follow-up requests (fetchMore) carry this; the marker and the watchers skip them.
var OWN = /[?&]jpInf=1(&|$)/;

function isTv() {
    return document.documentElement.classList.contains('layout-tv');
}

function onSearchPage() {
    return /^#\/search(\?|$)/.test(window.location.hash || '');
}

function changed() {
    listeners.forEach(function (fn) {
        try {
            fn();
        } catch (err) {
            log('search pager listener failed', err);
        }
    });
}

export function onPagerChanged(fn) {
    listeners.push(fn);
}

onFiltersChanged(resetAll);

/* Appended last in network.js's markSearch chain. Anything that is not a result query is returned as is. */
export function markSearchPaging(url) {
    if (typeof url !== 'string' || !onSearchPage() || isTv() || OWN.test(url)) {
        return url;
    }

    var k = kindOf(url);
    if (!k) {
        return url;
    }

    if (k.discard) {
        // The page throws this result away; the section it fed is not there any more.
        if (stats[k.kind]) {
            stats[k.kind] = null;
            changed();
        }

        return url;
    }

    var key = [searchTermOf(url), searchParentId(), excludeText()].join('\u0001');
    if (key !== lastKey) {
        if (lastKey !== null) {
            resetAll();
        }

        lastKey = key;
    }

    var out = rewritePagedUrl(url, want[k.kind], sizeOf(k.kind));
    // What fetchMore() continues from: this very request, filters and exclusion included.
    lastUrl[k.kind] = out;
    if (out !== url) {
        log('markSearchPaging: ' + url + ' -> ' + out);
    }

    return out;
}

function note(url, body) {
    var k = kindOf(url);
    var req = pagingOf(url);
    var s = k && !k.discard ? summarize(req, body) : null;
    if (!s) {
        return;
    }

    stats[k.kind] = s;
    log('search pager: ' + k.kind + ' page ' + s.page + ' of ' + s.pages + ' (' + s.total + ' total)');

    if (isInfinite() && s.start === 0) {
        // A first slice that differs from the one the cache was built on means React replaced the
        // cards (new results), so whatever was appended to the old ones is stale.
        var st = inf[k.kind];
        var sig = Object.keys(s.ids).sort().join(',');
        if (sig !== st.baseSig) {
            resetInf(k.kind);
            st.baseSig = sig;
            Object.keys(s.ids).forEach(function (id) { st.seen[id] = true; });
            st.done = reachedEnd(s.count, s.size, s.total, s.count);
        }
    }

    // A page past the end (results shrank) is empty, and an empty page shows no section, so no
    // pager either: step back on our own rather than strand the viewer.
    if (s.count === 0 && s.page > 1 && want[k.kind] === s.page) {
        want[k.kind] = pageAfterEmpty(s);
        refetchKind(k.kind);
    }

    changed();
}

/* Hooked from network.js's XHR open(), with the final url. The search page's requests are axios, i.e. XHR. */
export function watchPagedXhr(xhr, url) {
    try {
        var k = kindOf(url);
        if (!k || k.discard || !pagingOf(url) || OWN.test(url)) {
            return;
        }

        xhr.addEventListener('load', function () {
            try {
                var body;
                if (xhr.responseType === 'json') {
                    body = xhr.response;
                } else if (xhr.responseType === '' || xhr.responseType === 'text') {
                    body = JSON.parse(xhr.responseText);
                }

                note(url, body);
            } catch (err) {
                log('search pager: could not read the response', err);
            }
        });
    } catch (err) {
        log('search pager: could not watch the request', err);
    }
}

/* The same for fetch: a side branch off the promise, which is returned to the caller untouched. */
export function watchPagedFetch(url, promise) {
    try {
        var k = kindOf(url);
        if (!k || k.discard || !pagingOf(url) || OWN.test(url)) {
            return;
        }

        promise.then(function (res) {
            return res.clone().json().then(function (body) { note(url, body); });
        }).catch(function () { /* a failed search is the page's to show */ });
    } catch (err) {
        log('search pager: could not watch the fetch', err);
    }
}

function isSectionsQuery(q) {
    return q.queryKey && q.queryKey[0] === 'Search' && q.queryKey[1] === 'Items';
}

/*
 * Re-runs what a page change needs, in the order search-exclude.js's refetchSearch explains: the
 * ['Search','Items'] query builds its sections from the OTHER queries' data as captured by the last
 * render, so a Videos change refetches the Video query first, lets React commit, and only then
 * refetches Items (which also carries the all-types request). An all-types change needs Items only.
 * Hence this is not refetchSearch(): that would re-send the artists/people/studios queries too.
 */
function refetchKind(kind) {
    var qc = getQueryClient();
    if (!qc) {
        log('search pager: no React Query client found; the page changes on the next search');
        pending[kind] = false;
        return;
    }

    var gen = ++generation;
    pending[kind] = true;
    changed();

    var first = kind === 'video'
        ? qc.invalidateQueries({
            predicate: function (q) { return q.queryKey && q.queryKey[0] === 'Search' && q.queryKey[1] === 'Video'; }
        })
        : undefined;

    Promise.resolve(first)
        .catch(function (err) { log('search pager: phase 1 failed', err); })
        .then(function () {
            return new Promise(function (resolve) {
                requestAnimationFrame(function () { requestAnimationFrame(resolve); });
            });
        })
        .then(function () {
            return gen === generation ? qc.invalidateQueries({ predicate: isSectionsQuery }) : undefined;
        })
        .catch(function (err) { log('search pager: phase 2 failed', err); })
        .then(function () {
            pending[kind] = false;
            changed();
        });
}

/* ---- what the view reads and does ---- */

/* The pager's numbers for a kind, or null while nothing has been fetched for it. */
export function pagerOf(kind) {
    var s = stats[kind];
    if (!s) {
        return null;
    }

    return {
        page: s.page, size: s.size, total: s.total, pages: s.pages, start: s.start, count: s.count,
        sizes: SIZES[kind], busy: pending[kind]
    };
}

/* Whether this item id is on the page the kind last fetched (that is how the view finds sections). */
export function hasItem(kind, id) {
    var key = String(id).toLowerCase();
    return !!((stats[kind] && stats[kind].ids[key]) || inf[kind].seen[key]);
}

/* True once, right after the viewer changed the page, so the view scrolls to the top of the section. */
export function takeUserNav(kind) {
    var v = userNav[kind];
    userNav[kind] = false;
    return v;
}

export function goTo(kind, page) {
    var s = stats[kind];
    if (!s || pending[kind]) {
        return;
    }

    var p = Math.max(1, Math.min(Math.floor(page), pageCount(s.total, s.size)));
    if (p === s.page) {
        return;
    }

    want[kind] = p;
    userNav[kind] = true;
    refetchKind(kind);
}

/*
 * Infinite mode: fetches the next slice of a kind and keeps it in the cache. Resolves to the items
 * that are new (already-seen ids dropped), [] when there is nothing to add or the viewer's search
 * changed while it was in flight. One request per kind at a time.
 */
export function fetchMore(kind) {
    var st = inf[kind];
    var s = stats[kind];
    var base = lastUrl[kind];
    if (!st || !s || !base || st.loading || st.done || !isInfinite()) {
        return Promise.resolve([]);
    }

    var client = window.ApiClient;
    if (!client || typeof client.ajax !== 'function') {
        st.error = true;
        changed();
        return Promise.resolve([]);
    }

    var epoch = st.epoch;
    var page = st.loadedPages + 1;
    var url = rewritePagedUrl(base, page, s.size) + '&jpInf=1';
    st.loading = true;
    st.error = false;
    changed();
    log('search pager: fetchMore ' + kind + ' page ' + page + ' - ' + url);

    return client.ajax({ type: 'GET', url: url, dataType: 'json' }).then(function (body) {
        if (st.epoch !== epoch) {
            return [];
        }

        var list = (body && Array.isArray(body.Items)) ? body.Items : [];
        var fresh = [];
        list.forEach(function (it) {
            var id = it && it.Id ? String(it.Id).toLowerCase() : '';
            if (id && !st.seen[id]) {
                st.seen[id] = true;
                fresh.push(it);
            }
        });
        fresh.forEach(function (it) { st.items.push(it); });
        st.loadedPages = page;
        s.total = Math.max(s.total, typeof body.TotalRecordCount === 'number' ? body.TotalRecordCount : 0,
            (page - 1) * s.size + list.length);
        st.done = reachedEnd((page - 1) * s.size + list.length, s.size, s.total, list.length);
        st.loading = false;
        changed();
        return fresh;
    }, function (err) {
        if (st.epoch === epoch) {
            st.loading = false;
            st.error = true;
            changed();
        }

        log('search pager: fetchMore failed', err);
        return [];
    });
}

/* The Paged / Infinite switch. Both change the size React's queries ask for, so they re-run. */
export function setMode(next) {
    var m = normalizeMode(next);
    if (!m) {
        return;
    }

    mode = m;
    saveMode(m);
    resetAll();
    stats = { video: null, all: null };
    refetchKind('video');
    changed();
}

export function setSize(kind, size) {
    var n = normalizeSize(kind, size);
    if (KINDS.indexOf(kind) === -1 || n === sizes[kind] || pending[kind]) {
        return;
    }

    sizes[kind] = n;
    saveSizes(sizes);
    want[kind] = 1;
    userNav[kind] = true;
    refetchKind(kind);
}
