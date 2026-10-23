/*
 * QUICK TAG-FILTER GROUPS, PURE PART. No DOM, no network: runs under node (quick-tags.test.mjs).
 *
 * Each viewer keeps their own groups (localStorage `jellyfinPlus.quickTags`, mirrored to the server by
 * controller/prefs-sync.js) and edits them in the client (view/quick-tags-editor.js). A group is either a fixed tag list or a PREFIX: every tag
 * that starts with it is a chip, labelled with what follows the prefix. Picked chips of one group
 * combine with OR, different groups with AND, and a group with nothing picked adds no condition.
 * On the wire that is one `jpTagAnyOf` parameter per group that has a pick, its value the picked tag
 * names joined by `|` (src/patcher/LibraryFilterPatches.cs, ParseTagAnyOf). No tag name is baked in
 * anywhere in this client: names come from what the viewer picks out of the server's tag list.
 */

export var MAX_GROUPS = 10;
export var MAX_NAMES = 100;
export var MAX_LEN = 200;

/* Separates a group name from a tag inside one stored/marker string. Never part of a real name. */
export var SEP = '\u0003';

/* Case- and diacritic-insensitive, like the server's clean value. */
export function normalize(s) {
    try {
        return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    } catch (e) {
        return String(s).toLowerCase();
    }
}

/* A tag the `|`-separated wire value can carry exactly. */
export function usableTag(t) {
    return typeof t === 'string' && t.length > 0 && t.length <= MAX_LEN && t.indexOf('|') === -1
        && t.indexOf(SEP) === -1 && t.indexOf('\u0001') === -1 && t.indexOf('\u0002') === -1;
}

function field(o, a, b) {
    return o[a] !== undefined ? o[a] : o[b];
}

/* Anything the server (or a hand-edited cache) sent -> a well-formed [{name, tags, prefix}], at most MAX_GROUPS. */
export function parseGroups(raw) {
    var out = [];
    var seen = {};
    (Array.isArray(raw) ? raw : []).forEach(function (g) {
        if (!g || typeof g !== 'object' || out.length >= MAX_GROUPS) {
            return;
        }

        var name = String(field(g, 'name', 'Name') || '').replace(/[\u0001-\u0003]/g, '').trim();
        var prefix = String(field(g, 'prefix', 'Prefix') || '').trim();
        var tagList = field(g, 'tags', 'Tags');
        var tags = [];
        (Array.isArray(tagList) ? tagList : []).forEach(function (t) {
            var v = typeof t === 'string' ? t.trim() : '';
            if (usableTag(v) && tags.indexOf(v) === -1 && tags.length < MAX_NAMES) {
                tags.push(v);
            }
        });
        if (prefix.length > MAX_LEN) {
            prefix = '';
        }

        if (!name || name.length > 100 || seen[name] || (!tags.length && !prefix)) {
            return;
        }

        seen[name] = true;
        out.push({ name: name, tags: tags, prefix: prefix });
    });
    return out;
}

/* Does `tag` start with `prefix` (case- and diacritic-insensitive)? An empty prefix matches nothing. */
export function startsWithPrefix(tag, prefix) {
    var p = normalize(prefix).trim();
    return p.length > 0 && normalize(tag).indexOf(p) === 0;
}

/* The chip label for a prefix group's tag: the remainder, minus separators that only glued it on. */
export function labelFor(tag, prefix) {
    var p = String(prefix || '').trim();
    if (!startsWithPrefix(tag, p)) {
        return tag;
    }

    // NFD can change string length; the prefix and tag normalise together, so cut by the same count
    // only when the lengths agree, otherwise show the whole tag rather than a wrong slice.
    if (normalize(tag.slice(0, p.length)) !== normalize(p)) {
        return tag;
    }

    var rest = tag.slice(p.length).replace(/^[\s\-_:.\/]+/, '').trim();
    return rest || tag;
}

function byLabel(a, b) {
    return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
}

/*
 * The chips of one group: [{ tag, label }]. A fixed group lists its tags in the configured order. A
 * prefix group lists `names` (the tag names the server returned for the prefix) that really START with
 * it, label order. `selected` tag names that are not listed are appended, so a saved pick never
 * vanishes from the row.
 */
