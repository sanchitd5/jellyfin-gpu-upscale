import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';
import { normalize, WINDOW_SIZE, searchEntities } from '../controller/library-filters.js';
import {
    currentFilters,
    commit,
    onFiltersChanged,
    searchParentId,
    fetchTags,
    refreshIfActive
} from '../controller/search-filters.js';
import {
    SORTS,
    TYPES,
    RESOLUTIONS,
    ADDED_PRESETS,
    RUNTIME_PRESETS,
    defaultState,
    normalizeState,
    sortInfo,
    chipsOf,
    activeGroups,
    removeChip
} from '../model/search-filters.js';

/*
 * THE SEARCH PAGE'S "SORT & FILTER" BUTTON, ACTIVE-FILTER CHIPS AND BOTTOM SHEET.
 *
 * The bar (button + badge + chips) is appended to jellyfin-web's `#searchPage .searchFields`, below
 * the exclude box that controller/search-exclude.js puts there, and re-added whenever React
 * re-renders the fields away. The sheet is a modal dialog on <body>: a bottom sheet on a phone, a
 * centred panel on a wide window. It edits a DRAFT copy of the filters; nothing is sent until
 * Apply (controller/search-filters.js commit()). Closing it any other way - backdrop, the close
 * button, Escape, the browser's Back - throws the draft away.
 *
 * Styled with jellyfin-web's own --jf-palette-* variables (each with a dark fallback), so every
 * theme applies; controls are at least 40px tall. Skipped on TV layouts.
 */

var STYLE_ID = 'jellyfinPlusSearchFilterStyle';
var BAR_CLASS = 'jfp-bar';
var EXCLUDE_BOX = 'jellyfinPlusSearchExclude';

var P = 'var(--jf-palette-primary-main, #00a4dc)';
var LINE = 'var(--jf-palette-divider, rgba(128,128,128,0.4))';

