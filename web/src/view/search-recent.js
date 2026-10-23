import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';
import { runSearch } from '../controller/search-exclude.js';
import { committedTerm } from '../controller/search-filters.js';
import { loadRecent, saveRecent, pushTerm, removeTerm, listSig } from '../model/search-recent.js';

/*
 * THE SEARCH PAGE'S RECENT SEARCHES, AND A LONGER SEARCH BOX.
 *
 * Recent searches. Every term the page commits (?query= in the hash) is remembered, newest first
 * (model/search-recent.js, localStorage `jellyfinPlus.searchRecent`). With search-on-submit
 * (controller/search-exclude.js) a committed term IS a submitted one: typing alone commits nothing.
 * The URL is read from the page's own mutations rather than from `hashchange`: react-router moves
 * the hash with history.pushState, which fires no hashchange. While nothing is committed - the
 * empty page that shows jellyfin-web's Suggestions - a row of chips sits under the search fields,
 * after the Sort & filter bar. Tapping a chip searches it through search-exclude.js's own submit
 * path (runSearch); the x forgets one, Clear forgets all.
 *
 * (This module used to raise the 40-character maxLength stock put on #searchTextInput. jellyfin-web
 * 12.3 removed that cap itself, PR #8412, so there is nothing left to raise.)
 *
 * Skipped on TV layouts, where the on-screen alpha picker searches letter by letter. Fails soft: if
 * the fields or the box are not found nothing is added, and stock behaviour is untouched.
 */

var STYLE_ID = 'jellyfinPlusSearchRecentStyle';
var ROW_CLASS = 'jfp-recent';

var LINE = 'var(--jf-palette-divider, rgba(128,128,128,0.4))';

var CSS = [
    '.' + ROW_CLASS + ' { max-width: 60em; margin: 0.8em auto 0; }',
    '.' + ROW_CLASS + '[hidden] { display: none; }',
    '.jfp-rhead { display: flex; align-items: center; justify-content: space-between; min-height: 36px;'
        + ' font-size: 0.9em; opacity: 0.75; }',
    '.jfp-rclear { min-height: 40px; padding: 0 0.8em; border: 0; background: none; color: inherit; font: inherit;'
        + ' cursor: pointer; text-decoration: underline; -webkit-tap-highlight-color: transparent; }',
    '.jfp-rlist { display: flex; flex-wrap: wrap; gap: 0.4em; }',
    '.jfp-rchip { display: inline-flex; align-items: center; max-width: 100%; min-height: 40px; box-sizing: border-box;'
        + ' border-radius: 20px; border: 1px solid ' + LINE + '; }',
    '.jfp-rterm { min-height: 40px; max-width: 100%; padding: 0 0.3em 0 0.9em; border: 0; background: none; color: inherit;'
        + ' font: inherit; font-size: 0.95em; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;'
        + ' -webkit-tap-highlight-color: transparent; }',
    '.jfp-rx { flex: none; min-width: 40px; min-height: 40px; padding: 0; border: 0; background: none; color: inherit;'
        + ' font: inherit; cursor: pointer; opacity: 0.7; border-radius: 20px; }',
    '.jfp-rterm:focus-visible, .jfp-rx:focus-visible, .jfp-rclear:focus-visible'
        + ' { outline: 2px solid var(--jf-palette-primary-main, #00a4dc); outline-offset: 1px; }'
].join('\n');

var recent = [];

function isTv() {
    return document.documentElement.classList.contains('layout-tv');
}

function storage() {
    try {
        return window.localStorage;
    } catch (e) {
        return null;
    }
}

function setRecent(list) {
    recent = list;
    saveRecent(storage(), list);
    render();
}

function ensureStyle() {
    if (document.getElementById(STYLE_ID)) {
        return;
    }

    var style = el('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
}

function button(cls, text, label) {
    var b = el('button', cls, text);
    b.type = 'button';
    if (label) {
        b.setAttribute('aria-label', label);
    }

    return b;
}

function onRowClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!b) {
        return;
    }

    if (b.classList.contains('jfp-rclear')) {
        setRecent([]);
    } else if (b.hasAttribute('data-rm')) {
        setRecent(removeTerm(loadRecent(storage()), b.getAttribute('data-rm')));
    } else if (b.hasAttribute('data-term')) {
        var term = b.getAttribute('data-term');
        if (!runSearch(term)) {
            log('search recent: the search box is not on the page; "' + term + '" not run');
        }
    }
}

function buildRow() {
    var row = el('div', ROW_CLASS);
    row.setAttribute('role', 'region');
    row.setAttribute('aria-label', 'Recent searches');
    var head = el('div', 'jfp-rhead');
    head.appendChild(el('span', null, 'Recent searches'));
    head.appendChild(button('jfp-rclear', 'Clear', 'Clear recent searches'));
    row.appendChild(head);
    row.appendChild(el('div', 'jfp-rlist'));
    row.addEventListener('click', onRowClick);
    return row;
}

function fillChips(list, terms) {
    var sig = listSig(terms);
    if (list.getAttribute('data-sig') === sig) {
        return;
    }

    list.setAttribute('data-sig', sig);
    list.textContent = '';
    terms.forEach(function (t) {
        var chip = el('span', 'jfp-rchip');
        var go = button('jfp-rterm', t, 'Search ' + t);
        go.setAttribute('data-term', t);
        var x = button('jfp-rx', '✕', 'Forget ' + t);
        x.setAttribute('data-rm', t);
        chip.appendChild(go);
        chip.appendChild(x);
        list.appendChild(chip);
    });
}

function render() {
    var fields = document.querySelector('#searchPage .searchFields');
    if (!fields) {
        return;
    }

    var row = fields.querySelector('.' + ROW_CLASS);
    var show = recent.length > 0 && !committedTerm().trim();
    if (!row) {
        if (!show) {
            return;
        }

        row = buildRow();
        fields.appendChild(row);
    }

    // Below whatever else the other search modules put in the fields (exclude box, Sort & filter bar),
    // whichever of them was added first.
    var anchor = fields.querySelector('.jfp-bar') || fields.querySelector('.jellyfinPlusSearchExclude');
    if (anchor && row.previousElementSibling !== anchor) {
        anchor.after(row);
    }

    fillChips(row.querySelector('.jfp-rlist'), recent);
    if (row.hidden === show) {
        row.hidden = !show;
    }
}

var lastSeen = null;

function scan() {
    try {
        if (isTv()) {
            return;
        }

        var fields = document.querySelector('#searchPage .searchFields');
        if (!fields) {
            lastSeen = null;
            return;
        }

        var term = committedTerm().trim();
        if (term && term !== lastSeen) {
            // Re-read first: another tab may have added to the list since this one loaded it.
            var next = pushTerm(loadRecent(storage()), term);
            if (listSig(next) !== listSig(recent)) {
                recent = next;
                saveRecent(storage(), recent);
            }
        }

        if (!term && lastSeen !== '') {
            // Arriving at the empty page (or clearing back to it): show what storage holds now.
            recent = loadRecent(storage());
        }

        lastSeen = term;
        render();
    } catch (err) {
        log('search recent scan failed', err);
    }
}

export function installSearchRecent() {
    ensureStyle();
    recent = loadRecent(storage());

    var pending = false;
    var observer = new MutationObserver(function () {
        // Coalesced, as in search-exclude.js: one scan covers a whole React commit.
        if (pending) {
            return;
        }

        pending = true;
        requestAnimationFrame(function () {
            pending = false;
            scan();
        });
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    scan();
}
