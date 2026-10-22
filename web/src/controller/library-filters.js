import { log } from '../lib/log.js';
import { rewriteLibraryUrl, parseTags, buildTags } from '../model/library-filter-marks.js';
import { getQueryClient } from './search-exclude.js';

/*
 * THE LIBRARY FILTER POPOVER'S DATA SIDE (view/library-filter-panel.js is the DOM side).
 *
 *  1. REQUEST REWRITE. rewriteLibraryUrl() (model/library-filter-marks.js) turns the marker
 *     entries the panel stores in Filters.Tags into excludeTagNames / tagMatch / personIds on the
 *     outgoing /Items request. This module wraps XMLHttpRequest.open and fetch to apply it:
 *     the library view's requests are axios (XHR), "play all" / "shuffle" go through the legacy
 *     API client (fetch). Nothing is added to network.js; these wrappers sit outside its own.
 *
 *  2. THE TAG LIST WINDOW. The Tags accordion renders ONE React checkbox per tag, from
 *     GET /Items/Filters -> the React Query entry ['QueryFiltersLegacy', parentId, itemType]. On a
 *     library with thousands of tags that is seconds of main-thread work every time it opens. So
 *     a list longer than WINDOW_LIMIT is shrunk, both as the response is parsed (so a refetch
 *     cannot bring the full list back) and in the cache (for a response that was restored from the
 *     persisted cache and never crossed the network), to: the tags currently selected or
 *     excluded, plus the first WINDOW_SIZE that match the search text. The full list stays here.
 *     Typing in the panel's search box recomputes the window and writes it into the cache with
 *     setQueryData, so React renders the new few dozen rows - stock rendering, stock checkboxes,
 *     stock selection handling, nothing replaced.
 *
 *  3. THE SETTINGS HANDLE. The filter state is jellyfin-web's useLocalStorage object for the tab.
 *     Writes go through its own setter, found BY SHAPE on the React fiber of the popover (the
 *     nearest component whose props carry setLibraryViewSettings + viewType + parentId, which is
 *     FilterButton), so React state, the persisted copy and the query key all move together and
 *     StartIndex goes back to 0 exactly as the stock handlers do it. Reads come from the
 *     persisted copy, key `${viewType} - ${parentId}` (utils/settings.ts getSettingsKey).
 */

// A full tag list up to this long is left alone; longer is windowed.
export var WINDOW_LIMIT = 300;
// How many matching tags the window shows (selected and excluded ones are always shown too).
export var WINDOW_SIZE = 100;

/* Case- and diacritic-insensitive, like the server's clean value. */
export function normalize(s) {
    try {
        return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    } catch (e) {
        return String(s).toLowerCase();
    }
}

/* ---- tab and list identity ---- */

function typesOf(v) {
    var list = Array.isArray(v) ? v : (v == null ? [] : [v]);
    var out = [];
    list.forEach(function (x) {
        String(x).split(',').forEach(function (p) {
            if (p) { out.push(p.toLowerCase()); }
        });
    });
    return out.sort();
}

/* One tag list per library and item-type set, the same two things the query is keyed on. */
export function listKey(parentId, itemTypes) {
    return String(parentId || '') + '|' + typesOf(itemTypes).join(',');
}

function queryParam(url, name) {
    var q = url.indexOf('?');
    if (q === -1) {
        return [];
    }

    var out = [];
    url.slice(q + 1).split('&').forEach(function (piece) {
        var eq = piece.indexOf('=');
        if (eq === -1) {
            return;
        }

        try {
            if (decodeURIComponent(piece.slice(0, eq)).toLowerCase() === name) {
                out.push(decodeURIComponent(piece.slice(eq + 1).replace(/\+/g, ' ')));
            }
        } catch (e) { /* a bad escape is not a parameter we can use */ }
    });
    return out;
}

/* ---- the persisted filter state ---- */

function settingsKey(ctx) {
    return ctx.viewType + ' - ' + ctx.parentId;
}

