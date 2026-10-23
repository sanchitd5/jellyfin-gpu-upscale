import assert from 'node:assert/strict';
import { columnsFor, shapeOf, MAX_COLS } from './grid-density.js';

// shapes
assert.equal(shapeOf('cardPadder-portrait'), 'portrait');
assert.equal(shapeOf('cardPadder-overflowPortrait'), 'portrait');
assert.equal(shapeOf('cardPadder-square'), 'square');
assert.equal(shapeOf('cardPadder-mixedBackdrop'), 'backdrop');
assert.equal(shapeOf('cardPadder-smallBackdrop'), 'backdrop');
assert.equal(shapeOf('cardPadder-overflowBanner'), 'banner');
assert.equal(shapeOf(''), 'portrait');
assert.equal(shapeOf(undefined), 'portrait');

// portrait posters (min 9rem = 144px at 16px), gap 8
assert.equal(columnsFor(340, 'portrait', 8, 16), 2);    // small phone
assert.equal(columnsFor(366, 'portrait', 8, 16), 2);    // 390 px phone
assert.equal(columnsFor(430, 'portrait', 8, 16), 2);    // large phone: 438/152 = 2.88
assert.equal(columnsFor(500, 'portrait', 8, 16), 3);    // phone landscape-ish
assert.equal(columnsFor(800, 'portrait', 8, 16), 5);    // tablet
assert.equal(columnsFor(1400, 'portrait', 8, 16), 9);   // desktop

// a grid never has fewer than two poster columns, however narrow
assert.equal(columnsFor(100, 'portrait', 8, 16), 2);
assert.equal(columnsFor(0, 'portrait', 8, 16), 2);

// landscape cards want more room: fewer columns at the same width
assert.ok(columnsFor(800, 'backdrop', 8, 16) < columnsFor(800, 'portrait', 8, 16));
assert.equal(columnsFor(366, 'backdrop', 8, 16), 2);
assert.equal(columnsFor(366, 'banner', 8, 16), 1);

// monotonic in width, and capped
var last = 0;
for (var w = 200; w <= 4000; w += 50) {
    var c = columnsFor(w, 'portrait', 8, 16);
    assert.ok(c >= last, 'monotonic at ' + w);
    assert.ok(c <= MAX_COLS);
    last = c;
}
assert.equal(columnsFor(9000, 'portrait', 8, 16), MAX_COLS);

// it follows the viewer's font size: a larger rem means bigger cards, so fewer columns
assert.ok(columnsFor(800, 'portrait', 8, 20) < columnsFor(800, 'portrait', 8, 16));

// bad input falls back to sane values
assert.equal(columnsFor(800, 'nonsense', 8, 16), columnsFor(800, 'portrait', 8, 16));
assert.equal(columnsFor(800, 'portrait', -1, 0), columnsFor(800, 'portrait', 0, 16));

console.log('grid-density tests ok');
