import { state } from './model/state.js';
import { log } from './lib/log.js';
import './model/prefs-store.js';
import { hookWebpack } from './controller/webpack-hook.js';
import { hookFetch, hookXhr } from './controller/network.js';
import { watchPlaybackInfoDialog } from './controller/playback-hooks.js';
import { probeServer } from './controller/probe.js';
import { tryRequireShim } from './controller/live-apply.js';

/*
 * ENTRY POINT. Everything above this module is imported for its side effects (installing hooks)
 * or its exports (read by whichever module needs them); this is the only file that runs code at
 * the top level to actually install the hook, exactly as the old single IIFE's closing block did.
 */
(function install() {
    log('bootstrap install: start');
    try {
        hookWebpack();
        hookFetch();
        hookXhr();
        tryRequireShim();
        watchPlaybackInfoDialog();
        probeServer();
        state.installed = true;
        log('bootstrap install: end, installed on', state.globals.join(', '));
    } catch (err) {
        log('bootstrap install: end, threw', err);
        /* never break the web client */
    }
})();
