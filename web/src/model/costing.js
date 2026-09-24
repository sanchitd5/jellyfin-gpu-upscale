import { state } from './state.js';
import { CONTROLS } from './controls-data.js';
import { FPS, DENOISE_COST, NEURAL_COST, GAME_COST, DEBLOCK_COST } from './state.js';
import { shownPrefs } from './effective.js';
import { isOff } from '../lib/utils.js';

/* The levels and thresholds the server reported, or null when it has not been reached yet. */
export function serverConfig() {
    return (state.serverCaps && state.serverCaps.levels) || null;
}

/*
 * The upscale targets this server would actually accept for the source now playing.
 *
 * Returns null when there is not enough information to filter honestly (no probe answer, or no
 * source height yet) - the caller then shows the full list rather than a wrongly pruned one -
 * and an EMPTY array when the source is taller than MaxSourceHeight, where the server refuses
 * every target and the only truthful menu is one that offers none.
 *
 * The rules are the server's own, fetched from the probe, never copied into this file:
 *   MinScaleFactor   a target at or below source x this ratio is declined outright
 *   MaxTargetHeight  a higher request is silently clamped, so offering it would be a lie
 *   MaxSourceHeight  a taller source is never upscaled at all
 */
export function eligibleTargets() {
    var cfg = serverConfig();
    var sh = state.sourceHeight;
    if (!cfg || !sh || sh <= 0) {
        return null;
    }

    if (cfg.MaxSourceHeight > 0 && sh > cfg.MaxSourceHeight) {
        return [];
    }

    var min = cfg.MinScaleFactor > 0 ? cfg.MinScaleFactor : 1;
    var maxTarget = cfg.MaxTargetHeight > 0 ? cfg.MaxTargetHeight : 0;
    return CONTROLS[0].options.filter(function (o) {
        if (!/^[0-9]+$/.test(o.id)) {
            return false;
        }

        var h = parseInt(o.id, 10);
        return (!maxTarget || h <= maxTarget) && h > sh * min;
    });
}

/*
 * Will the server run the super-resolution network at this target, or bypass it and fall back
 * to plain scaling plus the sharpener? Below SrMinScaleFactor it bypasses - which is not a
 * failure (the sharpener measured better there), but the menu should say so rather than let the
 * viewer believe a network ran.
 */
export function srWouldRun(targetHeight) {
    var cfg = serverConfig();
    if (!cfg || !state.sourceHeight || !(cfg.SrMinScaleFactor > 1)) {
        return true;
    }

    return targetHeight >= state.sourceHeight * cfg.SrMinScaleFactor;
}

/* An indicative GPU cost for a stage, relative to the cheapest upscale measured. */
export function stageCost(height, sr, denoise, neural) {
    var row = FPS[height] || FPS[1080];
    var fps = sr ? row.sr : row.off;
    return (FPS[1080].off / fps) * (DENOISE_COST[denoise] || 1) * (NEURAL_COST[neural] || 1);
}

/*
 * What the CURRENT selection is likely to cost, as opposed to what a ladder stage costs. The
 * stages are costed and ordered; a Custom pick is not, so nothing stopped a viewer stacking
 * fspp, OptiX and DLSS into 0.22x realtime and watching it buffer with no explanation.
 */
export function selectionCost() {
    try {
        var p = shownPrefs();
        var base = stageCost(parseInt(p.upscale, 10) || state.sourceHeight || 1080,
            !isOff(p.sr), p.denoise, p.neural);
        return base * (DEBLOCK_COST[p.deblock] || 1) * (GAME_COST[p.game] || 1);
    } catch (err) {
        return 0;
    }
}

export function costHint(cost) {
    // Three bands rather than a bare number, because what the viewer needs to know is how many
    // of these the server can run at once, not a ratio.
    if (cost < 1.5) { return 'light'; }
    return cost < 2.2 ? 'moderate' : 'heavy';
}
