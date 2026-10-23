import './lib/storage-migrate.js';
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
import { installSearchPager } from './view/search-pager.js';
import { installImageZoom } from './view/image-zoom.js';
import { installPlayAllFix } from './controller/play-all.js';
import { installCardActions } from './view/card-actions.js';
import { installDoubleTapSeek } from './controller/double-tap-seek.js';
import { installClipUpNext } from './controller/clip-upnext.js';
import { installDetailRelated } from './controller/detail-related.js';
import { installPersonVideos } from './controller/person-videos.js';
import { installBulkTags } from './controller/bulk-tags.js';
import { installSearchCensus } from './controller/search-census.js';
import { installLibraryFilterHooks } from './controller/library-filters.js';
import { installLibraryFilterPanel } from './view/library-filter-panel.js';
import { installLibraryLanding } from './controller/library-landing.js';

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
        hookWebpack();
        // Innermost on purpose: it must judge a search url AFTER network.js's markings have rewritten it.
        feature('search census', installSearchCensus);
        hookFetch();
        hookXhr();
        // Wraps fetch/XHR on top of the hooks above, so it must come after them.
        feature('play-all fix', installPlayAllFix);
        feature('library filter hooks', installLibraryFilterHooks);
        feature('library filter panel', installLibraryFilterPanel);
        feature('library landing', installLibraryLanding);
        tryRequireShim();
        watchPlaybackInfoDialog();
        feature('search page', watchSearchPage);
        feature('search scope', installSearchScopeFix);
        feature('search sort & filter', installSearchFilterBar);
        feature('search grid', installSearchGrid);
        feature('search recent', installSearchRecent);
        feature('search pager', installSearchPager);
        feature('image zoom', installImageZoom);
        feature('card actions', installCardActions);
        feature('double-tap seek', installDoubleTapSeek);
        feature('clip up next', installClipUpNext);
        feature('detail related', installDetailRelated);
        feature('person videos', installPersonVideos);
        feature('bulk tags', installBulkTags);
        probeServer();
        state.installed = true;
        log('bootstrap install: end, installed on', state.globals.join(', '));
    } catch (err) {
        log('bootstrap install: end, threw', err);
        /* never break the web client */
    }
})();
