/* Debug logging, gated on a localStorage flag so it costs nothing until a viewer opts in.
 * The flag is read under either name: storage-migrate.js renames the old key, but a viewer who
 * sets the old one by hand (from the old docs) still gets logs. */
export function log() {
    try {
        var ls = window.localStorage;
        if (ls && (ls.getItem('jellyfinPlusDebug') || ls.getItem('gpuUpscaleDebug'))) {
            console.log.apply(console, ['[jellyfin-plus]'].concat(Array.prototype.slice.call(arguments)));
        }
    } catch (e) { /* ignore */ }
}