export function chipsFor(group, names, selected) {
    var out = [];
    var seen = {};
    var add = function (tag, label) {
        if (usableTag(tag) && !seen[tag]) {
            seen[tag] = true;
            out.push({ tag: tag, label: label });
        }
    };
    if (group.tags.length) {
        group.tags.forEach(function (t) { add(t, group.prefix ? labelFor(t, group.prefix) : t); });
    } else {
        var found = [];
        (names || []).forEach(function (t) {
            if (typeof t === 'string' && startsWithPrefix(t, group.prefix) && usableTag(t) && !seen[t]) {
                seen[t] = true;
                found.push({ tag: t, label: labelFor(t, group.prefix) });
            }
        });
        found.sort(byLabel);
        out = found;
    }

    (selected || []).forEach(function (t) {
        add(t, group.prefix ? labelFor(t, group.prefix) : t);
    });
    return out;
}

/* ---- the viewer's own groups: stored form, limits, editing ---- */

export var STORE_KEY = 'jellyfinPlus.quickTags';
// The editor's per-group tag cap (the wire allows MAX_NAMES) and the largest stored string: it syncs to
// the server as one DisplayPreferences.CustomPrefs value, which model/prefs-sync.js limits to 20000.
export var MAX_EDIT_TAGS = 30;
export var MAX_STORED = 14000;

/* Compact stored form: [{n: name, t: [tags], p: prefix}]. */
export function encodeGroups(groups) {
    return JSON.stringify(parseGroups(groups).map(function (g) {
        return g.tags.length ? (g.prefix ? { n: g.name, t: g.tags, p: g.prefix } : { n: g.name, t: g.tags }) : { n: g.name, p: g.prefix };
    }));
}

/* The stored string (or null/garbage) -> well-formed groups. Never throws. */
export function decodeGroups(raw) {
    try {
        var a = JSON.parse(raw);
        return parseGroups((Array.isArray(a) ? a : []).map(function (g) {
            return g && typeof g === 'object' ? { name: g.n, tags: g.t, prefix: g.p } : null;
        }));
    } catch (e) {
        return [];
    }
}

/* What is wrong with an edited list, as a sentence for the editor, or null when it can be saved. */
export function validateDraft(groups) {
    var seen = {};
    for (var i = 0; i < groups.length; i++) {
        var g = groups[i];
        var name = String(g.name || '').trim();
        if (!name) {
            return 'Every group needs a name.';
        }

        if (seen[name]) {
            return 'Two groups are called "' + name + '". Give each its own name.';
        }

        seen[name] = true;
        if (!(g.tags && g.tags.length) && !String(g.prefix || '').trim()) {
            return 'Group "' + name + '" needs tags or a prefix.';
        }
    }

    if (groups.length > MAX_GROUPS) {
        return 'At most ' + MAX_GROUPS + ' groups.';
    }

    if (encodeGroups(groups).length > MAX_STORED) {
        return 'That is more than can be saved. Remove some tags.';
    }

    return null;
}

/* ---- suggested ("auto") groups from a pluggable source, and the viewer's choices about them ---- */

export var AUTO_KEY = 'jellyfinPlus.quickTagsAuto';
// 50 hidden ids + 50 renames, ids up to 80 characters, names up to 100: under 14000 characters in the worst case.
var MAX_AUTO_PREFS = 50;
var MAX_ID = 80;

/* A source's groups -> [{ name, tags | prefix, id, kind, auto: true }]. Same gate as parseGroups; ids default to `auto:<name>`. */
export function parseSuggested(raw) {
    var out = [];
    var seen = {};
    (Array.isArray(raw) ? raw : []).forEach(function (g) {
        var one = parseGroups([g])[0];
        if (!one) {
            return;
        }

        var id = typeof g.id === 'string' && g.id && g.id.length <= MAX_ID ? g.id : 'auto:' + one.name;
        if (seen[id]) {
            return;
        }

        seen[id] = true;
        one.id = id;
        one.kind = typeof g.kind === 'string' ? g.kind.slice(0, 30) : '';
        one.auto = true;
        out.push(one);
    });
    return out;
}

/* The stored choices: { hidden: [ids], names: { id: renamedName } }, well-formed and capped. Never throws. */
export function decodeAuto(raw) {
    var out = { hidden: [], names: {} };
    try {
        var o = JSON.parse(raw);
        if (!o || typeof o !== 'object') {
            return out;
        }

        (Array.isArray(o.h) ? o.h : []).forEach(function (id) {
            if (typeof id === 'string' && id && id.length <= MAX_ID && out.hidden.indexOf(id) === -1
                && out.hidden.length < MAX_AUTO_PREFS) {
                out.hidden.push(id);
            }
        });
        var n = o.r && typeof o.r === 'object' && !Array.isArray(o.r) ? o.r : {};
        Object.keys(n).slice(0, MAX_AUTO_PREFS).forEach(function (id) {
            var v = typeof n[id] === 'string' ? n[id].replace(/[\u0001-\u0003]/g, '').trim() : '';
            if (id.length <= MAX_ID && v && v.length <= 100) {
                out.names[id] = v;
            }
        });
    } catch (e) { /* unreadable: no choices */ }
    return out;
}

