import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';
import { openEnhancePanel } from '../controller/playback-hooks.js';
import { currentItem } from '../controller/player-item.js';
import { syncFavorite, toggleFavorite } from '../controller/player-favorite.js';
import {
    cycleRotation, resetRotation, rotationAvailable, rotationFollowsItem, refreshRotation, cssRotation,
    installRotateListeners
} from '../controller/player-rotate.js';

/*
 * THE TOUCH OSD (proposal P4 b-d, P12): finger-sized OSD controls, a portrait layout that pulls
 * the controls up under the picture, and a lock for pocketing the phone. (The chip move, P4a, is
 * in controller/player-badge.js; the gesture edge dead zone, P4e, in model/player-gesture.js.)
 *
 * EVERYTHING HERE IS SCOPED to `html:not(.jp-theme-off):not(.layout-tv)`, and the sizing rules to
 * `(pointer: coarse)`, so the off switch (localStorage jellyfinPlus.mobileTheme=off, which the
 * theme module reflects as html.jp-theme-off) and the TV layout get stock untouched. Tier classes
 * (jp-phone / jp-tablet) are deliberately NOT required: a touch device in portrait is what
 * matters here, and an iPad is as much a "portrait strip" as a phone.
 *
 * (b) SIZES. Stock .videoOsdBottom buttons are paper-icon-button-light (mouse sized) and the
 * emby-slider thumb is 1.08em with a 1.25em tall container. On a coarse pointer: buttons get
 * min 44px (--jp-tap), the thumb is 20px, the slider container 44px tall (the input fills it, so
 * the hit area is 44px), the time texts use --jp-font-small.
 *
 * (c) PORTRAIT. A video wider than the viewport, on a portrait touch screen, is a strip in the
 * middle with the OSD bar at the very bottom. While the video page is up in that state this module
 * sets html.jp-portrait-osd and --jp-pv-h (the picture's height, from videoWidth/videoHeight):
 * the video is pinned to the top (object-position), .videoOsdBottom is moved to top: picture
 * height (so it sits under the picture), and a dock at the bottom carries an Enhance shortcut.
 * The bar keeps its own opacity transition, so stock's videoOsdBottom-hidden toggling still
 * works; only its position changes. Nothing is measured except the video's own size. Leaving the
 * state (rotate, a different video, the video goes away) removes the class and stock layout
 * returns.
 *
 * --jp-osd-clear is the one measurement the chip (player-badge.js) and the clip Up Next card
 * (clip-upnext.js) both anchor on: the distance from the bottom of the viewport to the top of
 * the OSD controls (or of the dock in portrait). It is set while the video page is up.
 *
 * (d) LOCK. A button (and, while locked, the only thing left) toggles html.jp-player-locked.
 * Locked: the plugin's gestures ignore every press (controller/player-gestures.js checks the
 * class), and a capture-phase listener keeps stock's tap-to-toggle, double-click fullscreen and
 * mouse play/pause from seeing presses on the video page. Controls, the lock button itself and
 * the OS stay normal. The lock is dropped when the video page goes away.
 *
 * SEAMS (all in the built 12.3 client): #videoOsdPage, .videoOsdBottom, .videoOsdBottom-hidden,
 * .osdControls, .osdPositionSlider / .mdl-slider / .mdl-slider-container, .osdTimeText /
 * .osdPositionText / .osdDurationText, the SHOW_VIDEO_OSD event the player badge already uses.
 * A missing seam means no class, no variable: stock.
 */

var STYLE_ID = 'jellyfinPlusPortraitOsdStyle';
var DOCK_ID = 'jellyfinPlusPortraitDock';
var LOCK_ID = 'jellyfinPlusPlayerLock';
var FAV_ID = 'jellyfinPlusPlayerFavorite';
var ROT_ID = 'jellyfinPlusPlayerRotate';
var PAGE_ID = 'videoOsdPage';
var EVENT = 'SHOW_VIDEO_OSD';
var POLL_MS = 1000;
// A picture less than this fraction of the viewport height is "a strip": worth the portrait layout.
var STRIP_MAX_FRACTION = 0.6;
var DOCK_PX = 56;

var P = 'html:not(.jp-theme-off):not(.layout-tv)';

