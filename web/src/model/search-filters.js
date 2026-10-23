/*
 * THE SEARCH PAGE'S "SORT & FILTER" STATE, AND ITS SERIALISER. No DOM here, so it runs under node
 * (search-filters.test.mjs) exactly as it runs in the browser.
 *
 * The state is one plain object (defaultState() below), persisted in localStorage
 * `jellyfinPlus.searchFilters`. rewriteSearchUrl() turns it into the WIRE CONTRACT the server half
 * (src/patcher) reads, on the search page's /Items requests only:
 *
 *   sortBy / sortOrder            stock params; absent = relevance. Random sends jpSeed, no order.
 *   isPlayed / isFavorite         stock
 *   tags=a|b + tagMatch=all       stock (pipe-separated exact names) + ours
 *   personIds / studioIds         stock, comma-separated Guids
 *   personTypes                   stock, comma-separated PersonKind names (Actor, Director, ...). Stock
 *                                 applies it only together with personIds: one credit row must match
 *                                 BOTH the person and the role, so it is a role filter on the picked people
 *   jpPersonMatch=all             ours: every picked person must be credited (stock personIds is any-of)
 *   jpMinRuntime / jpMaxRuntime   whole minutes, inclusive
 *   jpMinDateAdded / jpMaxDateAdded  YYYY-MM-DD, UTC, inclusive by day
 *   jpResolution                  comma list of sd,hd,4k
 *   jpTagAnyOf                    one per quick tag group with a pick: the picked tags joined by `|`
 *                                 (OR inside a group, AND between groups; model/quick-tags.js)
 *
 * Type is the one filter jellyfin-web's own two /Items search queries (the Video query, marked by
 * mediaTypes=Video, and the all-types query) answer differently, so it is done by steering them:
 * the query that should show nothing is cut down to a one-item stock request whose result the page
 * discards (it only builds sections for the item types it asked for), and the other one carries
 * the filters. See typePlan().
 */

import { SEP, MAX_GROUPS, MAX_NAMES, usableTag, anyOfValues } from './quick-tags.js';

export var STORE_KEY = 'jellyfinPlus.searchFilters';

export var SORTS = [
    { value: 'relevance', label: 'Relevance', order: null },
    { value: 'DateCreated', label: 'Date added', order: 'Descending' },
    { value: 'SortName', label: 'Name', order: 'Ascending' },
    { value: 'Runtime', label: 'Runtime', order: 'Descending' },
    { value: 'PremiereDate', label: 'Release date', order: 'Descending' },
    { value: 'CommunityRating', label: 'Rating', order: 'Descending' },
    { value: 'Random', label: 'Random', order: null },
    { value: 'PlayCount', label: 'Play count', order: 'Descending' },
    { value: 'DatePlayed', label: 'Last played', order: 'Descending' }
];

export var TYPES = [
    { value: 'all', label: 'All' },
    { value: 'videos', label: 'Videos' },
    { value: 'movies', label: 'Movies' },
    { value: 'episodes', label: 'Episodes' }
];

/* Credit roles, value = the PersonKind name stock stores and matches (personTypes is case-sensitive). */
export var ROLES = [
    { value: 'Actor', label: 'Actor' },
    { value: 'Director', label: 'Director' },
    { value: 'Writer', label: 'Writer' },
    { value: 'Producer', label: 'Producer' },
    { value: 'GuestStar', label: 'Guest star' },
    { value: 'Composer', label: 'Composer' },
    { value: 'Conductor', label: 'Conductor' },
    { value: 'Lyricist', label: 'Lyricist' },
    { value: 'Arranger', label: 'Arranger' },
    { value: 'Creator', label: 'Creator' }
];

export var RESOLUTIONS = [
    { value: 'sd', label: 'SD' },
    { value: 'hd', label: 'HD' },
    { value: '4k', label: '4K' }
];

export var ADDED_PRESETS = [
    { value: 'any', label: 'Any time', days: null },
    { value: '24h', label: '24 hours', days: 1 },
    { value: '7d', label: '7 days', days: 7 },
    { value: '30d', label: '30 days', days: 30 },
    { value: '1y', label: '1 year', days: 365 },
    { value: 'custom', label: 'Custom', days: null }
];

// Runtime presets in minutes. null = unbounded on that side.
export var RUNTIME_PRESETS = [
    { label: 'Any', min: null, max: null },
    { label: 'Under 5', min: null, max: 5 },
    { label: '5-20', min: 5, max: 20 },
    { label: '20-60', min: 20, max: 60 },
    { label: 'Over 60', min: 60, max: null }
];

