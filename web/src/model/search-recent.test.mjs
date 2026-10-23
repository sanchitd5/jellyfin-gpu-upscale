// Run: node web/src/model/search-recent.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import {
    STORE_KEY, MAX_RECENT, MAX_TERM, cleanTerm, normalizeList, pushTerm, removeTerm, loadRecent, saveRecent, listSig
} from './search-recent.js';

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

function fakeStorage(initial) {
    var data = initial || {};
    return {
        data: data,
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
        setItem: function (k, v) { data[k] = String(v); },
        removeItem: function (k) { delete data[k]; }
    };
}

t('cleanTerm trims, collapses whitespace and rejects the unusable', function () {
    assert.equal(cleanTerm('  red   car '), 'red car');
    assert.equal(cleanTerm('a'), '');
    assert.equal(cleanTerm('   '), '');
    assert.equal(cleanTerm(''), '');
    assert.equal(cleanTerm(null), '');
    assert.equal(cleanTerm(42), '');
    assert.equal(cleanTerm('x'.repeat(MAX_TERM)), 'x'.repeat(MAX_TERM));
    assert.equal(cleanTerm('x'.repeat(MAX_TERM + 1)), '');
});

t('pushTerm puts the newest first', function () {
    assert.deepEqual(pushTerm(['cat', 'dog'], 'bird'), ['bird', 'cat', 'dog']);
    assert.deepEqual(pushTerm([], 'bird'), ['bird']);
});

t('a repeat moves to the front, case-insensitively, with the new spelling', function () {
    assert.deepEqual(pushTerm(['cat', 'dog', 'bird'], 'DOG'), ['DOG', 'cat', 'bird']);
});

t('wildcards and punctuation are kept as typed', function () {
    assert.deepEqual(pushTerm([], 'red*car ?'), ['red*car ?']);
});

t('the list is capped at MAX_RECENT, dropping the oldest', function () {
    var list = [];
    for (var i = 0; i < MAX_RECENT + 5; i++) {
        list = pushTerm(list, 'term ' + i);
    }

    assert.equal(list.length, MAX_RECENT);
    assert.equal(list[0], 'term ' + (MAX_RECENT + 4));
    assert.equal(list[MAX_RECENT - 1], 'term 5');
});

t('unusable text changes nothing', function () {
    var list = ['cat'];
    assert.equal(pushTerm(list, ' '), list);
    assert.equal(pushTerm(list, 'a'), list);
    assert.equal(pushTerm(list, undefined), list);
});

t('removeTerm is case-insensitive and leaves the rest in order', function () {
    assert.deepEqual(removeTerm(['cat', 'Dog', 'bird'], 'dog'), ['cat', 'bird']);
    assert.deepEqual(removeTerm(['cat'], 'zebra'), ['cat']);
});

t('normalizeList repairs whatever was stored', function () {
    assert.deepEqual(normalizeList('nope'), []);
    assert.deepEqual(normalizeList(null), []);
    assert.deepEqual(normalizeList(['cat', 3, null, 'CAT', ' dog ', '']), ['cat', 'dog']);
});

t('save then load round-trips; an empty list removes the key', function () {
    var s = fakeStorage();
    saveRecent(s, ['cat', 'dog']);
    assert.equal(s.data[STORE_KEY], '["cat","dog"]');
    assert.deepEqual(loadRecent(s), ['cat', 'dog']);
    saveRecent(s, []);
    assert.equal(STORE_KEY in s.data, false);
    assert.deepEqual(loadRecent(s), []);
});

t('corrupt JSON, a missing storage and a throwing storage all give an empty list', function () {
    assert.deepEqual(loadRecent(fakeStorage({ [STORE_KEY]: '{not json' })), []);
    assert.deepEqual(loadRecent(null), []);
    var boom = {
        getItem: function () { throw new Error('denied'); },
        setItem: function () { throw new Error('denied'); },
        removeItem: function () { throw new Error('denied'); }
    };
    assert.deepEqual(loadRecent(boom), []);
    saveRecent(boom, ['cat']);
    saveRecent(boom, []);
});

t('listSig differs when order or content differs', function () {
    assert.notEqual(listSig(['a b', 'c']), listSig(['a', 'b c']));
    assert.notEqual(listSig(['cat', 'dog']), listSig(['dog', 'cat']));
    assert.equal(listSig([]), '');
});

console.log(passed + ' passed');
