/*
 * THE GESTURE ARBITER FOR THE VIDEO PAGE (pure: no DOM, no clock, no player).
 *
 * One press on the video surface can become exactly one of:
 *
 *   tap         a short press that moved little. The stock handler gets it, unchanged.
 *   double tap  a second (or later) tap on the same side third within DOUBLE_TAP_MS: a seek.
 *   hold        a press that stays put for HOLD_MS: play at 2x until it is released.
 *   swipe       a touch that moves mostly vertically past HOLD_SLOP_PX: volume (right half) or
 *               brightness (left half).
 *   pass        anything else (a horizontal move, a mouse drag, a refused hold or swipe): the
 *               stock handler gets it, late.
 *
 * The first of {the slop being exceeded, the hold timer, the release} decides, so the outcomes
 * cannot overlap. The controller swallows the stock pointerdown for every press it tracks and
 * replays it when the verdict is tap or pass, which is the only way a hold and a swipe can avoid
 * the stock OSD toggle (touch) and play/pause (mouse); see controller/player-gestures.js.
 *
 * Every number is here, in THRESHOLDS, and tested in player-gesture.test.mjs.
 */

export var THRESHOLDS = {
    // A press that stays within HOLD_SLOP_PX for this long is a hold.
    HOLD_MS: 400,
    // Finger jitter below this is still "the same press". Under the browser's own pan slop, so a
    // vertical swipe is classified here before the browser could take the gesture over.
    HOLD_SLOP_PX: 10,
    // Two taps closer than this (down to down) and within DOUBLE_TAP_SLOP_PX are a double tap.
    // Under the stock 300 ms OSD debounce on purpose.
    DOUBLE_TAP_MS: 280,
    DOUBLE_TAP_SLOP_PX: 60,
    // |dy| must be at least this many times |dx| for the move to count as a vertical swipe.
    VERTICAL_RATIO: 1.5,
    // Fraction of the page height that sweeps the whole 0..1 range.
    SWIPE_RANGE: 0.7
};

export var HOLD_RATE = 2;

// Brightness is a CSS filter on the video: below 1 darkens, above 1 brightens.
export var BRIGHTNESS_MIN = 0.3;
export var BRIGHTNESS_MAX = 1.5;
// Within this of 1 the value snaps to 1, so "no filter" is reachable and the filter can be dropped.
var BRIGHTNESS_SNAP = 0.03;

/* -1 left third, 1 right third, 0 middle. */
export function zoneOf(x, width) {
    if (!(width > 0)) { return 0; }
    return x < width / 3 ? -1 : (x > width * 2 / 3 ? 1 : 0);
}

/* Left half is brightness, right half is volume. */
export function swipeKind(x, width) {
    return x < width / 2 ? 'brightness' : 'volume';
}

function clamp01(v) {
    return v < 0 ? 0 : (v > 1 ? 1 : v);
}

/* The level (0..1) a swipe of dy pixels (negative is up) reaches from a starting level. */
export function swipeLevel(base, dy, height) {
    if (!(height > 0)) { return clamp01(base); }
    return clamp01(base - dy / (height * THRESHOLDS.SWIPE_RANGE));
}

export function brightnessToLevel(b) {
    return clamp01((b - BRIGHTNESS_MIN) / (BRIGHTNESS_MAX - BRIGHTNESS_MIN));
}

export function levelToBrightness(level) {
    var b = BRIGHTNESS_MIN + clamp01(level) * (BRIGHTNESS_MAX - BRIGHTNESS_MIN);
    b = Math.round(b * 100) / 100;
    return Math.abs(b - 1) <= BRIGHTNESS_SNAP ? 1 : b;
}

/* A stored brightness, or 1 when it is missing or out of range (never trust storage). */
export function parseBrightness(raw) {
    var b = parseFloat(raw);
    return (isFinite(b) && b >= BRIGHTNESS_MIN && b <= BRIGHTNESS_MAX) ? b : 1;
}

