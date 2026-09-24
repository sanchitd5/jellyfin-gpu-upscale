    try {
        hookWebpack();
        hookFetch();
        hookXhr();
        watchPlaybackInfoDialog();
        probeServer();
        state.installed = true;
        log('installed on', state.globals.join(', '));
    } catch (err) {
        /* never break the web client */
    }
})();
