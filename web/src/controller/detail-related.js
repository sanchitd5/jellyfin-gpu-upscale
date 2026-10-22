import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';

/*
 * RELATED CONTENT ON A CLIP'S DETAILS PAGE: tag and person chips, and a "More Like This" row.
 *
 * Both are about plain Video items (BaseItemKind.Video, what a Home Videos library holds). Stock
 * jellyfin-web 12.1 handles them badly in three separate places, all in
 * apps/legacy/controllers/itemDetails/index.js:
 *
 *  - renderSimilarItems() hides #similarCollapsible for every type outside an allow-list
 *    (Movie, Trailer, Series, Program, Recording, MusicAlbum, MusicArtist, Playlist, Audio), so a
 *    clip never even asks. The server half (src/patcher/SimilarPatches.cs) makes the answer
 *    non-empty; this module asks for it and renders it into the stock #similarCollapsible with
 *    the stock cardBuilder.
 *  - renderTags() writes every tag into ONE comma-joined line of text links (".itemTags"), which on
 *    a clip with dozens of tags is a wall of text.
 *  - people appear only in the horizontal cast scroller far down the page.
 *
 * The page is found by its own id (#itemDetailPage) and the item by the `id` in the route hash;
 * the item is fetched again through the page's ApiClient (the same window.ApiClient probe.js
 * uses), because the stock controller keeps it in a closure. Nothing here replaces stock markup:
 * the chips are a new sibling after .itemTags (which a page class then hides), and the similar
 * row reuses the stock section. cardBuilder is found BY SHAPE on a module export, handed in by
 * webpack-hook.js through noteCardBuilder(), never by a global name.
 *
 * Counts on the chips were considered and left out: there is no endpoint returning "items with this
 * tag" or "items with this person" for a list of them, so it would be one /Items?Limit=0 query per
 * chip, up to dozens per page view, each a join over the tag or people mapping of a 70k-item
 * library.
 */

var STYLE_ID = 'gpuUpscaleDetailRelatedStyle';

// Item types that get chips / a similar row. Types, not "everything": a Movie already has
// working versions of both.
var CHIP_TYPES = { Video: 1 };
var SIMILAR_TYPES = { Video: 1 };

// Where a tag chip goes. 'search' = the search page for the tag (substring match on tags, and the
// page's exclude-tags box applies); 'list' = jellyfin's own exact-tag list, which is what the stock
// tag link opens: #/list?type=tag&tag=<tag>.
var TAG_TARGET = 'search';

// Chips shown before the rest fold behind a "+N" button.
var CHIP_FOLD = 40;

var SIMILAR_LIMIT = 12;

var cardBuilder = null;

function isCardBuilder(o) {
    return !!o
        && (typeof o === 'object' || typeof o === 'function')
        && typeof o.getCardsHtml === 'function'
        && typeof o.buildCards === 'function';
}

/* Called with every module's exports; keeps the first cardBuilder it sees. */
export function noteCardBuilder(exports) {
    if (cardBuilder || !exports || (typeof exports !== 'object' && typeof exports !== 'function')) {
        return;
    }

    try {
        if (isCardBuilder(exports)) {
            cardBuilder = exports;
        } else {
            var keys = Object.keys(exports);
            for (var i = 0; i < keys.length && !cardBuilder; i++) {
                var v;
                try {
                    v = exports[keys[i]];
                } catch (e) {
                    continue;
                }

                if (isCardBuilder(v)) {
                    cardBuilder = v;
                }
            }
        }

        if (cardBuilder) {
            log('found cardBuilder on a module export');
        }
    } catch (err) { /* an exotic export is not a reason to break module loading */ }
}

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

function tagHref(tag, serverId) {
    if (TAG_TARGET === 'list') {
        return '#/list?type=tag&tag=' + encodeURIComponent(tag) + (serverId ? '&serverId=' + serverId : '');
    }

    return '#/search?query=' + encodeURIComponent(tag);
}

function personHref(person, serverId) {
    return '#/details?id=' + person.Id + (serverId ? '&serverId=' + serverId : '');
}

