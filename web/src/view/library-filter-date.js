import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';
import { parseTags } from '../model/library-filter-marks.js';
import { PRESETS, normalize, validDay, encode, decode, labelOf } from '../model/date-added.js';
import { readFilters, updateTagState } from '../controller/library-filters.js';
import { refreshQuickTags } from './quick-tags.js';

/*
 * DATE ADDED INSIDE THE LIBRARY FILTER MENU (the stock Filter popover; a side pane on desktop, a bottom sheet
 * on phones - view/library-filter-panel.js).
 *
 * One collapsible section: presets as toggle chips (a preset applies on tap, tapping the picked one clears
 * it) and a Custom From / To pair with Apply. The choice is the same `d` marker in the tab's Filters.Tags that
 * the date sheet writes (model/date-added.js, model/library-filter-marks.js), so Reset, the filter dot,
 * persistence and the request (jpMinDateAdded / jpMaxDateAdded) are the stock paths. The section header shows
 * the active range. Drawn just before the quick tag groups (view/library-filter-groups.js).
 */

var SEC_CLASS = 'jpFdSec';
var ACCENT = 'var(--jp-accent, var(--jf-palette-primary-main, #00a4dc))';

export var DATE_CSS = [
    '.' + SEC_CLASS + ' { border-top: 1px solid var(--jp-border, rgba(128,128,128,0.4)); }',
    '.jpFdHead { margin: 0.8em 0 0.3em; font-size: 0.8em; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.04em; }',
    '.jpFdPair { display: flex; gap: 0.6em; flex-wrap: wrap; }',
    '.jpFdPair label { flex: 1 1 8em; display: flex; flex-direction: column; gap: 0.25em; font-size: 0.9em; }',
    '.jpFdPair input { min-height: var(--jp-tap, 44px); box-sizing: border-box; padding: 0 0.6em; font: inherit;'
        + ' font-size: 16px; color: inherit; background: transparent; color-scheme: light dark;'
        + ' border: 1px solid var(--jp-border, rgba(128,128,128,0.55)); border-radius: 4px; }',
    '.jpFdHint { font-size: 0.85em; opacity: 0.7; min-height: 1.2em; margin: 0.35em 0; }',
    '.jpFdApply[disabled] { opacity: 0.45; cursor: default; }',
    '.jpFdApply:not([disabled]) { border-color: ' + ACCENT + '; }'
].join('\n');

var open = false;   // survives the popover closing, like the group sections' state

function currentState(ctx) {
    return decode(parseTags(readFilters(ctx).Tags).added);
}

function presetOn(cur, value) {
    return value === 'any' ? !cur : !!cur && cur.kind === 'preset' && cur.id === value;
}

