import { log } from '../lib/log.js';
import { isLazyLoaderClass, isImageUrl, enabled, createQueue, PRELOAD_MARGIN } from '../model/image-preload.js';

/*
 * Smoother card images (see model/image-preload.js for the why and the measurements).
 *
 * Found by shape: every module export that is a LazyLoader-shaped class (createObserver, addElements,
 * destroyObserver). The 12.3 build carries three copies; each prototype is patched once. Per loader:
 *   1. a second IntersectionObserver with a much wider margin queues the cards' `data-src` image URLs
 *      for an early, low-priority fetch (nearest to the viewport first, a few at a time);
 *   2. a card image that scrolls out of range is no longer emptied, so coming back to it does not
 *      fetch and fade it in again. Only elements actually showing an image are kept; genre rows,
 *      which use the same loader for other content, behave exactly as stock.
 * Nothing changes the URL stock asks for, so what the early fetch caches is what stock then uses.
 * Off switch: localStorage jellyfinPlus.imagePreload = off. TV layout untouched.
 */

var queue = null;

function getQueue() {
    if (!queue) {
        queue = createQueue(function (url) {
            return new Promise(function (resolve) {
                var img = new Image();
                var timer = setTimeout(resolve, 15000);
                img.decoding = 'async';
                if ('fetchPriority' in img) {
                    img.fetchPriority = 'low';
                }
                img.onload = img.onerror = function () {
                    clearTimeout(timer);
                    resolve();
                };
                img.src = url;
            });
        });
    }
    return queue;
}

function showsImage(el) {
    if (!el || el.getAttribute('data-src')) {
        return false;
    }
    return el.tagName === 'IMG' ? !!el.getAttribute('src') : /url\(/.test(el.style.backgroundImage || '');
}

function onAhead(entries) {
    var q = getQueue();
    var mid = window.innerHeight / 2;
    var batch = [];
    entries.forEach(function (entry) {
        var url = entry.target && entry.target.getAttribute('data-src');
        if (!isImageUrl(url)) {
            return;
        }
        if (entry.isIntersecting) {
            var r = entry.boundingClientRect;
            batch.push({ url: url, d: Math.abs(r.top + r.height / 2 - mid) });
        } else {
            q.drop(url);
        }
    });
    // One observer callback delivers a whole screenful; the queue starts loads as they arrive, so
    // hand it the batch nearest-first or the first free slots go to whatever the DOM listed first.
    batch.sort(function (a, b) { return a.d - b.d; }).forEach(function (x) { q.add(x.url, x.d); });
}

function patch(Cls) {
    var proto = Cls.prototype;
    if (proto.__jellyfinPlusPreload) {
        return;
    }
    proto.__jellyfinPlusPreload = true;

    var createObserver = proto.createObserver;
    var addElements = proto.addElements;
    var destroyObserver = proto.destroyObserver;

    proto.createObserver = function () {
        if (document.documentElement.classList.contains('layout-tv')) {
            return createObserver.apply(this, arguments);
        }
        var opts = this.options;
        if (opts && typeof opts.callback === 'function' && !opts.callback.__jellyfinPlus) {
            var cb = opts.callback;
            opts.callback = function (entry, observer) {
                // Stock empties a loaded image on the way out; keep it instead.
                if (entry && !entry.isIntersecting && showsImage(entry.target)) {
                    return undefined;
                }
                return cb.apply(this, arguments);
            };
            opts.callback.__jellyfinPlus = true;
        }
        var res = createObserver.apply(this, arguments);
        try {
            if (!this.__jpAhead && typeof IntersectionObserver === 'function') {
                this.__jpAhead = new IntersectionObserver(onAhead, { rootMargin: PRELOAD_MARGIN, threshold: 0 });
            }
        } catch (err) {
            log('image preload: observer failed', err);
        }
        return res;
    };

    proto.addElements = function (elements) {
        var res = addElements.apply(this, arguments);
        try {
            var ahead = this.__jpAhead;
            if (ahead && elements) {
                Array.from(elements).forEach(function (el) {
                    ahead.observe(el);
                });
            }
        } catch (err) {
            log('image preload: observe failed', err);
        }
        return res;
    };

    proto.destroyObserver = function () {
        if (this.__jpAhead) {
            this.__jpAhead.disconnect();
            this.__jpAhead = null;
        }
        return destroyObserver.apply(this, arguments);
    };

    log('image preload: patched a lazy loader');
}

var active = false;

function scan(obj, depth) {
    Object.keys(obj).forEach(function (k) {
        var v;
        try {
            v = obj[k];
        } catch (e) {
            return;
        }
        if (isLazyLoaderClass(v)) {
            patch(v);
        } else if (depth > 0 && v && typeof v === 'object' && !Array.isArray(v)) {
            scan(v, depth - 1);
        }
    });
}

/*
 * Called by webpack-hook.js with every module's exports. The class is not a top-level export: the
 * 12.3 build (module 99891) exports `lazyChildren` and sets the default export to
 * `{LazyLoader, lazyChildren}`, so look one level into object-valued exports as well.
 */
export function noteLazyLoader(exports) {
    if (!active || !exports || typeof exports !== 'object') {
        return;
    }
    scan(exports, 1);
}

/* Runs before jellyfin-web's chunks evaluate; the TV layout is decided later, so it is checked per loader. */
export function installImagePreload() {
    if (!enabled(window.localStorage)) {
        log('image preload: switched off');
        return;
    }
    if (typeof IntersectionObserver !== 'function') {
        return;
    }
    active = true;
}
