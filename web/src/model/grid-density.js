/*
 * LIBRARY GRID DENSITY (pure: no DOM). The number of columns is a function of the width the grid
 * actually has, never a fixed 2 or 3: a card of a given shape wants a minimum width (in rem, so it
 * follows the viewer's font size), and as many fit as the width allows.
 *
 *   cols = floor((width + gap) / (min + gap)), kept within [minCols(shape), MAX_COLS]
 *
 * A phone (about 360 px of grid) therefore gets 2 portrait columns, a small tablet 4 to 5, a
 * desktop window 8 to 10, with no breakpoint table. Landscape and banner cards want more width, so
 * they get fewer columns at the same width. view/library-grid.js measures and applies it.
 */

// Minimum card width in rem, by the shape jellyfin-web names in the card's cardPadder-<shape>.
export var MIN_CARD_REM = { portrait: 9, square: 9, backdrop: 14, banner: 20 };
// A phone should never drop below two columns of posters or thumbnails; a banner may be alone.
export var MIN_COLS = { portrait: 2, square: 2, backdrop: 2, banner: 1 };
export var MAX_COLS = 12;
export var DEFAULT_SHAPE = 'portrait';

/*
 * The shape for a cardPadder class ("cardPadder-overflowPortrait", "cardPadder-mixedBackdrop",
 * "cardPadder-smallBackdrop", "cardPadder-square", "cardPadder-banner", ...). Unknown is portrait.
 */
export function shapeOf(padderClass) {
    var s = String(padderClass || '').replace(/^cardPadder-/, '').toLowerCase();
    if (s.indexOf('banner') >= 0) { return 'banner'; }
    if (s.indexOf('backdrop') >= 0) { return 'backdrop'; }
    if (s.indexOf('square') >= 0) { return 'square'; }
    return DEFAULT_SHAPE;
}

/* width and gap in px, rem is the px size of 1rem. Returns an integer column count >= 1. */
export function columnsFor(width, shape, gap, rem) {
    var s = MIN_CARD_REM[shape] ? shape : DEFAULT_SHAPE;
    var min = MIN_CARD_REM[s] * (rem > 0 ? rem : 16);
    var g = gap >= 0 ? gap : 0;
    var n = Math.floor(((width > 0 ? width : 0) + g) / (min + g));
    return Math.max(MIN_COLS[s], Math.min(MAX_COLS, n));
}
