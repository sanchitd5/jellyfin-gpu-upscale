import { state } from './state.js';
import { LADDER_SHARPEN } from './state.js';
import { eligibleTargets, srWouldRun, stageCost } from './costing.js';

/*
 * THE QUALITY LADDER, GENERATED for the source now playing rather than listed, because the
 * honest set of stages is not the same for a 540p source and a 1080p one. See state.js for the
 * measured constants this is built from.
 *
 * A stage is stored as a RECIPE, not as a number: which eligible target (by rank), whether the
 * network is on, and how much denoise. A number would mean something different on the next
 * item, whose ladder may be a different length.
 *
 * Within one target the order is the measured one - sharpen, then the network, then denoise -
 * and across targets it is by computed cost, so a later stage never costs less than an earlier
 * one.
 */
export function ladder() {
    var targets = eligibleTargets();
    if (targets === null) {
        return null;
    }

    var stages = [];
    targets.forEach(function (t, rank) {
        var h = parseInt(t.id, 10);
        var srHere = srWouldRun(h);
        var top = rank === targets.length - 1;

        // 1. the cheapest real improvement: scale up and sharpen, ~1% of throughput.
        stages.push({ rank: rank, height: h, sr: false, denoise: 'off' });

        // 2. add the network, but only where the server would actually run it.
        if (srHere) {
            stages.push({ rank: rank, height: h, sr: true, denoise: 'off' });
        }

        // 3. add denoise on top of the best chain available at this target.
        stages.push({ rank: rank, height: h, sr: srHere, denoise: 'light' });

        // 4. and the heaviest denoise only at the top of the ladder.
        if (top) {
            stages.push({ rank: rank, height: h, sr: srHere, denoise: 'strong' });
        }
    });

    stages.forEach(function (st) { st.cost = stageCost(st.height, st.sr, st.denoise); });
    stages.sort(function (a, b) { return a.cost - b.cost; });
    stages.forEach(function (st, i) { st.n = i + 1; });
    return stages;
}

/*
 * The recommended stage: the smallest step up, the network where it would run, the gentle
 * sharpener, and no denoise. That is the measured sweet spot - the network earns its ~15% only
 * above SrMinScaleFactor, the sharpener costs ~1%, and denoise costs about 60% of throughput
 * while returning nothing on clean material.
 */
export function recommendedStage() {
    var l = ladder();
    if (!l || !l.length) {
        return null;
    }

    var wanted = l.filter(function (st) { return st.rank === 0 && st.denoise === 'off'; });
    return (wanted.length ? wanted[wanted.length - 1] : l[0]);
}

export function sameStage(a, b) {
    return !!a && !!b && a.rank === b.rank && !!a.sr === !!b.sr && a.denoise === b.denoise;
}

/* The stage the stored recipe lands on for THIS source, or null if the ladder has no room. */
export function currentStage() {
    if (!state.stage || typeof state.stage !== 'object') {
        return null;
    }

    var l = ladder();
    if (!l || !l.length) {
        return null;
    }

    var exact = l.filter(function (st) { return sameStage(st, state.stage); })[0];
    if (exact) {
        return exact;
    }

    // The recipe does not exist for this source - a rank this source has no target for, or the
    // network bypassed at this ratio. Degrade to the nearest stage at or below its cost rather
    // than silently doing something else or offering nothing.
    var want = stageCost(
        parseInt((eligibleTargets()[Math.min(state.stage.rank, eligibleTargets().length - 1)] || {}).id, 10) || 1080,
        state.stage.sr,
        state.stage.denoise);
    var below = l.filter(function (st) { return st.cost <= want; });
    return below.length ? below[below.length - 1] : l[0];
}

/* What one stage actually does, in the viewer's words rather than the engine's. */
export function stageText(st) {
    var bits = [st.height + 'p'];
    bits.push(st.sr ? 'FSRCNNX + sharpen' : 'sharpen');
    if (st.denoise !== 'off') {
        bits.push(st.denoise === 'strong' ? 'strong denoise' : 'denoise');
    }

    return bits.join(', ');
}
