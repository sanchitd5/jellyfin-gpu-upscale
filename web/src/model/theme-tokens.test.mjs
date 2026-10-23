// Run: node web/src/model/theme-tokens.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import { tierOf, contrast, DARK, LIGHT, themeCss, zoomableViewport } from './theme-tokens.js';

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

t('tier boundaries', function () {
    assert.equal(tierOf(320), 'jp-phone');
    assert.equal(tierOf(599), 'jp-phone');
    assert.equal(tierOf(600), 'jp-tablet');
    assert.equal(tierOf(820), 'jp-tablet');
    assert.equal(tierOf(1023), 'jp-tablet');
    assert.equal(tierOf(1024), 'jp-desktop');
    assert.equal(tierOf(1440), 'jp-desktop');
    assert.equal(tierOf(0), 'jp-desktop');
    assert.equal(tierOf(undefined), 'jp-desktop');
});

[['dark', DARK], ['light', LIGHT]].forEach(function (s) {
    var name = s[0], p = s[1];
    function ge(a, b, min) {
        var c = contrast(a, b);
        assert.ok(c >= min, name + ' ' + a + ' on ' + b + ' = ' + c.toFixed(2) + ' < ' + min);
    }
    t(name + ': text pairs are AA (4.5)', function () {
        [p.bg, p.surface, p.surface2].forEach(function (bg) {
            ge(p.text, bg, 4.5);
            ge(p.muted, bg, 4.5);
            ge(p.accent, bg, 4.5);
            ge(p.accentHover, bg, 4.5);
            ge(p.error, bg, 4.5);
        });
    });
    t(name + ': on-accent is AA on accent and hover', function () {
        ge(p.onAccent, p.accent, 4.5);
        ge(p.onAccent, p.accentHover, 4.5);
    });
    t(name + ': border is a hairline, not a contrast carrier (1.3 floor)', function () {
        ge(p.border, p.bg, 1.3);
    });
});

t('accent is the chosen blue, not stock #00a4dc', function () {
    assert.equal(DARK.accent, '#5ccfff');
    assert.equal(LIGHT.accent, '#0369a1');
});

t('contrast sanity', function () {
    assert.ok(Math.abs(contrast('#000000', '#ffffff') - 21) < 0.01);
    assert.ok(contrast('#00a4dc', '#ffffff') < 3.1);
});

t('css: every rule scoped, TV and off excluded, contract tokens present', function () {
    var css = themeCss();
    ['--jp-accent', '--jp-accent-hover', '--jp-on-accent', '--jp-bg', '--jp-surface', '--jp-surface-2',
        '--jp-text', '--jp-text-muted', '--jp-border', '--jp-radius-s', '--jp-radius-m', '--jp-radius-l',
        '--jp-space-1', '--jp-space-6', '--jp-font-body', '--jp-font-small', '--jp-font-title', '--jp-tap',
        '--jp-elev-1', '--jp-elev-2', '--jp-dur-fast', '--jp-dur', '--jp-ease', '--jp-safe-bottom', '--jp-nav-h'
    ].forEach(function (v) { assert.ok(css.indexOf(v + ':') >= 0, 'missing ' + v); });
    // Strip @media wrappers, then every selector must carry both guards (or be a keyframe / the layout-mobile font rule).
    css.split('\n').forEach(function (line) {
        var l = line.replace(/^@media[^{]*\{/, '');
        if (/^@keyframes/.test(l)) return;
        assert.ok(/:not\(\.jp-theme-off\)/.test(l), 'unscoped (off): ' + l.slice(0, 80));
        if (!/^html\.layout-mobile/.test(l)) assert.ok(/:not\(\.layout-tv\)/.test(l), 'unscoped (tv): ' + l.slice(0, 80));
    });
    assert.ok(/prefers-reduced-motion:reduce\)\{[^}]*--jp-dur:0ms/.test(css));
    assert.ok(css.length < 12000, 'size ' + css.length);
});

t('pinch-zoom: user-scalable and maximum-scale dropped', function () {
    assert.equal(
        zoomableViewport('width=device-width,initial-scale=1,minimum-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover'),
        'width=device-width,initial-scale=1,minimum-scale=1,viewport-fit=cover');
    assert.equal(zoomableViewport('width=device-width, initial-scale=1'), 'width=device-width,initial-scale=1');
    assert.equal(zoomableViewport(null), '');
});

console.log(passed + ' passed');