var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
var GUID_RE = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;

export function defaultState() {
    return {
        sort: 'relevance',
        order: 'Descending',
        seed: 0,
        tags: [],
        tagAll: false,
        quick: [],
        people: [],
        roles: [],
        peopleAll: false,
        studios: [],
        minRuntime: null,
        maxRuntime: null,
        added: 'any',
        addedFrom: '',
        addedTo: '',
        res: [],
        played: 'any',
        favorites: false,
        type: 'all'
    };
}

export function sortInfo(value) {
    for (var i = 0; i < SORTS.length; i++) {
        if (SORTS[i].value === value) {
            return SORTS[i];
        }
    }

    return SORTS[0];
}

function minutes(v) {
    if (v === null || v === undefined || v === '') {
        return null;
    }

    var n = Math.floor(Number(v));
    return isFinite(n) && n >= 0 && n <= 100000 ? n : null;
}

function pickOne(v, allowed, fallback) {
    return allowed.indexOf(v) !== -1 ? v : fallback;
}

function entities(list) {
    var out = [];
    var seen = {};
    (Array.isArray(list) ? list : []).forEach(function (e) {
        if (e && typeof e.id === 'string' && GUID_RE.test(e.id) && !seen[e.id]) {
            seen[e.id] = true;
            out.push({ id: e.id, name: typeof e.name === 'string' ? e.name : e.id });
        }
    });
    return out;
}

/* Quick tag picks: [{ group, tag, label }], well-formed, deduplicated, within the wire's caps. */
function quickPicks(list) {
    var out = [];
    var groups = {};
    (Array.isArray(list) ? list : []).forEach(function (q) {
        if (!q || typeof q.group !== 'string' || !q.group || q.group.length > 100 || q.group.indexOf(SEP) !== -1
            || !usableTag(q.tag)) {
            return;
        }

        var inGroup = out.filter(function (x) { return x.group === q.group; });
        if (inGroup.some(function (x) { return x.tag === q.tag; }) || inGroup.length >= MAX_NAMES
            || (!groups[q.group] && Object.keys(groups).length >= MAX_GROUPS)) {
            return;
        }

        groups[q.group] = true;
        out.push({ group: q.group, tag: q.tag, label: typeof q.label === 'string' && q.label ? q.label : q.tag });
    });
    return out;
}

/* Anything -> a well-formed state. Used on every load and on every draft, so nothing malformed
 * (hand-edited storage, an older shape) can reach a URL. */
export function normalizeState(raw) {
    var s = defaultState();
    if (!raw || typeof raw !== 'object') {
        return s;
    }

    var sortValues = SORTS.map(function (x) { return x.value; });
    s.sort = pickOne(raw.sort, sortValues, 'relevance');
    s.order = pickOne(raw.order, ['Ascending', 'Descending'], sortInfo(s.sort).order || 'Descending');
    s.seed = Math.floor(Number(raw.seed)) > 0 && Math.floor(Number(raw.seed)) <= 2147483647
        ? Math.floor(Number(raw.seed)) : 0;

    var seenTag = {};
    (Array.isArray(raw.tags) ? raw.tags : []).forEach(function (t) {
        if (typeof t === 'string' && t && t.indexOf('|') === -1 && !seenTag[t]) {
            seenTag[t] = true;
            s.tags.push(t);
        }
    });
    s.tagAll = raw.tagAll === true;
    s.quick = quickPicks(raw.quick);
    s.people = entities(raw.people);
    // Canonical ROLES order, unknown names dropped: nothing but a PersonKind name reaches a URL.
    s.roles = ROLES.map(function (x) { return x.value; }).filter(function (v) {
        return Array.isArray(raw.roles) && raw.roles.indexOf(v) !== -1;
    });
    s.peopleAll = raw.peopleAll === true;
    s.studios = entities(raw.studios);

    s.minRuntime = minutes(raw.minRuntime);
    s.maxRuntime = minutes(raw.maxRuntime);
    if (s.minRuntime !== null && s.maxRuntime !== null && s.minRuntime > s.maxRuntime) {
        var t = s.minRuntime;
        s.minRuntime = s.maxRuntime;
        s.maxRuntime = t;
    }

    s.added = pickOne(raw.added, ADDED_PRESETS.map(function (x) { return x.value; }), 'any');
    s.addedFrom = typeof raw.addedFrom === 'string' && DATE_RE.test(raw.addedFrom) ? raw.addedFrom : '';
    s.addedTo = typeof raw.addedTo === 'string' && DATE_RE.test(raw.addedTo) ? raw.addedTo : '';
    if (s.addedFrom && s.addedTo && s.addedFrom > s.addedTo) {
        var d = s.addedFrom;
        s.addedFrom = s.addedTo;
        s.addedTo = d;
    }

    s.res = RESOLUTIONS.map(function (x) { return x.value; }).filter(function (v) {
        return Array.isArray(raw.res) && raw.res.indexOf(v) !== -1;
    });
    s.played = pickOne(raw.played, ['any', 'played', 'unplayed'], 'any');
    s.favorites = raw.favorites === true;
    s.type = pickOne(raw.type, TYPES.map(function (x) { return x.value; }), 'all');
    return s;
}

