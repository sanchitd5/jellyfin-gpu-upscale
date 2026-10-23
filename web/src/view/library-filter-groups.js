import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';
import { parseTags } from '../model/library-filter-marks.js';
import { chipsFor, isSelected, toggleSelection, selectedIn } from '../model/quick-tags.js';
import { menuChips, pickedLabel } from '../model/quick-tags-menu.js';
import { readFilters, updateTagState } from '../controller/library-filters.js';
import { groupsFor, namesNow, resolveNames, onGroupsChanged } from '../controller/quick-tags.js';
import { refreshQuickTags } from './quick-tags.js';

/*
 * QUICK TAG GROUPS INSIDE THE LIBRARY FILTER MENU (the stock Filter popover, a bottom sheet on phones).
 *
 * One collapsible section per group, in the order of the chip row above the grid: the viewer's own groups,
 * then the suggested ("auto") ones. The header carries the group name, "auto" for a suggestion and a count of
 * what is picked; the body has tag chips (aria-pressed), a search box for a long group and "Show more".
 * A prefix group's chips are labelled by what follows the prefix (model/quick-tags.js chipsFor).
 *
 * The picks are NOT stored here. A chip writes the same `jpTagAnyOf` marker in the tab's Filters.Tags that the
 * chip row writes (controller/library-filters.js updateTagState, model/library-filter-marks.js kind `a`), so
 * the two views are one state: Reset, the filter dot, persistence and infinite scroll are the stock ones, and
 * the request is the same OR-within-a-group, AND-across-groups `jpTagAnyOf`. After a tick the chip row is
 * nudged (refreshQuickTags); the menu itself re-reads the state on every sync.
 *
 * Fail soft: no groups, a missing categories route, an unproved tab context or groups that are still loading
 * add no section and touch nothing. Not drawn on the TV layout (the panel is not installed there).
 */

var ROOT_CLASS = 'jpFg';
var ACCENT = 'var(--jp-accent, var(--jf-palette-primary-main, #00a4dc))';

export var GROUP_CSS = [
    '.' + ROOT_CLASS + ' { border-top: 1px solid var(--jp-border, rgba(128,128,128,0.4)); }',
    '.jpFgSec { border-bottom: 1px solid var(--jp-border, rgba(128,128,128,0.25)); }',
    '.jpFgSec > summary { display: flex; align-items: center; gap: 0.5em; min-height: var(--jp-tap, 44px);'
        + ' padding: 0 1em 0 1.2em; cursor: pointer; }',
    '.jpFgSec > summary .jpFgName { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.jpFgAuto { font-size: 0.8em; opacity: 0.7; font-style: italic; margin-left: 0.4em; }',
    '.jpFgCount { min-width: 1.6em; padding: 0 0.5em; border-radius: 999px; text-align: center; font-size: 0.8em;'
        + ' background: ' + ACCENT + '; color: var(--jp-on-accent, var(--jf-palette-primary-contrastText, #fff)); }',
    '.jpFgCount:empty { display: none; }',
    '.jpFgBody { padding: 0.2em 1em 0.9em 1.2em; }',
    '.jpFgBody input[type=search] { width: 100%; box-sizing: border-box; min-height: var(--jp-tap, 44px); padding: 0 0.6em;'
        + ' margin-bottom: 0.5em; font: inherit; font-size: 16px; color: inherit; background: transparent;'
        + ' border: 1px solid var(--jp-border, rgba(128,128,128,0.6)); border-radius: 4px; }',
    '.jpFgChips { display: flex; flex-wrap: wrap; gap: 0.45em; }',
    '.jpFgChip { flex: none; max-width: 100%; min-height: var(--jp-tap, 44px); box-sizing: border-box; padding: 0 1em;'
        + ' border-radius: 999px; border: 1px solid var(--jp-border, rgba(128,128,128,0.55)); background: transparent;'
        + ' color: inherit; font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }',
    '.jpFgChip:focus-visible { outline: 2px solid ' + ACCENT + '; outline-offset: 1px; }',
    '.jpFgChip[aria-pressed=true] { background: ' + ACCENT + '; border-color: ' + ACCENT + ';'
        + ' color: var(--jp-on-accent, var(--jf-palette-primary-contrastText, #fff)); }',
    '.jpFgMore { border-style: dashed; opacity: 0.8; }',
    '.jpFgNone { font-size: 0.85em; opacity: 0.7; padding: 0.4em 0; }'
].join('\n');

var ui = {};        // group name -> { open, q, expanded }
var wired = false;
var resync = function () { };

function stateOf(name) {
    return ui[name] || (ui[name] = { open: false, q: '', expanded: false });
}

function pickedTags(ctx) {
    return parseTags(readFilters(ctx).Tags).any;
}

function buildSection(g) {
    var sec = el('details', 'jpFgSec');
    sec.setAttribute('data-group', g.name);
    var sum = el('summary');
    var name = el('span', 'jpFgName', g.name);
    if (g.auto) {
        name.appendChild(el('small', 'jpFgAuto', 'auto'));
    }

    sum.appendChild(name);
    sum.appendChild(el('span', 'jpFgCount'));
    sec.appendChild(sum);
    // aria-expanded on the summary: <details> exposes it natively, but not in every engine's tree.
    sum.setAttribute('aria-expanded', 'false');
    sec.addEventListener('toggle', function () {
        stateOf(g.name).open = sec.open;
        sum.setAttribute('aria-expanded', sec.open ? 'true' : 'false');
    });

    var body = el('div', 'jpFgBody');
    var input = el('input');
    input.type = 'search';
    input.placeholder = 'Search ' + g.name;
    input.autocomplete = 'off';
    input.hidden = true;
    input.setAttribute('aria-label', 'Search ' + g.name);
    // The page binds keys for its own navigation; typing here must not trigger them.
    input.addEventListener('keydown', function (e) { if (e.key !== 'Escape') { e.stopPropagation(); } });
    input.addEventListener('input', function () {
        stateOf(g.name).q = input.value;
        resync();
    });
    body.appendChild(input);
    body.appendChild(el('div', 'jpFgChips'));
    sec.appendChild(body);
    return sec;
}

