import { el } from '../lib/dom.js';
import { log } from '../lib/log.js';

/*
 * The small dialog behind "Add tags", "Remove tags" and "Edit tags" (controller/bulk-tags.js).
 *
 * Three states in one box: the form (a comma-separated box with tag suggestions), the run (a
 * progress bar and a Stop button) and the result (counts, and every skipped or failed item with its
 * reason). Built from plain DOM with its own CSS, so it depends on no jellyfin-web module. All text
 * goes in through textContent, never innerHTML: tag names are user data.
 *
 * opts: { mode: 'add'|'remove'|'edit', title, note, count, currentTags?, suggest: Promise<string[]>,
 *         run(add, remove, { onProgress, shouldStop }) -> Promise<summary> }
 */

var CSS = '' +
    '.gubtOverlay{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}' +
    '.gubtBox{background:#202020;color:#eee;border-radius:8px;padding:18px;width:100%;max-width:440px;max-height:90vh;overflow:auto;box-sizing:border-box;box-shadow:0 8px 32px rgba(0,0,0,.6);font-size:15px}' +
    '.gubtBox h2{margin:0 0 4px;font-size:1.25em;font-weight:500}' +
    '.gubtNote{opacity:.7;margin:0 0 12px;font-size:.9em;word-break:break-word}' +
    '.gubtInput{width:100%;box-sizing:border-box;padding:10px;font-size:16px;border:1px solid #555;border-radius:4px;background:#111;color:#fff}' +
    '.gubtInput:focus{outline:2px solid var(--theme-primary-color,#00a4dc);border-color:transparent}' +
    '.gubtLabel{display:block;margin:12px 0 6px;font-size:.85em;opacity:.7}' +
    '.gubtChips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 0;min-height:4px}' +
    '.gubtChip{border:1px solid #666;background:#2c2c2c;color:#eee;border-radius:14px;padding:5px 11px;font-size:.9em;cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.gubtChip:hover{border-color:var(--theme-primary-color,#00a4dc)}' +
    '.gubtChip.gubtOff{text-decoration:line-through;opacity:.5;border-style:dashed}' +
    '.gubtPreview{margin:12px 0 0;font-size:.9em;opacity:.85;word-break:break-word;min-height:1.2em}' +
    '.gubtButtons{display:flex;justify-content:flex-end;gap:10px;margin-top:16px}' +
    '.gubtBtn{border:0;border-radius:4px;padding:10px 18px;font-size:15px;cursor:pointer;background:#3a3a3a;color:#fff}' +
    '.gubtBtn.gubtPrimary{background:var(--theme-primary-color,#00a4dc);color:#fff}' +
    '.gubtBtn[disabled]{opacity:.4;cursor:default}' +
    '.gubtBox progress{width:100%;height:10px;margin:10px 0}' +
    '.gubtList{margin:8px 0 0;padding:0 0 0 18px;font-size:.88em;max-height:30vh;overflow:auto;word-break:break-word}' +
    '.gubtBad{color:#ff8a80}';

function injectStyle() {
    if (document.getElementById('gpuUpscaleBulkTagsCss')) { return; }
    var s = document.createElement('style');
    s.id = 'gpuUpscaleBulkTagsCss';
    s.textContent = CSS;
    document.head.appendChild(s);
}

function button(label, primary) {
    var b = el('button', 'gubtBtn' + (primary ? ' gubtPrimary' : ''), label);
    b.type = 'button';
    return b;
}

function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
}