export function loadState() {
    try {
        return normalizeState(JSON.parse(window.localStorage.getItem(STORE_KEY)));
    } catch (e) {
        return defaultState();
    }
}

export function saveState(state) {
    try {
        if (activeGroups(state).length) {
            window.localStorage.setItem(STORE_KEY, JSON.stringify(state));
        } else {
            window.localStorage.removeItem(STORE_KEY);
        }
    } catch (e) { /* storage refused: the filters still apply for this page view */ }
}

/* ---- what is active, for the chips and the badge ---- */

function pad(n) {
    return (n < 10 ? '0' : '') + n;
}

/* YYYY-MM-DD of a Date, in UTC (the contract's day boundary). */
export function utcDay(date) {
    return date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate());
}

/* The date-added bounds the state means right now: { from, to } as YYYY-MM-DD or ''. */
export function addedRange(s, now) {
    if (s.added === 'custom') {
        return { from: s.addedFrom, to: s.addedTo };
    }

    for (var i = 0; i < ADDED_PRESETS.length; i++) {
        if (ADDED_PRESETS[i].value === s.added && ADDED_PRESETS[i].days) {
            var from = new Date((now || new Date()).getTime() - ADDED_PRESETS[i].days * 86400000);
            return { from: utcDay(from), to: '' };
        }
    }

    return { from: '', to: '' };
}

/* Three resolution buckets together restrict nothing worth sending (and would drop files whose
 * width is unknown), so only one or two count as a filter. */
export function activeRes(s) {
    return s.res.length > 0 && s.res.length < RESOLUTIONS.length ? s.res : [];
}

/* Roles only mean something next to picked people (stock ignores personTypes without personIds). */
export function activeRoles(s) {
    return s.people.length ? s.roles : [];
}

/* "All of" is only a choice, and only sent, with two or more people. */
export function matchAllPeople(s) {
    return s.peopleAll && s.people.length > 1;
}

function roleLabels(s) {
    return activeRoles(s).map(function (v) {
        return ROLES.filter(function (x) { return x.value === v; })[0].label;
    }).join(' / ');
}

function runtimeText(s) {
    if (s.minRuntime !== null && s.maxRuntime !== null) {
        return s.minRuntime + '-' + s.maxRuntime + ' min';
    }

    return s.minRuntime !== null ? 'Over ' + s.minRuntime + ' min' : 'Under ' + s.maxRuntime + ' min';
}

function addedText(s) {
    var preset = ADDED_PRESETS.filter(function (x) { return x.value === s.added; })[0];
    if (s.added !== 'custom') {
        return 'Added: last ' + preset.label;
    }

    if (s.addedFrom && s.addedTo) {
        return 'Added: ' + s.addedFrom + ' to ' + s.addedTo;
    }

    return s.addedFrom ? 'Added: since ' + s.addedFrom : 'Added: until ' + s.addedTo;
}

/*
 * The active filters as removable chips: [{ group, label, id }]. `group` is what the badge counts
 * (tags, people, ... each count once however many are picked); `id` says what a click removes.
 */
