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

    /*
     * Deblock costs, ESTIMATED not measured, and the comment says so because this project does not
     * pretend a guess is a measurement. deblock is a cheap 8-pixel-grid pass; fspp and pp7 are
     * libpostproc, single-threaded on the CPU at source resolution, and they are the two that turn
     * a working chain into a slideshow. Replace with real numbers when somebody benchmarks them.
     */
    var DEBLOCK_COST = { off: 1, light: 1.15, strong: 1.3, fspp: 2.4, pp7: 2.2 };

    /*
     * What the CURRENT selection is likely to cost, as opposed to what a ladder stage costs. The
     * stages are costed and ordered; a Custom pick is not, so nothing stopped a viewer stacking
     * fspp, OptiX and DLSS into 0.22x realtime and watching it buffer with no explanation.
     */
    function selectionCost() {
        try {
            var p = shownPrefs();
            var base = stageCost(parseInt(p.upscale, 10) || state.sourceHeight || 1080,
                !isOff(p.sr), p.denoise, p.neural);
            return base * (DEBLOCK_COST[p.deblock] || 1) * (GAME_COST[p.game] || 1);
        } catch (err) {
            return 0;
        }
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
    function displayPrefs() {
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
    function shownPrefs() {
        return state.shown || state.prefs;
    }

    function anyEnhancement() {
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
