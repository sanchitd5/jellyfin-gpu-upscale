import { state } from '../model/state.js';
import { CONTROLS } from '../model/controls-data.js';
import { eligibleTargets, srWouldRun } from '../model/costing.js';
import { shownPrefs } from '../model/effective.js';
import { log } from '../lib/log.js';
import { isOff } from '../lib/utils.js';

export function probeServer() {
    if (state.serverCaps && state.serverCaps.full) {
        return Promise.resolve(state.serverCaps);
    }

    // Not "target only": not answered. The panel words the two differently.
    var no = { full: false, failed: true };
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
            // generation could do anyway. This is the ONLY response that carries them: the
            // session poll does not, because they change on a config change or an install and
            // not three times a minute.
            state.serverCaps = { full: true, levels: (res && res.Levels) || null };
            log('server probe: full capabilities', state.serverCaps.levels);
            return state.serverCaps;
        }, function (err) {
            // A 404 is the server ANSWERING: this build has no probe endpoint, so it really is
            // the generation that understands the target alone. Anything else - no response, a
            // gateway error while Jellyfin restarts - is not an answer about capabilities.
            var status = (err && (err.status || (err.response && err.response.status))) || 0;
            log('server probe failed; will retry on next panel open', status, err);
            return status === 404 ? { full: false, targetOnly: true } : no;
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
export function axisControls(caps) {
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
            return acts.indexOf(shownPrefs()[c.showWhen.key]) >= 0;
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
                key: c.key, label: c.label, fallback: c.fallback, probeKey: c.probeKey || null,
                group: c.group || 'Detail',
                basic: c.basic || 0, expert: c.expert || null, expertHead: !!c.expertHead,
                grade: c.grade || null, chips: !!c.chips, costKey: c.costKey || null,
                showWhen: c.showWhen || null, options: options,
                levelGroups: c.levelGroups || null,
                // WEB_PANEL_DESIGN.md 1.3(b)/2.3: optional server-supplied grouping and
                // per-level notes for a picker. Null when the control declares no such key,
                // or when this server's probe did not send one - controlRow() renders the
                // plain flat list in either case, same as before this design pass.
                families: (c.familiesKey && caps.levels && caps.levels[c.familiesKey]) || null,
                familyLabels: (c.familyLabelsKey && caps.levels && caps.levels[c.familyLabelsKey]) || null,
                notes: (c.notesKey && caps.levels && caps.levels[c.notesKey]) || null
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
            return (s && s.Known && s.SrBypassed && shownPrefs().sr !== 'off')
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
            return (s && s.Known && s.GameApplied && isSrOff(s.SrLevel) && shownPrefs().sr !== 'off')
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

// Same predicate as utils.isOff, kept local to avoid a probe -> utils edge for one call site
// used only inside this file's CONTROL_NOTES table.
function isSrOff(v) {
    return v == null || v === '' || v === 'off' || v === false;
}

export function controlNote(key) {
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
