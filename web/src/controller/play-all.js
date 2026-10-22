import { log } from '../lib/log.js';

/*
 * PLAY ALL / SHUFFLE: THE 300 CAP, AND HOME VIDEOS FOLDERS THAT QUEUE ONLY PHOTOS.
 *
 * Both live in jellyfin-web 12.1's components/playback/playbackmanager.js, and both are decided
 * inside a request the manager builds itself, so the fix is a rewrite of that one request on its
 * way out - the same seam search-exclude.js uses, installed as a second layer over fetch and XHR
 * so neither network.js nor the existing hooks change.
 *
 *  - getItemsForPlayback() (:147-152) gives every multi-item query `Limit = query.Limit || 300`.
 *    A tag, person or studio with more than 300 clips therefore stops after 300. The request is
 *    recognisable: it asks for `Fields=Chapters,MediaSources,Trickplay` with
 *    `ExcludeLocationTypes=Virtual` and `EnableTotalRecordCount=false`, a combination nothing
 *    else sends. Limit=300 on such a request becomes PLAY_ALL_LIMIT.
 *  - getNonItemTypePromise() (:1953-1962), for a folder whose CollectionType is homevideos, asks
 *    for `MediaTypes=Photo` "because we do not handle mixed queues" - so Play and Shuffle on a
 *    Home Videos folder queue its photos and none of its videos. It is the only playback query
 *    that is Recursive with MediaTypes=Photo exactly (the photo album one is not recursive, the
 *    single-photo one asks Photo,Video), so that signature becomes MediaTypes=Video,Photo - the
 *    same mixed queue the single-photo case already builds (:1936).
 *
 * Only the query string is edited, token by token, so the rest of the URL is byte-for-byte what
 * the client built. A URL that does not match is returned as the very same string.
 */

// Items per Play all / Shuffle queue. Each queued entry carries Chapters + MediaSources +
// Trickplay, a few KB, so this bounds the response at a few MB rather than the whole library.
var PLAY_ALL_LIMIT = 1000;
var STOCK_LIMIT = '300';

var ITEMS_PATH = /\/Items\/?(\?|$)/i;

function decode(s) {
    try {
        return decodeURIComponent(s.replace(/\+/g, ' '));
    } catch (e) {
        return s;
    }
}

/* Returns the rewritten URL, or the same string when this is not one of the two queries. */
export function rewritePlaybackQueryUrl(url) {
    if (typeof url !== 'string' || !ITEMS_PATH.test(url)) {
        return url;
    }

    var q = url.indexOf('?');
    if (q < 0) {
        return url;
    }

    var hash = url.indexOf('#');
    var end = hash >= 0 ? hash : url.length;
    var tokens = url.slice(q + 1, end).split('&');

    var params = Object.create(null);
    tokens.forEach(function (t) {
        var eq = t.indexOf('=');
        var name = decode(eq < 0 ? t : t.slice(0, eq)).toLowerCase();
        // A repeated name (Fields=a&Fields=b) reads the same as Fields=a,b.
        var value = decode(eq < 0 ? '' : t.slice(eq + 1));
        params[name] = params[name] === undefined ? value : params[name] + ',' + value;
    });

    var fields = (params.fields || '').toLowerCase();
    var isPlaybackQuery = fields.indexOf('chapters') >= 0 && fields.indexOf('mediasources') >= 0
        && (params.excludelocationtypes || '').toLowerCase() === 'virtual'
        && (params.enabletotalrecordcount || '').toLowerCase() === 'false';
    if (!isPlaybackQuery) {
        return url;
    }

    var raiseLimit = params.limit === STOCK_LIMIT;
    var mixHomeVideos = (params.mediatypes || '').toLowerCase() === 'photo'
        && (params.recursive || '').toLowerCase() === 'true'
        && !!params.parentid && params.limit === undefined;
    if (!raiseLimit && !mixHomeVideos) {
        return url;
    }

    var out = tokens.map(function (t) {
        var eq = t.indexOf('=');
        var name = decode(eq < 0 ? t : t.slice(0, eq)).toLowerCase();
        if (raiseLimit && name === 'limit') {
            return t.slice(0, eq + 1) + PLAY_ALL_LIMIT;
        }

        if (mixHomeVideos && name === 'mediatypes') {
            return t.slice(0, eq + 1) + 'Video,Photo';
        }

        return t;
    });

    return url.slice(0, q + 1) + out.join('&') + url.slice(end);
}

function mark(url) {
    try {
        var out = rewritePlaybackQueryUrl(url);
        if (out !== url) {
            log('play-all: rewrote a playback query', url, '->', out);
        }

        return out;
    } catch (err) {
        log('play-all: rewrite failed', err);
        return url;
    }
}

export function installPlayAllFix() {
    try {
        if (window.fetch && !window.fetch.__jellyfinPlusPlayAll) {
            var previousFetch = window.fetch;
            var wrappedFetch = function (input, init) {
                if (typeof input === 'string') {
                    var marked = mark(input);
                    if (marked !== input) {
                        return previousFetch.call(this, marked, init);
                    }
                }

                return previousFetch.apply(this, arguments);
            };
            wrappedFetch.__jellyfinPlusPlayAll = true;
            window.fetch = wrappedFetch;
        }

        var proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
        if (proto && !proto.open.__jellyfinPlusPlayAll) {
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
            wrappedOpen.__jellyfinPlusPlayAll = true;
            proto.open = wrappedOpen;
        }

        log('play-all fix installed');
    } catch (err) {
        log('play-all fix install failed', err);
    }
}
