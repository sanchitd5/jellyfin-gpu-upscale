import { log } from '../lib/log.js';
import { watchDetail } from './detail-page.js';
import { STORAGE_KEY, runAround, neighbours, encode, decode, detailHref } from '../model/detail-nav.js';

/*
 * PREVIOUS / NEXT CLIP ON THE DETAILS PAGE (QOL_IDEAS #23).
 *
 * Walking through a tag's clips otherwise means going back to the list after every one. Stock has
 * no notion of "the list I came from" (only renderNextUp for a Series), so this keeps one:
 *
 *  - CAPTURE. A click that opens an item from a card or a list row (the stock handler's own test:
 *    the nearest .itemAction, or the nearest element with data-action, says "link") stores, in
 *    sessionStorage, the ids of the cards in that card's items container in page order, plus the
 *    route the list is on (src). It is a capture-phase listener, so it runs before jellyfin's
 *    handler stops the event, and it never prevents or stops anything.
 *  - USE. On a details page the item is looked up in the stored ids. If it is there, previous and
 *    next buttons appear in the button row (cloned from the stock Replay button so they look and
 *    focus like the rest) and each goes to the neighbour's details route, exactly as a card link
 *    would. If it is not there - another list, a deep link, a reload in a new tab - nothing is added.
 *
 * What the list is: the cards that are in the DOM when the card is clicked. A paged list therefore
 * gives the current page, and the infinite or virtualised search results give the gap-free run of
 * cards around the click (evicted chunks are gaps, see model/detail-nav.js). Past either end there
 * is no button rather than a guess. The "More like this", cast, collections and additional-parts
 * rows on a details page are not lists to walk through and are never captured.
 *
 * Fail soft: no storage, no Replay button to copy, or an odd page means no buttons, never an error
 * in the page. TV layouts are untouched (the D-pad has its own flow).
 */

var NAV_CLASS = 'jpNavBtn';

// Rows on a details page that hold recommendations or credits, not a list in the viewer's order.
var NOT_A_LIST = '#similarCollapsible, #castCollapsible, #guestCastCollapsible, #collectionsCollapsible, #additionalPartsCollapsible';

function isTv() {
    return document.documentElement.classList.contains('layout-tv');
}

function readContext() {
    try {
        return decode(window.sessionStorage.getItem(STORAGE_KEY));
    } catch (e) {
        return null;
    }
}

function writeContext(src, ids) {
    try {
        window.sessionStorage.setItem(STORAGE_KEY, encode(src, ids));
        return true;
    } catch (e) {
        return false;
    }
}

/* What the stock click handler (components/shortcuts.js onClick) would decide this click does. */
function actionOf(target) {
    var card = target.closest('.itemAction');
    if (!card) {
        return null;
    }

    var action = card.getAttribute('data-action');
    if (!action) {
        var holder = card.closest('[data-action]');
        action = holder ? holder.getAttribute('data-action') : null;
    }

    return action;
}

function capture(e) {
    try {
        var target = e.target;
        if (isTv() || !target || !target.closest || actionOf(target) !== 'link') {
            return;
        }

        var holder = target.closest('.card[data-id], .listItem[data-id]');
        if (!holder || holder.closest(NOT_A_LIST)) {
            return;
        }

        var container = holder.closest('.itemsContainer') || holder.parentNode;
        var entries = [];
        var nodes = container.querySelectorAll('.card[data-id], .listItem[data-id], .jpChunk[data-evicted]');
        for (var i = 0; i < nodes.length; i++) {
            entries.push(nodes[i].hasAttribute('data-evicted') ? null : nodes[i].getAttribute('data-id'));
        }

        var ids = runAround(entries, holder.getAttribute('data-id'));
        if (ids.length < 2) {
            // Nothing to step to: drop an older list rather than leave it standing for this item.
            try {
                window.sessionStorage.removeItem(STORAGE_KEY);
            } catch (err) { /* no storage, no context */ }
            return;
        }

        if (writeContext(window.location.hash, ids)) {
            log('detail nav: captured ' + ids.length + ' ids from ' + window.location.hash);
        }
    } catch (err) {
        log('detail nav: capture failed', err);
    }
}

function removeButtons(page) {
    Array.prototype.forEach.call(page.querySelectorAll('.' + NAV_CLASS), function (n) {
        n.parentNode.removeChild(n);
    });
}

/* A button that looks like the stock ones: a copy of the Replay button without its identity. */
function makeButton(template, icon, title, href) {
    var b = template.cloneNode(true);
    b.classList.remove('hide', 'btnReplay', 'btnPlay', 'jpPrimaryPlay');
    b.classList.add(NAV_CLASS);
    // view/detail-actions.js may already have marked the template as the primary Play (accent + label).
    Array.prototype.forEach.call(b.querySelectorAll('.jpPlayLabel'), function (n) {
        n.parentNode.removeChild(n);
    });
    b.removeAttribute('data-action');
    b.removeAttribute('id');
    b.title = title;
    b.setAttribute('aria-label', title);
    var glyph = b.querySelector('.detailButton-icon');
    if (!glyph) {
        return null;
    }

    glyph.className = 'material-icons detailButton-icon ' + icon;
    b.addEventListener('click', function (ev) {
        ev.preventDefault();
        window.location.hash = href;
    });
    return b;
}

function render(page, item) {
    removeButtons(page);
    if (isTv()) {
        return;
    }

    var ctx = readContext();
    var nb = ctx && neighbours(ctx.ids, item.Id);
    if (!nb || (!nb.prev && !nb.next)) {
        return;
    }

    var row = page.querySelector('.mainDetailButtons');
    var template = page.querySelector('.btnReplay') || page.querySelector('.btnPlay');
    if (!row || !template) {
        log('detail nav: no button row to add to');
        return;
    }

    var at = nb.index + 1 + ' of ' + nb.total;
    var prev = nb.prev && makeButton(template, 'skip_previous', 'Previous (this is ' + at + ')', detailHref(nb.prev, item.ServerId));
    var next = nb.next && makeButton(template, 'skip_next', 'Next (this is ' + at + ')', detailHref(nb.next, item.ServerId));

    // Before Download when it is in this row, so Play, Replay stay first.
    var anchor = page.querySelector('.btnDownload');
    if (!anchor || anchor.parentNode !== row) {
        anchor = null;
    }

    [prev, next].forEach(function (b) {
        if (b) {
            row.insertBefore(b, anchor);
        }
    });
    log('detail nav: ' + at + ' in the list captured from ' + ctx.src);
}

export function installDetailNav() {
    if (!document.body) {
        document.addEventListener('DOMContentLoaded', installDetailNav, { once: true });
        return;
    }

    try {
        document.addEventListener('click', capture, true);
        watchDetail({
            start: removeButtons,
            item: render
        });
        log('detail nav: installed');
    } catch (err) {
        log('detail nav: install failed', err);
    }
}
