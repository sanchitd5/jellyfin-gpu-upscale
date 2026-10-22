import { log } from '../lib/log.js';
import { loadState, saveState, rewriteSearchUrl, normalizeState, activeGroups } from '../model/search-filters.js';
import { refetchSearch, excludeText } from './search-exclude.js';

/*
 * THE SEARCH PAGE'S SORT & FILTER, DATA SIDE (view/search-filter-sheet.js is the DOM side).
 *
 * `committed` is what search requests carry. It changes only through commit() - the sheet's Apply,
 * Reset, or removing a chip - never while the sheet is merely being edited. markSearchFilters()
 * is called from the fetch/XHR hooks in network.js next to markSearchUrl(), and (like it) only
 * touches a search /Items request: the serialiser in model/search-filters.js does the matching.
 *
 * The page's React Query keys do not include these parameters, so commit() re-runs the page's
 * queries with search-exclude.js's two-phase refetch, exactly as the exclude box does.
 */

var committed = loadState();
var listeners = [];

export function currentFilters() {
    return committed;
}

export function onFiltersChanged(fn) {
    listeners.push(fn);
}

function onSearchPage() {
    return /^#\/search(\?|$)/.test(window.location.hash || '');
}

/* The library the search is scoped to (?parentId=), or '' for a global search. */
export function searchParentId() {
    try {
        var hash = window.location.hash || '';
        var q = hash.indexOf('?');
        return q === -1 ? '' : (new URLSearchParams(hash.slice(q + 1)).get('parentId') || '');
    } catch (e) {
        return '';
    }
}

/* Called by the fetch/XHR hooks for every outgoing url; anything but a search request is returned as is. */
export function markSearchFilters(url) {
    if (typeof url !== 'string' || !onSearchPage()) {
        return url;
    }

    var out = rewriteSearchUrl(url, committed, new Date());
    if (out !== url) {
        log('markSearchFilters: ' + url + ' -> ' + out);
    }

    return out;
}

/*
 * Makes `next` the filters every search request carries from now on, and re-runs the page's
 * queries. Random gets a fresh seed on every commit, so Apply reshuffles and one commit stays
 * stable across re-renders and paging.
 */
export function commit(next) {
    var s = normalizeState(next);
    if (s.sort === 'Random') {
        s.seed = 1 + Math.floor(Math.random() * 2147483646);
    } else {
        s.seed = 0;
    }

    committed = s;
    saveState(s);
    listeners.forEach(function (fn) {
        try {
            fn(s);
        } catch (err) {
            log('search filters listener failed', err);
        }
    });
    log('search filters committed: ' + JSON.stringify(s));
    refetchSearch();
}

/* On first sight of the page: results already on screen may predate the stored filters. */
export function refreshIfActive() {
    if (activeGroups(committed).length && !excludeText()) {
        // The exclude box does its own refetch when it has text; one run covers both.
        refetchSearch();
    }
}

/* ---- the tag list for the picker ---- */

var tagCache = {};
var TAG_TTL = 5 * 60 * 1000;

/* Promise of the sorted tag names for a library ('' = everything the user can see). */
export function fetchTags(parentId) {
    var hit = tagCache[parentId];
    if (hit && Date.now() - hit.at < TAG_TTL) {
        return Promise.resolve(hit.tags);
    }

    var client = window.ApiClient;
    if (!client || typeof client.getUrl !== 'function' || typeof client.ajax !== 'function') {
        return Promise.reject(new Error('no ApiClient'));
    }

    var params = { userId: client.getCurrentUserId() };
    if (parentId) {
        params.parentId = parentId;
    }

    return client.ajax({
        type: 'GET',
        url: client.getUrl('Items/Filters', params),
        dataType: 'json'
    }).then(function (res) {
        var tags = ((res && res.Tags) || []).filter(function (t) { return typeof t === 'string' && t; });
        tags.sort(function (a, b) { return a.localeCompare(b, undefined, { sensitivity: 'base' }); });
        tagCache[parentId] = { at: Date.now(), tags: tags };
        log('search filters: ' + tags.length + ' tags loaded');
        return tags;
    });
}