/*
 * The arbiter. Events carry plain data; every method returns the action the controller must
 * take, or null. Actions:
 *
 *   down()      { doubleTap: -1|0|1, continuing }  (the press is always swallowed)
 *   move()      { type: 'swipe-start', kind } | { type: 'swipe', dy } | { type: 'replay' } | null
 *   holdTimeout { type: 'hold-start' } | null
 *   up()        { type: 'replay' } (a tap) | { type: 'hold-end' } | { type: 'swipe-end' } | null
 *   cancel()    as up(), except a cancelled touch that never decided is replayed (the browser
 *               took it for a horizontal pan, which stock treats as a tap on the OSD)
 *   refuse()    { type: 'replay' }: the controller could not do the hold or swipe it was told to
 */
export function createArbiter() {
    var T = THRESHOLDS;
    var phase = 'idle'; // idle | pending | hold | swipe | consumed | passed
    var g = null;       // the press: { t, x, y, width, touch, third }
    var sw = null;      // the swipe: { kind, y0 }
    var last = null;    // the previous tap: { third, t, x, y, chained }

    function reset() {
        phase = 'idle';
        g = null;
        sw = null;
    }

    return {
        phase: function () { return phase; },

        /* A press on something that is not the video surface breaks a tap chain. */
        forgetTaps: function () { last = null; },

        down: function (p) {
            phase = 'pending';
            sw = null;
            g = { t: p.t, x: p.x, y: p.y, width: p.width, touch: !!p.touch, third: zoneOf(p.x, p.width) };

            if (g.touch && g.third && last && last.third === g.third
                && p.t - last.t <= T.DOUBLE_TAP_MS
                && Math.abs(p.x - last.x) <= T.DOUBLE_TAP_SLOP_PX
                && Math.abs(p.y - last.y) <= T.DOUBLE_TAP_SLOP_PX) {
                var continuing = last.chained;
                last = { third: g.third, t: p.t, x: p.x, y: p.y, chained: true };
                phase = 'consumed';
                return { doubleTap: g.third, continuing: continuing };
            }

            last = null;
            return { doubleTap: 0, continuing: false };
        },

        move: function (p) {
            if (phase === 'swipe') {
                return { type: 'swipe', dy: p.y - sw.y0 };
            }

            if (phase !== 'pending') { return null; }

            var dx = p.x - g.x;
            var dy = p.y - g.y;
            if (Math.max(Math.abs(dx), Math.abs(dy)) <= T.HOLD_SLOP_PX) { return null; }

            if (g.touch && Math.abs(dy) >= Math.abs(dx) * T.VERTICAL_RATIO) {
                phase = 'swipe';
                sw = { kind: swipeKind(g.x, g.width), y0: p.y };
                return { type: 'swipe-start', kind: sw.kind };
            }

            // Horizontal, diagonal, or a mouse drag: nothing of ours, so stock gets its press.
            phase = 'passed';
            return { type: 'replay' };
        },

        holdTimeout: function () {
            if (phase !== 'pending') { return null; }
            phase = 'hold';
            return { type: 'hold-start' };
        },

        refuse: function () {
            if (phase === 'pending' || phase === 'hold' || phase === 'swipe') {
                phase = 'passed';
                return { type: 'replay' };
            }

            return null;
        },

        up: function () {
            var was = phase;
            var press = g;
            reset();
            if (was === 'pending') {
                last = (press.touch && press.third)
                    ? { third: press.third, t: press.t, x: press.x, y: press.y, chained: false }
                    : null;
                return { type: 'replay' };
            }

            if (was === 'hold') { return { type: 'hold-end' }; }
            if (was === 'swipe') { return { type: 'swipe-end' }; }
            return null;
        },

        cancel: function () {
            var was = phase;
            var press = g;
            reset();
            last = null;
            if (was === 'pending') { return press.touch ? { type: 'replay' } : null; }
            if (was === 'hold') { return { type: 'hold-end' }; }
            if (was === 'swipe') { return { type: 'swipe-end' }; }
            return null;
        }
    };
}