export function chipsOf(s) {
    var out = [];
    if (s.sort !== 'relevance') {
        var info = sortInfo(s.sort);
        out.push({
            group: 'sort',
            id: 'sort',
            label: 'Sort: ' + info.label + (info.order ? (s.order === 'Ascending' ? ' (asc)' : ' (desc)') : '')
        });
    }

    s.tags.forEach(function (t) { out.push({ group: 'tags', id: 'tag:' + t, label: t }); });
    if (s.tagAll && s.tags.length > 1) {
        out.push({ group: 'tags', id: 'tagAll', label: 'Match all tags' });
    }

    // One badge count per quick group, however many of its chips are picked.
    s.quick.forEach(function (q) {
        out.push({ group: 'quick:' + q.group, id: 'quick:' + q.group + SEP + q.tag, label: q.group + ': ' + q.label });
    });

    var roleText = roleLabels(s);
    s.people.forEach(function (p) {
        out.push({ group: 'people', id: 'person:' + p.id, label: 'Cast: ' + p.name + (roleText ? ' (' + roleText + ')' : '') });
    });
    if (matchAllPeople(s)) {
        out.push({ group: 'people', id: 'peopleAll', label: 'Match all people' });
    }

    s.studios.forEach(function (p) { out.push({ group: 'studios', id: 'studio:' + p.id, label: p.name }); });
    if (s.minRuntime !== null || s.maxRuntime !== null) {
        out.push({ group: 'runtime', id: 'runtime', label: runtimeText(s) });
    }

    var added = addedRange(s);
    if (added.from || added.to) {
        out.push({ group: 'added', id: 'added', label: addedText(s) });
    }

    var res = activeRes(s);
    if (res.length) {
        out.push({
            group: 'res',
            id: 'res',
            label: res.map(function (v) {
                return RESOLUTIONS.filter(function (x) { return x.value === v; })[0].label;
            }).join(' + ')
        });
    }

    if (s.played !== 'any') {
        out.push({ group: 'played', id: 'played', label: s.played === 'played' ? 'Played' : 'Unplayed' });
    }

    if (s.favorites) {
        out.push({ group: 'favorites', id: 'favorites', label: 'Favourites' });
    }

    if (s.type !== 'all') {
        out.push({
            group: 'type',
            id: 'type',
            label: 'Type: ' + TYPES.filter(function (x) { return x.value === s.type; })[0].label
        });
    }

    return out;
}

/* The distinct active groups; its length is the badge. */
export function activeGroups(s) {
    var seen = {};
    var out = [];
    chipsOf(s).forEach(function (c) {
        if (!seen[c.group]) {
            seen[c.group] = true;
            out.push(c.group);
        }
    });
    return out;
}

/* A copy of the state with one chip's filter cleared. */
export function removeChip(s, id) {
    var n = normalizeState(JSON.parse(JSON.stringify(s)));
    var d = defaultState();
    var colon = id.indexOf(':');
    var kind = colon === -1 ? id : id.slice(0, colon);
    var arg = colon === -1 ? '' : id.slice(colon + 1);
    if (kind === 'sort') {
        n.sort = d.sort;
        n.order = d.order;
        n.seed = 0;
    } else if (kind === 'tag') {
        n.tags = n.tags.filter(function (t) { return t !== arg; });
    } else if (kind === 'tagAll') {
        n.tagAll = false;
    } else if (kind === 'quick') {
        n.quick = n.quick.filter(function (q) { return q.group + SEP + q.tag !== arg; });
    } else if (kind === 'person') {
        n.people = n.people.filter(function (p) { return p.id !== arg; });
        if (!n.people.length) {
            n.roles = [];
            n.peopleAll = false;
        }
    } else if (kind === 'peopleAll') {
        n.peopleAll = false;
    } else if (kind === 'studio') {
        n.studios = n.studios.filter(function (p) { return p.id !== arg; });
    } else if (kind === 'runtime') {
        n.minRuntime = null;
        n.maxRuntime = null;
    } else if (kind === 'added') {
        n.added = 'any';
        n.addedFrom = '';
        n.addedTo = '';
    } else if (kind === 'res') {
        n.res = [];
    } else if (kind === 'played') {
        n.played = 'any';
    } else if (kind === 'favorites') {
        n.favorites = false;
    } else if (kind === 'type') {
        n.type = 'all';
    }

    return n;
}

/* ---- the serialiser ---- */

// The search page's /Items requests: the path ends in /Items and a searchTerm rides along.
var IS_ITEMS = /\/items$/i;
var HAS_TERM = /[?&]searchterm=[^&]/i;
var IS_VIDEO_QUERY = /[?&]mediatypes=video(&|$|,)/i;

/*
 * Which of the page's two /Items queries a URL is, and what the Type filter does to it.
 *   'normal'  carries the filters (plus, for Movies/Episodes, an includeItemTypes narrowing)
 *   'discard' its result is not shown: cut down to a one-item stock request
 */