function buildSection(getCtx, again) {
    var sec = el('details', 'jpFgSec ' + SEC_CLASS);
    var sum = el('summary');
    sum.appendChild(el('span', 'jpFgName', 'Date added'));
    sum.appendChild(el('span', 'jpFgCount'));
    sum.setAttribute('aria-expanded', 'false');
    sec.appendChild(sum);
    sec.addEventListener('toggle', function () {
        open = sec.open;
        sum.setAttribute('aria-expanded', sec.open ? 'true' : 'false');
    });

    var body = el('div', 'jpFgBody');
    var chips = el('div', 'jpFgChips');
    PRESETS.forEach(function (p) {
        var b = el('button', 'jpFgChip', p.label);
        b.type = 'button';
        b.setAttribute('data-preset', p.value);
        chips.appendChild(b);
    });
    body.appendChild(chips);

    body.appendChild(el('div', 'jpFdHead', 'Custom'));
    var pair = el('div', 'jpFdPair');
    var inputs = {};
    [['from', 'From'], ['to', 'To']].forEach(function (f) {
        var label = el('label', null, f[1]);
        var input = el('input');
        input.type = 'date';
        // The page binds keys for its own navigation; Escape still reaches MUI so the popover closes.
        input.addEventListener('keydown', function (e) { if (e.key !== 'Escape') { e.stopPropagation(); } });
        input.addEventListener('input', refresh);
        input.addEventListener('change', refresh);
        inputs[f[0]] = input;
        label.appendChild(input);
        pair.appendChild(label);
    });
    body.appendChild(pair);
    var hint = el('div', 'jpFdHint');
    body.appendChild(hint);
    var apply = el('button', 'jpFgChip jpFdApply', 'Apply');
    apply.type = 'button';
    body.appendChild(apply);
    sec.appendChild(body);

    function custom() {
        return normalize({ kind: 'custom', from: inputs.from.value, to: inputs.to.value });
    }

    function refresh() {
        var f = inputs.from.value;
        var t = inputs.to.value;
        apply.disabled = !custom() || (f !== '' && !validDay(f)) || (t !== '' && !validDay(t));
        hint.textContent = f && t && f > t ? 'From is after To: the two will be swapped.'
            : (f && !validDay(f)) || (t && !validDay(t)) ? 'That is not a valid date.' : '';
    }

    function write(state) {
        var ctx = getCtx();
        if (!ctx) {
            return;
        }

        updateTagState(ctx, function (p) { p.added = encode(state); });
        again(true);
        refreshQuickTags();
    }

    sec.addEventListener('click', function (e) {
        try {
            var t = e.target && e.target.closest ? e.target : null;
            var b = t && t.closest('[data-preset]');
            if (b) {
                e.stopPropagation();
                var v = b.getAttribute('data-preset');
                // Tapping the picked preset clears it, like a group chip.
                var on = b.getAttribute('aria-pressed') !== 'true';
                write(v === 'any' || !on ? null : { kind: 'preset', id: v });
                return;
            }

            if (t && t.closest('.jpFdApply') && !apply.disabled) {
                e.stopPropagation();
                var s = custom();
                if (s) {
                    write(s);
                }
            }
        } catch (err) {
            log('filter menu date click failed', err);
        }
    });

    sec.__jpInputs = inputs;
    sec.__jpRefresh = refresh;
    return sec;
}

function fillSection(sec, cur) {
    var label = cur ? labelOf(cur) : '';
    var count = sec.querySelector('.jpFgCount');
    // Only when it differs: identical text still counts as a DOM change to the popover's observer.
    if (count.textContent !== label) {
        count.textContent = label;
    }

    Array.prototype.forEach.call(sec.querySelectorAll('[data-preset]'), function (b) {
        var v = presetOn(cur, b.getAttribute('data-preset')) ? 'true' : 'false';
        if (b.getAttribute('aria-pressed') !== v) {
            b.setAttribute('aria-pressed', v);
        }
    });

    // The custom pair shows the stored custom range, never overwriting a field being typed in.
    var sig = cur && cur.kind === 'custom' ? cur.from + '~' + cur.to : '';
    if (sec.getAttribute('data-sig') !== sig) {
        sec.setAttribute('data-sig', sig);
        ['from', 'to'].forEach(function (k) {
            var input = sec.__jpInputs[k];
            var v = cur && cur.kind === 'custom' ? cur[k] : '';
            if (document.activeElement !== input && input.value !== v) {
                input.value = v;
            }
        });
        sec.__jpRefresh();
    }
}

/* Draws / updates the Date added section inside the popover `paper`, just before the quick tag groups. */
export function syncDateSection(paper, ctx, getCtx, again) {
    var sec = paper.querySelector(':scope > .' + SEC_CLASS);
    if (!sec) {
        sec = buildSection(getCtx, again);
        sec.setAttribute('data-sig', '-');
        if (open) {
            sec.open = true;
        }
    }

    var groups = paper.querySelector(':scope > .jpFg');
    if (groups) {
        if (sec.nextElementSibling !== groups) {
            paper.insertBefore(sec, groups);
        }
    } else if (paper.lastElementChild !== sec) {
        paper.appendChild(sec);
    }

    fillSection(sec, currentState(ctx));
}