var CSS = [
    // (b) sizes
    '@media (pointer: coarse) {',
    '  ' + P + ' .videoOsdBottom .paper-icon-button-light { min-width: var(--jp-tap, 44px); min-height: var(--jp-tap, 44px); }',
    '  ' + P + ' .videoOsdBottom .mdl-slider-container { height: var(--jp-tap, 44px); }',
    '  ' + P + ' .videoOsdBottom .mdl-slider-container .mdl-slider { height: 100%; }',
    '  ' + P + ' .videoOsdBottom .mdl-slider-background-flex-container { padding: 0 10px; }',
    '  ' + P + ' .videoOsdBottom .mdl-slider::-webkit-slider-thumb { width: 20px; height: 20px; }',
    '  ' + P + ' .videoOsdBottom .mdl-slider::-moz-range-thumb { width: 20px; height: 20px; }',
    '  ' + P + ' .videoOsdBottom .osdPositionText, ' + P + ' .videoOsdBottom .osdDurationText,',
    '  ' + P + ' .videoOsdBottom .osdTimeText { font-size: var(--jp-font-small, 0.9em); }',
    '}',

    // The lock button: bottom-right above the OSD controls, like the chip on the left.
    // Three round buttons in a row bottom-right above the OSD controls (heart rightmost, then the
    // lock, then rotate), mirroring the chip on the left. In portrait they sit in the dock row.
    '.jp-osdbtn { position: fixed; z-index: 99991; box-sizing: border-box; display: none; align-items: center;'
        + ' justify-content: center; width: var(--jp-tap, 44px); height: var(--jp-tap, 44px); padding: 0; border: 0;'
        + ' border-radius: 50%; color: #fff; background: rgba(0,0,0,0.55); cursor: pointer;'
        + ' --jp-btn-r: calc(max(env(safe-area-inset-right, 0px), 12px) + 4px);'
        + ' bottom: calc(var(--jp-osd-clear, 9em) + 8px);'
        + ' opacity: 0; visibility: hidden; transition: opacity var(--jp-dur, 0.2s), visibility var(--jp-dur, 0.2s); }',
    '.jp-osdbtn .material-icons { font-family: "Material Icons"; font-feature-settings: "liga"; font-size: 24px; line-height: 1; }',
    '#' + FAV_ID + ' { right: var(--jp-btn-r); }',
    '#' + LOCK_ID + ' { right: calc(var(--jp-btn-r) + var(--jp-tap, 44px) + 8px); }',
    '#' + ROT_ID + ' { right: calc(var(--jp-btn-r) + 2 * (var(--jp-tap, 44px) + 8px)); }',
    '#' + FAV_ID + '[aria-pressed="true"] { color: #ff6b81; }',
    'html.jp-video-page.jp-fav-ok:not(.jp-theme-off):not(.layout-tv) #' + FAV_ID + ' { display: flex; }',
    '@media (pointer: coarse) {',
    '  html.jp-video-page:not(.jp-theme-off):not(.layout-tv) #' + LOCK_ID + ' { display: flex; }',
    '  html.jp-video-page:not(.jp-desktop):not(.jp-rot-broken):not(.jp-theme-off):not(.layout-tv) #' + ROT_ID + ' { display: flex; }',
    '}',
    'html.jp-osd-on:not(.jp-player-locked) .jp-osdbtn, html.jp-player-locked #' + LOCK_ID + ' { opacity: 1; visibility: visible; }',
    // Locked and the OSD is out of the way: the unlock button stays, quietly.
    'html.jp-player-locked:not(.jp-osd-on) #' + LOCK_ID + ' { opacity: 0.45; }',

    // (c) portrait
    'html.jp-portrait-osd:not(.jp-theme-off):not(.layout-tv) .videoPlayerContainer video,'
        + ' html.jp-portrait-osd:not(.jp-theme-off):not(.layout-tv) video.htmlvideoplayer'
        + ' { object-position: 50% 0; box-sizing: border-box; padding-top: env(safe-area-inset-top, 0px); }',
    'html.jp-portrait-osd:not(.jp-theme-off):not(.layout-tv) .videoOsdBottom { top: calc(env(safe-area-inset-top, 0px) + var(--jp-pv-h, 56.25vw));'
        + ' bottom: auto; padding-top: 0; background: none; }',
    'html.jp-portrait-osd:not(.jp-theme-off):not(.layout-tv) .osdControls { padding-top: 0.4em; }',

    '#' + DOCK_ID + ' { position: fixed; left: 0; right: 0; bottom: 0; z-index: 99991; box-sizing: border-box; display: none;'
        + ' align-items: center; gap: 0.6em; height: calc(' + DOCK_PX + 'px + env(safe-area-inset-bottom, 0px));'
        + ' padding: 0 calc(3 * var(--jp-tap, 44px) + 24px + max(env(safe-area-inset-right, 0px), 12px) + 12px) env(safe-area-inset-bottom, 0px)'
        + ' max(env(safe-area-inset-left, 0px), 12px); pointer-events: none;'
        + ' opacity: 0; visibility: hidden; transition: opacity var(--jp-dur, 0.2s), visibility var(--jp-dur, 0.2s); }',
    'html.jp-portrait-osd.jp-osd-on:not(.jp-theme-off):not(.layout-tv) #' + DOCK_ID + ' { display: flex; opacity: 1; visibility: visible; }',
    'html.jp-portrait-osd:not(.jp-theme-off):not(.layout-tv) #' + DOCK_ID + ' { display: flex; }',
    '#' + DOCK_ID + ' button { pointer-events: auto; min-height: var(--jp-tap, 44px); padding: 0 1em; border: 0;'
        + ' border-radius: 1.4em; color: #fff; background: rgba(255,255,255,0.14); font: inherit; cursor: pointer; }',
    // In portrait the buttons live in the dock row, bottom-right.
    'html.jp-portrait-osd .jp-osdbtn { bottom: calc(env(safe-area-inset-bottom, 0px) + ' + ((DOCK_PX - 44) / 2) + 'px); }'
].join('\n');

