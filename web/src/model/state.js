import { DEFAULT_PREFS } from './controls-data.js';

/*
 * THE QUALITY LADDER CONSTANTS, AND WHY THEY ARE WHAT THEY ARE.
 *
 * Every choice below comes from what was measured on this deployment (HANDOVER-gpuupscale.md
 * sessions 4, 5 and 6), not from taste. See ladder.js for how they are turned into a generated
 * ladder for the source now playing.
 *
 *  - Sharpening is RCAS at its gentlest (low = SHARPNESS 2.0) and nothing stronger.
 *  - The super-resolution network is FSRCNNX and nothing else, measured against fsrcnnx-heavy
 *    and Anime4K and found no better in the general case.
 *  - Denoise helps only on GRAINY HIGH-BITRATE material, so it appears only in the upper rungs.
 */
export var LADDER_SHARPEN = 'low';
export var LADDER_SR = 'fsrcnnx';

/*
 * Measured throughput, 960x540 source, session-4 benchmark table (fps). Used only to put a cost
 * hint beside each stage, so the viewer can see that the top of the ladder is several times the
 * GPU of the bottom and that the server's concurrent-session limit will bite sooner there.
 */
export var FPS = {
    1080: { off: 264, sr: 227 },
    1440: { off: 242, sr: 187 },
    2160: { off: 152, sr: 138 }
};

// Measured 720p -> 1440p on this GPU: no denoise 167.5 fps, atadenoise 124.3, nlmeans 59.5.
// OIDN re-measured in the deployed chain on a real source: 200 fps with denoise off against
// 36-42 fps with it, i.e. about 5x. It is not a ladder rung - the entry is here so that a
// Custom selection is costed honestly rather than silently treated as free.
// OptiX measured in the same chain on the same 720p source: 120 fps with denoise off,
// 49.9 with optix spatial, 39.6 with optix-temporal, 35.7 with oidn, at a 1080p target.
export var DENOISE_COST = {
    off: 1, light: 1.35, strong: 2.8, max: 3.1,
    oidn: 5.0, optix: 3.6, 'optix-temporal': 4.5
};

// Neural super-resolution, on the same scale as DENOISE_COST and taken the same way: one
// reading each in the deployed chain, 960x540 source at a 1080p target. 265 fps with it off
// against 24 / 15 / 10 fps gives 11 / 18 / 27. No generated stage ever sets one.
// vsr-rtcuda and dlpp-1..4 are PROVISIONAL, same caveat as GAME_COST below: not measured on
// the same 960x540->1080p baseline as the realesr entries above, so the numbers are a ratio
// argument, not a like-for-like reading. RTXDLPP.md reports roughly 2.3x for the dlpp levels;
// vsr-rtcuda is a resample, not a network, and costs less again.
export var NEURAL_COST = {
    off: 1, 'realesr-anime-x2': 11, 'realesr-anime-x4': 18, 'realesr-general-x4': 27,
    'vsr-rtcuda': 2, 'dlpp-1': 3, 'dlpp-2': 3, 'dlpp-3': 3, 'dlpp-4': 3
};

// Game temporal upscalers, on the same scale as DENOISE_COST and NEURAL_COST. Measured
// 960x540 at a 1080p target in the deployed chain: 87.9 fps with the axis off against 7.8, 4.0
// and 2.7. The indices are PROVISIONAL - the frame rates are measured, putting them on the
// OIDN-5.0 scale is a ratio argument - but the ordering they express is not in doubt.
export var GAME_COST = { off: 1, dlaa: 11, dlss: 22, fsr2: 36 };

// Looked up by name at render time, because a control is declared before these exist.
export var COSTS = { neural: NEURAL_COST, game: GAME_COST };

/*
 * Deblock costs, ESTIMATED not measured, and the comment says so because this project does not
 * pretend a guess is a measurement. deblock is a cheap 8-pixel-grid pass; fspp and pp7 are
 * libpostproc, single-threaded on the CPU at source resolution, and they are the two that turn
 * a working chain into a slideshow. Replace with real numbers when somebody benchmarks them.
 */
export var DEBLOCK_COST = { off: 1, light: 1.15, strong: 1.3, fspp: 2.4, pp7: 2.2 };

/*
 * THE SINGLE MUTABLE STATE OBJECT for the whole client hook. Every module that needs to read or
 * write session state imports this same object, exactly as every function shared one closure
 * scope in the pre-module build - splitting into real modules changes how the pieces are wired
 * together, not the fact that there is one shared, mutable session record.
 */
export var state = {
    version: 17,
    installed: false,
    globals: [],
    chunks: 0,
    modulesWrapped: 0,
    sheetsSeen: 0,
    menuShown: 0,
    marked: [],
    playSessionId: null,
    lastServerState: null,
    // Where the viewer dragged the panel to, as viewport pixels, or null for the built-in
    // corner. Persisted with the other preferences; always re-clamped before it is used.
    panelPos: null,
    // The in-flight drag, and the "applying..." text while a change is being re-negotiated.
    drag: null,
    // The media source the last PlaybackInfo described, so a NEW item can be told from a
    // re-negotiation of the one already playing.
    lastSourceId: null,
    playbackHooked: false,
    applying: null,
    applyTimer: null,
    // True once a re-negotiation was asked for and did not land. Kept because clearing
    // `applying` on its own made a change that never happened look exactly like one that did.
    applyFailed: false,
    // One re-play attempt per selection, cleared on each fresh request, so a stream that
    // refuses to change cannot restart the viewer's film on a loop.
    replayTried: false,
    // jellyfin-web does not put playbackManager on window, so it is recognised by shape
    // in the webpack module exports this script already wraps. Null until a module
    // carrying it has run.
    playbackManagerRef: null,
    // The query string this script last wrote onto a TranscodingUrl, so the live block can
    // tell a record of the CURRENT selections from a record of an older negotiation.
    sentSig: null,
    caps: null,
    // The height of the video stream the server reported for the item being played. Read out
    // of the PlaybackInfo response this script already intercepts, so the menu can drop targets
    // at or below the source instead of offering a downscale as if it were an improvement.
    sourceHeight: null,
    // 'unset' (no opinion - the server's own defaults stand), 'off' (an opinion: play it as
    // it is), 'custom' (the Advanced controls own it), or a stage recipe object.
    stage: 'unset',
    prefs: Object.assign({}, DEFAULT_PREFS)
};

window.__gpuUpscale = state;
