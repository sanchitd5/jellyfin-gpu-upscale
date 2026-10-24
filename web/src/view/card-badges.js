import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';
import { badgeType, tagsText } from '../model/card-badges.js';
import { badgesEnabled, cardInfo, onCardInfo, watchCard } from '../controller/card-data.js';
import { categoriesNow, getCategories } from '../controller/smart-tags.js';
import { primaryTagOf, scopeFromHash } from '../model/smart-tags.js';

/*
 * CARD BADGES (QOL_IDEAS #41): resolution, runtime and the first two tags on video cards.
 *
 * Nothing on a stock card tells a 4K clip from a 480p one, or shows its tags. For a Video, Movie,
 * Episode, MusicVideo or Trailer card:
 *
 *  - a small chip group at the top left of the thumbnail: "1080p" and the runtime ("12:34"). The top
 *    right belongs to jellyfin's own indicators (played, count) and the bottom right to the phone
 *    action row (view/card-actions.js). The chips ignore pointer events, so taps and long presses
 *    reach the card exactly as before;
 *  - one more line in the card's footer, under the title: "tag one · tag two". Cards without a footer
 *    (overlay-text styles) get no tag line.
 *
 * The data is NOT part of any list request. controller/card-data.js looks it up once a card is near
 * the screen, in batches, and caches it; a card that is redrawn (virtualised chunks, React re-render)
 * is painted from the cache with no request. Everything is added through textContent, never innerHTML:
 * tag names are user data. TV layouts are left alone. `localStorage jellyfinPlus.cardBadges = off`
 * turns the badges off.
 *
 * Like card-actions.js this finds cards by the stable .card[data-id][data-serverid] markup that both
 * the legacy cardBuilder lists and the modern library views emit, with a MutationObserver. If a card
 * has no .cardScalable (the markup changed) it is left alone.
 *
 * THE CATEGORY PILL. The item's tag from the PRIMARY smart category (the exclusive facet covering the most
 * items, GET /JellyfinPlus/Tags/Categories via controller/smart-tags.js, fetched once per library scope and
 * cached) is an accent pill: on a card it joins the top-left chips (clear of the bottom-right heart/more row
 * and of a title drawn over the image), on a list row (.listItem, phone/tablet list view) it sits after the
 * row's text. When a card has one, it replaces the footer's "first two tags" line. No route, no primary facet
 * or an item without one of its tags: nothing extra is drawn.
 */

var STYLE_ID = 'jellyfinPlusCardBadgesStyle';
var CHIPS = 'jpCardChips';
var TAGS = 'jpCardTags';
var CAT = 'jpChipCat';
var LIST_CAT = 'jpListCat';
var CARD_SELECTOR = '.card[data-id][data-serverid]';
var LIST_SELECTOR = '.listItem[data-id][data-serverid]';

var CSS = [
    '.' + CHIPS + ' { position: absolute; left: 0; top: 0; z-index: 1; display: flex; flex-wrap: wrap; gap: 3px;'
        + ' max-width: 100%; box-sizing: border-box; padding: 4px; pointer-events: none; }',
    '.' + CHIPS + ' > span { display: inline-block; padding: 1px 5px; border-radius: 4px; background: rgba(0,0,0,0.72);'
        + ' color: #fff; font-size: 0.72em; font-weight: 600; line-height: 1.5; letter-spacing: 0.02em; white-space: nowrap;'
        + ' font-variant-numeric: tabular-nums; }',
    '.' + CHIPS + ' > .jpChipRes { background: rgba(0,0,0,0.82); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.55); }',
    '.' + CHIPS + ' > .jpChipTip { background: rgba(0,0,0,0.82); color: #ffd36b; box-shadow: inset 0 0 0 1px rgba(255,211,107,0.6); }',
    '.' + TAGS + ' { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 0.8em; opacity: 0.75; }',
    // The category pill: the theme's accent (fallbacks for the theme switched off), clipped, never wider than the card.
    '.' + CHIPS + ' > .' + CAT + ', .' + LIST_CAT + ' { background: var(--jp-accent, #5ccfff); color: var(--jp-on-accent, #0b1a22);'
        + ' border-radius: 999px; padding: 1px 7px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; box-sizing: border-box; }',
    '.' + LIST_CAT + ' { display: inline-block; flex: none; align-self: center; margin: 0 6px; font-size: 0.75em; font-weight: 600;'
        + ' line-height: 1.6; white-space: nowrap; max-width: 40%; pointer-events: none; }'
].join('\n');

