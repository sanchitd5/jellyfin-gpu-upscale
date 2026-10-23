// Run: node web/src/model/client-upscale.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import {
    parseClientPrefs, DEFAULT_CLIENT_PREFS, sharpnessStops, contentRect, visibleRect, layout,
    decide, clientLine, newGovernor, stepGovernor, windowIsBad, MAX_OUTPUT_PIXELS,
    PERF_FULL, PERF_NO_CLEANUP, PERF_NO_RCAS, PERF_OFF
} from './client-upscale.js';

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

t('prefs: defaults are Auto, cleanup Low, sharpness 0.25', function () {
    assert.deepEqual(parseClientPrefs(null), DEFAULT_CLIENT_PREFS);
    assert.deepEqual(DEFAULT_CLIENT_PREFS, { mode: 'auto', cleanup: 'low', sharpness: '0.25' });
});

t('prefs: garbage and unknown values fall back per field', function () {
    assert.deepEqual(parseClientPrefs('{nope'), DEFAULT_CLIENT_PREFS);
    assert.deepEqual(parseClientPrefs('"str"'), DEFAULT_CLIENT_PREFS);
    assert.deepEqual(parseClientPrefs('{"mode":"always","cleanup":"ultra","sharpness":7}'),
        { mode: 'always', cleanup: 'low', sharpness: '0.25' });
    assert.deepEqual(parseClientPrefs('{"mode":"off","cleanup":"high","sharpness":0}'),
        { mode: 'off', cleanup: 'high', sharpness: '0' });
});

t('sharpness stops', function () {
    assert.equal(sharpnessStops('0'), 0);
    assert.equal(sharpnessStops('1'), 1);
    assert.equal(sharpnessStops('x'), 0.25);
});

t('contentRect: contain letterboxes a 16:9 picture in a 4:3 box', function () {
    var r = contentRect(1024, 768, 1280, 720, 'contain');
    assert.equal(r.w, 1024);
    assert.equal(r.h, 576);
    assert.equal(r.x, 0);
    assert.equal(r.y, 96);
});

t('contentRect: cover overflows, fill stretches, unknown fit is contain', function () {
    var c = contentRect(1000, 1000, 2000, 1000, 'cover');
    assert.deepEqual(c, { x: -500, y: 0, w: 2000, h: 1000 });
    assert.deepEqual(contentRect(300, 200, 640, 360, 'fill'), { x: 0, y: 0, w: 300, h: 200 });
    assert.deepEqual(contentRect(1024, 768, 1280, 720, ''), contentRect(1024, 768, 1280, 720, 'contain'));
    assert.equal(contentRect(0, 768, 1280, 720, 'contain'), null);
    assert.equal(contentRect(1024, 768, 0, 0, 'contain'), null);
});

t('visibleRect crops cover to the box', function () {
    assert.deepEqual(visibleRect({ x: -500, y: 0, w: 2000, h: 1000 }, 1000, 1000), { x: 0, y: 0, w: 1000, h: 1000 });
});

t('layout: device pixels, viewport inside the canvas for contain', function () {
    var g = layout(1280, 720, 640, 360, 'contain', 2);
    assert.equal(g.canvasW, 2560);
    assert.equal(g.canvasH, 1440);
    assert.deepEqual(g.viewport, { x: 0, y: 0, w: 2560, h: 1440 });
    assert.equal(g.scaleX, 4);
    assert.equal(g.scaleY, 4);
});

t('layout: cover viewport overhangs the canvas, centred', function () {
    var g = layout(1000, 1000, 2000, 1000, 'cover', 1);
    assert.equal(g.canvasW, 1000);
    assert.equal(g.viewport.w, 2000);
    assert.equal(g.viewport.x, -500);
    assert.equal(g.viewport.y, 0);
});

