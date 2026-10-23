import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';
import { chunkItems } from '../model/search-paging.js';
import {
    CHUNK, pageOf, pageCount, pillText, currentPage, cardOptionsFor, supportsTab
} from '../model/library-infinite.js';
import { infState, onInfChanged, fetchNext, retryNext, infiniteEnabled } from '../controller/list-requests.js';
import { findFilterContext } from '../controller/library-filters.js';
import { getCardBuilder } from '../controller/detail-related.js';
import { addChunk, removeChunk } from './virtual-chunks.js';

/*
 * LIBRARY INFINITE SCROLL, DOM SIDE (the data and the requests are controller/list-requests.js, the
 * pure rules model/library-infinite.js; this is modelled on view/search-infinite.js).
 *
 * jellyfin-web's library tabs (the modern LibraryPage -> ItemsView) show ONE page of the library,
 * `libraryPageSize` items, with Previous / Next buttons in the toolbar. Here the stock page stays as
 * page 1, and the pages after it are drawn under it:
 *
 *  - Cards are made by jellyfin-web's own cardBuilder (found by shape, via detail-related.js) into
 *    `.jpChunk` wrappers inside the page's own `.itemsContainer`, with options rebuilt from the
 *    tab's saved view settings (what ItemsView.getCardOptions gives its React cards) and the shape
 *    the stock cards resolved to. They are ordinary cards: taps, the long-press menu, selection and
 *    the card-actions / badges observers all see them.
 *  - Bounded DOM: view/virtual-chunks.js empties chunks far from the screen and pins their height.
 *  - A status row after the last chunk is watched by an IntersectionObserver with a margin of two
 *    screens; reaching it fetches the next page. It says "Loading more...", "End of list", or after a
 *    failure offers a retry. After each load the observation is re-armed (a row still inside the
 *    margin reports nothing new on its own).
 *  - The stock Previous / Next buttons are hidden while this is active on a list that starts at the
 *    first page, and a fixed "Page N of M" pill takes their place. N follows the chunk under the
 *    reading line, so it is the page the viewer is actually looking at.
 *  - The stock view re-renders on a sort or filter change; that is a different request, so the
 *    controller's epoch changes and everything appended is discarded (discard() below). A chunk that
 *    React threw away without a new request (the page was left and re-entered) is noticed and the
 *    cache redrawn, as evicted placeholders so only the part near the screen is built.
 *
 * It activates only when it can prove what it is extending: a `.itemsContainer.vertical-wrap` that
 * holds a card of the first page's response, a cardBuilder, and the tab's settings handle (found by
 * shape, see controller/library-filters.js findFilterContext) with a tab that draws cards. Otherwise
 * nothing is touched and the stock pager stays.
 */

var STYLE_ID = 'jellyfinPlusLibraryInfiniteStyle';
var HIDE_CLASS = 'jpLibPagerOff';
var CONTAINER = '.itemsContainer.vertical-wrap';

var CSS = [
    CONTAINER + ' > .jpChunk { flex: 0 0 100%; max-width: 100%; box-sizing: border-box; display: flex; flex-flow: row wrap; }',
    CONTAINER + ' > .jpChunk[data-grid] { grid-column: 1 / -1; display: grid; grid-template-columns: inherit;'
        + ' column-gap: inherit; row-gap: inherit; }',
    CONTAINER + ' > .jpChunk[data-evicted] { display: block; }',
    CONTAINER + ' > .jpInfStatus { flex: 0 0 100%; display: block; min-height: 3em; margin: 0.5em 0 1.5em; padding: 0;'
        + ' border: 0; background: none; color: inherit; font: inherit; opacity: 0.7; text-align: center; }',
    CONTAINER + ' > .jpInfStatus[data-state=error] { opacity: 1; text-decoration: underline; cursor: pointer; }',
    '.' + HIDE_CLASS + ' { display: none !important; }',
    '.jpLibPill { position: fixed; left: 50%; z-index: 900; transform: translateX(-50%); pointer-events: none;'
        + ' bottom: calc(var(--jp-nav-h, 0px) + var(--jp-safe-bottom, env(safe-area-inset-bottom, 0px)) + 12px);'
        + ' padding: 0.45em 1em; border-radius: 999px; font-size: 0.85em; line-height: 1.2; white-space: nowrap;'
        + ' background: var(--jp-surface-2, rgba(32, 32, 32, 0.92)); color: var(--jp-text, #fff);'
        + ' border: 1px solid var(--jp-border, rgba(255, 255, 255, 0.2)); box-shadow: var(--jp-elev-2, 0 2px 8px rgba(0, 0, 0, 0.4));'
        + ' opacity: 0; transition: opacity var(--jp-dur, 0.2s) var(--jp-ease, ease); }',
    '.jpLibPill[data-on] { opacity: 1; }',
    'html.jp-sheet-open .jpLibPill, html.layout-tv .jpLibPill { display: none; }'
].join('\n');

