import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';
import { parseTags } from '../model/library-filter-marks.js';
import {
    normalize,
    listKey,
    listState,
    setSearch,
    applyWindow,
    ensureWindowed,
    findFilterContext,
    readFilters,
    updateFilters,
    updateTagState,
    nameOf,
    searchEntities
} from '../controller/library-filters.js';

/*
 * ADDITIONS TO THE MODERN LIBRARY PAGE'S FILTER POPOVER (jellyfin-web 12.1,
 * apps/modern/features/libraries/components/filter/FilterButton.tsx - a MUI Popover, #filter-popover).
 *
 * Tags accordion (#filtersTags-content, mounted only while expanded):
 *   - a search box above the list (the list itself is windowed - see controller/library-filters.js);
 *   - an "exclude" button on every tag row, and the excluded tags as removable chips;
 *   - a "match ALL selected tags" switch (stock is "any").
 * Below the stock accordions, on tabs where the stock popover hides them (Videos, Folders, Mixed,
 * Music videos): Resolution, Studios and People, which the server's /Items query already handles
 * for any item type.
 *
 * All state goes through the tab's own settings setter (controller findFilterContext /
 * updateFilters / updateTagState), so React, the persisted copy and the request all agree and the
 * stock "reset filters" button clears everything added here. This file only draws and wires DOM.
 * Found by shape (ids MUI derives from the stock aria-controls, props on the React tree), never
 * through a global; everything is in try/catch so the web client cannot break.
 */

var STYLE_ID = 'gpuUpscaleLibFilterStyle';
var POPOVER_ID = 'filter-popover';
var TAGS_REGION_ID = 'filtersTags-content';

// Tabs that list through their own endpoint (/Artists, /Persons, /Studios): the /Items-only
// parameters would be ignored there, so exclude and match-all are not offered.
var OTHER_ENDPOINT_TABS = ['artists', 'albumartists', 'authors', 'studios'];
// Tabs where the stock popover hides studios / resolution and /Items filtering applies.
var EXTRA_TABS = ['videos', 'folders', 'mixed', 'musicvideos'];

var CSS = [
    '#' + TAGS_REGION_ID + ' label.MuiFormControlLabel-root { display: flex; width: 100%; margin-right: 0; }',
    '#' + TAGS_REGION_ID + ' label[hidden] { display: none; }',
    '#' + TAGS_REGION_ID + ' label.gu-excluded .MuiFormControlLabel-label { text-decoration: line-through; opacity: 0.55; }',
    '.gu-tagtools { padding: 12px 16px 0; }',
    '.gu-tagtools input[type=search], .gu-sec input[type=search] { width: 100%; box-sizing: border-box;'
        + ' padding: 0.55em 0.6em; font: inherit; font-size: 16px; color: inherit; background: transparent;'
        + ' border: 1px solid rgba(128,128,128,0.6); border-radius: 4px; }',
    '.gu-status { font-size: 0.8em; opacity: 0.7; margin: 0.35em 0; min-height: 1em; }',
    '.gu-mode { display: flex; align-items: center; gap: 0.5em; margin: 0.4em 0; font-size: 0.9em; cursor: pointer; }',
    '.gu-chips { display: flex; flex-wrap: wrap; gap: 0.35em; margin: 0.35em 0; }',
    '.gu-chip { display: inline-flex; align-items: center; padding: 0.1em 0.1em 0.1em 0.7em; border-radius: 1em;'
        + ' border: 1px solid rgba(128,128,128,0.7); font-size: 0.85em; max-width: 100%; }',
    '.gu-chip.gu-x { border-color: rgba(230,90,90,0.9); }',
    '.gu-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.gu-chip button, .gu-exc { background: none; border: 0; color: inherit; cursor: pointer; font: inherit;'
        + ' line-height: 1; padding: 0.45em 0.7em; opacity: 0.85; }',
    '.gu-exc { margin-left: auto; font-size: 1.1em; }',
    'label.gu-excluded .gu-exc { color: rgb(230,90,90); opacity: 1; }',
    '.gu-hint { font-size: 0.75em; opacity: 0.6; margin: 0.2em 0 0.4em; }',
    '.gu-extras { border-top: 1px solid rgba(128,128,128,0.4); }',
    '.gu-sec { border-bottom: 1px solid rgba(128,128,128,0.25); }',
    '.gu-sec > summary { padding: 0.9em 1em 0.9em 1.2em; cursor: pointer; list-style: revert; }',
    '.gu-sec > div { padding: 0.2em 1em 0.9em 1.2em; }',
    '.gu-sec label.gu-row { display: flex; align-items: center; gap: 0.5em; padding: 0.4em 0; cursor: pointer; }',
    '.gu-results { max-height: 14em; overflow-y: auto; margin-top: 0.4em; }',
    'html.layout-mobile #' + POPOVER_ID + ' .MuiPopover-paper { width: min(94vw, 440px) !important;'
        + ' max-height: 75% !important; }'
].join('\n');

