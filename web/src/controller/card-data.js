import { log } from '../lib/log.js';
import { badgeInfo } from '../model/card-badges.js';

/*
 * PER-CARD DATA, LOOKED UP LAZILY (shared by view/card-actions.js and view/card-badges.js).
 *
 * jellyfin-web's cards carry no favourite flag, no resolution, no tags. Rather than widening every
 * list request (Fields=Tags alone is ~60 KB on a 100-card page of this library, paid whether or not
 * the cards are ever seen), a card is watched with an IntersectionObserver and, once it is near the
 * screen, its id joins a small batch that is looked up in ONE plain item query:
 *
 *     GET /Users/{id}/Items?Ids=<up to 40>&Fields=Tags,Width,Height&EnableImages=false ...
 *
 * UserData and RunTimeTicks are in the default DTO. The answer is reduced to a small record per item
 * (model/card-badges.js badgeInfo) and cached for the page's lifetime, so a card that is redrawn
 * (virtualised chunks, React re-render) costs nothing.
 *
 * Badges can be switched off by setting localStorage `jellyfinPlus.cardBadges` to `off`; the lookup
 * then asks for no extra Fields (the favourite hearts still need it).
 */

var LOOKUP_BATCH = 40;
var LOOKUP_DELAY_MS = 150;
var CACHE_MAX = 4000;
export var BADGES_KEY = 'jellyfinPlus.cardBadges';

var cache = new Map();
var pending = new Set();
var timer = null;
var listeners = [];
var observer = null;
var watched = new WeakSet();

export function badgesEnabled() {
    try {
        return window.localStorage.getItem(BADGES_KEY) !== 'off';
    } catch (e) {
        return true;
    }
}

export function apiClient() {
    var c = window.ApiClient;
    return c && typeof c.getCurrentUserId === 'function' ? c : null;
}

/* The card's server is the one ApiClient talks to (a multi-server setup is left alone). */
export function sameServer(serverId) {
    var c = apiClient();
    try {
        return !!c && (typeof c.serverId !== 'function' || !serverId || c.serverId() === serverId);
    } catch (err) {
        return false;
    }
}

/* The record for an item once it has been looked up, else null. */
export function cardInfo(id) {
    return cache.get(id) || null;
}

/* fn(id, info) runs when a lookup brings a record for an item. */
export function onCardInfo(fn) {
    listeners.push(fn);
}

function remember(id, info) {
    cache.set(id, info);
    if (cache.size > CACHE_MAX) {
        cache.delete(cache.keys().next().value);
    }
}

function flush() {
    timer = null;
    var c = apiClient();
    if (!c || typeof c.getItems !== 'function' || !pending.size) {
        pending.clear();
        return;
    }

    var ids = Array.from(pending).filter(function (id) { return !cache.has(id); });
    pending.clear();
    var fields = badgesEnabled() ? 'Tags,Width,Height' : undefined;
    for (var i = 0; i < ids.length; i += LOOKUP_BATCH) {
        var chunk = ids.slice(i, i + LOOKUP_BATCH);
        try {
            var query = {
                Ids: chunk.join(','),
                EnableImages: false,
                EnableTotalRecordCount: false,
                Limit: chunk.length
            };
            if (fields) {
                query.Fields = fields;
            }

            Promise.resolve(c.getItems(c.getCurrentUserId(), query)).then(function (res) {
                ((res && res.Items) || []).forEach(function (it) {
                    var info = it && it.Id && !cache.has(it.Id) ? badgeInfo(it) : null;
                    if (!info) {
                        return;
                    }

                    remember(it.Id, info);
                    listeners.forEach(function (fn) {
                        try {
                            fn(it.Id, info);
                        } catch (err) {
                            log('card data: listener failed', err);
                        }
                    });
                });
            }).catch(function (err) { log('card data: lookup failed', err); });
        } catch (err) {
            log('card data: lookup threw', err);
        }
    }
}

function want(id) {
    if (cache.has(id)) {
        return;
    }

    pending.add(id);
    if (!timer) {
        timer = setTimeout(flush, LOOKUP_DELAY_MS);
    }
}

/* Looks the card's item up once the card is (about to be) on screen. Idempotent per card. */
export function watchCard(card) {
    var id = card && card.getAttribute && card.getAttribute('data-id');
    if (!id || watched.has(card)) {
        return;
    }

    watched.add(card);
    if (typeof IntersectionObserver === 'undefined') {
        want(id);
        return;
    }

    if (!observer) {
        observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (en) {
                if (en.isIntersecting) {
                    observer.unobserve(en.target);
                    var id2 = en.target.getAttribute('data-id');
                    if (id2) {
                        want(id2);
                    }
                }
            });
        }, { rootMargin: '300px 0px' });
    }

    observer.observe(card);
}
