import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';
import {
    MAX_IDS, PAGE, isListUrl, isIdsPageUrl, idsPageUrl, noteResponse, pickGroup, offerLabel, countText,
    pageStarts, normId
} from '../model/select-all.js';

/*
 * "SELECT ALL N RESULTS" ACROSS PAGES (QOL_IDEAS #42), for the bulk tag flow.
 *
 * Stock multi-select (components/multiSelect/multiSelect.js) keeps its selection in a module closure
 * and its "Select all" ticks only the cards that are drawn, so on a list of 3,000 clips it selects the
 * first screenful. This adds, to the selection menu that controller/bulk-tags.js already decorates, a
 * row "Select all N results" (administrators, like the tag rows it feeds):
 *
 *  1. RECORD. XHR and fetch responses of list queries (GET .../Items with a page size, no `ids`) are
 *     read on a side branch, never altered, into a few "groups": the query without its paging, the ids
 *     its pages brought, and the TotalRecordCount. Final urls are used (xhr.responseURL, response.url),
 *     so every rewrite the other hooks made - filters, exclusions, search paging - is already in them.
 *  2. MATCH. When the menu opens, the ticked ids (read from the checkboxes) pick the most recently
 *     touched group that holds every one of them. No match (the list was served from React Query's
 *     cache and never crossed the network here, or the selection spans lists) -> the row is not
 *     offered, and stock behaviour is untouched.
 *  3. COLLECT. The same query is asked again, page by page, for ids only (model/select-all.js
 *     idsPageUrl: no images, no user data, `jpInf=1` so the search page's own handlers ignore it, a
 *     Random sort made stable). It must bring back at least the counted total, or nothing is selected.
 *  4. USE. The ids are held here; a banner in the selection bar says so and offers Clear. Only
 *     bulk-tags' "Add tags" / "Remove tags" read them (extendedSelection()); every other stock command
 *     in that menu (playlist, delete, mark played ...) still acts on the ticked cards alone, which is why
 *     nothing here pretends to tick them. The selection is dropped when the viewer ticks or unticks a
 *     card, taps Clear, or the selection bar goes away.
 *
 * Over MAX_IDS results nothing is selected and the banner says so: a partial selection presented as
 * "all" would tag the wrong set.
 */

var STYLE_ID = 'jellyfinPlusSelectAllStyle';
var BANNER_CLASS = 'jpSelAll';

var CSS = [
    '.selectionCommandsPanel .' + BANNER_CLASS + ' {'
        + ' position: absolute; left: 0.5em; right: 0.5em; top: 100%; margin-top: -0.4em; z-index: 1;'
        + ' display: flex; align-items: center; gap: 0.6em; box-sizing: border-box; padding: 0.4em 0.4em 0.4em 0.9em;'
        + ' border-radius: 8px; background: #202020; color: #eee; font-size: 0.95em; box-shadow: 0 2px 10px rgba(0,0,0,0.5); }',
    '.' + BANNER_CLASS + ' .jpSelAllText { flex: 1; min-width: 0; word-break: break-word; }',
    '.' + BANNER_CLASS + '[data-state="error"] .jpSelAllText { color: #ff8a80; }',
    '.' + BANNER_CLASS + ' button { flex: none; min-width: 44px; min-height: 40px; padding: 0 0.9em; border: 0; border-radius: 6px;'
        + ' background: #3a3a3a; color: #fff; font: inherit; cursor: pointer; }'
].join('\n');

var groups = new Map();
// The selection: { ids, total, panel, banner, collecting, cancelled } or null.
var ext = null;

/* ---- 1. record list responses ---- */

function record(url, body) {
    try {
        if (!isListUrl(url) || isIdsPageUrl(url) || !body || !Array.isArray(body.Items)) {
            return;
        }

        noteResponse(groups, url, body.Items, body.TotalRecordCount, Date.now());
    } catch (err) {
        log('select all: could not record a list response', err);
    }
}

var ITEMS_URL = /\/Items\?/i;

function hookXhr() {
    if (!window.XMLHttpRequest) {
        return;
    }

    var proto = window.XMLHttpRequest.prototype;
    var originalOpen = proto.open;
    proto.open = function (method, url) {
        try {
            if (String(method).toUpperCase() === 'GET' && ITEMS_URL.test(String(url))) {
                var xhr = this;
                var asked = String(url);
                xhr.addEventListener('load', function () {
                    try {
                        var body;
                        if (xhr.responseType === 'json') {
                            body = xhr.response;
                        } else if (xhr.responseType === '' || xhr.responseType === 'text') {
                            body = JSON.parse(xhr.responseText);
                        }

                        record(xhr.responseURL || asked, body);
                    } catch (err) { /* not JSON: not a list response */ }
                });
            }
        } catch (err) {
            log('select all: xhr open hook failed', err);
        }

        return originalOpen.apply(this, arguments);
    };
}

function hookFetch() {
    if (typeof window.fetch !== 'function') {
        return;
    }

    var originalFetch = window.fetch;
    window.fetch = function (input, init) {
        var promise = originalFetch.apply(this, arguments);
        try {
            var url = typeof input === 'string' ? input : (input && input.url) || '';
            var method = (init && init.method) || (input && input.method) || 'GET';
            if (String(method).toUpperCase() === 'GET' && ITEMS_URL.test(url)) {
                promise.then(function (res) {
                    return res.ok ? res.clone().json().then(function (body) { record(res.url || url, body); }) : undefined;
                }).catch(function () { /* the caller sees the failure; this branch only watches */ });
            }
        } catch (err) {
            log('select all: fetch hook failed', err);
        }

        return promise;
    };
}

