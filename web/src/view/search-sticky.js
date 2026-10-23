import { log } from '../lib/log.js';

/*
 * STICKY SEARCH FIELD (P11).
 *
 * jellyfin-web's `#searchPage .searchFields` (the query box, plus the exclude row and the Sort &
 * filter bar that other modules append into it) is pinned under the fixed app bar, so the field is
 * reachable after any number of infinite pages. Pure CSS `position: sticky`: #searchPage is the
 * fields' parent and holds the results as siblings, so the sticky range is the whole page. The only
 * script is measuring the app bar (`.skinHeader`, position: fixed) into --jp-search-top on <html>,
 * on resize / orientation change and when the route changes. Without the measurement the CSS falls
 * back to a 3.5em bar.
 *
 * Scoped to html:not(.jp-theme-off):not(.layout-tv): the mobile-theme off switch and TV stay stock.
 * Colours come from the --jp-* tokens with jellyfin-web palette fallbacks, so it works before
 * (or without) the theme module.
 */

var STYLE_ID = 'jellyfinPlusSearchStickyStyle';
var SCOPE = 'html:not(.jp-theme-off):not(.layout-tv) #searchPage .searchFields';

var CSS = SCOPE + ' {'
    + ' position: sticky; top: var(--jp-search-top, calc(3.5em + env(safe-area-inset-top, 0px)));'
    + ' z-index: 10; padding-top: 0.4em; padding-bottom: 0.4em;'
    + ' background: var(--jp-bg, var(--jf-palette-background-default, #101010));'
    + ' }\n'
    // Chips stay with the field but on ONE horizontally scrolling line, so many active filters
    // cannot grow the pinned block to a third of the screen.
    + SCOPE + ' .jfp-chips { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; margin-top: 0.3em; }\n'
    + SCOPE + ' .jfp-chips > * { flex: 0 0 auto; }\n';

function measure() {
    try {
        var header = document.querySelector('.skinHeader');
        if (!header) {
            return;
        }

        var bottom = Math.round(header.getBoundingClientRect().bottom);
        // A hidden / zero-height bar must not collapse the field under the status bar.
        if (bottom > 0) {
            document.documentElement.style.setProperty('--jp-search-top', bottom + 'px');
        }
    } catch (err) {
        log('search sticky measure failed', err);
    }
}

export function installSearchSticky() {
    if (document.getElementById(STYLE_ID)) {
        return;
    }

    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);

    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    window.addEventListener('hashchange', function () { setTimeout(measure, 300); });
    setTimeout(measure, 500);
}
