// Run: node web/src/model/search-paging.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import {
    kindOf, rewritePagedUrl, pagingOf, summarize, worthShowing, rangeText, pageAfterEmpty, pageCount,
    normalizeSize, normalizeSizes, normalizeMode, chunkItems, reachedEnd, cardOptionsFor, shapeForType,
    typeTitle, SIZES, DEFAULT_SIZES, INF_SIZES, CHUNK
} from './search-paging.js';
import { rewriteSearchUrl, normalizeState, defaultState } from './search-filters.js';

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

var ALL = 'http://h/Items?userId=u&recursive=true&includeItemTypes=Movie&includeItemTypes=Series&searchTerm=cat&limit=800&enableTotalRecordCount=false&fields=X';
var VID = 'http://h/Items?userId=u&recursive=true&mediaTypes=Video&excludeItemTypes=Movie&excludeItemTypes=Episode&searchTerm=cat&limit=100&enableTotalRecordCount=false';

function q(url) {
    var o = {};
    new URLSearchParams(url.split('?')[1]).forEach(function (v, k) { (o[k] = o[k] || []).push(v); });
    return o;
}

t('kindOf tells the two result queries apart and ignores everything else', function () {
    assert.deepEqual(kindOf(VID), { kind: 'video', discard: false });
    assert.deepEqual(kindOf(ALL), { kind: 'all', discard: false });
    assert.equal(kindOf('http://h/Persons?searchTerm=cat&limit=40'), null);
    assert.equal(kindOf('http://h/Studios?searchTerm=cat'), null);
    assert.equal(kindOf('http://h/Items?userId=u&limit=100&mediaTypes=Video'), null); // no search term
    assert.equal(kindOf('http://h/Items?searchTerm=cat&limit=50'), null); // neither query
    assert.equal(kindOf(5), null);
});

t('a one-item request is a discard, whichever query it was cut from', function () {
    assert.deepEqual(kindOf(VID.replace('limit=100', 'limit=1')), { kind: 'video', discard: true });
    assert.deepEqual(kindOf(ALL.replace('limit=800', 'limit=1')), { kind: 'all', discard: true });
    var u = rewritePagedUrl(ALL.replace('limit=800', 'limit=1'), 3, 200);
    assert.equal(u, ALL.replace('limit=800', 'limit=1'));
});

t('rewritePagedUrl sets the slice, asks for the total and flags the request', function () {
    var o = q(rewritePagedUrl(VID, 3, 50));
    assert.deepEqual(o.startIndex, ['100']);
    assert.deepEqual(o.limit, ['50']);
    assert.deepEqual(o.enableTotalRecordCount, ['true']);
    assert.deepEqual(o.jpPaged, ['true']);
    assert.deepEqual(o.mediaTypes, ['Video']);
    assert.deepEqual(o.searchTerm, ['cat']);
    assert.deepEqual(o.excludeItemTypes, ['Movie', 'Episode']);
});

t('rewritePagedUrl is idempotent and never doubles a parameter', function () {
    var once = rewritePagedUrl(ALL, 2, 200);
    var twice = rewritePagedUrl(once, 2, 200);
    assert.equal(once, twice);
    var o = q(rewritePagedUrl(once, 5, 400));
    ['startIndex', 'limit', 'enableTotalRecordCount', 'jpPaged'].forEach(function (k) {
        assert.equal(o[k].length, 1, k);
    });
    assert.deepEqual(o.startIndex, ['1600']);
    assert.deepEqual(o.includeItemTypes, ['Movie', 'Series']);
});

t('page 1 starts at 0; a bad page or size leaves a safe request', function () {
    assert.deepEqual(q(rewritePagedUrl(VID, 1, 100)).startIndex, ['0']);
    assert.deepEqual(q(rewritePagedUrl(VID, 0, 100)).startIndex, ['0']);
    assert.deepEqual(q(rewritePagedUrl(VID, -4, 100)).startIndex, ['0']);
    assert.equal(rewritePagedUrl(VID, 2, 0), VID);
    assert.equal(rewritePagedUrl(VID, 2, 'x'), VID);
});

t('a url fragment survives', function () {
    var o = rewritePagedUrl(VID + '#frag', 2, 50);
    assert.ok(o.endsWith('#frag'));
});

t('paging composes with the Sort & filter rewrite in either order and keeps its sort, filters and seed', function () {
    var s = normalizeState(Object.assign(defaultState(), { sort: 'Random', seed: 4242, favorites: true, tags: ['a', 'b'] }));
    var NOW = new Date('2026-10-22T15:30:00Z');
    var filtered = rewriteSearchUrl(VID, s, NOW);
    var paged = rewritePagedUrl(filtered, 4, 50);
    var o = q(paged);
    assert.deepEqual(o.sortBy, ['Random']);
    assert.deepEqual(o.jpSeed, ['4242']);
    assert.deepEqual(o.isFavorite, ['true']);
    assert.deepEqual(o.tags, ['a|b']);
    assert.deepEqual(o.startIndex, ['150']);
    // The infinite follow-up reuses the marked url and changes only the slice.
    var next = rewritePagedUrl(paged, 5, 50);
    var n = q(next);
    assert.deepEqual(n.startIndex, ['200']);
    ['sortBy', 'jpSeed', 'isFavorite', 'tags', 'searchTerm'].forEach(function (k) {
        assert.deepEqual(n[k], o[k], k);
    });
    // And the sheet's discard of the other query is left alone by paging.
    var cut = rewriteSearchUrl(ALL, normalizeState(Object.assign(defaultState(), { type: 'videos' })), NOW);
    assert.equal(q(cut).limit[0], '1');
    assert.equal(rewritePagedUrl(cut, 3, 200), cut);
});

