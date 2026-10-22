import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';
import { worthShowing, rangeText, KINDS, POOL_CAP } from '../model/search-paging.js';
import {
    pagerOf, hasItem, takeUserNav, goTo, setSize, setMode, isInfinite, onPagerChanged
} from '../controller/search-pager.js';
import { syncInfinite, teardownInfinite } from './search-infinite.js';

/*
 * THE PAGER UNDER THE SEARCH PAGE'S RESULT GRIDS: "‹ Prev | Page X of Y | Next ›" and a page-size
 * choice. Data and requests are controller/search-pager.js; this only draws.
 *
 * Two pagers, because the page runs two result queries:
 *   - Videos: its own query, its own pager under the Videos section.
 *   - Library results: the all-types query is ONE request that jellyfin-web splits into Movies,
 *     Shows, Episodes, ... client-side. Its pager sits under the last of those sections and says it
 *     spans them all: a page is a slice of the ranked mix, not a page of each section.
 *
 * Which section belongs to which query is found by the item ids on its cards (the controller keeps
 * the ids each query last returned), never by the section's title: titles are translated.
 * Each pager lives inside its section's `.verticalSection` element, which jellyfin-web leaves alone
 * until the section's title or position changes; when it does re-create the section the observer
 * below puts the pager back. A pager is only touched when what it shows has changed, so the
 * observer cannot feed on its own edits.
 */

var STYLE_ID = 'jellyfinPlusSearchPagerStyle';
var CLASS = 'jpPager';
var MODE_CLASS = 'jpMode';
var LINE = 'var(--jf-palette-divider, rgba(128,128,128,0.4))';
var P = 'var(--jf-palette-primary-main, #00a4dc)';

var LABELS = { video: 'Videos', all: 'Library results (all sections above)' };

var CSS = [
    '.jpPager { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 0.5em 0.9em;'
        + ' margin: 0.9em 0 1.6em; }',
    '.jpPager-label { flex: 1 0 100%; text-align: center; font-size: 0.85em;'
        + ' color: var(--jf-palette-text-secondary, rgba(255,255,255,0.7)); }',
    '.jpPager-nav, .jpPager-size { display: inline-flex; align-items: center; gap: 0.5em; }',
    '.jpPager-btn { min-height: 44px; min-width: 44px; padding: 0 1em; box-sizing: border-box; border-radius: 22px;'
        + ' border: 1px solid ' + LINE + '; background: transparent; color: inherit; font: inherit; cursor: pointer;'
        + ' -webkit-tap-highlight-color: transparent; }',
    '.jpPager-btn:focus-visible { outline: 2px solid ' + P + '; outline-offset: 1px; }',
    '.jpPager-btn[disabled] { opacity: 0.4; cursor: default; }',
    '.jpPager-btn[aria-pressed=true] { background: ' + P + '; border-color: ' + P + ';'
        + ' color: var(--jf-palette-primary-contrastText, #fff); }',
    '.jpPager-size .jpPager-btn { padding: 0 0.8em; min-width: 0; border-radius: 20px; min-height: 40px; }',
    '.jpPager-page { min-width: 8em; text-align: center; }',
    '.jpPager-per { font-size: 0.85em; opacity: 0.8; }',
    '.jpPager[data-busy=true] { opacity: 0.6; }',
    '.jpMode { display: flex; align-items: center; justify-content: flex-end; gap: 0.5em; margin: 0.2em 0 0; }',
    '.jpMode .jpPager-btn { padding: 0 0.8em; min-width: 0; border-radius: 20px; min-height: 40px; }',
    '.jpInfStatus { display: block; width: 100%; min-height: 3em; margin: 0.5em 0 1.5em; padding: 0; border: 0;'
        + ' background: none; color: inherit; font: inherit; opacity: 0.7; text-align: center; }',
    '.jpInfStatus[data-state=error] { opacity: 1; text-decoration: underline; cursor: pointer; }',
    // Room for the fixed header when a page change scrolls a section to the top.
    '#searchPage .searchResults > .verticalSection { scroll-margin-top: 5em; }'
].join('\n');

function isTv() {
    return document.documentElement.classList.contains('layout-tv');
}

function btn(text, label, onClick, disabled) {
    var b = el('button', 'jpPager-btn', text);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.disabled = !!disabled;
    b.addEventListener('click', onClick);
    return b;
}

function build(kind, m) {
    var box = el('div', CLASS + ' padded-left padded-right');
    box.setAttribute('data-kind', kind);
    box.setAttribute('data-busy', m.busy ? 'true' : 'false');
    box.appendChild(el('div', 'jpPager-label', LABELS[kind] + ': ' + rangeText({
        start: m.start, count: m.count, total: m.total
    })));

    var nav = el('div', 'jpPager-nav');
    nav.appendChild(btn('‹ Prev', 'Previous page', function () { goTo(kind, m.page - 1); },
        m.busy || m.page <= 1));
    nav.appendChild(el('span', 'jpPager-page', 'Page ' + m.page + ' of ' + m.pages
        + (m.total >= POOL_CAP ? '+' : '')));
    nav.appendChild(btn('Next ›', 'Next page', function () { goTo(kind, m.page + 1); },
        m.busy || m.page >= m.pages));
    box.appendChild(nav);

    var size = el('div', 'jpPager-size');
    size.appendChild(el('span', 'jpPager-per', 'Per page'));
    m.sizes.forEach(function (n) {
        var b = btn(String(n), n + ' per page', function () { setSize(kind, n); }, m.busy);
        b.setAttribute('aria-pressed', n === m.size ? 'true' : 'false');
        size.appendChild(b);
    });
    box.appendChild(size);
    return box;
}

