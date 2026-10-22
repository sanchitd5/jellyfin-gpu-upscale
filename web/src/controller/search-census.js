import { log } from '../lib/log.js';
import { verdict, nullRequest } from '../model/search-census.js';

/*
 * SKIP SEARCH REQUESTS THAT CAN NOT MATCH (model/search-census.js decides; this wires it).
 *
 * The search page asks for artists, people, studios, programs, videos and the all-types list on
 * every search, however small the library. GET /JellyfinPlus/Library/Census says which item kinds
 * the user has; a request whose answer is provably empty is rewritten to a lookup of a nonexistent
 * id (model/search-census.js nullRequest), which returns the stock empty result shape for no real
 * work, so the page's React Query code is untouched and sees a valid empty answer.
 *
 * WHERE IT SITS. This must see the URL AFTER the search page's other markings (the exclude box,
 * Sort & filter, paging) - Sort & filter can change includeItemTypes, so a verdict on the page's
 * original URL could skip a request those markings were about to widen. So this wraps XHR/fetch
 * BEFORE network.js does (bootstrap.js installs it first): network.js's wrappers then run first
 * and call into this one with the final URL.
 *
 * FAIL OPEN. No census yet, a failed census, a census older than CENSUS_TTL, a server without the
 * route: the request goes through unchanged. A fetch is started whenever one is needed, so only the
 * first search after a page load can miss the saving.
 */

var CENSUS_TTL = 5 * 60 * 1000;
var STORE_KEY = 'jellyfinPlus.census';

var census = null; // { at, user, counts }
var inflight = null;
var failedAt = 0;
// A server without the route (or a failing one) is asked again only this often.
var RETRY_AFTER_FAIL = 60 * 1000;

function onSearchPage() {
    return /^#\/search(\?|$)/.test(window.location.hash || '');
}

function currentUser() {
    try {
        var c = window.ApiClient;
        return c && typeof c.getCurrentUserId === 'function' ? c.getCurrentUserId() : null;
    } catch (e) {
        return null;
    }
}

function restore(user) {
    try {
        var saved = JSON.parse(window.sessionStorage.getItem(STORE_KEY));
        if (saved && saved.user === user && saved.counts && typeof saved.at === 'number') {
            return saved;
        }
    } catch (e) { /* no stored census: fetch one */ }
    return null;
}

function usable(user) {
    if (!census || census.user !== user) {
        census = restore(user);
    }

    return census && census.user === user && Date.now() - census.at < CENSUS_TTL ? census : null;
}

function load(user) {
    var client = window.ApiClient;
    if (inflight || !user || !client || typeof client.getUrl !== 'function' || typeof client.ajax !== 'function'
        || Date.now() - failedAt < RETRY_AFTER_FAIL) {
        return;
    }

    // Set before the call: ajax goes through the fetch/XHR wrappers below, which would re-enter here.
    inflight = true;
    var request;
    try {
        request = client.ajax({
            type: 'GET',
            url: client.getUrl('JellyfinPlus/Library/Census', { userId: user }),
            dataType: 'json'
        });
    } catch (e) {
        inflight = null;
        failedAt = Date.now();
        return;
    }

    inflight = request.then(function (res) {
        inflight = null;
        if (res && res.counts && typeof res.counts === 'object') {
            census = { at: Date.now(), user: user, counts: res.counts };
            try {
                window.sessionStorage.setItem(STORE_KEY, JSON.stringify(census));
            } catch (e) { /* in-memory only */ }
            log('census: ' + Object.keys(res.counts).join(','));
        }
    }, function (err) {
        inflight = null;
        failedAt = Date.now();
        log('census unavailable; no search request will be skipped', err);
    });
}

/* The url to send: the same one unless the census proves it empty. Never throws. */
export function adjustSearchUrl(url) {
    try {
        if (typeof url !== 'string' || !onSearchPage()) {
            return url;
        }

        var user = currentUser();
        var c = usable(user);
        if (!c) {
            load(user);
            return url;
        }

        if (verdict(url, c.counts) === 'skip') {
            var out = nullRequest(url);
            log('census: skipping ' + url + ' -> ' + out);
            return out;
        }
    } catch (err) {
        log('census check failed; sending the request unchanged', err);
    }

    return url;
}

export function installSearchCensus() {
    if (window.XMLHttpRequest) {
        var proto = window.XMLHttpRequest.prototype;
        var originalOpen = proto.open;
        proto.open = function (method, url) {
            if (!method || String(method).toUpperCase() === 'GET') {
                var out = adjustSearchUrl(url);
                if (out !== url) {
                    var args = Array.prototype.slice.call(arguments);
                    args[1] = out;
                    return originalOpen.apply(this, args);
                }
            }

            return originalOpen.apply(this, arguments);
        };
    }

    if (window.fetch) {
        var originalFetch = window.fetch;
        window.fetch = function (input, init) {
            if (typeof input === 'string') {
                var out = adjustSearchUrl(input);
                if (out !== input) {
                    return originalFetch.call(this, out, init);
                }
            }

            return originalFetch.apply(this, arguments);
        };
    }

    // Warm: the first search after a page load should already have an answer.
    load(currentUser());
    window.addEventListener('hashchange', function () {
        if (onSearchPage() && !usable(currentUser())) {
            load(currentUser());
        }
    });
    log('census hooks installed');
}
