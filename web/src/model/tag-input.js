import { parseTags, mergeTags } from '../controller/bulk-tags.js';

/*
 * TAG INPUT IN THE METADATA EDITOR: THE PURE PART (controller/tag-autocomplete.js is the DOM side).
 *
 * Normalising is not redone here: parseTags (split on commas and newlines, trim, drop blanks and
 * case-insensitive repeats) and mergeTags (a tag already present, in any case, is not added again
 * and the stored spelling wins) are the bulk tag editor's own, so a tag typed in the metadata
 * editor and one added in bulk end up identical.
 */

/* The tag being typed: what follows the last comma or newline, trimmed. */
export function currentToken(text) {
    var s = String(text || '');
    var cut = Math.max(s.lastIndexOf(','), s.lastIndexOf('\n'));
    return s.slice(cut + 1).trim();
}

/* The text with the tag being typed replaced by `tag`, ready for the next one. */
export function withToken(text, tag) {
    var done = finishedTags(text);
    return done.concat([tag]).join(', ') + ', ';
}

/* The tags already finished in the text (everything before the one being typed). */
export function finishedTags(text) {
    var s = String(text || '');
    var cut = Math.max(s.lastIndexOf(','), s.lastIndexOf('\n'));
    return cut === -1 ? [] : parseTags(s.slice(0, cut));
}

/*
 * What pressing Add does with `text` when the list already holds `existing`:
 * { add } the new tags in the order typed, { dupes } the typed tags that were already in the list.
 */
export function planAdd(text, existing) {
    var typed = parseTags(text);
    var merged = mergeTags(existing, typed, []);
    var lower = new Set(merged.added.map(function (t) { return t.toLowerCase(); }));
    return {
        add: merged.added,
        dupes: typed.filter(function (t) { return !lower.has(t.toLowerCase()); })
    };
}

/*
 * The editor's own list order (populateListView): case-insensitive localeCompare. `key` maps an
 * element to the string it is ordered by (the element itself when omitted). Returns a new array.
 */
export function sortLikeEditor(values, key) {
    var k = key || function (v) { return v; };
    return values.slice().sort(function (a, b) {
        return k(a).toLowerCase().localeCompare(k(b).toLowerCase());
    });
}

/*
 * Suggestions for the tag being typed from a server window of matching names: not ones already in
 * the list or already finished in the box, names that start with the token before the others
 * (the server's order is alphabetical, a substring match), at most `max`.
 */
export function pickSuggestions(names, text, existing, max) {
    var token = currentToken(text).toLowerCase();
    if (!token) {
        return [];
    }

    var skip = new Set((existing || []).concat(finishedTags(text)).map(function (t) { return String(t).trim().toLowerCase(); }));
    var starts = [];
    var inside = [];
    (names || []).forEach(function (n) {
        var l = String(n).toLowerCase();
        if (skip.has(l.trim())) {
            return;
        }

        (l.indexOf(token) === 0 ? starts : inside).push(n);
    });
    return starts.concat(inside).slice(0, max);
}
