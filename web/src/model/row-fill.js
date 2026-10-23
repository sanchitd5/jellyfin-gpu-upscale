/*
 * ROW ALIGNMENT FOR APPENDED CARDS, AS PURE FUNCTIONS (no DOM; row-fill.test.mjs runs them under node).
 *
 * Infinite scroll appends cards after a grid jellyfin-web already drew, in `.jpChunk` wrappers that
 * each start on a fresh line. Unless every wrapper holds a whole number of rows, the row before a
 * wrapper is short and leaves a gap. So: chunks are whole rows, the few cards that close the stock
 * grid's last row are drawn straight into the container (a "head"), and a remainder that does not
 * fill a row is carried to the next fetch (shown for good only when the list is over).
 */

/* Columns of a grid, from its computed `grid-template-columns` (a list of resolved track sizes). */
export function columnsFromTemplate(template) {
    var s = String(template || '').trim();
    if (!s || s === 'none') {
        return 0;
    }

    return s.split(/\s+/).length;
}

/* Columns of a wrapping flex row: how many cards of `cardWidth` fit in `inner`. 0 when unmeasurable. */
export function columnsFromWidths(inner, cardWidth) {
    if (!(inner > 0 && cardWidth > 0)) {
        return 0;
    }

    // The epsilon absorbs 16.6667% widths adding up to a hair under the container.
    return Math.max(1, Math.floor(inner / cardWidth + 0.01));
}

/* A chunk's size: whole rows, about `target` cards. */
export function chunkSize(cols, target) {
    var c = Math.max(1, cols | 0);
    return c * Math.max(1, Math.ceil(target / c));
}

/* Cards that close a last row holding `existing` cards. */
export function headCount(existing, cols) {
    var c = Math.max(1, cols | 0);
    var r = existing % c;
    return r ? c - r : 0;
}

/*
 * Plans the appended cards. `pool` = carried items followed by new ones. `headNeeded` is what is
 * still owed to the stock grid's last row (0 once paid). Returns { head, chunks, carry, headLeft }:
 * `head` closes the stock row; `chunks` are whole-row runs of at most `size`; `carry` is less than
 * one row, kept for the next fetch unless `flush` (list over), which turns it into a final short chunk.
 */
export function planRows(pool, cols, size, headNeeded, flush) {
    var c = Math.max(1, cols | 0);
    var head = pool.slice(0, headNeeded);
    var rest = pool.slice(head.length);
    var headLeft = headNeeded - head.length;
    if (headLeft > 0) {
        // Not enough items to close the row: nothing else can be placed either.
        return { head: head, chunks: [], carry: [], headLeft: headLeft };
    }

    var chunks = [];
    var whole = rest.length - (rest.length % c);
    for (var i = 0; i < whole; i += size) {
        chunks.push(rest.slice(i, Math.min(i + size, whole)));
    }

    var carry = rest.slice(whole);
    if (flush && carry.length) {
        chunks.push(carry);
        carry = [];
    }

    return { head: head, chunks: chunks, carry: carry, headLeft: 0 };
}
