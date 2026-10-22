import { log } from '../lib/log.js';

/*
 * SEARCHING INSIDE A HOME VIDEOS (OR SIMILAR) LIBRARY FINDS NOTHING - STOCK jellyfin-web 12.1 BUG.
 *
 * The toolbar's search button (apps/modern/components/AppToolbar/SearchButton.tsx) carries the
 * current library into the search page as ?parentId=...&collectionType=.... With a collectionType
 * set, useSearchItems:
 *   - disables the Videos query outright (useVideoSearch: `enabled: ... && !collectionType`), and
 *   - asks for getItemTypesFromCollectionType(collectionType), whose default list (anything but
 *     movies / tvshows / music) has no Video and no MusicVideo.
 * So in a homevideos, musicvideos, mixed or photos library, a clip - BaseItemKind Video - can never
 * be returned, whatever the search term. Verified live: a homevideos library whose Video items
 * matched by tag returned 0 results.
 *
 * Fix: on the search page, a collectionType outside the ones jellyfin-web actually handles is
 * dropped from the URL, keeping parentId. The page then searches like the global search but
 * scoped to that library: the Videos query runs (with parentId), and so does the all-types query.
 * location.replace swaps the history entry, so Back does not bounce through the broken URL, and
 * it fires hashchange, which is what the HashRouter listens to. Covers every way in: the toolbar
 * button, a pasted link, a reload.
 */

// The collection types jellyfin-web's search handles correctly (its own switch cases, plus the
// ones whose default type list already covers their content and that hold no Video items).
var HANDLED = { movies: 1, tvshows: 1, music: 1, livetv: 1, books: 1, boxsets: 1, playlists: 1 };

function fixScope() {
    try {
        var hash = window.location.hash || '';
        if (!/^#\/search(\?|$)/.test(hash)) {
            return;
        }

        var q = hash.indexOf('?');
        if (q === -1) {
            return;
        }

        var params = new URLSearchParams(hash.slice(q + 1));
        var type = (params.get('collectionType') || '').toLowerCase();
        if (!type || HANDLED[type]) {
            return;
        }

        params.delete('collectionType');
        var rest = params.toString();
        var url = window.location.href.split('#')[0] + '#/search' + (rest ? '?' + rest : '');
        log('search scope: collectionType=' + type + ' would hide Video items; dropping it');
        window.location.replace(url);
    } catch (err) {
        log('search scope fix failed', err);
    }
}

export function installSearchScopeFix() {
    window.addEventListener('hashchange', fixScope);
    fixScope();
}