/* People once each: a director who also wrote shows up as two People entries. */
function uniquePeople(item) {
    var byId = {};
    var out = [];
    (item.People || []).forEach(function (p) {
        if (!p || !p.Id || !p.Name) {
            return;
        }

        var seen = byId[p.Id];
        if (seen) {
            if (p.Type && seen.types.indexOf(p.Type) === -1) {
                seen.types.push(p.Type);
            }

            return;
        }

        seen = { Id: p.Id, Name: p.Name, types: p.Type ? [p.Type] : [], role: p.Role || '' };
        byId[p.Id] = seen;
        out.push(seen);
    });
    return out;
}

function uniqueTags(item) {
    var seen = {};
    return (item.Tags || []).filter(function (t) {
        if (typeof t !== 'string' || !t.trim()) {
            return false;
        }

        var k = t.toLowerCase();
        if (seen[k]) {
            return false;
        }

        seen[k] = true;
        return true;
    });
}

function chipRow(kind, label, chips) {
    var row = el('div', 'gprChipRow');
    row.setAttribute('data-kind', kind);
    row.setAttribute('role', 'list');
    row.setAttribute('aria-label', label);

    chips.forEach(function (chip, i) {
        chip.setAttribute('role', 'listitem');
        if (i >= CHIP_FOLD) {
            chip.classList.add('gprChipFolded');
        }

        row.appendChild(chip);
    });

    if (chips.length > CHIP_FOLD) {
        var more = el('button', 'gprChip gprChipMore', '+' + (chips.length - CHIP_FOLD) + ' more');
        more.type = 'button';
        more.addEventListener('click', function () {
            row.classList.add('gprChipsExpanded');
            more.parentNode.removeChild(more);
        });
        row.appendChild(more);
    }

    return row;
}

function removeChips(page) {
    Array.prototype.forEach.call(page.querySelectorAll('.gprChips'), function (n) {
        n.parentNode.removeChild(n);
    });
    page.classList.remove('gprHasChips');
}

function renderChips(page, item) {
    removeChips(page);

    // The D-pad cannot reach a row of small links; TV keeps the stock tag line.
    if (document.documentElement.classList.contains('layout-tv')) {
        return;
    }

    var tags = uniqueTags(item);
    var people = uniquePeople(item);
    if (!tags.length && !people.length) {
        return;
    }

    var anchor = page.querySelector('.itemTags');
    if (!anchor || !anchor.parentNode) {
        return;
    }

    var wrap = el('div', 'gprChips');

    if (people.length) {
        wrap.appendChild(chipRow('people', 'People', people.map(function (p) {
            var a = el('a', 'gprChip gprChipPerson');
            a.setAttribute('href', personHref(p, item.ServerId));
            a.title = p.types.concat(p.role ? [p.role] : []).join(', ') || p.Name;
            var icon = el('span', 'material-icons gprChipIcon', 'person');
            icon.setAttribute('aria-hidden', 'true');
            a.appendChild(icon);
            a.appendChild(el('span', 'gprChipText', p.Name));
            return a;
        })));
    }

    if (tags.length) {
        wrap.appendChild(chipRow('tags', 'Tags', tags.map(function (t) {
            var a = el('a', 'gprChip gprChipTag', t);
            a.setAttribute('href', tagHref(t, item.ServerId));
            return a;
        })));
    }

    anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
    // Only now that the chips exist is the stock one-line tag list hidden, so a failure above
    // never leaves the page with neither.
    page.classList.add('gprHasChips');
    log('detail chips: ' + people.length + ' people, ' + tags.length + ' tags');
}

/*
 * The stock controller adds `hide` to #similarCollapsible for a Video on every (re)render, and it
 * does so on its own schedule relative to our fetch. Once there is something to show, take the
 * class off again whenever it comes back.
 */
function keepVisible(page, section) {
    if (page.__gprSimilarObserver) {
        return;
    }

    page.__gprSimilarObserver = new MutationObserver(function () {
        if (page.__gprSimilarShown && section.classList.contains('hide')) {
            section.classList.remove('hide');
        }
    });
    page.__gprSimilarObserver.observe(section, { attributes: true, attributeFilter: ['class'] });
}

