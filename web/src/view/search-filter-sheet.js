import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';
import { openSheet as sharedSheet, closeSheet as sharedClose } from './sheet.js';
import { normalize, WINDOW_SIZE, searchEntities } from '../controller/library-filters.js';
import {
    currentFilters,
    commit,
    onFiltersChanged,
    searchParentId,
    fetchTags,
    fetchPeopleFacets,
    refreshIfActive
} from '../controller/search-filters.js';
import { loadVisible, namesNow, resolveNames } from '../controller/quick-tags.js';
import { openQuickTagsEditor } from './quick-tags-editor.js';
import { chipsFor, isSelected, selectedIn, pruneSelection } from '../model/quick-tags.js';
import {
    SORTS,
    TYPES,
    ROLES,
    RESOLUTIONS,
    ADDED_PRESETS,
    RUNTIME_PRESETS,
    defaultState,
    normalizeState,
    sortInfo,
    chipsOf,
    activeGroups,
    removeChip,
    facetRows,
    facetText,
    offeredRoles
} from '../model/search-filters.js';

/*
 * THE SEARCH PAGE'S "SORT & FILTER" BUTTON, ACTIVE-FILTER CHIPS AND BOTTOM SHEET.
 *
 * The bar (button + badge + chips) is appended to jellyfin-web's `#searchPage .searchFields`, below
 * the exclude box that controller/search-exclude.js puts there, and re-added whenever React
 * re-renders the fields away. The sheet is a modal dialog on <body>: a bottom sheet on a phone, a
 * centred panel on a wide window (the shell is view/sheet.js, shared). It edits a DRAFT copy of the filters; nothing is sent until
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
    // Quick tag groups on a phone: one horizontally scrolling line per group.
    'html:not(.jp-theme-off):not(.layout-tv):is(.jp-phone, .layout-mobile:not(.jp-tablet):not(.jp-desktop)) .jfp-pills.jfp-scroll'
        + ' { flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none;'
        + ' overscroll-behavior-x: contain; }',
    '.jfp-pills.jfp-scroll .jfp-pill { flex: none; }',
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

    var body = el('div');
    var reset = button('jfp-reset', 'Reset');
    var apply = button('jfp-apply', 'Apply');

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

    // The picker holds one window of the tag list at a time: the first WINDOW_SIZE tags containing
    // the typed text, asked of the server on every change (fetchTags), never the whole list.
    var tagRows = null; // { tags, total } for `tagQuery`
    var tagQuery = '';
    var tagSeq = 0;
    var renderTags = function () {
        if (!tagRows) {
            return;
        }

        var q = tagQuery;
        tagList.textContent = '';
        tagRows.tags.forEach(function (name) {
            var box = el('input');
            box.type = 'checkbox';
            box.value = name;
            box.checked = draft.tags.indexOf(name) !== -1;
            var row = el('label', 'jfp-row');
            row.appendChild(box);
            row.appendChild(el('span', null, name));
            tagList.appendChild(row);
        });

        var shown = tagRows.tags.length;
        var matches = tagRows.total;
        setText(tagStatus, !matches ? (q ? 'No tags match.' : 'No tags in the library.')
            : matches > shown ? 'Showing ' + shown + ' of ' + matches + (q ? ' matching' : '') + ' tags - type to narrow'
                : matches + (q ? ' matching' : '') + ' tags');
    };
    var loadTags = function () {
        var query = tagInput.value.trim();
        if (tagRows && query === tagQuery) {
            return;
        }

        var seq = ++tagSeq;
        if (!tagRows) {
            setText(tagStatus, 'Loading tags...');
        }

        fetchTags(searchParentId(), query, WINDOW_SIZE).then(function (w) {
            if (seq !== tagSeq) {
                return; // a newer keystroke is already on its way
            }

            // A tag containing the wire's separator cannot be sent as an exact name.
            tagRows = { tags: w.tags.filter(function (t) { return t.indexOf('|') === -1; }), total: w.total };
            tagQuery = query;
            renderTags();
        }, function (err) {
            if (seq === tagSeq) {
                log('search filters: tag list failed', err);
                setText(tagStatus, 'Could not load tags.');
            }
        });
    };
    tagSec.addEventListener('toggle', function () {
        if (tagSec.open) {
            loadTags();
        }
    });
    tagInput.addEventListener('input', debounce(function () {
        if (tagSec.open) {
            loadTags();
        }
    }, 150));
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

    /* ---- quick tag groups (owner-configured; nothing is drawn when there are none) ---- */
    var quickHost = el('div');
    body.appendChild(quickHost);
    loadVisible(searchParentId()).then(function (groups) {
        if (!sheet || !groups || !quickHost.isConnected) {
            return;
        }

        // A pick for a group the owner removed would filter with no chip to show for it.
        draft.quick = pruneSelection(draft.quick, groups);
        groups.forEach(function (g) {
            var sec = el('section', 'jfp-sec');
            sec.appendChild(el('h3', null, g.auto ? g.name + ' (auto)' : g.name));
            var pills = el('div', 'jfp-pills jfp-scroll');
            pills.setAttribute('role', 'group');
            pills.setAttribute('aria-label', g.name);
            sec.appendChild(pills);
            var built = '';
            var draw = function (names) {
                var chips = chipsFor(g, names, selectedIn(draft.quick, g.name));
                var sig = chips.map(function (c) { return c.tag; }).join('\u0001');
                if (sig === built) {
                    return;
                }

                built = sig;
                pills.textContent = '';
                chips.forEach(function (c) {
                    var b = button('jfp-pill', c.label);
                    b.setAttribute('aria-pressed', 'false');
                    b.setAttribute('data-tag', c.tag);
                    b.addEventListener('click', function () {
                        var on = !isSelected(draft.quick, g.name, c.tag);
                        draft.quick = draft.quick.filter(function (q) { return !(q.group === g.name && q.tag === c.tag); });
                        if (on) {
                            draft.quick.push({ group: g.name, tag: c.tag, label: c.label });
                        }

                        refreshAll();
                    });
                    pills.appendChild(b);
                });
                sec.hidden = chips.length === 0;
                refreshAll();
            };
            quickHost.appendChild(sec);
            refreshers.push(function () {
                Array.prototype.forEach.call(pills.children, function (b) {
                    setPressed(b, isSelected(draft.quick, g.name, b.getAttribute('data-tag')));
                });
            });
            sec.hidden = true;
            draw(namesNow(g) || []);
            resolveNames(g).then(function (names) { if (quickHost.isConnected) { draw(names); } });
        });

        // The way into the editor. It replaces this sheet, so unapplied edits here are dropped.
        var editSec = el('div', 'jfp-pills');
        var edit = button('jfp-pill', groups.length ? '⚙ Edit quick filters' : '+ Add quick filters');
        edit.addEventListener('click', function () {
            // Close this sheet first and open the editor only once its history entry has been popped
            // (popstate, or a fallback timer): opening while it is open orphans that entry and swallows the next Back.
            var done = false;
            var act = function () {
                if (done) { return; }
                done = true;
                window.removeEventListener('popstate', act);
                openQuickTagsEditor(opener, null, searchParentId());
            };
            window.addEventListener('popstate', act);
            setTimeout(act, 250);
            sheet.close();
        });
        editSec.style.marginTop = '0.7em';
        editSec.appendChild(edit);
        quickHost.appendChild(editSec);
        refreshAll();
    });

    /* ---- people and studios ---- */
    function entityPicker(kind, title, key, useFacets) {
        var facet = useFacets ? { all: null } : null;
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
        input.placeholder = kind === 'studio' ? 'Search studios' : (facet ? 'Filter cast & crew in these results' : 'Search cast & crew');
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
        var addRow = function (id, name, text) {
            var box = el('input');
            box.type = 'checkbox';
            box.value = id;
            box.setAttribute('data-name', name);
            box.checked = draft[key].some(function (v) { return v.id === id; });
            var row = el('label', 'jfp-row');
            row.appendChild(box);
            row.appendChild(el('span', null, text));
            list.appendChild(row);
        };
        var showEntities = function (items) {
            list.textContent = '';
            setText(status, items.length ? '' : 'Nothing found.');
            items.forEach(function (it) { addRow(it.Id, it.Name, it.Name); });
        };

        /*
         * The facet checklist: only people credited on the CURRENT search's results (the committed
         * term and filters), "Name · count". People already picked stay listed even if they fell out.
         */
        var showFacets = function (res, needle) {
            list.textContent = '';
            if (!res) {
                facet.all = null;
                setText(status, 'Search first to see who appears in the results.');
            } else {
                if (!needle) {
                    facet.all = res.list;
                }

                setText(status, '');
            }

            var rows = facetRows(res ? res.list : [], draft[key], needle);
            rows.forEach(function (r) { addRow(r.id, r.name, facetText(r)); });
            if (res && !rows.length) {
                setText(status, needle ? 'Nobody in these results matches.' : 'No cast or crew are listed for these results.');
            }

            refreshAll();
        };

        var run = function () {
            var mine = ++token;
            loaded = true;
            setText(status, 'Searching...');
            if (facet) {
                var needle = input.value.trim();
                fetchPeopleFacets(needle).then(function (res) {
                    if (mine === token) {
                        showFacets(res, needle);
                    }
                }, function (err) {
                    // An older server without the facets route: fall back to the global people search.
                    log('search filters: facets unavailable, using the global people search', err);
                    searchEntities(kind, { parentId: searchParentId(), itemType: [] }, needle).then(function (items) {
                        if (mine === token) {
                            showEntities(items);
                            setText(status, 'Showing everyone in the library (the results list is unavailable).');
                        }
                    });
                });
                return;
            }

            searchEntities(kind, { parentId: searchParentId(), itemType: [] }, input.value.trim()).then(function (items) {
                if (mine === token) {
                    showEntities(items);
                }
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

        return { sec: sec, input: input, facet: facet };
    }

    /* ---- cast & crew: people + role + any/all ---- */
    var cast = entityPicker('person', 'Cast & Crew', 'people', true);
    var castExtras = el('div', 'jfp-sub');
    var matchBox = el('div', 'jfp-pills');
    var matchBtns = [['Any of', false], ['All of', true]].map(function (m) {
        var b = button('jfp-pill', m[0]);
        b.setAttribute('aria-pressed', 'false');
        b.addEventListener('click', function () {
            draft.peopleAll = m[1];
            refreshAll();
        });
        matchBox.appendChild(b);
        return b;
    });
    var roleBox = el('div', 'jfp-pills');
    var anyRole = button('jfp-pill', 'Any role');
    anyRole.setAttribute('aria-pressed', 'false');
    anyRole.addEventListener('click', function () {
        draft.roles = [];
        refreshAll();
    });
    roleBox.appendChild(anyRole);
    var roleBtns = ROLES.map(function (r) {
        var b = button('jfp-pill', r.label);
        b.setAttribute('aria-pressed', 'false');
        b.addEventListener('click', function () {
            var at = draft.roles.indexOf(r.value);
            if (at === -1) {
                draft.roles.push(r.value);
            } else {
                draft.roles.splice(at, 1);
            }

            refreshAll();
        });
        roleBox.appendChild(b);
        return b;
    });
    var castHint = el('p', 'jfp-hint', 'Role limits the picked people to that credit. With several people, All of keeps only items that credit every one of them.');
    castExtras.appendChild(matchBox);
    castExtras.appendChild(roleBox);
    castExtras.appendChild(castHint);
    cast.sec.insertBefore(castExtras, cast.input);
    refreshers.push(function () {
        // Neither choice means anything until someone is picked (and All of until two are).
        castExtras.hidden = draft.people.length === 0;
        matchBox.hidden = draft.people.length < 2;
        setPressed(matchBtns[0], !draft.peopleAll);
        setPressed(matchBtns[1], draft.peopleAll);
        setPressed(anyRole, draft.roles.length === 0);
        // Only the roles that occur among the people listed for these results (and any already chosen).
        var offered = offeredRoles(cast.facet.all, draft.roles);
        ROLES.forEach(function (r, i) {
            roleBtns[i].hidden = offered.indexOf(r.value) === -1;
            setPressed(roleBtns[i], draft.roles.indexOf(r.value) !== -1);
        });
    });
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
        function write() {
            draft[key] = input.value;
            refreshAll();
        }
        input.addEventListener('input', write);
        input.addEventListener('change', write);
        label.appendChild(input);
        datePair.appendChild(label);
        refreshers.push(function () {
            // Never rewrite a field while it is being typed in.
            if (document.activeElement !== input && input.value !== draft[key]) { input.value = draft[key]; }
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
    resSec.appendChild(el('div', 'jfp-hint', 'SD is under 1200 px wide, HD 1200 and up, 4K 3800 wide or 2100 tall and up. Pick any of them.'));
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

    apply.addEventListener('click', function () {
        var next = normalizeState(draft);
        var same = JSON.stringify(next) === JSON.stringify(currentFilters());
        sheet.close();
        // Unchanged filters need no request - except Random, where Apply means "shuffle again".
        if (!same || next.sort === 'Random') {
            commit(next);
        }
    });
    reset.addEventListener('click', function () {
        var had = activeGroups(currentFilters()).length > 0;
        sheet.close();
        if (had) {
            commit(defaultState());
        }
    });

    refreshAll();
    var handle = sharedSheet({
        title: 'Sort & filter',
        content: body,
        footer: [reset, apply],
        opener: opener,
        onClose: function () {
            sheet = null;
            log('search filter sheet closed');
        }
    });
    sheet = { close: handle.close, el: handle.el };
    log('search filter sheet opened');
}

/* Quick picks saved for a group the owner has since removed would filter with no chip to show: clear them. */
function pruneCommitted() {
    loadVisible(searchParentId()).then(function (groups) {
        var cur = currentFilters();
        if (!groups || !cur.quick.length) {
            return;
        }

        var keep = pruneSelection(cur.quick, groups);
        if (keep.length !== cur.quick.length) {
            var next = JSON.parse(JSON.stringify(cur));
            next.quick = keep;
            commit(next);
        }
    });
}

/* ---- installation ---- */

function scan() {
    try {
        var page = document.getElementById('searchPage');
        if (!page && sheet) {
            // Navigated away with the sheet open (e.g. a link from a notification): drop it.
            sharedClose('navigated', true);
        }

        Array.prototype.forEach.call(document.querySelectorAll('#searchPage .searchFields'), function (fields) {
            // After the exclude box, so the order on the page is: search, exclude, Sort & filter.
            if (fields.querySelector('.' + BAR_CLASS) || !fields.querySelector('.' + EXCLUDE_BOX)) {
                return;
            }

            fields.appendChild(buildBar());
            log('search sort & filter bar added');
            pruneCommitted();
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
