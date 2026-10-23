// Run: node web/src/model/player-gesture.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import {
    THRESHOLDS as T, HOLD_RATE, createArbiter, zoneOf, swipeKind, swipeLevel,
    brightnessToLevel, levelToBrightness, parseBrightness, BRIGHTNESS_MIN, BRIGHTNESS_MAX,
    inEdgeZone, toContent
} from './player-gesture.js';

var passed = 0;
function t(name, fn) {
    try {
        fn();
        passed++;
        console.log('ok   ' + name);
    } catch (e) {
        console.log('FAIL ' + name + '\n' + e.message);
        process.exitCode = 1;
    }
}

var W = 900;
var H = 400;
function touch(x, y, at) { return { t: at || 0, x: x, y: y, width: W, touch: true }; }
function mouse(x, y, at) { return { t: at || 0, x: x, y: y, width: W, touch: false }; }

t('thresholds keep the documented ordering', function () {
    assert.ok(T.DOUBLE_TAP_MS < 300, 'under the stock 300 ms OSD debounce');
    assert.ok(T.HOLD_MS > T.DOUBLE_TAP_MS, 'a hold is longer than the double-tap window');
    assert.ok(T.HOLD_SLOP_PX < 15, 'under the browser pan slop');
    assert.equal(HOLD_RATE, 2);
});

t('thirds and halves', function () {
    assert.equal(zoneOf(10, W), -1);
    assert.equal(zoneOf(450, W), 0);
    assert.equal(zoneOf(890, W), 1);
    assert.equal(zoneOf(300, W), 0);
    assert.equal(zoneOf(301, W), 0);
    assert.equal(zoneOf(10, 0), 0);
    assert.equal(swipeKind(449, W), 'brightness');
    assert.equal(swipeKind(450, W), 'volume');
});

t('a quick press and release is a tap: replayed to stock', function () {
    var a = createArbiter();
    assert.deepEqual(a.down(touch(100, 200)), { doubleTap: 0, continuing: false });
    assert.equal(a.phase(), 'pending');
    assert.deepEqual(a.up(), { type: 'replay' });
    assert.equal(a.phase(), 'idle');
});

t('jitter inside the slop stays a tap', function () {
    var a = createArbiter();
    a.down(touch(100, 200));
    assert.equal(a.move({ x: 100 + T.HOLD_SLOP_PX, y: 200 - T.HOLD_SLOP_PX, t: 50 }), null);
    assert.deepEqual(a.up(), { type: 'replay' });
});

t('holding still for HOLD_MS is a hold; release ends it and is never replayed', function () {
    var a = createArbiter();
    a.down(touch(450, 200));
    assert.deepEqual(a.holdTimeout(), { type: 'hold-start' });
    assert.equal(a.phase(), 'hold');
    assert.equal(a.move({ x: 450, y: 260, t: 900 }), null, 'moving during a hold changes nothing');
    assert.deepEqual(a.up(), { type: 'hold-end' });
    assert.equal(a.phase(), 'idle');
});

t('a hold needs the timer: a late timer after release does nothing', function () {
    var a = createArbiter();
    a.down(touch(450, 200));
    a.up();
    assert.equal(a.holdTimeout(), null);
});

t('a hold on the mouse works the same', function () {
    var a = createArbiter();
    a.down(mouse(450, 200));
    assert.deepEqual(a.holdTimeout(), { type: 'hold-start' });
    assert.deepEqual(a.up(), { type: 'hold-end' });
});

t('a refused hold (paused video) replays the press and then the release is quiet', function () {
    var a = createArbiter();
    a.down(touch(450, 200));
    a.holdTimeout();
    assert.deepEqual(a.refuse(), { type: 'replay' });
    assert.equal(a.up(), null);
});

t('a vertical touch move past the slop starts a swipe on the side it began on', function () {
    var a = createArbiter();
    a.down(touch(100, 300));
    assert.deepEqual(a.move({ x: 102, y: 300 - T.HOLD_SLOP_PX - 1, t: 40 }), { type: 'swipe-start', kind: 'brightness' });
    assert.deepEqual(a.move({ x: 104, y: 200, t: 80 }), { type: 'swipe', dy: 200 - (300 - T.HOLD_SLOP_PX - 1) });
    assert.deepEqual(a.up(), { type: 'swipe-end' });

    var b = createArbiter();
    b.down(touch(800, 300));
    assert.equal(b.move({ x: 800, y: 280, t: 40 }).kind, 'volume');
});

t('the swipe starts from where it was recognised, so there is no jump', function () {
    var a = createArbiter();
    a.down(touch(800, 300));
    var start = a.move({ x: 800, y: 280, t: 40 });
    assert.equal(start.type, 'swipe-start');
    assert.deepEqual(a.move({ x: 800, y: 280, t: 41 }), { type: 'swipe', dy: 0 });
});

