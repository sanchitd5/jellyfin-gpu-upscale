import { log } from '../lib/log.js';
import {
    extendSortOptions,
    tagDefaultSort,
    loadChosen,
    markChosen,
    RECENT_OPTION,
    modernRecentApplies,
    modernRecentActive,
    modernRecentUpdate
} from '../model/list-sort.js';

/*
 * SORT MENUS AND THE TAG LIST DEFAULT (model/list-sort.js holds the rules; this finds the seams).
 *
 * LEGACY LIST PAGE (tag, person, studio, genre and folder lists). Its controller module's default
 * export is the ItemsView class, and the sort menu is a separate class; both are found BY SHAPE as
 * webpack-hook.js hands over each module's exports (noteListView / noteSortMenu), never by name or
 * module id, and wrapped on their prototypes:
 *
 *   - getSortMenuOptions() gets Random and Recently edited appended. The page also builds its
 *     "Sort by: <name>" label from this method, so the label is right for the new entries too.
 *   - getSortValues() opens a tag list newest-first while its saved sort is the stock default and
 *     the viewer has not picked a sort on it. The sort menu's show() is wrapped only to learn that
 *     a pick happened (it returns the promise unchanged).
 *
 * MODERN LIBRARY TABS. They already offer Random. Their sort menu is a MUI popover (#sort-popover)
 * built from arrays that are private to the component, so "Recently edited" is added as one more
 * menu row in that popover (a clone of a stock row, so it looks native). It writes through the tab's
 * own settings setter, found by shape on the React tree (the component whose props carry
 * setLibraryViewSettings + viewType + libraryViewSettings), exactly like the stock rows do.
 *
 * Every step is in try/catch and a missing seam leaves the stock menu as it was.
 */

var viewPatched = false;
var menuPatched = false;

/*
 * The class-like function exports of a module (its default export is mangled to a short name in a
 * production build, so the keys are scanned, as the other note* hooks do). A getter that throws
 * (a binding still in its temporal dead zone) is skipped.
 */
function functionExports(exports) {
    var out = [];
    if (typeof exports === 'function') {
        out.push(exports);
    }

    if (exports && (typeof exports === 'object' || typeof exports === 'function')) {
        Object.keys(exports).forEach(function (k) {
            try {
                var v = exports[k];
                if (typeof v === 'function' && out.indexOf(v) === -1) {
                    out.push(v);
                }
            } catch (err) { /* not readable yet */ }
        });
    }

    return out;
}

/* ---- legacy: the list view class ---- */

function isListView(proto) {
    return !!proto && typeof proto.getSortMenuOptions === 'function' && typeof proto.getSortValues === 'function'
        && typeof proto.getVisibleFilters === 'function' && typeof proto.getFilterMenuOptions === 'function'
        && typeof proto.getSettingsKey === 'function';
}

export function noteListView(exports) {
    try {
        if (viewPatched || !exports) {
            return;
        }

        var View = functionExports(exports).filter(function (f) { return isListView(f.prototype); })[0];
        if (!View) {
            return;
        }

        var proto = View.prototype;
        viewPatched = true;
        var originalOptions = proto.getSortMenuOptions;
        proto.getSortMenuOptions = function () {
            var options = originalOptions.apply(this, arguments);
            try {
                return extendSortOptions(options, this.params);
            } catch (err) {
                log('list sort: extending the sort menu failed', err);
                return options;
            }
        };

        var originalValues = proto.getSortValues;
        proto.getSortValues = function () {
            var values = originalValues.apply(this, arguments);
            try {
                return tagDefaultSort(values, this.params, this.getSettingsKey(), loadChosen());
            } catch (err) {
                log('list sort: tag default failed', err);
                return values;
            }
        };

        log('list sort: legacy list view patched (sort menu options, tag default)');
    } catch (err) {
        log('list sort: legacy list view hook failed', err);
    }
}

/* ---- legacy: the sort menu dialog ---- */

