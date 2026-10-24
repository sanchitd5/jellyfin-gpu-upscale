import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';
import { parseTags } from '../model/library-filter-marks.js';
import { pruneSelection } from '../model/quick-tags.js';
import { findFilterContext, readFilters, updateTagState } from '../controller/library-filters.js';
import { groupsFor, onGroupsChanged } from '../controller/quick-tags.js';
import { openDateSheet } from './date-sheet.js';
import { encode as encodeDate, decode as decodeDate, labelOf } from '../model/date-added.js';

/*
 * DATE CHIP ABOVE A LIBRARY LIST, AND THE KEEPER OF QUICK TAG PICKS (the search page has its own section in
 * the Sort & filter sheet).
 *
 * The row, drawn just before the page's `.itemsContainer.vertical-wrap` only while a Date-added range is
 * set, shows that range (tap: the date sheet) and a clear button. Date added is picked in the Filter popover
 * (view/library-filter-date.js).
 * Quick tag groups are picked in the library Filter popover (view/library-filter-groups.js); picked chips of
 * a group are OR-ed, groups are AND-ed (model/quick-tags.js). This module still prunes stale picks.
 * The picks are stored the way every other extra library filter is: as marker entries in the tab's own
 * Filters.Tags (model/library-filter-marks.js, kind `a`), written through the tab's settings setter
 * (controller/library-filters.js updateTagState). So React, the persisted copy, the React Query key and
 * the stock Reset button all agree, the stock "has filters" dot counts them, and the outgoing /Items
 * request - including library infinite scroll's follow-up pages, which replay the page's own request -
 * gets `jpTagAnyOf` from the same fetch/XHR rewrite as excludeTagNames.
 *
 * Shown only where it can prove it is on a library tab: the toolbar's React fiber must yield the tab's
 * settings handle, and tabs served by their own endpoint (artists, studios, ...) are skipped because the
 * parameter would be ignored there. No groups configured, groups unreadable, or TV layout: nothing is
 * drawn and nothing is touched. Picks for a group the owner has since removed are cleared, so nothing
 * invisible keeps filtering.
 */

var STYLE_ID = 'jellyfinPlusQuickTagsStyle';
var ROW = 'jpQuickTags';
var OTHER_ENDPOINT_TABS = ['artists', 'albumartists', 'authors', 'studios'];
var PHONE_TIER = 'html:not(.jp-theme-off):not(.layout-tv):is(.jp-phone, .layout-mobile:not(.jp-tablet):not(.jp-desktop))';
var ACCENT = 'var(--jp-accent, var(--jf-palette-primary-main, #00a4dc))';

var CSS = [
    '.' + ROW + ' { flex: 0 0 100%; width: 100%; box-sizing: border-box; display: flex; flex-direction: column; gap: 0.4em;'
        + ' padding: 0 var(--jp-gutter, 16px) 0.6em; }',
    '.jpQtGroup { display: flex; align-items: center; gap: 0.6em; min-width: 0; }',
    '.jpQtName { flex: none; font-size: 0.85em; opacity: 0.7; max-width: 30%; overflow: hidden; text-overflow: ellipsis;'
        + ' white-space: nowrap; }',
    '.jpQtChips { display: flex; flex-wrap: wrap; gap: 0.45em; min-width: 0; padding: 2px 0; }',
    '.jpQtChip { flex: none; min-height: var(--jp-tap, 44px); box-sizing: border-box; padding: 0 1em; border-radius: 999px;'
        + ' border: 1px solid var(--jp-border, rgba(128, 128, 128, 0.55)); background: transparent; color: inherit; font: inherit;'
        + ' cursor: pointer; -webkit-tap-highlight-color: transparent; }',
    '.jpQtDateX { padding: 0; min-width: var(--jp-tap, 44px); margin-left: -0.3em; }',
    '.jpQtAuto { font-size: 0.8em; opacity: 0.7; font-style: italic; }',
    '.jpQtEdit { opacity: 0.75; border-style: dashed; }',
    '.jpQtChip:focus-visible { outline: 2px solid ' + ACCENT + '; outline-offset: 1px; }',
    '.jpQtChip[aria-pressed=true] { background: ' + ACCENT + '; border-color: ' + ACCENT + ';'
        + ' color: var(--jp-on-accent, var(--jf-palette-primary-contrastText, #fff)); }',
    // Phone: one scrolling line per group instead of a wrapped block.
    PHONE_TIER + ' .jpQtChips { flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch;'
        + ' scrollbar-width: none; overscroll-behavior-x: contain; }',
    PHONE_TIER + ' .jpQtChips::-webkit-scrollbar { display: none; }',
    'html.layout-tv .' + ROW + ' { display: none; }'
].join('\n');

var timer = null;
var last = 0;

/* { viewType, parentId, ... } of the tab, from the toolbar's React fiber (by shape), or null. */
function tabContext() {
    var btns = document.querySelectorAll('.MuiToolbar-root button');
    for (var i = 0; i < btns.length; i++) {
        var ctx = findFilterContext(btns[i]);
        if (ctx) {
            return ctx;
        }
    }

    return null;
}

