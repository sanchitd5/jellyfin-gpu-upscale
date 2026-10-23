/*
 * THE EMPTY SEARCH PAGE'S "SUGGESTIONS", MADE TO INCLUDE CLIPS (pure; controller/search-recent.js
 * documents the rest, network.js calls this from the shared request hook).
 *
 * jellyfin-web 12.1's useSearchSuggestions asks for 20 random items, favourites first, of the types
 * Movie, Series and MusicArtist. A library of Home Videos has none of those, so the list is an empty
 * "Suggestions" heading. This adds Video to that request's includeItemTypes and nothing else, so a
 * mixed library keeps its movies and series and a clip library gets clips.
 *
 * The request is recognised by its SHAPE, not by a module: an /Items path, no searchTerm, a sortBy
 * naming both IsFavoriteOrLiked and Random, and an includeItemTypes naming Movie, Series and
 * MusicArtist. Anything else comes back as the very same string, so a changed stock request means
 * "no suggestions for clips", never a broken one. Both wire forms are handled: the SDK's repeated
 * key (includeItemTypes=Movie&includeItemTypes=Series) and one comma-separated value; the server's
 * binder (CommaDelimitedCollectionModelBinder) splits commas only in the single-value form, so
 * Video is added in whichever form the request already uses.
 */

var WANT = ['movie', 'series', 'musicartist'];

function nameOf(piece) {
    var eq = piece.indexOf('=');
    try {
        return decodeURIComponent((eq === -1 ? piece : piece.slice(0, eq)).replace(/\+/g, ' ')).toLowerCase();
    } catch (e) {
        return '';
    }
}

function valueOf(piece) {
    var eq = piece.indexOf('=');
    if (eq === -1) {
        return '';
    }

    try {
        return decodeURIComponent(piece.slice(eq + 1).replace(/\+/g, ' '));
    } catch (e) {
        return '';
    }
}

/* The lowercase values of every `name` pair, comma lists split. */
function valuesOf(pieces, name) {
    var out = [];
    pieces.forEach(function (p) {
        if (nameOf(p) === name) {
            valueOf(p).split(',').forEach(function (v) {
                v = v.trim().toLowerCase();
                if (v) {
                    out.push(v);
                }
            });
        }
    });
    return out;
}

export function suggestVideoUrl(url) {
    if (typeof url !== 'string') {
        return url;
    }

    var q = url.indexOf('?');
    if (q === -1 || !/\/items$/i.test(url.slice(0, q))) {
        return url;
    }

    var rest = url.slice(q + 1);
    var hash = '';
    var h = rest.indexOf('#');
    if (h !== -1) {
        hash = rest.slice(h);
        rest = rest.slice(0, h);
    }

    var pieces = rest.split('&').filter(function (p) { return p !== ''; });
    if (pieces.some(function (p) { return nameOf(p) === 'searchterm'; })) {
        return url;
    }

    var sorts = valuesOf(pieces, 'sortby');
    if (sorts.indexOf('isfavoriteorliked') === -1 || sorts.indexOf('random') === -1) {
        return url;
    }

    var types = valuesOf(pieces, 'includeitemtypes');
    if (types.indexOf('video') !== -1 || !WANT.every(function (w) { return types.indexOf(w) !== -1; })) {
        return url;
    }

    var typePieces = pieces.filter(function (p) { return nameOf(p) === 'includeitemtypes'; });
    var out;
    if (typePieces.length === 1) {
        // One comma-separated value: extend it, keeping the spelling of its separator.
        var last = typePieces[0];
        var sep = /%2c/i.test(last) ? '%2C' : ',';
        out = pieces.map(function (p) { return p === last ? p + sep + 'Video' : p; });
    } else {
        out = pieces.concat(['includeItemTypes=Video']);
    }

    return url.slice(0, q) + '?' + out.join('&') + hash;
}
