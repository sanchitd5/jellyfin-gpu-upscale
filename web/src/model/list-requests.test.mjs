// Run: node web/src/model/list-requests.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import { parts } from './search-census.js';
import {
    rewriteListUrl, createSeeds, wantsSeed, listSignature, isFavouritesSection, FAV_LIMIT
} from './list-requests.js';

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
var seeds = { seedFor: function () { return 4242; } };
var PAGE = H + '/Items?userId=u&StartIndex=0&Limit=100&Fields=PrimaryImageAspectRatio,SortName&ImageTypeLimit=1&IncludeItemTypes=Video&Recursive=true&SortBy=Random&SortOrder=Ascending';

/* ---- seeded random ---- */

t('a Random list page gets a seed appended, the rest untouched', function () {
    assert.equal(rewriteListUrl(PAGE, seeds), PAGE + '&jpListSeed=4242');
});

t('sortBy and path are matched case-insensitively; /Users/{id}/Items too', function () {
    var u = H + '/Users/abc/Items?sortby=random,SortName&startindex=0&limit=50';
    assert.equal(rewriteListUrl(u, seeds), u + '&jpListSeed=4242');
});

t('a hash fragment stays at the end', function () {
    assert.equal(rewriteListUrl(PAGE + '#frag', seeds), PAGE + '&jpListSeed=4242#frag');
});

t('every page of one list shares a signature, other lists do not', function () {
    var a = parts(PAGE);
    var b = parts(PAGE.replace('StartIndex=0', 'StartIndex=300').replace('Limit=100', 'Limit=100'));
    var c = parts(PAGE.replace('IncludeItemTypes=Video', 'IncludeItemTypes=Movie'));
    var d = parts(PAGE.replace('Ascending', 'Descending'));
    assert.equal(listSignature(a), listSignature(b));
    assert.notEqual(listSignature(a), listSignature(c));
    assert.notEqual(listSignature(a), listSignature(d));
});

t('an infinite-scroll follow-up (jpInf) shares its list signature', function () {
    var a = parts(PAGE);
    var b = parts(PAGE.replace('StartIndex=0', 'StartIndex=100') + '&jpInf=1');
    assert.equal(listSignature(a), listSignature(b));
});

t('parameter order does not change the signature', function () {
    var a = parts(H + '/Items?SortBy=Random&startIndex=0&limit=10&tags=a&parentId=p');
    var b = parts(H + '/Items?parentId=p&tags=a&limit=10&startIndex=0&SortBy=Random');
    assert.equal(listSignature(a), listSignature(b));
});

t('requests that must stay truly random are left alone', function () {
    [
        // no paging window (home rows, screensavers)
        H + '/Items?SortBy=Random&Limit=20&Recursive=true',
        H + '/Items?SortBy=Random&StartIndex=0',
        // the playback queue (Play all / Shuffle) re-rolls on purpose
        H + '/Items?StartIndex=0&Limit=300&SortBy=Random&Fields=Chapters,MediaSources,Trickplay&EnableTotalRecordCount=false',
        H + '/Items?StartIndex=0&Limit=300&SortBy=Random&Fields=PrimaryImageAspectRatio,Chapters,Trickplay',
        // total count opted out
        H + '/Items?StartIndex=0&Limit=100&SortBy=Random&EnableTotalRecordCount=false',
        // search has its own seed
        H + '/Items?StartIndex=0&Limit=100&SortBy=Random&searchTerm=cat',
        H + '/Items?StartIndex=0&Limit=100&SortBy=Random&jpSeed=5',
        // lookup by ids
        H + '/Items?StartIndex=0&Limit=100&SortBy=Random&ids=a,b',
        // a seed already there is not overwritten
        H + '/Items?StartIndex=0&Limit=100&SortBy=Random&jpListSeed=9',
        // other sort, other endpoints
        H + '/Items?StartIndex=0&Limit=100&SortBy=SortName',
        H + '/Items/Suggestions?StartIndex=0&Limit=100&SortBy=Random',
        H + '/Artists?StartIndex=0&Limit=100&SortBy=Random',
        H + '/Items?StartIndex=0&Limit=0&SortBy=Random'
    ].forEach(function (u) {
        assert.equal(rewriteListUrl(u, seeds), u, u);
    });
});

t('no seed source means no rewrite', function () {
    assert.equal(rewriteListUrl(PAGE, undefined), PAGE);
    assert.equal(rewriteListUrl(PAGE, {}), PAGE);
    assert.equal(rewriteListUrl(PAGE, { seedFor: function () { return 0; } }), PAGE);
});

t('wantsSeed accepts the page shape the library views send', function () {
    // modern library: lowercase sdk params, no explicit total count
    assert.equal(wantsSeed(parts(H + '/Items?userId=u&parentId=p&startIndex=100&limit=100&sortBy=Random&sortOrder=Ascending&includeItemTypes=Video&recursive=true')), true);
});

