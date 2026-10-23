import { normalize } from './quick-tags.js';

/*
 * QUICK TAG GROUPS IN THE FILTER MENU, PURE PART (view/library-filter-groups.js draws it). No DOM, no network.
 *
 * A group can have far more chips than a menu section should draw at once (a prefix group lists up to 200
 * tags). `menuChips` decides which to show: with a search query every chip whose label or tag contains it;
 * without one the first COLLAPSED chips, plus every picked chip wherever it sits (a pick never hides), unless
 * the section was expanded with "Show more". A search box is offered once a group has SEARCH_MIN chips.
 */

export var SEARCH_MIN = 12;
export var COLLAPSED = 20;

/* chips: [{ tag, label }] (model/quick-tags.js chipsFor). picked: tag names. Returns { shown, more, total, searchable }. */
export function menuChips(chips, query, expanded, picked) {
    var q = normalize(query || '').trim();
    var total = chips.length;
    var searchable = total >= SEARCH_MIN;
    if (q) {
        return {
            shown: chips.filter(function (c) { return normalize(c.label).indexOf(q) !== -1 || normalize(c.tag).indexOf(q) !== -1; }),
            more: 0, total: total, searchable: searchable
        };
    }

    if (expanded || total <= COLLAPSED) {
        return { shown: chips, more: 0, total: total, searchable: searchable };
    }

    var shown = chips.filter(function (c, i) { return i < COLLAPSED || (picked || []).indexOf(c.tag) !== -1; });
    return { shown: shown, more: total - shown.length, total: total, searchable: searchable };
}

/* The section header's count of picked tags: "" for none. */
export function pickedLabel(n) {
    return n > 0 ? String(n) : '';
}
