/*
 * SMART TAG CATEGORIES, PURE PART. No DOM, no network: runs under node (smart-tags.test.mjs).
 *
 * The server derives categories from the tag vocabulary of what the viewer can see
 * (GET /JellyfinPlus/Tags/Categories, src/SmartTagsController.cs):
 *   [{ id, label, kind: 'prefix'|'exclusive'|'popular', prefix?, primary, coverage, tags: [{ name, label, count }] }]
 * This turns that answer into the quick tag groups' suggestion shape (model/quick-tags.js parseSuggested):
 * a prefix family becomes { name, prefix }, an exclusive or popular facet { name, tags[] }. It also finds the
 * item's tag in the PRIMARY facet (the exclusive facet covering the most items) for the card badge.
 * No tag name is baked in anywhere: every name comes from the server's answer.
 */

/* Case- and diacritic-insensitive, like the server's clean value. */
function norm(s) {
    try {
        return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    } catch (e) {
        return String(s).toLowerCase().trim();
    }
}

function str(v) {
    return typeof v === 'string' ? v : '';
}

/* Anything the route (or a stale cache) sent -> well-formed categories. Never throws. */
export function parseCategories(raw) {
    var out = [];
    (Array.isArray(raw) ? raw : []).forEach(function (c) {
        if (!c || typeof c !== 'object') {
            return;
        }

        var tags = [];
        (Array.isArray(c.tags) ? c.tags : []).forEach(function (t) {
            var name = t && str(t.name).trim();
            if (name) {
                tags.push({ name: name, label: str(t.label).trim() || name, count: Number(t.count) || 0 });
            }
        });
        var kind = str(c.kind);
        var prefix = kind === 'prefix' ? str(c.prefix).trim() : '';
        var label = str(c.label).trim();
        if (!label || (!tags.length && !prefix) || (kind === 'prefix' && !prefix)) {
            return;
        }

        out.push({
            id: str(c.id) || kind + ':' + label,
            label: label,
            kind: kind,
            prefix: prefix,
            primary: c.primary === true,
            coverage: Number(c.coverage) || 0,
            tags: tags
        });
    });
    return out;
}

/* Categories -> quick tag group suggestions: [{ id, name, kind, prefix } | { id, name, kind, tags }]. */
export function toGroups(categories) {
    return parseCategories(categories).map(function (c) {
        return c.kind === 'prefix'
            ? { id: 'smart:' + c.id, name: c.label, kind: c.kind, prefix: c.prefix, tags: c.tags.map(function (t) { return t.name; }) }
            : { id: 'smart:' + c.id, name: c.label, kind: c.kind, tags: c.tags.map(function (t) { return t.name; }) };
    });
}

/* The primary facet (flagged by the server; only an exclusive facet can be), or null. */
export function primaryFacet(categories) {
    var list = parseCategories(categories);
    for (var i = 0; i < list.length; i++) {
        if (list[i].primary && list[i].kind === 'exclusive' && list[i].tags.length) {
            return list[i];
        }
    }

    return null;
}

/*
 * The item's tag from the primary facet, labelled for display: { name, label }, or null when there is no
 * primary facet or the item carries none of its tags. A prefix family's label is the remainder (the server
 * already strips it). When an item carries several (a facet is NEAR-exclusive), the facet's larger tag wins.
 */
export function primaryTagOf(itemTags, categories) {
    var facet = categories && categories.__primary !== undefined ? categories.__primary : primaryFacet(categories);
    if (!facet || !Array.isArray(itemTags) || !itemTags.length) {
        return null;
    }

    var have = {};
    itemTags.forEach(function (t) {
        if (typeof t === 'string' && t.trim()) {
            have[norm(t)] = true;
        }
    });
    for (var i = 0; i < facet.tags.length; i++) {
        if (have[norm(facet.tags[i].name)]) {
            return { name: facet.tags[i].name, label: facet.tags[i].label };
        }
    }

    return null;
}

/* The library a page shows, from its hash route (`#/list?parentId=..`, `topParentId=..`): the categories' scope. '' when none. */
export function scopeFromHash(hash) {
    var q = String(hash || '');
    var at = q.indexOf('?');
    if (at < 0) {
        return '';
    }

    var params = q.slice(at + 1).split('&');
    var found = { parentid: '', topparentid: '' };
    params.forEach(function (p) {
        var eq = p.indexOf('=');
        var k = (eq < 0 ? p : p.slice(0, eq)).toLowerCase();
        if (k in found && !found[k]) {
            try {
                found[k] = decodeURIComponent(eq < 0 ? '' : p.slice(eq + 1));
            } catch (e) { /* malformed: ignored */ }
        }
    });
    var id = found.parentid || found.topparentid;
    return /^[0-9a-fA-F-]{32,36}$/.test(id) ? id.replace(/-/g, '').toLowerCase() : '';
}

/* The categories with their primary facet resolved once, for many primaryTagOf calls (the card badges). */
export function withPrimary(categories) {
    var list = parseCategories(categories);
    list.__primary = primaryFacet(list);
    return list;
}
