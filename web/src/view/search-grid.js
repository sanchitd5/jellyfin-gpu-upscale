import { log } from '../lib/log.js';

/*
 * SEARCH RESULTS AS A VERTICAL GRID, ON PHONES AND ON DESKTOP.
 *
 * jellyfin-web 12.1 renders each search section (Movies, Episodes, ...) as a horizontal
 * emby-scroller of cardBuilder cards (SearchResultsRow.tsx), sized in vw for sideways scrolling.
 * That is one swipe axis per section and only a handful of cards visible at once, on a phone and
 * on a desktop alike. This restyles exactly those sections - scoped to #searchPage .searchResults,
 * nothing else - so the page scrolls vertically over a grid of cards.
 *
 *  - up to 50em wide (a phone, in either orientation): two columns;
 *  - wider (desktop, tablet): as many columns as fit, `repeat(auto-fill, minmax(<card>, 1fr))`,
 *    with a wider minimum for landscape cards (backdrops, episode thumbs, videos) than for portrait
 *    and square ones, so a section reads as roughly 4 to 8 across at common window widths.
 *
 * CSS only, on purpose: the scroller and the cards stay jellyfin-web's own, so focus handling,
 * card menus and lazy image loading keep working untouched. On non-TV layouts the scroller runs in
 * native mode (the frame gets .scrollX, the slider an inline `white-space: nowrap`), so overriding
 * overflow and the slider's display is all it takes; the !important flags beat that inline style
 * and the vw widths from card.scss.
 *
 * The card shape is read off the cards themselves (every card carries a `cardPadder-<shape>`
 * element), with :has() on the container; a browser without :has() keeps the portrait minimum for
 * every section, which still works, just with smaller thumbnails in landscape sections.
 *
 * TV layouts (html.layout-tv) are left alone: their D-pad navigation relies on the horizontal rows.
 */

var STYLE_ID = 'jellyfinPlusSearchGridStyle';

var NON_TV = 'html:not(.layout-tv) #searchPage .searchResults';
var SLIDER = NON_TV + ' .itemsContainer.scrollSlider';

// Shared by both widths: turn the scroller into a plain, wrapping block holding a grid.
var COMMON = [
    NON_TV + ' [is="emby-scroller"], ' + NON_TV + ' .emby-scroller {'
        + ' overflow: visible !important; white-space: normal !important; }',
    SLIDER + ' {'
        + ' display: grid !important;'
        + ' column-gap: 0.8em; row-gap: 0.2em;'
        + ' white-space: normal !important;'
        + ' transform: none !important;'
        + ' width: auto !important; }',
    // `.card` anywhere below the slider, not only directly: infinite scroll (view/search-infinite.js)
    // keeps the cards it appends in `.jpChunk` wrappers.
    SLIDER + ' .card {'
        + ' width: auto !important; max-width: none !important; min-width: 0; }',
    // jellyfin offsets each card's box to align the first one with the heading; in a grid
    // that offset only skews the columns.
    SLIDER + ' .card > .cardBox {'
        + ' margin-left: 0 !important; margin-right: 0 !important; }',
    // A chunk is a full-width grid on the very same columns, so its cards line up with the ones
    // jellyfin drew; an evicted one (virtual-chunks.js) is an empty block pinned to its old height.
    SLIDER + ' > .jpChunk {'
        + ' grid-column: 1 / -1; display: grid; grid-template-columns: inherit; column-gap: inherit; row-gap: inherit; }',
    SLIDER + ' > .jpChunk[data-evicted] { display: block; }',
    NON_TV + ' .emby-scrollbuttons { display: none !important; }'
].join('\n');

var PHONE = SLIDER + ' { grid-template-columns: repeat(2, minmax(0, 1fr)); }';

// Card minimums in em, so they follow the viewer's font size. Landscape cards need to be wider than
// portrait ones for the same readable thumbnail.
var DESKTOP = [
    SLIDER + ' { --jp-card-min: 14em; grid-template-columns: repeat(auto-fill, minmax(var(--jp-card-min), 1fr)); }',
    SLIDER + ':has(.cardPadder-backdrop), ' + SLIDER + ':has(.cardPadder-overflowBackdrop) { --jp-card-min: 18em; }',
    SLIDER + ':has(.cardPadder-banner), ' + SLIDER + ':has(.cardPadder-overflowBanner) { --jp-card-min: 24em; }'
].join('\n');

export function installSearchGrid() {
    try {
        if (document.getElementById(STYLE_ID)) {
            return;
        }

        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = COMMON
            + '\n@media (max-width: 50em) {\n' + PHONE + '\n}'
            + '\n@media (min-width: 50.01em) {\n' + DESKTOP + '\n}';
        (document.head || document.documentElement).appendChild(style);
        log('search grid style installed');
    } catch (err) {
        log('search grid style failed', err);
    }
}
