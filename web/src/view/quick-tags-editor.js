import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';
import { openSheet } from './sheet.js';
import {
    MAX_GROUPS, MAX_EDIT_TAGS, MAX_LEN, usableTag, chipsFor, moveGroup, validateDraft, parseGroups,
    mergeGroups, pinSuggestion, encodeAuto
} from '../model/quick-tags.js';
import {
    groupsNow, saveGroups, resolveNames, searchTags, loadSuggested, autoPrefs, saveAutoPrefs
} from '../controller/quick-tags.js';

/*
 * THE "QUICK FILTERS" EDITOR: the viewer's own tag-filter groups (see model/quick-tags.js). Opened from the
 * chip row above a library list, the search Sort & filter sheet and the More sheet; shown in the shared
 * sheet (view/sheet.js). It edits a draft; Save stores it (controller/quick-tags.js saveGroups, which
 * prefs-sync mirrors to the server), Cancel, Back and the backdrop discard it.
 *
 * Per group: a name, order (up / down), remove, and either specific tags or a tag prefix.
 *  - Tags are found with a search box answered by the server's tag window (jpTagQuery, 20 at a time): the
 *    full tag list is never downloaded.
 *  - A prefix shows a live preview: how many tags start with it and what their chip labels would be.
 * Renaming a group starts it afresh: filters picked under the old name are cleared.
 * Plain text everywhere (textContent), so a tag name can never inject markup.
 */

var STYLE_ID = 'jellyfinPlusQuickEditorStyle';
var ACCENT = 'var(--jp-accent, var(--jf-palette-primary-main, #00a4dc))';
var LINE = 'var(--jp-border, rgba(128, 128, 128, 0.45))';
var SEARCH_LIMIT = 20;
var PREVIEW_SHOWN = 12;

var CSS = [
    '.jpQe-group { border: 1px solid ' + LINE + '; border-radius: 12px; padding: 0.7em; margin: 0 0 0.8em; }',
    '.jpQe-head { display: flex; align-items: center; gap: 0.3em; }',
    '.jpQe-input { flex: 1; min-width: 0; min-height: var(--jp-tap, 44px); box-sizing: border-box; padding: 0 0.8em;'
        + ' font: inherit; font-size: 16px; color: inherit; background: transparent; border: 1px solid ' + LINE + '; border-radius: 8px; }',
    '.jpQe-icon { flex: none; min-width: var(--jp-tap, 44px); min-height: var(--jp-tap, 44px); padding: 0; border: 0;'
        + ' background: none; color: inherit; font: inherit; font-size: 1.1em; cursor: pointer; border-radius: 22px; }',
    '.jpQe-icon[disabled] { opacity: 0.3; cursor: default; }',
    '.jpQe-modes, .jpQe-chips { display: flex; flex-wrap: wrap; gap: 0.4em; margin: 0.6em 0 0; }',
    '.jpQe-pill { min-height: 40px; padding: 0 1em; box-sizing: border-box; border-radius: 20px; border: 1px solid ' + LINE + ';'
        + ' background: transparent; color: inherit; font: inherit; cursor: pointer; max-width: 100%;'
        + ' overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.jpQe-pill[aria-pressed=true] { background: ' + ACCENT + '; border-color: ' + ACCENT + ';'
        + ' color: var(--jp-on-accent, var(--jf-palette-primary-contrastText, #fff)); }',
    '.jpQe-pill:focus-visible, .jpQe-icon:focus-visible, .jpQe-input:focus-visible { outline: 2px solid ' + ACCENT + '; outline-offset: 1px; }',
    '.jpQe-body { margin: 0.6em 0 0; }',
    '.jpQe-body .jpQe-input { width: 100%; }',
    '.jpQe-note { margin: 0.4em 0 0; font-size: 0.8em; opacity: 0.7; min-height: 1.2em; }',
    '.jpQe-add { width: 100%; min-height: var(--jp-tap, 44px); border-radius: 22px; border: 1px dashed ' + LINE + ';'
        + ' background: transparent; color: inherit; font: inherit; cursor: pointer; }',
    '.jpQe-error { margin: 0.6em 0 0; color: var(--jp-danger, #e65a5a); font-size: 0.9em; min-height: 1.2em; }',
    '.jpQe-save, .jpQe-cancel { flex: 1; min-height: 46px; border-radius: 23px; font: inherit; font-weight: 600; cursor: pointer; }',
    '.jpQe-save { background: ' + ACCENT + '; color: var(--jp-on-accent, var(--jf-palette-primary-contrastText, #fff)); border: 1px solid ' + ACCENT + '; }',
    '.jpQe-cancel { background: transparent; color: inherit; border: 1px solid ' + LINE + '; }'
].join('\n');