function removeRow() {
    var row = document.querySelector('.' + ROW);
    if (row && row.parentNode) {
        row.parentNode.removeChild(row);
    }
}

/*
 * The row holds the active Date-added range only (drawn only while one is set; scan removes it
 * otherwise). Date added and the quick tag groups are picked in the library Filter popover
 * (view/library-filter-groups.js), together with the entry that edits them.
 */
function render(row, ctx, added) {
    var sig = ctx.viewType + '|' + ctx.parentId + '|' + (added ? labelOf(added) : '-');
    if (row.getAttribute('data-sig') === sig) {
        return;
    }

    row.setAttribute('data-sig', sig);
    row.textContent = '';
    var box = el('div', 'jpQtGroup');
    var line = el('div', 'jpQtChips');
    box.appendChild(line);
    row.appendChild(box);

    // With a range set the chip carries its label and a clear button.
    var date = el('button', 'jpQtChip jpQtDate', added ? labelOf(added) : 'Date');
    date.type = 'button';
    date.setAttribute('data-date', '1');
    date.setAttribute('aria-pressed', added ? 'true' : 'false');
    date.setAttribute('aria-label', added ? 'Date added: ' + labelOf(added) : 'Filter by date added');
    line.appendChild(date);
    if (added) {
        var clear = el('button', 'jpQtChip jpQtDateX', '\u2715');
        clear.type = 'button';
        clear.setAttribute('data-date-clear', '1');
        clear.setAttribute('aria-label', 'Clear date filter');
        line.appendChild(clear);
    }
}

function onClick(e) {
    try {
        var b = e.target && e.target.closest ? e.target.closest('.jpQtChip') : null;
        if (!b) {
            return;
        }

        if (b.getAttribute('data-date') || b.getAttribute('data-date-clear')) {
            var dctx = tabContext();
            if (!dctx) {
                return;
            }

            var setDate = function (state) {
                updateTagState(dctx, function (p) { p.added = encodeDate(state); });
                schedule(0);
                setTimeout(function () { schedule(0); }, 150);
            };
            if (b.getAttribute('data-date-clear')) {
                setDate(null);
            } else {
                openDateSheet(decodeDate(parseTags(readFilters(dctx).Tags).added), setDate, b);
            }

            return;
        }
    } catch (err) {
        log('quick tag chip click failed', err);
    }
}

function scan() {
    last = Date.now();
    var container = document.querySelector('.itemsContainer.vertical-wrap');
    var ctx = container ? tabContext() : null;
    if (!ctx || OTHER_ENDPOINT_TABS.indexOf(ctx.viewType) !== -1) {
        removeRow();
        return;
    }

    var found = groupsFor(ctx.parentId);
    var groups = found.groups;

    // A pick for a group that is no longer configured would filter with no chip to show for it. Not while a
    // suggestion source has yet to answer: its groups are missing from the list, not removed.
    var parsed = parseTags(readFilters(ctx).Tags);
    var picks = parsed.any;
    var added = decodeDate(parsed.added);
    var live = found.ready ? pruneSelection(picks, groups) : picks;
    if (live.length !== picks.length) {
        updateTagState(ctx, function (p) { p.any = pruneSelection(p.any, groups); });
        picks = live;
    }

    // Date added is picked in the Filter popover (view/library-filter-date.js); the row only shows an active
    // range, with its clear button.
    if (!added) {
        removeRow();
        return;
    }

    var row = document.querySelector('.' + ROW);
    if (!row) {
        row = el('div', ROW);
        row.addEventListener('click', onClick);
    }

    if (row.nextSibling !== container || row.parentNode !== container.parentNode) {
        container.parentNode.insertBefore(row, container);
        row.removeAttribute('data-sig');
    }

    render(row, ctx, added);
}

/* At most one scan per 250 ms; a burst of React mutations costs one. */
function schedule(delay) {
    if (timer) {
        return;
    }

    var wait = Math.max(delay, 250 - (Date.now() - last), 0);
    timer = setTimeout(function () {
        timer = null;
        requestAnimationFrame(function () {
            try {
                scan();
            } catch (err) {
                log('quick tags scan failed', err);
            }
        });
    }, wait);
}

/* Re-reads the picks into the chip row now (the filter menu calls this after a tick, the tab's state settles late). */
export function refreshQuickTags() {
    schedule(0);
    setTimeout(function () { schedule(0); }, 150);
}

export function installQuickTags() {
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

        var start = function () {
            new MutationObserver(function () { schedule(0); }).observe(document.body, { childList: true, subtree: true });
            onGroupsChanged(function () { schedule(0); });
            schedule(0);
            log('quick tags installed');
        };

        if (document.body) {
            start();
        } else {
            document.addEventListener('DOMContentLoaded', start, { once: true });
        }
    } catch (err) {
        log('quick tags install failed', err);
    }
}
