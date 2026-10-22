/*
 * One-time localStorage migration for the GPU Upscale -> Jellyfin Plus rename.
 *
 * Imported FIRST by bootstrap.js, for its side effect. ES imports are hoisted and evaluated in
 * source order, so this module runs before model/prefs-store.js reads its key on import.
 * Each old key is copied to its new name only when the new one is absent, then the old one is
 * removed; a second run finds nothing to do. A browser that refuses localStorage is left alone.
 */
var RENAMED_KEYS = {
    'gpuUpscalePrefs': 'jellyfinPlusPrefs',
    'gpuUpscaleOpen': 'jellyfinPlusOpen',
    'gpuUpscaleDebug': 'jellyfinPlusDebug',
    'gpuUpscale.searchExclude': 'jellyfinPlus.searchExclude',
    'gpuUpscale.libFilterNames': 'jellyfinPlus.libFilterNames'
};

try {
    var store = window.localStorage;
    Object.keys(RENAMED_KEYS).forEach(function (oldKey) {
        var value = store.getItem(oldKey);
        if (value === null) { return; }
        var newKey = RENAMED_KEYS[oldKey];
        if (store.getItem(newKey) === null) { store.setItem(newKey, value); }
        store.removeItem(oldKey);
    });
} catch (e) { /* storage unavailable or full: nothing to migrate, nothing to lose */ }
