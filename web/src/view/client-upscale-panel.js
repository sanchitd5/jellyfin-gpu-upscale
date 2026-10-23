import { el } from '../lib/dom.js';
import { MODES, CLEANUP_LEVELS, SHARPNESS_LEVELS } from '../model/client-upscale.js';
import { clientPrefs, setClientPrefs, clientStatus } from '../controller/client-upscale.js';

/*
 * "ON THIS DEVICE": the Enhance panel's section for client-side upscaling. Visibly separate from
 * the server controls above it, because nothing here reaches the server: no request parameter,
 * no restream, and the settings are kept in this browser only. Changes apply at once.
 *
 * The wording is the client's own (WEB_PANEL_DESIGN.md section 5: client rules may name
 * themselves), and the status line is the same one the OSD badge shows.
 */

function chipRow(label, options, current, onPick) {
    var row = el('div', 'gpuup-row');
    row.appendChild(el('div', 'gpuup-label', label));
    var box = el('div', 'gpuup-chips');
    box.setAttribute('role', 'radiogroup');
    box.setAttribute('aria-label', label);
    options.forEach(function (o) {
        var b = el('button', 'gpuup-chip' + (o.id === current ? ' on' : ''), o.name);
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', o.id === current ? 'true' : 'false');
        b.onclick = function () { onPick(o.id); };
        box.appendChild(b);
    });
    row.appendChild(box);
    return row;
}

export function deviceSection(rerender) {
    var wrap = el('div', 'jp-device');
    // A rule above the heading: this is a different thing from everything before it.
    wrap.style.borderTop = '1px solid rgba(255,255,255,0.25)';
    wrap.style.marginTop = '0.8em';
    wrap.style.paddingTop = '0.4em';
    wrap.appendChild(el('h3', null, 'On this device'));
    wrap.appendChild(el('div', 'gpuup-note',
        'Upscales in this browser, on this device\'s GPU, when the stream is smaller than the'
        + ' screen. Not sent to the server; saved for this device only.'));

    var p = clientPrefs();
    var pick = function (key) {
        return function (id) {
            var change = {};
            change[key] = id;
            setClientPrefs(change);
            rerender();
        };
    };
    wrap.appendChild(chipRow('Upscale here', MODES, p.mode, pick('mode')));
    if (p.mode !== 'off') {
        wrap.appendChild(chipRow('Cleanup', CLEANUP_LEVELS, p.cleanup, pick('cleanup')));
        wrap.appendChild(chipRow('Sharpness', SHARPNESS_LEVELS, p.sharpness, pick('sharpness')));
    }

    var line = clientStatus().line;
    var st = el('div', 'gpuup-note', line || (p.mode === 'off' ? 'This device: off' : 'This device: not running'));
    st.setAttribute('aria-live', 'polite');
    wrap.appendChild(st);
    return wrap;
}
