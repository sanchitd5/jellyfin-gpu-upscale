// Run: node web/src/model/prefs-sync.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import { SYNCED, MAX_KEY_LENGTH, canon, encode, decode, decide, adopted, byLocalKey } from './prefs-sync.js';

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

var PREFS = SYNCED[0];
var SIZE = SYNCED[1];

t('every remote key fits the server limit and is in the jellyfinPlus namespace', function () {
    SYNCED.forEach(function (d) {
        assert.ok(d.remote.length <= MAX_KEY_LENGTH, d.remote);
        assert.ok(d.remote.indexOf('jellyfinPlus.') === 0, d.remote);
    });
});

t('remote keys never collide with ones jellyfin-web parses specially', function () {
    SYNCED.forEach(function (d) {
        assert.ok(!/^(homesection|landing-)/i.test(d.remote));
        assert.ok(['chromecastVersion', 'skipForwardLength', 'skipBackLength', 'enableNextVideoInfoOverlay', 'tvhome', 'dashboardTheme'].indexOf(d.remote) === -1);
    });
});

t('canon drops the panel position and nothing else', function () {
    var raw = JSON.stringify({ stage: 'unset', upscale: '1080', pos: { x: 3, y: 4 } });
    assert.equal(canon(PREFS, raw), JSON.stringify({ stage: 'unset', upscale: '1080' }));
});

t('canon: a position-only change is not a change', function () {
    var a = canon(PREFS, JSON.stringify({ stage: 'custom', sr: 'x', pos: { x: 1, y: 1 } }));
    var b = canon(PREFS, JSON.stringify({ stage: 'custom', sr: 'x', pos: { x: 90, y: 5 } }));
    var c = canon(PREFS, JSON.stringify({ stage: 'custom', sr: 'x', pos: null }));
    assert.equal(a, b);
    assert.equal(a, c);
});

t('canon: unset and unusable values are null', function () {
    assert.equal(canon(PREFS, null), null);
    assert.equal(canon(PREFS, 'not json'), null);
    assert.equal(canon(PREFS, '[1,2]'), null);
    assert.equal(canon(PREFS, '"x"'), null);
});

t('canon: plain keys are the raw string, empty string included', function () {
    assert.equal(canon(SIZE, '{"a":1}'), '{"a":1}');
    assert.equal(canon(SYNCED[2], ''), '');
});

t('encode / decode round trip, including cleared (null)', function () {
    assert.deepEqual(decode(SIZE, encode('x', 1700000000000)), { t: 1700000000000, v: 'x' });
    assert.deepEqual(decode(SIZE, encode(null, 5)), { t: 5, v: null });
    assert.deepEqual(decode(SIZE, encode('', 5)), { t: 5, v: '' });
});

t('decode rejects anything that is not our envelope', function () {
    [undefined, null, '', 'plain', '[]', '{}', '{"t":1}', '{"t":"1","v":"x"}', '{"t":0,"v":"x"}', '{"t":-3,"v":"x"}',
        '{"t":1,"v":5}', '{"t":1,"v":{"a":1}}', '{"t":1e999,"v":"x"}'].forEach(function (s) {
        assert.equal(decode(SIZE, s), null, String(s));
    });
});

t('decode: a prefs envelope must carry a JSON object; an oversized value is refused', function () {
    assert.equal(decode(PREFS, encode('nope', 1)), null);
    assert.equal(decode(PREFS, encode('[1]', 1)), null);
    assert.ok(decode(PREFS, encode('{"a":1}', 1)));
    assert.equal(decode(SIZE, encode(new Array(20005).join('x'), 1)), null);
});

t('decide: no server value -> push ours if this user recorded writing it; nothing otherwise', function () {
    assert.equal(decide('a', 5, null), 'push');
    // For an owned key with no write time under this user: the value may be another account's on a shared browser. Keep it local, push nothing.
    assert.equal(decide('a', 0, null), 'push');
    assert.equal(decide('a', 0, null, true), 'none');
    assert.equal(decide('a', 5, null, true), 'push');
    assert.equal(decide(null, 0, null, true), 'none');
    assert.equal(decide(null, 0, null), 'none');
});

t('decide: equal values never move, whatever the times', function () {
    assert.equal(decide('a', 1, { t: 99, v: 'a' }), 'none');
    assert.equal(decide('', 1, { t: 99, v: '' }), 'none');
    assert.equal(decide(null, 0, { t: 99, v: null }), 'none');
});

t('decide: no local value -> adopt', function () {
    assert.equal(decide(null, 0, { t: 5, v: 'a' }), 'adopt');
});

t('decide: a value removed locally after the server copy was written sends the removal; an old removal does not', function () {
    assert.equal(decide(null, 300, { t: 200, v: 'theirs' }), 'push');
    assert.equal(decide(null, 100, { t: 200, v: 'theirs' }), 'adopt');
});

t('decide: the most recent write wins', function () {
    assert.equal(decide('mine', 100, { t: 200, v: 'theirs' }), 'adopt');
    assert.equal(decide('mine', 300, { t: 200, v: 'theirs' }), 'push');
});

t('decide: a local value with no recorded time loses to a recorded server value; a tie goes to the server', function () {
    assert.equal(decide('mine', 0, { t: 200, v: 'theirs' }), 'adopt');
    assert.equal(decide('mine', 200, { t: 200, v: 'theirs' }), 'adopt');
});

t('decide: the server clearing a key beats an older local value', function () {
    assert.equal(decide('mine', 100, { t: 200, v: null }), 'adopt');
    assert.equal(decide('mine', 300, { t: 200, v: null }), 'push');
});

t('adopted: plain key takes the server value; cleared removes', function () {
    assert.equal(adopted(SIZE, 'x', 'old'), 'x');
    assert.equal(adopted(SIZE, null, 'old'), null);
    assert.equal(adopted(SIZE, '', 'old'), '');
});

t('adopted: prefs keep this device\'s own panel position', function () {
    var local = JSON.stringify({ stage: 'old', pos: { x: 7, y: 8 } });
    var out = JSON.parse(adopted(PREFS, JSON.stringify({ stage: 'new', sr: 'fsrcnnx' }), local));
    assert.equal(out.stage, 'new');
    assert.equal(out.sr, 'fsrcnnx');
    assert.deepEqual(out.pos, { x: 7, y: 8 });
});

t('adopted: no local position, unreadable local value -> the server value as is', function () {
    assert.deepEqual(JSON.parse(adopted(PREFS, '{"stage":"s"}', null)), { stage: 's' });
    assert.deepEqual(JSON.parse(adopted(PREFS, '{"stage":"s"}', 'garbage')), { stage: 's' });
});

t('adopting then canonicalising gives back what the server holds (no ping-pong)', function () {
    var remoteV = canon(PREFS, JSON.stringify({ stage: 'custom', upscale: '2160', pos: { x: 1, y: 2 } }));
    var local = adopted(PREFS, remoteV, JSON.stringify({ stage: 'old', pos: { x: 5, y: 6 } }));
    assert.equal(canon(PREFS, local), remoteV);
    assert.equal(decide(canon(PREFS, local), 1, { t: 1, v: remoteV }), 'none');
});

t('byLocalKey indexes every synced key', function () {
    var m = byLocalKey();
    SYNCED.forEach(function (d) { assert.equal(m[d.local], d); });
    assert.equal(m['jellyfinPlusOpen'], undefined);
});

console.log(passed + ' passed');
