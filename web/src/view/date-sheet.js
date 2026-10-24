import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';
import { openSheet } from './sheet.js';
import { PRESETS, normalize, validDay } from '../model/date-added.js';

/*
 * THE DATE-ADDED SHEET for a library tab (opened by the active-range chip, view/quick-tags.js).
 *
 * Presets apply on tap and close the sheet. The Custom section holds two native date inputs and an
 * Apply button; a custom range is stored as fixed days, a preset as its name (so it keeps rolling,
 * model/date-added.js). `onPick(state)` receives a normalised state or null for "Any time"; the caller
 * writes it into the tab's Filters.Tags. Styled with --jp-* tokens, each with a stock fallback.
 */

var STYLE_ID = 'jellyfinPlusDateSheetStyle';
var ACCENT = 'var(--jp-accent, var(--jf-palette-primary-main, #00a4dc))';
var CSS = [
    '.jpDsList { display: flex; flex-direction: column; gap: 0.1em; }',
    '.jpDsOpt { display: flex; align-items: center; justify-content: space-between; min-height: var(--jp-tap, 44px);'
        + ' box-sizing: border-box; padding: 0 0.6em; border: 0; border-radius: var(--jp-radius-m, 8px); background: transparent;'
        + ' color: inherit; font: inherit; text-align: left; cursor: pointer; -webkit-tap-highlight-color: transparent; }',
    '.jpDsOpt:focus-visible { outline: 2px solid ' + ACCENT + '; outline-offset: -2px; }',
    '.jpDsOpt[aria-pressed=true] { font-weight: 600; color: ' + ACCENT + '; }',
    '.jpDsOpt[aria-pressed=true]::after { content: "\\2713"; }',
    '.jpDsHead { margin: 0.9em 0 0.3em; font-size: 0.85em; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.04em; }',
    '.jpDsPair { display: flex; gap: 0.8em; flex-wrap: wrap; }',
    '.jpDsPair label { flex: 1 1 9em; display: flex; flex-direction: column; gap: 0.3em; font-size: 0.9em; }',
    '.jpDsPair input { min-height: var(--jp-tap, 44px); box-sizing: border-box; padding: 0 0.6em; font: inherit;'
        + ' color: inherit; background: transparent; color-scheme: light dark;'
        + ' border: 1px solid var(--jp-border, rgba(128, 128, 128, 0.55)); border-radius: var(--jp-radius-m, 8px); }',
    '.jpDsHint { margin-top: 0.5em; font-size: 0.85em; opacity: 0.7; min-height: 1.2em; }',
    '.jpDsApply { flex: 1; min-height: 46px; border: 0; border-radius: 23px; font: inherit; font-weight: 600; cursor: pointer;'
        + ' background: ' + ACCENT + '; color: var(--jp-on-accent, var(--jf-palette-primary-contrastText, #fff)); }',
    '.jpDsApply:disabled { opacity: 0.45; cursor: default; }'
].join('\n');

function ensureStyle() {
    if (!document.getElementById(STYLE_ID)) {
        var style = el('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);
    }
}

/* `current` is the stored state (or null); `onPick(state|null)`; `opener` gets the focus back. */
export function openDateSheet(current, onPick, opener) {
    try {
        ensureStyle();
        var cur = normalize(current);
        var sheet = null;
        var pick = function (state) {
            sheet.close();
            try { onPick(state); } catch (e) { log('date sheet pick failed', e); }
        };

        var root = el('div');
        var list = el('div', 'jpDsList');
        PRESETS.forEach(function (p) {
            var b = el('button', 'jpDsOpt', p.label);
            b.type = 'button';
            var on = p.value === 'any' ? !cur : !!cur && cur.kind === 'preset' && cur.id === p.value;
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
            b.addEventListener('click', function () {
                pick(p.value === 'any' ? null : { kind: 'preset', id: p.value });
            });
            list.appendChild(b);
        });
        root.appendChild(list);

        root.appendChild(el('div', 'jpDsHead', 'Custom'));
        var pair = el('div', 'jpDsPair');
        var inputs = {};
        [['from', 'From'], ['to', 'To']].forEach(function (f) {
            var label = el('label', null, f[1]);
            var input = el('input');
            input.type = 'date';
            input.value = cur && cur.kind === 'custom' ? cur[f[0]] : '';
            input.addEventListener('keydown', function (e) { e.stopPropagation(); });
            input.addEventListener('input', refresh);
            input.addEventListener('change', refresh);
            inputs[f[0]] = input;
            label.appendChild(input);
            pair.appendChild(label);
        });
        root.appendChild(pair);
        var hint = el('div', 'jpDsHint');
        root.appendChild(hint);

        var apply = el('button', 'jpDsApply', 'Apply');
        apply.type = 'button';
        function state() {
            return normalize({ kind: 'custom', from: inputs.from.value, to: inputs.to.value });
        }

        function refresh() {
            var f = inputs.from.value;
            var t = inputs.to.value;
            apply.disabled = !state() || (f !== '' && !validDay(f)) || (t !== '' && !validDay(t));
            hint.textContent = f && t && f > t ? 'From is after To: the two will be swapped.'
                : (f && !validDay(f)) || (t && !validDay(t)) ? 'That is not a valid date.' : '';
        }

        apply.addEventListener('click', function () {
            var s = state();
            if (s) {
                pick(s);
            }
        });
        refresh();

        sheet = openSheet({
            title: 'Date added',
            content: root,
            footer: apply,
            opener: opener
        });
    } catch (e) {
        log('date sheet failed', e);
    }
}