function ensureStyle() {
    if (!document.getElementById(STYLE_ID)) {
        var s = el('style');
        s.id = STYLE_ID;
        s.textContent = CSS;
        (document.head || document.documentElement).appendChild(s);
    }
}

function btn(cls, text, label) {
    var b = el('button', cls, text);
    b.type = 'button';
    if (label) {
        b.setAttribute('aria-label', label);
    }

    return b;
}

function debounce(fn, ms) {
    var timer = null;
    return function () {
        clearTimeout(timer);
        timer = setTimeout(fn, ms);
    };
}

function stopKeys(input) {
    // The page binds keys for its own navigation; typing here must not trigger them.
    input.addEventListener('keydown', function (e) { e.stopPropagation(); });
}

/* Opens the editor. `opener` gets the focus back; `onClose(saved)` runs once the sheet is gone. */
export function openQuickTagsEditor(opener, onClose, parentId) {
    ensureStyle();
    var saved = false;
    // Suggested ("auto") groups from a registered source: the viewer can pin, hide or rename them. The
    // choices are edited here and stored on Save, like the groups.
    var prefs = autoPrefs();
    var prefsBefore = encodeAuto(prefs);
    var suggested = [];
    var sugHost = el('div');
    // Editing copies: `mode` is the UI choice (a group with neither tags nor prefix yet starts on tags).
    var draft = groupsNow().map(function (g) {
        return { name: g.name, tags: g.tags.slice(), prefix: g.prefix, mode: g.tags.length ? 'tags' : (g.prefix ? 'prefix' : 'tags') };
    });
    var content = el('div');
    var list = el('div');
    var addBtn = btn('jpQe-add', '+ Add a group');
    var error = el('div', 'jpQe-error');
    error.setAttribute('role', 'alert');
    content.appendChild(el('p', 'jpQe-note',
        'Chips in one group match any of them; different groups must all match. Nothing is shown for a group until you pick one of its chips.'));
    content.appendChild(list);
    content.appendChild(addBtn);
    content.appendChild(sugHost);
    content.appendChild(error);

    var save = btn('jpQe-save', 'Save');
    var cancel = btn('jpQe-cancel', 'Cancel');
    var handle = null;

    function groupView(g, i) {
        var box = el('section', 'jpQe-group');
        box.setAttribute('aria-label', g.name || 'New group');

        var head = el('div', 'jpQe-head');
        var name = el('input', 'jpQe-input');
        name.type = 'text';
        name.placeholder = 'Group name';
        name.maxLength = 100;
        name.value = g.name;
        name.setAttribute('aria-label', 'Group name');
        stopKeys(name);
        name.addEventListener('input', function () { g.name = name.value; error.textContent = ''; });
        head.appendChild(name);
        var up = btn('jpQe-icon', '↑', 'Move group up');
        up.disabled = i === 0;
        up.addEventListener('click', function () { draft = moveGroup(draft, i, -1); redraw(); });
        var down = btn('jpQe-icon', '↓', 'Move group down');
        down.disabled = i === draft.length - 1;
        down.addEventListener('click', function () { draft = moveGroup(draft, i, 1); redraw(); });
        var remove = btn('jpQe-icon', '✕', 'Remove group');
        remove.addEventListener('click', function () { draft.splice(i, 1); redraw(); });
        head.appendChild(up);
        head.appendChild(down);
        head.appendChild(remove);
        box.appendChild(head);

        var modes = el('div', 'jpQe-modes');
        var body = el('div', 'jpQe-body');
        [['tags', 'Pick tags'], ['prefix', 'Tag prefix']].forEach(function (m) {
            var b = btn('jpQe-pill', m[1]);
            b.setAttribute('aria-pressed', g.mode === m[0] ? 'true' : 'false');
            b.addEventListener('click', function () {
                g.mode = m[0];
                // One source per group: switching drops the other, so what is saved is what is shown.
                if (m[0] === 'tags') { g.prefix = ''; } else { g.tags = []; }
                redraw();
            });
            modes.appendChild(b);
        });
        box.appendChild(modes);
        box.appendChild(body);
        if (g.mode === 'tags') {
            tagsBody(g, body);
        } else {
            prefixBody(g, body);
        }

        return box;
    }

    function tagsBody(g, body) {
        var chips = el('div', 'jpQe-chips');
        var drawChips = function () {
            chips.textContent = '';
            g.tags.forEach(function (t) {
                var c = btn('jpQe-pill', t + '  ✕', 'Remove tag ' + t);
                c.addEventListener('click', function () {
                    g.tags = g.tags.filter(function (x) { return x !== t; });
                    drawChips();
                });
                chips.appendChild(c);
            });
        };
        drawChips();
        body.appendChild(chips);

        var input = el('input', 'jpQe-input');
        input.type = 'search';
        input.placeholder = 'Search tags to add';
        input.autocomplete = 'off';
        input.setAttribute('aria-label', 'Search tags to add');
        stopKeys(input);
        var note = el('div', 'jpQe-note');
        var results = el('div', 'jpQe-chips');
        body.appendChild(input);
        body.appendChild(note);
        body.appendChild(results);
        var seq = 0;
        var run = function () {
            var q = input.value.trim();
            var mine = ++seq;
            results.textContent = '';
            if (!q) {
                note.textContent = g.tags.length >= MAX_EDIT_TAGS ? 'This group is full (' + MAX_EDIT_TAGS + ' tags).' : 'Type part of a tag name.';
                return;
            }

            note.textContent = 'Searching...';
            searchTags(q, SEARCH_LIMIT).then(function (w) {
                if (mine !== seq) {
                    return;
                }

                var fresh = w.tags.filter(function (t) { return usableTag(t) && g.tags.indexOf(t) === -1; });
                note.textContent = !w.total ? 'No tags match.'
                    : (w.total > w.tags.length ? 'Showing ' + w.tags.length + ' of ' + w.total + ' - type more to narrow.' : '');
                fresh.forEach(function (t) {
                    var b = btn('jpQe-pill', '+ ' + t);
                    b.setAttribute('aria-label', 'Add tag ' + t);
                    b.addEventListener('click', function () {
                        if (g.tags.length >= MAX_EDIT_TAGS) {
                            note.textContent = 'This group is full (' + MAX_EDIT_TAGS + ' tags).';
                            return;
                        }

                        g.tags.push(t);
                        drawChips();
                        if (b.parentNode) { b.parentNode.removeChild(b); }
                    });
                    results.appendChild(b);
                });
            });
        };
        input.addEventListener('input', debounce(run, 200));
        run();
    }

    function prefixBody(g, body) {
        var input = el('input', 'jpQe-input');
        input.type = 'text';
        input.placeholder = 'Tag prefix';
        input.maxLength = MAX_LEN;
        input.value = g.prefix;
        input.autocomplete = 'off';
        input.setAttribute('aria-label', 'Tag prefix');
        stopKeys(input);
        var note = el('div', 'jpQe-note');
        note.setAttribute('aria-live', 'polite');
        var preview = el('div', 'jpQe-chips');
        body.appendChild(input);
        body.appendChild(note);
        body.appendChild(preview);
        var seq = 0;
        var run = function () {
            var p = input.value.trim();
            g.prefix = p;
            var mine = ++seq;
            preview.textContent = '';
            if (!p) {
                note.textContent = 'Every tag starting with the prefix becomes a chip, labelled with the rest of its name.';
                return;
            }

            note.textContent = 'Checking...';
            resolveNames({ tags: [], prefix: p }).then(function (names) {
                if (mine !== seq) {
                    return;
                }

                var chips = chipsFor({ name: g.name, tags: [], prefix: p }, names, []);
                note.textContent = chips.length
                    ? chips.length + (chips.length === 1 ? ' tag starts' : ' tags start') + ' with this prefix.'
                    : 'No tag starts with this prefix.';
                chips.slice(0, PREVIEW_SHOWN).forEach(function (c) {
                    var s = el('span', 'jpQe-pill', c.label);
                    preview.appendChild(s);
                });
                if (chips.length > PREVIEW_SHOWN) {
                    preview.appendChild(el('span', 'jpQe-note', '+ ' + (chips.length - PREVIEW_SHOWN) + ' more'));
                }
            });
        };
        input.addEventListener('input', debounce(run, 250));
        run();
    }

    /* The suggested groups, with this editing session's names and hidden choices applied. */
    function redrawSuggested() {
        sugHost.textContent = '';
        var all = mergeGroups(draft, suggested, prefs).all;
        if (!all.length) {
            return;
        }

        sugHost.appendChild(el('h3', 'jpQe-sugtitle', 'Suggested'));
        sugHost.appendChild(el('p', 'jpQe-note',
            'Made automatically for this library. Pin one to make it yours and edit it; hide one you do not want; or rename it.'));
        all.forEach(function (g) {
            var box = el('section', 'jpQe-group');
            box.setAttribute('aria-label', g.name + ', suggested');
            var head = el('div', 'jpQe-head');
            var name = el('input', 'jpQe-input');
            name.type = 'text';
            name.maxLength = 100;
            name.value = g.name;
            name.setAttribute('aria-label', 'Name of suggested group ' + g.original);
            stopKeys(name);
            name.addEventListener('change', function () {
                var v = name.value.trim();
                if (v && v !== g.original) { prefs.names[g.id] = v; } else { delete prefs.names[g.id]; }
                redrawSuggested();
            });
            head.appendChild(name);
            var pin = btn('jpQe-pill', 'Pin', 'Pin ' + g.name + ' as your own group');
            pin.disabled = draft.length >= MAX_GROUPS;
            pin.addEventListener('click', function () {
                var before = draft.length;
                var next = pinSuggestion(draft, { name: g.name, tags: g.tags, prefix: g.prefix });
                if (next.length === before) { return; }
                draft = next.map(function (x) {
                    return x.mode ? x : { name: x.name, tags: x.tags, prefix: x.prefix, mode: x.tags.length ? 'tags' : 'prefix' };
                });
                if (prefs.hidden.indexOf(g.id) === -1) { prefs.hidden.push(g.id); }
                delete prefs.names[g.id];
                redraw();
            });
            var hide = btn('jpQe-pill', g.hidden ? 'Show' : 'Hide', (g.hidden ? 'Show ' : 'Hide ') + g.name);
            hide.addEventListener('click', function () {
                prefs.hidden = g.hidden ? prefs.hidden.filter(function (x) { return x !== g.id; }) : prefs.hidden.concat([g.id]);
                redrawSuggested();
            });
            head.appendChild(pin);
            head.appendChild(hide);
            box.appendChild(head);
            if (g.hidden) { box.style.opacity = '0.6'; }
            sugHost.appendChild(box);
        });
    }

    function redraw() {
        list.textContent = '';
        draft.forEach(function (g, i) { list.appendChild(groupView(g, i)); });
        addBtn.hidden = draft.length >= MAX_GROUPS;
        error.textContent = '';
        redrawSuggested();
    }

    addBtn.addEventListener('click', function () {
        draft.push({ name: '', tags: [], prefix: '', mode: 'tags' });
        redraw();
        var inputs = list.querySelectorAll('.jpQe-head .jpQe-input');
        if (inputs.length) { inputs[inputs.length - 1].focus(); }
    });
    cancel.addEventListener('click', function () { if (handle) { handle.close(); } });
    save.addEventListener('click', function () {
        var clean = draft.map(function (g) {
            return { name: g.name.trim(), tags: g.mode === 'tags' ? g.tags : [], prefix: g.mode === 'prefix' ? g.prefix.trim() : '' };
        });
        var problem = validateDraft(clean);
        if (problem) {
            error.textContent = problem;
            return;
        }

        // A renamed suggestion may not take the name of one of the viewer's own groups.
        // (mergeGroups drops a clashing suggestion, so fewer shown than not-hidden means a clash.)
        var shown = mergeGroups(clean, suggested, prefs).all.filter(function (g) { return !g.hidden; });
        var wanted = suggested.filter(function (s) { return prefs.hidden.indexOf(s.id) === -1; });
        if (shown.length < wanted.length) {
            error.textContent = 'A suggested group has the same name as one of yours. Rename one of them.';
            return;
        }

        // parseGroups is the same gate every read passes, so what is stored is what will be shown.
        if (!saveGroups(parseGroups(clean)) || (encodeAuto(prefs) !== prefsBefore && !saveAutoPrefs(prefs))) {
            error.textContent = 'Could not save here (browser storage is unavailable).';
            return;
        }

        saved = true;
        handle.close();
    });

    redraw();
    loadSuggested(parentId).then(function (s) { suggested = s; redrawSuggested(); });
    handle = openSheet({
        title: 'Quick filters',
        content: content,
        footer: [cancel, save],
        opener: opener,
        tiers: ['phone', 'tablet'],
        onClose: function () {
            log('quick filters editor closed' + (saved ? ' (saved)' : ''));
            if (typeof onClose === 'function') { onClose(saved); }
        }
    });
    return handle;
}
