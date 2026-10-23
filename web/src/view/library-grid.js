import { log } from '../lib/log.js';
import { columnsFor, shapeOf, DEFAULT_SHAPE } from '../model/grid-density.js';

/*
 * LIBRARY GRID DENSITY AND THE CARD TREATMENT (P6), PHONE AND TABLET TIERS.
 *
 * jellyfin-web sizes a wrapping card list with a table of em breakpoints (card.scss) and sizes the
 * requested images with getPostersPerRow; neither follows the width the grid really has. Here the
 * list becomes a CSS grid whose column count is columnsFor(width, shape) (model/grid-density.js:
 * a minimum card width per shape, as many columns as fit, never a fixed 2 or 3). Nothing is stored:
 * the density is recomputed from the container's own width on every resize and rotation.
 *
 * WHICH LISTS. Wrapping card lists (.itemsContainer.vertical-wrap) that hold cards: the modern
 * library tabs, the legacy list / tag / collection pages, favourites. Not the home sections, the
 * item page, or Search (view/search-grid.js owns it), and not a list the viewer put in list view
 * (.vertical-list). A marker class, .jpGrid, is what the CSS keys on, so anything this does not
 * recognise stays stock.
 *
 * WHEN. A phone or tablet tier (html.jp-phone / html.jp-tablet, set by view/mobile-theme.js), or,
 * until that exists, stock's own html.layout-mobile. Not on TV, not with html.jp-theme-off, not on
 * a desktop tier (the desktop grid stays stock).
 *
 * IMAGE SIZE. cardBuilder asks for image sizes from its own getPostersPerRow before this runs and
 * is not touched, so a column count that differs from stock changes only the CSS box the same image
 * is drawn in: no request changes, and 3 columns never fetch a larger image than 2 did.
 *
 * THE CARD. Under .jpGrid the card is a rounded picture with the title over the bottom of the image
 * (a scrim keeps it legible), the plugin's resolution/runtime chips at the top left
 * (view/card-badges.js), and the heart and "more" at the bottom right (view/card-actions.js; the
 * play button is dropped here because a tap on the picture already opens or plays). The footer
 * ignores pointer events so a tap on the title reaches the picture's own action.
 */

var STYLE_ID = 'jellyfinPlusLibraryGridStyle';
var GAP = 8;
var EXCLUDE = '.homePage, #searchPage, .itemDetailPage, .scrollSlider, .homeLibraryButtonContainer, [is="emby-scroller"]';

var CSS = [
    '.jpGrid { display: grid !important; flex-wrap: nowrap;'
        + ' grid-template-columns: repeat(var(--jp-cols, 2), minmax(0, 1fr)); gap: ' + GAP + 'px; }',
    // `.card` below the grid, not only directly: infinite scroll keeps appended cards in .jpChunk wrappers.
    '.jpGrid .card { width: auto !important; max-width: none !important; min-width: 0; }',
    '.jpGrid .card > .cardBox { margin: 0 !important; }',
    '.jpGrid > .jpChunk { grid-column: 1 / -1; display: grid; grid-template-columns: inherit; gap: inherit; }',
    '.jpGrid > .jpChunk[data-evicted] { display: block; }',

    '.jpGrid .card > .cardBox { position: relative; overflow: hidden;'
        + ' border-radius: var(--jp-radius-m, 8px); }',
    '.jpGrid .cardBox > .cardFooter { position: absolute; left: 0; right: 0; bottom: 0; z-index: 1; margin: 0;'
        // The bottom 44px is the heart / more row (view/card-actions.js), so the text sits above it.
        + ' box-sizing: border-box; padding: 24px 8px 44px; pointer-events: none; color: #fff;'
        + ' background: linear-gradient(to top, rgba(0,0,0,0.78), rgba(0,0,0,0)); }',
    '.jpGrid .cardBox > .cardFooter .cardText { color: inherit; padding: 0; white-space: nowrap; overflow: hidden;'
        + ' text-overflow: ellipsis; }',
    '.jpGrid .cardBox > .cardFooter .cardText-secondary { opacity: 0.8; font-size: var(--jp-font-small, 0.85em); }',
    '.jpGrid .jellyfinPlusCardActions [data-action="play"] { display: none; }'
].join('\n');

function cls() {
    return document.documentElement.classList;
}

function enabled() {
    var c = cls();
    if (c.contains('layout-tv') || c.contains('jp-theme-off') || c.contains('jp-desktop')) {
        return false;
    }

    // jp-desktop was ruled out above, so a missing tier class means the theme has not set one yet.
    return c.contains('jp-phone') || c.contains('jp-tablet') || c.contains('layout-mobile');
}

function contentWidth(node) {
    var s = window.getComputedStyle(node);
    return node.clientWidth - (parseFloat(s.paddingLeft) || 0) - (parseFloat(s.paddingRight) || 0);
}

function shapeIn(node) {
    var pad = node.querySelector('[class*="cardPadder-"]');
    if (!pad) {
        return DEFAULT_SHAPE;
    }

    var m = /cardPadder-[A-Za-z]+/.exec(pad.className);
    return shapeOf(m ? m[0] : '');
}

function qualifies(node) {
    return !node.closest(EXCLUDE) && !!node.querySelector('.card');
}

function apply(node) {
    var w = contentWidth(node);
    if (!(w > 0)) {
        return;
    }

    var rem = parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
    var n = String(columnsFor(w, shapeIn(node), GAP, rem));
    if (node.style.getPropertyValue('--jp-cols') !== n) {
        node.style.setProperty('--jp-cols', n);
    }
}

var resizer = null;
var tracked = new WeakSet();

function release(node) {
    node.classList.remove('jpGrid');
    node.style.removeProperty('--jp-cols');
}

function scan() {
    var on = enabled();
    var nodes = document.querySelectorAll('.itemsContainer.vertical-wrap, .jpGrid');
    for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (!on || !node.classList.contains('vertical-wrap') || !qualifies(node)) {
            if (node.classList.contains('jpGrid')) {
                release(node);
            }

            continue;
        }

        node.classList.add('jpGrid');
        if (resizer && !tracked.has(node)) {
            tracked.add(node);
            resizer.observe(node);
        }

        apply(node);
    }
}

var queued = false;
function schedule() {
    if (queued) {
        return;
    }

    queued = true;
    requestAnimationFrame(function () {
        queued = false;
        try {
            scan();
        } catch (err) {
            log('library grid: scan failed', err);
        }
    });
}

export function installLibraryGrid() {
    try {
        if (document.documentElement.classList.contains('layout-tv')) {
            return;
        }

        if (!document.getElementById(STYLE_ID)) {
            var style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = CSS;
            (document.head || document.documentElement).appendChild(style);
        }

        if (typeof ResizeObserver === 'function') {
            resizer = new ResizeObserver(schedule);
        }

        // Cards arrive and the shape becomes known after the container exists; the tier class and
        // the viewport change on rotation. Both are cheap to re-evaluate.
        new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
        new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        window.addEventListener('resize', schedule);
        window.addEventListener('orientationchange', schedule);
        schedule();
        log('library grid installed');
    } catch (err) {
        log('library grid install failed', err);
    }
}