/* ---- helpers ---- */

function setText(node, text) {
    // Only when it differs: assigning identical text still counts as a DOM change to observers.
    if (node.textContent !== text) {
        node.textContent = text;
    }
}

function debounce(fn, ms) {
    var timer = null;
    return function () {
        var args = arguments;
        clearTimeout(timer);
        timer = setTimeout(function () { fn.apply(null, args); }, ms);
    };
}

function labelled(text, input) {
    var l = el('label', 'gu-row');
    l.appendChild(input);
    l.appendChild(el('span', null, text));
    return l;
}

function chip(text, kind, data) {
    var c = el('span', 'gu-chip' + (kind ? ' gu-' + kind : ''));
    c.appendChild(el('span', null, text));
    var b = el('button', null, '✕');
    b.type = 'button';
    b.setAttribute('aria-label', 'Remove ' + text);
    b.setAttribute('data-gu-remove', data);
    c.appendChild(b);
    return c;
}

/* The React-managed element must be the starting point: this panel's own nodes have no fiber. */
function contextOf(root) {
    return findFilterContext(root.querySelector('.MuiPopover-paper') || root);
}

function currentContext() {
    var root = document.getElementById(POPOVER_ID);
    return root ? contextOf(root) : null;
}

/* ---- tags accordion ---- */

function buildTagTools(ctx) {
    var tools = el('div', 'gu-tagtools');

    var input = el('input');
    input.type = 'search';
    input.placeholder = 'Search tags';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Search tags');
    // The page binds keys for its own navigation; typing here must not trigger them.
    input.addEventListener('keydown', function (e) { e.stopPropagation(); });
    input.addEventListener('input', debounce(function () {
        var c = currentContext();
        if (!c) {
            return;
        }

        var key = listKey(c.parentId, c.itemType);
        setSearch(key, input.value);
        var list = listState(key);
        if (list && list.windowed) {
            applyWindow(c.parentId, c.itemType);
        }

        scheduleSync();
    }, 150));
    tools.appendChild(input);
    tools.appendChild(el('div', 'gu-status'));

    if (!OTHER_ENDPOINT_TABS.includes(ctx.viewType)) {
        var mode = el('input');
        mode.type = 'checkbox';
        mode.className = 'gu-all';
        mode.addEventListener('change', function () {
            var c = currentContext();
            if (c) {
                updateTagState(c, function (p) { p.all = mode.checked; });
                scheduleSync(true);
            }
        });
        var modeRow = el('label', 'gu-mode');
        modeRow.appendChild(mode);
        modeRow.appendChild(el('span', null, 'Match ALL selected tags (default: any)'));
        tools.appendChild(modeRow);
        tools.appendChild(el('div', 'gu-chips gu-excl'));
        tools.appendChild(el('div', 'gu-hint', 'Tap ⊘ beside a tag to hide clips that have it.'));
    }

    return tools;
}