function isTv() {
    return document.documentElement.classList.contains('layout-tv');
}

/* The item's primary-category tag ({ name, label }) when the scope's categories are loaded, else null. */
function categoryOf(info) {
    if (!info || !info.all || !info.all.length) {
        return null;
    }

    var scope = scopeFromHash(window.location.hash);
    var cats = categoriesNow(scope);
    if (!cats && !waiting[scope]) {
        // First card of this scope: once the categories arrive, every painted card gets its pill.
        waiting[scope] = true;
        getCategories(scope).then(function () {
            waiting[scope] = false;
            repaintAll();
        });
    }

    return cats ? primaryTagOf(info.all, cats) : null;
}

var waiting = {};

function repaintAll() {
    if (isTv()) {
        return;
    }

    var nodes = document.querySelectorAll(CARD_SELECTOR + ', ' + LIST_SELECTOR);
    for (var i = 0; i < nodes.length; i++) {
        var info = cardInfo(nodes[i].getAttribute('data-id'));
        if (info && badgeType(nodes[i].getAttribute('data-type'))) {
            try {
                paint(nodes[i], info);
            } catch (err) {
                log('card badges: repaint failed', err);
            }
        }
    }
}

/* A list row: the pill after the row's text, or none. Idempotent. */
function paintRow(li, info) {
    var cat = categoryOf(info);
    var pill = li.querySelector('.' + LIST_CAT);
    if (!cat) {
        if (pill) { pill.remove(); }
        return;
    }

    if (!pill) {
        pill = el('span', LIST_CAT);
        var body = li.querySelector('.listItemBody');
        if (body && body.parentNode) {
            body.parentNode.insertBefore(pill, body.nextSibling);
        } else {
            (li.querySelector(':scope > .listItem-content') || li).appendChild(pill);
        }
    }

    if (pill.textContent !== cat.label) {
        pill.textContent = cat.label;
        pill.title = cat.name;
    }
}

/* Brings one card in line with the record for its item. Idempotent: touches the DOM only on a change. */
function paint(card, info) {
    if (card.matches && card.matches(LIST_SELECTOR)) {
        paintRow(card, info);
        return;
    }

    var scalable = card.querySelector('.cardScalable');
    if (!scalable || !info) {
        return;
    }

    var cat = categoryOf(info);
    var chips = scalable.querySelector(':scope > .' + CHIPS);
    var texts = [];
    if (info.res) { texts.push(['jpChipRes', info.res]); }
    if (info.runtime) { texts.push(['jpChipRuntime', info.runtime]); }
    if (cat) { texts.push([CAT, cat.label, cat.name]); }
    // CommunityRating here is the tip value for that recording; beside the category pill.
    if (info.tip) { texts.push(['jpChipTip', 'Tip ' + info.tip, 'Tips for this recording (community rating)']); }
    var sig = texts.map(function (t) { return t[1]; }).join('|');
    if (!texts.length) {
        if (chips) { chips.remove(); }
    } else if (!chips || chips.getAttribute('data-sig') !== sig) {
        if (!chips) {
            chips = el('div', CHIPS);
            scalable.appendChild(chips);
        }

        chips.textContent = '';
        chips.setAttribute('data-sig', sig);
        texts.forEach(function (t) {
            var span = el('span', t[0], t[1]);
            if (t[2]) { span.title = t[2]; }
            chips.appendChild(span);
        });
    }

    // The footer UNDER the thumbnail only: a footer drawn over the image has no room for a third line.
    var footer = null;
    var footers = card.querySelectorAll('.cardFooter');
    for (var f = 0; f < footers.length; f++) {
        if (!scalable.contains(footers[f])) {
            footer = footers[f];
            break;
        }
    }

    var line = card.querySelector('.' + TAGS);
    var text = cat ? '' : tagsText(info.tags); // the pill replaces the generic tag line
    if (!text || !footer) {
        if (line) { line.remove(); }
        return;
    }

    if (!line) {
        line = el('div', 'cardText cardText-secondary ' + TAGS);
        footer.appendChild(line);
    }

    if (line.textContent !== text) {
        line.textContent = text;
        line.title = text;
    }
}

