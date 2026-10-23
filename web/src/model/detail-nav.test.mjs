// Run: node web/src/model/detail-nav.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import { runAround, neighbours, encode, decode, detailHref, normId, MAX_IDS } from './detail-nav.js';

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

function id(n) {
    return ('0'.repeat(32) + n.toString(16)).slice(-32);
}

var A = id(1), B = id(2), C = id(3), D = id(4), E = id(5);

t('normId lowercases and strips dashes', function () {
    assert.equal(normId('0123ABCD-0123-4567-89AB-CDEF01234567'), '0123abcd0123456789abcdef01234567');
    assert.equal(normId(null), '');
});

t('runAround returns the whole list when nothing is missing', function () {
    assert.deepEqual(runAround([A, B, C], B), [A, B, C]);
});

t('runAround is empty when the item is not in the list', function () {
    assert.deepEqual(runAround([A, B, C], D), []);
    assert.deepEqual(runAround([], A), []);
    assert.deepEqual(runAround(null, A), []);
});

t('runAround keeps only the gap-free run that holds the item', function () {
    assert.deepEqual(runAround([A, B, null, C, D, null, E], D), [C, D]);
    assert.deepEqual(runAround([A, B, null, C, D, null, E], A), [A, B]);
    assert.deepEqual(runAround([A, B, null, C, D, null, E], E), [E]);
});

t('runAround treats a malformed id as a gap and normalises dashed ids', function () {
    assert.deepEqual(runAround([A, 'not-an-id', B, C], C), [B, C]);
    var dashed = B.slice(0, 8) + '-' + B.slice(8, 12) + '-' + B.slice(12, 16) + '-' + B.slice(16, 20) + '-' + B.slice(20);
    assert.deepEqual(runAround([A, dashed.toUpperCase(), C], B), [A, B, C]);
});

t('runAround drops repeated ids, first occurrence wins', function () {
    assert.deepEqual(runAround([A, B, A, C], C), [A, B, C]);
});

t('runAround caps the list around the item', function () {
    var many = [];
    for (var i = 1; i <= MAX_IDS + 500; i++) { many.push(id(i)); }
    var mid = runAround(many, id(1200));
    assert.equal(mid.length, MAX_IDS);
    assert.ok(mid.indexOf(id(1200)) !== -1);
    var first = runAround(many, id(1));
    assert.equal(first.length, MAX_IDS);
    assert.equal(first[0], id(1));
    var last = runAround(many, id(MAX_IDS + 500));
    assert.equal(last.length, MAX_IDS);
    assert.equal(last[last.length - 1], id(MAX_IDS + 500));
});

t('neighbours at the start, middle and end', function () {
    var ids = [A, B, C];
    assert.deepEqual(neighbours(ids, A), { index: 0, total: 3, prev: null, next: B });
    assert.deepEqual(neighbours(ids, B), { index: 1, total: 3, prev: A, next: C });
    assert.deepEqual(neighbours(ids, C), { index: 2, total: 3, prev: B, next: null });
});

t('neighbours is null outside the list', function () {
    assert.equal(neighbours([A, B], C), null);
    assert.equal(neighbours(null, A), null);
});

t('neighbours finds a dashed or upper-case id', function () {
    assert.equal(neighbours([A, B], B.toUpperCase()).index, 1);
});

t('encode and decode round-trip', function () {
    var raw = encode('#/list?type=tag&tag=x', [A, B]);
    assert.deepEqual(decode(raw), { src: '#/list?type=tag&tag=x', ids: [A, B] });
});

t('decode rejects anything that is not what encode wrote', function () {
    assert.equal(decode(null), null);
    assert.equal(decode('nope'), null);
    assert.equal(decode('{}'), null);
    assert.equal(decode(JSON.stringify({ v: 2, src: '', ids: [A] })), null);
    assert.equal(decode(JSON.stringify({ v: 1, src: '', ids: ['zz'] })), null);
    assert.equal(decode(JSON.stringify({ v: 1, src: 5, ids: [A] })), null);
    assert.equal(decode(JSON.stringify({ v: 1, src: '', ids: Array(MAX_IDS + 1).fill(A) })), null);
});

t('detailHref matches a card link', function () {
    assert.equal(detailHref(A, 'srv1'), '#/details?id=' + A + '&serverId=srv1');
    assert.equal(detailHref(A), '#/details?id=' + A);
});

console.log(passed + ' passed');
