import { log } from '../lib/log.js';
import { rewriteListUrl, createSeeds, listSignature } from '../model/list-requests.js';
import { parts } from '../model/search-census.js';
import { isLibraryListUrl, startOf, limitOf, nextUrl, reachedEnd } from '../model/library-infinite.js';

/*
 * LIBRARY LIST PAGE REQUESTS (model/list-requests.js decides what changes; this wires it).
 *
 * A third layer over fetch and XHR, installed the same way as play-all.js so network.js and the
 * other hooks do not change: the legacy list page and the Favourites page fetch through the API
 * client (fetch), the modern library tabs through axios (XHR). Three rewrites, each only on the
 * request shape it was written for:
 *
 *   - Random + paging gets jpListSeed, so page 2 continues page 1's shuffle (server:
 *     ListSortPatches.cs). The seed is per list and per page load; the Shuffle button on a list
 *     page reshuffles (its click is seen here BEFORE the page's own handler runs, so its request
 *     already carries a fresh seed).
 *   - "Recently edited" (DateLastSaved) is sent as the placeholder sort plus jpSortKey.
 *   - The Favourites page's 20-per-section cap becomes 100.
 *
 * A request that matches none of them is passed on as the very same string.
 *
 * LIBRARY INFINITE SCROLL (view/library-infinite.js draws, model/library-infinite.js decides). This
 * is the one place that sees a library tab's page request as it leaves the page, so it also keeps
 * the infinite-scroll record: the request of the page the viewer is on (as SENT, so the Random seed
 * and every other rewrite rides along), the response (ids, total) and what fetchNext() has added
 * since. fetchNext() takes that request and changes only StartIndex, marked jpInf=1; it goes through
 * the same wrappers as any request (the library filter markers apply), and the list signature
 * ignores jpInf, so a follow-up page of a Random list is the same shuffle as the first. A change of
 * list (sort, filter, tab, page) or a response with different ids starts the record over; the view
 * notices through the epoch. Nothing here changes a request the page itself sends.
 */

var seeds = createSeeds();

function freshInf() {
    return {
        epoch: 0, sig: '', baseSent: '', start: 0, limit: 0, next: 0, total: 0, idsSig: '', firstId: '',
        items: [], seen: {}, loading: false, done: true, error: false, ready: false
    };
}

var inf = freshInf();
var infListeners = [];
// Set by mark(): the sent url when the request just marked is a library page the record follows.
var lastTracked = '';

/* The record the view reads: { epoch, ready, start, limit, total, firstId, items, loading, done, error }. */
export function infState() {
    return inf;
}

export function onInfChanged(fn) {
    infListeners.push(fn);
}

function infChanged() {
    infListeners.forEach(function (fn) {
        try {
            fn();
        } catch (err) {
            log('list requests: infinite listener failed', err);
        }
    });
}

function resetInf(keep) {
    var epoch = inf.epoch + 1;
    var next = freshInf();
    if (keep) {
        ['sig', 'baseSent', 'start', 'limit', 'next'].forEach(function (k) { next[k] = inf[k]; });
    }

    inf = next;
    inf.epoch = epoch;
}

/* On unless TV, the Mobile theme off switch, or the viewer's own choice (jellyfinPlus.libraryInfinite = on | off). */
export function infiniteEnabled() {
    try {
        var root = document.documentElement;
        if (root.classList.contains('layout-tv')) {
            return false;
        }

        var own = window.localStorage.getItem('jellyfinPlus.libraryInfinite');
        if (own === 'on' || own === 'off') {
            return own === 'on';
        }

        return !root.classList.contains('jp-theme-off') && window.localStorage.getItem('jellyfinPlus.mobileTheme') !== 'off';
    } catch (e) {
        return true;
    }
}

function onSearchPage() {
    return /^#\/search(\?|$)/.test(window.location.hash || '');
}

function sigOf(url) {
    return listSignature(parts(url)) + '|' + startOf(url);
}

/* A library tab's page request is leaving (raw url in, url as sent out): is it the one to continue from? */
function track(url, sent) {
    if (onTv() || onSearchPage() || !isLibraryListUrl(url)) {
        return false;
    }

    var sig = sigOf(url);
    if (sig !== inf.sig) {
        resetInf(false);
        inf.sig = sig;
        inf.baseSent = sent;
        inf.start = startOf(url);
        inf.limit = limitOf(url);
        inf.next = inf.start + inf.limit;
        infChanged();
    }

    return true;
}

/* The response to the request track() accepted. A stale one (the list changed since) is ignored. */
function noteResponse(url, body) {
    try {
        if (sigOf(url) !== inf.sig || !body || !Array.isArray(body.Items)) {
            return;
        }

        var ids = body.Items.map(function (it) { return it && it.Id ? String(it.Id).toLowerCase() : ''; });
        var idsSig = ids.join(',');
        if (idsSig !== inf.idsSig) {
            // Different first page than the one pages were appended to: whatever was appended is stale.
            resetInf(true);
            inf.idsSig = idsSig;
            ids.forEach(function (id) { if (id) { inf.seen[id] = true; } });
            inf.firstId = ids[0] || '';
        }

        inf.total = typeof body.TotalRecordCount === 'number' ? body.TotalRecordCount : body.Items.length;
        inf.done = reachedEnd(inf.start, inf.limit, inf.total, body.Items.length);
        inf.ready = true;
        infChanged();
    } catch (err) {
        log('list requests: could not read the page response', err);
    }
}

