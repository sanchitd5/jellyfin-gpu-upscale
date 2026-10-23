import { el } from '../lib/dom.js';

/*
 * THE ON-SCREEN FEEDBACK OF THE VIDEO PAGE GESTURES.
 *
 * Three small overlays, all fixed-position, pointer-events none (they never take a touch) and all
 * built lazily: the seek hint over the third that was double-tapped, the "2x" pill at the top
 * centre while a hold is playing at double speed, and the vertical level bar at the screen edge
 * while a swipe changes volume or brightness. The style is injected once, with the page rules the
 * gestures need.
 */

var PAGE = '#videoOsdPage';
var STYLE_ID = 'jellyfinPlusPlayerHudStyle';
var HINT_ID = 'jellyfinPlusSeekHint';
var PILL_ID = 'jellyfinPlusHoldPill';
var BAR_ID = 'jellyfinPlusLevelBar';

var HINT_MS = 650;
var BAR_LINGER_MS = 700;

var CSS = [
    // pan-x leaves horizontal panning and pinch-zoom to the browser and gives every vertical move
    // (the volume and brightness swipes) to the page, which is what keeps a vertical swipe from
    // being cancelled by a pan. It also stops the browser treating the second tap as a zoom.
    // The select/callout rules keep a long press from selecting text or opening a context menu.
    PAGE + ' { touch-action: pan-x pinch-zoom; -webkit-touch-callout: none; user-select: none; }',

    '#' + HINT_ID + ' { position: fixed; top: 0; bottom: 0; width: 33.34vw; display: flex;'
        + ' align-items: center; justify-content: center; pointer-events: none; z-index: 99998;'
        + ' opacity: 0; transition: opacity 0.15s; }',
    '#' + HINT_ID + '.show { opacity: 1; }',
    '#' + HINT_ID + ' .pill { display: flex; flex-direction: column; align-items: center;'
        + ' padding: 0.6em 1em; border-radius: 1.5em; color: #fff; background: rgba(0,0,0,0.55);'
        + ' font-size: 1.1em; }',
    '#' + HINT_ID + ' .material-icons, #' + BAR_ID + ' .material-icons { font-family: "Material Icons";'
        + ' font-feature-settings: "liga"; font-size: 2em; line-height: 1; }',

    '#' + PILL_ID + ' { position: fixed; top: calc(max(env(safe-area-inset-top, 0px), 12px) + 1em); left: 50%;'
        + ' transform: translateX(-50%); padding: 0.35em 0.9em; border-radius: 1.5em; color: #fff;'
        + ' background: rgba(0,0,0,0.6); font-size: 1.1em; font-weight: 600; letter-spacing: 0.05em;'
        + ' pointer-events: none; z-index: 99998; opacity: 0; transition: opacity 0.12s; }',
    '#' + PILL_ID + '.show { opacity: 1; }',

    '#' + BAR_ID + ' { position: fixed; top: 0; bottom: 0; width: 5em; display: flex;'
        + ' align-items: center; justify-content: center; pointer-events: none; z-index: 99998;'
        + ' opacity: 0; transition: opacity 0.15s; }',
    '#' + BAR_ID + '.show { opacity: 1; }',
    // Inset by the notch / rounded corner / gesture bar, and never less than 12px (P12).
    '#' + BAR_ID + '.volume { right: max(env(safe-area-inset-right, 0px), 12px); }',
    '#' + BAR_ID + '.brightness { left: max(env(safe-area-inset-left, 0px), 12px); }',
    '#' + BAR_ID + ' { padding-top: max(env(safe-area-inset-top, 0px), 12px);'
        + ' padding-bottom: max(env(safe-area-inset-bottom, 0px), 12px); box-sizing: border-box; }',
    '#' + BAR_ID + ' .pill { display: flex; flex-direction: column; align-items: center;'
        + ' padding: 0.7em 0.6em; border-radius: 1.5em; color: #fff; background: rgba(0,0,0,0.55); }',
    '#' + BAR_ID + ' .track { position: relative; width: 0.5em; height: 30vh; margin: 0.5em 0;'
        + ' border-radius: 0.25em; background: rgba(255,255,255,0.3); overflow: hidden; }',
    '#' + BAR_ID + ' .fill { position: absolute; left: 0; right: 0; bottom: 0; background: #fff; }',
    '#' + BAR_ID + ' .label { font-size: 0.9em; font-variant-numeric: tabular-nums; }',

    // The brightness swipe. Only present while the value is not 1, so a viewer who never uses it
    // (or put it back to 100%) gets no filter on the video element at all.
    'html.jp-brightness-on .videoPlayerContainer video, html.jp-brightness-on video.htmlvideoplayer'
        + ' { filter: brightness(var(--jp-brightness, 1)); }'
].join('\n');

