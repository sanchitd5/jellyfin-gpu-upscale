// Run: node web/src/model/player-badge.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import { badgeModel } from './player-badge.js';

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

var FULL = { full: true, levels: null };
var ACTIVE = { key: 'active', label: 'Enhancing now', why: 'why-active' };
var OFF = { key: 'off', label: 'Not enhancing', why: 'why-off' };
var WAIT = { key: 'waiting', label: 'Waiting for the server', why: 'why-wait' };
var UNAVAIL = { key: 'unavailable', label: 'Enhancement unavailable', why: 'why-unavail' };

t('hidden unless the probe answered fully', function () {
    [null, undefined, { full: false, failed: true }, { full: false, targetOnly: true }].forEach(function (c) {
        assert.equal(badgeModel(c, { Known: true, Summary: 'x' }, ACTIVE).show, false);
    });
    assert.equal(badgeModel(FULL, null, null).show, false);
});

t('active shows the server summary verbatim', function () {
    var m = badgeModel(FULL, { Known: true, Summary: 'Denoise 2 (a), Upscaled 1280x720 to 1920x1080 (b)' }, ACTIVE);
    assert.equal(m.show, true);
    assert.equal(m.key, 'active');
    assert.equal(m.text, 'Denoise 2 (a), Upscaled 1280x720 to 1920x1080 (b)');
    assert.equal(m.title, m.text);
});

t('active with no summary falls back to the client label, not an invented one', function () {
    var m = badgeModel(FULL, { Known: true }, ACTIVE);
    assert.equal(m.text, 'Enhancing now');
});

t('a named server reason is the honest negative text', function () {
    var m = badgeModel(FULL, { Known: true, Status: 'stream-copy', Summary: 'Enhancement not applied (video is being streamed as-is)' }, OFF);
    assert.equal(m.key, 'off');
    assert.equal(m.text, 'Enhancement not applied (video is being streamed as-is)');
    assert.ok(m.title.indexOf('stream-copy') >= 0);
});

t('a record with nothing to add uses the client label and its explanation', function () {
    var m = badgeModel(FULL, { Known: true, Summary: 'No enhancement' }, OFF);
    assert.equal(m.text, 'Not enhancing');
    assert.equal(m.title, 'why-off');
});

t('no record (direct play, copy or not started) is the client label, never the server default text', function () {
    var m = badgeModel(FULL, { Known: false, Summary: 'No enhancement', Status: 'unknown' }, OFF);
    assert.equal(m.text, 'Not enhancing');
    assert.equal(m.title, 'why-off');
});

t('waiting and unavailable keep the client wording', function () {
    assert.equal(badgeModel(FULL, null, WAIT).text, 'Waiting for the server');
    assert.equal(badgeModel(FULL, { PatchActive: false, Known: false }, UNAVAIL).text, 'Enhancement unavailable');
    assert.equal(badgeModel(FULL, null, WAIT).key, 'waiting');
});

t('a whitespace summary counts as none', function () {
    assert.equal(badgeModel(FULL, { Known: true, Summary: '   ' }, ACTIVE).text, 'Enhancing now');
});

console.log(passed + ' passed');