var rec = null;
var denied = null;
var sentinelObserver = null;
var pill = null;

function isTv() {
    return document.documentElement.classList.contains('layout-tv');
}

function getSentinelObserver() {
    if (!sentinelObserver) {
        sentinelObserver = new IntersectionObserver(function (entries) {
            entries.forEach(function (e) {
                if (e.isIntersecting) {
                    load();
                }
            });
        }, { rootMargin: '200% 0px', threshold: 0 });
    }

    return sentinelObserver;
}

function load(retry) {
    (retry ? retryNext : fetchNext)().then(function () {
        requestAnimationFrame(function () {
            if (rec && rec.sentinel && rec.sentinel.isConnected) {
                var o = getSentinelObserver();
                o.unobserve(rec.sentinel);
                o.observe(rec.sentinel);
            }
        });
    });
}

/* ---- finding what we extend ---- */

/* The stock grid that holds a card of the first page's response (matched by item id, never by text). */
function findContainer(st) {
    var all = document.querySelectorAll(CONTAINER);
    for (var i = 0; i < all.length; i++) {
        var cards = all[i].querySelectorAll('.card[data-id]');
        for (var j = 0; j < cards.length && j < 12; j++) {
            if (String(cards[j].getAttribute('data-id')).toLowerCase() === st.firstId) {
                return all[i];
            }
        }
    }

    return null;
}

/* { viewType, parentId, ... } of the tab, from the toolbar's React fiber (by shape), or null. */
function tabContext() {
    var btns = document.querySelectorAll('.MuiToolbar-root button');
    for (var i = 0; i < btns.length; i++) {
        var ctx = findFilterContext(btns[i]);
        if (ctx) {
            return ctx;
        }
    }

    return null;
}

/* The tab's saved view settings (jellyfin-web's useLocalStorage blob, key "<viewType> - <parentId>"). */
function settingsOf(ctx) {
    try {
        return JSON.parse(window.localStorage.getItem(ctx.viewType + ' - ' + ctx.parentId)) || {};
    } catch (e) {
        return {};
    }
}

function settingsSig(s) {
    return [s.ImageType, s.ShowTitle, s.ShowYear, s.CardLayout, s.ViewMode].join('|');
}

function collectionType() {
    var m = /[?&]collectionType=([^&]+)/i.exec(window.location.hash || '');
    return m ? decodeURIComponent(m[1]) : '';
}

/* The shape jellyfin-web picked for the stock cards (cardPadder-<shape>), or ''. */
function shapeOf(container) {
    var pad = container.querySelector('[class*="cardPadder-"]');
    if (!pad) {
        return '';
    }

    var cls = pad.className.split(/\s+/);
    for (var i = 0; i < cls.length; i++) {
        if (cls[i].indexOf('cardPadder-') === 0) {
            return cls[i].slice('cardPadder-'.length);
        }
    }

    return '';
}

/* What n more cards measure here, for evicted placeholders drawn before layout; 0 when it cannot tell. */
function estimate(container, n) {
    var card = container.querySelector('.card');
    if (!card) {
        return 0;
    }

    var box = card.getBoundingClientRect();
    if (!(box.width > 0 && box.height > 0)) {
        return 0;
    }

    var cs = window.getComputedStyle(container);
    var inner = container.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    var cols = Math.max(1, Math.round(inner / box.width));
    var rows = Math.ceil(n / cols);
    return rows * box.height + (rows - 1) * (parseFloat(cs.rowGap) || 0);
}