var CSS = [
    '.jfp-bar { max-width: 60em; margin: 0.6em auto 0; }',
    '.jfp-bar-row { display: flex; align-items: center; gap: 0.6em; }',
    '.jfp-btn { display: inline-flex; align-items: center; justify-content: center; gap: 0.5em; min-height: 44px;'
        + ' padding: 0 1.1em; box-sizing: border-box; border-radius: 22px; border: 1px solid ' + LINE + ';'
        + ' background: transparent; color: inherit; font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }',
    '.jfp-btn:focus-visible, .jfp-pill:focus-visible, .jfp-x:focus-visible, .jfp-input:focus-visible'
        + ' { outline: 2px solid ' + P + '; outline-offset: 1px; }',
    '.jfp-badge { display: inline-block; min-width: 1.5em; height: 1.5em; line-height: 1.5em; padding: 0 0.3em;'
        + ' box-sizing: border-box; border-radius: 0.75em; text-align: center; font-size: 0.85em;'
        + ' background: ' + P + '; color: var(--jf-palette-primary-contrastText, #fff); }',
    '.jfp-badge[hidden] { display: none; }',
    '.jfp-chips { display: flex; flex-wrap: wrap; gap: 0.4em; margin: 0.5em 0 0; }',
    '.jfp-chips:empty { display: none; }',
    '.jfp-chip { display: inline-flex; align-items: center; min-height: 40px; max-width: 100%; box-sizing: border-box;'
        + ' padding: 0 0 0 0.9em; border-radius: 20px; border: 1px solid ' + LINE + '; font-size: 0.9em; }',
    '.jfp-chip > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.jfp-x { flex: none; min-width: 40px; min-height: 40px; padding: 0; margin-left: 0.1em; border: 0; background: none;'
        + ' color: inherit; font: inherit; cursor: pointer; opacity: 0.8; border-radius: 20px; }',
    '.jfp-backdrop { position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 9000; display: flex;'
        + ' align-items: flex-end; justify-content: center; background: rgba(0,0,0,0.6); touch-action: none;'
        + ' animation: jfp-fade 0.15s ease-out; }',
    '.jfp-sheet { display: flex; flex-direction: column; width: 100%; max-height: 92vh; max-height: 92dvh;'
        + ' box-sizing: border-box; border-radius: 16px 16px 0 0; touch-action: auto; outline: none;'
        + ' background: var(--jf-palette-background-paper, #202020); color: var(--jf-palette-text-primary, #fff);'
        + ' box-shadow: 0 -4px 24px rgba(0,0,0,0.45); animation: jfp-rise 0.2s ease-out; }',
    '@media (min-width: 50em) { .jfp-backdrop { align-items: center; }'
        + ' .jfp-sheet { width: min(580px, 92vw); max-height: 85vh; border-radius: 12px;'
        + ' box-shadow: 0 8px 32px rgba(0,0,0,0.5); animation: jfp-fade 0.15s ease-out; } }',
    '@keyframes jfp-fade { from { opacity: 0; } to { opacity: 1; } }',
    '@keyframes jfp-rise { from { transform: translateY(40px); opacity: 0.6; } to { transform: none; opacity: 1; } }',
    '@media (prefers-reduced-motion: reduce) { .jfp-backdrop, .jfp-sheet { animation: none; } }',
    '.jfp-head { display: flex; align-items: center; justify-content: space-between; flex: none;'
        + ' padding: 0.3em 0.4em 0.3em 1.1em; border-bottom: 1px solid ' + LINE + '; }',
    '.jfp-head h2 { margin: 0; font-size: 1.15em; font-weight: 600; }',
    '.jfp-head .jfp-x { min-width: 44px; min-height: 44px; font-size: 1.2em; }',
    '.jfp-body { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;'
        + ' padding: 0.3em 1.1em 1em; }',
    '.jfp-foot { display: flex; gap: 0.7em; flex: none; padding: 0.7em 1.1em;'
        + ' padding-bottom: calc(0.7em + env(safe-area-inset-bottom, 0px)); border-top: 1px solid ' + LINE + '; }',
    '.jfp-foot button { flex: 1; min-height: 46px; margin: 0; border-radius: 23px; font: inherit; font-weight: 600; cursor: pointer; }',
    '.jfp-reset { background: transparent; color: inherit; border: 1px solid ' + LINE + '; }',
    '.jfp-apply { background: ' + P + '; color: var(--jf-palette-primary-contrastText, #fff); border: 1px solid ' + P + '; }',
    '.jfp-sec { padding: 0.9em 0 0.3em; border-bottom: 1px solid ' + LINE + '; }',
    '.jfp-sec:last-child { border-bottom: 0; }',
    '.jfp-sec > h3, .jfp-sec > summary { margin: 0 0 0.5em; font-size: 0.95em; font-weight: 600;'
        + ' color: var(--jf-palette-text-secondary, rgba(255,255,255,0.7)); }',
    '.jfp-sec > summary { display: flex; align-items: center; justify-content: space-between; min-height: 44px;'
        + ' margin: -0.5em 0 0; cursor: pointer; }',
    '.jfp-sec > summary::-webkit-details-marker { display: none; }',
    '.jfp-sec > summary small { margin-left: auto; font-weight: 400; font-size: 0.9em; }',
    '.jfp-sec > summary::after { content: "\\25BE"; margin-left: 0.6em; transition: transform 0.15s; }',
    '.jfp-sec[open] > summary::after { transform: rotate(180deg); }',
    '.jfp-sub { margin: 0.3em 0 0.7em; }',
    '.jfp-pills { display: flex; flex-wrap: wrap; gap: 0.45em; margin: 0 0 0.7em; }',
    '.jfp-pills[hidden] { display: none; }',
    '.jfp-pill { min-height: 40px; padding: 0 1em; box-sizing: border-box; border-radius: 20px; border: 1px solid ' + LINE + ';'
        + ' background: transparent; color: inherit; font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }',
    '.jfp-pill[aria-pressed=true] { background: ' + P + '; border-color: ' + P + ';'
        + ' color: var(--jf-palette-primary-contrastText, #fff); }',
    '.jfp-input { width: 100%; min-height: 44px; box-sizing: border-box; padding: 0 0.8em; font: inherit; font-size: 16px;'
        + ' color: inherit; background: transparent; border: 1px solid rgba(128,128,128,0.6); border-radius: 8px; }',
    '.jfp-pair { display: flex; gap: 0.6em; margin: 0 0 0.7em; }',
    '.jfp-pair label { flex: 1; min-width: 0; font-size: 0.85em; }',
    '.jfp-pair .jfp-input { margin-top: 0.25em; }',
    '.jfp-pair[hidden] { display: none; }',
    '.jfp-list { max-height: 14em; overflow-y: auto; overscroll-behavior: contain; margin: 0.4em 0 0.7em; }',
    '.jfp-row { display: flex; align-items: center; gap: 0.8em; min-height: 44px; padding: 0 0.2em; cursor: pointer; }',
    '.jfp-row input { flex: none; width: 20px; height: 20px; margin: 0; accent-color: ' + P + '; }',
    '.jfp-row span { overflow: hidden; text-overflow: ellipsis; }',
    '.jfp-status { min-height: 1.2em; margin: 0.35em 0; font-size: 0.8em; opacity: 0.7; }',
    '.jfp-hint { margin: 0 0 0.7em; font-size: 0.8em; opacity: 0.65; }'
].join('\n');

