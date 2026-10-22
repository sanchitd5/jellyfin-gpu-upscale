import { log } from '../lib/log.js';

/*
 * SEARCH RESULTS AS A VERTICAL TWO-COLUMN GRID ON MOBILE.
 *
 * jellyfin-web 12.1 renders each search section (Movies, Episodes, ...) as a horizontal
 * emby-scroller of cardBuilder cards (SearchResultsRow.tsx), sized in vw for sideways scrolling.
 * On a phone that means one swipe axis per section and two or three cards visible at once. This
 * restyles exactly those sections - scoped to #searchPage .searchResults, nothing else - so the
 * page scrolls vertically with two cards per row.
 *
 * CSS only, on purpose: the scroller and the cards stay jellyfin-web's own, so focus handling,
 * card menus and lazy image loading keep working untouched. On mobile the scroller runs in native
 * mode (the frame gets .scrollX, the slider an inline `white-space: nowrap`), so overriding
 * overflow and the slider's display is all it takes; the !important flags beat that inline style
 * and the vw widths from card.scss.
 *
 * "Mobile" is jellyfin's own layout class (html.layout-mobile), plus any narrow non-TV window, so
 * a phone in landscape still gets the grid and a TV never does (its D-pad navigation relies on the
 * horizontal rows).
 */

var STYLE_ID = 'gpuUpscaleSearchGridStyle';

function rules(scope) {
    var s = scope + ' #searchPage .searchResults';
    return [
        s + ' [is="emby-scroller"], ' + s + ' .emby-scroller {'
            + ' overflow: visible !important; white-space: normal !important; }',
        s + ' .itemsContainer.scrollSlider {'
            + ' display: grid !important;'
            + ' grid-template-columns: repeat(2, minmax(0, 1fr));'
            + ' column-gap: 0.8em; row-gap: 0.2em;'
            + ' white-space: normal !important;'
            + ' transform: none !important;'
            + ' width: auto !important; }',
        s + ' .itemsContainer.scrollSlider > .card {'
            + ' width: auto !important; max-width: none !important; min-width: 0; }',
        // jellyfin offsets each card's box to align the first one with the heading; in a grid
        // that offset only skews the two columns.
        s + ' .itemsContainer.scrollSlider > .card > .cardBox {'
            + ' margin-left: 0 !important; margin-right: 0 !important; }',
        s + ' .emby-scrollbuttons { display: none !important; }'
    ].join('\n');
}

export function installSearchGrid() {
    try {
        if (document.getElementById(STYLE_ID)) {
            return;
        }

        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = rules('html.layout-mobile')
            + '\n@media (max-width: 50em) {\n' + rules('html:not(.layout-tv)') + '\n}';
        (document.head || document.documentElement).appendChild(style);
        log('search grid style installed');
    } catch (err) {
        log('search grid style failed', err);
    }
}
