import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';

/*
 * THE SEARCH PAGE'S "EXCLUDE TAGS" BOX.
 *
 * The server half lives in src/patcher/SearchPatches.cs: SqlSearchProvider.SearchAsync also matches
 * tags, and drops any item with a tag containing one of the request's `excludeTags` terms
 * (case-insensitive substring, comma- or pipe-separated). This module is the client half:
 *
 *  1. a second input under jellyfin-web's own search box (#searchPage .searchFields), found by
 *     shape and re-added whenever React re-renders it away;
 *  2. `markSearchUrl()`, called from the fetch/XHR hooks in network.js, appending `excludeTags` to
 *     every search request (/Items or /Search/Hints carrying a searchTerm) while the box has text;
 *  3. a refetch when the box changes. jellyfin-web's search hooks are React Query queries keyed on
 *     ['Search', ..., searchTerm] with a 60s staleTime and an IndexedDB-persisted cache, and the
 *     exclude text is not in that key - so without invalidating them the page would keep showing
 *     results fetched under the old exclusion. The QueryClient is found BY SHAPE on a module
 *     export (webpack-hook.js hands every export to noteQueryClient), never by a global name.
 */

var STORE = 'gpuUpscale.searchExclude';
var PARAM = 'excludeTags';
var BOX_CLASS = 'gpuUpscaleSearchExclude';

// Search endpoints the server patch serves: the search page's /Items calls, and /Search/Hints.
var IS_SEARCH = /\/(items|search\/hints)(\?|$)/i;
var HAS_TERM = /[?&]searchterm=[^&]/i;

var queryClient = null;
var debounce = null;

export function excludeText() {
    try {
        return (window.localStorage && window.localStorage.getItem(STORE)) || '';
    } catch (e) {
        return '';
    }
}

function saveExclude(text) {
    try {
        if (text) {
            window.localStorage.setItem(STORE, text);
        } else {
            window.localStorage.removeItem(STORE);
        }
    } catch (e) { /* storage refused: the box still works for this page view */ }
}

/* Appends (or replaces) excludeTags on a search request. Any other url comes back unchanged. */
export function markSearchUrl(url) {
    var text = excludeText().trim();
    if (!text || typeof url !== 'string' || !IS_SEARCH.test(url) || !HAS_TERM.test(url)) {
        return url;
    }

    var value = encodeURIComponent(text);
    var re = new RegExp('([?&])' + PARAM + '=[^&]*', 'i');
    var out = re.test(url)
        ? url.replace(re, '$1' + PARAM + '=' + value)
        : url + (url.indexOf('?') === -1 ? '?' : '&') + PARAM + '=' + value;
    log('markSearchUrl: ' + url + ' -> ' + out);
    return out;
}

function isQueryClient(o) {
    return !!o
        && typeof o.invalidateQueries === 'function'
        && typeof o.getQueryCache === 'function'
        && typeof o.fetchQuery === 'function';
}

/* Called with every module's exports; keeps the first React Query client it sees. */
export function noteQueryClient(exports) {
    if (queryClient || !exports || (typeof exports !== 'object' && typeof exports !== 'function')) {
        return;
    }

    try {
        if (isQueryClient(exports)) {
            queryClient = exports;
        } else {
            var keys = Object.keys(exports);
            for (var i = 0; i < keys.length && !queryClient; i++) {
                var v;
                try {
                    v = exports[keys[i]];
                } catch (e) {
                    continue;
                }

                if (isQueryClient(v)) {
                    queryClient = v;
                }
            }
        }

        if (queryClient) {
            log('found the React Query client on a module export');
        }
    } catch (err) { /* an exotic export is not a reason to break module loading */ }
}

/* Re-runs the search page's queries so they go out again with the current exclusion. */
function refetchSearch() {
    if (!queryClient) {
        log('refetchSearch: no React Query client found; results refresh on the next search');
        return;
    }

    try {
        queryClient.invalidateQueries({ queryKey: ['Search'] });
    } catch (err) {
        log('refetchSearch: invalidateQueries threw', err);
    }
}

function buildBox() {
    var row = el('div', BOX_CLASS + ' searchFieldsInner flex align-items-center justify-content-center');
    row.style.marginTop = '0.5em';

    var icon = el('span', 'searchfields-icon material-icons block');
    icon.setAttribute('aria-hidden', 'true');

    var wrap = el('div', 'inputContainer flex-grow');
    wrap.style.marginBottom = '0';

    var input = el('input', 'emby-input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.maxLength = 200;
    input.placeholder = 'Exclude tags (comma-separated)';
    input.setAttribute('aria-label', 'Exclude tags');
    input.title = 'Hide results with a tag containing any of these words. Case-insensitive.';
    input.value = excludeText();

    input.addEventListener('input', function () {
        saveExclude(input.value.trim());
        clearTimeout(debounce);
        // Same pause the search box itself waits (search.tsx debounces its query by 500ms).
        debounce = setTimeout(refetchSearch, 500);
    });

    // The page binds keys for its own navigation; typing here must not trigger them.
    input.addEventListener('keydown', function (e) { e.stopPropagation(); });

    wrap.appendChild(input);
    row.appendChild(icon);
    row.appendChild(wrap);
    return row;
}

function ensureBox(fields) {
    if (!fields || fields.querySelector('.' + BOX_CLASS)) {
        return;
    }

    fields.appendChild(buildBox());
    log('search exclude box added');

    // Results already on screen (or restored from the persisted cache) may predate the
    // current exclusion.
    if (excludeText()) {
        refetchSearch();
    }
}

function scan() {
    try {
        Array.prototype.forEach.call(
            document.querySelectorAll('#searchPage .searchFields'),
            ensureBox);
    } catch (err) {
        log('search exclude scan failed', err);
    }
}

export function watchSearchPage() {
    try {
        var pending = false;
        var observer = new MutationObserver(function () {
            // Coalesced: React commits many mutations at once and one scan covers them all.
            if (pending) {
                return;
            }

            pending = true;
            requestAnimationFrame(function () {
                pending = false;
                scan();
            });
        });
        observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
        scan();
    } catch (err) {
        log('search page observer failed', err);
    }
}