/* ---- the DOM we add ---- */

function discard() {
    var r = rec;
    if (!r) {
        return;
    }

    r.chunks.forEach(removeChunk);
    if (r.sentinel) {
        if (sentinelObserver) {
            sentinelObserver.unobserve(r.sentinel);
        }

        if (r.sentinel.parentNode) {
            r.sentinel.parentNode.removeChild(r.sentinel);
        }
    }

    rec = null;
}

function setStockPager(hidden) {
    var icons = document.querySelectorAll('[data-testid="NavigateNextIcon"]');
    Array.prototype.forEach.call(icons, function (icon) {
        var group = icon.closest('.MuiButtonGroup-root');
        if (group) {
            group.classList.toggle(HIDE_CLASS, hidden);
        }
    });
    if (!hidden) {
        Array.prototype.forEach.call(document.querySelectorAll('.' + HIDE_CLASS), function (n) {
            n.classList.remove(HIDE_CLASS);
        });
    }
}

function teardown() {
    var had = !!rec;
    discard();
    if (had) {
        setStockPager(false);
    }

    if (pill) {
        pill.removeAttribute('data-on');
    }
}

function drawSlice(r, st, items, fromCache) {
    var cb = getCardBuilder();
    if (!cb) {
        log('library infinite: cardBuilder not found yet');
        return false;
    }

    var container = r.container;
    var shape = shapeOf(container);
    var opts = function () {
        return cardOptionsFor(r.ctx.viewType, r.settings, collectionType(), shape);
    };
    var render = function (chunkEl, its) {
        // Fresh options each call: cardBuilder writes into them.
        cb.buildCards(its, Object.assign(opts(), { itemsContainer: chunkEl }));
    };

    var offset = r.rendered;
    chunkItems(items, CHUNK).forEach(function (part) {
        var h = fromCache ? estimate(container, part.length) : 0;
        var c = addChunk(container, part, render, h);
        c.page = Math.min(pageCount(st.total, st.limit), pageOf(st.start + st.limit + offset, st.limit));
        r.chunks.push(c);
        offset += part.length;
    });
    return true;
}

function statusText(st) {
    if (st.error) {
        return 'Could not load more. Tap to retry.';
    }

    if (st.loading) {
        return 'Loading more…';
    }

    return st.done ? 'End of list' : '';
}

function ensureSentinel(r, st) {
    var container = r.container;
    if (st.done && !st.items.length && !st.loading) {
        // A one-page library: nothing was added, so there is nothing to say.
        if (r.sentinel && r.sentinel.parentNode) {
            r.sentinel.parentNode.removeChild(r.sentinel);
        }

        return;
    }

    if (!r.sentinel) {
        r.sentinel = el('button', 'jpInfStatus');
        r.sentinel.type = 'button';
        r.sentinel.addEventListener('click', function () {
            if (infState().error) {
                load(true);
            }
        });
        getSentinelObserver().observe(r.sentinel);
    }

    // Always the last child: React may have appended its own nodes, or a chunk was added after it.
    if (r.sentinel.parentNode !== container || container.lastChild !== r.sentinel) {
        container.appendChild(r.sentinel);
    }

    var text = statusText(st);
    if (r.sig !== text) {
        r.sig = text;
        r.sentinel.textContent = text;
        r.sentinel.setAttribute('data-state', st.error ? 'error' : (st.loading ? 'loading' : (st.done ? 'done' : 'idle')));
        r.sentinel.disabled = !st.error;
    }
}

function ensurePill() {
    if (!pill) {
        pill = el('div', 'jpLibPill');
        pill.setAttribute('role', 'status');
        pill.setAttribute('aria-live', 'off');
    }

    if (!pill.isConnected) {
        document.body.appendChild(pill);
    }

    return pill;
}

function updatePill() {
    try {
        var st = infState();
        if (!rec) {
            return;
        }

        var pages = pageCount(st.total, st.limit);
        var p = ensurePill();
        if (pages < 2) {
            p.removeAttribute('data-on');
            return;
        }

        var tops = rec.chunks.map(function (c) { return { page: c.page, top: c.el.getBoundingClientRect().top }; });
        var page = currentPage(pageOf(st.start, st.limit), tops, window.innerHeight * 0.35);
        var text = pillText(page, pages);
        if (p.textContent !== text) {
            p.textContent = text;
        }

        p.setAttribute('data-on', '1');
    } catch (err) {
        log('library infinite pill failed', err);
    }
}

