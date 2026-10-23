// Run: node web/src/model/list-sort.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import {
    extendSortOptions, tagDefaultSort, modernRecentApplies, modernRecentActive, modernRecentUpdate,
    markChosen, loadChosen, RANDOM_OPTION, RECENT_OPTION, TAG_DEFAULT
} from './list-sort.js';

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

// The legacy list controller's menu for a tag list (list.js getSortMenuOptions).
var STOCK = [
    { name: 'Name', value: 'SortName' },
    { name: 'Community Rating', value: 'CommunityRating,SortName' },
    { name: 'Critic Rating', value: 'CriticRating,SortName' },
    { name: 'Date Added', value: 'DateCreated,SortName' },
    { name: 'Date Played', value: 'DatePlayed,SortName' },
    { name: 'Parental Rating', value: 'OfficialRating,SortName' },
    { name: 'Play Count', value: 'PlayCount,SortName' },
    { name: 'Release Date', value: 'ProductionYear,PremiereDate,SortName' },
    { name: 'Runtime', value: 'Runtime,SortName' }
];

t('Random and Recently edited are appended to a library list menu', function () {
    var out = extendSortOptions(STOCK, { type: 'tag' });
    assert.equal(out.length, STOCK.length + 2);
    assert.deepEqual(out.slice(0, STOCK.length), STOCK);
    assert.deepEqual(out[STOCK.length], RANDOM_OPTION);
    assert.deepEqual(out[STOCK.length + 1], RECENT_OPTION);
    assert.equal(STOCK.length, 9, 'the input array is not modified');
});

t('a menu that already has Random only gets Recently edited', function () {
    var withRandom = STOCK.concat([{ name: 'Random', value: 'Random,SortName' }]);
    var out = extendSortOptions(withRandom, {});
    assert.equal(out.length, withRandom.length + 1);
    assert.deepEqual(out[out.length - 1], RECENT_OPTION);
});

t('nothing to add returns the very same array', function () {
    var both = STOCK.concat([RANDOM_OPTION, RECENT_OPTION]);
    assert.equal(extendSortOptions(both, {}), both);
});

t('Live TV and menus that are not library lists are left alone', function () {
    assert.equal(extendSortOptions(STOCK, { type: 'Programs' }), STOCK);
    var live = [{ name: 'Air Date', value: 'StartDate,SortName' }, { name: 'Name', value: 'SortName' }];
    assert.equal(extendSortOptions(live, {}), live);
    assert.equal(extendSortOptions(undefined, {}), undefined);
    assert.equal(extendSortOptions(null, {}), null);
    assert.deepEqual(extendSortOptions([], {}), []);
});

t('tag lists open newest first while the saved state is the stock default', function () {
    var stock = { sortBy: 'SortName', sortOrder: 'Ascending' };
    var out = tagDefaultSort(stock, { type: 'tag', tag: 'x' }, 'items-tag', {});
    assert.deepEqual(out, TAG_DEFAULT);
    assert.deepEqual(stock, { sortBy: 'SortName', sortOrder: 'Ascending' }, 'input not modified');
});

t('a sort the viewer saved, or chose through the menu, is theirs', function () {
    var saved = { sortBy: 'Runtime,SortName', sortOrder: 'Descending' };
    assert.equal(tagDefaultSort(saved, { type: 'tag' }, 'items-tag', {}), saved);
    var byName = { sortBy: 'SortName', sortOrder: 'Descending' };
    assert.equal(tagDefaultSort(byName, { type: 'tag' }, 'items-tag', {}), byName);
    var stock = { sortBy: 'SortName', sortOrder: 'Ascending' };
    assert.equal(tagDefaultSort(stock, { type: 'tag' }, 'items-tag', { 'items-tag': true }), stock);
});

t('only tag lists change', function () {
    var stock = { sortBy: 'SortName', sortOrder: 'Ascending' };
    [{ type: 'Video' }, { type: 'Person' }, { parentId: 'p' }, {}, null, undefined].forEach(function (p) {
        assert.equal(tagDefaultSort(stock, p, 'k', {}), stock);
    });
    assert.equal(tagDefaultSort(undefined, { type: 'tag' }, 'k', {}), undefined);
});

t('the chosen map is kept in localStorage and survives a broken store', function () {
    var data = {};
    globalThis.window = { localStorage: { getItem: function (k) { return data[k] === undefined ? null : data[k]; }, setItem: function (k, v) { data[k] = v; } } };
    assert.deepEqual(loadChosen(), {});
    markChosen('items-tag');
    markChosen('items-tag');
    assert.deepEqual(loadChosen(), { 'items-tag': true });
    data['jellyfinPlus.listSortChosen'] = 'not json';
    assert.deepEqual(loadChosen(), {});
    globalThis.window = { localStorage: { getItem: function () { throw new Error('denied'); }, setItem: function () { throw new Error('denied'); } } };
    assert.deepEqual(loadChosen(), {});
    markChosen('x'); // must not throw
    delete globalThis.window;
});

t('modern tabs: Recently edited applies to item list tabs only', function () {
    ['movies', 'videos', 'musicvideos', 'folders', 'mixed', 'photos', 'favorites'].forEach(function (v) {
        assert.equal(modernRecentApplies(v), true, v);
    });
    ['songs', 'albums', 'series', 'playlists', 'episodes', 'collections', 'books', '', undefined].forEach(function (v) {
        assert.equal(modernRecentApplies(v), false, String(v));
    });
});

t('modern tabs: picking it sorts newest first, picking again flips', function () {
    var prev = { StartIndex: 300, SortBy: ['SortName'], SortOrder: 'Ascending', ShowTitle: true };
    var a = modernRecentUpdate(prev);
    assert.deepEqual(a, { StartIndex: 0, SortBy: ['DateLastSaved'], SortOrder: 'Descending', ShowTitle: true });
    assert.equal(prev.StartIndex, 300, 'previous settings are not modified');
    assert.equal(modernRecentActive(a), true);
    var b = modernRecentUpdate(a);
    assert.equal(b.SortOrder, 'Ascending');
    assert.equal(modernRecentUpdate(b).SortOrder, 'Descending');
});

t('modern tabs: only a lone DateLastSaved counts as active', function () {
    assert.equal(modernRecentActive({ SortBy: ['DateLastSaved'] }), true);
    assert.equal(modernRecentActive({ SortBy: ['DateLastSaved', 'SortName'] }), false);
    assert.equal(modernRecentActive({ SortBy: ['Random'] }), false);
    assert.equal(modernRecentActive({}), false);
    assert.equal(modernRecentActive(undefined), false);
});

console.log(passed + ' passed');
