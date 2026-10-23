import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';
import { CHUNK, cardOptionsFor, shapeForType, typeTitle } from '../model/search-paging.js';
import { chunkSize, headCount, planRows } from '../model/row-fill.js';
import { infOf, fetchMore } from '../controller/search-pager.js';
import { getCardBuilder } from '../controller/detail-related.js';
import { addChunk, addHead, removeChunk, measureColumns, stockCount, estimateChunkHeight } from './virtual-chunks.js';

/*
 * INFINITE SCROLL, DOM SIDE. The data is controller/search-pager.js (`infOf(kind).items`, the
 * ordered cache of everything fetched after the first slice; fetchMore()); view/search-pager.js
 * calls syncInfinite() for each kind on every scan, handing it the section(s) jellyfin-web drew.
 *
 *  - Cards are drawn with jellyfin-web's own cardBuilder (found by shape, via detail-related.js),
 *    into `.jpChunk` elements inside the section's own `.itemsContainer`, with the options and shape
 *    of the cards already there. They are therefore ordinary cards: taps and the long-press menu go
 *    through the container's delegated handlers, the card-actions buttons are added by its mutation
 *    observer, and buildCards registers each chunk's images with jellyfin's lazy loader (an
 *    IntersectionObserver, 50% margin: a card's image is requested only when it is near the screen,
 *    and the loader itself blanks images that scroll far away).
 *  - The all-types query is one request split into sections by Type; its appended items go to the
 *    section of their Type, and a Type with no section yet gets one built like jellyfin-web's own,
 *    under an English title, placed after the last one.
 *  - Bounded DOM: see view/virtual-chunks.js. Chunks far from the screen are emptied and pinned.
 *  - A sentinel under the last section is watched by an IntersectionObserver with a margin of two
 *    screens; reaching it calls fetchMore(). It also says "Loading", "End of results" or, after a
 *    failure, offers a retry. After each load the observation is re-armed, because a list that is
 *    still short of the margin would otherwise never report again.
 *  - React can throw our chunks away (it replaced the cards, or the page was left and re-entered):
 *    the record notices a chunk that is no longer in the document and redraws the whole cache,
 *    as evicted placeholders so only the part near the screen is actually built.
 */

var SECTION_HTML = '<h2 class="sectionTitle sectionTitle-cards focuscontainer-x padded-left padded-right"></h2>'
    + '<div is="emby-scroller" data-horizontal="true" data-centerfocus="card" class="padded-top-focusscale padded-bottom-focusscale">'
    + '<div is="emby-itemscontainer" class="focuscontainer-x itemsContainer scrollSlider"></div></div>';

var rec = { video: null, all: null };
var sentinelObserver = null;

function freshRec(epoch) {
    // groups: per Type, the cards still owed to a row and the column count the rows were cut for.
    return {
        epoch: epoch, rendered: 0, chunks: [], heads: [], groups: {}, created: [], createdBy: {}, sentinel: null,
        sig: '', host: null
    };
}

var resizeObserver = null;
var widths = new WeakMap();

/* A width change is what can change a column count: re-sync the kinds whose sections are on screen. */
function watchWidth(container) {
    if (typeof ResizeObserver === 'undefined' || widths.has(container)) {
        return;
    }

    if (!resizeObserver) {
        resizeObserver = new ResizeObserver(function (entries) {
            var changed = false;
            entries.forEach(function (e) {
                var w = e.contentRect.width;
                if (widths.get(e.target) !== w) {
                    widths.set(e.target, w);
                    changed = true;
                }
            });
            if (changed) {
                Object.keys(rec).forEach(function (kind) {
                    var r = rec[kind];
                    if (r && r.host && r.host.last && r.host.last.isConnected) {
                        syncInfinite(kind, r.host);
                    }
                });
            }
        });
    }

    widths.set(container, container.clientWidth);
    resizeObserver.observe(container);
}

function getSentinelObserver() {
    if (!sentinelObserver) {
        sentinelObserver = new IntersectionObserver(function (entries) {
            entries.forEach(function (e) {
                if (e.isIntersecting) {
                    load(e.target.getAttribute('data-kind'));
                }
            });
        }, { rootMargin: '200% 0px', threshold: 0 });
    }

    return sentinelObserver;
}