/* null when there is nothing to remember (the key is then removed). */
export function encodeAuto(prefs) {
    var h = (prefs.hidden || []).slice(0, MAX_AUTO_PREFS);
    var r = prefs.names || {};
    if (!h.length && !Object.keys(r).length) {
        return null;
    }

    var o = {};
    if (h.length) { o.h = h; }
    if (Object.keys(r).length) { o.r = r; }
    return JSON.stringify(o);
}

/*
 * The viewer's groups plus the suggested ones, with the viewer's choices applied: renamed ids take their
 * new name, hidden ids are left out of `visible`, and a suggestion whose name equals one the viewer
 * already has (or an earlier suggestion's) is dropped, so a group name is unique and a pick can be keyed
 * by it. `all` keeps hidden suggestions (flagged) for the editor. Returns { visible, all }.
 */
export function mergeGroups(user, suggested, prefs) {
    var names = {};
    user.forEach(function (g) { names[g.name] = true; });
    var all = [];
    (suggested || []).forEach(function (g) {
        var name = prefs.names[g.id] || g.name;
        if (names[name]) {
            return;
        }

        names[name] = true;
        all.push(Object.assign({}, g, { name: name, original: g.name, hidden: prefs.hidden.indexOf(g.id) !== -1 }));
    });
    // Capped at MAX_GROUPS (own first): anyOfValues and the server take no more, so a pick in a cut group would show pressed and never filter.
    return { visible: user.concat(all.filter(function (g) { return !g.hidden; })).slice(0, MAX_GROUPS), all: all };
}

/* The viewer's list with a suggestion copied in as their own (a name clash gets " (2)", " (3)", ...). Same list when full. */
export function pinSuggestion(user, g) {
    if (user.length >= MAX_GROUPS) {
        return user.slice();
    }

    var name = g.name;
    var n = 2;
    while (user.some(function (u) { return u.name === name; })) {
        name = g.name + ' (' + n++ + ')';
    }

    var copy = g.tags && g.tags.length ? { name: name, tags: g.tags.slice(), prefix: g.prefix || '' } : { name: name, tags: [], prefix: g.prefix };
    return user.concat([copy]);
}

/* A copy of the list with item i moved by dir (-1 up, +1 down); unchanged at the ends. */
export function moveGroup(list, i, dir) {
    var j = i + dir;
    var out = list.slice();
    if (i < 0 || i >= list.length || j < 0 || j >= list.length) {
        return out;
    }

    out[i] = list[j];
    out[j] = list[i];
    return out;
}

/* ---- selections: [{ group, tag }] ---- */

export function isSelected(list, group, tag) {
    return list.some(function (s) { return s.group === group && s.tag === tag; });
}

/* A copy of the selection with (group, tag) switched on or off. */
export function toggleSelection(list, group, tag, on) {
    var rest = list.filter(function (s) { return !(s.group === group && s.tag === tag); });
    if (on && usableTag(tag)) {
        rest.push({ group: group, tag: tag });
    }

    return rest;
}

export function selectedIn(list, group) {
    return list.filter(function (s) { return s.group === group; }).map(function (s) { return s.tag; });
}

/* Drops selections whose group is no longer configured (the owner removed it): nothing invisible may filter. */
export function pruneSelection(list, groups) {
    var names = {};
    groups.forEach(function (g) { names[g.name] = true; });
    return list.filter(function (s) { return names[s.group]; });
}

/*
 * The jpTagAnyOf values for a selection: one string per group that has a pick, picked tags joined by
 * `|`, groups in the order they first appear; at most MAX_GROUPS values of MAX_NAMES names.
 */
export function anyOfValues(list) {
    var order = [];
    var byGroup = {};
    list.forEach(function (s) {
        if (!s || !usableTag(s.tag)) {
            return;
        }

        if (!byGroup[s.group]) {
            byGroup[s.group] = [];
            order.push(s.group);
        }

        if (byGroup[s.group].indexOf(s.tag) === -1 && byGroup[s.group].length < MAX_NAMES) {
            byGroup[s.group].push(s.tag);
        }
    });
    return order.slice(0, MAX_GROUPS).map(function (g) { return byGroup[g].join('|'); });
}
