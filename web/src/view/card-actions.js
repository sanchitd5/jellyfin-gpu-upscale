import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';
import { apiClient, sameServer, cardInfo, onCardInfo, watchCard } from '../controller/card-data.js';

/*
 * FAVOURITE / MORE / PLAY ON EVERY CARD, ON A PHONE.
 *
 * jellyfin-web 12.1 draws a card's favourite and "more" buttons only in a hover overlay
 * (cardBuilder getHoverMenuHtml / modern CardHoverMenu), which is rendered for layoutManager.desktop
 * alone. On a phone the card has at most a small play button (and only on some lists: the modern
 * Videos tab sets neither overlayPlayButton nor overlayMoreButton), so favouriting or reaching the
 * context menu meant a 550 ms long press - which iOS Safari turns into multi-select.
 *
 * This adds a small always-visible button row to each card under html.layout-mobile, in both the
 * legacy cardBuilder lists and the modern MUI library views (both emit the same .card[data-id]
 * markup with .cardScalable inside):
 *
 *  - MORE and PLAY carry the stock `itemAction` class and `data-action="menu"` / `"play"`. They are
 *    not handled here at all: the items container's own delegated click handler (shortcuts.js
 *    onClick) resolves them exactly as it resolves the stock play button, so the real context menu
 *    and real playback open. That is also why buttons are only added to cards inside an items
 *    container - a card elsewhere has no handler listening for them.
 *  - FAVOURITE has no data-action in stock (the hover one is an emby-ratingbutton custom element
 *    that is not even loaded on a phone), so it makes the same call that element makes,
 *    ApiClient.updateFavoriteStatus(), through the page's ApiClient (the repo already uses
 *    window.ApiClient in probe.js). Cards carry no favourite flag, so the heart state is read in
 *    small batches for the cards that scroll into view (controller/card-data.js, which the card
 *    badges share: one lookup serves both).
 *
 * The row ignores pointer events except on the buttons themselves, so a tap anywhere else on the
 * card still opens it, and a long press anywhere (including on a button) still starts the stock
 * multi-select. While multi-select is active the row is hidden, so a tap there selects the card.
 * Tap targets are 40 px; the visible disc inside is smaller so the thumbnail is not covered.
 */

var STYLE_ID = 'jellyfinPlusCardActionsStyle';
var ROW_CLASS = 'jellyfinPlusCardActions';
var CARD_SELECTOR = '.card[data-id][data-serverid]';
// The stock items-container classes; the click handler that executes data-action lives on them.
var CONTAINER_SELECTOR = '.itemsContainer, [is="emby-itemscontainer"]';

// Cards that are not library items a user can favourite / open a context menu for.
var SKIP_TYPES = ['Program', 'Timer', 'SeriesTimer', 'Channel', 'TvChannel', 'CollectionFolder', 'UserView'];

var TAP_TARGET = '40px';

var CSS = [
    '.' + ROW_CLASS + ' { display: none; }',
    'html.layout-mobile .' + ROW_CLASS + ' {'
        + ' display: flex; flex-wrap: wrap-reverse; justify-content: flex-end; align-items: flex-end;'
        + ' position: absolute; right: 0; bottom: 0; max-width: 100%; z-index: 2; pointer-events: none; }',
    'html.layout-mobile .' + ROW_CLASS + ' button {'
        + ' pointer-events: auto; box-sizing: border-box; margin: 0; padding: 4px; border: 0;'
        + ' min-width: ' + TAP_TARGET + '; min-height: ' + TAP_TARGET + ';'
        + ' width: ' + TAP_TARGET + '; height: ' + TAP_TARGET + ';'
        + ' background: transparent; color: #fff; cursor: pointer; -webkit-tap-highlight-color: transparent; }',
    'html.layout-mobile .' + ROW_CLASS + ' .jellyfinPlusDisc {'
        + ' display: flex; align-items: center; justify-content: center; width: 100%; height: 100%;'
        + ' border-radius: 50%; background: rgba(0,0,0,0.7); pointer-events: none; }',
    'html.layout-mobile .' + ROW_CLASS + ' .material-icons {'
        + ' font-family: "Material Icons"; font-feature-settings: "liga"; font-size: 20px; line-height: 1;'
        + ' font-style: normal; letter-spacing: normal; text-transform: none; white-space: nowrap;'
        + ' -webkit-font-smoothing: antialiased; }',
    'html.layout-mobile .' + ROW_CLASS + ' button[aria-pressed="true"] .material-icons { color: #ff4d6d; }',
    // The row replaces the stock bottom-right overlay buttons (play, or more on some lists); both
    // at once would sit on top of each other.
    'html.layout-mobile .card[data-gpu-actions] .cardOverlayButton-br { display: none !important; }',
    // Multi-select is active on this card: a tap there must select it, not favourite it.
    '.card:has(.withMultiSelect) .' + ROW_CLASS + ' { display: none !important; }',

    // QOL_IDEAS #17, the rest of the phone tap targets under 40 px: the stock selection bar's two
    // buttons and the bulk tag dialog's suggestion chips and buttons (view/bulk-tags-dialog.js, whose
    // own sizes suit a mouse). Padding and min sizes only; nothing is hidden or moved.
    'html.layout-mobile .selectionCommandsPanel .btnCloseSelectionPanel,'
        + ' html.layout-mobile .selectionCommandsPanel .btnSelectionPanelOptions { min-width: 44px; min-height: 44px; }',
    'html.layout-mobile .gubtChip { display: inline-flex; align-items: center; min-height: 40px; padding: 0 14px; }',
    'html.layout-mobile .gubtBtn { min-height: 44px; min-width: 88px; }'
].join('\n');

