/*
 * GPU Upscale - jellyfin-web client hook.
 *
 * Adds one "Enhance" entry to the player's settings menu. Choosing it opens ONE FLAT PANEL over
 * the video - no nested sheets, no back buttons - carrying, in this order:
 *
 *     Quality     Automatic / Off / Manual, and when Manual, a slider over the graded ladder
 *                 generated for the source now playing
 *     The axes    one row each, grouped by intent, the control type chosen from the data:
 *                 segmented chips for a graded or short axis, a compact picker for a long one
 *     What the    the server's own record for the session playing, refreshed while the panel is
 *     server is   open, including the negatives: bypassed, requested but not applied, no chain
 *     doing       built at all
 *
 * A NEW LEVEL IS DATA. Adding one means an entry in an options array; adding a whole axis means an
 * entry in CONTROLS (with its probe key, its group and, if it grades, its rungs) plus one line in
 * LIVE_ROWS. Neither needs a line of rendering code, which is the point: levels and axes have
 * arrived in four of the last five sessions.
 *
 * THREE STATES, NOT TWO. "Automatic" means the viewer has expressed no opinion, so nothing is sent
 * and the server's own dashboard defaults decide - that is what RequireClientOptIn=false is for.
 * "Off" is an opinion: it is sent as upscale=off, which makes the server skip its defaults too, so
 * the file DIRECT PLAYS exactly as stock Jellyfin would. Silence and Off are not the same answer
 * and this script never conflates them.
 *
 * THE OPTION LISTS BELOW ARE A CEILING, NOT THE MENU. The server reports, in its probe response,
 * which levels it can actually deliver on this machine - a super-resolution level whose shader file
 * was never installed is not in that list - and the menu is the intersection. An option that
 * silently does nothing is worse than an absent one.
 *
 * The SR entries name a shader FAMILY and a WEIGHT rather than a single opaque quality ladder,
 * because the two families are different networks and which one looks right on this content is a
 * judgement for the eye.
 *
 * How the choices reach the server
 * --------------------------------
 * The picks are appended to the media source's TranscodingUrl as the query parameters
 * "upscale", "deblur", "denoise" and "sr". Jellyfin copies every query parameter whose name starts with a
 * lowercase letter into the streaming request's StreamOptions dictionary
 * (Jellyfin.Api ... ParseStreamOptions), so the server reads them back verbatim with
 * BaseRequest.GetOption(...). Unlike a bitrate or a maxHeight, nothing clamps or rewrites them.
 *
 * Every control also has a server-side default in the plugin dashboard, so the features still work
 * if none of this renders.
 *
 * Everything is wrapped in try/catch: if any of it breaks, the stock menus and normal playback are
 * untouched.
 */