t('a swipe is vertical only when |dy| clears VERTICAL_RATIO times |dx|', function () {
    var a = createArbiter();
    a.down(touch(100, 300));
    // dy 20, dx 18: ratio 1.1, below 1.5: horizontal-ish, stock gets it
    assert.deepEqual(a.move({ x: 118, y: 280, t: 30 }), { type: 'replay' });
    assert.equal(a.up(), null, 'already replayed');

    var b = createArbiter();
    b.down(touch(100, 300));
    assert.equal(b.move({ x: 112, y: 280, t: 30 }).type, 'swipe-start'); // 20 vs 12: 1.67
});

t('a horizontal touch move is stock: replayed at once, release quiet', function () {
    var a = createArbiter();
    a.down(touch(100, 300));
    assert.deepEqual(a.move({ x: 150, y: 302, t: 30 }), { type: 'replay' });
    assert.equal(a.phase(), 'passed');
    assert.equal(a.move({ x: 200, y: 400, t: 60 }), null, 'a passed press never becomes a swipe');
    assert.equal(a.holdTimeout(), null);
    assert.equal(a.up(), null);
});

t('the mouse never swipes: a drag past the slop is a pass', function () {
    var a = createArbiter();
    a.down(mouse(100, 300));
    assert.deepEqual(a.move({ x: 100, y: 200, t: 30 }), { type: 'replay' });
});

t('a refused swipe (volume on iOS) is replayed and the rest of the touch is quiet', function () {
    var a = createArbiter();
    a.down(touch(800, 300));
    assert.equal(a.move({ x: 800, y: 270, t: 30 }).type, 'swipe-start');
    assert.deepEqual(a.refuse(), { type: 'replay' });
    assert.equal(a.move({ x: 800, y: 100, t: 60 }), null);
    assert.equal(a.up(), null);
});

t('a swipe beats the hold timer, a hold beats a late move', function () {
    var a = createArbiter();
    a.down(touch(800, 300));
    a.move({ x: 800, y: 270, t: 100 });
    assert.equal(a.holdTimeout(), null, 'the timer fires after the swipe was decided');
});

t('double tap on a side third: the second tap is consumed, the first was a tap', function () {
    var a = createArbiter();
    a.down(touch(800, 200, 1000));
    assert.deepEqual(a.up(), { type: 'replay' });
    var r = a.down(touch(805, 205, 1200));
    assert.deepEqual(r, { doubleTap: 1, continuing: false });
    assert.equal(a.phase(), 'consumed');
    assert.equal(a.holdTimeout(), null, 'no hold on a consumed tap');
    assert.equal(a.up(), null);
});

t('a chain: later taps continue and keep the side', function () {
    var a = createArbiter();
    a.down(touch(50, 200, 0)); a.up();
    assert.deepEqual(a.down(touch(50, 200, 150)), { doubleTap: -1, continuing: false });
    a.up();
    assert.deepEqual(a.down(touch(55, 200, 300)), { doubleTap: -1, continuing: true });
    a.up();
    assert.deepEqual(a.down(touch(55, 200, 450)), { doubleTap: -1, continuing: true });
});

t('too slow, too far, other side, or middle third: not a double tap', function () {
    var a = createArbiter();
    a.down(touch(800, 200, 0)); a.up();
    assert.equal(a.down(touch(800, 200, T.DOUBLE_TAP_MS + 1)).doubleTap, 0, 'too slow');
    a.up();

    a.down(touch(800, 200, 1000)); a.up();
    assert.equal(a.down(touch(800 - T.DOUBLE_TAP_SLOP_PX - 1, 200, 1100)).doubleTap, 0, 'too far (and not on the same third)');
    a.up();

    a.down(touch(800, 200, 2000)); a.up();
    assert.equal(a.down(touch(50, 200, 2100)).doubleTap, 0, 'other side');
    a.up();

    a.down(touch(450, 200, 3000)); a.up();
    assert.equal(a.down(touch(450, 200, 3100)).doubleTap, 0, 'the middle third is stock');
});

t('a hold or a swipe is not a first tap of a pair', function () {
    var a = createArbiter();
    a.down(touch(800, 200, 0));
    a.holdTimeout();
    a.up();
    assert.equal(a.down(touch(800, 200, 100)).doubleTap, 0);
    a.cancel();

    var b = createArbiter();
    b.down(touch(800, 200, 0));
    b.move({ x: 800, y: 150, t: 20 });
    b.up();
    assert.equal(b.down(touch(800, 200, 100)).doubleTap, 0);
});

