// Run: node web/src/model/row-fill.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import { columnsFromTemplate, columnsFromWidths, chunkSize, headCount, planRows } from './row-fill.js';

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

function seq(n, from) {
    var a = [];
    for (var i = 0; i < n; i++) { a.push((from || 0) + i); }
    return a;
}

t('columnsFromTemplate counts resolved tracks', function () {
    assert.equal(columnsFromTemplate('100px 100px 100px'), 3);
    assert.equal(columnsFromTemplate('none'), 0);
    assert.equal(columnsFromTemplate(''), 0);
});

t('columnsFromWidths tolerates rounding and bad input', function () {
    assert.equal(columnsFromWidths(1200, 200), 6);
    assert.equal(columnsFromWidths(1199.99, 199.999), 6);
    assert.equal(columnsFromWidths(0, 100), 0);
    assert.equal(columnsFromWidths(100, 300), 1);
});

t('chunkSize is whole rows near the target', function () {
    [1, 2, 3, 4, 5, 6, 7, 8].forEach(function (c) {
        var s = chunkSize(c, 12);
        assert.equal(s % c, 0);
        assert.ok(s >= 12 && s < 12 + c);
    });
});

t('headCount closes the stock row', function () {
    assert.equal(headCount(100, 5), 0);
    assert.equal(headCount(100, 6), 2);
    assert.equal(headCount(100, 7), 5);
    assert.equal(headCount(0, 5), 0);
});

t('every boundary falls on a row edge for every column count and stock size', function () {
    for (var cols = 1; cols <= 9; cols++) {
        [100, 50, 37].forEach(function (stock) {
            var need = headCount(stock, cols);
            var carry = [];
            var shown = stock;
            var next = 0;
            var all = [];
            for (var page = 0; page < 7; page++) {
                var last = page === 6;
                var plan = planRows(carry.concat(seq(100, next)), cols, chunkSize(cols, 12), need, last);
                next += 100;
                need = plan.headLeft;
                carry = plan.carry;
                all = all.concat(plan.head);
                shown += plan.head.length;
                plan.chunks.forEach(function (c, i) {
                    var finalShort = last && i === plan.chunks.length - 1;
                    if (!finalShort) {
                        assert.equal(c.length % cols, 0, 'chunk of ' + c.length + ' at ' + cols + ' columns');
                    }

                    // a chunk starts a row: everything above it is a whole number of rows
                    assert.equal(shown % cols, 0);
                    all = all.concat(c);
                    shown += c.length;
                });
            }

            assert.equal(carry.length, 0);
            assert.deepEqual(all, seq(700), 'no loss, no duplicates, in order');
        });
    }
});

t('carry is under one row and is kept until flushed', function () {
    var plan = planRows(seq(13), 5, 15, 0, false);
    assert.deepEqual(plan.chunks.map(function (c) { return c.length; }), [10]);
    assert.deepEqual(plan.carry, [10, 11, 12]);
    var done = planRows(plan.carry, 5, 15, 0, true);
    assert.deepEqual(done.chunks, [[10, 11, 12]]);
    assert.equal(done.carry.length, 0);
});

t('too few items to close the stock row place nothing else', function () {
    var plan = planRows(seq(2), 6, 12, 4, true);
    assert.equal(plan.head.length, 2);
    assert.equal(plan.headLeft, 2);
    assert.equal(plan.chunks.length, 0);
});

console.log(passed + ' passed');