function fillSection(sec, g, picks, open) {
    var st = stateOf(g.name);
    var mine = selectedIn(picks, g.name);
    var all = chipsFor(g, namesNow(g), mine);
    var r = menuChips(all, st.q, st.expanded, mine);
    var sig = all.length + '|' + st.q + '|' + st.expanded + '|' + r.shown.map(function (c) {
        return c.tag + (isSelected(picks, g.name, c.tag) ? '*' : '');
    }).join(',') + '|' + r.more;

    var count = sec.querySelector('.jpFgCount');
    // Only when it differs: identical text still counts as a DOM change to the popover's observer.
    if (count.textContent !== pickedLabel(mine.length)) {
        count.textContent = pickedLabel(mine.length);
    }
    var input = sec.querySelector('input[type=search]');
    if (input.hidden === r.searchable) {
        input.hidden = !r.searchable;
    }

    if (document.activeElement !== input && input.value !== st.q) {
        input.value = st.q;
    }

    if (open && !sec.open && st.open) {
        sec.open = true;
    }

    var line = sec.querySelector('.jpFgChips');
    if (line.getAttribute('data-sig') === sig) {
        return;
    }

    line.setAttribute('data-sig', sig);
    line.textContent = '';
    r.shown.forEach(function (c) {
        var b = el('button', 'jpFgChip', c.label);
        b.type = 'button';
        b.setAttribute('aria-pressed', isSelected(picks, g.name, c.tag) ? 'true' : 'false');
        b.setAttribute('data-group', g.name);
        b.setAttribute('data-tag', c.tag);
        line.appendChild(b);
    });
    if (!r.shown.length) {
        line.appendChild(el('div', 'jpFgNone', 'No match.'));
    }

    if (r.more > 0) {
        var more = el('button', 'jpFgChip jpFgMore', 'Show ' + r.more + ' more');
        more.type = 'button';
        more.setAttribute('data-more', g.name);
        line.appendChild(more);
    } else if (st.expanded && all.length > 20 && !st.q) {
        var less = el('button', 'jpFgChip jpFgMore', 'Show fewer');
        less.type = 'button';
        less.setAttribute('data-more', g.name);
        line.appendChild(less);
    }
}

function onClick(e) {
    try {
        var t = e.target && e.target.closest ? e.target : null;
        var more = t && t.closest('[data-more]');
        if (more) {
            var st = stateOf(more.getAttribute('data-more'));
            st.expanded = !st.expanded;
            e.stopPropagation();
            resync(true);
            return;
        }

        var b = t && t.closest('.jpFgChip[data-tag]');
        var ctx = b && e.currentTarget.__jpCtx ? e.currentTarget.__jpCtx() : null;
        if (!b || !ctx) {
            return;
        }

        e.stopPropagation();
        var group = b.getAttribute('data-group');
        var tag = b.getAttribute('data-tag');
        var on = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        updateTagState(ctx, function (p) { p.any = toggleSelection(p.any, group, tag, on); });
        resync(true);
        refreshQuickTags();
    } catch (err) {
        log('filter menu group click failed', err);
    }
}

/*
 * Draws / updates the sections inside the popover `paper` for tab `ctx`. `getCtx` re-finds the tab context
 * at click time (the popover's own nodes have no React fiber). `again(true)` re-runs after React re-renders.
 */
export function syncGroupSections(paper, ctx, getCtx, again) {
    resync = again;
    if (!wired) {
        wired = true;
        onGroupsChanged(function () { again(); });
    }

    var found = groupsFor(ctx.parentId);
    var groups = found.ready ? found.groups : [];
    groups.forEach(function (g) {
        if (!g.tags.length && !namesNow(g)) {
            resolveNames(g).then(function () { again(); });
        }
    });

    var host = paper.querySelector(':scope > .' + ROOT_CLASS);
    var picks = pickedTags(ctx);
    var usable = groups.filter(function (g) { return chipsFor(g, namesNow(g), selectedIn(picks, g.name)).length > 0; });
    if (!usable.length) {
        if (host) {
            host.remove();
        }

        return;
    }

    if (!host) {
        host = el('div', ROOT_CLASS);
        host.__jpCtx = getCtx;
        host.addEventListener('click', onClick);
        host.setAttribute('role', 'group');
        host.setAttribute('aria-label', 'Quick tag filters');
        log('quick tag groups added to the filter menu (' + ctx.viewType + ')');
    }

    if (paper.lastElementChild !== host) {
        paper.appendChild(host);
    }

    var byName = {};
    Array.prototype.forEach.call(host.children, function (s) { byName[s.getAttribute('data-group')] = s; });
    var keep = {};
    usable.forEach(function (g, i) {
        keep[g.name] = true;
        var sec = byName[g.name];
        if (!sec) {
            sec = buildSection(g);
        }

        if (host.children[i] !== sec) {
            host.insertBefore(sec, host.children[i] || null);
        }

        fillSection(sec, g, picks, true);
    });
    Object.keys(byName).forEach(function (n) {
        if (!keep[n]) {
            byName[n].remove();
        }
    });
}