function syncTagsRegion(region, ctx) {
    var supportsExclude = !OTHER_ENDPOINT_TABS.includes(ctx.viewType);
    var tools = region.querySelector('.gu-tagtools');
    if (!tools) {
        tools = buildTagTools(ctx);
        region.insertBefore(tools, region.firstChild);
        region.addEventListener('click', onRegionClick, true);
        log('tag search / exclude tools added (' + ctx.viewType + ')');
    }

    var key = listKey(ctx.parentId, ctx.itemType);
    var list = listState(key);
    var state = parseTags(readFilters(ctx).Tags);
    var search = list ? list.search : '';
    var q = normalize(search).trim();

    var input = tools.querySelector('input[type=search]');
    if (document.activeElement !== input && input.value !== search) {
        input.value = search;
    }

    if (supportsExclude) {
        var mode = tools.querySelector('.gu-all');
        if (mode.checked !== state.all) {
            mode.checked = state.all;
        }

        var chips = tools.querySelector('.gu-excl');
        var sig = state.exclude.join('\u0002');
        if (chips.getAttribute('data-sig') !== sig) {
            chips.setAttribute('data-sig', sig);
            chips.textContent = '';
            state.exclude.forEach(function (name) { chips.appendChild(chip('Hide: ' + name, 'x', name)); });
        }
    }

    // Rows. In a windowed list the cache already holds only what matches; in a short list the
    // rows are all there and the search hides the ones that do not match.
    var windowed = !!(list && list.windowed);
    var excluded = {};
    state.exclude.forEach(function (t) { excluded[t] = true; });
    var visible = 0;
    var total = 0;
    Array.prototype.forEach.call(region.querySelectorAll('label'), function (label) {
        var box = label.querySelector('input[type=checkbox]');
        if (!box || label.classList.contains('gu-mode')) {
            return;
        }

        total++;
        var tag = box.value;
        var isEx = !!excluded[tag];

        if (supportsExclude) {
            var btn = label.querySelector('.gu-exc');
            if (!btn) {
                btn = el('button', 'gu-exc', '⊘');
                btn.type = 'button';
                label.appendChild(btn);
            }

            btn.setAttribute('data-tag', tag);
            var title = isEx ? 'Stop hiding "' + tag + '"' : 'Hide clips tagged "' + tag + '"';
            if (btn.title !== title) {
                btn.title = title;
                btn.setAttribute('aria-label', title);
            }

            setText(btn, isEx ? '↺' : '⊘');

            // An excluded tag cannot also be required: the row is inert until it is un-hidden.
            if (isEx && !box.disabled) {
                box.disabled = true;
                box.setAttribute('data-gu-disabled', '1');
            } else if (!isEx && box.getAttribute('data-gu-disabled')) {
                box.disabled = false;
                box.removeAttribute('data-gu-disabled');
            }
        }

        label.classList.toggle('gu-excluded', isEx);
        var hide = !windowed && q && !isEx && !box.checked && normalize(tag).indexOf(q) === -1;
        if (label.hidden !== !!hide) {
            label.hidden = !!hide;
        }

        if (!hide) {
            visible++;
        }
    });

    var status = '';
    if (windowed) {
        status = 'Showing ' + list.shown + ' of ' + list.full.length + ' tags'
            + (q ? ' (' + list.matches + ' match)' : ' - type to search the rest');
    } else if (q) {
        status = visible + ' of ' + total + ' tags match';
    }

    setText(tools.querySelector('.gu-status'), status);
}

function onRegionClick(e) {
    try {
        var region = e.currentTarget;
        var t = e.target && e.target.closest ? e.target : null;
        var excBtn = t && t.closest('.gu-exc');
        var removeBtn = t && t.closest('[data-gu-remove]');
        if (!excBtn && !removeBtn) {
            return;
        }

        e.preventDefault();
        e.stopPropagation();
        var ctx = currentContext();
        if (!ctx) {
            return;
        }

        var tag = excBtn ? excBtn.getAttribute('data-tag') : removeBtn.getAttribute('data-gu-remove');
        updateTagState(ctx, function (p) {
            var i = p.exclude.indexOf(tag);
            if (i >= 0) {
                p.exclude.splice(i, 1);
            } else {
                p.exclude.push(tag);
                // Hiding a tag that is currently required would contradict itself.
                p.tags = p.tags.filter(function (x) { return x !== tag; });
            }
        });
        scheduleSync(true);
    } catch (err) {
        log('exclude click failed', err);
    }
}

/* ---- studios / people / resolution (tabs where the stock popover hides them) ---- */