function signature(m) {
    return [m.page, m.pages, m.size, m.start, m.count, m.total, m.busy].join('/');
}

/* The first and last section of each kind, by the ids on their first card. */
function findHosts(root) {
    var hosts = { video: null, all: null };
    Array.prototype.forEach.call(root.children, function (sec) {
        if (!sec.classList || !sec.classList.contains('verticalSection')) {
            return;
        }

        var card = sec.querySelector('.itemsContainer .card[data-id]');
        var id = card && card.getAttribute('data-id');
        if (!id) {
            return;
        }

        var kind = hasItem('video', id) ? 'video' : (hasItem('all', id) ? 'all' : null);
        if (kind) {
            hosts[kind] = hosts[kind] || { first: sec, last: sec, sections: [] };
            hosts[kind].last = sec;
            hosts[kind].sections.push(sec);
        }
    });
    return hosts;
}

/* The Paged / Infinite switch, first in the results. Shown once there is more than one slice to show. */
function ensureModeSwitch(root, show) {
    var box = null;
    Array.prototype.forEach.call(root.children, function (c) {
        if (c.classList && c.classList.contains(MODE_CLASS)) {
            box = c;
        }
    });

    if (!show) {
        if (box) {
            root.removeChild(box);
        }

        return;
    }

    var infinite = isInfinite();
    var sig = infinite ? 'infinite' : 'paged';
    if (box && box.getAttribute('data-sig') === sig) {
        return;
    }

    var fresh = el('div', MODE_CLASS + ' padded-left padded-right');
    fresh.setAttribute('data-sig', sig);
    fresh.appendChild(el('span', 'jpPager-per', 'Results'));
    [['paged', 'Paged'], ['infinite', 'Infinite']].forEach(function (o) {
        var b = btn(o[1], o[1] + ' results', function () { setMode(o[0]); }, false);
        b.setAttribute('aria-pressed', o[0] === sig ? 'true' : 'false');
        fresh.appendChild(b);
    });
    if (box) {
        root.replaceChild(fresh, box);
    } else {
        root.insertBefore(fresh, root.firstChild);
    }
}

function scan() {
    try {
        var root = document.querySelector('#searchPage .searchResults');
        if (!root || isTv()) {
            return;
        }

        var hosts = findHosts(root);
        var infinite = isInfinite();
        var multi = false;
        var wanted = {};
        KINDS.forEach(function (kind) {
            var m = pagerOf(kind);
            multi = multi || (!!m && m.total > m.size);
            if (infinite) {
                if (hosts[kind]) {
                    syncInfinite(kind, hosts[kind]);
                }
            } else {
                teardownInfinite(kind);
                if (m && hosts[kind] && worthShowing({ page: m.page, size: m.size, total: m.total })) {
                    wanted[kind] = { m: m, host: hosts[kind] };
                }
            }
        });

        ensureModeSwitch(root, multi);

        Array.prototype.forEach.call(root.querySelectorAll('.' + CLASS), function (box) {
            var w = wanted[box.getAttribute('data-kind')];
            if (!w || box.parentNode !== w.host.last) {
                box.parentNode.removeChild(box);
            }
        });

        Object.keys(wanted).forEach(function (kind) {
            var w = wanted[kind];
            var sig = signature(w.m);
            var box = null;
            Array.prototype.forEach.call(w.host.last.children, function (c) {
                if (c.classList && c.classList.contains(CLASS) && c.getAttribute('data-kind') === kind) {
                    box = c;
                }
            });

            if (!box || box.getAttribute('data-sig') !== sig) {
                var fresh = build(kind, w.m);
                fresh.setAttribute('data-sig', sig);
                if (box) {
                    w.host.last.replaceChild(fresh, box);
                } else {
                    w.host.last.appendChild(fresh);
                }
            }

            if (!w.m.busy && takeUserNav(kind)) {
                // The page just changed: show its first cards, not the pager the viewer clicked.
                w.host.first.scrollIntoView({ block: 'start' });
            }
        });
    } catch (err) {
        log('search pager scan failed', err);
    }
}

export function installSearchPager() {
    try {
        if (!document.getElementById(STYLE_ID)) {
            var style = el('style');
            style.id = STYLE_ID;
            style.textContent = CSS;
            (document.head || document.documentElement).appendChild(style);
        }

        var pending = false;
        var schedule = function () {
            // Coalesced: React commits many mutations at once and one scan covers them all.
            if (pending) {
                return;
            }

            pending = true;
            requestAnimationFrame(function () {
                pending = false;
                scan();
            });
        };

        new MutationObserver(schedule).observe(document.body || document.documentElement,
            { childList: true, subtree: true });
        onPagerChanged(schedule);
        schedule();
        log('search pager installed');
    } catch (err) {
        log('search pager failed to install', err);
    }
}
