import { log } from '../lib/log.js';
import { fallbackHref } from '../model/theme-fallback.js';

/*
 * Keeps the client usable when the selectable "Jellyfin Plus" theme's stylesheet is missing: a
 * stylesheet <link> that fails to load and names themes/jellyfinplus/theme.css is repointed at the
 * stock Dark one. 'error' does not bubble, so one capturing listener on the document catches every
 * link, including ones React adds later. Not a seam into jellyfin-web: nothing is wrapped, and a
 * link for any other theme is never touched.
 */
export function installThemeFallback() {
    document.addEventListener('error', function (e) {
        var link = e.target;
        if (!link || link.tagName !== 'LINK' || link.rel !== 'stylesheet') {
            return;
        }
        var next = fallbackHref(link.getAttribute('href'));
        if (next) {
            log('theme-fallback: Jellyfin Plus theme css missing, using Dark');
            link.setAttribute('href', next);
        }
    }, true);
}