function watchXhr(xhr, url) {
    xhr.addEventListener('load', function () {
        try {
            var body = xhr.responseType === 'json' ? xhr.response
                : ((xhr.responseType === '' || xhr.responseType === 'text') ? JSON.parse(xhr.responseText) : null);
            noteResponse(url, body);
        } catch (err) { /* the page's own request failed or is not JSON: nothing to record */ }
    });
}

function watchFetch(url, promise) {
    promise.then(function (res) {
        return res.clone().json().then(function (body) { noteResponse(url, body); });
    }).catch(function () { /* the page shows its own failure */ });
}

/*
 * The next page after what is on screen, drawn by the view. Resolves to the items that are new (ids
 * already shown are dropped); [] when there is nothing to add, the list changed while it was in
 * flight, or it failed (error is then set, and the view offers a retry).
 */
export function fetchNext() {
    var st = inf;
    var client = window.ApiClient;
    if (!st.ready || !st.baseSent || st.loading || st.done || st.error || !infiniteEnabled()) {
        return Promise.resolve([]);
    }

    if (!client || typeof client.ajax !== 'function') {
        st.error = true;
        infChanged();
        return Promise.resolve([]);
    }

    var epoch = st.epoch;
    var start = st.next;
    var url = nextUrl(st.baseSent, start);
    st.loading = true;
    st.error = false;
    infChanged();
    log('list requests: infinite page at ' + start + ' - ' + url);

    return client.ajax({ type: 'GET', url: url, dataType: 'json' }).then(function (body) {
        if (inf.epoch !== epoch) {
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
        st.next = start + st.limit;
        if (body && typeof body.TotalRecordCount === 'number') {
            st.total = body.TotalRecordCount;
        }

        st.done = reachedEnd(start, st.limit, st.total, list.length);
        st.loading = false;
        infChanged();
        return fresh;
    }, function (err) {
        if (inf.epoch === epoch) {
            st.loading = false;
            st.error = true;
            infChanged();
        }

        log('list requests: infinite page failed', err);
        return [];
    });
}

/* Retry after a failure. */
export function retryNext() {
    inf.error = false;
    return fetchNext();
}
var shuffleBound = false;

function onTv() {
    return document.documentElement.classList.contains('layout-tv');
}

function mark(url) {
    lastTracked = '';
    try {
        var out = rewriteListUrl(url, { seedFor: seeds.seedFor, tv: onTv() });
        if (out !== url) {
            log('list requests: ' + url + ' -> ' + out);
        }

        lastTracked = track(url, out) ? url : '';
        return out;
    } catch (err) {
        log('list requests: rewrite failed', err);
        return url;
    }
}

export function installListRequests() {
    try {
        if (window.fetch && !window.fetch.__jellyfinPlusListRequests) {
            var previousFetch = window.fetch;
            var wrappedFetch = function (input) {
                var tracked = '';
                var args = arguments;
                try {
                    if (typeof input === 'string') {
                        var marked = mark(input);
                        tracked = lastTracked;
                        if (marked !== input) {
                            args = Array.prototype.slice.call(arguments);
                            args[0] = marked;
                        }
                    } else if (input && typeof Request !== 'undefined' && input instanceof Request) {
                        var rewritten = mark(input.url);
                        tracked = lastTracked;
                        if (rewritten !== input.url) {
                            args = Array.prototype.slice.call(arguments);
                            args[0] = new Request(rewritten, input);
                        }
                    }
                } catch (err) {
                    log('list requests: fetch hook threw; sending the request unchanged', err);
                    args = arguments;
                    tracked = '';
                }

                var promise = previousFetch.apply(this, args);
                if (tracked) {
                    watchFetch(tracked, promise);
                }

                return promise;
            };
            wrappedFetch.__jellyfinPlusListRequests = true;
            window.fetch = wrappedFetch;
        }

        var proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
        if (proto && !proto.open.__jellyfinPlusListRequests) {
            var previousOpen = proto.open;
            var wrappedOpen = function (method, url) {
                var args = arguments;
                try {
                    if (typeof url === 'string') {
                        var marked = mark(url);
                        if (marked !== url) {
                            args = Array.prototype.slice.call(arguments);
                            args[1] = marked;
                        }

                        if (lastTracked) {
                            watchXhr(this, lastTracked);
                        }
                    }
                } catch (err) { /* fall through with the original arguments */ }

                return previousOpen.apply(this, args);
            };
            wrappedOpen.__jellyfinPlusListRequests = true;
            proto.open = wrappedOpen;
        }

        // The list page's Shuffle button asks for "Random, 300 items" through the same request shape
        // as a Random page; it must not replay the shuffle the page already showed.
        if (!shuffleBound) {
            shuffleBound = true;
            document.addEventListener('click', function (e) {
                try {
                    var target = e.target;
                    if (target && typeof target.closest === 'function' && target.closest('.btnShuffle')) {
                        seeds.reset();
                    }
                } catch (err) { /* the next shuffle just reuses the seed */ }
            }, true);
        }

        log('list requests installed');
    } catch (err) {
        log('list requests install failed', err);
    }
}