t('layout: output capped at about a 4K pixel count', function () {
    var g = layout(3840, 2160, 1280, 720, 'contain', 3);
    assert.ok(g.canvasW * g.canvasH <= MAX_OUTPUT_PIXELS * 1.001);
    assert.equal(g.canvasW, 3840);
});

var GEO_1080 = layout(1920, 1080, 1280, 720, 'contain', 1);     // 1.5x
var GEO_SAME = layout(1920, 1080, 1920, 1080, 'contain', 1);    // 1.0x
var GEO_SMALL = layout(1366, 768, 1280, 720, 'contain', 1);     // 1.067x
var GEO_DOWN = layout(960, 540, 1920, 1080, 'contain', 1);      // 0.5x

function facts(over) {
    var f = { mode: 'auto', tv: false, webgl2: true, failure: null, nativeFullscreen: false,
        nativeCues: false, vw: 1280, vh: 720, geo: GEO_1080, perf: PERF_FULL, cleanup: 'low' };
    Object.keys(over || {}).forEach(function (k) { f[k] = over[k]; });
    return f;
}

t('decide: auto runs on 720p shown at 1080p, with cleanup and RCAS', function () {
    assert.deepEqual(decide(facts()), { active: true, reason: null, cleanup: true, rcas: true });
});

t('decide: auto stays off at native size and at 1.067x, always runs at 1.067x', function () {
    assert.equal(decide(facts({ vw: 1920, vh: 1080, geo: GEO_SAME })).reason, 'full-size');
    assert.equal(decide(facts({ geo: GEO_SMALL })).reason, 'full-size');
    assert.equal(decide(facts({ geo: GEO_SMALL, mode: 'always' })).active, true);
    assert.equal(decide(facts({ vw: 1920, vh: 1080, geo: GEO_SAME, mode: 'always' })).active, false);
});

t('decide: never minifies, not even on Always', function () {
    assert.equal(decide(facts({ vw: 1920, vh: 1080, geo: GEO_DOWN, mode: 'always' })).reason, 'full-size');
});

t('decide: fail-soft reasons, in order', function () {
    assert.equal(decide(facts({ mode: 'off' })).reason, 'mode-off');
    assert.equal(decide(facts({ tv: true })).reason, 'tv');
    assert.equal(decide(facts({ webgl2: false })).reason, 'no-webgl2');
    assert.equal(decide(facts({ failure: 'context-lost' })).reason, 'context-lost');
    assert.equal(decide(facts({ failure: 'unreadable' })).reason, 'unreadable');
    assert.equal(decide(facts({ nativeFullscreen: true })).reason, 'native-fullscreen');
    assert.equal(decide(facts({ nativeCues: true })).reason, 'native-cues');
    assert.equal(decide(facts({ pip: true })).reason, 'pip');
    assert.equal(clientLine(decide(facts({ pip: true }))), 'This device: off (picture-in-picture)');
    assert.equal(clientLine(decide(facts({ failure: 'unreadable' }))), 'This device: off (video not readable by the page)');
    assert.equal(decide(facts({ vw: 0, vh: 0 })).reason, 'no-video');
    assert.equal(decide(null).reason, 'mode-off');
});

t('decide: cleanup off, and the governor steps', function () {
    assert.equal(decide(facts({ cleanup: 'off' })).cleanup, false);
    assert.deepEqual(decide(facts({ perf: PERF_NO_CLEANUP })), { active: true, reason: 'gpu-slow', cleanup: false, rcas: true });
    assert.deepEqual(decide(facts({ perf: PERF_NO_RCAS })), { active: true, reason: 'gpu-slow', cleanup: false, rcas: false });
    assert.equal(decide(facts({ perf: PERF_OFF })).reason, 'gpu-slow');
    assert.equal(decide(facts({ perf: PERF_OFF })).active, false);
});

