/* Debug logging, gated on a localStorage flag so it costs nothing until a viewer opts in. */
export function log() {
    try {
        if (window.localStorage && window.localStorage.getItem('gpuUpscaleDebug')) {
            console.log.apply(console, ['[gpu-upscale]'].concat(Array.prototype.slice.call(arguments)));
        }
    } catch (e) { /* ignore */ }
}
