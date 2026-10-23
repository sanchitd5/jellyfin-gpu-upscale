/*
 * DATE ADDED RANGE FOR A LIBRARY TAB, PURE PART. No DOM, no network: runs under node (date-added.test.mjs).
 *
 * The choice rides in the tab's Filters.Tags as one marker (model/library-filter-marks.js, kind `d`)
 * whose payload is this module's encoded form:
 *
 *   a preset id            `today` `7d` `30d` `90d` `ytd`     -> relative: the range is worked out when
 *                                                                the REQUEST is built, so "Last 7 days" rolls
 *   `c:<from>~<to>`        fixed days, either side may be empty   (YYYY-MM-DD)
 *
 * Days are UTC days, inclusive ("Last N days" = today plus the N-1 before it), exactly the server's contract (jpMinDateAdded / jpMaxDateAdded in
 * src/patcher/LibraryFilterPatches.cs). Anything unreadable decodes to null = no date filter.
 */

export var PRESETS = [
    { value: 'any', label: 'Any time' },
    { value: 'today', label: 'Today', days: 0 },
    { value: '7d', label: 'Last 7 days', days: 7 },
    { value: '30d', label: 'Last 30 days', days: 30 },
    { value: '90d', label: 'Last 90 days', days: 90 },
    { value: 'ytd', label: 'This year' }
];

var DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad(n) {
    return (n < 10 ? '0' : '') + n;
}

/* YYYY-MM-DD of a Date, in UTC. */
export function utcDay(date) {
    return date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate());
}

/* A real calendar day in YYYY-MM-DD form (2026-02-30 is not one). */
export function validDay(s) {
    var m = typeof s === 'string' ? DAY_RE.exec(s) : null;
    if (!m) {
        return false;
    }

    return utcDay(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))) === s;
}

function presetOf(id) {
    for (var i = 0; i < PRESETS.length; i++) {
        if (PRESETS[i].value === id && id !== 'any') {
            return PRESETS[i];
        }
    }

    return null;
}

/* A state or stored string -> { kind:'preset', id } | { kind:'custom', from, to } | null. Never throws. */
export function normalize(x) {
    if (typeof x === 'string') {
        return decode(x);
    }

    if (!x || typeof x !== 'object') {
        return null;
    }

    if (x.kind === 'preset') {
        return presetOf(x.id) ? { kind: 'preset', id: x.id } : null;
    }

    if (x.kind === 'custom') {
        var from = validDay(x.from) ? x.from : '';
        var to = validDay(x.to) ? x.to : '';
        if (!from && !to) {
            return null;
        }

        if (from && to && from > to) {
            var t = from;
            from = to;
            to = t;
        }

        return { kind: 'custom', from: from, to: to };
    }

    return null;
}

/* The stored string -> a state, or null. */
export function decode(raw) {
    if (typeof raw !== 'string' || !raw) {
        return null;
    }

    if (raw.indexOf('c:') === 0) {
        var parts = raw.slice(2).split('~');
        return parts.length === 2 ? normalize({ kind: 'custom', from: parts[0], to: parts[1] }) : null;
    }

    return presetOf(raw) ? { kind: 'preset', id: raw } : null;
}

/* A state -> the stored string; '' for "no filter". */
export function encode(state) {
    var s = normalize(state);
    if (!s) {
        return '';
    }

    return s.kind === 'preset' ? s.id : 'c:' + s.from + '~' + s.to;
}

/* The bounds the state means at `now`: { from, to } as YYYY-MM-DD or ''. Relative presets move with `now`. */
export function rangeOf(state, now) {
    var s = normalize(state);
    if (!s) {
        return { from: '', to: '' };
    }

    if (s.kind === 'custom') {
        return { from: s.from, to: s.to };
    }

    var at = now || new Date();
    if (s.id === 'ytd') {
        return { from: at.getUTCFullYear() + '-01-01', to: '' };
    }

    return { from: utcDay(new Date(at.getTime() - Math.max(0, presetOf(s.id).days - 1) * 86400000)), to: '' };
}

function dayText(day, withYear) {
    var m = DAY_RE.exec(day);
    return (+m[3]) + ' ' + MONTHS[+m[2] - 1] + (withYear ? ' ' + m[1] : '');
}

/* The chip text: the preset's name, or "1 Oct – 15 Oct" (years shown when not this year / when they differ). */
export function labelOf(state, now) {
    var s = normalize(state);
    if (!s) {
        return 'Date';
    }

    if (s.kind === 'preset') {
        return presetOf(s.id).label;
    }

    var year = String((now || new Date()).getUTCFullYear());
    var fy = s.from ? s.from.slice(0, 4) : '';
    var ty = s.to ? s.to.slice(0, 4) : '';
    var years = (s.from && s.to && fy !== ty) || (fy && fy !== year) || (ty && ty !== year);
    if (s.from && s.to) {
        return s.from === s.to ? dayText(s.from, years) : dayText(s.from, years) + ' – ' + dayText(s.to, years);
    }

    return s.from ? 'From ' + dayText(s.from, years) : 'Until ' + dayText(s.to, years);
}

/* The request parameters for a state: [] or [['jpMinDateAdded', day], ['jpMaxDateAdded', day]]. */
export function paramPairs(state, now) {
    var r = rangeOf(state, now);
    var out = [];
    if (r.from) {
        out.push(['jpMinDateAdded', r.from]);
    }

    if (r.to) {
        out.push(['jpMaxDateAdded', r.to]);
    }

    return out;
}
