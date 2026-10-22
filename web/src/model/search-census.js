/*
 * WHICH SEARCH REQUESTS CAN NOT MATCH ANYTHING (pure; controller/search-census.js does the wiring).
 *
 * The census (GET /JellyfinPlus/Library/Census) says which item kinds the user has at all. The
 * search page fires one request per kind of result - artists, people, studios, programs, videos and
 * the all-types list - whether or not the library has any such thing. A request is dropped only
 * when its answer is PROVABLY empty:
 *
 *   - every kind it can return is one the census covers (DECIDABLE), and
 *   - none of those kinds has an item.
 *
 * A kind the census does not cover is never assumed absent, so a kind this file has not heard of
 * can only ever cost a request, never hide a result.
 */

// Kinds the server's census is authoritative for: library-resident kinds (counted under the user's
// libraries) and the by-name / outside-the-library kinds it counts library-wide by type.
var DECIDABLE = {};
[
    'Movie', 'Series', 'Season', 'Episode', 'Video', 'MusicVideo', 'Trailer', 'Audio', 'MusicAlbum',
    'MusicArtist', 'AudioBook', 'Book', 'Photo', 'PhotoAlbum', 'BoxSet', 'Playlist', 'Person', 'Studio',
    'Genre', 'MusicGenre', 'TvChannel', 'LiveTvProgram'
].forEach(function (k) { DECIDABLE[k.toLowerCase()] = k; });

// What /Artists lists: artists are derived from music, so any of these means it may answer.
var ARTIST_KINDS = ['MusicArtist', 'Audio', 'MusicAlbum'];

// What the Videos query (mediaTypes=Video, minus Movie/Episode/TvChannel) can return.
var VIDEO_KINDS = ['Video', 'MusicVideo', 'Trailer', 'LiveTvProgram'];

/* { path (lowercase, no query), q: { lowercase name: [values] } } for a relative or absolute url. */
export function parts(url) {
    var s = String(url);
    var hash = s.indexOf('#');
    if (hash !== -1) {
        s = s.slice(0, hash);
    }

    var qi = s.indexOf('?');
    var path = (qi === -1 ? s : s.slice(0, qi)).replace(/\/+$/, '');
    var q = {};
    if (qi !== -1) {
        s.slice(qi + 1).split('&').forEach(function (piece) {
            if (!piece) {
                return;
            }

            var eq = piece.indexOf('=');
            try {
                var name = decodeURIComponent((eq === -1 ? piece : piece.slice(0, eq)).replace(/\+/g, ' ')).toLowerCase();
                var val = eq === -1 ? '' : decodeURIComponent(piece.slice(eq + 1).replace(/\+/g, ' '));
                (q[name] = q[name] || []).push(val);
            } catch (e) { /* an undecodable parameter is not one we act on */ }
        });
    }

    return { path: path.toLowerCase(), rawPath: path, q: q };
}

function list(q, name) {
    var out = [];
    (q[name] || []).forEach(function (v) {
        v.split(',').forEach(function (p) {
            p = p.trim();
            if (p) { out.push(p); }
        });
    });
    return out;
}

function present(counts, kind) {
    return !!(counts && counts[kind] > 0);
}

function lacksAll(counts, kinds) {
    return kinds.every(function (k) { return !present(counts, k); });
}

/*
 * 'skip' when this request provably returns nothing for a user whose kinds are `counts`
 * ({ Kind: n }), else null. Only search requests are considered: /Artists, /Persons, /Studios and
 * /Items with a searchTerm.
 */
export function verdict(url, counts) {
    if (!counts) {
        return null;
    }

    var p = parts(url);
    var last = p.path.slice(p.path.lastIndexOf('/') + 1);

    if (last === 'artists') {
        return lacksAll(counts, ARTIST_KINDS) ? 'skip' : null;
    }

    if (last === 'persons') {
        return lacksAll(counts, ['Person']) ? 'skip' : null;
    }

    if (last === 'studios') {
        return lacksAll(counts, ['Studio']) ? 'skip' : null;
    }

    if (last !== 'items' || !p.q.searchterm || !p.q.searchterm[0]) {
        return null;
    }

    var include = list(p.q, 'includeitemtypes');
    if (include.length) {
        var kinds = [];
        for (var i = 0; i < include.length; i++) {
            var k = DECIDABLE[include[i].toLowerCase()];
            if (!k) {
                return null;
            }

            kinds.push(k);
        }

        return lacksAll(counts, kinds) ? 'skip' : null;
    }

    var media = list(p.q, 'mediatypes');
    if (media.length === 1 && media[0].toLowerCase() === 'video' && list(p.q, 'excludeitemtypes').length) {
        return lacksAll(counts, VIDEO_KINDS) ? 'skip' : null;
    }

    return null;
}

var NIL = '00000000-0000-0000-0000-000000000000';

/*
 * The request to send INSTEAD of a skipped one: the same server, the same user, an /Items query for
 * an id that does not exist. It returns the stock result shape ({ Items: [], TotalRecordCount: 0 })
 * for nothing more than an id lookup, so the page's React code receives exactly what an empty
 * search would have given it.
 */
export function nullRequest(url) {
    var p = parts(url);
    var cut = p.rawPath.lastIndexOf('/');
    var base = cut === -1 ? '' : p.rawPath.slice(0, cut);
    var out = base + '/Items?ids=' + NIL + '&limit=1&enableTotalRecordCount=false&enableImages=false&enableUserData=false';
    if (p.q.userid && p.q.userid[0]) {
        out += '&userId=' + encodeURIComponent(p.q.userid[0]);
    }

    return out;
}
