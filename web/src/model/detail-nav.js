/*
 * PREVIOUS / NEXT ON A DETAILS PAGE: THE PURE PART (controller/detail-nav.js is the DOM side).
 *
 * When a card on a list is opened, the ids of the cards around it, in the order the viewer saw them,
 * are kept in sessionStorage together with the page they came from. On a details page the current
 * item is looked up in that list; previous and next are its neighbours. An item that is not in the
 * list gets no buttons: the list is the context, and nothing is guessed outside it.
 */

export var STORAGE_KEY = 'jellyfinPlus.detailNav';

// Ids kept per list. Each is 32 characters, so this bounds the stored value at about 35 KB.
export var MAX_IDS = 1000;

var HEX32 = /^[0-9a-f]{32}$/;

/* An item id the way the list stores it: lower case, no dashes. */
export function normId(id) {
    return String(id == null ? '' : id).replace(/-/g, '').toLowerCase();
}

/*
 * `entries` is the cards of one list in page order: an id for each card that is in the DOM, and
 * null where cards are missing (the virtualised search results evict far-away chunks). Only a run
 * of cards with no gap is trusted to be consecutive, so the result is the run that holds `id`:
 * normalised, de-duplicated (first occurrence wins), and at most MAX_IDS long, centred on `id`.
 * [] when `id` is not in any run.
 */
export function runAround(entries, id) {
    var want = normId(id);
    var run = [];
    var inRun = new Set();
    var found = false;
    var best = [];

    function close() {
        if (found) {
            best = run;
        }

        run = [];
        inRun = new Set();
        found = false;
    }

    (entries || []).forEach(function (e) {
        if (e == null) {
            close();
            return;
        }

        var n = normId(e);
        if (!HEX32.test(n)) {
            close();
            return;
        }

        if (!inRun.has(n)) {
            inRun.add(n);
            run.push(n);
        }

        if (n === want) {
            found = true;
        }
    });
    close();

    var at = best.indexOf(want);
    if (at === -1) {
        return [];
    }

    if (best.length > MAX_IDS) {
        var start = Math.max(0, Math.min(at - Math.floor(MAX_IDS / 2), best.length - MAX_IDS));
        best = best.slice(start, start + MAX_IDS);
    }

    return best;
}

/* { index, total, prev, next } for `id` in `ids`, or null when it is not there. prev/next may be null. */
export function neighbours(ids, id) {
    if (!Array.isArray(ids)) {
        return null;
    }

    var n = normId(id);
    var i = ids.indexOf(n);
    if (i === -1) {
        return null;
    }

    return {
        index: i,
        total: ids.length,
        prev: i > 0 ? ids[i - 1] : null,
        next: i < ids.length - 1 ? ids[i + 1] : null
    };
}

export function encode(src, ids) {
    return JSON.stringify({ v: 1, src: String(src || ''), ids: ids });
}

/* The stored value back, or null for anything that is not exactly what encode() wrote. */
export function decode(raw) {
    try {
        var o = JSON.parse(raw);
        if (!o || o.v !== 1 || !Array.isArray(o.ids) || o.ids.length > MAX_IDS || typeof o.src !== 'string') {
            return null;
        }

        for (var i = 0; i < o.ids.length; i++) {
            if (typeof o.ids[i] !== 'string' || !HEX32.test(o.ids[i])) {
                return null;
            }
        }

        return { src: o.src, ids: o.ids };
    } catch (e) {
        return null;
    }
}

/* The details route for an item, in the form a card's own link uses. */
export function detailHref(id, serverId) {
    return '#/details?id=' + normId(id) + (serverId ? '&serverId=' + encodeURIComponent(serverId) : '');
}