export function noteSortMenu(exports) {
    try {
        if (menuPatched || !exports) {
            return;
        }

        // Dialog classes with a show() are common; the sort menu is the one whose show() reads
        // options.sortOptions and options.settingsKey.
        var Menu = functionExports(exports).filter(function (f) {
            if (!f.prototype || typeof f.prototype.show !== 'function') {
                return false;
            }

            var source = Function.prototype.toString.call(f.prototype.show);
            return source.indexOf('sortOptions') !== -1 && source.indexOf('settingsKey') !== -1;
        })[0];
        if (!Menu) {
            return;
        }

        var proto = Menu.prototype;
        menuPatched = true;
        var originalShow = proto.show;
        proto.show = function (options) {
            var promise = originalShow.apply(this, arguments);
            try {
                var key = options && options.settingsKey;
                if (key && promise && typeof promise.then === 'function') {
                    // Resolved only when the viewer changed something (stock rejects on a plain close).
                    promise.then(function () { markChosen(key); }, function () { /* closed unchanged */ });
                }
            } catch (err) {
                log('list sort: sort menu hook failed', err);
            }

            return promise;
        };

        log('list sort: legacy sort menu wrapped');
    } catch (err) {
        log('list sort: legacy sort menu hook failed', err);
    }
}

/* ---- modern: Recently edited in the library sort popover ---- */

var POPOVER_ID = 'sort-popover';
var MARK = 'data-jp-recent';

function fiberOf(node) {
    var keys = Object.keys(node);
    for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('__reactFiber$') === 0) {
            return node[keys[i]];
        }
    }

    return null;
}

/* { viewType, settings, set } of the tab whose sort button owns this popover, or null. By shape. */
function sortContext(node) {
    try {
        for (var f = node && fiberOf(node); f; f = f.return) {
            var p = f.memoizedProps;
            if (p && typeof p.setLibraryViewSettings === 'function' && typeof p.viewType === 'string'
                && p.libraryViewSettings && typeof p.libraryViewSettings === 'object') {
                return { viewType: p.viewType, settings: p.libraryViewSettings, set: p.setLibraryViewSettings };
            }
        }
    } catch (err) {
        log('list sort: finding the sort button failed', err);
    }

    return null;
}

var warned = false;

/* True when there is nothing more to do for this popover (added, or not applicable). */
function inject(root) {
    var list = root.querySelector('ul[role="menu"]') || root.querySelector('ul');
    var rows = list ? list.querySelectorAll('li') : [];
    if (!list || !rows.length) {
        return false;
    }

    if (list.querySelector('[' + MARK + ']')) {
        return true;
    }

    var ctx = sortContext(list);
    if (!ctx || !modernRecentApplies(ctx.viewType)) {
        return true;
    }

    var label = rows[rows.length - 1].querySelector('.MuiListItemText-primary');
    if (!label) {
        if (!warned) {
            warned = true;
            log('list sort: the sort popover has an unexpected shape; Recently edited not added');
        }

        return true;
    }

    var row = rows[rows.length - 1].cloneNode(true);
    row.setAttribute(MARK, '1');
    row.classList.remove('Mui-selected', 'Mui-focusVisible');
    row.removeAttribute('aria-selected');
    row.querySelector('.MuiListItemText-primary').textContent = RECENT_OPTION.name;
    var icon = row.querySelector('.MuiListItemIcon-root');
    if (icon) {
        icon.textContent = modernRecentActive(ctx.settings) ? (ctx.settings.SortOrder === 'Ascending' ? '▲' : '▼') : '';
    }

    row.addEventListener('click', function () {
        try {
            var again = sortContext(list) || ctx;
            again.set(modernRecentUpdate);
            var backdrop = root.querySelector('.MuiBackdrop-root');
            if (backdrop) {
                backdrop.click();
            }
        } catch (err) {
            log('list sort: Recently edited failed', err);
        }
    });
    list.appendChild(row);
    return true;
}

var observedRoot = null;
var rootObserver = null;

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
        return;
    }

    if (inject(root)) {
        return;
    }

    // The popover's content mounts a moment after its root: retry until it is there.
    rootObserver = new MutationObserver(function () {
        try {
            if (inject(root) && rootObserver) {
                rootObserver.disconnect();
                rootObserver = null;
            }
        } catch (err) {
            log('list sort: popover sync failed', err);
        }
    });
    rootObserver.observe(root, { childList: true, subtree: true });
}

export function installListSort() {
    try {
        if (document.documentElement.classList.contains('layout-tv')) {
            return;
        }

        // MUI portals the popover as a direct child of <body>, and this script runs from <head>, before
        // <body> exists (see view/library-filter-panel.js): wait for it.
        var start = function () {
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
                        log('list sort: popover scan failed', err);
                    }
                });
            }).observe(document.body, { childList: true });
            scan();
            log('list sort installed');
        };

        if (document.body) {
            start();
        } else {
            document.addEventListener('DOMContentLoaded', start, { once: true });
        }
    } catch (err) {
        log('list sort install failed', err);
    }
}