t('pagingOf reads back what rewritePagedUrl wrote', function () {
    assert.deepEqual(pagingOf(rewritePagedUrl(VID, 3, 50)), { start: 100, size: 50, page: 3 });
    assert.equal(pagingOf(VID), null);
});

t('summarize: totals never read lower than what was seen', function () {
    var req = { start: 100, size: 50, page: 3 };
    var items = [];
    for (var i = 0; i < 50; i++) { items.push({ Id: 'ID' + i }); }
    var s = summarize(req, { Items: items, TotalRecordCount: 0 });
    assert.equal(s.total, 150);
    assert.equal(s.pages, 3);
    assert.equal(s.count, 50);
    assert.ok(s.ids.id7);
    s = summarize(req, { Items: items, TotalRecordCount: 342 });
    assert.equal(s.total, 342);
    assert.equal(s.pages, 7);
    assert.equal(summarize(req, { nope: 1 }), null);
    assert.equal(summarize(null, { Items: [] }), null);
});

t('worthShowing: more than one page, or not on the first', function () {
    assert.equal(worthShowing({ page: 1, size: 100, total: 100 }), false);
    assert.equal(worthShowing({ page: 1, size: 100, total: 101 }), true);
    assert.equal(worthShowing({ page: 2, size: 100, total: 90 }), true);
    assert.equal(worthShowing(null), false);
});

t('rangeText and page maths', function () {
    assert.equal(rangeText({ start: 100, count: 100, total: 342 }), '101-200 of 342');
    assert.equal(rangeText({ start: 300, count: 42, total: 342 }), '301-342 of 342');
    assert.equal(rangeText({ start: 0, count: 0, total: 0 }), '0 of 0');
    assert.equal(pageCount(0, 100), 1);
    assert.equal(pageCount(201, 100), 3);
    assert.equal(pageAfterEmpty({ page: 5, size: 100, total: 250 }), 3);
    assert.equal(pageAfterEmpty({ page: 2, size: 100, total: 0 }), 1);
});

t('sizes: only the offered ones, else the stock default', function () {
    assert.equal(normalizeSize('video', 50), 50);
    assert.equal(normalizeSize('video', 51), DEFAULT_SIZES.video);
    assert.equal(normalizeSize('all', 'x'), DEFAULT_SIZES.all);
    assert.deepEqual(normalizeSizes(null), DEFAULT_SIZES);
    assert.deepEqual(normalizeSizes({ video: 200, all: 5 }), { video: 200, all: 800 });
    assert.ok(SIZES.video.indexOf(DEFAULT_SIZES.video) !== -1);
    assert.ok(SIZES.all.indexOf(DEFAULT_SIZES.all) !== -1);
    assert.equal(DEFAULT_SIZES.video, 100);
    assert.equal(DEFAULT_SIZES.all, 800);
});

t('infinite: small slices, whole-row chunks, mode parsing', function () {
    assert.ok(INF_SIZES.video <= 50 && INF_SIZES.all <= 200);
    assert.equal(CHUNK % 2, 0);
    assert.equal(CHUNK % 3, 0);
    assert.equal(CHUNK % 4, 0);
    assert.equal(normalizeMode('infinite'), 'infinite');
    assert.equal(normalizeMode('paged'), 'paged');
    assert.equal(normalizeMode('x'), null);
    assert.equal(normalizeMode(null), null);
});

t('chunkItems splits in order and loses nothing', function () {
    var list = [];
    for (var i = 0; i < 30; i++) { list.push(i); }
    var parts = chunkItems(list, CHUNK);
    assert.deepEqual(parts.map(function (p) { return p.length; }), [12, 12, 6]);
    assert.deepEqual([].concat.apply([], parts), list);
    assert.deepEqual(chunkItems([], 12), []);
});

t('reachedEnd: a short slice, or reaching the total', function () {
    assert.equal(reachedEnd(100, 50, 400, 50), false);
    assert.equal(reachedEnd(120, 50, 400, 20), true);
    assert.equal(reachedEnd(400, 50, 400, 50), true);
});

t('appended cards get jellyfin-web search page options for their type', function () {
    assert.equal(cardOptionsFor('video', 'Video', 'overflowBackdrop').showParentTitle, true);
    assert.equal(cardOptionsFor('all', 'Movie', 'overflowPortrait').showYear, true);
    var ep = cardOptionsFor('all', 'Episode', 'overflowBackdrop');
    assert.equal(ep.coverImage, true);
    assert.equal(ep.showParentTitle, true);
    assert.equal(cardOptionsFor('all', 'Audio', 'overflowSquare').showParentTitle, true);
    assert.equal(cardOptionsFor('all', 'Movie', 'overflowPortrait').shape, 'overflowPortrait');
    assert.equal(shapeForType('Movie'), 'overflowPortrait');
    assert.equal(shapeForType('Episode'), 'overflowBackdrop');
    assert.equal(shapeForType('Audio'), 'overflowSquare');
    assert.equal(typeTitle('Series'), 'Shows');
    assert.equal(typeTitle('Weird'), 'Weird');
});

console.log(passed + ' passed');
