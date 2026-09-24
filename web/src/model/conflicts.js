import { state } from './state.js';
import { COSTS } from './state.js';
import { isOff } from '../lib/utils.js';
import { eligibleTargets } from './costing.js';
import { shownPrefs } from './effective.js';

/*
 * AXES THAT CANNOT BOTH BE ON, AS DATA.
 *
 * The server already resolves every one of these: it forces the super-resolution level off when
 * a game upscaler produced the output size, drops the separate unblur pass for a shader that
 * sharpens inside its own, and has nothing for a refinement pass to correct when nothing was
 * enlarged. It resolves them silently, though, so the panel went on offering a control whose
 * value the server was about to discard. That is the dead-control failure wearing a different
 * hat: the pick is real, it is sent, and it changes nothing.
 *
 * Each rule names the axis it disables, when, and why in the words a viewer needs. `when` reads
 * only the current selection and the source, so nothing here needs the server to answer first.
 * A new conflict is one entry.
 */
export function gameOwnsOutputSize(level) {
    // dlaa is 1:1 by design, so it is the one game level that does NOT take over the scale.
    return level === 'fsr2' || level === 'dlss';
}

function nothingIsEnlarged(p) {
    var t = eligibleTargets();
    return isOff(p.upscale) || !t || !t.length;
}

// WEB_PANEL_DESIGN.md section 3.2: the server's own probe is the source of truth for both
// which neural levels run on the CUDA-native branch (`NeuralCudaLevels`) and which axes that
// branch forces off (`NeuralCudaDisables`). An older server that does not send these keys
// falls back to the literal lists the CUDA-native levels shipped with, so this degrades to
// "no new UI" rather than to wrong UI on a mixed-version deployment - the same rule every
// other probe-driven list in this file already follows.
//
// Exact match only, never a prefix test: the pre-existing Maxine placeholder id is the bare
// 'vsr', and a prefix match on 'vsr' would wrongly catch it too.
var NEURAL_CUDA_LEVELS_FALLBACK = ['vsr-rtcuda', 'dlpp-1', 'dlpp-2', 'dlpp-3', 'dlpp-4'];
var NEURAL_CUDA_DISABLES_FALLBACK = ['sr', 'refine', 'chroma', 'deblur', 'game', 'deband', 'kernel'];
var CUDA_DENOISE_LEVELS_FALLBACK = ['off', 'optix', 'optix-temporal'];

function probeList(key, fallback) {
    var caps = state.serverCaps;
    var listed = caps && caps.levels && caps.levels[key];
    return (listed && listed.length) ? listed : fallback;
}

export function neuralCudaLevels() {
    return probeList('NeuralCudaLevels', NEURAL_CUDA_LEVELS_FALLBACK);
}

export function neuralCudaDisables() {
    return probeList('NeuralCudaDisables', NEURAL_CUDA_DISABLES_FALLBACK);
}

export function cudaDenoiseLevels() {
    return probeList('CudaDenoiseLevels', CUDA_DENOISE_LEVELS_FALLBACK);
}

export function neuralIsCudaNative(p) {
    return neuralCudaLevels().indexOf(p.neural) >= 0;
}

// Plain-English name for an axis this branch forces off, used only in CONFLICTS.why text
// below. A key the map does not carry (an axis a future server adds to NeuralCudaDisables)
// still gets a serviceable sentence rather than none, which is the point of driving this list
// from the probe rather than hardcoding one CONFLICTS entry per axis.
var NEURAL_CUDA_AXIS_NAME = {
    sr: 'super-resolution', refine: 'post-scale refinement', chroma: 'chroma upscaling',
    deblur: 'unblur', game: 'the game upscaler', deband: 'debanding',
    kernel: 'the scaling kernel'
};