function load(kind) {
    var st = infOf(kind);
    if (!st || st.loading || st.done || st.error) {
        return;
    }

    fetchMore(kind).then(function () {
        // Re-arm: a sentinel still inside the margin reports nothing new on its own.
        requestAnimationFrame(function () {
            var r = rec[kind];
            if (r && r.sentinel && r.sentinel.isConnected) {
                var o = getSentinelObserver();
                o.unobserve(r.sentinel);
                o.observe(r.sentinel);
            }
        });
    });
}

function sliderOf(section) {
    return section.querySelector('.itemsContainer.scrollSlider');
}

/* The shape jellyfin-web picked for the cards in a container (cardPadder-<shape>), or ''. */
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

function typeOf(section) {
    var card = section.querySelector('.itemsContainer .card[data-type]');
    return card ? card.getAttribute('data-type') : '';
}

function discard(kind) {
    var r = rec[kind];
    if (!r) {
        return;
    }

    r.chunks.forEach(removeChunk);
    r.heads.forEach(function (h) {
        if (h.parentNode) {
            h.parentNode.removeChild(h);
        }
    });
    r.created.forEach(function (s) {
        if (s.parentNode) {
            s.parentNode.removeChild(s);
        }
    });
    if (r.sentinel) {
        if (sentinelObserver) {
            sentinelObserver.unobserve(r.sentinel);
        }

        if (r.sentinel.parentNode) {
            r.sentinel.parentNode.removeChild(r.sentinel);
        }
    }

    rec[kind] = null;
}

/* The section for a Type in the all-types query, built like jellyfin-web's if it is not there yet. */
function sectionFor(host, r, type) {
    if (r.createdBy[type]) {
        return r.createdBy[type];
    }

    for (var i = 0; i < host.sections.length; i++) {
        if (typeOf(host.sections[i]) === type) {
            return host.sections[i];
        }
    }

    var sec = el('div', 'verticalSection');
    sec.innerHTML = SECTION_HTML;
    sec.querySelector('h2').textContent = typeTitle(type);
    var last = tailOf(host, r);
    last.parentNode.insertBefore(sec, last.nextSibling);
    r.created.push(sec);
    r.createdBy[type] = sec;
    return sec;
}

/* The last section of the kind, ours included: where the sentinel belongs. */
function tailOf(host, r) {
    return r.created.length ? r.created[r.created.length - 1] : host.last;
}

function drawGroup(kind, host, r, type, items, fromCache) {
    var cb = getCardBuilder();
    if (!cb) {
        log('search infinite: cardBuilder not found yet');
        return false;
    }

    var section = kind === 'video' ? host.last : sectionFor(host, r, type);
    var container = sliderOf(section);
    if (!container) {
        return false;
    }

    var shape = shapeOf(container) || shapeForType(kind === 'video' ? 'Video' : type);
    var render = function (chunkEl, its) {
        // Fresh options each call: cardBuilder writes into them.
        cb.buildCards(its, Object.assign(cardOptionsFor(kind, type, shape), { itemsContainer: chunkEl }));
    };

    var g = r.groups[type] = r.groups[type] || { carry: [], need: -1, cols: 0, container: container };
    var cols = measureColumns(container);
    if (!cols) {
        // Nothing laid out (a hidden page): keep the items back; the next sync places them.
        g.carry = g.carry.concat(items);
        return true;
    }

    g.cols = cols;
    g.container = container;
    watchWidth(container);
    // Every boundary on a row edge: close the stock grid's last row first, then whole-row chunks, and
    // keep under one row back for the next fetch (shown for good only when the list is over).
    if (g.need < 0) {
        g.need = headCount(stockCount(container), cols);
    }

    var plan = planRows(g.carry.concat(items), cols, chunkSize(cols, CHUNK), g.need, infOf(kind).done);
    g.need = plan.headLeft;
    g.carry = plan.carry;
    if (plan.head.length) {
        r.heads.push(addHead(container, plan.head, render));
    }

    plan.chunks.forEach(function (part) {
        var estimate = fromCache ? estimateChunkHeight(container, part.length) : 0;
        r.chunks.push(addChunk(container, part, render, estimate));
    });
    return true;
}