/* ---- the banner ---- */

function selectionPanel() {
    return document.querySelector('.selectionCommandsPanel');
}

function drop(reason) {
    if (!ext) {
        return;
    }

    ext.cancelled = true;
    if (ext.banner && ext.banner.parentNode) {
        ext.banner.parentNode.removeChild(ext.banner);
    }

    log('select all: selection dropped (' + reason + ')');
    ext = null;
}

function button(label, onClick) {
    var b = el('button', '', label);
    b.type = 'button';
    b.addEventListener('click', function (e) {
        e.stopPropagation();
        onClick();
    });
    return b;
}

/* Replaces the banner's content: text, and at most one action button. */
function say(text, state, action) {
    var panel = ext && ext.panel;
    if (!panel || !panel.isConnected) {
        return;
    }

    if (!ext.banner) {
        ext.banner = el('div', BANNER_CLASS);
        ext.banner.setAttribute('role', 'status');
        panel.appendChild(ext.banner);
    }

    var b = ext.banner;
    b.textContent = '';
    b.setAttribute('data-state', state || 'info');
    b.appendChild(el('span', 'jpSelAllText', text));
    if (action) {
        b.appendChild(button(action.label, action.run));
    }
}

/* ---- 2. what to offer ---- */

/* { label, url, total } for the ticked ids, or null when there is nothing to offer. */
export function offerSelectAll(tickedIds) {
    if (extendedSelection()) {
        return null;
    }

    var group = pickGroup(groups, tickedIds);
    var label = offerLabel(group, tickedIds.length);
    return label ? { label: label, url: group.url, total: group.total } : null;
}

/* ---- 3. collect ---- */

export function startSelectAll(offer) {
    var client = window.ApiClient;
    var panel = selectionPanel();
    if (!offer || !panel || !client || typeof client.ajax !== 'function') {
        log('select all: no selection bar or ApiClient, nothing done');
        return;
    }

    drop('restart');
    var total = offer.total;
    var starts = pageStarts(total, PAGE);
    ext = { ids: [], total: total, panel: panel, banner: null, collecting: true, cancelled: false };
    var mine = ext;
    var seen = new Set();

    function cancel() {
        drop('cancelled');
    }

    function fail(message) {
        if (ext !== mine) {
            return;
        }

        mine.collecting = false;
        say(message, 'error', { label: 'Dismiss', run: function () { drop('dismissed'); } });
        // An error banner is not a selection: the tag rows must not see it.
        mine.ids = [];
    }

    if (!starts.length) {
        fail(countText(total) + ' results is over the limit of ' + countText(MAX_IDS)
            + ' for a selection like this. Narrow the list (filters, search) and try again.');
        return;
    }

    say('Collecting results: 0 of ' + countText(total) + '…', 'info', { label: 'Cancel', run: cancel });

    var i = 0;
    function next() {
        if (ext !== mine) {
            return Promise.resolve();
        }

        if (i >= starts.length) {
            return Promise.resolve();
        }

        var url = idsPageUrl(offer.url, starts[i], PAGE);
        i++;
        return Promise.resolve(client.ajax({ type: 'GET', url: url, dataType: 'json' })).then(function (body) {
            if (ext !== mine) {
                return undefined;
            }

            var list = body && Array.isArray(body.Items) ? body.Items : [];
            list.forEach(function (it) {
                var id = it && it.Id ? normId(it.Id) : '';
                if (id && !seen.has(id)) {
                    seen.add(id);
                    mine.ids.push(String(it.Id));
                }
            });
            say('Collecting results: ' + countText(mine.ids.length) + ' of ' + countText(total) + '…', 'info',
                { label: 'Cancel', run: cancel });
            // An empty page is the end of the list, whatever the count said.
            return list.length ? next() : undefined;
        });
    }

    next().then(function () {
        if (ext !== mine) {
            return;
        }

        if (mine.ids.length < total) {
            fail('Only ' + countText(mine.ids.length) + ' of ' + countText(total)
                + ' results could be collected (the list may have changed). Nothing was selected; try again.');
            return;
        }

        mine.collecting = false;
        say('All ' + countText(mine.ids.length) + ' results selected for Add tags / Remove tags. '
            + 'Other menu actions still apply to the ticked cards only.', 'ready',
            { label: 'Clear', run: function () { drop('cleared'); } });
        log('select all: ' + mine.ids.length + ' ids collected (counted ' + total + ')');
    }, function (err) {
        log('select all: collecting failed', err);
        var status = err && (err.status || (err.response && err.response.status));
        fail('Could not collect the results' + (status ? ' (server error ' + status + ')' : '') + '. Nothing was selected.');
    });
}

/* ---- 4. what the tag rows read ---- */

/* { ids, total } once all results are collected and the selection bar is still up, else null. */
export function extendedSelection() {
    if (!ext || ext.collecting || !ext.ids.length) {
        return null;
    }

    if (!ext.panel || !ext.panel.isConnected) {
        drop('selection bar closed');
        return null;
    }

    return { ids: ext.ids.slice(), total: ext.total };
}

export function installSelectAll() {
    try {
        if (!document.getElementById(STYLE_ID)) {
            var style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = CSS;
            (document.head || document.documentElement).appendChild(style);
        }

        hookXhr();
        hookFetch();

        // Ticking or unticking a card changes what "the selection" means: go back to the ticked cards.
        document.addEventListener('change', function (e) {
            var t = e.target;
            if (ext && t && t.classList && t.classList.contains('chkItemSelect')) {
                drop('card ticked or unticked');
            }
        }, true);
        log('select all installed');
    } catch (err) {
        log('select all install failed', err);
    }
}
