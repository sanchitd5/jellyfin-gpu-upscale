import { state } from '../model/state.js';
import { log } from '../lib/log.js';
import { badgeModel } from '../model/player-badge.js';
import { probeServer } from './probe.js';
import { fetchServerState } from './live-block.js';
import { activeState } from './live-apply.js';
import { openEnhancePanel } from './playback-hooks.js';
import { clientStatus, onClientStatus } from './client-upscale.js';
import { el } from '../lib/dom.js';

/*
 * THE ENHANCE BADGE IN THE VIDEO OSD: a small chip, shown with the OSD, saying what the server is
 * actually doing for this stream ("Denoise 2 (...), Upscaled ..." or an honest negative such as
 * "Enhancement not applied (video is being streamed as-is)"). Tapping it opens the Enhance panel.
 *
 * THE WORDS ARE NOT ARRANGED HERE. model/player-badge.js builds the text from the session record
 * the server sent (its own Summary) and live-apply.js activeState(); nothing is derived from
 * what the panel selected, and no label is made up on the client.
 *
 * WHERE IT LIVES. jellyfin-web has two OSD headers (the legacy skinHeader built by libraryMenu.js
 * and a React/MUI one in the modern app). Injecting into either is fragile, and one of them is
 * React-owned, so the chip is a fixed element on <body> placed under the top bar, and it follows
 * the OSD through the SHOW_VIDEO_OSD event both headers already react to. The event is a
 * jellyfin-web Events trigger: callbacks live in obj._callbacks[type], the same seam
 * playback-hooks.js already uses on the playbackManager, so the chip adds one callback to
 * document._callbacks.SHOW_VIDEO_OSD. If that event never fires on some build, the chip simply
 * never appears.
 *
 * WHEN IT REFRESHES. When the OSD appears, when the play session id changes (playback start and
 * every live apply that lands: network.js records the new id from the PlaybackInfo response), and
 * every five seconds while visible. The poll only runs while the chip is on screen. A probe that
 * does not answer fully hides it, and so does leaving the video page.
 */

var STYLE_ID = 'jellyfinPlusBadgeStyle';
var CHIP_ID = 'jellyfinPlusEnhanceBadge';
var PAGE_ID = 'videoOsdPage';
var EVENT = 'SHOW_VIDEO_OSD';
var TICK_MS = 1000;
var REFRESH_EVERY_TICKS = 5;

var CSS = [
    '#' + CHIP_ID + ' { position: fixed; z-index: 99990; box-sizing: border-box;'
        // Bottom-left, just above the OSD controls (never in the header band, so it cannot hit the
        // title). --jp-osd-clear is the height of the controls, measured by view/portrait-osd.js;
        // the fallback is where stock's .videoOsdBottom controls end.
        + ' bottom: calc(var(--jp-osd-clear, 9em) + 8px); left: calc(max(env(safe-area-inset-left, 0px), 12px) + 4px);'
        + ' max-width: min(32em, calc(100vw - 2em - max(env(safe-area-inset-left, 0px), 12px) - max(env(safe-area-inset-right, 0px), 12px)));'
        + ' padding: 0.25em 0.8em; border: 0; border-radius: 1em; font: inherit; font-size: 0.85em;'
        + ' color: #fff; background: rgba(0,0,0,0.55); white-space: nowrap; overflow: hidden;'
        + ' text-overflow: ellipsis; cursor: pointer; opacity: 0; visibility: hidden;'
        + ' transition: opacity 0.2s, visibility 0.2s; }',
    '#' + CHIP_ID + '.show { opacity: 1; visibility: visible; }',
    // Landscape: the chip is only there while the OSD is (the degraded exception below is for
    // portrait, where the dock under the picture has room for it).
    '@media (orientation: landscape) { #' + CHIP_ID + ':not([data-osd="1"]) { opacity: 0; visibility: hidden; } }',
    // A finger-sized target.
    '@media (pointer: coarse) { #' + CHIP_ID + ' { min-height: var(--jp-tap, 44px); display: inline-flex;'
        + ' flex-direction: column; justify-content: center; } }',
    '#' + CHIP_ID + '[data-key="active"] { background: rgba(0,128,96,0.75); }',
    '#' + CHIP_ID + '[data-key="off"], #' + CHIP_ID + '[data-key="unavailable"] { background: rgba(110,70,0,0.7); }',
    '#' + CHIP_ID + '.show[data-key="waiting"] { opacity: 0.7; }',
    '#' + CHIP_ID + '[data-key="device"] { background: rgba(0,70,130,0.75); }',
    '#' + CHIP_ID + ' .jp-device-line { display: block; overflow: hidden; text-overflow: ellipsis;'
        + ' font-size: 0.9em; opacity: 0.85; text-align: left; }'
].join('\n');

var chip = null;
var timer = null;
var ticks = 0;
var burst = 0;     // extra one-second refreshes after a new session, while the server catches up
var lastSid = null;
var caps = null;