export function readFilters(ctx) {
    try {
        var raw = window.localStorage.getItem(settingsKey(ctx));
        var blob = raw ? JSON.parse(raw) : null;
        return (blob && blob.Filters) || {};
    } catch (e) {
        return {};
    }
}

/* Filters.Tags of every tab of one library, merged: what the list window must keep visible. */
function selectionForLibrary(parentId) {
    var out = { tags: [], exclude: [] };
    try {
        var suffix = ' - ' + parentId;
        for (var i = 0; i < window.localStorage.length; i++) {
            var key = window.localStorage.key(i);
            if (!key || key.length <= suffix.length || key.slice(-suffix.length) !== suffix) {
                continue;
            }

            var blob = JSON.parse(window.localStorage.getItem(key));
            var p = parseTags(blob && blob.Filters && blob.Filters.Tags);
            out.tags = out.tags.concat(p.tags);
            out.exclude = out.exclude.concat(p.exclude);
        }
    } catch (e) { /* storage unreadable: the window just shows the first matches */ }
    return out;
}

/* ---- finding the settings setter ---- */

function fiberOf(node) {
    var keys = Object.keys(node);
    for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('__reactFiber$') === 0) {
            return node[keys[i]];
        }
    }

    return null;
}

/*
 * { viewType, parentId, itemType, set } for the popover, or null. By shape: the first component
 * up the React tree whose props carry the settings setter along with the tab and library it
 * belongs to. A minified build keeps prop names, so this survives renumbering that a component
 * name would not.
 */
export function findFilterContext(node) {
    try {
        for (var f = node && fiberOf(node); f; f = f.return) {
            var p = f.memoizedProps;
            if (p && typeof p.setLibraryViewSettings === 'function'
                && typeof p.viewType === 'string' && p.parentId) {
                return {
                    viewType: p.viewType,
                    parentId: p.parentId,
                    itemType: p.itemType || [],
                    set: p.setLibraryViewSettings
                };
            }
        }
    } catch (e) {
        log('findFilterContext failed', e);
    }

    return null;
}

/*
 * Edits Filters through the tab's own setter. `edit` receives a COPY of Filters to change in place;
 * an empty array or empty value is dropped so the stock "has filters" dot stays honest. The
 * StartIndex reset is the one every stock filter handler does.
 */
export function updateFilters(ctx, edit) {
    ctx.set(function (prev) {
        var f = Object.assign({}, prev && prev.Filters);
        edit(f);
        Object.keys(f).forEach(function (k) {
            if (f[k] === undefined || f[k] === null || (Array.isArray(f[k]) && f[k].length === 0)) {
                delete f[k];
            }
        });
        return Object.assign({}, prev, { StartIndex: 0, Filters: f });
    });
}

/* Edits the tag/exclude/people/mode state that rides in Filters.Tags (see library-filter-marks.js). */
export function updateTagState(ctx, edit) {
    updateFilters(ctx, function (f) {
        var p = parseTags(f.Tags);
        edit(p);
        f.Tags = buildTags(p);
    });
}

/* ---- the tag list window ---- */

var lists = {};

export function listState(key) {
    return lists[key] || null;
}

function noteFullList(key, tags) {
    var prev = lists[key];
    lists[key] = {
        full: tags,
        norm: tags.map(normalize),
        search: prev ? prev.search : '',
        windowed: tags.length > WINDOW_LIMIT,
        matches: tags.length,
        shown: tags.length
    };
    return lists[key];
}

export function setSearch(key, text) {
    if (lists[key]) {
        lists[key].search = text;
    }
}

/* The tags to render for this list: selected + excluded + the first WINDOW_SIZE matches. */
function windowTags(key, parentId) {
    var e = lists[key];
    var sel = selectionForLibrary(parentId);
    var keep = {};
    sel.tags.concat(sel.exclude).forEach(function (t) { keep[t] = true; });
    var q = normalize(e.search || '').trim();
    var out = [];
    var shown = 0;
    var matches = 0;
    for (var i = 0; i < e.full.length; i++) {
        var t = e.full[i];
        var isMatch = !q || e.norm[i].indexOf(q) !== -1;
        if (isMatch) { matches++; }
        if (keep[t]) {
            out.push(t);
        } else if (isMatch && shown < WINDOW_SIZE) {
            out.push(t);
            shown++;
        }
    }

    e.matches = matches;
    e.shown = out.length;
    return out;
}