export function typePlan(type, isVideoQuery) {
    if (type === 'videos') {
        return isVideoQuery ? { mode: 'normal' } : { mode: 'discard', include: 'Video' };
    }

    if (type === 'movies' || type === 'episodes') {
        var kind = type === 'movies' ? 'Movie' : 'Episode';
        return isVideoQuery ? { mode: 'discard', include: kind } : { mode: 'normal', include: kind };
    }

    return { mode: 'normal' };
}

/* The [key, value] pairs for a normal (filtered) request, in a stable order. */
export function filterPairs(s, now) {
    var p = [];
    if (s.sort !== 'relevance') {
        p.push(['sortBy', s.sort]);
        var info = sortInfo(s.sort);
        if (s.sort === 'Random') {
            if (s.seed > 0) {
                p.push(['jpSeed', String(s.seed)]);
            }
        } else if (info.order) {
            p.push(['sortOrder', s.order]);
        }
    }

    if (s.played !== 'any') {
        p.push(['isPlayed', s.played === 'played' ? 'true' : 'false']);
    }

    if (s.favorites) {
        p.push(['isFavorite', 'true']);
    }

    if (s.tags.length) {
        p.push(['tags', s.tags.join('|')]);
        if (s.tagAll && s.tags.length > 1) {
            p.push(['tagMatch', 'all']);
        }
    }

    anyOfValues(s.quick).forEach(function (v) { p.push(['jpTagAnyOf', v]); });

    if (s.people.length) {
        p.push(['personIds', s.people.map(function (x) { return x.id; }).join(',')]);
        if (activeRoles(s).length) {
            p.push(['personTypes', s.roles.join(',')]);
        }

        if (matchAllPeople(s)) {
            p.push(['jpPersonMatch', 'all']);
        }
    }

    if (s.studios.length) {
        p.push(['studioIds', s.studios.map(function (x) { return x.id; }).join(',')]);
    }

    if (s.minRuntime !== null) {
        p.push(['jpMinRuntime', String(s.minRuntime)]);
    }

    if (s.maxRuntime !== null) {
        p.push(['jpMaxRuntime', String(s.maxRuntime)]);
    }

    var added = addedRange(s, now);
    if (added.from) {
        p.push(['jpMinDateAdded', added.from]);
    }

    if (added.to) {
        p.push(['jpMaxDateAdded', added.to]);
    }

    var res = activeRes(s);
    if (res.length) {
        p.push(['jpResolution', res.join(',')]);
    }

    return p;
}

// Every parameter this module may write: removed from the URL first so a value is never doubled.
var OWNED = [
    'sortby', 'sortorder', 'jpseed', 'isplayed', 'isfavorite', 'tags', 'tagmatch', 'personids',
    'persontypes', 'jppersonmatch', 'studioids', 'jpminruntime', 'jpmaxruntime', 'jpmindateadded', 'jpmaxdateadded', 'jpresolution', 'jptaganyof'
];

function keyOf(piece) {
    var eq = piece.indexOf('=');
    try {
        return decodeURIComponent(eq === -1 ? piece : piece.slice(0, eq)).toLowerCase();
    } catch (e) {
        return piece.toLowerCase();
    }
}

/*
 * Applies the state to one outgoing URL. Anything that is not a search /Items request, and any
 * state with nothing active, comes back as the very same string. `now` is injectable for tests.
 */
export function rewriteSearchUrl(url, state, now) {
    if (typeof url !== 'string' || url.indexOf('?') === -1 || !IS_ITEMS.test(url.split('?')[0])
        || !HAS_TERM.test(url)) {
        return url;
    }

    var s = normalizeState(state);
    if (!chipsOf(s).length) {
        return url;
    }

    var q = url.indexOf('?');
    var base = url.slice(0, q);
    var rest = url.slice(q + 1);
    var hash = '';
    var h = rest.indexOf('#');
    if (h !== -1) {
        hash = rest.slice(h);
        rest = rest.slice(0, h);
    }

    var plan = typePlan(s.type, IS_VIDEO_QUERY.test(url));
    var drop = OWNED.slice();
    var add = [];
    if (plan.mode === 'discard') {
        // A stock one-item request: no filters, no sort, the cheap candidate pool.
        add.push(['includeItemTypes', plan.include], ['limit', '1']);
        drop.push('includeitemtypes', 'limit');
    } else {
        add = filterPairs(s, now);
        if (plan.include) {
            add.push(['includeItemTypes', plan.include]);
            drop.push('includeitemtypes');
        }
    }

    var kept = rest.split('&').filter(function (piece) {
        return piece !== '' && drop.indexOf(keyOf(piece)) === -1;
    });
    var pieces = kept.concat(add.map(function (kv) {
        return kv[0] + '=' + encodeURIComponent(kv[1]);
    }));
    return base + '?' + pieces.join('&') + hash;
}

