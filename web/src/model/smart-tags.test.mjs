// Run: node web/src/model/smart-tags.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import { parseCategories, toGroups, primaryFacet, primaryTagOf, withPrimary, scopeFromHash } from './smart-tags.js';

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

// Neutral synthetic vocabulary: no real library content.
var ROUTE = [
    { id: 'exclusive:00ff', label: 'Group A', kind: 'exclusive', primary: true, coverage: 970,
        tags: [{ name: 'Apple', label: 'Apple', count: 400 }, { name: 'river', label: 'river', count: 330 }, { name: 'stone', label: 'stone', count: 230 }, { name: 'cloud', label: 'cloud', count: 10 }] },
    { id: 'prefix:tint', label: 'Tint', kind: 'prefix', prefix: 'tint', primary: false, coverage: 900,
        tags: [{ name: 'tintalpha', label: 'alpha', count: 500 }, { name: 'tintbravo', label: 'bravo', count: 400 }] },
    { id: 'exclusive:0a0a', label: 'Group B', kind: 'exclusive', primary: false, coverage: 600,
        tags: [{ name: 'north', label: 'north', count: 300 }, { name: 'south', label: 'south', count: 300 }] },
    { id: 'popular', label: 'Popular', kind: 'popular', primary: false, coverage: 990,
        tags: [{ name: 'common', label: 'common', count: 900 }] }
];

t('parseCategories keeps well-formed entries and drops junk', function () {
    var list = parseCategories(ROUTE.concat([null, 'x', { label: '' }, { label: 'Empty', kind: 'exclusive', tags: [] }, { label: 'P', kind: 'prefix', tags: [{ name: 'a' }] }]));
    assert.equal(list.length, 4);
    assert.equal(list[1].prefix, 'tint');
    assert.equal(list[0].tags[0].label, 'Apple');
    assert.deepEqual(parseCategories('garbage'), []);
    assert.deepEqual(parseCategories(undefined), []);
});

t('toGroups: prefix family -> { name, prefix }, facets -> { name, tags }', function () {
    var g = toGroups(ROUTE);
    assert.deepEqual(g[0], { id: 'smart:exclusive:00ff', name: 'Group A', kind: 'exclusive', tags: ['Apple', 'river', 'stone', 'cloud'] });
    assert.deepEqual(g[1], { id: 'smart:prefix:tint', name: 'Tint', kind: 'prefix', prefix: 'tint' });
    assert.deepEqual(g[3].tags, ['common']);
});

// The quick tag groups' suggestion parser (model/quick-tags.js parseSuggested) when it is present: it must
// accept the adapter's output unchanged. Skipped on a tree without it.
var quick = null;
try {
    quick = await import('./quick-tags.js');
} catch (e) {
    console.log('skip quick-tags.js not present');
}

if (quick && typeof quick.parseSuggested === 'function') {
    t('toGroups output is accepted by quick-tags parseSuggested', function () {
        var s = quick.parseSuggested(toGroups(ROUTE));
        assert.equal(s.length, 4);
        assert.equal(s[1].prefix, 'tint');
        assert.deepEqual(s[0].tags, ['Apple', 'river', 'stone', 'cloud']);
        assert.ok(s.every(function (x) { return typeof x.name === 'string' && x.name.length > 0; }));
    });
}

t('primaryFacet: the flagged exclusive facet, or null', function () {
    assert.equal(primaryFacet(ROUTE).label, 'Group A');
    assert.equal(primaryFacet(ROUTE.slice(1)), null);
    assert.equal(primaryFacet([]), null);
    // a primary flag on a non-exclusive kind is not trusted
    assert.equal(primaryFacet([{ label: 'X', kind: 'popular', primary: true, tags: [{ name: 'a' }] }]), null);
});

t('primaryTagOf finds the item tag of the primary facet, case/diacritic-insensitive', function () {
    assert.deepEqual(primaryTagOf(['zzz', 'APPLE', 'tintalpha'], ROUTE), { name: 'Apple', label: 'Apple' });
    assert.deepEqual(primaryTagOf(['Stóne'], ROUTE), { name: 'stone', label: 'stone' });
    assert.equal(primaryTagOf(['tintalpha', 'north'], ROUTE), null); // tags of other categories only
    assert.equal(primaryTagOf([], ROUTE), null);
    assert.equal(primaryTagOf(null, ROUTE), null);
    assert.equal(primaryTagOf(['apple'], []), null);
    assert.equal(primaryTagOf(['apple'], null), null);
});

t('primaryTagOf: an item with two facet tags gets the larger one (facet order)', function () {
    assert.deepEqual(primaryTagOf(['cloud', 'river'], ROUTE), { name: 'river', label: 'river' });
});

t('primaryTagOf: a prefix-family primary facet shows the remainder label', function () {
    var cats = [{ id: 'x', label: 'Tint', kind: 'exclusive', primary: true, coverage: 1, tags: [{ name: 'tintalpha', label: 'alpha', count: 3 }] }];
    assert.deepEqual(primaryTagOf(['TintAlpha'], cats), { name: 'tintalpha', label: 'alpha' });
});

t('withPrimary resolves once and primaryTagOf uses it', function () {
    var w = withPrimary(ROUTE);
    assert.equal(w.__primary.label, 'Group A');
    assert.deepEqual(primaryTagOf(['river'], w), { name: 'river', label: 'river' });
    assert.equal(primaryTagOf(['river'], withPrimary([])), null);
});

t('scopeFromHash: parentId, then topParentId, else empty', function () {
    assert.equal(scopeFromHash('#/list?parentId=0123456789ABCDEF0123456789abcdef&serverId=x'), '0123456789abcdef0123456789abcdef');
    assert.equal(scopeFromHash('#/movies?topParentId=01234567-89ab-cdef-0123-456789abcdef'), '0123456789abcdef0123456789abcdef');
    assert.equal(scopeFromHash('#/home'), '');
    assert.equal(scopeFromHash('#/list?parentId=not-an-id'), '');
    assert.equal(scopeFromHash(undefined), '');
    assert.equal(scopeFromHash('#/list?parentId=%E0%A4%A'), '');
});

console.log(passed + ' passed');
