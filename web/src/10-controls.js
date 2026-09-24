    var CONTROLS = [
        {
            // `basic` is the tier: a numbered basic control is always visible, in that number's
            // order, and everything without one lives behind the Advanced disclosure. A number
            // rather than a flag because the three always-visible rows are not in CONTROLS order
            // and reordering the array would move the probe-driven groups with them.
            key: 'upscale', label: 'Upscale to', fallback: 'off', group: 'Size', chips: true, basic: 1,
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
            key: 'deblur', label: 'Unblur', atSource: 1, fallback: 'off', group: 'Sharpness',
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
            key: 'denoise', label: 'Denoise', atSource: 2, fallback: 'off', group: 'Noise', basic: 3,
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
            // COMPRESSION CLEANUP, and it runs BEFORE anything is enlarged: blocking and ringing
            // left by the encoder are damage in the source, so removing them first stops every
            // later pass from sharpening and enlarging the damage along with the picture. A
            // restoration pass rather than a picture control, which is why it lives in Advanced:
            // nobody reaches for it mid-film the way they reach for size or denoise.
            key: 'deblock', label: 'Clean up compression', atSource: 3, fallback: 'off', group: 'Noise',
            probeKey: 'Deblock', grade: ['off', 'light', 'strong'],
            options: [
                { id: 'off', name: 'Off' },
                { id: 'light', name: 'Light' },
                { id: 'strong', name: 'Strong' },
                // The two that also take ringing off edges, not only blocking. Both cost more GPU
                // than light and strong, so they are not rungs and each says so in its own name.
                { id: 'fspp', name: 'FSPP (also removes ringing - slower)' },
                { id: 'pp7', name: 'PP7 (also removes ringing - slowest)' }
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
            //
            // NVIDIA Maxine Video Super Resolution ('vsr') is RETIRED as of VSR.md's banner
            // (2026-09-23): the build flag is now WITH_MAXINE_VSR, gated behind
            // MAXINE_VSR_UNRETIRE=1, and ShaderLibrary.VsrOffered is hardcoded false. No ceiling
            // entry for it lives here any more - do not re-add one without first flipping the
            // server-side gate deliberately (NvVFX_Load hangs indefinitely rather than returning;
            // see VSR.md), and do not confuse it with the two CUDA-native levels below, which are
            // live and unrelated.
            // Two CUDA-native levels also live on this axis: 'vsr-rtcuda' (RTX VSR bypass
            // resampler - a fast GPU resample, explicitly NOT a neural network, see RTXVSR.md)
            // and 'dlpp-1'..'dlpp-4' (RTX DLPP, DEGRADED: content-dependent, not a ladder, see
            // RTXDLPP.md). Neither is hardcoded below: `fromProbe`/`labelsKey` means the server's
            // probe (`Neural`/`NeuralLabels`) supplies both which of them exist on this server
            // (gated on nvaivpx.dll/nvdlppx.dll being installed - see ShaderLibrary.RtxVsrOffered/
            // RtxDlppOffered) and their exact display wording, the same mechanism the `game`
            // control below already uses. Picking either turns off Detail/Refine/Chroma/Debanding
            // for that session - see `CudaNeuralBypass` in the session-record row wiring.
            //
            // WEB_PANEL_DESIGN.md section 1.3: renamed from 'Neural super-resolution' now that
            // vsr-rtcuda (a fast resample, not a network) shares this control with the trained
            // networks - a JUDGMENT CALL, not the user's: the design doc's own alternatives were
            // "GPU detail engine" and "Detail (RTX / neural)"; this picked the latter. Flag for
            // revisit if it reads wrong in practice. `familiesKey`/`familyLabelsKey`/`notesKey`
            // are the section 1.3(b)/2.3 probe keys (NeuralFamilies/NeuralFamilyLabels/
            // NeuralNotes): optional, server-supplied grouping and per-level caveats for this
            // picker. A server that does not send them yields today's flat list with no notes,
            // same degrade-safe rule as every other probe-driven field here.
            key: 'neural', label: 'Detail engine (RTX / neural)', fallback: 'off', group: 'Detail',
            probeKey: 'Neural', labelsKey: 'NeuralLabels', fromProbe: true, costKey: 'neural',
            familiesKey: 'NeuralFamilies', familyLabelsKey: 'NeuralFamilyLabels', notesKey: 'NeuralNotes',
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
            // `expert` names a cluster that reads as ONE axis to a viewer: the upscaler and the
            // three inputs it is fed. The cluster's own disclosure is opened by the control whose
            // `expertHead` says it leads, so the three inputs are one row until someone wants them.
            key: 'game', label: 'Game temporal upscaler', atSource: 5, fallback: 'off', group: 'Detail',
            expert: 'game', expertHead: true,
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
            expert: 'game',
            probeKey: 'GameJitter', labelsKey: 'GameJitterLabels', fromProbe: true,
            showWhen: { key: 'game', levelsKey: 'GameOptionLevels' },
            options: [{ id: 'default', name: 'Server default' }]
        },
        {
            key: 'depth', label: 'Game upscaler: depth source', fallback: 'default', group: 'Detail',
            expert: 'game',
            probeKey: 'GameDepth', labelsKey: 'GameDepthLabels', fromProbe: true,
            showWhen: { key: 'game', levelsKey: 'GameOptionLevels' },
            options: [{ id: 'default', name: 'Server default' }]
        },
        {
            key: 'reactive', label: 'Game upscaler: reactive mask', fallback: 'default', group: 'Detail',
            expert: 'game',
            probeKey: 'GameReactive', labelsKey: 'GameReactiveLabels', fromProbe: true,
            showWhen: { key: 'game', levelsKey: 'GameOptionLevels' },
            options: [{ id: 'default', name: 'Server default' }]
        },
        {
            // Two different networks, not one quality ladder. The name says which family and
            // which weight, so the viewer can tell them apart rather than trusting an opaque
            // "Light / Standard / Max" that hid a family swap.
            key: 'sr', label: 'Detail (super-resolution)', fallback: 'fsrcnnx', group: 'Detail',
            probeKey: 'Sr', basic: 2,
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
            key: 'chroma', label: 'Chroma upscaling', atSource: 4, fallback: 'default', group: 'Detail', chips: true,
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
            key: 'deband', label: 'Debanding', atSource: 6, fallback: 'default', group: 'Picture', chips: true,
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
        upscale: 'off', deblur: 'off', denoise: 'off', deblock: 'off', neural: 'off', game: 'off', sr: 'fsrcnnx',
        deband: 'default', kernel: 'default', refine: 'default', chroma: 'default',
        jitter: 'default', depth: 'default', reactive: 'default'