function isTv() {
    return document.documentElement.classList.contains('layout-tv');
}

function onVideoPage() {
    var p = document.getElementById(PAGE_ID);
    return !!p && p.getClientRects().length > 0;
}

function ensureChip() {
    if (chip && chip.isConnected) { return chip; }
    if (!document.getElementById(STYLE_ID)) {
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);
    }

    chip = document.createElement('button');
    chip.id = CHIP_ID;
    chip.type = 'button';
    chip.addEventListener('click', function (e) {
        e.stopPropagation();
        openEnhancePanel();
    });
    // The player listens for taps on the page, not here, but a press on the chip must not reach
    // any document-level handler that would read it as a tap on the video.
    chip.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    (document.body || document.documentElement).appendChild(chip);
    return chip;
}

function render() {
    if (!chip) { return; }
    var model = badgeModel(caps, state.lastServerState, activeState());
    // Client-side upscaling (controller/client-upscale.js) is its own line, always worded
    // "This device: ...", so it can never be read as something the server did. It does not need
    // the server plugin, so it can be the chip's only line.
    var device = clientStatus().line;
    if (!model.show && !device) {
        chip.classList.remove('show');
        return;
    }

    if (model.show) {
        chip.textContent = model.text;
        chip.title = model.title;
        chip.setAttribute('aria-label', 'Enhance: ' + model.text);
        chip.setAttribute('data-key', model.key);
        if (device) {
            chip.appendChild(el('span', 'jp-device-line', device));
            chip.title = model.title + '\n' + device;
            chip.setAttribute('aria-label', 'Enhance: ' + model.text + '. ' + device);
        }
    } else {
        chip.textContent = device;
        chip.title = device;
        chip.setAttribute('aria-label', 'Enhance: ' + device);
        chip.setAttribute('data-key', 'device');
    }
    chip.classList.add('show');
}

function refresh() {
    lastSid = state.playSessionId;
    fetchServerState().then(function () {
        if (timer) { render(); }
    }, function () { /* keep the last answer */ });
}

function hide() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }

    if (chip) { chip.classList.remove('show'); }
}

function tick() {
    try {
        if (!onVideoPage()) {
            hide();
            return;
        }

        ticks++;
        if (state.playSessionId !== lastSid) {
            // Playback start or a live apply landed. The server writes its record when the
            // transcode starts, which can be a moment after the new id is known.
            burst = 4;
        }

        if (!caps || !caps.full) {
            render();       // device line only: no server record to fetch
            return;
        }

        if (burst > 0 || ticks % REFRESH_EVERY_TICKS === 0) {
            if (burst > 0) { burst--; }
            refresh();
        }
    } catch (err) {
        log('enhance badge: tick failed', err);
    }
}

function show() {
    ensureChip();
    // probeServer() answers from cache once it has succeeded, and retries after a failure.
    probeServer().then(function (c) {
        caps = c;
        if (!onVideoPage()) { return; }
        if (!timer) {
            ticks = 0;
            timer = setInterval(tick, TICK_MS);
        }

        if (!c || !c.full) {
            render();       // the device line alone, or nothing
            return;
        }

        // A record fetched for an earlier session is not shown as this one's: when the session
        // changed since the last fetch, the chip waits for the new answer.
        if (state.playSessionId === lastSid) { render(); }
        refresh();
    }, function () {
        caps = null;
        if (onVideoPage()) { render(); } else { hide(); }
    });
}

/* "Degraded": the server says it is NOT doing what was asked. Worth keeping on screen. */
function degraded() {
    var k = chip && chip.getAttribute('data-key');
    return k === 'off' || k === 'unavailable';
}

function onOsd(e, showing) {
    try {
        if (showing && !isTv() && onVideoPage()) {
            show();
            if (chip) { chip.setAttribute('data-osd', '1'); }
        } else if (!showing && !isTv() && onVideoPage() && timer && chip
            && chip.classList.contains('show') && degraded()) {
            // The OSD went away but the stream is degraded: the chip stays (and keeps polling;
            // tick() hides it when the video page goes away). Landscape CSS hides it anyway.
            chip.setAttribute('data-osd', '0');
        } else {
            if (chip) { chip.setAttribute('data-osd', '0'); }
            hide();
        }
    } catch (err) {
        log('enhance badge: osd callback failed', err);
    }
}

export function installPlayerBadge() {
    try {
        document._callbacks = document._callbacks || {};
        var list = document._callbacks[EVENT] = document._callbacks[EVENT] || [];
        list.push(onOsd);
        // The device line changes on its own (auto turning on, the governor stepping down):
        // follow it while the chip is up.
        onClientStatus(function () { if (timer) { render(); } });
        log('enhance badge installed');
    } catch (err) {
        log('enhance badge install failed', err);
    }
}
