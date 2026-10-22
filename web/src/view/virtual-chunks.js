/*
 * A VIRTUALISED RUN OF CARD CHUNKS. DOM only, no jellyfin imports, so it can be exercised alone in
 * a browser (the harness does).
 *
 * Infinite scroll appends a page after a page, and a long search is thousands of cards. Each card
 * is a few dozen nodes plus a lazy image, so an unbounded list is what makes a phone stutter and
 * finally reload the tab. Instead the appended cards live in CHUNKS (a `.jpChunk` element holding a
 * dozen cards, a whole number of rows on a phone's two columns). A chunk more than three viewport
 * heights from the screen is EVICTED: its cards are removed and the element is pinned to the exact
 * height it had, so the page does not move and the scrollbar does not jump. When it comes back
 * within three heights it is rebuilt from the items it still holds, at the same height.
 *
 * Why not `content-visibility: auto`: it skips rendering but keeps every node, so memory and style
 * recalculation still grow with the list, and iOS Safari before 18 ignores it. Evicting nodes is
 * the only thing that keeps the card count bounded.
 *
 * One IntersectionObserver with rootMargin 300% (of the viewport height) top and bottom decides
 * everything; there is no scroll handler. The chunk is measured immediately before it is evicted,
 * while it is still laid out, so the pinned height is the real one.
 */

var MARGIN = '300% 0px';

var records = new WeakMap();
var observer = null;

function getObserver() {
    if (!observer) {
        observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (e) {
                var rec = records.get(e.target);
                if (!rec) {
                    return;
                }

                if (e.isIntersecting) {
                    restore(rec);
                } else {
                    evict(rec);
                }
            });
        }, { rootMargin: MARGIN, threshold: 0 });
    }

    return observer;
}

function evict(rec) {
    if (!rec.live || !rec.el.isConnected) {
        return;
    }

    var h = rec.el.getBoundingClientRect().height;
    if (!(h > 0)) {
        // Not laid out (a hidden page): nothing to pin, nothing gained by emptying it.
        return;
    }

    rec.h = h;
    rec.el.style.height = h + 'px';
    rec.el.setAttribute('data-evicted', '1');
    rec.el.textContent = '';
    // cardBuilder skips re-rendering a container whose html it believes is already there.
    rec.el.cardBuilderHtml = null;
    rec.live = false;
}

function restore(rec) {
    if (rec.live) {
        return;
    }

    rec.el.removeAttribute('data-evicted');
    rec.el.style.height = '';
    rec.el.cardBuilderHtml = null;
    rec.render(rec.el, rec.items);
    rec.live = true;
}

/*
 * Adds a chunk at the end of `parent`. `render(el, items)` fills it. With `estimate` > 0 the chunk
 * starts evicted at that height (used when redrawing a long list from the cache: only the ones near
 * the screen are built); otherwise it is built now.
 */
export function addChunk(parent, items, render, estimate) {
    var el = document.createElement('div');
    el.className = 'jpChunk';
    parent.appendChild(el);

    var rec = { el: el, items: items, render: render, live: false, h: 0 };
    records.set(el, rec);
    if (estimate > 0) {
        el.setAttribute('data-evicted', '1');
        el.style.height = Math.round(estimate) + 'px';
    } else {
        render(el, items);
        rec.live = true;
    }

    getObserver().observe(el);
    return rec;
}

export function removeChunk(rec) {
    try {
        if (observer) {
            observer.unobserve(rec.el);
        }

        records.delete(rec.el);
        if (rec.el.parentNode) {
            rec.el.parentNode.removeChild(rec.el);
        }
    } catch (e) { /* already gone */ }
}

/*
 * What `n` cards would measure in `container` (a grid already holding at least one card), for
 * drawing evicted placeholders before anything has been laid out. 0 when it cannot tell, which
 * makes addChunk build the chunk instead.
 */
export function estimateChunkHeight(container, n) {
    var card = container.querySelector('.card');
    if (!card) {
        return 0;
    }

    var h = card.getBoundingClientRect().height;
    if (!(h > 0)) {
        return 0;
    }

    var cs = window.getComputedStyle(container);
    var cols = (cs.gridTemplateColumns || '').split(' ').filter(Boolean).length || 1;
    var gap = parseFloat(cs.rowGap) || 0;
    var rows = Math.ceil(n / cols);
    return rows * h + (rows - 1) * gap;
}
