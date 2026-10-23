import { log } from '../lib/log.js';
import { rewriteListUrl, createSeeds } from '../model/list-requests.js';

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
 */

var seeds = createSeeds();
var shuffleBound = false;

function onTv() {
    return document.documentElement.classList.contains('layout-tv');
}

function mark(url) {
    try {
        var out = rewriteListUrl(url, { seedFor: seeds.seedFor, tv: onTv() });
        if (out !== url) {
            log('list requests: ' + url + ' -> ' + out);
        }

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
                try {
                    if (typeof input === 'string') {
                        var marked = mark(input);
                        if (marked !== input) {
                            var args = Array.prototype.slice.call(arguments);
                            args[0] = marked;
                            return previousFetch.apply(this, args);
                        }
                    } else if (input && typeof Request !== 'undefined' && input instanceof Request) {
                        var rewritten = mark(input.url);
                        if (rewritten !== input.url) {
                            var rest = Array.prototype.slice.call(arguments);
                            rest[0] = new Request(rewritten, input);
                            return previousFetch.apply(this, rest);
                        }
                    }
                } catch (err) {
                    log('list requests: fetch hook threw; sending the request unchanged', err);
                }

                return previousFetch.apply(this, arguments);
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
