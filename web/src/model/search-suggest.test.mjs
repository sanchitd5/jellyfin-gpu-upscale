// Run: node web/src/model/search-suggest.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import { suggestVideoUrl } from './search-suggest.js';

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

var H = 'http://h/jf/Items?userId=u&';
var TAIL = '&limit=20&recursive=true&imageTypeLimit=0&enableImages=false&parentId=p&enableTotalRecordCount=false';
var REPEATED = H + 'sortBy=IsFavoriteOrLiked&sortBy=Random&includeItemTypes=Movie&includeItemTypes=Series&includeItemTypes=MusicArtist' + TAIL;
var COMMA = H + 'sortBy=IsFavoriteOrLiked%2CRandom&includeItemTypes=Movie%2CSeries%2CMusicArtist' + TAIL;
var COMMA_RAW = H + 'sortBy=IsFavoriteOrLiked,Random&includeItemTypes=Movie,Series,MusicArtist' + TAIL;

t('repeated-key form gets one more includeItemTypes pair', function () {
    var out = suggestVideoUrl(REPEATED);
    assert.equal(out, REPEATED + '&includeItemTypes=Video');
});

t('encoded comma form is extended in place with an encoded comma', function () {
    assert.equal(suggestVideoUrl(COMMA), COMMA.replace('MusicArtist', 'MusicArtist%2CVideo'));
});

t('raw comma form is extended with a raw comma', function () {
    assert.equal(suggestVideoUrl(COMMA_RAW), COMMA_RAW.replace('MusicArtist', 'MusicArtist,Video'));
});

t('a request that already has Video is left alone', function () {
    var u = REPEATED + '&includeItemTypes=Video';
    assert.equal(suggestVideoUrl(u), u);
    assert.equal(suggestVideoUrl(COMMA.replace('MusicArtist', 'MusicArtist%2CVideo')), COMMA.replace('MusicArtist', 'MusicArtist%2CVideo'));
});

t('a search request is never touched', function () {
    var u = REPEATED + '&searchTerm=cat';
    assert.equal(suggestVideoUrl(u), u);
});

t('other requests with the same sort or types are not suggestions', function () {
    var noRandom = H + 'sortBy=IsFavoriteOrLiked&includeItemTypes=Movie&includeItemTypes=Series&includeItemTypes=MusicArtist' + TAIL;
    var noFav = H + 'sortBy=Random&includeItemTypes=Movie&includeItemTypes=Series&includeItemTypes=MusicArtist' + TAIL;
    var fewTypes = H + 'sortBy=IsFavoriteOrLiked&sortBy=Random&includeItemTypes=Movie&includeItemTypes=Series' + TAIL;
    [noRandom, noFav, fewTypes].forEach(function (u) { assert.equal(suggestVideoUrl(u), u, u); });
});

t('only /Items is considered', function () {
    var u = REPEATED.replace('/Items?', '/Persons?');
    assert.equal(suggestVideoUrl(u), u);
    var v = REPEATED.replace('/Items?', '/Items/Filters?');
    assert.equal(suggestVideoUrl(v), v);
});

t('names are matched case-insensitively', function () {
    var u = H + 'SORTBY=IsFavoriteOrLiked&SortBy=random&IncludeItemTypes=movie&includeitemtypes=SERIES&includeItemTypes=musicartist' + TAIL;
    assert.equal(suggestVideoUrl(u), u + '&includeItemTypes=Video');
});

t('a fragment stays at the end', function () {
    assert.equal(suggestVideoUrl(REPEATED + '#x'), REPEATED + '&includeItemTypes=Video#x');
});

t('non-strings and malformed escapes come back unchanged', function () {
    assert.equal(suggestVideoUrl(undefined), undefined);
    assert.equal(suggestVideoUrl(null), null);
    var bad = H + 'sortBy=%E0%A4%A&x=1';
    assert.equal(suggestVideoUrl(bad), bad);
    assert.equal(suggestVideoUrl('http://h/jf/Items'), 'http://h/jf/Items');
});

console.log(passed + ' passed');
