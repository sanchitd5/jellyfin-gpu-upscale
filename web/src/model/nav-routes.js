/*
 * Pure route logic for the bottom bar (P3). Hash form, as the stock router produces it.
 * Spec: redesign-nav-decision.md, proved against jellyfin-web v12.3.
 */

export var PUBLIC_PATHS = ['addserver', 'selectserver', 'login', 'forgotpassword', 'forgotpasswordpin',
    'wizardremoteaccess', 'wizardfinish', 'wizardstart', 'wizardsettings', 'wizardlibrary', 'wizarduser'];

var LIBRARY_PATHS = ['movies', 'tv', 'music', 'livetv', 'books', 'homevideos', 'musicvideos', 'boxsets',
    'playlists', 'mixed', 'list'];
var MORE_PATHS = ['queue', 'lyrics', 'userprofile', 'quickconnect'];

/* '#/home?tab=1' -> { path: 'home', query: URLSearchParams } */
export function parseHash(hash) {
    var h = String(hash || '').replace(/^#\/?/, '');
    var q = h.indexOf('?');
    var path = (q === -1 ? h : h.slice(0, q)).toLowerCase().replace(/\.html$/, '');
    return { path: path, query: new URLSearchParams(q === -1 ? '' : h.slice(q + 1)) };
}

/* Which slot is current: home | libraries | search | favourites | more | null. */
export function activeSlot(hash) {
    var p = parseHash(hash);
    if (p.path === 'home') {
        var tab = p.query.get('tab');
        if (tab === '1') { return 'favourites'; }
        return !tab || tab === '0' ? 'home' : null;
    }
    if (p.path === 'search') { return 'search'; }
    if (LIBRARY_PATHS.indexOf(p.path) !== -1) { return 'libraries'; }
    if (MORE_PATHS.indexOf(p.path) !== -1 || /^(mypreferences|dashboard|metadata)/.test(p.path)) { return 'more'; }
    return null;
}

export function isVideoPath(hash) { return parseHash(hash).path === 'video'; }
export function isPublicPath(hash) { return PUBLIC_PATHS.indexOf(parseHash(hash).path) !== -1; }

var MODERN_TYPES = ['books', 'musicvideos', 'boxsets', 'playlists'];

/* Href for one /UserViews item; `modern` = the modern (MUI) app is running. */
export function libraryHref(view, modern) {
    var id = encodeURIComponent(view.Id);
    var t = view.CollectionType;
    var list = '#/list?parentId=' + id + '&serverId=' + encodeURIComponent(view.ServerId || '');
    if (t === 'movies') { return '#/movies?topParentId=' + id + '&collectionType=movies'; }
    if (t === 'tvshows') { return '#/tv?topParentId=' + id + '&collectionType=tvshows'; }
    if (t === 'music') { return '#/music?topParentId=' + id + '&collectionType=music'; }
    if (t === 'livetv') { return '#/livetv'; }
    if (!modern) { return list; }
    if (t === 'homevideos') { return '#/homevideos?topParentId=' + id; }
    if (MODERN_TYPES.indexOf(t) !== -1) { return '#/' + t + '?topParentId=' + id + '&collectionType=' + t; }
    if (!t && view.Type === 'CollectionFolder') { return '#/mixed?topParentId=' + id + '&collectionType=mixed'; }
    return list;
}

var ICONS = { movies: 'movie', tvshows: 'tv', music: 'library_music', livetv: 'live_tv', books: 'book',
    homevideos: 'video_library', musicvideos: 'music_video', boxsets: 'collections', playlists: 'queue_music' };
export function libraryIcon(type) { return ICONS[type] || 'folder'; }