function buildChooser(kind, title) {
    var sec = el('details', 'gu-sec');
    sec.setAttribute('data-kind', kind);
    sec.appendChild(el('summary', null, title));
    var body = el('div');
    var input = el('input');
    input.type = 'search';
    input.placeholder = kind === 'studio' ? 'Search studios' : 'Search people';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', input.placeholder);
    input.addEventListener('keydown', function (e) { e.stopPropagation(); });
    body.appendChild(input);
    body.appendChild(el('div', 'gu-chips gu-picked'));
    body.appendChild(el('div', 'gu-results'));
    sec.appendChild(body);

    var token = 0;
    var run = function () {
        var ctx = currentContext();
        if (!ctx) {
            return;
        }

        var mine = ++token;
        searchEntities(kind, ctx, input.value.trim()).then(function (items) {
            if (mine !== token) {
                return;
            }

            var results = sec.querySelector('.gu-results');
            results.textContent = '';
            if (!items.length) {
                results.appendChild(el('div', 'gu-hint', 'Nothing found.'));
            }

            items.forEach(function (it) {
                var box = el('input');
                box.type = 'checkbox';
                box.value = it.Id;
                box.setAttribute('data-name', it.Name);
                results.appendChild(labelled(it.Name, box));
            });
            scheduleSync();
        });
    };
    input.addEventListener('input', debounce(run, 250));
    sec.addEventListener('toggle', function () {
        if (sec.open && !sec.querySelector('.gu-results').firstChild) {
            run();
        }
    });
    sec.addEventListener('change', function (e) {
        var box = e.target;
        if (!box || box.type !== 'checkbox') {
            return;
        }

        var ctx = currentContext();
        if (ctx) {
            toggleEntity(ctx, kind, box.value, box.checked);
            scheduleSync(true);
        }
    });
    sec.addEventListener('click', function (e) {
        var rm = e.target && e.target.closest && e.target.closest('[data-gu-remove]');
        var ctx = rm && currentContext();
        if (ctx) {
            toggleEntity(ctx, kind, rm.getAttribute('data-gu-remove'), false);
            scheduleSync(true);
        }
    });
    return sec;
}

function selectedIds(ctx, kind) {
    var f = readFilters(ctx);
    return kind === 'studio' ? (f.StudioIds || []) : parseTags(f.Tags).people;
}

function toggleEntity(ctx, kind, id, on) {
    if (kind === 'studio') {
        updateFilters(ctx, function (f) {
            var ids = (f.StudioIds || []).filter(function (x) { return x !== id; });
            if (on) { ids.push(id); }
            f.StudioIds = ids;
        });
    } else {
        updateTagState(ctx, function (p) {
            p.people = p.people.filter(function (x) { return x !== id; });
            if (on) { p.people.push(id); }
        });
    }
}

function buildResolution() {
    var sec = el('details', 'gu-sec');
    sec.setAttribute('data-kind', 'resolution');
    sec.appendChild(el('summary', null, 'Resolution'));
    var body = el('div');
    [['IsHD', 'HD (1200 px wide or more)'], ['Is4K', '4K'], ['IsSD', 'SD (under HD)']].forEach(function (o) {
        var box = el('input');
        box.type = 'checkbox';
        box.value = o[0];
        body.appendChild(labelled(o[1], box));
    });
    sec.appendChild(body);
    sec.addEventListener('change', function (e) {
        var box = e.target;
        var ctx = box && box.type === 'checkbox' ? currentContext() : null;
        if (!ctx) {
            return;
        }

        updateFilters(ctx, function (f) {
            var v = (f.VideoBasicFilter || []).filter(function (x) { return x !== box.value; });
            if (box.checked) {
                v.push(box.value);
                // The stock handlers treat HD and SD as exclusive; so does this.
                var other = box.value === 'IsHD' ? 'IsSD' : (box.value === 'IsSD' ? 'IsHD' : null);
                v = v.filter(function (x) { return x !== other; });
            }

            f.VideoBasicFilter = v;
        });
        scheduleSync(true);
    });
    return sec;
}

