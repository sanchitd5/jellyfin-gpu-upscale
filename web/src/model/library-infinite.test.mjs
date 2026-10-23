// Run: node web/src/model/library-infinite.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import { parts } from './search-census.js';
import { rewriteListUrl, listSignature, createSeeds } from './list-requests.js';
import {
    isLibraryListUrl, startOf, limitOf, nextUrl, pageOf, pageCount, reachedEnd, pillText, currentPage,
    cardOptionsFor, supportsTab
} from './library-infinite.js';

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

var H = 'http://h/jf';
var PAGE = H + '/Items?userId=u&StartIndex=0&Limit=100&Fields=PrimaryImageAspectRatio,SortName&IncludeItemTypes=Movie&Recursive=true&SortBy=Random&SortOrder=Ascending&ParentId=p&EnableTotalRecordCount=true';

t('a library tab page request is recognised', function () {
    assert.equal(isLibraryListUrl(PAGE), true);
    assert.equal(isLibraryListUrl(H + '/Users/u/Items?startindex=200&limit=50&sortby=SortName'), true);
});

t('searches, id lookups, the playback queue, our own follow-ups and uncounted sections are not', function () {
    [
        PAGE + '&searchTerm=abc',
        PAGE + '&ids=a,b',
        PAGE.replace('Fields=PrimaryImageAspectRatio', 'Fields=Chapters,PrimaryImageAspectRatio'),
        PAGE + '&jpInf=1',
        PAGE.replace('EnableTotalRecordCount=true', 'EnableTotalRecordCount=false'),
        H + '/Items?SortBy=Random&Limit=20',
        H + '/Items?StartIndex=0',
        H + '/Items/Filters?parentId=p&startIndex=0&limit=5',
        H + '/Shows/NextUp?startIndex=0&limit=10'
    ].forEach(function (u) { assert.equal(isLibraryListUrl(u), false, u); });
    assert.equal(isLibraryListUrl(undefined), false);
});

t('nextUrl changes only StartIndex and marks the request as ours', function () {
    var out = nextUrl(PAGE, 100);
    assert.equal(startOf(out), 100);
    assert.equal(limitOf(out), 100);
    assert.ok(/[?&]jpInf=1(&|$)/.test(out));
    var a = parts(PAGE).q;
    var b = parts(out).q;
    Object.keys(a).forEach(function (k) {
        if (k !== 'startindex') { assert.deepEqual(b[k], a[k], k); }
    });
    assert.deepEqual(Object.keys(b).sort(), Object.keys(a).concat(['jpinf']).sort());
});

t('nextUrl keeps a hash, never doubles StartIndex or jpInf, and keeps a Random seed', function () {
    var seeded = PAGE + '&jpListSeed=777';
    var once = nextUrl(seeded + '#x', 200);
    var twice = nextUrl(once, 300);
    assert.ok(once.endsWith('#x'));
    assert.equal((twice.match(/startindex=/ig) || []).length, 1);
    assert.equal((twice.match(/jpInf=/g) || []).length, 1);
    assert.equal(parts(twice).q.jplistseed[0], '777');
    assert.equal(startOf(twice), 300);
});

t('Random: every follow-up page is the same shuffle as page 1 (seed pinned, signature unchanged)', function () {
    var seeds = createSeeds(function () { return 0.5; });
    var sent = rewriteListUrl(PAGE, { seedFor: seeds.seedFor });
    assert.ok(/jpListSeed=\d+/.test(sent));
    var next = nextUrl(sent, 100);
    // already seeded: the page-request rewrite leaves it alone, so the seed cannot change
    assert.equal(rewriteListUrl(next, { seedFor: function () { return 1; } }), next);
    assert.equal(listSignature(parts(PAGE)), listSignature(parts(next)));
    // and if the seed were applied from the raw url instead, the same list still gets the same seed
    var raw = rewriteListUrl(nextUrl(PAGE, 100), { seedFor: seeds.seedFor });
    assert.equal(parts(raw).q.jplistseed[0], parts(sent).q.jplistseed[0]);
});

t('page arithmetic, including a short last page and an empty list', function () {
    assert.equal(pageOf(0, 100), 1);
    assert.equal(pageOf(99, 100), 1);
    assert.equal(pageOf(100, 100), 2);
    assert.equal(pageOf(250, 100), 3);
    assert.equal(pageCount(250, 100), 3);
    assert.equal(pageCount(300, 100), 3);
    assert.equal(pageCount(0, 100), 1);
    assert.equal(pageCount(5, 0), 1);
    assert.equal(pillText(2, 7), 'Page 2 of 7');
});

t('the end of the list: a short page, or everything counted', function () {
    assert.equal(reachedEnd(0, 100, 250, 100), false);
    assert.equal(reachedEnd(200, 100, 250, 50), true);
    assert.equal(reachedEnd(200, 100, 300, 100), true);
    assert.equal(reachedEnd(0, 100, 40, 40), true);
});

t('the page under the reading line follows the chunks', function () {
    var tops = [{ page: 2, top: 900 }, { page: 2, top: 1500 }, { page: 3, top: 2100 }];
    assert.equal(currentPage(1, tops, 300), 1);
    assert.equal(currentPage(1, [{ page: 2, top: -400 }, { page: 2, top: 400 }, { page: 3, top: 1200 }], 300), 2);
    assert.equal(currentPage(1, [{ page: 2, top: -4000 }, { page: 3, top: -100 }], 300), 3);
    assert.equal(currentPage(4, [], 300), 4);
    assert.equal(currentPage(1, tops, 5000), 3);
});

t('card options follow the tab settings the way ItemsView does', function () {
    var m = cardOptionsFor('movies', { ShowTitle: true, ShowYear: true, ImageType: 'Primary' }, 'movies', 'portrait');
    assert.equal(m.shape, 'portrait');
    assert.equal(m.overlayPlayButton, true);
    assert.equal(m.overlayText, false);
    assert.equal(m.showTitle, true);
    var noTitle = cardOptionsFor('series', { ShowTitle: false, ImageType: 'Thumb' }, '', '');
    assert.equal(noTitle.overlayText, true);
    assert.equal(noTitle.shape, 'backdrop');
    assert.equal(noTitle.preferThumb, true);
    assert.equal(noTitle.overlayMoreButton, true);
    var artists = cardOptionsFor('artists', {}, '', 'square');
    assert.equal(artists.lines, 1);
    assert.equal(artists.showYear, false);
    assert.equal(cardOptionsFor('episodes', { ShowTitle: true }, '', 'backdrop').showParentTitle, true);
    assert.equal(cardOptionsFor('movies', { ImageType: 'Banner' }, '', '').shape, 'banner');
    assert.equal(cardOptionsFor('movies', null, '', '').showTitle, true);
});

t('list mode and non-grid tabs are left to the stock pager', function () {
    assert.equal(supportsTab('movies', { ViewMode: 'grid' }), true);
    assert.equal(supportsTab('movies', {}), true);
    assert.equal(supportsTab('movies', { ViewMode: 'list' }), false);
    assert.equal(supportsTab('songs', {}), false);
    assert.equal(supportsTab('channels', {}), false);
    assert.equal(supportsTab('', {}), false);
});

console.log(passed + ' passed');
