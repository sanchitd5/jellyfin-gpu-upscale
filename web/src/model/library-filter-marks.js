/*
 * THE LIBRARY FILTER'S EXTRA STATE, CARRIED INSIDE jellyfin-web's OWN FILTER STATE.
 *
 * The modern library page keeps its filters in one useLocalStorage object per library tab
 * (LibraryViewSettings.Filters), and every request is built from it. That object has no field for
 * "exclude this tag", "require all of these tags" or "this person" - and a field added from
 * outside would never reach the request. But Filters.Tags is a plain string array that is already
 * persisted, part of the React Query key (so a change refetches and results are cached per
 * state), cleared by the stock reset button (in the library toolbar since jellyfin-web 12.3, PR #8568;
 * it sets Filters to undefined), and sent as the `tags` parameter.
 *
 * So the extra state rides in that array as MARKER entries - strings no real tag can equal -
 * and rewriteLibraryUrl() lifts them back out of the outgoing request into the parameters the
 * server patch (src/patcher/LibraryFilterPatches.cs, plus the stock personIds) understands:
 *
 *   MARK x:<tag name> END   -> excludeTagNames=<tag name>            (one parameter per tag)
 *   MARK all: END           -> tagMatch=all
 *   MARK p:<person id> END  -> personIds=<id>[,<id>...]
 *
 * Every marker ends in END, so it is self-delimiting however the array was joined into the URL
 * (the SDK uses `|`, the legacy API client a comma): a tag name may contain either.
 *
 * FAIL-CLOSED. A marker that is never rewritten (the script not loaded, a request path this does
 * not see) reaches the server as a tag nothing has: an empty listing, not a wrong one. Markers
 * are removed from every URL that carries them, whether or not the path takes the new
 * parameters, so one cannot leak into an endpoint that would treat it as a real tag.
 */

export var MARK_START = '\u0001gu:';
var END = '\u0002';

// One marker, plus a single separator after it, so removing it leaves the other tags joined.
var MARK_ANY = /\u0001gu:([a-z]+):([^\u0002]*)\u0002[|,]?/g;
var MARK_ONE = /^\u0001gu:([a-z]+):([^\u0002]*)\u0002$/;

export function mark(kind, payload) {
    return MARK_START + kind + ':' + (payload || '') + END;
}

export function isMark(s) {
    return typeof s === 'string' && s.indexOf(MARK_START) === 0;
}

/* A Filters.Tags array, split into the real tags and the state riding along with them. */
export function parseTags(list) {
    var out = { tags: [], exclude: [], people: [], all: false };
    (Array.isArray(list) ? list : []).forEach(function (t) {
        if (typeof t !== 'string') {
            return;
        }

        if (!isMark(t)) {
            out.tags.push(t);
            return;
        }

        var m = MARK_ONE.exec(t);
        if (!m) {
            return;
        }

        if (m[1] === 'x') {
            out.exclude.push(m[2]);
        } else if (m[1] === 'p') {
            out.people.push(m[2]);
        } else if (m[1] === 'all') {
            out.all = true;
        }
    });
    return out;
}

/* The inverse of parseTags: the array to store back as Filters.Tags (empty when nothing is set). */
export function buildTags(p) {
    return p.tags
        .concat(p.exclude.map(function (n) { return mark('x', n); }))
        .concat(p.people.map(function (id) { return mark('p', id); }))
        .concat(p.all ? [mark('all')] : []);
}

function decode(s) {
    return decodeURIComponent(String(s).replace(/\+/g, ' '));
}

function hasMarks(url) {
    return url.indexOf(MARK_START) !== -1 || /%01gu(%3a|:)/i.test(url);
}

/*
 * Rewrites one outgoing URL. Anything without a marker comes back as the very same string, so the
 * common case costs one indexOf. On a path ending in /Items the markers become the parameters
 * above; on any other path they are simply removed.
 */
export function rewriteLibraryUrl(url) {
    if (typeof url !== 'string' || !hasMarks(url)) {
        return url;
    }

    try {
        var q = url.indexOf('?');
        if (q === -1) {
            return url;
        }

        var base = url.slice(0, q);
        var rest = url.slice(q + 1);
        var hash = '';
        var h = rest.indexOf('#');
        if (h !== -1) {
            hash = rest.slice(h);
            rest = rest.slice(0, h);
        }

        var kept = [];
        var tagsAt = -1;
        var tagValues = [];
        rest.split('&').forEach(function (piece) {
            var eq = piece.indexOf('=');
            var key = decode(eq === -1 ? piece : piece.slice(0, eq)).toLowerCase();
            if (key === 'tags' && eq !== -1) {
                if (tagsAt === -1) {
                    tagsAt = kept.length;
                }

                tagValues.push(decode(piece.slice(eq + 1)));
            } else if (piece !== '') {
                kept.push(piece);
            }
        });

        var exclude = [];
        var people = [];
        var all = false;
        var real = [];
        tagValues.forEach(function (value) {
            var removed = false;
            var stripped = value.replace(MARK_ANY, function (whole, kind, payload) {
                removed = true;
                if (kind === 'x') {
                    exclude.push(payload);
                } else if (kind === 'p') {
                    people.push(payload);
                } else if (kind === 'all') {
                    all = true;
                }

                return '';
            });
            // "a|b|<marker>" leaves "a|b|": drop the separator the marker was hanging on.
            if (removed) {
                stripped = stripped.replace(/[|,]$/, '');
            }

            if (stripped !== '') {
                real.push(stripped);
            }
        });

        var tagPieces = real.map(function (v) { return 'tags=' + encodeURIComponent(v); });
        var extra = [];
        if (/\/items$/i.test(base)) {
            exclude.forEach(function (n) { extra.push('excludeTagNames=' + encodeURIComponent(n)); });
            if (all) {
                extra.push('tagMatch=all');
            }

            if (people.length) {
                extra.push('personIds=' + people.map(encodeURIComponent).join(','));
            }
        }

        var at = tagsAt === -1 ? kept.length : tagsAt;
        var pieces = kept.slice(0, at).concat(tagPieces, kept.slice(at), extra);
        return base + (pieces.length ? '?' + pieces.join('&') : '') + hash;
    } catch (e) {
        return url;
    }
}