(function () {
    'use strict';

    var STORE = 'gpuUpscalePrefs';

    var CONTROLS = [
        {
            key: 'upscale', label: 'Upscale to', fallback: 'off', group: 'Size', chips: true,
            options: [
                { id: 'off', name: 'Off' },
                { id: '1080', name: '1080p' },
                { id: '1440', name: '1440p' },
                { id: '2160', name: '4K (2160p)' }
            ]
        },
        {
            // The levels are AMD RCAS. Its own SHARPNESS scale is INVERTED - 0.0 is maximum, 2.0
            // is gentlest - so low/medium/high map to 2.0/1.7/1.4 on the server. These labels read
            // in the ordinary direction on purpose: the viewer should never meet the inversion,
            // and nothing here should tempt anyone to "turn it up" by raising a number.
            key: 'deblur', label: 'Unblur', fallback: 'off', group: 'Sharpness',
            probeKey: 'Deblur', grade: ['off', 'low', 'medium', 'high'],
            options: [
                { id: 'off', name: 'Off' },
                { id: 'low', name: 'Gentle' },
                { id: 'medium', name: 'Medium' },
                { id: 'high', name: 'Strong' },
                // NVIDIA Image Sharpening. Measured slightly nearer the ground truth on detail than
                // RCAS but 0.70 dB worse on fidelity and about ten times the GPU overhead, so it is
                // not a default - it is here because it is stable and the difference is a matter of
                // taste on real footage.
                { id: 'nvsharpen', name: 'NVSharpen (NVIDIA)' },
                { id: 'nvsharpen-strong', name: 'NVSharpen strong' }
            ]
        },
        {
            // A cost ladder across two filter families, not one filter turned up. Light is
            // atadenoise (adaptive temporal, CPU): measured -30% flicker for -0.20 dB at 124 fps
            // where nlmeans gave -2% flicker for -0.35 dB at 60 fps. Strong and Max are nlmeans,
            // a SPATIAL denoiser, kept because it attacks grain a temporal filter leaves alone.
            // hqdn3d was retired (no recovery at all) and tmix is deliberately absent (it ghosts
            // even on 96% still content) - both are recorded in ShaderLibrary.
            key: 'denoise', label: 'Denoise', fallback: 'off', group: 'Noise',
            probeKey: 'Denoise', grade: ['off', 'light', 'strong', 'max'],
            options: [
                { id: 'off', name: 'Off' },
                { id: 'light', name: 'Light (temporal)' },
                { id: 'strong', name: 'Strong (spatial, slower)' },
                { id: 'max', name: 'Max (slowest)' },
                // Intel Open Image Denoise, carried by a separate patched ffmpeg binary that only
                // this level ever reaches. Offered here and nowhere else: it is not a ladder rung,
                // because it is the most expensive level on offer and measures as a no-op on this
                // library's normal bitrates. It earns its place only on grainy high-bitrate video.
                { id: 'oidn', name: 'OIDN (Intel, grainy sources only - slow)' },
                // NVIDIA OptiX, out of the same patched binary. The temporal entry is the one
                // worth offering: it is the only level here that uses motion between frames, so
                // it is the only one that can touch flicker rather than grain. Neither is a
                // ladder rung; both are reachable only from this Advanced row.
                { id: 'optix', name: 'OptiX (NVIDIA, spatial - slow)' },
                { id: 'optix-temporal', name: 'OptiX temporal (NVIDIA, anti-flicker - slowest)' }
            ]
        },
        {
            // NEURAL SUPER-RESOLUTION - a different mechanism from the Detail row below, not a
            // better grade of it. Detail is a libplacebo shader inside the scaling pass; these are
            // ONNX networks run by ONNX Runtime on CUDA, ahead of it, out of the same patched
            // ffmpeg binary that carries OIDN and OptiX. The two compose.
            //
            // Measured once each in the deployed chain, 960x540 source at a 1080p target, against
            // 265 fps with this off: x2 24 fps (0.56x realtime), anime x4 15 fps (0.34x), general
            // x4 10 fps (0.24x). NONE of them reaches realtime for one session, so every entry
            // says so in its own name. Not a ladder rung and never chosen for anyone.
            key: 'neural', label: 'Neural super-resolution', fallback: 'off', group: 'Detail',
            probeKey: 'Neural', costKey: 'neural',
            options: [
                { id: 'off', name: 'Off' },
                { id: 'realesr-anime-x2', name: 'Real-ESRGAN x2 anime (0.56x realtime - slow)' },
                { id: 'realesr-anime-x4', name: 'Real-ESRGAN x4 anime (0.34x realtime - very slow)' },
                { id: 'realesr-general-x4', name: 'Real-ESRGAN x4 general (0.24x realtime - slowest)' }
            ]
        },
        {
            // GAME TEMPORAL UPSCALERS - FSR2, DLSS SR and DLAA, which were built for a game engine
            // that hands them true motion vectors, a depth buffer and a jittered camera. Video has
            // none of those, so the server synthesises them, and every level says "degraded" in the
            // wording the SERVER supplies. The options and their names are taken whole from the
            // probe (`Game` and `GameLabels`): nothing here decides which of them exists, and
            // nothing here writes their wording.
            //
            // They are the most expensive levels in the project - measured 960x540 to 1080p in the
            // deployed chain: 87.9 fps with the axis off against 7.8 (dlaa), 4.0 (dlss) and 2.7
            // (fsr2) - so each option carries its cost beside it. None is ever a ladder rung.
            key: 'game', label: 'Game temporal upscaler', fallback: 'off', group: 'Detail',
            probeKey: 'Game', labelsKey: 'GameLabels', fromProbe: true, costKey: 'game',
            options: [{ id: 'off', name: 'Off' }]
        },
        {
            // THE THREE SYNTHESISED INPUTS of the game upscalers, and the only controls here that
            // are not always shown. They change nothing unless a game upscaler is running, so
            // `showWhen` hides them unless the chosen game level is one the SERVER says they act
            // on (`GameOptionLevels` from the probe - today fsr2, dlss and dlaa, since dlaa is the
            // same filter and is handed the same depth, jitter and mask). A row that can do
            // nothing is not shown, which is why these waited for the server to read them.
            //
            // Values and wording come whole from the probe, like the game levels themselves.
            // 'default' is this script's own neutral id: it sends nothing, so the dashboard value
            // applies, exactly as it does on Refine, Chroma and Debanding.
            key: 'jitter', label: 'Game upscaler: jitter source', fallback: 'default', group: 'Detail',
            probeKey: 'GameJitter', labelsKey: 'GameJitterLabels', fromProbe: true,
            showWhen: { key: 'game', levelsKey: 'GameOptionLevels' },
            options: [{ id: 'default', name: 'Server default' }]
        },
        {
            key: 'depth', label: 'Game upscaler: depth source', fallback: 'default', group: 'Detail',
            probeKey: 'GameDepth', labelsKey: 'GameDepthLabels', fromProbe: true,
            showWhen: { key: 'game', levelsKey: 'GameOptionLevels' },
            options: [{ id: 'default', name: 'Server default' }]
        },
        {
            key: 'reactive', label: 'Game upscaler: reactive mask', fallback: 'default', group: 'Detail',
            probeKey: 'GameReactive', labelsKey: 'GameReactiveLabels', fromProbe: true,
            showWhen: { key: 'game', levelsKey: 'GameOptionLevels' },
            options: [{ id: 'default', name: 'Server default' }]
        },
        {
            // Two different networks, not one quality ladder. The name says which family and
            // which weight, so the viewer can tell them apart rather than trusting an opaque
            // "Light / Standard / Max" that hid a family swap.
            key: 'sr', label: 'Detail (super-resolution)', fallback: 'fsrcnnx', group: 'Detail',
            probeKey: 'Sr',
            options: [
                { id: 'off', name: 'Off (plain scaling)' },
                { id: 'fsrcnnx', name: 'FSRCNNX' },
                { id: 'fsrcnnx-heavy', name: 'FSRCNNX heavy' },
                { id: 'anime4k-s', name: 'Anime4K S' },
                { id: 'anime4k-m', name: 'Anime4K M' },
                // An upscaler that sharpens inside its own pass, so the server drops the separate
                // unblur pass for it rather than stacking two sharpeners into ringing. It measured
                // +13% detail overshoot against the ground truth here, which is why it is offered
                // but never used by a quality stage.
                { id: 'nvscaler', name: 'NVScaler (NVIDIA, sharpens itself)' },
                // The one entry here that is not a fixed-2x network: ravu-zoom is handed the
                // output size and scales to it at any ratio, so the server does not apply the
                // super-resolution ratio bypass to it.
                { id: 'ravu-zoom', name: 'RAVU-Zoom r3 (any ratio, GPU light)' },
                // CuNNy, int8 dp4a. Fixed 2x like FSRCNNX, so the ratio bypass applies to these
                // exactly as it does to FSRCNNX. Small to large.
                { id: 'cunny-fast', name: 'CuNNy fast (GPU light)' },
                { id: 'cunny', name: 'CuNNy 4x16 (GPU light)' },
                { id: 'cunny-heavy', name: 'CuNNy 4x32 (GPU moderate)' },
                { id: 'cunny-ds', name: 'CuNNy 4x16 DS, denoise + sharpen (GPU moderate)' }
            ]
        },
        {
            // POST-SCALE REFINEMENT, and a separate axis rather than another super-resolution
            // level: it hooks POSTKERNEL, so it corrects the enlargement the chain already made
            // and composes with whichever network (or none) produced it. Being ratio-agnostic, it
            // is also the only thing here that runs below the server's super-resolution threshold,
            // where the fixed-2x networks are bypassed and the chain is plain scaling plus a
            // sharpener. "Server default" sends nothing, like Debanding.
            key: 'refine', label: 'Refine (post-scale)', fallback: 'default', group: 'Detail', chips: true,
            probeKey: 'Refine',
            options: [
                { id: 'default', name: 'Server default' },
                { id: 'off', name: 'Off' },
                { id: 'ssimsuperres', name: 'SSimSuperRes (GPU light)' }
            ]
        },
        {
            // CHROMA upscaling - the colour planes, which every other control here leaves to the
            // plain kernel. These sources are 4:2:0, so chroma is stored at quarter resolution.
            // Composes with any super-resolution level rather than replacing one.
            key: 'chroma', label: 'Chroma upscaling', fallback: 'default', group: 'Detail', chips: true,
            probeKey: 'Chroma',
            options: [
                { id: 'default', name: 'Server default' },
                { id: 'off', name: 'Off' },
                { id: 'krigbilateral', name: 'KrigBilateral (GPU moderate)' }
            ]
        },
        {
            // Debanding rides on the libplacebo instance the chain is building anyway. "Server
            // default" sends nothing and lets the dashboard decide, which is what every client
            // without this script gets.
            key: 'deband', label: 'Debanding', fallback: 'default', group: 'Picture', chips: true,
            options: [
                { id: 'default', name: 'Server default' },
                { id: 'on', name: 'On' },
                { id: 'off', name: 'Off' }
            ]
        },
        {
            // The libplacebo scaling kernel. The list comes from the server's own whitelist, since
            // an unknown kernel name does not soften the picture - it fails the whole job.
            key: 'kernel', label: 'Scaling kernel', fallback: 'default', group: 'Picture',
            probeKey: 'Upscalers', fromProbe: true,
            options: [{ id: 'default', name: 'Server default' }]
        }
    ];

    // Names the previous build wrote into localStorage. Mapped on load so an existing viewer does
    // not come back to a control showing a level that is no longer in its own option list.
    var SR_ALIASES = { light: 'fsrcnnx', standard: 'fsrcnnx', max: 'fsrcnnx-max' };

    /* The axes that only act while a game upscaler is running. Named once, used by addParams. */
    var GAME_OPTION_KEYS = ['jitter', 'depth', 'reactive'];

    var DEFAULT_PREFS = {
        upscale: 'off', deblur: 'off', denoise: 'off', neural: 'off', game: 'off', sr: 'fsrcnnx',
        deband: 'default', kernel: 'default', refine: 'default', chroma: 'default',
        jitter: 'default', depth: 'default', reactive: 'default'
    };

    /*
     * THE QUALITY LADDER, AND WHY IT IS BUILT RATHER THAN LISTED.
     *
     * Every choice below comes from what was measured on this deployment (HANDOVER-gpuupscale.md
     * sessions 4, 5 and 6), not from taste. The
     * ladder is GENERATED for the source now playing rather than being a fixed list of names,
     * because the honest set of stages is not the same for a 540p source and a 1080p one.
     *
     * What the measurements allow, and therefore what the ladder is made of:
     *
     *  - Sharpening is RCAS at its gentlest (low = SHARPNESS 2.0) and nothing stronger. At 1.5x it
     *    took detail energy from 3.28 to 3.60 against a ground truth of 3.52, for about 1% of
     *    throughput. Medium and high overshoot the ground truth, so they are not rungs; they stay
     *    in Advanced for anyone who wants them.
     *  - The super-resolution network is FSRCNNX and nothing else. fsrcnnx-heavy measured no better
     *    for roughly twice the GPU time, and Anime4K measured BELOW plain scaling at 1.5x and only
     *    competes at its native 2.0x on animation. Neither is an improvement in the general case,
     *    so neither is a rung; both stay in Advanced.
     *  - Denoise helps only on GRAINY HIGH-BITRATE material and returns essentially nothing on a
     *    normally compressed source, where the encoder has already removed the temporal noise, so
     *    it appears only in the upper rungs. The cheap rung is atadenoise (-26% throughput), the
     *    top rung nlmeans (-64%), and the cost hint says plainly what each costs.
     *  - Below the server's SrMinScaleFactor the network is bypassed, so a stage that switched it
     *    on there would be a rung that does nothing. srWouldRun() drops that stage instead of
     *    shipping a fake one, which is why a 720p source (1.5x to 1080p) has a shorter ladder than
     *    a 540p source (2.0x).
     *
     * A stage is stored as a RECIPE, not as a number: which eligible target (by rank), whether the
     * network is on, and how much denoise. A number would mean something different on the next
     * item, whose ladder may be a different length.
     */
    var LADDER_SHARPEN = 'low';
    var LADDER_SR = 'fsrcnnx';

    /*
     * Measured throughput, 960x540 source, session-4 benchmark table (fps). Used only to put a cost
     * hint beside each stage, so the viewer can see that the top of the ladder is several times the
     * GPU of the bottom and that the server's concurrent-session limit will bite sooner there.
     */
    var FPS = {
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
    // Placed on the same scale as the oidn entry that is 3.6 and 4.5. Neither is a ladder rung;
    // the entries exist so that a Custom selection is costed honestly rather than treated as free.
    var DENOISE_COST = {
        off: 1, light: 1.35, strong: 2.8, max: 3.1,
        oidn: 5.0, optix: 3.6, 'optix-temporal': 4.5
    };

    // Neural super-resolution, on the same scale as DENOISE_COST and taken the same way: one
    // reading each in the deployed chain, 960x540 source at a 1080p target. 265 fps with it off
    // against 24 / 15 / 10 fps gives 11 / 18 / 27. Those numbers dwarf everything else on this
    // scale, which is the honest answer - these are not a dear option, they are a different order
    // of cost - and like the OIDN and OptiX entries they exist only so that a Custom selection is
    // costed rather than silently treated as free. No generated stage ever sets one.
    var NEURAL_COST = {
        off: 1, 'realesr-anime-x2': 11, 'realesr-anime-x4': 18, 'realesr-general-x4': 27
    };

    // Game temporal upscalers, on the same scale as DENOISE_COST and NEURAL_COST. Measured
    // 960x540 at a 1080p target in the deployed chain: 87.9 fps with the axis off against 7.8, 4.0
    // and 2.7. The indices are PROVISIONAL - the frame rates are measured, putting them on the
    // OIDN-5.0 scale is a ratio argument - but the ordering they express is not in doubt: these are
    // the most expensive levels here, every one of them slower than every neural model.
    var GAME_COST = { off: 1, dlaa: 11, dlss: 22, fsr2: 36 };

    // Looked up by name at render time, because a control is declared before these exist.
    var COSTS = { neural: NEURAL_COST, game: GAME_COST };

    var state = {
        version: 16,
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
        caps: null,
        // The height of the video stream the server reported for the item being played. Read out
        // of the PlaybackInfo response this script already intercepts, so the menu can drop targets
        // at or below the source instead of offering a downscale as if it were an improvement.
        sourceHeight: null,
        // 'unset' (no opinion - the server's own defaults stand), 'off' (an opinion: play it as
        // it is), 'custom' (the Advanced controls own it), or a stage recipe object.
        stage: 'unset',
        prefs: {
            upscale: 'off', deblur: 'off', denoise: 'off', neural: 'off', game: 'off', sr: 'fsrcnnx',
            deband: 'default', kernel: 'default', refine: 'default', chroma: 'default',
            jitter: 'default', depth: 'default', reactive: 'default'
        }
    };
    window.__gpuUpscale = state;

    function log() {
        try {
            if (window.localStorage && window.localStorage.getItem('gpuUpscaleDebug')) {
                console.log.apply(console, ['[gpu-upscale]'].concat(Array.prototype.slice.call(arguments)));
            }
        } catch (e) { /* ignore */ }
    }

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

    function savePrefs() {
        try {
            window.localStorage.setItem(STORE, JSON.stringify({
                stage: state.stage,
                upscale: state.prefs.upscale,
                deblur: state.prefs.deblur,
                denoise: state.prefs.denoise,
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

    /* The levels and thresholds the server reported, or null when it has not been reached yet. */
    function serverConfig() {
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
    function eligibleTargets() {
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
    function srWouldRun(targetHeight) {
        var cfg = serverConfig();
        if (!cfg || !state.sourceHeight || !(cfg.SrMinScaleFactor > 1)) {
            return true;
        }

        return targetHeight >= state.sourceHeight * cfg.SrMinScaleFactor;
    }

    /* An indicative GPU cost for a stage, relative to the cheapest upscale measured. */
    function stageCost(height, sr, denoise, neural) {
        var row = FPS[height] || FPS[1080];
        var fps = sr ? row.sr : row.off;
        return (FPS[1080].off / fps) * (DENOISE_COST[denoise] || 1) * (NEURAL_COST[neural] || 1);
    }

    function costHint(cost) {
        // Three bands rather than a bare number, because what the viewer needs to know is how many
        // of these the server can run at once, not a ratio.
        if (cost < 1.5) { return 'light'; }
        return cost < 2.2 ? 'moderate' : 'heavy';
    }

    /*
     * The ladder for the source now playing, cheapest first. Each entry is one genuinely different
     * filter chain: no two differ only in name. Returns [] when this server would not upscale this
     * source at all (taller than MaxSourceHeight), and null when there is not enough information
     * yet to build one honestly.
     *
     * Within one target the order is the measured one - sharpen, then the network, then denoise -
     * and across targets it is by computed cost, so a later stage never costs less than an earlier
     * one.
     */
    function ladder() {
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
    function recommendedStage() {
        var l = ladder();
        if (!l || !l.length) {
            return null;
        }

        var wanted = l.filter(function (st) { return st.rank === 0 && st.denoise === 'off'; });
        return (wanted.length ? wanted[wanted.length - 1] : l[0]);
    }

    function sameStage(a, b) {
        return !!a && !!b && a.rank === b.rank && !!a.sr === !!b.sr && a.denoise === b.denoise;
    }

    /* The stage the stored recipe lands on for THIS source, or null if the ladder has no room. */
    function currentStage() {
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

    /*
     * What this session is actually asking for. null means "nothing at all": the viewer has
     * expressed no opinion, so no marker is sent and the server's defaults stand untouched.
     */
    function effective() {
        if (state.stage === 'unset') {
            return null;
        }

        if (state.stage === 'off') {
            return { upscale: 'off', deblur: 'off', denoise: 'off', neural: 'off', game: 'off', sr: 'off' };
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

    function anyEnhancement() {
        var e = effective();
        // upscale === null is "let the server pick the target", which is still an enhancement.
        return !!e && (e.upscale !== 'off' || e.deblur !== 'off' || e.denoise !== 'off');
    }

    /* ------------------------------------------------------------ the Enhance settings menu */

    /*
     * Rather than hooking the minified module that builds the player's settings list, the shared
     * action-sheet component is wrapped and the sheet is recognised by its SHAPE: the player
     * settings sheet is the one carrying an item with id "quality" or "aspectratio". That survives
     * module renumbering, and an unrecognised sheet is passed straight through.
     *
     * The sheet is the ENTRY POINT ONLY. Choosing "Enhance" opens one flat panel of this script's
     * own making - every control on one surface, no drill-down, no back buttons - so nothing below
     * depends on the action sheet's shape beyond that single entry.
     */
    function isPlayerSettingsSheet(items) {
        return Array.isArray(items) && items.some(function (i) {
            return i && (i.id === 'quality' || i.id === 'aspectratio' || i.id === 'playbackrate');
        });
    }

    /* What one stage actually does, in the viewer's words rather than the engine's. */
    function stageText(st) {
        var bits = [st.height + 'p'];
        bits.push(st.sr ? 'FSRCNNX + sharpen' : 'sharpen');
        if (st.denoise !== 'off') {
            bits.push(st.denoise === 'strong' ? 'strong denoise' : 'denoise');
        }

        return bits.join(', ');
    }

    /* The label on the Enhance row and in the panel header: always what is actually in force. */
    function summaryText() {
        if (state.stage === 'unset') { return 'Automatic'; }
        if (state.stage === 'off') { return 'Off'; }
        if (state.stage === 'custom') { return 'Custom - ' + advancedText(); }

        var st = currentStage();
        return st ? (st.n + '. ' + stageText(st)) : 'Not available for this source';
    }

    function advancedText() {
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

    function wrapActionSheet(ns) {
        try {
            if (!ns || typeof ns !== 'object' || ns.__gpuUpscaleSheet || typeof ns.show !== 'function') {
                return;
            }

            // Webpack defines ES module exports as non-configurable getters, so only a plain object
            // (such as an "export default { show }" component) can be wrapped. Check before
            // assigning rather than throwing inside the module factory.
            var own = Object.getOwnPropertyDescriptor(ns, 'show');
            if (own && !own.writable && !own.configurable) {
                return;
            }

            var originalShow = ns.show;
            ns.show = function (options) {
                try {
                    if (options && isPlayerSettingsSheet(options.items) && !options.__gpuUpscaleOwn) {
                        state.sheetsSeen++;
                        options.items = options.items.concat([{
                            name: 'Enhance', id: 'gpuupscale-enhance', asideText: summaryText()
                        }]);

                        var self = this;
                        return originalShow.apply(self, arguments).then(function (chosen) {
                            if (chosen !== 'gpuupscale-enhance') {
                                return chosen;
                            }

                            openEnhancePanel();
                            return Promise.reject();
                        });
                    }
                } catch (err) {
                    log('sheet wrap failed', err);
                }

                return originalShow.apply(this, arguments);
            };

            ns.__gpuUpscaleSheet = true;
            state.sheetWraps = (state.sheetWraps || 0) + 1;
        } catch (err) {
            log('could not wrap action sheet', err);
        }
    }

    /*
     * The server-side half of this plugin ships in two generations. The older one only understands
     * an upscale target (signalled with maxHeight); the newer one also honours "deblur" and "sr"
     * and serves /GpuUpscale/Session/{id}. Probe for the newer endpoint and only offer the controls
     * the running server can actually act on, so the menu never promises something that will
     * silently do nothing.
     *
     * Only a SUCCESSFUL probe is cached. A failure is deliberately not remembered: the probe fails
     * while the server is restarting, and caching that for the life of the page left the panel
     * showing nothing but "Upscale to" until the viewer reloaded, with no way to tell why.
     * A failed probe is retried the next time the panel is opened.
     */
    function probeServer() {
        if (state.serverCaps && state.serverCaps.full) {
            return Promise.resolve(state.serverCaps);
        }

        var no = { full: false };
        try {
            var client = window.ApiClient;
            if (!client || typeof client.getUrl !== 'function') {
                return Promise.resolve(no);
            }

            return client.ajax({
                type: 'GET',
                url: client.getUrl('GpuUpscale/Session/probe'),
                dataType: 'json'
            }).then(function (res) {
                // The probe answer carries the levels this server can really deliver. Keep them:
                // axisControls narrows the option lists to them. A server too old to send Levels
                // leaves it null, and the panel falls back to the full lists, which is what that
                // generation could do anyway.
                state.serverCaps = { full: true, levels: (res && res.Levels) || null };
                log('server probe: full capabilities', state.serverCaps.levels);
                return state.serverCaps;
            }, function (err) {
                log('server probe failed; will retry on next panel open', err);
                return no;
            });
        } catch (err) {
            return Promise.resolve(no);
        }
    }

    /*
     * The levels the server said it can deliver, for one control, or null when it did not say.
     * The key names are the server's: Sr, Deblur, Denoise. A control carries its own probe key in
     * its data, so a NEW AXIS is one entry in CONTROLS and nothing else.
     */
    function serverLevels(caps, control) {
        var list = caps && caps.levels && control.probeKey ? caps.levels[control.probeKey] : null;
        return (list && list.length) ? list : null;
    }

    /*
     * The controls to render, narrowed to what this server and this source can really do.
     *
     * Everything here is driven by the CONTROLS data: which probe key holds the level list, which
     * ids form the graded run, what the neutral fallback is. Nothing below knows the name of an
     * axis or of a level.
     */
    function axisControls(caps) {
        var targets = eligibleTargets();
        return (caps.full ? CONTROLS : CONTROLS.filter(function (c) { return c.key === 'upscale'; }))
            // A control that could not change anything is not rendered. The test is data on the
            // control and a list from the server: show it only while the axis it depends on is
            // set to a level the server says it acts on.
            .filter(function (c) {
                if (!c.showWhen) {
                    return true;
                }

                var acts = (caps.levels && caps.levels[c.showWhen.levelsKey]) || [];
                return acts.indexOf(state.prefs[c.showWhen.key]) >= 0;
            })
            .map(function (c) {
                var allowed = serverLevels(caps, c);
                var options = allowed
                    // "default" is this script's own id, not a server level: it means "send no
                    // marker and let the dashboard decide". It is never in the server's list, so it
                    // has to survive the intersection or the Refine, Chroma and Debanding rows
                    // would lose their only neutral option.
                    ? c.options.filter(function (o) { return o.id === 'default' || allowed.indexOf(o.id) >= 0; })
                    : c.options;
                // Never end up with an empty control: if the server and this script agree on
                // nothing, showing the built-in list is better than showing a dead row.
                if (!options.length) {
                    options = c.options;
                }

                if (c.fromProbe) {
                    // THE SERVER OWNS THIS LIST AND ITS WORDING. The levels come from the probe and
                    // the names from the map the probe names in `labelsKey`, so a level this build
                    // has never heard of still appears, correctly labelled, and a level the server
                    // withdrew disappears. The control's own options are seeds - the neutral
                    // entries, such as "Server default" - and a seed wins over the probe's name for
                    // the same id.
                    var listed = (caps.levels && caps.levels[c.probeKey]) || [];
                    var labels = (c.labelsKey && caps.levels && caps.levels[c.labelsKey]) || {};
                    var seeded = c.options.map(function (o) { return o.id; });
                    options = c.options.concat(listed
                        .filter(function (id) { return seeded.indexOf(id) < 0; })
                        .map(function (id) { return { id: id, name: labels[id] || id }; }));
                }

                if (c.key === 'upscale' && targets !== null) {
                    // ONLY TARGETS ABOVE THE SOURCE. A target at or below the source height is a
                    // downscale or a no-op, and one within MinScaleFactor of it is refused by the
                    // server outright, so neither belongs in the panel. Off always stays.
                    var ids = targets.map(function (t) { return t.id; });
                    options = options.filter(function (o) {
                        return o.id === 'off' || ids.indexOf(o.id) >= 0;
                    }).map(function (o) {
                        // Honest about what the server will actually run: below SrMinScaleFactor
                        // the network is bypassed and plain scaling plus the sharpener does the
                        // work, which is not nothing - so the target is still offered, and said so.
                        if (o.id === 'off' || srWouldRun(parseInt(o.id, 10))) {
                            return o;
                        }

                        return { id: o.id, name: o.name + ' (plain scaling at this ratio)' };
                    });
                }

                return {
                    key: c.key, label: c.label, fallback: c.fallback, group: c.group || 'Detail',
                    grade: c.grade || null, chips: !!c.chips, costKey: c.costKey || null,
                    showWhen: c.showWhen || null, options: options
                };
            });
    }

    /*
     * A note under one row, when the server has something to say about it that the option name
     * cannot. Data, not a special case per axis: each entry names the control it annotates and a
     * test over the live session record.
     */
    var CONTROL_NOTES = [
        {
            key: 'sr',
            text: function () {
                var s = state.lastServerState;
                return (s && s.Known && s.SrBypassed && state.prefs.sr !== 'off')
                    ? 'The server bypassed this at the current ratio: plain scaling plus the sharpener ran instead.'
                    : '';
            }
        },
        {
            key: 'sr',
            text: function () {
                // fsr2 and dlss produce the target size themselves, so the server drops this pass
                // and reports SrLevel "off" with GameApplied true. That is the SERVER'S signal, read
                // straight out of the record - never worked out from what the viewer picked.
                var s = state.lastServerState;
                return (s && s.Known && s.GameApplied && isOff(s.SrLevel) && state.prefs.sr !== 'off')
                    ? 'The game temporal upscaler produced the target size, so the server dropped'
                      + ' this pass. It did not run.'
                    : '';
            }
        },
        {
            key: 'deblur',
            text: function () {
                var s = state.lastServerState;
                if (s && s.Known && s.SrOwnsSharpening) {
                    return 'Not used: the chosen upscaler sharpens inside its own pass.';
                }

                return '';
            }
        },
        {
            key: 'upscale',
            text: function () {
                var t = eligibleTargets();
                return (t && !t.length)
                    ? 'This source is at or above the server\'s upscale limit, so no target is offered.'
                    : '';
            }
        }
    ];

    function controlNote(key) {
        var out = '';
        CONTROL_NOTES.forEach(function (n) {
            if (n.key !== key) {
                return;
            }

            try {
                var t = n.text();
                if (t) { out = out ? out + ' ' + t : t; }
            } catch (e) { /* a note is never worth breaking the panel for */ }
        });
        return out;
    }

    /*
     * APPLYING A CHANGE LIVE - and it is jellyfin-web's own quality-change path, not a new one.
     *
     * playbackManager.setMaxStreamingBitrate() ends in the module-private changeStream(), which is
     * the same function the stock quality menu reaches when a viewer picks a bitrate. That
     * function already does every hard part of this:
     *
     *   - it re-requests PlaybackInfo, so this script's request and response hooks mark the new
     *     negotiation exactly as they mark a fresh playback. That is what makes BOTH direct-play
     *     crossovers work without a special case here: picking a stage while direct playing goes
     *     through the request rewrite that sets EnableDirectPlay/EnableDirectStream false, and
     *     picking Off stops forcing it, so the server is free to hand back a direct-play source.
     *   - it restarts the player at the current position (current ticks plus the transcoding
     *     offset), which discards the stale buffer along with the old stream.
     *   - it calls stopActiveEncodings(oldPlaySessionId) both before and after the switch. That is
     *     what stops the abandoned ffmpeg holding one of the server's MaxConcurrent slots until it
     *     times out - one viewer walking down a slider must not exhaust them.
     *
     * The bitrate handed back is the one already in force, so nothing about the quality changes;
     * the call is only the carrier. It does persist "not automatic" for the bitrate, exactly as
     * picking a quality from the stock menu does, which is why it is not done when the value is
     * not a number we can hand back unchanged.
     *
     * DEBOUNCED, because dragging a slider through five rungs must start one transcode, not five.
     * FAIL SAFE: every failure path leaves playback exactly as it was and says the change will
     * apply on the next playback, rather than taking the player down with it.
     */
    var APPLY_DEBOUNCE = 700;

    function panelEl() {
        return document.getElementById(PANEL_ID);
    }

    function repaintPanel() {
        try {
            var p = panelEl();
            if (p) { renderPanel(p, state.caps || { full: false }); }
        } catch (err) { /* the panel is never worth breaking playback for */ }
    }

    function playerPresent() {
        try {
            var pm = window.playbackManager;
            return !!(pm
                && typeof pm.setMaxStreamingBitrate === 'function'
                && typeof pm.getMaxStreamingBitrate === 'function'
                && typeof pm.currentItem === 'function'
                && pm.currentItem());
        } catch (err) {
            return false;
        }
    }

    /*
     * The change is finished when a NEW PlaySessionId comes back - which this script learns from
     * the PlaybackInfo response it is already reading, so nothing extra is polled off the server.
     * The timeout exists so the label cannot stick on forever if the negotiation never lands.
     */
    function watchApplied(previousId) {
        var tries = 0;
        var timer = setInterval(function () {
            try {
                tries++;
                var done = (state.playSessionId && state.playSessionId !== previousId) || tries > 48;
                if (done) {
                    clearInterval(timer);
                    state.applying = null;
                    repaintPanel();
                }
            } catch (err) {
                clearInterval(timer);
                state.applying = null;
            }
        }, 250);
    }

    function doApply() {
        state.applyTimer = null;
        if (!playerPresent()) {
            state.applying = null;
            repaintPanel();
            return;
        }

        var previousId = state.playSessionId;
        try {
            var pm = window.playbackManager;
            var current = pm.getMaxStreamingBitrate();
            if (!(current > 0)) {
                // Handing back a value that is not a bitrate would overwrite the viewer's own
                // saved setting with nothing. Not worth it: say so and leave playback alone.
                log('no current bitrate to hand back; the change applies on the next playback');
                state.applying = null;
                repaintPanel();
                return;
            }

            state.applying = 'applying\u2026';
            repaintPanel();
            pm.setMaxStreamingBitrate({ enableAutomaticBitrateDetection: false, maxBitrate: current });
            log('asked the player to renegotiate at the current position');
            watchApplied(previousId);
        } catch (err) {
            log('could not renegotiate; the change applies on the next playback', err);
            state.applying = null;
            repaintPanel();
        }
    }

    /* Called by every control. Debounced, and a no-op when nothing is playing. */
    function requestRestream() {
        try {
            if (state.applyTimer) {
                clearTimeout(state.applyTimer);
                state.applyTimer = null;
            }

            if (!playerPresent()) {
                log('nothing is playing; the change applies on the next playback');
                return;
            }

            state.applying = 'applying\u2026';
            state.applyTimer = setTimeout(doApply, APPLY_DEBOUNCE);
        } catch (err) {
            log('could not schedule the change', err);
        }
    }

    /* ------------------------------------------------------------------ what the server DID */

    /*
     * The live rows. One entry per axis, naming the fields of the session record it reads, so an
     * axis added to CONTROLS is reported here by adding one line of DATA, not by writing rendering
     * code. `applied` false against a level that is not "off" is the "requested but not applied"
     * case, and it is always shown.
     */
    var LIVE_ROWS = [
        { label: 'Upscaled', level: 'Upscaler', applied: 'UpscaleApplied' },
        { label: 'Detail (SR)', level: 'SrLevel', requested: 'SrRequested' },
        { label: 'Unblur', level: 'DeblurLevel', applied: 'DeblurApplied' },
        { label: 'Denoise', level: 'DenoiseLevel', applied: 'DenoiseApplied' },
        { label: 'Neural SR', level: 'NeuralLevel' },
        { label: 'Game upscaler', level: 'GameLevel', applied: 'GameApplied' },
        // What the server actually ran those three with - read from the record, never from what
        // this panel asked for. Null when no game upscaler ran, and a null row prints nothing.
        { label: 'Game jitter', level: 'GameJitter' },
        { label: 'Game depth', level: 'GameDepth' },
        { label: 'Game reactive mask', level: 'GameReactive' },
        { label: 'Refine', level: 'RefineLevel', applied: 'RefineApplied' },
        { label: 'Chroma', level: 'ChromaLevel', applied: 'ChromaApplied' },
        { label: 'Debanding', applied: 'DebandApplied' },
        { label: 'Encoder', level: 'Encoder', note: 'EncoderReason' }
    ];

    function isOff(v) {
        return v == null || v === '' || v === 'off' || v === false;
    }

    /*
     * The lines of the live block, as [label, value] pairs. NEGATIVES ARE NEVER DROPPED: a level
     * that was asked for and did not run is reported in the same list as one that did, and a
     * session the server knows nothing about says exactly that rather than showing the viewer's
     * own request back to them.
     */
    function liveLines() {
        var s = state.lastServerState;
        if (!s) {
            return [['Status', state.playSessionId
                ? 'Waiting for the server to answer for this session.'
                : 'No stream yet. Start playback to see what the server does.']];
        }

        if (s.PatchActive === false) {
            return [['Status', 'Enhancement is unavailable: the server-side patches are not active.']];
        }

        if (!s.Known) {
            // The server writes a record only when it builds a filter chain. No record means no
            // chain: direct play, a stream copy, or a session it never saw.
            return [
                ['Status', s.Status || 'unknown'],
                ['What ran', (s.Summary || 'No enhancement')
                    + ' - no filter chain was built for this session, so this is a direct play, a'
                    + ' stream copy, or a stream the server has not started yet.']
            ];
        }

        var lines = [['What ran', s.Summary || 'No enhancement']];
        if (s.Status) {
            lines.push(['Status', s.Status]);
        }

        LIVE_ROWS.forEach(function (r) {
            var val = r.level ? s[r.level] : null;
            if (!r.level && r.applied) {
                val = s[r.applied] ? 'on' : 'off';
            }

            var applied = r.applied ? s[r.applied] : null;
            var requested = r.requested ? s[r.requested] : null;
            var text = null;

            if (applied === false && !isOff(val)) {
                text = String(val) + ' - requested, not applied';
            } else if (requested != null && !isOff(requested) && requested !== val) {
                text = 'requested ' + requested + ', ran ' + (isOff(val) ? 'nothing' : val);
            } else if (!isOff(val)) {
                text = String(val);
            }

            if (r.label === 'Detail (SR)' && s.SrBypassed) {
                text = (text || 'off') + ' - bypassed at this ratio, plain scaling plus sharpener';
            }

            if (text && r.note && s[r.note]) {
                text += ' (' + s[r.note] + ')';
            }

            if (text) {
                lines.push([r.label, text]);
            }
        });

        if (s.SrOwnsSharpening) {
            lines.push(['Note', 'The upscaler sharpens internally, so the separate unblur pass was dropped.']);
        }

        if (s.GameDepthDowngraded) {
            // The server saw this one and said so. Its OTHER depth fallback - ONNX Runtime with no
            // CUDA execution provider - happens inside ffmpeg, is not reported back, and is
            // therefore not claimed here either way.
            lines.push(['Note', 'The depth weights are not installed on this server, so the game'
                + ' upscaler ran with a flat depth plane whatever was asked for.']);
        }

        return lines;
    }

    function fetchServerState() {
        if (!state.playSessionId) {
            return Promise.resolve(null);
        }

        try {
            var client = window.ApiClient;
            if (!client || typeof client.getUrl !== 'function') {
                return Promise.resolve(null);
            }

            return client.ajax({
                type: 'GET',
                url: client.getUrl('GpuUpscale/Session/' + encodeURIComponent(state.playSessionId)),
                dataType: 'json'
            }).then(function (s) {
                state.lastServerState = s;
                return s;
            }, function () { return null; });
        } catch (err) {
            return Promise.resolve(null);
        }
    }

    /* ------------------------------------------------------------------------- the flat panel */

    /*
     * ONE SURFACE. Quality first, then every axis, then what the server actually did - all of it
     * visible at once, over the video, with no nested sheets. The controls are chosen from the
     * DATA, not written per axis:
     *
     *   a control with a `grade` run   -> segmented chips over the graded rungs, plus a compact
     *                                     picker holding the specialist levels that are not rungs
     *   four options or fewer          -> segmented chips
     *   more than four                 -> a compact picker
     *
     * So a new level is a new entry in an options array, and a new axis is a new entry in CONTROLS
     * plus one line in LIVE_ROWS. Neither needs a line of rendering code.
     */
    var PANEL_ID = 'gpuUpscalePanel';
    var STYLE_ID = 'gpuUpscalePanelStyle';
    var CSS = [
        '#' + PANEL_ID + '{position:fixed;right:1.2em;bottom:5.5em;z-index:99999;width:24em;',
        'max-width:calc(100vw - 2.4em);max-height:72vh;overflow-y:auto;background:rgba(16,16,18,.94);',
        'color:#eee;border:1px solid rgba(255,255,255,.14);border-radius:.6em;padding:.7em .85em 1em;',
        'box-shadow:0 .6em 2em rgba(0,0,0,.6);font-size:.85em;line-height:1.35;', '-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);}',
        '#' + PANEL_ID + ' h3{margin:.9em 0 .3em;font-size:.95em;font-weight:600;letter-spacing:.04em;',
        'text-transform:uppercase;color:#9ad;opacity:.85;}',
        '.gpuup-head{display:flex;align-items:baseline;gap:.5em;cursor:move;touch-action:none;',
        '-webkit-user-select:none;user-select:none;}',
        '.gpuup-grip{flex:0 0 auto;background:none;border:0;color:inherit;font-size:1em;opacity:.55;',
        'cursor:move;padding:0 .15em;font-family:inherit;line-height:1;}',
        '.gpuup-grip:focus{outline:2px solid #00a4dc;opacity:1;}',
        '.gpuup-applying{flex:0 0 auto;color:#00a4dc;opacity:.95;}',
        '.gpuup-title{font-size:1.15em;font-weight:600;flex:0 0 auto;}',
        '.gpuup-sum{flex:1 1 auto;opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.gpuup-x{flex:0 0 auto;background:none;border:0;color:inherit;font-size:1.2em;cursor:pointer;opacity:.7;}',
        '.gpuup-row{margin:.35em 0;}',
        '.gpuup-label{opacity:.8;margin-bottom:.1em;}',
        '.gpuup-chips{display:flex;flex-wrap:wrap;align-items:center;gap:.25em;}',
        '.gpuup-chip{background:transparent;color:inherit;border:1px solid rgba(255,255,255,.22);',
        'border-radius:1em;padding:.12em .65em;cursor:pointer;font-size:.95em;font-family:inherit;}',
        '.gpuup-chip.on{background:#00a4dc;border-color:#00a4dc;color:#fff;}',
        '.gpuup-sel{background:rgba(255,255,255,.08);color:inherit;border:1px solid rgba(255,255,255,.22);',
        'border-radius:.3em;padding:.12em .3em;font-size:.95em;font-family:inherit;max-width:100%;}',
        '.gpuup-slider{width:100%;margin:.3em 0 .1em;}',
        '.gpuup-note{opacity:.6;font-size:.9em;margin-top:.1em;}',
        '.gpuup-live div{display:flex;gap:.5em;margin:.15em 0;}',
        '.gpuup-live b{flex:0 0 7.5em;font-weight:400;opacity:.65;}',
        '.gpuup-live span{flex:1 1 auto;}'
    ].join('');

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) { n.className = cls; }
        if (text != null) { n.textContent = text; }
        return n;
    }

    /* An option's measured cost, when its axis carries one, as plainly as it can be put. */
    function costSuffix(c, id) {
        var table = c.costKey ? COSTS[c.costKey] : null;
        var n = table ? table[id] : null;
        return (n && n > 1) ? '  [GPU ' + n + 'x]' : '';
    }

    function shortName(name) {
        // Chips carry the short form; the full name stays on the title attribute.
        return String(name).split(' (')[0];
    }

    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }

        var s = el('style');
        s.id = STYLE_ID;
        s.textContent = CSS;
        (document.head || document.documentElement).appendChild(s);
    }

    /* One axis row: chips, a picker, or both. onPick receives the chosen level id. */
    function controlRow(c, onPick) {
        var cur = state.prefs[c.key] || c.fallback;
        var ids = c.options.map(function (o) { return o.id; });
        var grade = (c.grade || []).filter(function (id) { return ids.indexOf(id) >= 0; });
        // Chips only where the data says the short form is safe to show, because a chip drops
        // everything after " (" - and on the neural and game axes that parenthesis is where the
        // honesty lives ("degraded: synthesised motion vectors", "0.24x realtime"). Those axes are
        // pickers, which show the server's wording whole.
        var chipIds = grade.length >= 2 ? grade : (c.chips && c.options.length <= 4 ? ids : []);
        var rest = c.options.filter(function (o) { return chipIds.indexOf(o.id) < 0; });

        var row = el('div', 'gpuup-row');
        row.appendChild(el('div', 'gpuup-label', c.label));
        var box = el('div', 'gpuup-chips');
        row.appendChild(box);

        chipIds.forEach(function (id) {
            var o = c.options.filter(function (x) { return x.id === id; })[0];
            var b = el('button', 'gpuup-chip' + (id === cur ? ' on' : ''), shortName(o.name));
            b.title = o.name;
            b.onclick = function () { onPick(id); };
            box.appendChild(b);
        });

        if (rest.length) {
            var sel = el('select', 'gpuup-sel');
            if (chipIds.length) {
                // A placeholder so the picker never looks like it owns a value the chips hold.
                var ph = el('option', null, rest.length === 1 ? 'more...' : 'more levels...');
                ph.value = '';
                sel.appendChild(ph);
            }

            rest.forEach(function (o) {
                var opt = el('option', null, o.name + costSuffix(c, o.id));
                opt.value = o.id;
                if (o.id === cur) { opt.selected = true; }
                sel.appendChild(opt);
            });
            sel.onchange = function () {
                if (sel.value) { onPick(sel.value); }
            };
            box.appendChild(sel);
        }

        var note = controlNote(c.key);
        if (note) {
            row.appendChild(el('div', 'gpuup-note', note));
        }

        return row;
    }

    /*
     * The quality stage, as a slider over the ladder that is already generated for this source.
     * The ladder itself is untouched: same stages, same order, same cost sort - only the way it is
     * presented changed, from a list of sheet rows to one control.
     */
    function qualitySection(rerender) {
        var wrap = el('div');
        wrap.appendChild(el('h3', null, 'Quality'));

        var modes = [
            { id: 'unset', name: 'Automatic', title: 'Send nothing: the server\'s own defaults decide.' },
            { id: 'off', name: 'Off', title: 'Play the file as it is. Direct play is left alone and no GPU is used.' },
            { id: 'manual', name: 'Manual', title: 'Choose a stage on the ladder, or set the axes below.' }
        ];
        var manual = state.stage !== 'unset' && state.stage !== 'off';
        var box = el('div', 'gpuup-chips');
        modes.forEach(function (m) {
            var on = m.id === 'manual' ? manual : state.stage === m.id;
            var b = el('button', 'gpuup-chip' + (on ? ' on' : ''), m.name);
            b.title = m.title;
            b.onclick = function () {
                if (m.id === 'manual') {
                    if (!manual) {
                        var rec = recommendedStage();
                        state.stage = rec ? { rank: rec.rank, sr: rec.sr, denoise: rec.denoise } : 'custom';
                    }
                } else {
                    state.stage = m.id;
                }

                savePrefs();
                requestRestream();
                rerender();
            };
            box.appendChild(b);
        });
        wrap.appendChild(box);

        if (!manual) {
            wrap.appendChild(el('div', 'gpuup-note', state.stage === 'off'
                ? 'The file plays as it is. The server is told this is Off, not silence, so its own defaults stay out of it.'
                : 'Nothing is sent. The server\'s dashboard defaults apply, exactly as for a player without this script.'));
            return wrap;
        }

        var l = ladder();
        if (l === null) {
            // Two different reasons, and they are not the same problem: say which one it is.
            wrap.appendChild(el('div', 'gpuup-note', serverConfig()
                ? 'Quality stages need the source size. Start playback, then open this again.'
                : 'The server has not reported its own limits yet, so the stages cannot be built'
                  + ' honestly. Open this again in a moment. The axes below still work.'));
            return wrap;
        }

        if (!l.length) {
            wrap.appendChild(el('div', 'gpuup-note',
                'This source is already above the server\'s upscale limit, so there is nothing to offer.'));
            return wrap;
        }

        var cur = currentStage();
        var rec = recommendedStage();
        var slider = el('input', 'gpuup-slider');
        slider.type = 'range';
        slider.min = 1;
        slider.max = l.length;
        slider.step = 1;
        slider.value = cur ? cur.n : (rec ? rec.n : 1);
        var caption = el('div', 'gpuup-note');

        function describe(n) {
            var st = l.filter(function (x) { return x.n === n; })[0];
            if (!st) {
                return '';
            }

            return st.n + ' of ' + l.length + '. ' + stageText(st)
                + '  (GPU ' + costHint(st.cost) + ')'
                + (sameStage(st, rec) ? '  recommended' : '');
        }

        caption.textContent = state.stage === 'custom'
            ? 'Custom: ' + advancedText() + '. Move the slider to go back to a stage.'
            : describe(parseInt(slider.value, 10));

        slider.oninput = function () {
            caption.textContent = describe(parseInt(slider.value, 10));
        };
        slider.onchange = function () {
            var st = l.filter(function (x) { return x.n === parseInt(slider.value, 10); })[0];
            if (!st) {
                return;
            }

            // Stored as a RECIPE, not as a number: stage 7 on this item is not stage 7 on the next
            // one, whose ladder may be a different length.
            state.stage = { rank: st.rank, sr: st.sr, denoise: st.denoise };
            savePrefs();
            log('quality stage', st.n);
            requestRestream();
            rerender();
        };

        wrap.appendChild(slider);
        wrap.appendChild(caption);
        return wrap;
    }

    function liveSection() {
        var wrap = el('div');
        wrap.appendChild(el('h3', null, 'What the server is doing'));
        var box = el('div', 'gpuup-live');
        liveLines().forEach(function (pair) {
            var d = el('div');
            d.appendChild(el('b', null, pair[0]));
            d.appendChild(el('span', null, pair[1]));
            box.appendChild(d);
        });
        wrap.appendChild(box);
        return wrap;
    }

    /* --------------------------------------------------------------- moving the panel */

    /*
     * The panel is moved by its header. Pointer events, so ONE code path covers mouse, touch and
     * pen. Three things it must not do, and each is why the code is the shape it is:
     *
     *   - It must not swallow a click on a header control. A drag is only entered once the pointer
     *     has travelled DRAG_SLOP pixels; below that nothing is captured and the button gets its
     *     click as usual. When a drag DID happen, the click that follows is eaten once in the
     *     capture phase, so letting go over the close button does not also close the panel.
     *   - It must not put the panel anywhere it cannot be reached. Every position - dragged,
     *     restored from localStorage, or left over after the window was resized - goes through
     *     clampPos() before it is used.
     *   - It must not be the only way to move it. A television has no pointer, so the grip is a
     *     real focusable button: arrow keys move the panel, Enter or Space puts it back, and
     *     double-clicking the header does the same. Nothing about the panel depends on dragging,
     *     so a remote is not locked out of anything - it simply leaves the panel where it is.
     *
     * All of it is inside try/catch: a broken drag must never escape into the player.
     */
    var DRAG_SLOP = 4;
    var KEY_STEP = 24;
    var EDGE = 4;

    function clampPos(x, y, w, h) {
        var maxX = Math.max(EDGE, (window.innerWidth || 0) - w - EDGE);
        var maxY = Math.max(EDGE, (window.innerHeight || 0) - h - EDGE);
        return {
            x: Math.min(Math.max(x, EDGE), maxX),
            y: Math.min(Math.max(y, EDGE), maxY)
        };
    }

    function applyPanelPos(panel) {
        try {
            panel = panel || panelEl();
            if (!panel) {
                return;
            }

            if (!state.panelPos) {
                // Back to the stylesheet's own corner: clear the inline overrides, do not guess
                // at what the CSS said.
                panel.style.left = '';
                panel.style.top = '';
                panel.style.right = '';
                panel.style.bottom = '';
                return;
            }

            var r = panel.getBoundingClientRect();
            var pos = clampPos(state.panelPos.x, state.panelPos.y, r.width, r.height);
            state.panelPos = pos;
            panel.style.left = pos.x + 'px';
            panel.style.top = pos.y + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        } catch (err) {
            log('could not place the panel', err);
        }
    }

    function movePanelBy(dx, dy) {
        try {
            var panel = panelEl();
            if (!panel) {
                return;
            }

            var r = panel.getBoundingClientRect();
            state.panelPos = { x: r.left + dx, y: r.top + dy };
            applyPanelPos(panel);
            savePrefs();
        } catch (err) {
            log('could not move the panel', err);
        }
    }

    function resetPanelPos() {
        try {
            state.panelPos = null;
            applyPanelPos();
            savePrefs();
            log('panel position reset');
        } catch (err) {
            log('could not reset the panel position', err);
        }
    }

    /* A pointerdown that landed on something clickable is that control's, not the drag's. */
    function isControl(node) {
        for (var n = node; n && n !== document; n = n.parentNode) {
            var t = n.tagName && String(n.tagName).toLowerCase();
            if (t === 'button' || t === 'select' || t === 'input' || t === 'textarea' || t === 'a') {
                return true;
            }
        }

        return false;
    }

    function makeDraggable(head) {
        try {
            head.addEventListener('dblclick', function (ev) {
                if (!isControl(ev.target)) {
                    resetPanelPos();
                }
            });

            if (!window.PointerEvent) {
                // No pointer events: the panel simply stays where it is, and the grip's keyboard
                // path still moves it. Nothing is broken, one way of moving it is absent.
                return;
            }

            head.addEventListener('pointerdown', function (ev) {
                try {
                    if (ev.button != null && ev.button !== 0) {
                        return;
                    }

                    if (isControl(ev.target)) {
                        return;
                    }

                    var panel = panelEl();
                    if (!panel) {
                        return;
                    }

                    var r = panel.getBoundingClientRect();
                    var d = {
                        id: ev.pointerId,
                        ox: ev.clientX - r.left,
                        oy: ev.clientY - r.top,
                        sx: ev.clientX,
                        sy: ev.clientY,
                        moved: false
                    };

                    var eatClick = function (e3) {
                        e3.stopPropagation();
                        e3.preventDefault();
                    };

                    function end() {
                        try {
                            document.removeEventListener('pointermove', onMove, true);
                            document.removeEventListener('pointerup', onUp, true);
                            document.removeEventListener('pointercancel', onUp, true);
                            try { head.releasePointerCapture(d.id); } catch (e) { /* ignore */ }
                            if (d.moved) {
                                savePrefs();
                                window.addEventListener('click', eatClick, true);
                                setTimeout(function () {
                                    window.removeEventListener('click', eatClick, true);
                                }, 0);
                            }
                        } catch (err) {
                            log('drag cleanup failed', err);
                        }

                        state.drag = null;
                    }

                    var onMove = function (e2) {
                        try {
                            if (!state.drag || e2.pointerId !== d.id) {
                                return;
                            }

                            if (!d.moved
                                && Math.abs(e2.clientX - d.sx) < DRAG_SLOP
                                && Math.abs(e2.clientY - d.sy) < DRAG_SLOP) {
                                return;
                            }

                            if (!d.moved) {
                                d.moved = true;
                                try { head.setPointerCapture(d.id); } catch (e) { /* not fatal */ }
                            }

                            if (e2.cancelable) { e2.preventDefault(); }
                            state.panelPos = { x: e2.clientX - d.ox, y: e2.clientY - d.oy };
                            applyPanelPos();
                        } catch (err) {
                            log('drag failed', err);
                            end();
                        }
                    };

                    var onUp = function (e4) {
                        if (e4.pointerId === d.id) {
                            end();
                        }
                    };

                    state.drag = d;
                    document.addEventListener('pointermove', onMove, true);
                    document.addEventListener('pointerup', onUp, true);
                    document.addEventListener('pointercancel', onUp, true);
                } catch (err) {
                    log('drag failed to start', err);
                    state.drag = null;
                }
            });
        } catch (err) {
            log('could not make the panel draggable', err);
        }
    }

    /* The grip: the pointerless way to do everything dragging does. */
    function gripButton() {
        var g = el('button', 'gpuup-grip', '\u283f');
        g.type = 'button';
        g.title = 'Drag to move. Arrow keys move it; Enter puts it back.';
        g.setAttribute('aria-label', 'Move panel. Arrow keys move it, Enter resets its position.');
        g.onkeydown = function (ev) {
            var step = ev.shiftKey ? KEY_STEP * 3 : KEY_STEP;
            var dx = 0;
            var dy = 0;
            if (ev.key === 'ArrowLeft') { dx = -step; } else if (ev.key === 'ArrowRight') { dx = step; } else if (ev.key === 'ArrowUp') { dy = -step; } else if (ev.key === 'ArrowDown') { dy = step; } else { return; }

            ev.preventDefault();
            ev.stopPropagation();
            movePanelBy(dx, dy);
        };
        g.onclick = function (ev) {
            ev.stopPropagation();
            resetPanelPos();
        };
        return g;
    }

    function renderPanel(panel, caps) {
        state.caps = caps;
        var body = el('div');

        var head = el('div', 'gpuup-head');
        head.appendChild(gripButton());
        head.appendChild(el('div', 'gpuup-title', 'Enhance'));
        head.appendChild(el('div', 'gpuup-sum', summaryText()));
        if (state.applying) {
            head.appendChild(el('div', 'gpuup-applying', state.applying));
        }

        var x = el('button', 'gpuup-x', '×');
        x.title = 'Close';
        x.onclick = closePanel;
        head.appendChild(x);
        body.appendChild(head);

        function rerender() {
            renderPanel(panel, caps);
        }

        body.appendChild(qualitySection(rerender));

        var controls = axisControls(caps);

        // Seed the controls from whatever is in force, so a panel opened on a stage shows that
        // stage's values rather than a stale set.
        var live = effective();
        if (live) {
            Object.keys(state.prefs).forEach(function (k) {
                if (live[k] != null) { state.prefs[k] = live[k]; }
                if (k === 'upscale' && live.upscale == null) { state.prefs.upscale = 'off'; }
            });
        }

        // A level that has gone away (an uninstalled shader, an old localStorage value, or a
        // target this source is too tall for) must not leave a control showing something the
        // server would refuse.
        controls.forEach(function (c) {
            var current = state.prefs[c.key];
            if (current && !c.options.some(function (o) { return o.id === current; })) {
                log('dropping unavailable preference', c.key, current);
                state.prefs[c.key] = c.fallback;
                savePrefs();
            }
        });

        // Grouped by intent, in the order the groups first appear in CONTROLS: another thing a new
        // axis gets for free by naming a group in its own data.
        var groups = [];
        controls.forEach(function (c) {
            if (groups.indexOf(c.group) < 0) { groups.push(c.group); }
        });

        groups.forEach(function (g) {
            body.appendChild(el('h3', null, g));
            controls.filter(function (c) { return c.group === g; }).forEach(function (c) {
                body.appendChild(controlRow(c, function (id) {
                    state.prefs[c.key] = String(id);
                    // A technical value now owns the settings, so the header says Custom instead of
                    // naming a stage these values no longer match.
                    state.stage = 'custom';
                    savePrefs();
                    log('axis', c.key, id);
                    requestRestream();
                    rerender();
                }));
            });
        });

        if (!caps.full) {
            body.appendChild(el('div', 'gpuup-note',
                'This server understands the upscale target only, so the other axes are not offered.'));
        }

        body.appendChild(liveSection());

        // The panel re-renders itself every few seconds to follow the session record. On a
        // television that would throw the focus away three times a minute, so the focused
        // control's position is carried across the swap.
        var focusIndex = -1;
        try {
            var before = panel.querySelectorAll('button,select,input');
            for (var fi = 0; fi < before.length; fi++) {
                if (before[fi] === document.activeElement) { focusIndex = fi; break; }
            }
        } catch (e) { /* ignore */ }

        panel.innerHTML = '';
        panel.appendChild(body);
        makeDraggable(head);
        applyPanelPos(panel);

        if (focusIndex >= 0) {
            try {
                var after = panel.querySelectorAll('button,select,input');
                if (after[focusIndex]) { after[focusIndex].focus(); }
            } catch (e) { /* ignore */ }
        }
    }

    function closePanel() {
        try {
            if (state.liveTimer) {
                clearInterval(state.liveTimer);
                state.liveTimer = null;
            }

            var p = document.getElementById(PANEL_ID);
            if (p && p.parentNode) {
                p.parentNode.removeChild(p);
            }

            if (state.panelKeyHandler) {
                document.removeEventListener('keydown', state.panelKeyHandler, true);
                state.panelKeyHandler = null;
            }

            if (state.onPanelResize) {
                window.removeEventListener('resize', state.onPanelResize);
                state.onPanelResize = null;
            }

            state.drag = null;
        } catch (err) {
            log('close failed', err);
        }
    }

    /*
     * THE PANEL IS A PLAYBACK CONTROL, so it closes when there is no playback left to control.
     *
     * Hooked, not polled. jellyfin-web's Events helper is a plain callback registry kept ON THE
     * OBJECT (events.js: obj._callbacks[type] = [] and Events.on pushes onto that array), so
     * subscribing to the playback manager's own events needs no module access at all - pushing
     * onto the same array is exactly what Events.on does, and the module is not exported anywhere
     * this script can reach.
     *
     * PAUSE IS DELIBERATELY NOT IN THE LIST. Pausing to go and change a setting is the whole
     * reason this panel exists; closing it under the viewer's hand would be hostile. Stop, end and
     * leaving the player all raise "playbackstop", which is the event this listens to.
     */
    function hookPlaybackEvents() {
        try {
            var pm = window.playbackManager;
            if (!pm || state.playbackHooked) {
                return;
            }

            pm._callbacks = pm._callbacks || {};
            ['playbackstop', 'playbackerror'].forEach(function (name) {
                pm._callbacks[name] = pm._callbacks[name] || [];
                pm._callbacks[name].push(function () {
                    try {
                        log('playback ended (' + name + '); closing the panel');
                        closePanel();
                    } catch (err) { /* never take playback down with the panel */ }
                });
            });

            state.playbackHooked = true;
        } catch (err) {
            log('could not hook the playback events', err);
        }
    }

    /*
     * A NEW ITEM RESETS THE UPSCALE TARGET, AND ONLY THAT.
     *
     * The quality ladder is generated FOR THE SOURCE: its targets are filtered against this
     * source's height and the server's own limits. 4K picked on a 540p file is not a choice that
     * means anything on the next item, and can be outside the set this panel would even offer for
     * it. The stage goes back to Automatic with it, because a stage IS a target plus a recipe.
     *
     * Everything else stays exactly as the viewer left it: sr, deblur, denoise, neural, game,
     * refine, chroma, deband, kernel, jitter, depth and reactive are taste, not properties of the
     * source, and none of them is filtered by the source height. Widening this to them would
     * throw away a preference for no reason.
     *
     * Done here, on the PlaybackInfo for a source this script has not seen, rather than on a
     * playback event: this runs BEFORE the parameters are written onto the TranscodingUrl, so the
     * new item is negotiated with the reset value instead of one item's worth of the old one.
     * (This reverses session 12, where a stage followed the viewer from item to item.)
     */
    function resetUpscaleForNewSource(info) {
        try {
            var sources = info && info.MediaSources;
            var id = sources && sources.length ? sources[0].Id : null;
            if (!id || id === state.lastSourceId) {
                return;
            }

            state.lastSourceId = id;
            if (state.stage === 'unset' && state.prefs.upscale === DEFAULT_PREFS.upscale) {
                return;
            }

            log('new item: the upscale target goes back to Automatic');
            state.stage = 'unset';
            state.prefs.upscale = DEFAULT_PREFS.upscale;
            savePrefs();
        } catch (err) {
            log('could not reset the upscale target', err);
        }
    }

    /*
     * Opening re-probes rather than trusting a cached answer, so a panel opened after a server
     * restart recovers the full control set instead of being stuck on the upscale target. The
     * session record is fetched alongside it, because it is the only honest source for what
     * actually ran, and it keeps being fetched while the panel is open so the live block follows
     * playback instead of freezing at the moment it was opened.
     */
    function openEnhancePanel() {
        state.menuShown++;
        hookPlaybackEvents();
        return probeServer().then(function (caps) {
            return fetchServerState().then(function () { return caps; },
                function () { return caps; });
        }).then(function (caps) {
            try {
                caps = caps || { full: false };
                closePanel();
                ensureStyle();
                var panel = el('div');
                panel.id = PANEL_ID;
                panel.setAttribute('role', 'dialog');
                panel.setAttribute('aria-label', 'Enhance');
                (document.body || document.documentElement).appendChild(panel);
                renderPanel(panel, caps);

                state.panelKeyHandler = function (ev) {
                    if (ev.key === 'Escape' || ev.keyCode === 27) {
                        closePanel();
                    }
                };
                document.addEventListener('keydown', state.panelKeyHandler, true);

                state.onPanelResize = function () { applyPanelPos(); };
                window.addEventListener('resize', state.onPanelResize);

                state.liveTimer = setInterval(function () {
                    try {
                        // Never re-render out from under a drag or an open dropdown.
                        if (state.drag) { return; }
                        var a = document.activeElement;
                        if (a && a.tagName === 'SELECT' && panel.contains(a)) { return; }
                        fetchServerState().then(function () {
                            var p = document.getElementById(PANEL_ID);
                            if (p) { renderPanel(p, caps); }
                        }, function () { /* keep the last answer */ });
                    } catch (e) { /* ignore */ }
                }, 3000);
                return null;
            } catch (err) {
                // The panel is never allowed to take playback or the stock menus with it.
                log('panel failed to open', err);
                closePanel();
                return null;
            }
        }, function () { return null; });
    }

    /*
     * Adds a row to the playback info dialog. Done by watching the DOM for the dialog rather than
     * hooking the module that builds it: the row is appended to whatever list the dialog already
     * renders, and if the shape is not recognised nothing is added and the dialog renders normally.
     */
    function watchPlaybackInfoDialog() {
        try {
            var observer = new MutationObserver(function (records) {
                records.forEach(function (record) {
                    Array.prototype.forEach.call(record.addedNodes || [], function (node) {
                        if (!node || node.nodeType !== 1 || !node.querySelectorAll) {
                            return;
                        }

                        var dialogs = node.matches && node.matches('.dialog, [is="emby-dialog"], .actionSheet')
                            ? [node] : Array.prototype.slice.call(node.querySelectorAll('.dialog, .actionSheet'));
                        dialogs.forEach(maybeAnnotate);
                    });
                });
            });
            observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
        } catch (err) {
            log('dialog observer failed', err);
        }
    }

    function maybeAnnotate(dialog) {
        try {
            if (!dialog || dialog.__gpuUpscaleAnnotated) {
                return;
            }

            var text = dialog.textContent || '';
            // The playback info dialog is the one listing the player and the play method.
            if (!/Playback Info|Play method|Player:/i.test(text)) {
                return;
            }

            dialog.__gpuUpscaleAnnotated = true;
            fetchServerState().then(function (s) {
                try {
                    if (!s) {
                        return;
                    }

                    var row = document.createElement('div');
                    row.className = 'gpuUpscaleStatsRow';
                    row.style.padding = '0.35em 0';
                    row.textContent = 'Enhance: ' + (s.Summary || 'No enhancement');
                    var host = dialog.querySelector('.dialogContent, .formDialogContent, .actionSheetContent') || dialog;
                    host.appendChild(row);
                    log('annotated playback info with', s.Summary);
                } catch (err) {
                    log('annotate failed', err);
                }
            });
        } catch (err) {
            log('annotate check failed', err);
        }
    }

    /* ---------------------------------------------------------------- webpack module wrapping */

    function wrapChunkModules(chunk) {
        try {
            if (!chunk || chunk.__gpuUpscaleSeen) {
                return;
            }

            chunk.__gpuUpscaleSeen = true;
            var modules = chunk[1];
            if (!modules) {
                return;
            }

            Object.keys(modules).forEach(function (id) {
                var factory = modules[id];
                if (typeof factory !== 'function') {
                    return;
                }

                state.modulesWrapped++;
                modules[id] = function (module, exports) {
                    var result = factory.apply(this, arguments);
                    try {
                        if (exports) {
                            wrapActionSheet(exports.Ay);
                            wrapActionSheet(exports.default);
                            wrapActionSheet(exports);
                        }
                    } catch (err) {
                        log('module wrap failed', err);
                    }

                    return result;
                };
            });
        } catch (err) {
            log('chunk wrap failed', err);
        }
    }

    /*
     * Webpack registers a chunk's modules and only then calls the previous push, so simply wrapping
     * push before webpack boots would be too late. The push property is defined with an accessor
     * instead, so webpack's own jsonp callback lands in `installed` while callers keep getting our
     * wrapper, which rewrites the chunk's modules before handing it on.
     *
     * This build's chunk-loading global is the bare "webpackChunk" (runtime.bundle.js:
     * self.webpackChunk=self.webpackChunk||[]); the jellyfin-web source name is kept as a fallback.
     */
    var GLOBALS = ['webpackChunk', 'webpackChunkjellyfin_web'];

    function hookChunkGlobal(key) {
        var chunks = window[key] = window[key] || [];
        if (chunks.__gpuUpscaleHooked) {
            return;
        }

        var nativePush = Array.prototype.push;
        var installed = null;
        var reentrant = false;

        var wrapper = function (chunk) {
            state.chunks++;
            wrapChunkModules(chunk);
            if (installed && !reentrant) {
                reentrant = true;
                try {
                    return installed.call(chunks, chunk);
                } finally {
                    reentrant = false;
                }
            }

            return nativePush.call(chunks, chunk);
        };

        Object.defineProperty(chunks, 'push', {
            configurable: true,
            get: function () { return wrapper; },
            set: function (value) { installed = value; }
        });

        chunks.__gpuUpscaleHooked = true;
        chunks.forEach(wrapChunkModules);
        state.globals.push(key);
    }

    function hookWebpack() {
        GLOBALS.forEach(function (key) {
            try {
                hookChunkGlobal(key);
            } catch (err) {
                log('webpack hook failed for ' + key, err);
            }
        });
    }

    /* ------------------------------------------------------- PlaybackInfo response rewriting */

    function addParams(url) {
        var e = effective();
        if (!url || !e) {
            return url;
        }

        var out = url;
        var params = {};
        // A null target means "no opinion on the size": the marker is left off entirely so the
        // server's own TargetHeight applies, exactly as it does for a client without this script.
        if (e.upscale != null) {
            params.upscale = e.upscale;
        }

        if (state.serverCaps && state.serverCaps.full) {
            params.deblur = e.deblur || 'off';
            params.denoise = e.denoise || 'off';
            params.sr = e.sr || 'off';
            if (state.prefs.deband && state.prefs.deband !== 'default') {
                params.deband = state.prefs.deband;
            }

            if (state.prefs.kernel && state.prefs.kernel !== 'default') {
                params.kernel = state.prefs.kernel;
            }

            // Refine and chroma ride alongside the ladder rather than inside it: they compose with
            // every stage, so they are sent from the preference regardless of which stage is in
            // force, exactly as Debanding and the scaling kernel already are. 'default' sends
            // nothing at all, so the dashboard's own value applies.
            if (state.prefs.refine && state.prefs.refine !== 'default') {
                params.refine = state.prefs.refine;
            }

            if (state.prefs.chroma && state.prefs.chroma !== 'default') {
                params.chroma = state.prefs.chroma;
            }

            // The neural and game axes ride alongside the ladder exactly as refine and chroma do:
            // they compose with every stage, so they are sent from the preference whichever stage
            // is in force - unless the viewer said Off, where `effective()` has already made them
            // off and this sends that. (Before this build the neural axis was never written onto
            // the URL at all, so choosing a level there did nothing.)
            params.neural = e.neural != null ? e.neural : (state.prefs.neural || 'off');
            params.game = e.game != null ? e.game : (state.prefs.game || 'off');

            // The three game-upscaler inputs, on the same rule that hides their rows: sent only
            // while the level in force is one the server says they act on, and only when the
            // viewer picked something other than "Server default". Otherwise nothing is written
            // and the dashboard value stands.
            GAME_OPTION_KEYS.forEach(function (k) {
                var acts = (state.serverCaps.levels && state.serverCaps.levels.GameOptionLevels) || [];
                if (acts.indexOf(params.game) >= 0 && state.prefs[k] && state.prefs[k] !== 'default') {
                    params[k] = state.prefs[k];
                }
            });
        }

        // Compatibility: the first server-side version of this plugin keyed off maxHeight. Sending
        // both means this script works against either server build; the newer one prefers
        // "upscale" and only falls back to maxHeight.
        if (params.upscale && params.upscale !== 'off' && /^\d+$/.test(params.upscale)) {
            params.maxHeight = params.upscale;
        }

        Object.keys(params).forEach(function (k) {
            var re = new RegExp('([?&])' + k + '=[^&]*');
            if (re.test(out)) {
                out = out.replace(re, '$1' + k + '=' + encodeURIComponent(params[k]));
            } else {
                out += (out.indexOf('?') === -1 ? '?' : '&') + k + '=' + encodeURIComponent(params[k]);
            }
        });

        return out;
    }

    /*
     * The source height, out of the media source the server just described. The client DOES know
     * this: PlaybackInfo carries MediaStreams with Height for every source, and this script already
     * reads that response. Knowing it is what lets the menu drop targets at or below the source
     * instead of offering a downscale as an improvement.
     */
    function noteSourceHeight(info) {
        try {
            var sources = info && info.MediaSources;
            if (!sources || !sources.length) {
                return;
            }

            for (var i = 0; i < sources.length; i++) {
                var streams = sources[i] && sources[i].MediaStreams;
                if (!streams) {
                    continue;
                }

                for (var j = 0; j < streams.length; j++) {
                    var st = streams[j];
                    if (st && st.Type === 'Video' && st.Height > 0) {
                        if (state.sourceHeight !== st.Height) {
                            log('source height', st.Height);
                        }

                        state.sourceHeight = st.Height;
                        return;
                    }
                }
            }
        } catch (err) {
            log('could not read the source height', err);
        }
    }

    function rewriteBody(bodyText) {
        var info = JSON.parse(bodyText);
        if (!info) {
            return null;
        }

        if (info.PlaySessionId) {
            state.playSessionId = info.PlaySessionId;
        }

        // Before any early return: the menu needs this even for a session it does not mark.
        noteSourceHeight(info);
        resetUpscaleForNewSource(info);

        var e = effective();
        if (!info.MediaSources || !e) {
            // No opinion from this viewer, so nothing is marked and the server's defaults stand.
            return null;
        }

        var enhancing = anyEnhancement();
        var touched = false;
        info.MediaSources.forEach(function (source) {
            if (!source.TranscodingUrl) {
                return;
            }

            source.TranscodingUrl = addParams(source.TranscodingUrl);
            if (enhancing) {
                // Make sure the client actually uses the transcode we just marked.
                source.SupportsDirectPlay = false;
                source.SupportsDirectStream = false;
            }
            // WHEN THE VIEWER SAID OFF, DIRECT PLAY IS LEFT EXACTLY AS JELLYFIN DECIDED IT.
            // The URL still carries upscale=off so that IF this session ends up transcoding for
            // some other reason, the server knows this is "off" and not "said nothing", and so
            // leaves its own defaults out of it. Nothing here pushes the session off direct play.

            touched = true;
        });

        if (!touched) {
            log(enhancing ? 'no TranscodingUrl to mark; playing without enhancement' : 'off: nothing to mark, direct play stands');
            return null;
        }

        state.marked.push([e.upscale, e.deblur, e.denoise, e.sr].join('/'));
        return JSON.stringify(info);
    }

    /*
     * THE DIRECT-PLAY PROBLEM.
     *
     * When the client can direct play a file, Jellyfin's PlaybackInfo response carries NO
     * TranscodingUrl at all - not an unused one, none. There is therefore nothing for this script
     * to mark, no ffmpeg command is ever built, and the server honestly reports "No enhancement"
     * however many options the viewer picked. Clearing SupportsDirectPlay on the RESPONSE does not
     * help either: without a TranscodingUrl the player has nothing to fall back to.
     *
     * So the marking has to happen on the REQUEST. Jellyfin's PlaybackInfo accepts
     * EnableDirectPlay / EnableDirectStream; setting both to false makes it return a real
     * TranscodingUrl, which the response rewrite below then marks as usual.
     *
     * This is only done when the viewer actually asked for enhancement - otherwise direct play is
     * left alone, because forcing a transcode nobody asked for would burn GPU for nothing.
     */
    var DIRECT_PLAY_OFF = { EnableDirectPlay: false, EnableDirectStream: false };

    function forceTranscodeUrl(url) {
        if (!url || !anyEnhancement()) {
            return url;
        }

        var out = url;
        // The GET form of the endpoint reads these from the query string.
        ['enableDirectPlay', 'enableDirectStream'].forEach(function (k) {
            var re = new RegExp('([?&])' + k + '=[^&]*', 'i');
            if (re.test(out)) {
                out = out.replace(re, '$1' + k + '=false');
            } else {
                out += (out.indexOf('?') === -1 ? '?' : '&') + k + '=false';
            }
        });
        return out;
    }

    function forceTranscodeBody(bodyText) {
        if (!anyEnhancement()) {
            return null;
        }

        try {
            if (typeof bodyText !== 'string' || !bodyText) {
                return null;
            }

            var body = JSON.parse(bodyText);
            if (!body || typeof body !== 'object') {
                return null;
            }

            if (body.EnableDirectPlay === false && body.EnableDirectStream === false) {
                return null;
            }

            body.EnableDirectPlay = false;
            body.EnableDirectStream = false;
            log('forcing a transcode for PlaybackInfo so there is something to enhance');
            return JSON.stringify(body);
        } catch (err) {
            log('could not rewrite PlaybackInfo request body', err);
            return null;
        }
    }

    function hookFetch() {
        if (!window.fetch) {
            return;
        }

        var originalFetch = window.fetch;
        window.fetch = function (input, init) {
            var url;
            try {
                url = typeof input === 'string' ? input : (input && input.url);
            } catch (e) {
                url = null;
            }

            var args = arguments;
            if (url && url.indexOf('/PlaybackInfo') !== -1 && anyEnhancement()) {
                try {
                    var newUrl = forceTranscodeUrl(url);
                    if (typeof input === 'string') {
                        var newInit = init || {};
                        var rewrittenBody = forceTranscodeBody(newInit.body);
                        if (rewrittenBody) {
                            newInit = Object.assign({}, newInit, { body: rewrittenBody });
                        }

                        args = [newUrl, newInit];
                        url = newUrl;
                    } else if (input && typeof Request !== 'undefined' && input instanceof Request) {
                        // A Request body can only be read asynchronously, so rebuild it from the
                        // clone and hand the whole call over to that promise.
                        var self = this;
                        return input.clone().text().then(function (text) {
                            var rb = forceTranscodeBody(text);
                            var req = new Request(newUrl, {
                                method: input.method,
                                headers: input.headers,
                                body: rb || (input.method === 'GET' || input.method === 'HEAD' ? undefined : text),
                                mode: input.mode,
                                credentials: input.credentials,
                                cache: input.cache,
                                redirect: input.redirect,
                                referrer: input.referrer
                            });
                            return handlePlaybackInfo(originalFetch.call(self, req));
                        }, function () {
                            return handlePlaybackInfo(originalFetch.apply(self, args));
                        });
                    }
                } catch (err) {
                    log('could not force a transcode on the PlaybackInfo request', err);
                }
            }

            var promise = originalFetch.apply(this, args);
            if (!url || url.indexOf('/PlaybackInfo') === -1) {
                return promise;
            }

            return handlePlaybackInfo(promise);
        };

        function handlePlaybackInfo(promise) {

            return promise.then(function (response) {
                try {
                    return response.clone().text().then(function (text) {
                        try {
                            var rewritten = rewriteBody(text);
                            if (!rewritten) {
                                return response;
                            }

                            return new Response(rewritten, {
                                status: response.status,
                                statusText: response.statusText,
                                headers: new Headers(response.headers)
                            });
                        } catch (err) {
                            log('rewrite failed', err);
                            return response;
                        }
                    }, function () { return response; });
                } catch (err) {
                    return response;
                }
            });
        };
    }

    function hookXhr() {
        if (!window.XMLHttpRequest) {
            return;
        }

        var proto = window.XMLHttpRequest.prototype;
        var originalOpen = proto.open;
        var originalSend = proto.send;

        proto.open = function (method, url) {
            try {
                this.__gpuUpscaleUrl = url;
                if (url && url.indexOf('/PlaybackInfo') !== -1 && anyEnhancement()) {
                    var forced = forceTranscodeUrl(url);
                    if (forced !== url) {
                        this.__gpuUpscaleUrl = forced;
                        var args = Array.prototype.slice.call(arguments);
                        args[1] = forced;
                        return originalOpen.apply(this, args);
                    }
                }
            } catch (e) { /* ignore */ }
            return originalOpen.apply(this, arguments);
        };

        proto.send = function (body) {
            var outgoing = body;

            try {
                var url = this.__gpuUpscaleUrl;
                if (url && url.indexOf('/PlaybackInfo') !== -1) {
                    // Request side: make sure a TranscodingUrl will exist to mark.
                    var rewrittenBody = forceTranscodeBody(body);
                    if (rewrittenBody) {
                        outgoing = rewrittenBody;
                    }

                    // Response side: mark the TranscodingUrl that now comes back.
                    var xhr = this;
                    Object.defineProperty(xhr, 'responseText', {
                        configurable: true,
                        get: function () {
                            var raw = Object.getOwnPropertyDescriptor(
                                window.XMLHttpRequest.prototype, 'responseText').get.call(xhr);
                            try {
                                return rewriteBody(raw) || raw;
                            } catch (err) {
                                return raw;
                            }
                        }
                    });
                }
            } catch (err) {
                log('xhr hook failed', err);
            }

            return originalSend.call(this, outgoing);
        };
    }

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