/* Writes the current window into the React Query entry/entries for this list. */
export function applyWindow(parentId, itemTypes) {
    var qc = getQueryClient();
    var key = listKey(parentId, itemTypes);
    if (!qc || !lists[key] || !lists[key].windowed) {
        return false;
    }

    var tags = windowTags(key, parentId);
    var found = false;
    qc.getQueryCache().findAll({ queryKey: ['QueryFiltersLegacy'] }).forEach(function (q) {
        var k = q.queryKey;
        if (k[1] !== parentId || listKey(k[1], k[2]) !== key) {
            return;
        }

        found = true;
        qc.setQueryData(k, function (old) {
            return old ? Object.assign({}, old, { Tags: tags, GuWindow: true }) : old;
        });
    });
    return found;
}

/*
 * Popover just opened: if the cached list is a long full one (it came from the persisted cache and
 * never passed through the response hook below), take it over and window it before the Tags
 * accordion is expanded and React is asked to render it.
 */
export function ensureWindowed(ctx) {
    var qc = getQueryClient();
    if (!qc || !ctx) {
        return null;
    }

    var key = listKey(ctx.parentId, ctx.itemType);
    try {
        var data = qc.getQueryData(['QueryFiltersLegacy', ctx.parentId, ctx.itemType]);
        var tags = data && data.Tags;
        if (data && data.GuWindow && !(lists[key] && lists[key].windowed)) {
            // A window we wrote earlier, restored from the persisted cache: the full list is gone.
            // Refetch it; the response hook windows it again on the way in.
            log('restored tag window without its full list; refetching');
            qc.invalidateQueries({ queryKey: ['QueryFiltersLegacy', ctx.parentId, ctx.itemType] });
        } else if (Array.isArray(tags)) {
            if (tags.length > WINDOW_LIMIT) {
                noteFullList(key, tags);
                applyWindow(ctx.parentId, ctx.itemType);
                log('tag list windowed from cache: ' + tags.length + ' tags');
            } else if (!lists[key] || !lists[key].windowed) {
                noteFullList(key, tags);
            }
        }
    } catch (e) {
        log('ensureWindowed failed', e);
    }

    return lists[key] || null;
}

/* ---- the XHR / fetch wrappers ---- */

var FILTERS_URL = /\/Items\/Filters\?/i;

/* The /Items/Filters body, with a long Tags list replaced by its window. */
function windowResponse(raw, url) {
    var body = JSON.parse(raw);
    if (!body || !Array.isArray(body.Tags)) {
        return raw;
    }

    var parentId = queryParam(url, 'parentid')[0];
    var key = listKey(parentId, queryParam(url, 'includeitemtypes'));
    var e = noteFullList(key, body.Tags);
    if (!e.windowed) {
        return raw;
    }

    body.Tags = windowTags(key, parentId);
    body.GuWindow = true;
    log('tag list windowed from response: ' + e.full.length + ' -> ' + body.Tags.length);
    return JSON.stringify(body);
}