function neuralCudaWhy(key) {
    return function (p) {
        var what = NEURAL_CUDA_AXIS_NAME[key] || ('the ' + key + ' control');
        return 'The ' + p.neural + ' level runs on the CUDA path, which has no Vulkan stage,'
            + ' so the server turns ' + what + ' off for the session.';
    };
}

/*
 * One CONFLICTS entry per axis NeuralCudaDisables names, built once at load time from the
 * fallback list above. If a later probe reports a different list, axisConflict() re-checks
 * membership against the LIVE list on every call (neuralCudaDisables() is not cached), so an
 * axis the server stopped disabling simply stops matching even though its rule stays in this
 * array - the array only has to be a ceiling, not the exact live set, same as CONTROLS itself.
 */
var CONFLICTS = NEURAL_CUDA_DISABLES_FALLBACK.map(function (key) {
    return {
        key: key,
        when: function (p) { return neuralIsCudaNative(p) && neuralCudaDisables().indexOf(key) >= 0; },
        why: neuralCudaWhy(key)
    };
}).concat([
    {
        key: 'sr', when: function (p) { return gameOwnsOutputSize(p.game); },
        why: function (p) {
            return 'The ' + p.game + ' upscaler produces the output size itself, so the server'
                + ' turns super-resolution off rather than enlarge twice.';
        }
    },
    {
        key: 'refine', when: function (p) { return gameOwnsOutputSize(p.game); },
        why: function (p) {
            return 'The ' + p.game + ' upscaler owns the scale here, so the post-scale'
                + ' refinement is not applied.';
        }
    },
    {
        key: 'deblur', when: function (p) { return p.sr === 'nvscaler'; },
        why: function () {
            return 'NVScaler sharpens inside its own pass, so the server drops the separate'
                + ' unblur rather than stack two sharpeners into ringing.';
        }
    },
    {
        key: 'sr', when: nothingIsEnlarged,
        why: function () {
            return 'Nothing is being enlarged, so a super-resolution network has nothing to'
                + ' reconstruct.';
        }
    },
    {
        key: 'refine', when: nothingIsEnlarged,
        why: function () {
            return 'Refine corrects an enlargement, and there is none here.';
        }
    }
]);

/* The reason this axis is inert right now, or null. First rule that fires wins. */
export function axisConflict(key) {
    try {
        var p = shownPrefs();
        for (var i = 0; i < CONFLICTS.length; i++) {
            if (CONFLICTS[i].key === key && CONFLICTS[i].when(p)) {
                return CONFLICTS[i].why(p);
            }
        }
    } catch (err) {
        // A panel that cannot work out a conflict shows the control, which is the old behaviour.
    }

    return null;
}

/*
 * WEB_PANEL_DESIGN.md section 3.3: on the CUDA-native branch, denoise is only PARTLY
 * unavailable (optix/optix-temporal still run there), so it gets option-level inertness
 * instead of the whole-row treatment axisConflict() gives every other affected axis. Returns
 * the reason one option is inert, or null. Only the denoise axis has an option-level rule
 * today; a future one is one more `if` here, not a new rendering path (controlRow already
 * consults this for every chip/select option it draws).
 */
export function optionInert(c, id) {
    try {
        var p = shownPrefs();
        if (c.key === 'denoise' && neuralIsCudaNative(p) && cudaDenoiseLevels().indexOf(id) < 0) {
            return 'Not available on the CUDA path; only OptiX denoise runs beside RTX levels.';
        }
    } catch (err) {
        // Same fail-open rule as axisConflict: an error here shows the option, not a broken panel.
    }

    return null;
}

/* An option's measured cost, when its axis carries one, as plainly as it can be put. */
export function costSuffix(c, id) {
    var table = c.costKey ? COSTS[c.costKey] : null;
    var n = table ? table[id] : null;
    return (n && n > 1) ? '  [GPU ' + n + 'x]' : '';
}

export function shortName(name) {
    // Chips carry the short form; the full name stays on the title attribute.
    return String(name).split(' (')[0];
}