var dock = null;
var lock = null;
var fav = null;
var rot = null;
var timer = 0;
var osdOn = false;
var wired = false;

function root() { return document.documentElement; }

function isTv() { return root().classList.contains('layout-tv'); }

function themeOff() { return root().classList.contains('jp-theme-off'); }

function page() {
    var p = document.getElementById(PAGE_ID);
    return p && p.getClientRects().length > 0 ? p : null;
}

function coarse() {
    try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; }
}

function ensureStyle() {
    if (document.getElementById(STYLE_ID)) { return; }
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
}

function setLocked(on) {
    root().classList.toggle('jp-player-locked', !!on);
    if (lock) {
        lock.setAttribute('aria-pressed', on ? 'true' : 'false');
        lock.setAttribute('aria-label', on ? 'Unlock the player' : 'Lock the player');
        lock.title = lock.getAttribute('aria-label');
        lock.firstChild.textContent = on ? 'lock' : 'lock_open';
    }
}

function osdButton(id, icon, label, onClick) {
    var b = el('button', 'jp-osdbtn');
    b.id = id;
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.appendChild(el('span', 'material-icons', icon));
    b.addEventListener('click', function (e) {
        e.stopPropagation();
        try { onClick(); } catch (err) { log('portrait osd: button failed', err); }
    });
    b.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    document.body.appendChild(b);
    return b;
}

function updateFavoriteButton() {
    var f = syncFavorite(updateFavoriteButton);
    root().classList.toggle('jp-fav-ok', f.available && f.fav !== null);
    if (fav && f.available && f.fav !== null) {
        var label = f.fav ? 'Remove from favourites' : 'Add to favourites';
        fav.setAttribute('aria-pressed', f.fav ? 'true' : 'false');
        fav.setAttribute('aria-label', label);
        fav.title = label;
        fav.firstChild.textContent = f.fav ? 'favorite' : 'favorite_border';
    }
}

function ensureControls() {
    if (!lock || !lock.isConnected) {
        lock = el('button', 'jp-osdbtn');
        lock.id = LOCK_ID;
        lock.type = 'button';
        lock.appendChild(el('span', 'material-icons', 'lock_open'));
        lock.addEventListener('click', function (e) {
            e.stopPropagation();
            setLocked(!root().classList.contains('jp-player-locked'));
        });
        // A press here is not a tap on the video.
        lock.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        document.body.appendChild(lock);
        setLocked(root().classList.contains('jp-player-locked'));
    }

    if (!fav || !fav.isConnected) {
        fav = osdButton(FAV_ID, 'favorite_border', 'Favourite', function () {
            toggleFavorite(updateFavoriteButton);
        });
        fav.setAttribute('aria-pressed', 'false');
    }

    if (!rot || !rot.isConnected) {
        rot = osdButton(ROT_ID, 'screen_rotation', 'Rotate the video', function () {
            var item = currentItem();
            cycleRotation(item && item.Id).then(function () { update(); });
        });
    }

    if (!dock || !dock.isConnected) {
        dock = el('div');
        dock.id = DOCK_ID;
        var enhance = el('button', null, 'Enhance');
        enhance.type = 'button';
        enhance.addEventListener('click', function (e) {
            e.stopPropagation();
            try { openEnhancePanel(); } catch (err) { log('portrait osd: enhance failed', err); }
        });
        dock.appendChild(enhance);
        dock.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        document.body.appendChild(dock);
    }
}

