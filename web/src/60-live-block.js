    var LIVE_ROWS = [
        { label: 'Upscaled', derive: sizeText, applied: 'UpscaleApplied' },
        { label: 'Detail (SR)', level: 'SrLevel', requested: 'SrRequested' },
        { label: 'Unblur', level: 'DeblurLevel', applied: 'DeblurApplied' },
        { label: 'Denoise', level: 'DenoiseLevel', applied: 'DenoiseApplied' },
        { label: 'Compression cleanup', level: 'DeblockLevel', applied: 'DeblockApplied', requested: 'DeblockRequested' },
        // 'Neural SR' renamed to 'Detail engine' to match the CONTROLS label rename in
        // WEB_PANEL_DESIGN.md section 1.3(a) - same axis, same fields, wording only.
        { label: 'Detail engine', level: 'NeuralLevel', applied: 'NeuralApplied', requested: 'NeuralRequested' },
        { label: 'Game upscaler', level: 'GameLevel', applied: 'GameApplied' },
        // What the server actually ran those three with - read from the record, never from what
        // this panel asked for. Null when no game upscaler ran, and a null row prints nothing.
        { label: 'Game jitter', level: 'GameJitter' },
        { label: 'Game depth', level: 'GameDepth' },
        { label: 'Game reactive mask', level: 'GameReactive' },
        { label: 'Refine', level: 'RefineLevel', applied: 'RefineApplied' },
        { label: 'Chroma', level: 'ChromaLevel', applied: 'ChromaApplied' },
        { label: 'Debanding', applied: 'DebandApplied' },
        // The only row reading Upscaler now that 'Upscaled' prints sizes, so a chosen kernel is
        // confirmed against what the server picked rather than sharing a field with a size claim.
        { label: 'Scaling kernel', level: 'Upscaler' },
        // WEB_PANEL_DESIGN.md section 3.5: two data-only rows, both already read straight off the
        // session record and both null (so silent) on an ordinary Vulkan session. 'Pipeline' is
        // the branch UpscaleEngine actually took ('CUDA (RTX)' or 'Vulkan') - the explanation for
        // five rows going inert at once when a CUDA-native neural level runs. Backend support for
        // these two fields is a server-side change outside this pass's scope (this brief is the
        // client restructuring); until a server sends them, both print nothing, same as any other
        // null row here.
        { label: 'Pipeline', level: 'Pipeline' },
        { label: 'Denoise dropped', level: 'DenoiseDroppedForPatchedBinary' },
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
    /*
     * A PANEL THAT LIES ABOUT WHAT RAN IS THE THING THIS PROJECT REFUSES TO DO.
     *
     * The record the server hands back describes ONE negotiation: the one that produced the stream
     * now playing. Change a control and, until the re-negotiation lands, the controls above show
     * one thing and the record below shows another - which reads as "I asked for RAVU-Zoom and the
     * server ran FSRCNNX" when what actually happened is "the server has not been asked yet".
     *
     * So the selections in force are compared against the ones the stream was negotiated with -
     * both built by wireParams(), so the comparison is of what is literally sent - and a
     * difference is stated, in the record's own block, before any line of the record.
     */
    function staleNote() {
        try {
            var now = paramSig(wireParams());
            if (!state.sentSig || !now || now === state.sentSig) {
                return null;
            }

            return ['Not this selection',
                'The record below is of the stream that is playing, which was negotiated with '
                + state.sentSig + '. The selections above have changed since and '
                + (state.applying
                    ? 'are being sent now.'
                    : 'have not been sent: they apply when playback next negotiates.')];
        } catch (err) {
            return null;
        }
    }

    function liveLines() {
        var s = state.lastServerState;
        // First line, in every state, including the ones that return early below: whether anything
        // is running. Playback Info renders these same lines, so the dialog answers it too.
        var act = activeState();
        if (!s) {
            return [['Enhancement', act.label], ['Status', state.playSessionId
                ? 'Waiting for the server to answer for this session.'
                : 'No stream yet. Start playback to see what the server does.']];
        }

        if (s.PatchActive === false) {
            return [['Status', 'Enhancement is unavailable: the server-side patches are not active.']];
        }

        if (!s.Known) {
            // The server writes a record only when it builds a filter chain. No record means no
            // chain: direct play, a stream copy, or a session it never saw.
            return [staleNote(), ['Status', s.Status || 'unknown'],
                ['What ran', (s.Summary || 'No enhancement')
                    + ' - no filter chain was built for this session, so this is a direct play, a'
                    + ' stream copy, or a stream the server has not started yet.']
            ].filter(Boolean);
        }

        var lines = [];
        var stale = staleNote();
        if (stale) {
            lines.push(stale);
        }

        lines.push(['What ran', s.Summary || 'No enhancement']);
        if (s.Status) {
            lines.push(['Status', s.Status]);
        }

        LIVE_ROWS.forEach(function (r) {
            var val = r.derive ? r.derive(s) : (r.level ? s[r.level] : null);
            if (!r.level && !r.derive && r.applied) {
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

        if (s.CudaNeuralBypass) {
            // A real, felt consequence of the RTX VSR/DLPP levels, not an internal detail: this
            // session's chain never reaches libplacebo, so Detail/Refine/Chroma/Debanding and the
            // scaling kernel could not run this time whatever the dashboard or panel asked for.
            // See INTEGRATION_DESIGN.md section 6.
            lines.push(['Note', 'This neural level runs its own CUDA-only chain, so Refine, Chroma,'
                + ' Debanding and the scaling kernel choice did not apply to this session.']);
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
     * ONE SURFACE. Quality first, then the three axes worth interrupting a film for, then one
     * Advanced disclosure holding the rest, then what the server actually did. No nested sheets,
     * and the record of what ran is never inside the disclosure. The controls are chosen from the
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
    // Everything the panel's tab order and its focus-across-a-repaint have to account for. A
    // <summary> is focusable and carries the disclosures, so leaving it out of this list would put
    // the Advanced section outside the trap and out of a remote's reach.
    var FOCUSABLE = 'button,select,input,summary';

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
        // The active badge. Colour is never the only carrier: the label says it in words, because a
        // coloured dot alone means nothing to a screen reader or to a colour-blind viewer.
        '.gpuup-active{display:flex;align-items:center;gap:.5em;margin:.35em 0 .1em;font-weight:600;}',
        '.gpuup-dot{width:.65em;height:.65em;border-radius:50%;background:currentColor;flex:0 0 auto;}',
        '.gpuup-active.is-active{color:#5ddc7a;}',
        '.gpuup-active.is-off{color:#e0a44a;}',
        '.gpuup-active.is-unavailable{color:#e46a6a;}',
        '.gpuup-active.is-waiting{color:#9aa0a6;}',
        // An axis another pick has made inert. Dimmed, not hidden, and its reason is printed under
        // it: greying alone leaves the viewer guessing which other control did this.
        '.gpuup-inert .gpuup-label,.gpuup-inert .gpuup-chips{opacity:.45;}',
        '.gpuup-inert .gpuup-chip,.gpuup-inert .gpuup-sel{cursor:not-allowed;}',
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
        '.gpuup-more{margin:.6em 0 .2em;border-top:1px solid rgba(255,255,255,.12);padding-top:.4em;}',
        '.gpuup-more>summary{cursor:pointer;list-style:none;padding:.15em 0;opacity:.85;',
        'font-size:.95em;letter-spacing:.03em;}',
        '.gpuup-more>summary::-webkit-details-marker{display:none;}',
        '.gpuup-more>summary:focus-visible{outline:2px solid #00a4dc;}',
        '.gpuup-more>summary::before{content:"\\25b8 ";opacity:.7;}',
        '.gpuup-more[open]>summary::before{content:"\\25be ";}',
        '.gpuup-changed{color:#00a4dc;opacity:.95;}',
        '.gpuup-sub{margin:.35em 0 .35em .2em;padding-left:.5em;',
        'border-left:1px solid rgba(255,255,255,.12);}',
        '.gpuup-live div{display:flex;gap:.5em;margin:.15em 0;}',
        '.gpuup-live b{flex:0 0 7.5em;font-weight:400;opacity:.65;}',
        '.gpuup-live span{flex:1 1 auto;}'
    ].join('');

