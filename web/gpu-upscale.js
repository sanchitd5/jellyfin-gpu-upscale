/*
 * GPU Upscale - jellyfin-web client hook.
 *
 * Adds one "Enhance" entry to the player's settings menu. It leads with PRESETS, because the
 * viewer's intent is "make this look better", not "choose a super-resolution network":
 *
 *     Quality     Automatic / Off / a graded ladder of up to ten stages / Custom
 *     Advanced    Upscale to, Unblur, Denoise, Detail (the four technical controls, unchanged)
 *     What the server did
 *
 * One home rather than four widgets, and the Quality menu goes back to meaning bitrate only.
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
            key: 'upscale', label: 'Upscale to', fallback: 'off',
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
            key: 'deblur', label: 'Unblur', fallback: 'off',
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
            // Both levels are nlmeans. hqdn3d was retired: it measured no recovery at all.
            key: 'denoise', label: 'Denoise', fallback: 'off',
            options: [
                { id: 'off', name: 'Off' },
                { id: 'light', name: 'Light' },
                { id: 'strong', name: 'Strong (slower)' }
            ]
        },
        {
            // Two different networks, not one quality ladder. The name says which family and
            // which weight, so the viewer can tell them apart rather than trusting an opaque
            // "Light / Standard / Max" that hid a family swap.
            key: 'sr', label: 'Detail (super-resolution)', fallback: 'fsrcnnx',
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
                { id: 'nvscaler', name: 'NVScaler (NVIDIA, sharpens itself)' }
            ]
        },
        {
            // Debanding rides on the libplacebo instance the chain is building anyway. "Server
            // default" sends nothing and lets the dashboard decide, which is what every client
            // without this script gets.
            key: 'deband', label: 'Debanding', fallback: 'default',
            options: [
                { id: 'default', name: 'Server default' },
                { id: 'on', name: 'On' },
                { id: 'off', name: 'Off' }
            ]
        },
        {
            // The libplacebo scaling kernel. The list comes from the server's own whitelist, since
            // an unknown kernel name does not soften the picture - it fails the whole job.
            key: 'kernel', label: 'Scaling kernel', fallback: 'default',
            options: [{ id: 'default', name: 'Server default' }]
        }
    ];

    // Names the previous build wrote into localStorage. Mapped on load so an existing viewer does
    // not come back to a control showing a level that is no longer in its own option list.
    var SR_ALIASES = { light: 'fsrcnnx', standard: 'fsrcnnx', max: 'fsrcnnx-max' };

    var DEFAULT_PREFS = {
        upscale: 'off', deblur: 'off', denoise: 'off', sr: 'fsrcnnx',
        deband: 'default', kernel: 'default'
    };

    /*
     * THE QUALITY LADDER, AND WHY IT IS BUILT RATHER THAN LISTED.
     *
     * Every choice below comes from what was measured on this deployment (HANDOVER-gpuupscale.md
     * sessions 4 and 5, and the session-6 run in /root/srresearch2/x6.out), not from taste. The
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
     *  - Denoise (nlmeans) is the largest single gain on noisy material but costs roughly 60% of
     *    throughput and returns nothing on clean sources, so it appears only in the upper rungs,
     *    where the cost hint says plainly what it costs.
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
    var DENOISE_COST = { off: 1, light: 2.5, strong: 3.1 };

    var state = {
        version: 10,
        installed: false,
        globals: [],
        chunks: 0,
        modulesWrapped: 0,
        sheetsSeen: 0,
        menuShown: 0,
        marked: [],
        playSessionId: null,
        lastServerState: null,
        // The height of the video stream the server reported for the item being played. Read out
        // of the PlaybackInfo response this script already intercepts, so the menu can drop targets
        // at or below the source instead of offering a downscale as if it were an improvement.
        sourceHeight: null,
        // 'unset' (no opinion - the server's own defaults stand), 'off' (an opinion: play it as
        // it is), 'custom' (the Advanced controls own it), or a stage recipe object.
        stage: 'unset',
        prefs: { upscale: 'off', deblur: 'off', denoise: 'off', sr: 'fsrcnnx', deband: 'default', kernel: 'default' }
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
                sr: state.prefs.sr,
                deband: state.prefs.deband,
                kernel: state.prefs.kernel
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
    function stageCost(height, sr, denoise) {
        var row = FPS[height] || FPS[1080];
        var fps = sr ? row.sr : row.off;
        return (FPS[1080].off / fps) * (DENOISE_COST[denoise] || 1);
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
            return { upscale: 'off', deblur: 'off', denoise: 'off', sr: 'off' };
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

    /* The label on the Enhance row and on the Quality row: always what is actually in force. */
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

                        var positionTo = options.positionTo;
                        var self = this;
                        return originalShow.apply(self, arguments).then(function (chosen) {
                            if (chosen !== 'gpuupscale-enhance') {
                                return chosen;
                            }

                            return openEnhanceMenu(originalShow.bind(self), positionTo).then(
                                function () { return Promise.reject(); },
                                function () { return Promise.reject(); });
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
     */
    /*
     * Only a SUCCESSFUL probe is cached. A failure is deliberately not remembered: the probe fails
     * while the server is restarting, and caching that for the life of the page left the Enhance
     * menu showing nothing but "Upscale to" until the viewer reloaded, with no way to tell why.
     * A failed probe is retried the next time the menu is opened.
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
                // buildEnhanceMenu narrows the option lists to them. A server too old to send
                // Levels leaves it null, and the menu falls back to the full lists, which is what
                // that generation could do anyway.
                state.serverCaps = { full: true, levels: (res && res.Levels) || null };
                log('server probe: full capabilities', state.serverCaps.levels);
                return state.serverCaps;
            }, function (err) {
                log('server probe failed; will retry on next menu open', err);
                return no;
            });
        } catch (err) {
            return Promise.resolve(no);
        }
    }

    function openEnhanceMenu(show, positionTo) {
        state.menuShown++;
        // Re-probe here rather than trusting a cached answer, so a menu opened after a server
        // restart recovers the full control set instead of being stuck on "Upscale to". The
        // session state is fetched alongside it, because it is the only honest source for whether
        // the chosen SR level actually ran - see the note in buildEnhanceMenu.
        return probeServer().then(function (caps) {
            return fetchServerState().then(function () {
                return buildEnhanceMenu(show, positionTo, caps || { full: false });
            }, function () {
                return buildEnhanceMenu(show, positionTo, caps || { full: false });
            });
        });
    }

    /*
     * The levels the server said it can deliver, for one control, or null when it did not say.
     * The key names are the server's: Sr, Deblur, Denoise.
     */
    function serverLevels(caps, key) {
        var map = { sr: 'Sr', deblur: 'Deblur', denoise: 'Denoise', kernel: 'Upscalers' };
        var list = caps && caps.levels && map[key] ? caps.levels[map[key]] : null;
        return (list && list.length) ? list : null;
    }

    /*
     * The server may decline to run the super-resolution network below a ratio threshold, because
     * below it the fixed-2x networks measured no better than plain scaling while still costing
     * GPU time. The client cannot work out that ratio for itself - it does not reliably know the
     * source height - so it does not guess and it does not grey the control out: a wrong grey-out
     * is worse than none. Instead the row is annotated from what the server REPORTED it did for
     * the session actually playing, which is the same honest-reporting channel the playback-info
     * row and "What the server did" already use.
     */
    function srNote() {
        var s = state.lastServerState;
        return (s && s.Known && s.SrBypassed) ? ' - not run at this ratio' : '';
    }

    /*
     * THE MENU. Presets first, technical controls behind Advanced.
     *
     * The viewer's intent is "make this look better", so the primary choice is a graded ladder
     * built for the source now playing, and the four technical controls - which are what the
     * ladder is made of - stay one level down for anyone who wants them. Choosing a technical
     * value switches the indicator to Custom rather than leaving a stage name standing beside
     * settings that no longer match it.
     */
    function buildEnhanceMenu(show, positionTo, caps) {
        var items = [{ name: 'Quality', id: 'gpuupscale-stage', asideText: summaryText() }];
        if (caps.full) {
            items.push({ name: 'Advanced', id: 'gpuupscale-advanced', asideText: advancedText() });
            items.push({ name: 'What the server did', id: 'gpuupscale-what' });
        } else {
            // An older server: only the upscale target is understood, so Advanced would offer
            // controls it cannot honour.
            items = [{ name: 'Upscale to', id: 'gpuupscale-advanced', asideText: advancedText() }];
        }

        return show({ items: items, positionTo: positionTo, __gpuUpscaleOwn: true }).then(function (chosen) {
            if (chosen === 'gpuupscale-what') {
                return describeServerState();
            }

            if (chosen === 'gpuupscale-advanced') {
                return openAdvanced(show, positionTo, caps);
            }

            if (chosen === 'gpuupscale-stage') {
                return openStages(show, positionTo);
            }

            return null;
        });
    }

    /*
     * The ladder. Every rung is a genuinely different filter chain for THIS source - a stage whose
     * super-resolution level the server would bypass at this ratio is never generated, and a target
     * the server would decline is never offered - so the ladder is shorter for a source that has
     * less room above it. Ten rungs need three eligible targets, which a 540p source has and a
     * 1080p source does not; showing six honest rungs beats padding to ten.
     */
    function openStages(show, positionTo) {
        var l = ladder();
        var rec = recommendedStage();
        var cur = currentStage();
        var items = [
            {
                id: 'unset',
                name: 'Automatic (server default)',
                selected: state.stage === 'unset'
            },
            {
                id: 'off',
                name: 'Off - play the file as it is, no GPU',
                selected: state.stage === 'off'
            }
        ];

        if (l === null) {
            // No probe answer or no source height yet: say so instead of inventing a ladder.
            items.push({ id: 'none', name: 'Quality stages need the source size - start playback first' });
        } else if (!l.length) {
            items.push({
                id: 'none',
                name: 'This source is already above the server\'s upscale limit - nothing to offer'
            });
        } else {
            l.forEach(function (st) {
                items.push({
                    id: 'stage:' + st.n,
                    name: st.n + '. ' + stageText(st)
                        + (sameStage(st, rec) ? ' - recommended' : '')
                        + '  (GPU ' + costHint(st.cost) + ')',
                    selected: typeof state.stage === 'object' && sameStage(st, cur) && sameStage(st, state.stage)
                });
            });
        }

        if (state.stage === 'custom') {
            items.push({ id: 'custom', name: 'Custom (see Advanced)', selected: true });
        }

        return show({ items: items, positionTo: positionTo, __gpuUpscaleOwn: true }).then(function (picked) {
            if (picked == null || picked === 'none' || picked === 'custom') {
                return null;
            }

            if (picked === 'unset' || picked === 'off') {
                state.stage = picked;
            } else {
                var n = parseInt(String(picked).split(':')[1], 10);
                var st = (l || []).filter(function (x) { return x.n === n; })[0];
                if (!st) {
                    return null;
                }

                // Stored as a recipe, not as a number: stage 7 on this item is not stage 7 on the
                // next one, whose ladder may be a different length.
                state.stage = { rank: st.rank, sr: st.sr, denoise: st.denoise };
            }

            savePrefs();
            log('quality stage', picked);
            requestRestream();
            return null;
        });
    }

    /* The four technical controls, narrowed to what this server and this source can really do. */
    function advancedControls(caps) {
        var targets = eligibleTargets();
        return (caps.full ? CONTROLS : CONTROLS.filter(function (c) { return c.key === 'upscale'; }))
            .map(function (c) {
                var allowed = serverLevels(caps, c.key);
                var options = allowed
                    ? c.options.filter(function (o) { return allowed.indexOf(o.id) >= 0; })
                    : c.options;
                // Never end up with an empty control: if the server and this script agree on
                // nothing, showing the built-in list is better than showing a dead row.
                if (!options.length) {
                    options = c.options;
                }

                if (c.key === 'kernel') {
                    var kernels = (caps.levels && caps.levels.Upscalers) || [];
                    options = [{ id: 'default', name: 'Server default' }].concat(
                        kernels.map(function (k) { return { id: k, name: k }; }));
                }

                if (c.key === 'upscale' && targets !== null) {
                    // ONLY TARGETS ABOVE THE SOURCE. A target at or below the source height is a
                    // downscale or a no-op, and one within MinScaleFactor of it is refused by the
                    // server outright, so neither belongs in the menu. Off always stays.
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

                return { key: c.key, label: c.label, fallback: c.fallback, options: options };
            });
    }

    function openAdvanced(show, positionTo, caps) {
        var controls = advancedControls(caps);

        // Seed the controls from whatever is in force, so opening Advanced on a stage shows that
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

        var items = controls.map(function (c) {
            var current = state.prefs[c.key] || c.fallback;
            var opt = c.options.filter(function (o) { return o.id === current; })[0];
            var aside = opt ? opt.name : current;
            if (c.key === 'sr' && current !== 'off') { aside += srNote(); }
            // Do not let anyone stack two sharpeners: NVScaler sharpens inside its own pass and
            // the server drops the separate one, so say that here rather than in a support thread.
            if (c.key === 'deblur' && state.prefs.sr === 'nvscaler') {
                aside = 'not used - NVScaler sharpens internally';
            }
            if (c.key === 'upscale' && eligibleTargets() && !eligibleTargets().length) {
                aside = 'not available for this source';
            }

            return { name: c.label, id: c.key, asideText: aside };
        });

        return show({ items: items, positionTo: positionTo, __gpuUpscaleOwn: true }).then(function (chosen) {
            var control = controls.filter(function (c) { return c.key === chosen; })[0];
            if (!control) {
                return null;
            }

            var current = state.prefs[control.key] || control.fallback;
            var opts = control.options.map(function (o) {
                return { id: o.id, name: o.name, selected: o.id === current };
            });
            return show({ items: opts, positionTo: positionTo, __gpuUpscaleOwn: true }).then(function (picked) {
                if (picked == null) {
                    return null;
                }

                state.prefs[control.key] = String(picked);
                // A technical value now owns the settings, so the indicator says Custom instead of
                // naming a stage these values no longer match.
                state.stage = 'custom';
                savePrefs();
                log('advanced', control.key, picked);
                // The choice applies to the next stream negotiation; nudge the player to re-fetch.
                requestRestream();
                return null;
            });
        });
    }

    /*
     * Making the choice take effect means getting a fresh PlaybackInfo. jellyfin-web re-requests it
     * when the max streaming bitrate changes, so the smallest honest nudge is to re-apply the value
     * it already has. If the hook is not reachable the viewer can simply restart playback, which is
     * also what the menu says.
     */
    function requestRestream() {
        try {
            var pm = window.playbackManager;
            if (pm && typeof pm.getMaxStreamingBitrate === 'function' && typeof pm.setMaxStreamingBitrate === 'function') {
                var current = pm.getMaxStreamingBitrate();
                pm.setMaxStreamingBitrate({ enableAutomaticBitrateDetection: false, maxBitrate: current });
                log('asked the player to renegotiate');
            }
        } catch (err) {
            log('could not nudge the player; playback restart needed', err);
        }
    }

    /* ------------------------------------------------- what the server actually did (honest) */

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

    function describeServerState() {
        return fetchServerState().then(function (s) {
            var text = s && s.Summary ? s.Summary : 'Not known for this session';
            try {
                if (window.Dashboard && window.Dashboard.alert) {
                    window.Dashboard.alert({ title: 'Enhance', message: text });
                } else {
                    window.alert(text);
                }
            } catch (e) { /* ignore */ }

            return null;
        });
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