function decorate(card) {
    if (!card || card.nodeType !== 1 || !card.isConnected || isTv() || !card.matches(CARD_SELECTOR)) {
        return;
    }

    if (!badgeType(card.getAttribute('data-type')) || !card.querySelector('.cardScalable')) {
        return;
    }

    var id = card.getAttribute('data-id');
    var info = cardInfo(id);
    if (info) {
        paint(card, info);
    } else {
        watchCard(card);
    }
}

/* A list row (.listItem, phone/tablet list view): only the category pill. */
function decorateRow(li) {
    if (!li || li.nodeType !== 1 || !li.isConnected || isTv() || !li.matches(LIST_SELECTOR)
        || !badgeType(li.getAttribute('data-type'))) {
        return;
    }

    var info = cardInfo(li.getAttribute('data-id'));
    if (info) {
        paintRow(li, info);
    } else {
        watchCard(li);
    }
}

var queue = [];
var scheduled = false;

function drain() {
    scheduled = false;
    var batch = queue;
    queue = [];
    batch.forEach(function (node) {
        try {
            if (node.matches && node.matches(CARD_SELECTOR)) {
                decorate(node);
            } else if (node.closest && node.closest(CARD_SELECTOR)) {
                // A card whose inner markup was rebuilt (React re-rendered .cardScalable).
                decorate(node.closest(CARD_SELECTOR));
            }

            if (node.querySelectorAll) {
                var cards = node.querySelectorAll(CARD_SELECTOR);
                for (var i = 0; i < cards.length; i++) {
                    decorate(cards[i]);
                }
            }

            if (node.matches && node.matches(LIST_SELECTOR)) {
                decorateRow(node);
            } else if (node.closest && node.closest(LIST_SELECTOR)) {
                decorateRow(node.closest(LIST_SELECTOR));
            }

            if (node.querySelectorAll) {
                var rows = node.querySelectorAll(LIST_SELECTOR);
                for (var r = 0; r < rows.length; r++) {
                    decorateRow(rows[r]);
                }
            }
        } catch (err) {
            log('card badges: decorate failed', err);
        }
    });
}

function enqueue(node) {
    queue.push(node);
    if (!scheduled) {
        scheduled = true;
        (window.requestAnimationFrame || setTimeout)(drain);
    }
}

function ours(n) {
    var c = n.classList;
    return !!c && (c.contains(CHIPS) || c.contains(TAGS) || c.contains(CAT) || c.contains(LIST_CAT));
}

export function installCardBadges() {
    try {
        if (!badgesEnabled()) {
            log('card badges: switched off (localStorage jellyfinPlus.cardBadges)');
            return;
        }

        if (!document.getElementById(STYLE_ID)) {
            var style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = CSS;
            (document.head || document.documentElement).appendChild(style);
        }

        onCardInfo(function (id, info) {
            if (isTv()) {
                return;
            }

            var cards = document.querySelectorAll('.card[data-id="' + id + '"], .listItem[data-id="' + id + '"]');
            for (var i = 0; i < cards.length; i++) {
                if (badgeType(cards[i].getAttribute('data-type'))) {
                    paint(cards[i], info);
                }
            }
        });

        new MutationObserver(function (mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var added = mutations[i].addedNodes;
                for (var j = 0; j < added.length; j++) {
                    var n = added[j];
                    // Our own chips / tag line being appended must not re-trigger work.
                    if (n.nodeType === 1 && !ours(n)) {
                        enqueue(n);
                    }
                }
            }
        }).observe(document.documentElement, { childList: true, subtree: true });

        // The page may already hold cards by the time this runs.
        enqueue(document.documentElement);
        log('card badges installed');
    } catch (err) {
        log('card badges install failed', err);
    }
}
