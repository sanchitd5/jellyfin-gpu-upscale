import { state } from '../model/state.js';
import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';
import { player, activePlayer } from './live-apply.js';

/*
 * "NEXT VIDEO IN N s" FOR CLIPS PLAYED FROM A LIST OR QUEUE.
 *
 * jellyfin-web 12.1 shows its Up Next card only for Episodes of 10+ minutes
 * (apps/legacy/controllers/playback/video/index.js showComingUpNextIfNeeded:
 * `currentItem.Type === 'Episode'` and runtime >= 10 minutes), so a queue of short Video items
 * just ends and jumps - or, with auto-play off, stops - with no warning.
 *
 * The stock component cannot be reused from here. components/upnextdialog/upnextdialog is a
 * lazily loaded webpack chunk that nothing loads unless an Episode reaches its trigger, so it
 * is neither present to be found by shape nor loadable without reaching webpack's private
 * chunk map; its stylesheet ships inside that chunk too. So this is the minimum: a small card
 * with the same wording and the same two actions (Start now, Hide).
 *
 * It follows the player by polling twice a second, only while a <video> element exists. Events
 * would need the Events util, which is not on window either, and a timer is the only thing that
 * also updates a countdown. What it does NOT do is advance playback: jellyfin's own
 * playbackManager already starts the next queued item when a Video ends (when the user's
 * "play next episode automatically" setting is on, which is also what decides whether the
 * countdown wording is shown), so this only announces it. "Play now" calls the manager's own
 * nextTrack(), the call the stock Start Now button makes.
 *
 * Gate: Type === 'Video' (Episodes keep the stock card, so the two never show together), a next
 * item in the queue, and a runtime long enough for a notice not to be a flash.
 */

// The card appears when this many seconds remain...
var SHOW_AT_SECONDS = 8;
// ...but not for items shorter than this: the notice would cover most of the clip.
var MIN_RUNTIME_SECONDS = 20;
var POLL_MS = 500;
var TICKS_PER_SECOND = 10000000;

var STYLE_ID = 'jellyfinPlusUpNextStyle';
var CARD_ID = 'jellyfinPlusUpNext';

var CSS = [
    // Docked bottom-right, above the OSD controls (--jp-osd-clear, measured by view/portrait-osd.js,
    // so the card never covers the seek bar), inset past the notch / rounded corners (P12).
    '#' + CARD_ID + ' { position: fixed; right: max(env(safe-area-inset-right, 0px), 12px);'
        + ' left: max(env(safe-area-inset-left, 0px), 12px); margin-left: auto; max-width: 26em;'
        + ' bottom: calc(var(--jp-osd-clear, 9em) + 12px); box-sizing: border-box; z-index: 99997;'
        + ' padding: 0.8em 1em; color: #fff; background: rgba(0,0,0,0.75); border-radius: 0.3em;'
        + ' user-select: none; -webkit-touch-callout: none; }',
    '#' + CARD_ID + '.hide { display: none; }',
    '#' + CARD_ID + ' .head { font-size: 1.1em; font-weight: 500; margin: 0 0 0.25em; }',
    '#' + CARD_ID + ' .title { margin: 0 0 0.6em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
    // Portrait with the dock under the picture: the card sits in the dead area above the chip.
    'html.jp-portrait-osd #' + CARD_ID + ' { bottom: calc(var(--jp-osd-clear, 9em) + 3.6em); }',
    '#' + CARD_ID + ' .buttons { display: flex; justify-content: flex-end; gap: 0.5em; }',
    '#' + CARD_ID + ' button { min-height: 40px; padding: 0 1em; border: 0; border-radius: 0.2em;'
        + ' background: #404040; color: #fff; font: inherit; cursor: pointer; }'
].join('\n');

var dismissedKey = null;   // the queue entry the viewer chose to hide the card for
var shownKey = null;       // the queue entry the card is currently up for
var autoAdvance = null;    // user's EnableNextEpisodeAutoPlay, read once; null until known
var autoAdvanceAsked = false;

function manager() {
    return state.playbackManagerRef || player();
}

/* The viewer's "show next video info" switch, best effort from localStorage (user-scoped key). */
function overlayDisabled() {
    try {
        var c = window.ApiClient;
        var uid = c && typeof c.getCurrentUserId === 'function' ? c.getCurrentUserId() : '';
        var v = window.localStorage.getItem((uid ? uid + '-' : '') + 'enableNextVideoInfoOverlay');
        return v === 'false';
    } catch (err) {
        return false;
    }
}

