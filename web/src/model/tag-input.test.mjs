// Run: node web/src/model/tag-input.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import { currentToken, withToken, finishedTags, planAdd, sortLikeEditor, pickSuggestions } from './tag-input.js';

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

t('currentToken is the text after the last comma, trimmed', function () {
    assert.equal(currentToken(''), '');
    assert.equal(currentToken('abc'), 'abc');
    assert.equal(currentToken('one, two,  thr'), 'thr');
    assert.equal(currentToken('one, two, '), '');
    assert.equal(currentToken('one\ntw'), 'tw');
});

t('withToken replaces the token being typed and leaves a separator', function () {
    assert.equal(withToken('th', 'three'), 'three, ');
    assert.equal(withToken('one,  two, th', 'three'), 'one, two, three, ');
    assert.equal(withToken('', 'x'), 'x, ');
    assert.equal(withToken('Red, red, th', 'three'), 'Red, three, ');
});

t('finishedTags are the complete ones before the token being typed', function () {
    assert.deepEqual(finishedTags('one'), []);
    assert.deepEqual(finishedTags('one, Two, th'), ['one', 'Two']);
    assert.deepEqual(finishedTags('one, ONE, th'), ['one']);
});

t('planAdd splits on commas, trims and drops blanks', function () {
    assert.deepEqual(planAdd('  red car ,, blue  ,', []), { add: ['red car', 'blue'], dupes: [] });
});

t('planAdd dedupes case-insensitively inside the input, first spelling wins', function () {
    assert.deepEqual(planAdd('Red, red, RED, blue', []), { add: ['Red', 'blue'], dupes: [] });
});

t('planAdd reports tags that are already in the list, in any case', function () {
    assert.deepEqual(planAdd('red, Blue, green', ['BLUE', 'Red']), { add: ['green'], dupes: ['red', 'Blue'] });
});

t('planAdd of only separators or blanks adds nothing', function () {
    assert.deepEqual(planAdd(' , ,, ', ['a']), { add: [], dupes: [] });
    assert.deepEqual(planAdd('', []), { add: [], dupes: [] });
});

t('sortLikeEditor orders case-insensitively without touching the input', function () {
    var src = ['b', 'A', 'c', 'B2'];
    assert.deepEqual(sortLikeEditor(src), ['A', 'b', 'B2', 'c']);
    assert.deepEqual(src, ['b', 'A', 'c', 'B2']);
    assert.deepEqual(sortLikeEditor([{ n: 'b' }, { n: 'A' }], function (o) { return o.n; }), [{ n: 'A' }, { n: 'b' }]);
});

t('pickSuggestions needs something typed', function () {
    assert.deepEqual(pickSuggestions(['alpha'], '', [], 8), []);
    assert.deepEqual(pickSuggestions(['alpha'], 'one, ', [], 8), []);
});

t('pickSuggestions ranks prefix matches first and caps the count', function () {
    var names = ['xcar', 'car', 'carpet', 'scar', 'cart'];
    assert.deepEqual(pickSuggestions(names, 'car', [], 8), ['car', 'carpet', 'cart', 'xcar', 'scar']);
    assert.deepEqual(pickSuggestions(names, 'car', [], 2), ['car', 'carpet']);
});

t('pickSuggestions leaves out tags already in the list or already typed', function () {
    var names = ['car', 'carpet', 'cart'];
    assert.deepEqual(pickSuggestions(names, 'car', ['CART'], 8), ['car', 'carpet']);
    assert.deepEqual(pickSuggestions(names, 'carpet, car', [], 8), ['car', 'cart']);
});

console.log(passed + ' passed');