t('mouse taps never double-tap-seek', function () {
    var a = createArbiter();
    a.down(mouse(800, 200, 0)); a.up();
    assert.equal(a.down(mouse(800, 200, 100)).doubleTap, 0);
});

t('forgetTaps breaks a pair (a press on a control in between)', function () {
    var a = createArbiter();
    a.down(touch(800, 200, 0)); a.up();
    a.forgetTaps();
    assert.equal(a.down(touch(800, 200, 100)).doubleTap, 0);
});

t('cancel: an undecided touch is replayed, an undecided mouse press is not, hold and swipe end', function () {
    var a = createArbiter();
    a.down(touch(100, 200));
    assert.deepEqual(a.cancel(), { type: 'replay' });
    a.down(mouse(100, 200));
    assert.equal(a.cancel(), null);
    a.down(touch(450, 200));
    a.holdTimeout();
    assert.deepEqual(a.cancel(), { type: 'hold-end' });
    a.down(touch(100, 200));
    a.move({ x: 100, y: 150, t: 10 });
    assert.deepEqual(a.cancel(), { type: 'swipe-end' });
    assert.equal(a.phase(), 'idle');
});

t('a new press after a lost release starts clean once cancelled', function () {
    var a = createArbiter();
    a.down(touch(450, 200));
    a.holdTimeout();
    assert.deepEqual(a.cancel(), { type: 'hold-end' });
    assert.deepEqual(a.down(touch(100, 200)), { doubleTap: 0, continuing: false });
    assert.equal(a.phase(), 'pending');
});

t('swipeLevel: up raises, down lowers, clamped, full range is SWIPE_RANGE of the height', function () {
    var full = H * T.SWIPE_RANGE;
    assert.equal(swipeLevel(0.5, 0, H), 0.5);
    assert.ok(Math.abs(swipeLevel(0, -full, H) - 1) < 1e-9);
    assert.ok(Math.abs(swipeLevel(1, full, H) - 0) < 1e-9);
    assert.equal(swipeLevel(0.9, -1000, H), 1);
    assert.equal(swipeLevel(0.1, 1000, H), 0);
    assert.ok(swipeLevel(0.5, -40, H) > 0.5);
    assert.ok(swipeLevel(0.5, 40, H) < 0.5);
    assert.equal(swipeLevel(0.4, -100, 0), 0.4, 'no height, no change');
});

t('brightness maps 0.3..1.5 to 0..1 and snaps to 1', function () {
    assert.equal(brightnessToLevel(BRIGHTNESS_MIN), 0);
    assert.equal(brightnessToLevel(BRIGHTNESS_MAX), 1);
    assert.equal(brightnessToLevel(0), 0);
    assert.equal(brightnessToLevel(9), 1);
    assert.equal(levelToBrightness(0), BRIGHTNESS_MIN);
    assert.equal(levelToBrightness(1), BRIGHTNESS_MAX);
    assert.equal(levelToBrightness(brightnessToLevel(1)), 1);
    assert.equal(levelToBrightness(brightnessToLevel(1.02)), 1, 'near 1 snaps');
    assert.equal(levelToBrightness(brightnessToLevel(1.1)), 1.1);
    assert.equal(levelToBrightness(-5), BRIGHTNESS_MIN);
});

t('a stored brightness is trusted only inside the range', function () {
    assert.equal(parseBrightness('0.8'), 0.8);
    assert.equal(parseBrightness(null), 1);
    assert.equal(parseBrightness('abc'), 1);
    assert.equal(parseBrightness('0.05'), 1);
    assert.equal(parseBrightness('7'), 1);
});

t('the edge dead zone is 24 px on both sides', function () {
    assert.equal(T.EDGE_DEAD_PX, 24);
    assert.equal(inEdgeZone(0, W), true);
    assert.equal(inEdgeZone(23, W), true);
    assert.equal(inEdgeZone(24, W), false);
    assert.equal(inEdgeZone(W - 24, W), false);
    assert.equal(inEdgeZone(W - 23, W), true);
    assert.equal(inEdgeZone(5, 0), false, 'no width: never an edge');
});

t('a touch in the edge zone is passed: no hold, no swipe, no double tap', function () {
    var a = createArbiter();
    assert.deepEqual(a.down(touch(10, 200)), { doubleTap: 0, continuing: false, edge: true });
    assert.equal(a.phase(), 'passed');
    assert.equal(a.holdTimeout(), null, 'the hold timer does nothing');
    assert.equal(a.move({ t: 50, x: 10, y: 60 }), null, 'a vertical drag from the edge is not a brightness swipe');
    assert.equal(a.up(), null);
    assert.equal(a.phase(), 'idle');
    var b = createArbiter();
    assert.equal(b.down(touch(W - 5, 200)).edge, true, 'right edge too');
});

