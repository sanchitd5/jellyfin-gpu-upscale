import { log } from '../lib/log.js';

/*
 * PERSON AND STUDIO PAGES SHOW NOTHING FOR VIDEO CLIPS - STOCK jellyfin-web 12.1 BEHAVIOUR.
 *
 * A Person or Studio details page (#/details?id=...) fills its sections in
 * scripts/itemsByName.js: renderItems() builds a fixed list of sections - Artists, Programs,
 * Movies, Shows, Episodes, Trailers, Albums, Music Videos, Audio Books, Books - and each fetches
 * /Items?PersonIds=... (or StudioIds=...) with ITS OWN IncludeItemTypes. There is no section for
 * the Video type, so a person whose only appearances are in Home Videos clips gets an empty page.
 *
 * Fix, by the least invasive means: re-point one of the sections that does exist. The Audio Books
 * section is always built (it is pushed unconditionally "until the API reports counts") and hides
 * itself when its query comes back empty, so a library with no audiobooks never sees it. On a
 * Person/Studio page this module rewrites THAT section's request - IncludeItemTypes=Audiobook
 * becomes Video, newest first, a bigger page - and the stock code then renders real Video cards
 * (play button, menu, lazy images, "More" button) with nothing reimplemented. Afterwards the
 * section is retitled "Videos", its "More" link is pointed at type=Video (which list.js already
 * supports), and its cards are given the 16:9 box clips have.
 *
 * The trade, stated plainly: on a server that DOES hold audiobooks by a person or studio, that
 * section shows their videos instead. The match is exact - IncludeItemTypes=Audiobook together with
 * PersonIds/StudioIds, on a #/details page, which only itemsByName.js produces - so nothing else on
 * the web client is touched.
 */

var STYLE_ID = 'gpuUpscaleVideoSectionStyle';
var MARK = 'data-gpr-videos';
var LIMIT = 24;

var IS_ITEMS = /\/items\?/i;
var IS_AUDIOBOOK_BY_NAME = /[?&]includeitemtypes=audiobook(&|$)/i;
var HAS_BY_NAME_ID = /[?&](personids|studioids)=/i;

function onDetailsPage() {
    return /^#\/details(\?|$)/.test(window.location.hash || '');
}

/* Any other url comes back unchanged. */
export function rewriteSectionUrl(url) {
    if (typeof url !== 'string' || !IS_ITEMS.test(url) || !IS_AUDIOBOOK_BY_NAME.test(url)
            || !HAS_BY_NAME_ID.test(url) || !onDetailsPage()) {
        return url;
    }

    var out = url
        .replace(/([?&])includeitemtypes=[^&]*/gi, '$1IncludeItemTypes=Video')
        .replace(/([?&])sortby=[^&]*/gi, '$1SortBy=DateCreated')
        .replace(/([?&])sortorder=[^&]*/gi, '$1SortOrder=Descending')
        .replace(/([?&])limit=[^&]*/gi, '$1Limit=' + LIMIT);
    log('person videos: ' + url + ' -> ' + out);
    return out;
}

function hookFetch() {
    if (!window.fetch) {
        return;
    }

    var originalFetch = window.fetch;
    window.fetch = function (input, init) {
        try {
            if (typeof input === 'string') {
                input = rewriteSectionUrl(input);
            }
        } catch (err) {
            log('person videos: fetch rewrite failed', err);
        }

        return originalFetch.call(this, input, init);
    };
}

function hookXhr() {
    if (!window.XMLHttpRequest) {
        return;
    }

    var proto = window.XMLHttpRequest.prototype;
    var originalOpen = proto.open;
    proto.open = function (method, url) {
        try {
            var rewritten = rewriteSectionUrl(url);
            if (rewritten !== url) {
                var args = Array.prototype.slice.call(arguments);
                args[1] = rewritten;
                return originalOpen.apply(this, args);
            }
        } catch (err) {
            log('person videos: xhr rewrite failed', err);
        }

        return originalOpen.apply(this, arguments);
    };
}

/* Retitle, re-link and mark the re-pointed section. Idempotent. */
function fixSections() {
    if (!onDetailsPage()) {
        return;
    }

    Array.prototype.forEach.call(
        document.querySelectorAll('#childrenContent .verticalSection[data-type="Audiobook"]'),
        function (section) {
            if (section.getAttribute(MARK) !== '1') {
                section.setAttribute(MARK, '1');
                var title = section.querySelector('.sectionTitle');
                if (title) {
                    title.textContent = 'Videos';
                }

                log('person videos: section retitled');
            }

            var more = section.querySelector('a[href*="type=Audiobook"]');
            if (more) {
                more.setAttribute('href', more.getAttribute('href').replace('type=Audiobook', 'type=Video'));
            }
        });
}

function installStyle() {
    if (document.getElementById(STYLE_ID)) {
        return;
    }

    var style = document.createElement('style');
    style.id = STYLE_ID;
    // The stock section builds portrait cards (a 2:3 box); clips are 16:9.
    style.textContent = '#childrenContent .verticalSection[' + MARK + '="1"] .cardPadder-overflowPortrait'
        + ' { padding-bottom: 56.25%; }';
    (document.head || document.documentElement).appendChild(style);
}

export function installPersonVideos() {
    try {
        installStyle();
        hookFetch();
        hookXhr();

        var pending = false;
        new MutationObserver(function () {
            if (pending) {
                return;
            }

            pending = true;
            requestAnimationFrame(function () {
                pending = false;
                try {
                    fixSections();
                } catch (err) {
                    log('person videos: fix failed', err);
                }
            });
        }).observe(document.body || document.documentElement, { childList: true, subtree: true });
        log('person videos: installed');
    } catch (err) {
        log('person videos install failed', err);
    }
}
