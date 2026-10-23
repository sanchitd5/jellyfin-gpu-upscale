// Run: node web/src/model/player-speed.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import { parseRate, seedFor, mirrorFor, SESSION_KEY, STORE_KEY } from './player-speed.js';

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

t('the stock session key is the one jellyfin-web writes', function () {
    assert.equal(SESSION_KEY, 'playbackRateSpeed');
    assert.equal(STORE_KEY, 'jellyfinPlusPlaybackRate');
});

t('parseRate accepts sane rates only', function () {
    assert.equal(parseRate('1.5'), 1.5);
    assert.equal(parseRate('0.25'), 0.25);
    assert.equal(parseRate('4'), 4);
    assert.equal(parseRate(2), 2);
    ['', null, undefined, 'abc', '0', '0.1', '5', '-1', 'NaN', 'Infinity'].forEach(function (v) {
        assert.equal(parseRate(v), null, String(v));
    });
});

t('seed: a fresh tab takes the saved rate', function () {
    assert.equal(seedFor(null, '1.5'), '1.5');
    assert.equal(seedFor(null, '0.75'), '0.75');
});

t('seed: never overwrites a rate this tab already chose, even 1x', function () {
    assert.equal(seedFor('2', '1.5'), null);
    assert.equal(seedFor('1', '1.5'), null);
    assert.equal(seedFor('', '1.5'), null);
});

t('seed: nothing to seed for 1x, junk or no saved rate', function () {
    assert.equal(seedFor(null, null), null);
    assert.equal(seedFor(null, '1'), null);
    assert.equal(seedFor(null, 'junk'), null);
    assert.equal(seedFor(null, '99'), null);
});

t('seed normalises what it writes', function () {
    assert.equal(seedFor(null, '1.50'), '1.5');
});

t('mirror: a changed rate is saved', function () {
    assert.deepEqual(mirrorFor('1.25', null), { op: 'set', value: '1.25' });
    assert.deepEqual(mirrorFor('2', '1.5'), { op: 'set', value: '2' });
});

t('mirror: an unchanged rate writes nothing (numeric compare)', function () {
    assert.equal(mirrorFor('1.5', '1.5'), null);
    assert.equal(mirrorFor('1.50', '1.5'), null);
});

t('mirror: back to 1x clears the saved rate, and only when there is one', function () {
    assert.deepEqual(mirrorFor('1', '1.5'), { op: 'remove' });
    assert.equal(mirrorFor('1', null), null);
});

t('mirror: a missing or unusable session value is left alone', function () {
    assert.equal(mirrorFor(null, '1.5'), null);
    assert.equal(mirrorFor('', '1.5'), null);
    assert.equal(mirrorFor('abc', '1.5'), null);
    assert.equal(mirrorFor('50', '1.5'), null);
});

t('a 2x hold never reaches the mirror: it does not change the session value', function () {
    // The hold sets the element's rate directly. The session key still says what the viewer chose,
    // so a ratechange to 2 while the key reads 1.5 mirrors 1.5, which is already saved.
    assert.equal(mirrorFor('1.5', '1.5'), null);
    assert.equal(mirrorFor(null, '1.5'), null);
});

console.log(passed + ' passed');