function askAutoAdvance() {
    if (autoAdvanceAsked) {
        return;
    }

    autoAdvanceAsked = true;
    try {
        var c = window.ApiClient;
        if (c && typeof c.getCurrentUser === 'function') {
            Promise.resolve(c.getCurrentUser()).then(function (u) {
                autoAdvance = !(u && u.Configuration && u.Configuration.EnableNextEpisodeAutoPlay === false);
            }).catch(function () { autoAdvance = true; });
        }
    } catch (err) { /* stays null: treated as auto-advance */ }
}

function card() {
    var c = document.getElementById(CARD_ID);
    if (c) {
        return c;
    }

    c = el('div', 'hide');
    c.id = CARD_ID;
    c.setAttribute('role', 'status');
    c.appendChild(el('div', 'head'));
    c.appendChild(el('div', 'title'));
    var buttons = el('div', 'buttons');
    var now = el('button', 'now', 'Start now');
    now.type = 'button';
    var hideBtn = el('button', 'dismiss', 'Hide');
    hideBtn.type = 'button';
    buttons.appendChild(now);
    buttons.appendChild(hideBtn);
    c.appendChild(buttons);

    now.addEventListener('click', function () {
        try {
            var pm = manager();
            var pl = pm && activePlayer(pm);
            hide();
            if (pm && pl && typeof pm.nextTrack === 'function') {
                pm.nextTrack(pl);
            }
        } catch (err) {
            log('clip up next: start now failed', err);
        }
    });
    hideBtn.addEventListener('click', function () {
        dismissedKey = shownKey;
        hide();
    });

    document.body.appendChild(c);
    return c;
}

function hide() {
    var c = document.getElementById(CARD_ID);
    if (c && !c.classList.contains('hide')) {
        c.classList.add('hide');
    }
}

function show(nextItem, secondsLeft) {
    var c = card();
    var head = autoAdvance === false
        ? 'Next video'
        : 'Next video playing in ' + secondsLeft + ' s';
    var headEl = c.querySelector('.head');
    if (headEl.textContent !== head) {
        headEl.textContent = head;
    }

    var title = nextItem.Name || '';
    var titleEl = c.querySelector('.title');
    if (titleEl.textContent !== title) {
        titleEl.textContent = title;
    }

    c.classList.remove('hide');
}

function tick() {
    try {
        if (!document.querySelector('video')) {
            shownKey = null;
            hide();
            return;
        }

        var pm = manager();
        var pl = pm && typeof pm.currentItem === 'function' ? activePlayer(pm) : null;
        var item = pl ? pm.currentItem(pl) : null;
        if (!item || item.Type !== 'Video') {
            shownKey = null;
            hide();
            return;
        }

        var key = item.PlaylistItemId || item.Id;
        if (key !== shownKey) {
            // A different queue entry: whatever was hidden or shown belonged to the last one.
            shownKey = key;
            if (dismissedKey !== key) {
                dismissedKey = null;
            }

            hide();
        }

        var durationTicks = pm.duration(pl);
        if (!durationTicks || durationTicks < MIN_RUNTIME_SECONDS * TICKS_PER_SECOND) {
            hide();
            return;
        }

        var remainingMs = durationTicks / 10000 - pm.currentTime(pl);
        if (remainingMs <= 0 || remainingMs > SHOW_AT_SECONDS * 1000 || dismissedKey === key) {
            hide();
            return;
        }

        var next = typeof pm.getNextItem === 'function' ? pm.getNextItem() : null;
        if (!next || !next.item || overlayDisabled()) {
            hide();
            return;
        }

        askAutoAdvance();
        show(next.item, Math.max(1, Math.round(remainingMs / 1000)));
    } catch (err) {
        // currentItem() throws when there is no active player; that just means nothing to show.
        hide();
    }
}

export function installClipUpNext() {
    try {
        if (!document.getElementById(STYLE_ID)) {
            var style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = CSS;
            (document.head || document.documentElement).appendChild(style);
        }

        setInterval(tick, POLL_MS);
        log('clip up next installed');
    } catch (err) {
        log('clip up next install failed', err);
    }
}
