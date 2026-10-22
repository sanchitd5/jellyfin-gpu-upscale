import { log } from '../lib/log.js';

/*
 * A WINDOW OF THE TAG LIST FROM THE SERVER.
 *
 * GET /Items/Filters takes jpTagLimit (how many tags) and jpTagQuery (case- and diacritic-insensitive
 * substring) and answers the first matching tags in the usual sorted order, with the number that
 * matched in the X-JellyfinPlus-TagTotal header. A library with 12,000 tags is then a few KB per
 * keystroke instead of ~450 KB per page load. Shared by the library filter popover and the search
 * page's Sort & filter sheet.
 *
 * A server without the parameters (older plugin, route unpatched) ignores them and returns the whole
 * list and no header; this then does the narrowing itself, so callers see one behaviour either way.
 */

export var TOTAL_HEADER = 'X-JellyfinPlus-TagTotal';

/* Case- and diacritic-insensitive, like the server's clean value. */
export function normalize(s) {
    try {
        return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    } catch (e) {
        return String(s).toLowerCase();
    }
}

/* What a window of a full list is: used when the server did not window it. */
export function localWindow(tags, query, limit) {
    var q = normalize(query || '').trim();
    var out = [];
    var total = 0;
    for (var i = 0; i < tags.length; i++) {
        if (q && normalize(tags[i]).indexOf(q) === -1) {
            continue;
        }

        total++;
        if (out.length < limit) {
            out.push(tags[i]);
        }
    }

    return { tags: out, total: total };
}

function authHeaders(client) {
    var token = typeof client.accessToken === 'function' ? client.accessToken() : null;
    return token ? { Authorization: 'MediaBrowser Token="' + token + '"' } : null;
}

/*
 * Promise of { tags, total } for opts { parentId, itemTypes (array or comma string), query, limit }.
 * `total` counts every match, `tags` is at most `limit` of them. Rejects when the request fails.
 */
export function fetchTagWindow(opts) {
    var client = window.ApiClient;
    if (!client || typeof client.getUrl !== 'function' || typeof client.ajax !== 'function') {
        return Promise.reject(new Error('no ApiClient'));
    }

    var limit = opts.limit;
    var query = (opts.query || '').trim();
    var params = { userId: client.getCurrentUserId(), jpTagLimit: limit };
    if (opts.parentId) {
        params.parentId = opts.parentId;
    }

    var types = Array.isArray(opts.itemTypes) ? opts.itemTypes.join(',') : (opts.itemTypes || '');
    if (types) {
        params.includeItemTypes = types;
    }

    if (query) {
        params.jpTagQuery = query;
    }

    var url = client.getUrl('Items/Filters', params);
    var headers = window.fetch ? authHeaders(client) : null;
    var done = function (tags, header) {
        tags = (tags || []).filter(function (t) { return typeof t === 'string' && t; });
        var total = header == null || header === '' ? NaN : parseInt(header, 10);
        if (isNaN(total)) {
            // No count: the server did not window this. Narrow it here.
            return localWindow(tags, query, limit);
        }

        return { tags: tags, total: total };
    };

    if (!headers) {
        // No token to build a request by hand: the client's own call, which hides response headers.
        return client.ajax({ type: 'GET', url: url, dataType: 'json' }).then(function (res) {
            return done(res && res.Tags, null);
        });
    }

    return window.fetch(url, { headers: headers, credentials: 'same-origin' }).then(function (res) {
        if (!res.ok) {
            throw new Error('tags ' + res.status);
        }

        return res.json().then(function (body) {
            return done(body && body.Tags, res.headers.get(TOTAL_HEADER));
        });
    }).then(function (w) {
        log('tag window: ' + w.tags.length + ' of ' + w.total + (query ? ' matching "' + query + '"' : ''));
        return w;
    });
}
