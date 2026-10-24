import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';

/*
 * "JELLYFINPLUS" WHERE JELLYFIN SHOWS ITS OWN NAME AS A LOGO. CSS only: nothing React renders is touched, so a
 * re-render can never fight it, and the off switch (html.jp-theme-off, view/mobile-theme.js) restores stock.
 *
 *  - Modern top bar (jellyfin-web 12.x AppToolbar): a text Button linking to "/" with the Jellyfin icon as its
 *    start icon and the SERVER NAME as its text. The text node is hidden (font-size 0) and the wordmark drawn
 *    in ::after; the icon keeps its size because the start-icon span gets its font size back.
 *  - Modern drawer header: a ListItem link to "/" with the icon and the server name as the primary text, same
 *    trick on the primary Typography (the version line under it is left alone).
 *  - Legacy header (.pageTitleWithDefaultLogo) and the splash (.splashLogo): their background image is the
 *    Jellyfin banner, replaced by an SVG wordmark.
 *
 * Matched by shape (a link to "/" holding the icon image), not by generated class names.
 */

var STYLE_ID = 'jellyfinPlusBrandStyle';
var ON = 'html:not(.jp-theme-off)';
var NAME = 'Jellyfin';
var PLUS = 'Plus';
var ACCENT = 'var(--jp-accent, var(--jf-palette-primary-main, #00a4dc))';

/* The wordmark as an SVG data URI for the background-image logos. */
function wordmark(fill) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 100">'
        + '<text x="0" y="74" font-family="Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="78" font-weight="600"'
        + ' letter-spacing="-1"><tspan fill="' + fill + '">' + NAME + '</tspan><tspan fill="#00a4dc">' + PLUS + '</tspan></text></svg>';
    return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
}

var TOP = ON + ' .MuiToolbar-root a.MuiButton-root[href="#/"]:has(> .MuiButton-startIcon img)';
var DRAWER = ON + ' .MuiDrawer-paper a[href="#/"]:has(img) .MuiListItemText-primary';

var CSS = [
    TOP + ' { font-size: 0 !important; }',
    TOP + ' > .MuiButton-startIcon { font-size: 1.1rem; }',
    TOP + '::after { content: "' + NAME + '"; font-size: 1.15rem; font-weight: 600; letter-spacing: -0.01em; }',
    TOP + '::before { content: "' + PLUS + '"; order: 3; font-size: 1.15rem; font-weight: 700; color: ' + ACCENT + '; }',
    TOP + ' { display: inline-flex; }',
    TOP + ' > .MuiButton-startIcon { order: 1; }',
    TOP + '::after { order: 2; }',
    DRAWER + ' { font-size: 0 !important; }',
    DRAWER + '::before { content: "' + NAME + '"; font-size: 1.25rem; font-weight: 600; }',
    DRAWER + '::after { content: "' + PLUS + '"; font-size: 1.25rem; font-weight: 700; color: ' + ACCENT + '; }',
    ON + ' .pageTitleWithDefaultLogo { background-image: ' + wordmark('#f2f4f7') + ' !important; }',
    ON + ' .splashLogo { background-image: ' + wordmark('#f2f4f7') + ' !important; }',
    ON + '[data-theme="light"] .pageTitleWithDefaultLogo, ' + ON + '[data-theme="light"] .splashLogo { background-image: '
        + wordmark('#202124') + ' !important; }'
].join('\n');

export function installBrand() {
    try {
        if (document.getElementById(STYLE_ID)) {
            return;
        }

        var style = el('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);
    } catch (err) {
        log('brand install failed', err);
    }
}