// id -> boolean. The favourite state, learned from lookups and from the taps made here.
var favState = new Map();

function isMobileLayout() {
    return document.documentElement.classList.contains('layout-mobile');
}

function paintFavourite(id) {
    var fav = favState.get(id) === true;
    var buttons = document.querySelectorAll('.' + ROW_CLASS + ' button[data-gpu-fav="' + id + '"]');
    for (var i = 0; i < buttons.length; i++) {
        var b = buttons[i];
        b.setAttribute('aria-pressed', fav ? 'true' : 'false');
        b.title = fav ? 'Favourite (tap to remove)' : 'Add to favourites';
        b.setAttribute('aria-label', b.title);
        var icon = b.querySelector('.material-icons');
        if (icon) {
            icon.textContent = fav ? 'favorite' : 'favorite_border';
        }
    }
}

/* A looked-up record arrived (controller/card-data.js): adopt its favourite flag unless a tap set it. */
function adopt(id, info) {
    if (info && !favState.has(id)) {
        favState.set(id, !!info.fav);
    }

    if (favState.has(id)) {
        paintFavourite(id);
    }
}

function onFavouriteTap(e) {
    var btn = e.currentTarget;
    e.preventDefault();
    e.stopPropagation();

    var id = btn.getAttribute('data-gpu-fav');
    var c = apiClient();
    if (!id || !c || typeof c.updateFavoriteStatus !== 'function') {
        log('card actions: no ApiClient.updateFavoriteStatus, favourite tap ignored');
        return;
    }

    var was = favState.get(id) === true;
    var next = !was;
    // Optimistic: the heart answers the tap at once, and goes back if the server refuses.
    favState.set(id, next);
    paintFavourite(id);
    Promise.resolve(c.updateFavoriteStatus(c.getCurrentUserId(), id, next)).then(function (ud) {
        if (ud && typeof ud.IsFavorite === 'boolean') {
            favState.set(id, ud.IsFavorite);
            paintFavourite(id);
        }
    }).catch(function (err) {
        log('card actions: updateFavoriteStatus failed', err);
        favState.set(id, was);
        paintFavourite(id);
    });
}

function iconButton(icon, title) {
    var b = el('button');
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    var disc = el('span', 'jellyfinPlusDisc');
    disc.appendChild(el('span', 'material-icons', icon));
    disc.firstChild.setAttribute('aria-hidden', 'true');
    b.appendChild(disc);
    return b;
}

function decorate(card) {
    if (!card || card.nodeType !== 1 || !card.isConnected || !isMobileLayout()) {
        return;
    }

    if (!card.matches(CARD_SELECTOR) || card.querySelector('.' + ROW_CLASS)) {
        return;
    }

    // Without an items container there is no click handler to run data-action="menu"/"play".
    if (!card.closest(CONTAINER_SELECTOR)) {
        return;
    }

    var type = card.getAttribute('data-type');
    if (SKIP_TYPES.indexOf(type) >= 0) {
        return;
    }

    var scalable = card.querySelector('.cardScalable');
    if (!scalable) {
        return;
    }

    var id = card.getAttribute('data-id');
    var serverId = card.getAttribute('data-serverid');
    var row = el('div', ROW_CLASS);
    var hasFavourite = false;

    // Favourite: only where a heart can be kept in step with the server.
    if (sameServer(serverId)) {
        var fav = iconButton('favorite_border', 'Add to favourites');
        fav.setAttribute('data-gpu-fav', id);
        fav.setAttribute('aria-pressed', 'false');
        fav.addEventListener('click', onFavouriteTap);
        row.appendChild(fav);
        hasFavourite = true;
    }

    // More: the stock context menu, executed by shortcuts.js through data-action.
    var more = iconButton('more_vert', 'More');
    more.className = 'itemAction';
    more.setAttribute('data-action', 'menu');
    row.appendChild(more);

    // Play: wherever the stock card already offered it, or for a plain playable file.
    var stockPlay = card.querySelector('.cardOverlayButton[data-action="play"]');
    var mediaType = card.getAttribute('data-mediatype');
    var playable = !!stockPlay
        || ((mediaType === 'Video' || mediaType === 'Audio') && card.getAttribute('data-isfolder') !== 'true');
    if (playable) {
        var play = iconButton('play_arrow', 'Play');
        play.className = 'itemAction';
        play.setAttribute('data-action', 'play');
        row.appendChild(play);
    }

    card.setAttribute('data-gpu-actions', '1');
    scalable.appendChild(row);

    if (hasFavourite) {
        // Already looked up (a redrawn card), or looked up once it is near the screen.
        adopt(id, cardInfo(id));
        watchCard(card);
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
        } catch (err) {
            log('card actions: decorate failed', err);
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

export function installCardActions() {
    try {
        if (!document.getElementById(STYLE_ID)) {
            var style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = CSS;
            (document.head || document.documentElement).appendChild(style);
        }

        var observer = new MutationObserver(function (mutations) {
            if (!isMobileLayout()) {
                return;
            }

            for (var i = 0; i < mutations.length; i++) {
                var added = mutations[i].addedNodes;
                for (var j = 0; j < added.length; j++) {
                    var n = added[j];
                    // Our own row being appended must not re-trigger work.
                    if (n.nodeType === 1 && !(n.classList && n.classList.contains(ROW_CLASS))) {
                        enqueue(n);
                    }
                }
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        onCardInfo(adopt);

        // The layout class can be applied after the first cards were drawn.
        new MutationObserver(function () {
            if (isMobileLayout()) {
                enqueue(document.documentElement);
            }
        }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

        // The page may already hold cards by the time this runs.
        enqueue(document.documentElement);
        log('card actions installed');
    } catch (err) {
        log('card actions install failed', err);
    }
}
