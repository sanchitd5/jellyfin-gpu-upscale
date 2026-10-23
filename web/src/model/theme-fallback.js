/*
 * Pure half of controller/theme-fallback.js. The selectable "Jellyfin Plus" theme is a stylesheet at
 * themes/jellyfinplus/theme.css; jellyfin-web <link>s whatever theme the user chose. If that file is
 * gone (an upgrade replaced the web tree and the injector has not re-run) the page would be left
 * with no base rules at all, so the client points the link at the stock Dark stylesheet instead.
 */

// The Dark URL for a failed Jellyfin Plus theme href, or null for any other href.
export function fallbackHref(href) {
    if (typeof href !== 'string') {
        return null;
    }
    var m = /^(.*\/)?themes\/jellyfinplus\/theme\.css(\?.*)?$/.exec(href);
    return m ? (m[1] || '') + 'themes/dark/theme.css' : null;
}