t('clientLine: active wording', function () {
    var d = decide(facts({ geo: layout(2560, 1440, 1280, 720, 'contain', 1) }));
    assert.equal(clientLine(d, 720, 1440), 'This device: cleanup + FSR 1 · 720p → 1440p');
    assert.equal(clientLine(decide(facts({ cleanup: 'off' })), 720, 1080), 'This device: FSR 1 · 720p → 1080p');
    assert.equal(clientLine(decide(facts({ perf: PERF_NO_RCAS })), 720, 1080),
        'This device: FSR 1 (EASU only) · 720p → 1080p (reduced: GPU too slow)');
});

t('clientLine: honest negatives, silence when off by choice or on TV', function () {
    assert.equal(clientLine(decide(facts({ geo: GEO_SMALL })), 720, 768), 'This device: off (stream already full size)');
    assert.equal(clientLine(decide(facts({ perf: PERF_OFF })), 720, 1080), 'This device: off (GPU too slow)');
    assert.equal(clientLine(decide(facts({ webgl2: false })), 720, 1080), 'This device: off (no WebGL2)');
    assert.equal(clientLine(decide(facts({ mode: 'off' })), 720, 1080), null);
    assert.equal(clientLine(decide(facts({ tv: true })), 720, 1080), null);
    assert.equal(clientLine(null), null);
});

t('governor: one bad window is not enough, two step down', function () {
    var bad = { frames: 48, missed: 10, dropped: 0 };
    var g = stepGovernor(newGovernor(), bad);
    assert.equal(g.level, PERF_FULL);
    g = stepGovernor(g, bad);
    assert.equal(g.level, PERF_NO_CLEANUP);
    g = stepGovernor(stepGovernor(g, bad), bad);
    assert.equal(g.level, PERF_NO_RCAS);
    g = stepGovernor(stepGovernor(g, bad), bad);
    assert.equal(g.level, PERF_OFF);
    assert.equal(stepGovernor(g, { frames: 48, missed: 0 }).level, PERF_OFF, 'off is sticky');
});

t('governor: a good window between bad ones resets the count', function () {
    var bad = { frames: 48, missed: 10 };
    var g = stepGovernor(stepGovernor(stepGovernor(newGovernor(), bad), { frames: 48, missed: 0 }), bad);
    assert.equal(g.level, PERF_FULL);
});

t('governor: twenty good windows step back up, never above the floor', function () {
    var g = { level: PERF_NO_RCAS, bad: 0, good: 0, floor: PERF_FULL };
    for (var i = 0; i < 19; i++) { g = stepGovernor(g, { frames: 48, missed: 0 }); }
    assert.equal(g.level, PERF_NO_RCAS);
    g = stepGovernor(g, { frames: 48, missed: 0 });
    assert.equal(g.level, PERF_NO_CLEANUP);
    g = { level: PERF_NO_CLEANUP, bad: 0, good: 0 };
    for (var j = 0; j < 40; j++) { g = stepGovernor(g, { frames: 48, missed: 0 }, PERF_NO_CLEANUP); }
    assert.equal(g.level, PERF_NO_CLEANUP);
});

t('governor: with cleanup off the first step down drops RCAS', function () {
    var bad = { frames: 48, missed: 10 };
    var g = stepGovernor(stepGovernor(newGovernor(), bad, PERF_NO_CLEANUP), bad, PERF_NO_CLEANUP);
    assert.equal(g.level, PERF_NO_RCAS);
});

t('windowIsBad: dropped frames and GPU time count too', function () {
    assert.equal(windowIsBad({ frames: 48, missed: 0, dropped: 5 }), true);
    assert.equal(windowIsBad({ frames: 48, missed: 1, dropped: 1 }), false);
    assert.equal(windowIsBad({ frames: 48, missed: 0, gpuMs: 15, budgetMs: 16.7 }), true);
    assert.equal(windowIsBad({ frames: 48, missed: 0, gpuMs: 5, budgetMs: 16.7 }), false);
    assert.equal(windowIsBad({ frames: 0 }), false);
});

console.log(passed + ' passed');
