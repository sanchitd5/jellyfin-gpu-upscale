/*
 * SORT MENU ADDITIONS AND THE TAG LIST'S DEFAULT SORT (pure; controller/list-sort.js does the wiring).
 *
 *  - QOL 10, legacy lists. jellyfin-web 12.1's legacy list page (apps/legacy/controllers/list.js, used
 *    for tag, person, studio, genre and folder lists) offers no Random and no "recently edited".
 *    extendSortOptions() adds both to its sort menu, to a library list only (one that already offers
 *    "Date added"), never to Live TV.
 *  - QOL 10, modern library tabs. They already have Random; only "Recently edited" is added, as a
 *    sort value the tab's own settings setter is given (see modernRecentUpdate).
 *  - QOL 15. A tag link opens `#/list?type=tag&tag=...`, sorted by name because the page reads its
 *    sort from the saved view settings and nothing in the URL. tagDefaultSort() makes the tag list
 *    open newest-first until the viewer picks a sort on it (the menu records that: markChosen).
 *
 * The strings are English like the rest of this script's own UI; jellyfin-web's translation table is
 * not reachable from here without a global that "should" exist.
 */

export var RANDOM_OPTION = { name: 'Random', value: 'Random' };
// 'DateLastSaved' is not a server sort name: list-requests.js sends it as DateLastContentAdded plus
// jpSortKey=DateLastSaved, which ListSortPatches.cs turns into the item's own DateLastSaved.
export var RECENT_SORT = 'DateLastSaved';
export var RECENT_OPTION = { name: 'Recently edited', value: RECENT_SORT + ',SortName' };

export var TAG_DEFAULT = { sortBy: 'DateCreated,SortName', sortOrder: 'Descending' };
export var CHOSEN_KEY = 'jellyfinPlus.listSortChosen';

function firstSort(value) {
    return String(value == null ? '' : value).split(',')[0].trim();
}

function offers(options, sort) {
    return options.some(function (o) {
        return o && String(o.value == null ? '' : o.value).split(',').some(function (p) { return p.trim() === sort; });
    });
}

/*
 * The legacy sort menu's options plus Random and Recently edited. The same array is returned when
 * there is nothing to add (not a library list, or both already there), a copy otherwise.
 */
export function extendSortOptions(options, params) {
    if (!Array.isArray(options) || (params && params.type === 'Programs')) {
        return options;
    }

    // "Date added" is the marker of a list of library items (Live TV programs have no such entry).
    if (!options.some(function (o) { return o && firstSort(o.value) === 'DateCreated'; })) {
        return options;
    }

    var out = options.slice();
    if (!offers(out, 'Random')) {
        out.push(RANDOM_OPTION);
    }

    if (!offers(out, RECENT_SORT)) {
        out.push(RECENT_OPTION);
    }

    return out.length === options.length ? options : out;
}

/*
 * The sort the tag list opens with: newest first, but only while the saved state is the stock
 * default (name, ascending) and the viewer has not picked a sort on this list through the menu.
 * Anything else the viewer saved is theirs and is returned untouched. `chosen` is { settingsKey: true }.
 */
export function tagDefaultSort(values, params, settingsKey, chosen) {
    if (!values || !params || params.type !== 'tag' || (chosen && chosen[settingsKey])) {
        return values;
    }

    if (values.sortBy !== 'SortName' || values.sortOrder !== 'Ascending') {
        return values;
    }

    return Object.assign({}, values, TAG_DEFAULT);
}

/* ---- which sort menus the viewer has used ---- */

export function loadChosen() {
    try {
        var raw = JSON.parse(window.localStorage.getItem(CHOSEN_KEY));
        return raw && typeof raw === 'object' ? raw : {};
    } catch (e) {
        return {};
    }
}

export function markChosen(settingsKey) {
    try {
        var chosen = loadChosen();
        if (!chosen[settingsKey]) {
            chosen[settingsKey] = true;
            window.localStorage.setItem(CHOSEN_KEY, JSON.stringify(chosen));
        }
    } catch (e) { /* the default simply applies again next time */ }
}

/* ---- the modern library tabs ---- */

// Tabs of item lists where "recently edited" means something (not songs, albums, series, playlists).
var MODERN_TABS = ['movies', 'videos', 'musicvideos', 'folders', 'mixed', 'photos', 'photoalbums', 'favorites'];

export function modernRecentApplies(viewType) {
    return MODERN_TABS.indexOf(String(viewType)) !== -1;
}

/* True when the tab is currently sorted by Recently edited alone. */
export function modernRecentActive(settings) {
    var by = settings && settings.SortBy;
    return Array.isArray(by) && by.length === 1 && by[0] === RECENT_SORT;
}

/*
 * The tab's next settings after picking Recently edited: newest first, and picking it again flips
 * the direction, exactly like the stock entries do. Paging goes back to the start, as stock does.
 */
export function modernRecentUpdate(prev) {
    var again = modernRecentActive(prev);
    var order = again ? (prev.SortOrder === 'Ascending' ? 'Descending' : 'Ascending') : 'Descending';
    return Object.assign({}, prev, { StartIndex: 0, SortBy: [RECENT_SORT], SortOrder: order });
}
