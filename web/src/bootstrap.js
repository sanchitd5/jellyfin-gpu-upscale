import './lib/storage-migrate.js';
import { installMobileTheme } from './view/mobile-theme.js';
import { state } from './model/state.js';
import { log } from './lib/log.js';
import './model/prefs-store.js';
import { hookWebpack } from './controller/webpack-hook.js';
import { hookFetch, hookXhr } from './controller/network.js';
import { watchPlaybackInfoDialog } from './controller/playback-hooks.js';
import { probeServer } from './controller/probe.js';
import { tryRequireShim } from './controller/live-apply.js';
import { watchSearchPage } from './controller/search-exclude.js';
import { installSearchScopeFix } from './controller/search-scope.js';
import { installSearchFilterBar } from './view/search-filter-sheet.js';
import { installSearchGrid } from './view/search-grid.js';
import { installSearchRecent } from './view/search-recent.js';
import { installSearchSticky } from './view/search-sticky.js';
import { installSearchPager } from './view/search-pager.js';
import { installImageZoom } from './view/image-zoom.js';
import { installPlayAllFix } from './controller/play-all.js';
import { installCardActions } from './view/card-actions.js';
import { installPlayerGestures } from './controller/player-gestures.js';
import { installPlayerSpeed } from './controller/player-speed.js';
import { installPlayerBadge } from './controller/player-badge.js';
import { installClientUpscale } from './controller/client-upscale.js';
import { installClipUpNext } from './controller/clip-upnext.js';
import { installPortraitOsd } from './view/portrait-osd.js';
import { installDetailRelated } from './controller/detail-related.js';
import { installPersonVideos } from './controller/person-videos.js';
import { installBulkTags } from './controller/bulk-tags.js';
import { installDetailNav } from './controller/detail-nav.js';
import { installDetailDownload } from './controller/detail-download.js';
import { installDetailActions } from './view/detail-actions.js';
import { installTagAutocomplete } from './controller/tag-autocomplete.js';
import { installSearchCensus } from './controller/search-census.js';
import { installLibraryFilterHooks } from './controller/library-filters.js';
import { installLibraryFilterPanel } from './view/library-filter-panel.js';
import { installLibraryGrid } from './view/library-grid.js';
import { installLibraryLanding } from './controller/library-landing.js';
import { installCardBadges } from './view/card-badges.js';
import { installSelectAll } from './controller/select-all.js';
import { installSelectMode } from './controller/select-mode.js';
import { installPrefsSync } from './controller/prefs-sync.js';
import { installImagePreload } from './controller/image-preload.js';
import { installListRequests } from './controller/list-requests.js';
import { installListSort } from './controller/list-sort.js';
import { installThemeFallback } from './controller/theme-fallback.js';
import { installLibraryInfinite } from './view/library-infinite.js';

/*
 * ENTRY POINT. Everything above this module is imported for its side effects (installing hooks)
 * or its exports (read by whichever module needs them); this is the only file that runs code at
 * the top level to actually install the hook, exactly as the old single IIFE's closing block did.
 */

/* Each QoL feature installs on its own: one that throws must not take the others down with it. */
function feature(name, install) {
    try {
        install();
    } catch (err) {
        log('bootstrap: ' + name + ' failed to install', err);
    }
}

(function install() {
    log('bootstrap install: start');
    try {
        // First: the --jp-* tokens and tier classes must exist before any other module's CSS reads them.
        feature('mobile theme', installMobileTheme);
        // Before hookWebpack: it arms noteLazyLoader(), which the module wrapper calls as chunks evaluate.
        feature('image preload', installImagePreload);
        feature('theme fallback', installThemeFallback);
        hookWebpack();
        // Innermost on purpose: it must judge a search url AFTER network.js's markings have rewritten it.
        feature('search census', installSearchCensus);
        hookFetch();
        hookXhr();
        // Wraps fetch/XHR on top of the hooks above, so it must come after them.
        feature('play-all fix', installPlayAllFix);
        feature('library filter hooks', installLibraryFilterHooks);
        feature('library filter panel', installLibraryFilterPanel);
        feature('library grid', installLibraryGrid);
        feature('library landing', installLibraryLanding);
        feature('list requests', installListRequests);
        feature('list sort menus', installListSort);
        // Reads the page requests list requests records; changes none. Draws the pages after the stock one.
        feature('library infinite', installLibraryInfinite);
        tryRequireShim();
        watchPlaybackInfoDialog();
        feature('search page', watchSearchPage);
        feature('search scope', installSearchScopeFix);
        feature('search sort & filter', installSearchFilterBar);
        feature('search grid', installSearchGrid);
        feature('search recent', installSearchRecent);
        feature('search sticky', installSearchSticky);
        feature('search pager', installSearchPager);
        feature('image zoom', installImageZoom);
        feature('card actions', installCardActions);
        feature('card badges', installCardBadges);
        // Observes list responses only (never changes a request), so its place in the chain does not matter.
        feature('select all', installSelectAll);
        // Explicit "Select" entry and the bottom-sheet selection bar (P8); drives stock multi-select.
        feature('select mode', installSelectMode);
        // Gestures (double-tap seek, hold for 2x, swipe volume/brightness), the saved playback
        // speed and the Enhance badge in the OSD. All independent of the request hooks above.
        feature('player gestures', installPlayerGestures);
        feature('player speed', installPlayerSpeed);
        feature('player badge', installPlayerBadge);
        // WebGL2 upscaling in this browser when the stream is smaller than the screen. Never
        // touches a request: it watches <video> media events only.
        feature('client upscale', installClientUpscale);
        feature('clip up next', installClipUpNext);
        feature('player touch osd', installPortraitOsd);
        feature('detail related', installDetailRelated);
        feature('person videos', installPersonVideos);
        feature('bulk tags', installBulkTags);
        feature('detail prev/next', installDetailNav);
        feature('detail download', installDetailDownload);
        feature('detail actions', installDetailActions);
        feature('tag autocomplete', installTagAutocomplete);
        feature('prefs sync', installPrefsSync);
        probeServer();
        state.installed = true;
        log('bootstrap install: end, installed on', state.globals.join(', '));
    } catch (err) {
        log('bootstrap install: end, threw', err);
        /* never break the web client */
    }
})();
