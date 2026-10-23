import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';
import { openSheet, closeSheet } from '../view/sheet.js';
import { openQuickTagsEditor } from '../view/quick-tags-editor.js';
import { libraryHref, libraryIcon } from '../model/nav-routes.js';
import { viewsCache } from './library-landing.js';
import { selectableCards, enterSelectMode } from './select-mode.js';

/*
 * The two sheets behind the bottom bar (P3): Libraries and More. Both are lists of full-width 48 px
 * links in the shared sheet (view/sheet.js). Rows that cannot work are omitted, never greyed.
 * Routes follow redesign-nav-decision.md; navigation is only ever a plain hash link.
 */

var THEME_KEY = 'jellyfinPlus.mobileTheme';
var STYLE_ID = 'jellyfinPlusMoreSheetStyle';
var CSS = [
    '.jp-nav-list { display: flex; flex-direction: column; margin: 0 -1.1em; }',
    '.jp-nav-row { display: flex; align-items: center; gap: 1em; box-sizing: border-box; width: 100%; min-height: 48px;'
        + ' padding: 0 1.1em; border: 0; background: none; color: inherit; font: inherit; text-align: left;'
        + ' text-decoration: none; cursor: pointer; touch-action: manipulation; }',
    '.jp-nav-row:active { background: var(--jp-surface-2, rgba(128,128,128,0.2)); }',
    '.jp-nav-row:focus-visible { outline: 2px solid var(--jp-accent, #00a4dc); outline-offset: -2px; }',
    '.jp-nav-row .material-icons { flex: none; opacity: 0.85; }',
    '.jp-nav-empty { padding: 1em 0; opacity: 0.8; }'
].join('\n');

function ensureStyle() {
    if (!document.getElementById(STYLE_ID)) {
        var s = el('style');
        s.id = STYLE_ID;
        s.textContent = CSS;
        (document.head || document.documentElement).appendChild(s);
    }
}

function icon(name) {
    var i = el('span', 'material-icons', name);
    i.setAttribute('aria-hidden', 'true');
    return i;
}

/* tag is 'a' (with href) or 'button' (with onclick). */
function row(iconName, label, href, onclick) {
    var n = el(href ? 'a' : 'button', 'jp-nav-row');
    if (href) { n.href = href; } else { n.type = 'button'; }
    n.appendChild(icon(iconName));
    n.appendChild(el('span', '', label));
    n.addEventListener('click', function (e) {
        // The sheet owns a history entry that closeSheet pops asynchronously: act only after that
        // pop has landed (popstate), or the hash navigation and the Back race each other.
        e.preventDefault();
        var done = false;
        var act = function () {
            if (done) { return; }
            done = true;
            window.removeEventListener('popstate', act);
            if (href) { window.location.hash = href.slice(1); }
            if (onclick) { onclick(); }
        };
        window.addEventListener('popstate', act);
        setTimeout(act, 250);
        closeSheet('navigate');
    });
    return n;
}

function modernApp() {
    return !!document.querySelector('.MuiAppBar-root');
}

function getViews() {
    if (viewsCache) { return Promise.resolve(viewsCache); }
    var c = window.ApiClient;
    if (!c || typeof c.getCurrentUserId !== 'function' || typeof c.ajax !== 'function') { return Promise.resolve(null); }
    return c.ajax({ type: 'GET', url: c.getUrl('UserViews', { userId: c.getCurrentUserId() }), dataType: 'json' })
        .then(function (r) { return r && r.Items; }, function () { return null; });
}

export function openLibrariesSheet(opener, onClose) {
    ensureStyle();
    var list = el('div', 'jp-nav-list');
    openSheet({ title: 'Libraries', content: list, opener: opener, onClose: onClose, tiers: ['phone', 'tablet'], flush: false });
    getViews().then(function (views) {
        if (!views || !views.length) {
            list.appendChild(el('div', 'jp-nav-empty', 'No libraries'));
            return;
        }
        var modern = modernApp();
        views.forEach(function (v) {
            list.appendChild(row(libraryIcon(v.CollectionType), v.Name, libraryHref(v, modern)));
        });
    }).catch(function (e) {
        log('libraries sheet failed', e);
        list.appendChild(el('div', 'jp-nav-empty', 'No libraries'));
    });
}

function isAdmin() {
    var c = window.ApiClient;
    if (!c || typeof c.getCurrentUser !== 'function') { return Promise.resolve(false); }
    return Promise.resolve(c.getCurrentUser()).then(function (u) {
        return !!(u && u.Policy && u.Policy.IsAdministrator);
    }, function () { return false; });
}

function themeOff() {
    try { return localStorage.getItem(THEME_KEY) === 'off'; } catch (e) { return false; }
}

function toggleTheme() {
    try {
        if (themeOff()) { localStorage.removeItem(THEME_KEY); } else { localStorage.setItem(THEME_KEY, 'off'); }
        window.location.reload();
    } catch (e) {
        log('theme toggle failed', e);
    }
}

export function openMoreSheet(opener, onClose) {
    ensureStyle();
    var list = el('div', 'jp-nav-list');
    list.appendChild(row('queue_music', 'Now playing', '#/queue'));
    list.appendChild(row('person', 'Profile', '#/userprofile'));
    list.appendChild(row('settings', 'Settings', '#/mypreferencesmenu'));
    try {
        if (selectableCards().length) { list.appendChild(row('checklist', 'Select items', null, enterSelectMode)); }
    } catch (e) { /* select mode absent: row omitted */ }
    // The viewer's own one-tap tag filters (model/quick-tags.js); synced across devices by prefs-sync.
    list.appendChild(row('filter_alt', 'Quick filters', null, function () { openQuickTagsEditor(); }));
    var dash = row('dashboard', 'Dashboard', '#/dashboard');
    var theme = row('palette', 'Jellyfin Plus look: ' + (themeOff() ? 'Stock' : 'On'), null, toggleTheme);
    list.appendChild(theme);
    openSheet({ title: 'More', content: list, opener: opener, onClose: onClose, tiers: ['phone', 'tablet'] });
    // Courtesy filter, not access control: shown only to administrators, omitted on any error.
    isAdmin().then(function (yes) {
        if (yes && theme.parentNode) { list.insertBefore(dash, theme); }
    });
}