t('the seed store: one seed per list, stable, reset reshuffles', function () {
    var n = 0;
    var store = createSeeds(function () { n += 0.25; return n % 1; });
    var a1 = store.seedFor('a');
    var b1 = store.seedFor('b');
    assert.equal(store.seedFor('a'), a1);
    assert.notEqual(a1, b1);
    assert.ok(a1 >= 1 && a1 <= 2147483647);
    store.reset();
    assert.notEqual(store.seedFor('a'), a1);
    // The extremes of the random range stay inside the server's positive int.
    assert.equal(createSeeds(function () { return 0; }).seedFor('x'), 1);
    assert.equal(createSeeds(function () { return 0.9999999999999999; }).seedFor('x'), 2147483647);
});

/* ---- recently edited ---- */

t('DateLastSaved becomes the placeholder plus jpSortKey', function () {
    var u = H + '/Items?SortBy=DateLastSaved,SortName&SortOrder=Descending&Limit=100';
    assert.equal(rewriteListUrl(u, seeds), H + '/Items?SortBy=DateLastContentAdded,SortName&SortOrder=Descending&Limit=100&jpSortKey=DateLastSaved');
});

t('DateLastSaved alone, url-encoded comma, repeated sortBy', function () {
    assert.equal(rewriteListUrl(H + '/Items?sortBy=DateLastSaved', seeds), H + '/Items?sortBy=DateLastContentAdded&jpSortKey=DateLastSaved');
    assert.equal(rewriteListUrl(H + '/Items?SortBy=DateLastSaved%2CSortName', seeds), H + '/Items?SortBy=DateLastContentAdded,SortName&jpSortKey=DateLastSaved');
    assert.equal(rewriteListUrl(H + '/Items?SortBy=DateLastSaved&SortBy=SortName', seeds), H + '/Items?SortBy=DateLastContentAdded&SortBy=SortName&jpSortKey=DateLastSaved');
});

t('recently edited is added once and only on /Items', function () {
    var u = H + '/Items?SortBy=DateLastSaved&jpSortKey=DateLastSaved';
    assert.equal(rewriteListUrl(u, seeds), H + '/Items?SortBy=DateLastContentAdded&jpSortKey=DateLastSaved');
    var other = H + '/Artists?SortBy=DateLastSaved';
    assert.equal(rewriteListUrl(other, seeds), other);
});

t('a stock sort is never touched', function () {
    [H + '/Items?SortBy=DateCreated,SortName&SortOrder=Descending', H + '/Items?SortBy=DateLastContentAdded', H + '/Items'].forEach(function (u) {
        assert.equal(rewriteListUrl(u, seeds), u, u);
    });
});

/* ---- favourites ---- */

var FAV = H + '/Items?SortBy=SeriesSortName%2CSortName&SortOrder=Ascending&Filters=IsFavorite&Recursive=true&Fields=PrimaryImageAspectRatio&CollapseBoxSetItems=false&ExcludeLocationTypes=Virtual&EnableTotalRecordCount=false&Limit=20&IncludeItemTypes=Video&userId=u';

t('the Favourites section request gets a bigger limit', function () {
    assert.equal(rewriteListUrl(FAV, seeds), FAV.replace('Limit=20', 'Limit=' + FAV_LIMIT));
    assert.equal(isFavouritesSection(parts(FAV)), true);
});

t('artists, people and studios sections too', function () {
    var a = H + '/Artists?SortBy=SeriesSortName,SortName&Filters=IsFavorite&CollapseBoxSetItems=false&ExcludeLocationTypes=Virtual&EnableTotalRecordCount=false&Limit=20&Recursive=true';
    assert.equal(rewriteListUrl(a, seeds), a.replace('Limit=20', 'Limit=' + FAV_LIMIT));
    var s = H + '/Studios?userId=u&isFavorite=true&enableTotalRecordCount=false&limit=20';
    assert.equal(rewriteListUrl(s, seeds), s.replace('limit=20', 'limit=' + FAV_LIMIT));
});

t('TV layouts keep the stock limit', function () {
    assert.equal(rewriteListUrl(FAV, { tv: true }), FAV);
});

t('lookalikes are not favourites sections', function () {
    [
        FAV.replace('Limit=20', 'Limit=30'),
        FAV.replace('Filters=IsFavorite', 'Filters=IsUnplayed'),
        FAV.replace('&EnableTotalRecordCount=false', ''),
        FAV.replace('&CollapseBoxSetItems=false', ''),
        FAV.replace('SeriesSortName%2CSortName', 'SortName'),
        FAV + '&StartIndex=20',
        H + '/Items?Filters=IsFavorite&Limit=20&EnableTotalRecordCount=false',
        H + '/Studios?userId=u&limit=20&enableTotalRecordCount=false'
    ].forEach(function (u) {
        assert.equal(rewriteListUrl(u, seeds), u, u);
    });
});

/* ---- everything else ---- */

t('urls with no query, other hosts, non-strings pass through unchanged', function () {
    assert.equal(rewriteListUrl(H + '/Items', seeds), H + '/Items');
    assert.equal(rewriteListUrl(H + '/Users/abc/Views?x=1', seeds), H + '/Users/abc/Views?x=1');
    assert.equal(rewriteListUrl(undefined, seeds), undefined);
    assert.equal(rewriteListUrl(null, seeds), null);
});

t('an undecodable parameter does not throw', function () {
    var u = H + '/Items?SortBy=Random&StartIndex=0&Limit=10&bad=%E0%A4%A';
    assert.equal(typeof rewriteListUrl(u, seeds), 'string');
});

console.log(passed + ' passed');