function scan() {
    try {
        var st = infState();
        if (isTv() || !infiniteEnabled() || !st.ready) {
            teardown();
            return;
        }

        var container = findContainer(st);
        if (!container) {
            teardown();
            return;
        }

        if (rec && (rec.epoch !== st.epoch || rec.container !== container || rec.rendered > st.items.length
            || rec.chunks.some(function (c) { return !c.el.isConnected; }))) {
            discard();
        }

        if (!rec) {
            if (denied && denied.epoch === st.epoch && denied.container === container) {
                return;
            }

            if (!getCardBuilder()) {
                // Without it nothing could be drawn, and the stock pager must stay usable.
                return;
            }

            var ctx = tabContext();
            var settings = ctx ? settingsOf(ctx) : null;
            if (!ctx || !supportsTab(ctx.viewType, settings)) {
                denied = { epoch: st.epoch, container: container };
                return;
            }

            rec = {
                epoch: st.epoch, container: container, ctx: ctx, settings: settings, sig: '', sentinel: null,
                chunks: [], rendered: 0, grid: false, seen: settingsSig(settings)
            };
        } else {
            // The viewer changed how cards look (title, year, image type): redraw from the cache.
            var now = settingsOf(rec.ctx);
            if (settingsSig(now) !== rec.seen) {
                if (now.ViewMode === 'list') {
                    teardown();
                    return;
                }

                var keep = { ctx: rec.ctx, epoch: rec.epoch, container: rec.container };
                discard();
                rec = {
                    epoch: keep.epoch, container: keep.container, ctx: keep.ctx, settings: now, sig: '', sentinel: null,
                    chunks: [], rendered: 0, grid: false, seen: settingsSig(now)
                };
            }
        }

        var grid = window.getComputedStyle(container).display === 'grid';
        if (grid !== rec.grid) {
            rec.grid = grid;
            rec.chunks.forEach(function (c) {
                if (grid) { c.el.setAttribute('data-grid', '1'); } else { c.el.removeAttribute('data-grid'); }
            });
        }

        if (rec.rendered < st.items.length) {
            var fromCache = rec.rendered === 0 && st.items.length > CHUNK * 2;
            if (!drawSlice(rec, st, st.items.slice(rec.rendered), fromCache)) {
                log('library infinite: could not draw ' + (st.items.length - rec.rendered) + ' items');
            }

            rec.rendered = st.items.length;
            if (grid) {
                rec.chunks.forEach(function (c) { c.el.setAttribute('data-grid', '1'); });
            }
        }

        ensureSentinel(rec, st);
        // Only a list that starts at the first page can be walked with the pill alone.
        setStockPager(st.start === 0 && pageCount(st.total, st.limit) > 1);
        updatePill();
    } catch (err) {
        log('library infinite sync failed', err);
    }
}

export function installLibraryInfinite() {
    try {
        if (!document.getElementById(STYLE_ID)) {
            var style = el('style');
            style.id = STYLE_ID;
            style.textContent = CSS;
            (document.head || document.documentElement).appendChild(style);
        }

        var pending = false;
        var schedule = function () {
            // Coalesced: React commits many mutations at once and one scan covers them all.
            if (pending) {
                return;
            }

            pending = true;
            requestAnimationFrame(function () {
                pending = false;
                scan();
            });
        };

        new MutationObserver(schedule).observe(document.body || document.documentElement,
            { childList: true, subtree: true });
        onInfChanged(schedule);

        var framed = false;
        document.addEventListener('scroll', function () {
            if (framed || !rec) {
                return;
            }

            framed = true;
            requestAnimationFrame(function () {
                framed = false;
                updatePill();
            });
        }, { capture: true, passive: true });

        window.addEventListener('hashchange', schedule);
        schedule();
        log('library infinite installed');
    } catch (err) {
        log('library infinite failed to install', err);
    }
}
