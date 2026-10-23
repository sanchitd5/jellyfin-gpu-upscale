import { log } from '../lib/log.js';

/*
 * ONE WATCHER FOR THE DETAILS PAGE, SHARED BY THE MODULES THAT ADD TO ITS BUTTON ROW
 * (detail-nav.js: previous / next, detail-download.js: Download).
 *
 * jellyfin-web 12.1's legacy details page is one element, #itemDetailPage, that is re-rendered for
 * each item (apps/legacy/controllers/itemDetails/index.js) and may be kept in the DOM, hidden,
 * while another route is shown. The item is therefore found the way detail-related.js finds it:
 * the page by its own id, the item by the `id` in the route hash, fetched again through
 * window.ApiClient (the stock controller keeps its copy in a closure). One fetch per page and id
 * serves every watcher.
 *
 * A watcher is { start(page, id), item(page, item) }, both optional. start() runs the moment a
 * new id is seen, before the item arrives, so a button that belonged to the previous item can be
 * removed at once. item() runs with the fresh DTO. A watcher that throws is logged and skipped;
 * the others still run.
 */

var watchers = [];
var installed = false;

function currentDetailId() {
    var hash = window.location.hash || '';
    if (!/^#\/details(\?|$)/.test(hash)) {
        return null;
    }

    var q = hash.indexOf('?');
    return q === -1 ? null : (new URLSearchParams(hash.slice(q + 1)).get('id') || null);
}

function isShown(node) {
    return !!node && (node.offsetParent !== null || node.getClientRects().length > 0);
}

function call(name, a, b) {
    watchers.forEach(function (w) {
        try {
            if (typeof w[name] === 'function') {
                w[name](a, b);
            }
        } catch (err) {
            log('detail page: a watcher failed in ' + name, err);
        }
    });
}

function load(page, id) {
    var client = window.ApiClient;
    if (!client || typeof client.getItem !== 'function' || typeof client.getCurrentUserId !== 'function') {
        return;
    }

    client.getItem(client.getCurrentUserId(), id).then(function (item) {
        if (page.__jpDetailId !== id || !item) {
            return;
        }

        call('item', page, item);
    }, function (err) {
        log('detail page: item request failed', err);
    });
}

function scan() {
    try {
        var id = currentDetailId();
        if (!id) {
            // Left the details route: coming back to the same id is a new visit (the list context may differ).
            Array.prototype.forEach.call(document.querySelectorAll('#itemDetailPage'), function (page) {
                page.__jpDetailId = null;
            });
            return;
        }

        Array.prototype.forEach.call(document.querySelectorAll('#itemDetailPage'), function (page) {
            if (page.__jpDetailId === id || !isShown(page)) {
                return;
            }

            page.__jpDetailId = id;
            call('start', page, id);
            load(page, id);
        });
    } catch (err) {
        log('detail page: scan failed', err);
    }
}

function install() {
    if (installed) {
        return;
    }

    installed = true;
    var pending = false;
    var run = function () {
        if (pending) {
            return;
        }

        pending = true;
        requestAnimationFrame(function () {
            pending = false;
            scan();
        });
    };

    new MutationObserver(run).observe(document.body || document.documentElement, { childList: true, subtree: true });
    window.addEventListener('hashchange', run);
    run();
}

/* Registers a watcher and starts the shared page watcher on first use. */
export function watchDetail(watcher) {
    watchers.push(watcher);
    install();
}
