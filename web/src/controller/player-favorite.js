import { log } from '../lib/log.js';
import { currentItem } from './player-item.js';

/*
 * THE FAVOURITE (HEART) TOGGLE IN THE PLAYER OSD: reflects the current item's UserData.IsFavorite
 * and flips it through stock's own API, window.ApiClient.updateFavoriteStatus(userId, itemId, bool)
 * (the call jellyfin-web's own heart buttons make; it resolves to the new UserData). The state is
 * the server's: the item is fetched once per item id (getItem(userId, id)), the toggle sets the
 * answer the server returned, and nothing is stored on the client.
 *
 * Unavailable (button hidden) when the item id, the user id or the API methods cannot be found.
 */

var RETRY_MS = 10000;

var cache = { id: null, fav: null, at: 0, busy: false };

function api() {
    var c = window.ApiClient;
    if (c && typeof c.getCurrentUserId === 'function' && typeof c.getItem === 'function'
        && typeof c.updateFavoriteStatus === 'function') {
        return c;
    }

    return null;
}

/*
 * Refreshes for the current item and returns { available, id, fav } right now (fav is null while
 * the answer is in flight). onChange is called when a fetch lands.
 */
export function syncFavorite(onChange) {
    var item = currentItem();
    var id = item && item.Id;
    var c = api();
    if (!id || !c) {
        cache = { id: null, fav: null, at: 0, busy: false };
        return { available: false, id: null, fav: null };
    }

    if (cache.id !== id) {
        var seed = item.UserData && typeof item.UserData.IsFavorite === 'boolean' ? item.UserData.IsFavorite : null;
        cache = { id: id, fav: seed, at: 0, busy: false };
    }

    if (!cache.busy && cache.at === 0 || (cache.fav === null && !cache.busy && Date.now() - cache.at > RETRY_MS)) {
        cache.busy = true;
        cache.at = Date.now();
        var asked = id;
        try {
            Promise.resolve(c.getItem(c.getCurrentUserId(), id)).then(function (full) {
                if (cache.id !== asked) { return; }
                cache.busy = false;
                cache.fav = !!(full && full.UserData && full.UserData.IsFavorite);
                if (onChange) { onChange(); }
            }).catch(function () {
                if (cache.id === asked) { cache.busy = false; }
            });
        } catch (err) {
            cache.busy = false;
        }
    }

    return { available: true, id: id, fav: cache.fav };
}

/* Flips the favourite flag; resolves when the server answered (or silently when it could not). */
export function toggleFavorite(onChange) {
    var c = api();
    var id = cache.id;
    if (!c || !id || cache.busy) { return Promise.resolve(); }
    cache.busy = true;
    var want = !cache.fav;
    return Promise.resolve(c.updateFavoriteStatus(c.getCurrentUserId(), id, want)).then(function (ud) {
        if (cache.id === id) {
            cache.fav = ud && typeof ud.IsFavorite === 'boolean' ? ud.IsFavorite : want;
        }
    }).catch(function (err) {
        log('player favorite: toggle failed', err);
    }).then(function () {
        if (cache.id === id) { cache.busy = false; }
        if (onChange) { onChange(); }
    });
}
