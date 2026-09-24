import { state } from '../model/state.js';
import { isOff } from '../lib/utils.js';
import { wireParams, paramSig } from './network.js';
import { activeState } from './live-apply.js';

/*
 * The live rows. One entry per axis, naming the fields of the session record it reads, so an
 * axis added to CONTROLS is reported here by adding one line of DATA, not by writing rendering
 * code. `applied` false against a level that is not "off" is the "requested but not applied"
 * case, and it is always shown.
 */
export var LIVE_ROWS = [
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

/*
 * The sizes, which are the only end-to-end proof that the size axis did anything. A kernel name
 * in this row read as a size claim without being one, and the kernel has its own row below.
 */
function sizeText(s) {
    if (!s.OutputWidth || !s.OutputHeight) {
        return null;
    }

    var to = s.OutputWidth + 'x' + s.OutputHeight;
    return s.SourceWidth && s.SourceHeight
        ? to + ' from ' + s.SourceWidth + 'x' + s.SourceHeight
        : to;
}

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
export function staleNote() {
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

/*
 * The lines of the live block, as [label, value] pairs. NEGATIVES ARE NEVER DROPPED: a level
 * that was asked for and did not run is reported in the same list as one that did, and a
 * session the server knows nothing about says exactly that rather than showing the viewer's
 * own request back to them.
 */
export function liveLines() {
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

export function fetchServerState() {
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