/* The wording of the direction toggle, per sort: [ascending, descending]. */
var ORDER_WORDS = {
    DateCreated: ['Oldest first', 'Newest first'],
    SortName: ['A to Z', 'Z to A'],
    Runtime: ['Shortest first', 'Longest first'],
    PremiereDate: ['Oldest first', 'Newest first'],
    CommunityRating: ['Lowest first', 'Highest first'],
    PlayCount: ['Fewest first', 'Most first'],
    DatePlayed: ['Oldest first', 'Most recent first']
};

/* ---- small DOM helpers ---- */

function button(cls, text, label) {
    var b = el('button', cls, text);
    b.type = 'button';
    if (label) {
        b.setAttribute('aria-label', label);
    }

    return b;
}

function stopKeys(input) {
    // The page binds keys for its own navigation; typing here must not trigger them.
    input.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter') {
            e.preventDefault();
            input.blur();
        }
    });
}

function setPressed(b, on) {
    var v = on ? 'true' : 'false';
    if (b.getAttribute('aria-pressed') !== v) {
        b.setAttribute('aria-pressed', v);
    }
}

function setText(node, text) {
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

/* Rebuilds a chip row: items = [{ id, label }]. The remove buttons carry data-id. */
function fillChips(box, items, removeLabel) {
    var sig = items.map(function (i) { return i.id + '\u0001' + i.label; }).join('\u0002');
    if (box.getAttribute('data-sig') === sig) {
        return;
    }

    box.setAttribute('data-sig', sig);
    box.textContent = '';
    items.forEach(function (it) {
        var c = el('span', 'jfp-chip');
        c.appendChild(el('span', null, it.label));
        var x = button('jfp-x', '✕', removeLabel + ' ' + it.label);
        x.setAttribute('data-id', it.id);
        c.appendChild(x);
        box.appendChild(c);
    });
}

/* ---- the bar on the page ---- */

function renderBar(bar) {
    var s = currentFilters();
    var n = activeGroups(s).length;
    var badge = bar.querySelector('.jfp-badge');
    setText(badge, String(n));
    badge.hidden = n === 0;
    var open = bar.querySelector('.jfp-open');
    var label = n ? 'Sort and filter, ' + n + ' active' : 'Sort and filter';
    if (open.getAttribute('aria-label') !== label) {
        open.setAttribute('aria-label', label);
    }

    fillChips(bar.querySelector('.jfp-chips'), chipsOf(s), 'Remove');
}

function renderBars() {
    Array.prototype.forEach.call(document.querySelectorAll('.' + BAR_CLASS), renderBar);
}

function buildBar() {
    var bar = el('div', BAR_CLASS);
    var row = el('div', 'jfp-bar-row');
    var open = button('jfp-btn jfp-open', null);
    open.appendChild(el('span', null, 'Sort & filter'));
    open.appendChild(el('span', 'jfp-badge', '0'));
    open.setAttribute('aria-haspopup', 'dialog');
    open.addEventListener('click', function () { openSheet(open); });
    row.appendChild(open);
    bar.appendChild(row);

    var chips = el('div', 'jfp-chips');
    chips.setAttribute('aria-label', 'Active filters');
    chips.addEventListener('click', function (e) {
        var x = e.target && e.target.closest ? e.target.closest('[data-id]') : null;
        if (x) {
            // A chip is a visible, active filter: removing one is an explicit act, so it applies now.
            commit(removeChip(currentFilters(), x.getAttribute('data-id')));
        }
    });
    bar.appendChild(chips);
    renderBar(bar);
    return bar;
}

/* ---- the sheet ---- */

var sheet = null;

function openSheet(opener) {
    if (sheet) {
        return;
    }

    var draft = normalizeState(JSON.parse(JSON.stringify(currentFilters())));
    var refreshers = [];
    var refreshAll = function () {
        refreshers.forEach(function (fn) {
            try {
                fn();
            } catch (err) {
                log('search filter sheet refresh failed', err);
            }
        });
    };

    var backdrop = el('div', 'jfp-backdrop');
    var dialog = el('div', 'jfp-sheet');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Sort and filter');
    dialog.tabIndex = -1;

    var head = el('div', 'jfp-head');
    head.appendChild(el('h2', null, 'Sort & filter'));
    var closeBtn = button('jfp-x', '✕', 'Close');
    head.appendChild(closeBtn);

    var body = el('div', 'jfp-body');
    var foot = el('div', 'jfp-foot');
    var reset = button('jfp-reset', 'Reset');
    var apply = button('jfp-apply', 'Apply');
    foot.appendChild(reset);
    foot.appendChild(apply);

    /* A group of single-choice pills bound to a draft field. */
    function choice(options, get, set) {
        var box = el('div', 'jfp-pills');
        var pairs = options.map(function (o) {
            var b = button('jfp-pill', o.label);
            b.setAttribute('aria-pressed', 'false');
            b.addEventListener('click', function () {
                set(o.value);
                refreshAll();
            });
            box.appendChild(b);
            return [o, b];
        });
        refreshers.push(function () {
            pairs.forEach(function (p) { setPressed(p[1], get() === p[0].value); });
        });
        return box;
    }

    function section(title) {
        var sec = el('section', 'jfp-sec');
        sec.appendChild(el('h3', null, title));
        body.appendChild(sec);
        return sec;
    }

    /* A collapsible section whose summary shows a count of what is picked. */
    function disclosure(title, count) {
        var sec = el('details', 'jfp-sec');
        var sum = el('summary');
        sum.appendChild(el('span', null, title));
        var small = el('small');
        sum.appendChild(small);
        sec.appendChild(sum);
        refreshers.push(function () {
            var n = count();
            setText(small, n ? n + ' selected' : '');
        });
        body.appendChild(sec);
        return sec;
    }

    /* ---- sort ---- */
    var sortSec = section('Sort by');
    sortSec.appendChild(choice(SORTS, function () { return draft.sort; }, function (v) {
        draft.sort = v;
        draft.order = sortInfo(v).order || draft.order;
    }));
    var orderBox = el('div', 'jfp-pills');
    var ascBtn = button('jfp-pill', 'Ascending');
    var descBtn = button('jfp-pill', 'Descending');
    ascBtn.addEventListener('click', function () { draft.order = 'Ascending'; refreshAll(); });
    descBtn.addEventListener('click', function () { draft.order = 'Descending'; refreshAll(); });
    orderBox.appendChild(ascBtn);
    orderBox.appendChild(descBtn);
    sortSec.appendChild(orderBox);
    refreshers.push(function () {
        var has = !!sortInfo(draft.sort).order;
        orderBox.hidden = !has;
        var words = ORDER_WORDS[draft.sort] || ['Ascending', 'Descending'];
        setText(ascBtn, words[0]);
        setText(descBtn, words[1]);
        setPressed(ascBtn, draft.order === 'Ascending');
        setPressed(descBtn, draft.order === 'Descending');
    });

    /* ---- tags ---- */
    var tagSec = disclosure('Tags', function () { return draft.tags.length; });
    var tagChips = el('div', 'jfp-chips');
    tagChips.style.marginBottom = '0.5em';
    tagChips.addEventListener('click', function (e) {
        var x = e.target && e.target.closest ? e.target.closest('[data-id]') : null;
        if (x) {
            var t = x.getAttribute('data-id');
            draft.tags = draft.tags.filter(function (v) { return v !== t; });
            refreshAll();
        }
    });
    tagSec.appendChild(tagChips);
    tagSec.appendChild(choice([{ value: false, label: 'Match any' }, { value: true, label: 'Match all' }],
        function () { return draft.tagAll; }, function (v) { draft.tagAll = v; }));
    var tagInput = el('input', 'jfp-input');
    tagInput.type = 'search';
    tagInput.placeholder = 'Search tags';
    tagInput.autocomplete = 'off';
    tagInput.setAttribute('aria-label', 'Search tags');
    stopKeys(tagInput);
    var tagStatus = el('div', 'jfp-status');
    var tagList = el('div', 'jfp-list');
    tagSec.appendChild(tagInput);
    tagSec.appendChild(tagStatus);
    tagSec.appendChild(tagList);
    tagSec.appendChild(el('div', 'jfp-hint',
        'Picked tags are required. The exclude box above hides results with a tag containing a word.'));
    refreshers.push(function () {
        fillChips(tagChips, draft.tags.map(function (t) { return { id: t, label: t }; }), 'Remove tag');
        Array.prototype.forEach.call(tagList.querySelectorAll('input'), function (box) {
            var on = draft.tags.indexOf(box.value) !== -1;
            if (box.checked !== on) { box.checked = on; }
        });
    });

    var allTags = null;
    var allNorm = null;
    var tagsLoading = false;
    var renderTags = function () {
        if (!allTags) {
            return;
        }

        var q = normalize(tagInput.value).trim();
        tagList.textContent = '';
        var shown = 0;
        var matches = 0;
        for (var i = 0; i < allTags.length; i++) {
            if (q && allNorm[i].indexOf(q) === -1) {
                continue;
            }

            matches++;
            if (shown < WINDOW_SIZE) {
                shown++;
                var box = el('input');
                box.type = 'checkbox';
                box.value = allTags[i];
                box.checked = draft.tags.indexOf(allTags[i]) !== -1;
                var row = el('label', 'jfp-row');
                row.appendChild(box);
                row.appendChild(el('span', null, allTags[i]));
                tagList.appendChild(row);
            }
        }

        setText(tagStatus, !allTags.length ? 'No tags in the library.'
            : matches > shown ? 'Showing ' + shown + ' of ' + matches + (q ? ' matching' : '') + ' tags - type to narrow'
                : matches + (q ? ' matching' : '') + ' tags');
    };
    var loadTags = function () {
        if (allTags || tagsLoading) {
            return;
        }

        tagsLoading = true;
        setText(tagStatus, 'Loading tags...');
        fetchTags(searchParentId()).then(function (tags) {
            // A tag containing the wire's separator cannot be sent as an exact name.
            allTags = tags.filter(function (t) { return t.indexOf('|') === -1; });
            allNorm = allTags.map(normalize);
            tagsLoading = false;
            renderTags();
        }, function (err) {
            tagsLoading = false;
            log('search filters: tag list failed', err);
            setText(tagStatus, 'Could not load tags.');
        });
    };
    tagSec.addEventListener('toggle', function () {
        if (tagSec.open) {
            loadTags();
        }
    });
    tagInput.addEventListener('input', debounce(renderTags, 150));
    tagList.addEventListener('change', function (e) {
        var box = e.target;
        if (!box || box.type !== 'checkbox') {
            return;
        }

        draft.tags = draft.tags.filter(function (v) { return v !== box.value; });
        if (box.checked) {
            draft.tags.push(box.value);
        }

        refreshAll();
    });
    if (draft.tags.length) {
        tagSec.open = true;
        loadTags();
    }

    /* ---- people and studios ---- */
    function entityPicker(kind, title, key) {
        var sec = disclosure(title, function () { return draft[key].length; });
        var chips = el('div', 'jfp-chips');
        chips.style.marginBottom = '0.5em';
        chips.addEventListener('click', function (e) {
            var x = e.target && e.target.closest ? e.target.closest('[data-id]') : null;
            if (x) {
                var id = x.getAttribute('data-id');
                draft[key] = draft[key].filter(function (v) { return v.id !== id; });
                refreshAll();
            }
        });
        var input = el('input', 'jfp-input');
        input.type = 'search';
        input.placeholder = kind === 'studio' ? 'Search studios' : 'Search people';
        input.autocomplete = 'off';
        input.setAttribute('aria-label', input.placeholder);
        stopKeys(input);
        var status = el('div', 'jfp-status');
        var list = el('div', 'jfp-list');
        sec.appendChild(chips);
        sec.appendChild(input);
        sec.appendChild(status);
        sec.appendChild(list);

        refreshers.push(function () {
            fillChips(chips, draft[key].map(function (v) { return { id: v.id, label: v.name }; }), 'Remove');
            Array.prototype.forEach.call(list.querySelectorAll('input'), function (box) {
                var on = draft[key].some(function (v) { return v.id === box.value; });
                if (box.checked !== on) { box.checked = on; }
            });
        });

        var token = 0;
        var loaded = false;
        var run = function () {
            var mine = ++token;
            loaded = true;
            setText(status, 'Searching...');
            searchEntities(kind, { parentId: searchParentId(), itemType: [] }, input.value.trim()).then(function (items) {
                if (mine !== token) {
                    return;
                }

                list.textContent = '';
                setText(status, items.length ? '' : 'Nothing found.');
                items.forEach(function (it) {
                    var box = el('input');
                    box.type = 'checkbox';
                    box.value = it.Id;
                    box.setAttribute('data-name', it.Name);
                    box.checked = draft[key].some(function (v) { return v.id === it.Id; });
                    var row = el('label', 'jfp-row');
                    row.appendChild(box);
                    row.appendChild(el('span', null, it.Name));
                    list.appendChild(row);
                });
            });
        };
        input.addEventListener('input', debounce(run, 250));
        sec.addEventListener('toggle', function () {
            if (sec.open && !loaded) {
                run();
            }
        });
        list.addEventListener('change', function (e) {
            var box = e.target;
            if (!box || box.type !== 'checkbox') {
                return;
            }

            draft[key] = draft[key].filter(function (v) { return v.id !== box.value; });
            if (box.checked) {
                draft[key].push({ id: box.value, name: box.getAttribute('data-name') || box.value });
            }

            refreshAll();
        });
        if (draft[key].length) {
            sec.open = true;
        }
    }
    entityPicker('person', 'People', 'people');
    entityPicker('studio', 'Studio', 'studios');

    /* ---- runtime ---- */
    var rtSec = section('Runtime (minutes)');
    var rtPills = el('div', 'jfp-pills');
    var rtBtns = RUNTIME_PRESETS.map(function (p) {
        var b = button('jfp-pill', p.label);
        b.setAttribute('aria-pressed', 'false');
        b.addEventListener('click', function () {
            draft.minRuntime = p.min;
            draft.maxRuntime = p.max;
            refreshAll();
        });
        rtPills.appendChild(b);
        return b;
    });
    rtSec.appendChild(rtPills);
    var rtPair = el('div', 'jfp-pair');
    function numberField(text, key) {
        var label = el('label', null, text);
        var input = el('input', 'jfp-input');
        input.type = 'number';
        input.min = '0';
        input.step = '1';
        input.inputMode = 'numeric';
        input.placeholder = 'Any';
        stopKeys(input);
        input.addEventListener('input', function () {
            var v = input.value.trim();
            var n = v === '' ? null : Math.floor(Number(v));
            draft[key] = n !== null && isFinite(n) && n >= 0 ? n : null;
            refreshAll();
        });
        label.appendChild(input);
        rtPair.appendChild(label);
        refreshers.push(function () {
            // Never rewrite a field while it is being typed in.
            if (document.activeElement !== input) {
                var want = draft[key] === null ? '' : String(draft[key]);
                if (input.value !== want) { input.value = want; }
            }
        });
    }
    numberField('At least', 'minRuntime');
    numberField('At most', 'maxRuntime');
    rtSec.appendChild(rtPair);
    refreshers.push(function () {
        RUNTIME_PRESETS.forEach(function (p, i) {
            setPressed(rtBtns[i], p.min === draft.minRuntime && p.max === draft.maxRuntime);
        });
    });

    /* ---- date added ---- */
    var addSec = section('Date added');
    addSec.appendChild(choice(ADDED_PRESETS, function () { return draft.added; }, function (v) { draft.added = v; }));
    var datePair = el('div', 'jfp-pair');
    function dateField(text, key) {
        var label = el('label', null, text);
        var input = el('input', 'jfp-input');
        input.type = 'date';
        input.addEventListener('keydown', function (e) { e.stopPropagation(); });
        input.addEventListener('change', function () {
            draft[key] = input.value;
            refreshAll();
        });
        label.appendChild(input);
        datePair.appendChild(label);
        refreshers.push(function () {
            if (input.value !== draft[key]) { input.value = draft[key]; }
        });
    }
    dateField('From', 'addedFrom');
    dateField('To', 'addedTo');
    addSec.appendChild(datePair);
    refreshers.push(function () { datePair.hidden = draft.added !== 'custom'; });

    /* ---- resolution ---- */
    var resSec = section('Resolution');
    var resBox = el('div', 'jfp-pills');
    var resBtns = RESOLUTIONS.map(function (r) {
        var b = button('jfp-pill', r.label);
        b.setAttribute('aria-pressed', 'false');
        b.addEventListener('click', function () {
            draft.res = draft.res.indexOf(r.value) === -1
                ? draft.res.concat([r.value])
                : draft.res.filter(function (v) { return v !== r.value; });
            refreshAll();
        });
        resBox.appendChild(b);
        return b;
    });
    resSec.appendChild(resBox);
    resSec.appendChild(el('div', 'jfp-hint', 'SD is under 1260 px wide, HD 1260 to 3799, 4K 3800 and up. Pick any of them.'));
    refreshers.push(function () {
        RESOLUTIONS.forEach(function (r, i) { setPressed(resBtns[i], draft.res.indexOf(r.value) !== -1); });
    });

    /* ---- played, favourites, type ---- */
    var playedSec = section('Watched');
    playedSec.appendChild(choice([
        { value: 'any', label: 'Any' }, { value: 'played', label: 'Played' }, { value: 'unplayed', label: 'Unplayed' }
    ], function () { return draft.played; }, function (v) { draft.played = v; }));
    var favBox = el('div', 'jfp-pills');
    var favBtn = button('jfp-pill', 'Favourites only');
    favBtn.setAttribute('aria-pressed', 'false');
    favBtn.addEventListener('click', function () {
        draft.favorites = !draft.favorites;
        refreshAll();
    });
    favBox.appendChild(favBtn);
    playedSec.appendChild(favBox);
    refreshers.push(function () { setPressed(favBtn, draft.favorites); });

    var typeSec = section('Type');
    typeSec.appendChild(choice(TYPES, function () { return draft.type; }, function (v) { draft.type = v; }));

    dialog.appendChild(head);
    dialog.appendChild(body);
    dialog.appendChild(foot);
    backdrop.appendChild(dialog);

    /* ---- closing: backdrop, button, Escape, Back ---- */
    var onKey = function (e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeSheet();
        } else if (e.key === 'Tab') {
            var focusable = Array.prototype.filter.call(
                dialog.querySelectorAll('button, input, summary, [tabindex]:not([tabindex="-1"])'),
                function (n) { return !n.disabled && n.offsetParent !== null; });
            if (focusable.length) {
                var first = focusable[0];
                var last = focusable[focusable.length - 1];
                if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
                    e.preventDefault();
                    last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
        }
    };
    var onPop = function () { closeSheet(true); };

    sheet = {
        backdrop: backdrop,
        opener: opener,
        onKey: onKey,
        onPop: onPop,
        pushed: false,
        draftOf: function () { return draft; }
    };

    backdrop.addEventListener('click', function (e) {
        if (e.target === backdrop) {
            closeSheet();
        }
    });
    closeBtn.addEventListener('click', function () { closeSheet(); });
    apply.addEventListener('click', function () {
        var next = normalizeState(draft);
        var same = JSON.stringify(next) === JSON.stringify(currentFilters());
        closeSheet();
        // Unchanged filters need no request - except Random, where Apply means "shuffle again".
        if (!same || next.sort === 'Random') {
            commit(next);
        }
    });
    reset.addEventListener('click', function () {
        var had = activeGroups(currentFilters()).length > 0;
        closeSheet();
        if (had) {
            commit(defaultState());
        }
    });

    document.addEventListener('keydown', onKey, true);
    window.addEventListener('popstate', onPop);
    try {
        window.history.pushState({ jfpSheet: true }, '');
        sheet.pushed = true;
    } catch (err) { /* no history entry: Back leaves the page instead of closing the sheet */ }

    refreshAll();
    document.body.appendChild(backdrop);
    dialog.focus();
    log('search filter sheet opened');
}

function closeSheet(fromPop) {
    if (!sheet) {
        return;
    }

    var s = sheet;
    sheet = null;
    document.removeEventListener('keydown', s.onKey, true);
    window.removeEventListener('popstate', s.onPop);
    if (s.backdrop.parentNode) {
        s.backdrop.parentNode.removeChild(s.backdrop);
    }

    // Our own history entry is still on top unless Back already took it.
    if (!fromPop && s.pushed) {
        try {
            if (window.history.state && window.history.state.jfpSheet) {
                window.history.back();
            }
        } catch (err) { /* nothing to pop */ }
    }

    try {
        if (s.opener && document.contains(s.opener)) {
            s.opener.focus();
        }
    } catch (err) { /* focus is a courtesy */ }

    log('search filter sheet closed');
}

/* ---- installation ---- */

function scan() {
    try {
        var page = document.getElementById('searchPage');
        if (!page && sheet) {
            // Navigated away with the sheet open (e.g. a link from a notification): drop it.
            closeSheet(true);
        }

        Array.prototype.forEach.call(document.querySelectorAll('#searchPage .searchFields'), function (fields) {
            // After the exclude box, so the order on the page is: search, exclude, Sort & filter.
            if (fields.querySelector('.' + BAR_CLASS) || !fields.querySelector('.' + EXCLUDE_BOX)) {
                return;
            }

            fields.appendChild(buildBar());
            log('search sort & filter bar added');
            // Results already on screen (or restored from the persisted cache) may predate the filters.
            refreshIfActive();
        });
    } catch (err) {
        log('search filter bar scan failed', err);
    }
}

export function installSearchFilterBar() {
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

        onFiltersChanged(renderBars);

        var start = function () {
            var pending = false;
            new MutationObserver(function () {
                // Coalesced: React commits many mutations at once and one scan covers them all.
                if (pending) {
                    return;
                }

                pending = true;
                requestAnimationFrame(function () {
                    pending = false;
                    scan();
                });
            }).observe(document.body, { childList: true, subtree: true });
            scan();
            log('search filter bar installed');
        };

        if (document.body) {
            start();
        } else {
            document.addEventListener('DOMContentLoaded', start, { once: true });
        }
    } catch (err) {
        log('search filter bar install failed', err);
    }
}