/* The picture's height in px when it is a strip on a portrait touch screen, else 0. */
function stripHeight() {
    // A rotated page (player-rotate.js) is a landscape picture whatever the screen says.
    if (!coarse() || window.innerHeight <= window.innerWidth || cssRotation()) { return 0; }
    var v = document.querySelector('#' + PAGE_ID + ' video, video.htmlvideoplayer');
    if (!v || !(v.videoWidth > 0) || !(v.videoHeight > 0)) { return 0; }
    var h = window.innerWidth * v.videoHeight / v.videoWidth;
    return h <= window.innerHeight * STRIP_MAX_FRACTION ? Math.round(h) : 0;
}

function setVar(name, value) {
    if (value == null) { root().style.removeProperty(name); } else { root().style.setProperty(name, value); }
}

function update() {
    try {
        var on = !!page() && !isTv() && !themeOff();
        root().classList.toggle('jp-video-page', on);
        if (!on) {
            root().classList.remove('jp-portrait-osd', 'jp-osd-on', 'jp-fav-ok');
            setVar('--jp-pv-h', null);
            setVar('--jp-osd-clear', null);
            if (root().classList.contains('jp-player-locked')) { setLocked(false); }
            // Playback stopped or the viewer left the page: the rotation (and its lock) end.
            resetRotation();
            osdOn = false;
            return;
        }

        ensureControls();
        var item = currentItem();
        rotationFollowsItem(item && item.Id);
        refreshRotation();
        root().classList.toggle('jp-rot-broken', !rotationAvailable());
        updateFavoriteButton();
        var h = stripHeight();
        root().classList.toggle('jp-portrait-osd', h > 0);
        setVar('--jp-pv-h', h > 0 ? h + 'px' : null);

        var anchor = h > 0 ? dock : document.querySelector('.videoOsdBottom .osdControls');
        var r = anchor && anchor.getBoundingClientRect();
        // An unlaid-out or hidden anchor reports an empty rect: keep the CSS fallback then.
        // Rects are screen coordinates; with the page rotated, the content's top edge is the
        // screen rect's right (+90) or left (-90) side, and the content is innerWidth tall.
        var rotation = cssRotation();
        var contentH = rotation ? window.innerWidth : window.innerHeight;
        var top = !r ? 0 : (rotation === 90 ? window.innerWidth - r.right : (rotation === -90 ? r.left : r.top));
        setVar('--jp-osd-clear', r && r.height > 0 ? Math.max(0, Math.round(contentH - top)) + 'px' : null);
    } catch (err) {
        log('portrait osd: update failed', err);
    }
}

function onOsd(e, showing) {
    osdOn = !!showing;
    root().classList.toggle('jp-osd-on', osdOn && !!page());
    update();
}

/* Locked: stock must not see presses on the video page (tap toggles the OSD, double-click goes
 * fullscreen, a mouse press pauses). The lock button and the dock stop their own events first. */
function blockWhenLocked(e) {
    if (!root().classList.contains('jp-player-locked')) { return; }
    var t = e.target;
    if (t && t.closest && t.closest('#' + LOCK_ID) && e.type !== 'dblclick') { return; }
    if (t && t.closest && t.closest('#' + PAGE_ID)) {
        e.stopPropagation();
        if (e.cancelable && e.type !== 'pointerdown') { e.preventDefault(); }
    }
}

export function installPortraitOsd() {
    try {
        if (wired) { return; }
        wired = true;
        ensureStyle();
        installRotateListeners();
        document._callbacks = document._callbacks || {};
        (document._callbacks[EVENT] = document._callbacks[EVENT] || []).push(onOsd);
        ['pointerdown', 'click', 'dblclick'].forEach(function (t) {
            document.addEventListener(t, blockWhenLocked, true);
        });
        window.addEventListener('resize', update);
        window.addEventListener('orientationchange', update);
        // Media events do not bubble; the capture phase sees them. The size is known at metadata.
        document.addEventListener('loadedmetadata', update, true);
        timer = setInterval(update, POLL_MS);
        update();
        log('portrait osd installed');
    } catch (err) {
        log('portrait osd install failed', err);
    }
}