/* ---- the Cast & Crew facet list: who appears in THESE search results ---- */

var FACET_TYPE = { videos: 'Video', movies: 'Movie', episodes: 'Episode' };

/*
 * The query string pairs for GET /JellyfinPlus/Search/Facets (src/SearchFacetsController.cs), apart
 * from userId, kind, q and limit. It is the committed search term plus the committed filters,
 * EXCEPT the cast filter itself (people, roles, any/all) and the sort: a facet ignores its own
 * filter, or picking one person would shrink the list to that person's co-stars, and sort changes
 * nothing about who appears. `exclude` is the search page's exclude-tags text.
 */
export function facetPairs(state, term, parentId, exclude, now) {
    var s = normalizeState(state);
    s.sort = 'relevance';
    s.seed = 0;
    s.people = [];
    s.roles = [];
    s.peopleAll = false;
    var p = [['searchTerm', String(term || '')]];
    if (parentId) {
        p.push(['parentId', parentId]);
    }

    if (FACET_TYPE[s.type]) {
        p.push(['includeItemTypes', FACET_TYPE[s.type]]);
    }

    filterPairs(s, now).forEach(function (kv) { p.push(kv); });
    var ex = typeof exclude === 'string' ? exclude.trim() : '';
    if (ex) {
        p.push(['excludeTags', ex]);
    }

    return p;
}

/* A cache key for one facet request: identical for identical term + filters, and only then. */
export function facetKey(pairs, q) {
    return pairs.map(function (kv) { return kv[0] + '=' + kv[1]; }).join('&') + '|' + (q || '');
}

/* Case-insensitive substring filter of a facet list by name (empty needle keeps everything). */
export function filterFacets(list, needle) {
    var n = String(needle || '').trim().toLowerCase();
    if (!n) {
        return list.slice();
    }

    return list.filter(function (f) { return f.name.toLowerCase().indexOf(n) !== -1; });
}

/*
 * The rows of the Cast & Crew checklist: [{ id, name, count, picked }]. People already picked stay
 * visible even when they are not in the facet list (count null), listed first; the rest follow in
 * the server's order (count descending, then name). `needle` narrows both.
 */
export function facetRows(list, picked, needle) {
    var inList = {};
    list.forEach(function (f) { inList[f.id] = true; });
    var pickedIds = {};
    picked.forEach(function (p) { pickedIds[p.id] = true; });
    var extra = filterFacets(picked.filter(function (p) { return !inList[p.id]; }).map(function (p) {
        return { id: p.id, name: p.name, count: null, roles: [] };
    }), needle);
    return extra.concat(filterFacets(list, needle)).map(function (f) {
        return { id: f.id, name: f.name, count: typeof f.count === 'number' ? f.count : null, picked: !!pickedIds[f.id] };
    });
}

/* "Name · 12", or just the name when the count is unknown. */
export function facetText(row) {
    return typeof row.count === 'number' ? row.name + ' · ' + row.count : row.name;
}

/*
 * The role values to offer as pills: those that occur among the listed people, in ROLES order, plus
 * any already selected (so a saved choice never vanishes). With no list (nothing loaded, or no
 * search term) there is no information, so every role is offered.
 */
export function offeredRoles(list, selected) {
    if (!list) {
        return ROLES.map(function (r) { return r.value; });
    }

    var seen = {};
    list.forEach(function (f) { (f.roles || []).forEach(function (r) { seen[r] = true; }); });
    return ROLES.map(function (r) { return r.value; }).filter(function (v) {
        return seen[v] || (selected || []).indexOf(v) !== -1;
    });
}

/* A response row (lower- or Pascal-case, per whichever serialiser answered) as { id, name, roles, count }, or null. */
export function normalizeFacet(raw) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    var id = raw.id !== undefined ? raw.id : raw.Id;
    var name = raw.name !== undefined ? raw.name : raw.Name;
    var roles = raw.roles !== undefined ? raw.roles : raw.Roles;
    var count = raw.count !== undefined ? raw.count : raw.Count;
    if (typeof id !== 'string' || !GUID_RE.test(id) || typeof name !== 'string' || !name) {
        return null;
    }

    return {
        id: id,
        name: name,
        roles: Array.isArray(roles) ? roles.filter(function (r) { return typeof r === 'string'; }) : [],
        count: typeof count === 'number' && isFinite(count) ? count : 0
    };
}