/* Sets the brightness filter on the video (1 removes it). */
export function applyBrightness(b) {
    var root = document.documentElement;
    if (b === 1) {
        root.classList.remove('jp-brightness-on');
        root.style.removeProperty('--jp-brightness');
    } else {
        root.style.setProperty('--jp-brightness', String(b));
        root.classList.add('jp-brightness-on');
    }
}

export function ensureHudStyle() {
    if (document.getElementById(STYLE_ID)) { return; }
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
}

function overlay(id, build) {
    var node = document.getElementById(id);
    if (!node) {
        node = el('div');
        node.id = id;
        node.setAttribute('aria-hidden', 'true');
        build(node);
        document.body.appendChild(node);
    }

    return node;
}

/* ------------------------------------------------------------------ double-tap seek hint */

var hintTimer = null;
var hintTotal = 0;

/* dir is -1 or 1; seconds is the size of one step. Repeated taps add up in the label. */
export function showSeekHint(dir, seconds) {
    var hint = overlay(HINT_ID, function (n) {
        var pill = el('div', 'pill');
        pill.appendChild(el('span', 'material-icons', ''));
        pill.appendChild(el('span', 'label', ''));
        n.appendChild(pill);
    });

    hintTotal += dir * seconds;
    hint.style.left = dir < 0 ? '0' : 'auto';
    hint.style.right = dir > 0 ? '0' : 'auto';
    hint.querySelector('.material-icons').textContent = dir < 0 ? 'fast_rewind' : 'fast_forward';
    hint.querySelector('.label').textContent = (hintTotal > 0 ? '+' : '') + hintTotal + ' s';
    hint.classList.add('show');

    if (hintTimer) { clearTimeout(hintTimer); }
    hintTimer = setTimeout(function () {
        hint.classList.remove('show');
        hintTotal = 0;
        hintTimer = null;
    }, HINT_MS);
}

/* ------------------------------------------------------------------ hold-for-2x pill */

export function showHoldPill(rate) {
    var pill = overlay(PILL_ID, function () { /* text set below */ });
    pill.textContent = rate + '× ▶▶';
    pill.classList.add('show');
}

export function hideHoldPill() {
    var pill = document.getElementById(PILL_ID);
    if (pill) { pill.classList.remove('show'); }
}

/* ------------------------------------------------------------------ swipe level bar */

var barTimer = null;

/* kind is 'volume' or 'brightness'; level is 0..1; text is the label under the bar. */
export function showLevelBar(kind, level, text, icon) {
    var bar = overlay(BAR_ID, function (n) {
        var pill = el('div', 'pill');
        pill.appendChild(el('span', 'material-icons', ''));
        var track = el('div', 'track');
        track.appendChild(el('div', 'fill'));
        pill.appendChild(track);
        pill.appendChild(el('span', 'label', ''));
        n.appendChild(pill);
    });

    bar.className = kind + ' show';
    bar.querySelector('.material-icons').textContent = icon;
    bar.querySelector('.fill').style.height = Math.round(level * 100) + '%';
    bar.querySelector('.label').textContent = text;
    if (barTimer) { clearTimeout(barTimer); barTimer = null; }
}

/* Fades the bar a moment after the finger lifts. */
export function hideLevelBar() {
    if (barTimer) { clearTimeout(barTimer); }
    barTimer = setTimeout(function () {
        var bar = document.getElementById(BAR_ID);
        if (bar) { bar.classList.remove('show'); }
        barTimer = null;
    }, BAR_LINGER_MS);
}