function draw(kind, host, r, items, fromCache) {
    if (kind === 'video') {
        return drawGroup(kind, host, r, 'Video', items, fromCache);
    }

    var order = [];
    var byType = {};
    // A group holding carried items is revisited even with nothing new (the list may be over now).
    Object.keys(r.groups).forEach(function (t) {
        if (r.groups[t].carry.length) {
            byType[t] = [];
            order.push(t);
        }
    });
    items.forEach(function (it) {
        var t = it.Type || '';
        if (!byType[t]) {
            byType[t] = [];
            order.push(t);
        }

        byType[t].push(it);
    });
    var ok = true;
    order.forEach(function (t) {
        ok = drawGroup(kind, host, r, t, byType[t], fromCache) && ok;
    });
    return ok;
}

/* True when a group's container now has a different column count than its rows were cut for. */
function columnsMoved(r) {
    return Object.keys(r.groups).some(function (t) {
        var g = r.groups[t];
        if (!g.cols || !g.container || !g.container.isConnected) {
            return false;
        }

        var now = measureColumns(g.container);
        return now > 0 && now !== g.cols;
    });
}

function statusText(kind, st) {
    if (st.error) {
        return 'Could not load more. Tap to retry.';
    }

    if (st.loading) {
        return 'Loading more…';
    }

    return st.done ? 'End of results' : '';
}

function ensureSentinel(kind, host, r, st) {
    if (!r.sentinel) {
        r.sentinel = el('button', 'jpInfStatus');
        r.sentinel.type = 'button';
        r.sentinel.setAttribute('data-kind', kind);
        r.sentinel.addEventListener('click', function () {
            var s = infOf(kind);
            if (s.error) {
                s.error = false;
                load(kind);
            }
        });
        getSentinelObserver().observe(r.sentinel);
    }

    // Always the last child of the last section, which moves when a section is added.
    var tail = tailOf(host, r);
    if (r.sentinel.parentNode !== tail || tail.lastChild !== r.sentinel) {
        tail.appendChild(r.sentinel);
    }

    var text = statusText(kind, st);
    if (r.sig !== text) {
        r.sig = text;
        r.sentinel.textContent = text;
        r.sentinel.setAttribute('data-state', st.error ? 'error' : (st.loading ? 'loading' : (st.done ? 'done' : 'idle')));
        r.sentinel.disabled = !st.error;
    }
}

/*
 * Brings the DOM of one kind in line with its cache. `host` = { sections: [el], first, last }, the
 * sections jellyfin-web drew for this kind. Idempotent: it only touches the DOM when something
 * changed, so the mutation observer that calls it cannot feed on its own edits.
 */
export function syncInfinite(kind, host) {
    try {
        var st = infOf(kind);
        var r = rec[kind];
        if (r && (r.epoch !== st.epoch || r.rendered > st.items.length
            || r.chunks.some(function (c) { return !c.el.isConnected; })
            || r.created.some(function (s) { return !s.isConnected; })
            || columnsMoved(r))) {
            discard(kind);
            r = null;
        }

        r = rec[kind] = r || freshRec(st.epoch);
        r.host = host;
        var owed = Object.keys(r.groups).some(function (t) {
            return r.groups[t].carry.length && (st.done || !r.groups[t].cols);
        });
        if (r.rendered < st.items.length || owed) {
            var fromCache = r.rendered === 0 && st.loadedPages > 2;
            if (!draw(kind, host, r, st.items.slice(r.rendered), fromCache)) {
                // No cardBuilder or no section to draw into: give these items up rather than
                // retry on every mutation (the retry's own edits would re-trigger it).
                log('search infinite: could not draw ' + (st.items.length - r.rendered) + ' items');
            }

            r.rendered = st.items.length;
        }

        ensureSentinel(kind, host, r, st);
    } catch (err) {
        log('search infinite sync failed', err);
    }
}

/* Paged mode, or the results went away: take everything this module added out of the page. */
export function teardownInfinite(kind) {
    discard(kind);
}
