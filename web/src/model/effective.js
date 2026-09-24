import { state } from './state.js';
import { DEFAULT_PREFS } from './controls-data.js';
import { currentStage, stageText } from './ladder.js';
import { LADDER_SHARPEN, LADDER_SR } from './state.js';
import { eligibleTargets } from './costing.js';
import { wireParams } from '../controller/network.js';
import { isOff } from '../lib/utils.js';

/*
 * What this session is actually asking for. null means "nothing at all": the viewer has
 * expressed no opinion, so no marker is sent and the server's defaults stand untouched.
 */
export function effective() {
    if (state.stage === 'unset') {
        return null;
    }

    if (state.stage === 'off') {
        return {
            upscale: 'off', deblur: 'off', denoise: 'off', deblock: 'off', neural: 'off',
            game: 'off', sr: 'off'
        };
    }

    if (state.stage === 'custom') {
        return state.prefs;
    }

    var st = currentStage();
    if (!st) {
        // A stage was chosen but this source has no ladder (the probe has not answered, or the
        // source is taller than the server will upscale). Send no target and let the server
        // decide rather than inventing one; the sharpener still applies.
        var targets = eligibleTargets();
        return {
            upscale: targets === null ? null : 'off',
            deblur: LADDER_SHARPEN,
            denoise: (state.stage && state.stage.denoise) || 'off',
            sr: LADDER_SR
        };
    }

    return {
        upscale: String(st.height),
        deblur: LADDER_SHARPEN,
        denoise: st.denoise,
        sr: st.sr ? LADDER_SR : 'off'
    };
}

/*
 * What the panel SHOWS: the viewer's own preferences with whatever stage is in force laid over
 * them. Deliberately NOT written back into state.prefs. Seeding effective() into the
 * preferences let a ladder stage overwrite the viewer's sr, and an Off stage wipe their neural
 * and game out of localStorage, where nothing could bring them back.
 */
export function displayPrefs() {
    var live = effective();
    var out = {};
    Object.keys(state.prefs).forEach(function (k) {
        out[k] = (live && live[k] != null) ? live[k] : state.prefs[k];
    });
    // A null target means "the server picks the size", which no control can show: read it Off.
    if (live && live.upscale == null) { out.upscale = 'off'; }
    return out;
}

/* What the render in progress is showing, or the bare preferences before one has run. */
export function shownPrefs() {
    return state.shown || state.prefs;
}

export function anyEnhancement() {
    var e = effective();
    if (!e) {
        return false;
    }

    // upscale === null is "let the server pick the target", which is still an enhancement.
    if (e.upscale == null) {
        return true;
    }

    // THE WHOLE WIRE OBJECT, not three axes of it. A Custom selection carrying only sr, neural,
    // game, refine, chroma, kernel or deband used to answer false here, so no transcode was
    // forced, the response kept no TranscodingUrl and the session direct-played with none of it.
    var params = wireParams() || {};
    return Object.keys(params).some(function (k) {
        return !isOff(params[k]) && params[k] !== 'default';
    });
}

/* The label on the Enhance row and in the panel header: always what is actually in force. */
export function summaryText() {
    if (state.stage === 'unset') { return 'Automatic'; }
    if (state.stage === 'off') { return 'Off'; }
    if (state.stage === 'custom') { return 'Custom - ' + advancedText(); }

    var st = currentStage();
    return st ? (st.n + '. ' + stageText(st)) : 'Not available for this source';
}

export function advancedText() {
    var e = effective() || DEFAULT_PREFS;
    var bits = [];
    if (e.upscale == null) { bits.push('server default'); } else if (e.upscale !== 'off') { bits.push(e.upscale + 'p'); }
    if (e.sr && e.sr !== 'off' && e.upscale !== 'off') { bits.push(e.sr); }
    if (e.deblur !== 'off') { bits.push('unblur ' + e.deblur); }
    if (e.denoise !== 'off') { bits.push('denoise ' + e.denoise); }
    if (state.prefs.neural && state.prefs.neural !== 'off') { bits.push('neural ' + state.prefs.neural); }
    if (state.prefs.game && state.prefs.game !== 'off') { bits.push('game ' + state.prefs.game); }
    if (state.prefs.refine && state.prefs.refine !== 'default' && state.prefs.refine !== 'off') {
        bits.push('refine ' + state.prefs.refine);
    }

    if (state.prefs.chroma && state.prefs.chroma !== 'default' && state.prefs.chroma !== 'off') {
        bits.push('chroma ' + state.prefs.chroma);
    }

    return bits.length ? bits.join(', ') : 'Off';
}
