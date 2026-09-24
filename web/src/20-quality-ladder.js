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
    // vsr-rtcuda and dlpp-1..4 are PROVISIONAL, same caveat as GAME_COST below: not measured on
    // the same 960x540->1080p baseline as the realesr entries above, so the numbers are a ratio
    // argument, not a like-for-like reading. RTXDLPP.md reports 113 fps at 1080p->4K against a
    // 265 fps off baseline at the same target (RTXDLPP.md's own measurement, not the FPS table's
    // 960x540 one), i.e. roughly 2.3x - cheap next to the realesr entries because it runs CUDA-
    // native with no Vulkan/libplacebo stage, not because it does less work. All four dlpp levels
    // get the same weight: nothing here measures a per-level cost difference. vsr-rtcuda is a
    // resample, not a network, and costs less again.
    var NEURAL_COST = {
        off: 1, 'realesr-anime-x2': 11, 'realesr-anime-x4': 18, 'realesr-general-x4': 27,
        'vsr-rtcuda': 2, 'dlpp-1': 3, 'dlpp-2': 3, 'dlpp-3': 3, 'dlpp-4': 3
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
        prefs: {
            upscale: 'off', deblur: 'off', denoise: 'off', deblock: 'off', neural: 'off', game: 'off', sr: 'fsrcnnx',
            deband: 'default', kernel: 'default', refine: 'default', chroma: 'default',
            jitter: 'default', depth: 'default', reactive: 'default'
        }
    };
    window.__gpuUpscale = state;