t('an edge press breaks a tap chain; a mouse at the edge is unaffected', function () {
    var a = createArbiter();
    a.down(touch(40, 200, 0)); a.up();
    assert.equal(a.down(touch(10, 200, 100)).doubleTap, 0, 'edge never seeks');
    a.up();
    assert.equal(a.down(touch(40, 200, 200)).doubleTap, 0, 'the edge press reset the chain');
    var m = createArbiter();
    assert.equal(m.down(mouse(5, 200)).edge, undefined);
    assert.equal(m.phase(), 'pending');
});

t('just inside the zone a swipe still works', function () {
    var a = createArbiter();
    a.down(touch(24, 300));
    assert.deepEqual(a.move({ t: 50, x: 24, y: 250 }), { type: 'swipe-start', kind: 'brightness' });
});

// Rotate video: a 400x800 portrait viewport, the page turned by +90 / -90 degrees.
var VW = 400, VH = 800;

t('toContent is the identity at 0 and inverts both rotations', function () {
    assert.deepEqual(toContent(0, 30, 40, VW, VH), { x: 30, y: 40 });
    // forward map for +90: content (cx, cy) shows at screen (VW - cy, cx)
    var c = { x: 120, y: 90 };
    var s90 = { x: VW - c.y, y: c.x };
    assert.deepEqual(toContent(90, s90.x, s90.y, VW, VH), c);
    // forward map for -90: content (cx, cy) shows at screen (cy, VH - cx)
    var s_90 = { x: c.y, y: VH - c.x };
    assert.deepEqual(toContent(-90, s_90.x, s_90.y, VW, VH), c);
    assert.deepEqual(toContent(45, 1, 2, VW, VH), { x: 1, y: 2 }, 'unknown angle: identity');
});

t('rotated: a finger moving up as the viewer sees it is a swipe up', function () {
    [90, -90].forEach(function (rot) {
        // The viewer's up is content -y. Walk a content-space line upward and project it to the screen.
        var cx = 600, cy0 = 300;
        function toScreen(x, y) {
            return rot === 90 ? { x: VW - y, y: x } : { x: y, y: VH - x };
        }
        var a = createArbiter();
        var s0 = toScreen(cx, cy0), c0 = toContent(rot, s0.x, s0.y, VW, VH);
        a.down({ t: 0, x: c0.x, y: c0.y, sx: s0.x, swidth: VW, width: VH, touch: true });
        var s1 = toScreen(cx, cy0 - 120), c1 = toContent(rot, s1.x, s1.y, VW, VH);
        assert.deepEqual(a.move({ t: 40, x: c1.x, y: c1.y }), { type: 'swipe-start', kind: 'volume' }, 'right half of the viewer\'s picture');
        var s2 = toScreen(cx, cy0 - 240), c2 = toContent(rot, s2.x, s2.y, VW, VH);
        var m = a.move({ t: 80, x: c2.x, y: c2.y });
        assert.equal(m.type, 'swipe');
        assert.ok(m.dy < 0, 'up is negative dy at rot ' + rot);
        assert.ok(swipeLevel(0.5, m.dy, VW) > 0.5, 'and raises the level');
    });
});

t('rotated: left and right thirds are the viewer\'s left and right', function () {
    [90, -90].forEach(function (rot) {
        function toScreen(x, y) { return rot === 90 ? { x: VW - y, y: x } : { x: y, y: VH - x }; }
        var s = toScreen(100, 200);           // content: left third of an 800-wide picture
        var c = toContent(rot, s.x, s.y, VW, VH);
        assert.equal(zoneOf(c.x, VH), -1, 'left at rot ' + rot);
        s = toScreen(700, 200);
        c = toContent(rot, s.x, s.y, VW, VH);
        assert.equal(zoneOf(c.x, VH), 1, 'right at rot ' + rot);
    });
});

t('rotated: the OS edge is judged on the screen, not the picture', function () {
    var a = createArbiter();
    // content x 400 (middle) but the screen x is 5: the OS edge, so it is passed
    assert.equal(a.down({ t: 0, x: 400, y: 200, sx: 5, swidth: VW, width: VH, touch: true }).edge, true);
    var b = createArbiter();
    // content x 5 (the picture's left edge) but the screen x is mid-screen: ours
    var r = b.down({ t: 0, x: 5, y: 200, sx: 200, swidth: VW, width: VH, touch: true });
    assert.equal(r.edge, undefined);
    assert.equal(b.phase(), 'pending');
});

console.log(passed + ' passed');