function loadSimilar(page, item, client, userId) {
    var section = page.querySelector('#similarCollapsible');
    var content = section && section.querySelector('.similarContent');
    if (!section || !content || typeof client.getSimilarItems !== 'function') {
        return;
    }

    if (!cardBuilder) {
        log('detail similar: cardBuilder not found yet; the row is skipped for this view');
        return;
    }

    client.getSimilarItems(item.Id, {
        userId: userId,
        limit: SIMILAR_LIMIT,
        fields: 'PrimaryImageAspectRatio,CanDelete'
    }).then(function (result) {
        if (page.__gprId !== item.Id) {
            return;
        }

        var items = (result && result.Items) || [];
        if (!items.length) {
            page.__gprSimilarShown = false;
            log('detail similar: server returned nothing');
            return;
        }

        page.__gprSimilarShown = true;
        section.classList.remove('hide');
        keepVisible(page, section);
        cardBuilder.buildCards(items, {
            itemsContainer: content,
            shape: 'autooverflow',
            centerText: true,
            showTitle: true,
            lazy: true,
            showDetailsMenu: true,
            overlayPlayButton: true,
            overlayText: false
        });
        log('detail similar: ' + items.length + ' items rendered');
    }, function (err) {
        log('detail similar: request failed', err);
    });
}

function load(page, id) {
    var client = window.ApiClient;
    if (!client || typeof client.getItem !== 'function' || typeof client.getCurrentUserId !== 'function') {
        return;
    }

    var userId = client.getCurrentUserId();
    client.getItem(userId, id).then(function (item) {
        if (page.__gprId !== id || !item) {
            return;
        }

        if (CHIP_TYPES[item.Type]) {
            renderChips(page, item);
        }

        if (SIMILAR_TYPES[item.Type]) {
            loadSimilar(page, item, client, userId);
        }
    }, function (err) {
        log('detail related: item request failed', err);
    });
}

function scan() {
    try {
        var id = currentDetailId();
        if (!id) {
            return;
        }

        Array.prototype.forEach.call(document.querySelectorAll('#itemDetailPage'), function (page) {
            if (page.__gprId === id || !isShown(page)) {
                return;
            }

            page.__gprId = id;
            page.__gprSimilarShown = false;
            removeChips(page);
            load(page, id);
        });
    } catch (err) {
        log('detail related scan failed', err);
    }
}

function installStyle() {
    if (document.getElementById(STYLE_ID)) {
        return;
    }

    var style = document.createElement('style');
    style.id = STYLE_ID;
    // Greys at partial alpha instead of theme colours, and `color: inherit`, so the chips read
    // on both the dark and the light theme without knowing which is active.
    style.textContent = [
        '.gprChips { margin: 0.7em 0; max-width: 100%; }',
        '.gprChipRow { display: flex; flex-wrap: wrap; gap: 0.45em; margin: 0.45em 0; max-width: 100%; }',
        '.gprChip { display: inline-flex; align-items: center; box-sizing: border-box; max-width: 100%;'
            + ' min-height: 2.1em; padding: 0.2em 0.8em; margin: 0; border-radius: 999px;'
            + ' border: 1px solid rgba(128, 128, 128, 0.45); background: rgba(128, 128, 128, 0.16);'
            + ' color: inherit; font: inherit; font-size: 92%; line-height: 1.4; text-decoration: none;'
            + ' overflow-wrap: anywhere; cursor: pointer; -webkit-tap-highlight-color: transparent; }',
        '.gprChip:hover, .gprChip:focus-visible { background: rgba(128, 128, 128, 0.32); outline: none; }',
        '.gprChip:focus-visible { box-shadow: 0 0 0 2px rgba(128, 128, 128, 0.7); }',
        '.gprChipIcon { font-size: 1.25em; margin: 0 0.3em 0 -0.25em; flex-shrink: 0; }',
        '.gprChipText { min-width: 0; overflow-wrap: anywhere; }',
        '.gprChipFolded { display: none; }',
        '.gprChipsExpanded .gprChipFolded { display: inline-flex; }',
        'html.layout-mobile .gprChip { min-height: 2.5em; padding: 0.35em 0.95em; }',
        '.gprHasChips .itemTags { display: none !important; }'
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
}

export function installDetailRelated() {
    try {
        installStyle();

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
        log('detail related: installed');
    } catch (err) {
        log('detail related install failed', err);
    }
}
