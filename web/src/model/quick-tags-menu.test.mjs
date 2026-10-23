// Run: node web/src/model/quick-tags-menu.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import { menuChips, pickedLabel, SEARCH_MIN, COLLAPSED } from './quick-tags-menu.js';

var passed = 0;
function t(name, fn) {
    try { fn(); passed++; console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n' + e.message); process.exitCode = 1; }
}
function mk(n) {
    var a = [];
    for (var i = 0; i < n; i++) { a.push({ tag: 'p-t' + i, label: 't' + i }); }
    return a;
}

t('short group: all chips, no search, no more', function () {
    var r = menuChips(mk(5), '', false, []);
    assert.equal(r.shown.length, 5); assert.equal(r.more, 0); assert.equal(r.searchable, false);
});
t('search offered from SEARCH_MIN chips', function () {
    assert.equal(menuChips(mk(SEARCH_MIN), '', false, []).searchable, true);
    assert.equal(menuChips(mk(SEARCH_MIN - 1), '', false, []).searchable, false);
});
t('long group collapses to COLLAPSED and reports the rest', function () {
    var r = menuChips(mk(30), '', false, []);
    assert.equal(r.shown.length, COLLAPSED); assert.equal(r.more, 30 - COLLAPSED);
});
t('picked chips beyond the cut stay visible', function () {
    var r = menuChips(mk(30), '', false, ['p-t25']);
    assert.equal(r.shown.length, COLLAPSED + 1); assert.equal(r.more, 30 - COLLAPSED - 1);
    assert.ok(r.shown.some(function (c) { return c.tag === 'p-t25'; }));
});
t('expanded shows everything', function () {
    var r = menuChips(mk(30), '', true, []);
    assert.equal(r.shown.length, 30); assert.equal(r.more, 0);
});
t('query filters all chips by label or tag, case-insensitively', function () {
    var r = menuChips(mk(30), 'T2', false, []);
    assert.deepEqual(r.shown.map(function (c) { return c.label; }), ['t2', 't20', 't21', 't22', 't23', 't24', 't25', 't26', 't27', 't28', 't29']);
    assert.equal(r.more, 0);
});
t('pickedLabel', function () {
    assert.equal(pickedLabel(0), ''); assert.equal(pickedLabel(3), '3');
});
console.log(passed + ' passed');
