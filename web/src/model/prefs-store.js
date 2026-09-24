import { state } from './state.js';
import { DEFAULT_PREFS, SR_ALIASES } from './controls-data.js';

var STORE = 'gpuUpscalePrefs';

// Loaded once, at module init, exactly as the pre-module build loaded it once at IIFE start.
(function loadPrefs() {
    try {
        var saved = window.localStorage && window.localStorage.getItem(STORE);
        if (saved) {
            var parsed = JSON.parse(saved);
            if (parsed && typeof parsed === 'object') {
                Object.keys(state.prefs).forEach(function (k) {
                    if (parsed[k] != null) { state.prefs[k] = parsed[k]; }
                });
                if (SR_ALIASES[state.prefs.sr]) { state.prefs.sr = SR_ALIASES[state.prefs.sr]; }

                // The panel's position rides with the preferences. Anything that is not a pair of
                // finite numbers is dropped rather than trusted: a bad value here would put the
                // panel somewhere unreachable.
                var pos = parsed.pos;
                if (pos && typeof pos === 'object' && isFinite(pos.x) && isFinite(pos.y)) {
                    state.panelPos = { x: Number(pos.x), y: Number(pos.y) };
                }

                if (parsed.stage && typeof parsed.stage === 'object') {
                    state.stage = parsed.stage;
                } else if (typeof parsed.stage === 'string') {
                    state.stage = parsed.stage;
                } else {
                    // Written by a build that had no presets. Values other than the built-in
                    // defaults mean the viewer picked them, which is Custom; anything else is
                    // someone who never expressed an opinion, which is Automatic.
                    var touched = Object.keys(DEFAULT_PREFS).some(function (k) {
                        return state.prefs[k] !== DEFAULT_PREFS[k];
                    });
                    state.stage = touched ? 'custom' : 'unset';
                }
            }
        }
    } catch (e) { /* defaults stand */ }
})();

export function savePrefs() {
    try {
        window.localStorage.setItem(STORE, JSON.stringify({
            stage: state.stage,
            upscale: state.prefs.upscale,
            deblur: state.prefs.deblur,
            denoise: state.prefs.denoise,
            deblock: state.prefs.deblock,
            neural: state.prefs.neural,
            game: state.prefs.game,
            sr: state.prefs.sr,
            deband: state.prefs.deband,
            kernel: state.prefs.kernel,
            refine: state.prefs.refine,
            chroma: state.prefs.chroma,
            jitter: state.prefs.jitter,
            depth: state.prefs.depth,
            reactive: state.prefs.reactive,
            pos: state.panelPos
        }));
    } catch (e) { /* ignore */ }
}