export function installLibraryFilterHooks() {
    try {
        if (window.XMLHttpRequest) {
            var proto = window.XMLHttpRequest.prototype;
            var originalOpen = proto.open;
            var originalSend = proto.send;

            proto.open = function (method, url) {
                try {
                    var out = rewriteLibraryUrl(url);
                    this.__jellyfinPlusLibUrl = out;
                    if (out !== url) {
                        var args = Array.prototype.slice.call(arguments);
                        args[1] = out;
                        log('library filter url: ' + url + ' -> ' + out);
                        return originalOpen.apply(this, args);
                    }
                } catch (e) {
                    log('library filter open hook threw; sending the url unchanged', e);
                }

                return originalOpen.apply(this, arguments);
            };

            proto.send = function (body) {
                try {
                    var url = this.__jellyfinPlusLibUrl;
                    if (typeof url === 'string' && FILTERS_URL.test(url)) {
                        var xhr = this;
                        Object.defineProperty(xhr, 'responseText', {
                            configurable: true,
                            get: function () {
                                var raw = Object.getOwnPropertyDescriptor(
                                    window.XMLHttpRequest.prototype, 'responseText').get.call(xhr);
                                try {
                                    return windowResponse(raw, url);
                                } catch (err) {
                                    log('windowing the tag list failed; passing it through', err);
                                    return raw;
                                }
                            }
                        });
                    }
                } catch (e) {
                    log('library filter send hook threw', e);
                }

                return originalSend.call(this, body);
            };
        }

        if (window.fetch) {
            var originalFetch = window.fetch;
            window.fetch = function (input, init) {
                try {
                    if (typeof input === 'string') {
                        var out = rewriteLibraryUrl(input);
                        if (out !== input) {
                            log('library filter fetch: ' + input + ' -> ' + out);
                            return originalFetch.call(this, out, init);
                        }
                    } else if (input && typeof Request !== 'undefined' && input instanceof Request) {
                        var rewritten = rewriteLibraryUrl(input.url);
                        if (rewritten !== input.url) {
                            return originalFetch.call(this, new Request(rewritten, input), init);
                        }
                    }
                } catch (e) {
                    log('library filter fetch hook threw; sending the request unchanged', e);
                }

                return originalFetch.apply(this, arguments);
            };
        }

        log('library filter hooks installed');
    } catch (err) {
        log('library filter hooks failed', err);
    }
}

/* ---- studios and people: names for ids, and the typeahead ---- */

var NAMES_KEY = 'jellyfinPlus.libFilterNames';
var NAMES_MAX = 400;

function readNames() {
    try {
        return JSON.parse(window.localStorage.getItem(NAMES_KEY)) || {};
    } catch (e) {
        return {};
    }
}

export function nameOf(id) {
    return readNames()[id] || null;
}

function rememberNames(items) {
    try {
        var names = readNames();
        items.forEach(function (it) { names[it.Id] = it.Name; });
        var ids = Object.keys(names);
        if (ids.length > NAMES_MAX) {
            // Oldest-inserted first: object key order is insertion order for these string keys.
            ids.slice(0, ids.length - NAMES_MAX).forEach(function (id) { delete names[id]; });
        }

        window.localStorage.setItem(NAMES_KEY, JSON.stringify(names));
    } catch (e) { /* names are a convenience: an id is shown instead */ }
}

/* kind 'studio' | 'person' -> Promise of [{Id, Name}] matching term (empty term: the first few). */
export function searchEntities(kind, ctx, term) {
    var client = window.ApiClient;
    if (!client || typeof client.getUrl !== 'function' || typeof client.ajax !== 'function') {
        return Promise.resolve([]);
    }

    var params = {
        userId: client.getCurrentUserId(),
        limit: 40,
        enableImages: false,
        enableUserData: false,
        enableTotalRecordCount: false
    };
    if (term) {
        params.searchTerm = term;
    }

    if (kind === 'studio') {
        // A global search has no library: an empty parentId would be sent as a malformed Guid.
        if (ctx.parentId) {
            params.parentId = ctx.parentId;
        }

        if (ctx.itemType && ctx.itemType.length) {
            params.includeItemTypes = ctx.itemType.join(',');
        }
    }

    return client.ajax({
        type: 'GET',
        url: client.getUrl(kind === 'studio' ? 'Studios' : 'Persons', params),
        dataType: 'json'
    }).then(function (res) {
        var items = ((res && res.Items) || []).filter(function (it) { return it && it.Id && it.Name; });
        rememberNames(items);
        return items.map(function (it) { return { Id: it.Id, Name: it.Name }; });
    }, function (err) {
        log('library filter ' + kind + ' search failed', err);
        return [];
    });
}