function syncExtras(root, ctx) {
    var paper = root.querySelector('.MuiPopover-paper');
    if (!paper) {
        return;
    }

    var extras = paper.querySelector('.gu-extras');
    if (!extras) {
        extras = el('div', 'gu-extras');
        extras.appendChild(buildResolution());
        extras.appendChild(buildChooser('studio', 'Studios'));
        extras.appendChild(buildChooser('person', 'People'));
        paper.appendChild(extras);
        log('studio / people / resolution filters added (' + ctx.viewType + ')');
    }

    var f = readFilters(ctx);
    var res = f.VideoBasicFilter || [];
    Array.prototype.forEach.call(extras.querySelectorAll('[data-kind=resolution] input'), function (box) {
        var on = res.indexOf(box.value) !== -1;
        if (box.checked !== on) { box.checked = on; }
    });

    ['studio', 'person'].forEach(function (kind) {
        var sec = extras.querySelector('[data-kind=' + kind + ']');
        var ids = selectedIds(ctx, kind);
        var picked = sec.querySelector('.gu-picked');
        var sig = ids.join(',');
        if (picked.getAttribute('data-sig') !== sig) {
            picked.setAttribute('data-sig', sig);
            picked.textContent = '';
            ids.forEach(function (id) { picked.appendChild(chip(nameOf(id) || id, '', id)); });
        }

        Array.prototype.forEach.call(sec.querySelectorAll('.gu-results input'), function (box) {
            var on = ids.indexOf(box.value) !== -1;
            if (box.checked !== on) { box.checked = on; }
        });
    });
}

/* ---- wiring ---- */

var observedRoot = null;
var rootObserver = null;
var syncQueued = false;
var openedFor = null;

function sync() {
    var root = document.getElementById(POPOVER_ID);
    if (!root) {
        return;
    }

    var ctx = contextOf(root);
    if (!ctx) {
        return;
    }

    if (openedFor !== root) {
        // First pass for this opening: window a long cached tag list before the Tags accordion
        // is expanded and React is asked to render all of it.
        openedFor = root;
        ensureWindowed(ctx);
    }

    var region = document.getElementById(TAGS_REGION_ID);
    if (region && root.contains(region)) {
        syncTagsRegion(region, ctx);
    }

    if (EXTRA_TABS.includes(ctx.viewType)) {
        syncExtras(root, ctx);
    }
}

/* Coalesced to a frame. `again` also re-runs after React has re-rendered from a state change. */
function scheduleSync(again) {
    if (!syncQueued) {
        syncQueued = true;
        requestAnimationFrame(function () {
            syncQueued = false;
            try {
                sync();
            } catch (err) {
                log('library filter panel sync failed', err);
            }
        });
    }

    if (again) {
        setTimeout(function () { scheduleSync(); }, 120);
    }
}

function scan() {
    var root = document.getElementById(POPOVER_ID);
    if (root === observedRoot) {
        return;
    }

    if (rootObserver) {
        rootObserver.disconnect();
        rootObserver = null;
    }

    observedRoot = root;
    if (!root) {
        openedFor = null;
        return;
    }

    rootObserver = new MutationObserver(function () { scheduleSync(); });
    rootObserver.observe(root, { childList: true, subtree: true });
    // The stock "reset filters" button and every stock checkbox change React state without
    // necessarily changing this DOM's structure.
    root.addEventListener('click', function () { scheduleSync(true); });
    scheduleSync();
}

export function installLibraryFilterPanel() {
    try {
        if (document.documentElement.classList.contains('layout-tv')) {
            return;
        }

        if (!document.getElementById(STYLE_ID)) {
            var style = el('style');
            style.id = STYLE_ID;
            style.textContent = CSS;
            (document.head || document.documentElement).appendChild(style);
        }

        var pending = false;
        new MutationObserver(function () {
            if (pending) {
                return;
            }

            pending = true;
            requestAnimationFrame(function () {
                pending = false;
                try {
                    scan();
                } catch (err) {
                    log('library filter popover scan failed', err);
                }
            });
        }).observe(document.body || document.documentElement, { childList: true });
        scan();
    } catch (err) {
        log('library filter panel install failed', err);
    }
}