export function showTagDialog(opts) {
    injectStyle();

    var overlay = el('div', 'gubtOverlay');
    var box = el('div', 'gubtBox');
    overlay.appendChild(box);
    box.appendChild(el('h2', '', opts.title));
    if (opts.note) { box.appendChild(el('p', 'gubtNote', opts.note)); }
    var body = el('div');
    box.appendChild(body);

    var running = false;
    var stopRequested = false;

    function close() {
        document.removeEventListener('keydown', onKey, true);
        if (overlay.parentNode) { overlay.parentNode.removeChild(overlay); }
    }

    function onKey(e) {
        if (e.key === 'Escape' && !running) {
            e.stopPropagation();
            close();
        }
    }

    overlay.addEventListener('mousedown', function (e) {
        if (e.target === overlay && !running) { close(); }
    });
    // Keep keystrokes from reaching the player's keyboard shortcuts behind the dialog.
    ['keydown', 'keyup', 'keypress'].forEach(function (t) {
        overlay.addEventListener(t, function (e) { e.stopPropagation(); });
    });
    document.addEventListener('keydown', onKey, true);

    // ---- form ----------------------------------------------------------------------------
    var input;
    var chips;
    var preview;
    var apply;
    var names = [];
    var marked = new Set(); // edit mode: current tags marked for removal

    function typedTokens() {
        return input.value.split(/[,\n]/).map(function (t) { return t.trim(); }).filter(Boolean);
    }

    function current() {
        var add = [];
        var remove = [];
        if (opts.mode === 'add') {
            add = typedTokens();
        } else if (opts.mode === 'remove') {
            remove = typedTokens();
        } else {
            add = typedTokens();
            remove = Array.from(marked);
        }
        return { add: add, remove: remove };
    }

    function refreshPreview() {
        var c = current();
        var parts = [];
        if (c.add.length) { parts.push('add ' + c.add.join(', ')); }
        if (c.remove.length) { parts.push('remove ' + c.remove.join(', ')); }
        preview.textContent = parts.length
            ? 'Will ' + parts.join(' and ') + (opts.count > 1 ? ' on ' + plural(opts.count, 'item', 'items') : '') + '.'
            : '';
        apply.disabled = !parts.length;
    }

    function refreshChips() {
        chips.textContent = '';
        var raw = input.value;
        var token = raw.slice(raw.lastIndexOf(',') + 1).trim().toLowerCase();
        var typed = new Set(typedTokens().map(function (t) { return t.toLowerCase(); }));
        var pool = names.filter(function (n) { return !typed.has(n.toLowerCase()); });
        var shown;

        if (token) {
            var starts = [];
            var inside = [];
            pool.forEach(function (n) {
                var l = n.toLowerCase();
                if (l.indexOf(token) === 0) { starts.push(n); } else if (l.indexOf(token) !== -1) { inside.push(n); }
            });
            shown = starts.concat(inside).slice(0, 8);
        } else {
            // With nothing typed, show a short list only (the selection's own tags for "remove").
            shown = pool.length <= 40 ? pool.slice(0, 12) : [];
        }

        shown.forEach(function (n) {
            var chip = el('button', 'gubtChip', n);
            chip.type = 'button';
            chip.addEventListener('click', function () {
                var cut = input.value.lastIndexOf(',');
                var head = cut === -1 ? '' : input.value.slice(0, cut).trim() + ', ';
                input.value = head + n + ', ';
                input.focus();
                refreshChips();
                refreshPreview();
            });
            chips.appendChild(chip);
        });
    }

    function buildForm() {
        body.textContent = '';

        if (opts.mode === 'edit') {
            body.appendChild(el('span', 'gubtLabel', 'Current tags (tap to remove)'));
            var cur = el('div', 'gubtChips');
            (opts.currentTags || []).forEach(function (t) {
                var chip = el('button', 'gubtChip', t);
                chip.type = 'button';
                chip.addEventListener('click', function () {
                    if (marked.has(t)) { marked.delete(t); chip.classList.remove('gubtOff'); } else { marked.add(t); chip.classList.add('gubtOff'); }
                    refreshPreview();
                });
                cur.appendChild(chip);
            });
            if (!(opts.currentTags || []).length) { cur.appendChild(el('span', 'gubtNote', 'No tags yet.')); }
            body.appendChild(cur);
        }

        body.appendChild(el('span', 'gubtLabel',
            opts.mode === 'remove' ? 'Tags to remove, separated by commas' : 'Tags to add, separated by commas'));
        input = el('input', 'gubtInput');
        input.type = 'text';
        input.placeholder = 'tag one, tag two';
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('autocapitalize', 'none');
        input.setAttribute('spellcheck', 'false');
        input.setAttribute('enterkeyhint', 'done');
        body.appendChild(input);

        chips = el('div', 'gubtChips');
        body.appendChild(chips);
        preview = el('p', 'gubtPreview');
        body.appendChild(preview);

        var row = el('div', 'gubtButtons');
        var cancel = button('Cancel');
        apply = button(opts.mode === 'add' ? 'Add' : opts.mode === 'remove' ? 'Remove' : 'Save', true);
        apply.disabled = true;
        row.appendChild(cancel);
        row.appendChild(apply);
        body.appendChild(row);

        cancel.addEventListener('click', close);
        apply.addEventListener('click', start);
        input.addEventListener('input', function () { refreshChips(); refreshPreview(); });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !apply.disabled) {
                e.preventDefault();
                start();
            }
        });

        refreshChips();
        refreshPreview();
        setTimeout(function () { input.focus(); }, 0);
    }

    // ---- run -----------------------------------------------------------------------------
    function start() {
        var c = current();
        if (!c.add.length && !c.remove.length) { return; }

        running = true;
        body.textContent = '';
        var status = el('p', 'gubtPreview', 'Starting…');
        var bar = document.createElement('progress');
        bar.max = Math.max(1, opts.count);
        bar.value = 0;
        var row = el('div', 'gubtButtons');
        var stop = button('Stop');
        row.appendChild(stop);
        body.appendChild(status);
        body.appendChild(bar);
        body.appendChild(row);

        stop.addEventListener('click', function () {
            stopRequested = true;
            stop.disabled = true;
            status.textContent = 'Stopping after the items already in progress…';
        });

        opts.run(c.add, c.remove, {
            shouldStop: function () { return stopRequested; },
            onProgress: function (done, total, s) {
                bar.max = Math.max(1, total);
                bar.value = done;
                if (!stopRequested) {
                    status.textContent = done + ' of ' + total + ' done' + (s.failed.length ? ' (' + s.failed.length + ' failed)' : '');
                }
            }
        }).then(showResult, function (err) {
            // runBulk never rejects; this is a belt for a broken caller.
            log('bulk tags: run failed', err);
            showResult({ total: opts.count, changed: 0, unchanged: 0, skipped: [], failed: [{ id: '', name: 'run', message: String((err && err.message) || err) }], notRun: opts.count });
        });
    }

    function itemList(entries, cls) {
        var ul = el('ul', 'gubtList' + (cls ? ' ' + cls : ''));
        entries.slice(0, 200).forEach(function (f) {
            ul.appendChild(el('li', '', (f.name || f.id) + ': ' + f.message));
        });
        if (entries.length > 200) { ul.appendChild(el('li', '', '…and ' + (entries.length - 200) + ' more')); }
        return ul;
    }

    function showResult(s) {
        running = false;
        body.textContent = '';
        var parts = [];
        if (s.changed) { parts.push(plural(s.changed, 'item', 'items') + ' updated'); }
        if (s.unchanged) { parts.push(s.unchanged + ' already as requested'); }
        if (s.skipped.length) { parts.push(s.skipped.length + ' skipped'); }
        if (s.failed.length) { parts.push(s.failed.length + ' failed'); }
        if (s.notRun) { parts.push(s.notRun + ' not processed (stopped)'); }
        body.appendChild(el('p', 'gubtPreview' + (s.failed.length ? ' gubtBad' : ''),
            (parts.join(', ') || 'Nothing to do') + ' of ' + s.total + '.'));
        if (s.failed.length) {
            body.appendChild(el('span', 'gubtLabel', 'Failed'));
            body.appendChild(itemList(s.failed, 'gubtBad'));
        }
        if (s.skipped.length) {
            body.appendChild(el('span', 'gubtLabel', 'Skipped'));
            body.appendChild(itemList(s.skipped));
        }
        var row = el('div', 'gubtButtons');
        var done = button('Close', true);
        row.appendChild(done);
        body.appendChild(row);
        done.addEventListener('click', close);
        done.focus();
    }

    document.body.appendChild(overlay);
    buildForm();

    Promise.resolve(opts.suggest).then(function (list) {
        names = Array.isArray(list) ? list : [];
        if (!running && chips) { refreshChips(); }
    }, function () { /* suggestions are optional */ });
}
