// Run: node web/src/model/search-census.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import { verdict, nullRequest, parts } from './search-census.js';

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
var ALL = H + '/Items?userId=u&recursive=true&includeItemTypes=Movie&includeItemTypes=Series&includeItemTypes=Episode&includeItemTypes=Playlist&includeItemTypes=BoxSet&searchTerm=cat&limit=800';
var VID = H + '/Items?userId=u&recursive=true&mediaTypes=Video&excludeItemTypes=Movie&excludeItemTypes=Episode&excludeItemTypes=TvChannel&searchTerm=cat&limit=100';
var PROG = H + '/Items?userId=u&includeItemTypes=LiveTvProgram&searchTerm=cat&limit=100';
var CHAN = H + '/Items?userId=u&includeItemTypes=TvChannel&searchTerm=cat';

t('no census means nothing is skipped', function () {
    assert.equal(verdict(ALL, null), null);
    assert.equal(verdict(H + '/Artists?searchTerm=a', undefined), null);
});

t('an empty library skips every search request', function () {
    var none = {};
    [ALL, VID, PROG, CHAN, H + '/Artists?searchTerm=a&userId=u', H + '/Persons?searchTerm=a', H + '/Studios?searchTerm=a&parentId=x']
        .forEach(function (u) { assert.equal(verdict(u, none), 'skip', u); });
});

t('artists run when there is any music or artist', function () {
    var u = H + '/Artists?searchTerm=a';
    assert.equal(verdict(u, { Video: 5 }), 'skip');
    ['MusicArtist', 'Audio', 'MusicAlbum'].forEach(function (k) {
        var c = {};
        c[k] = 1;
        assert.equal(verdict(u, c), null, k);
    });
});

t('people and studios run only when they exist', function () {
    assert.equal(verdict(H + '/Persons?x=1', { Video: 9 }), 'skip');
    assert.equal(verdict(H + '/Persons?x=1', { Person: 3 }), null);
    assert.equal(verdict(H + '/Studios?x=1', { Person: 3 }), 'skip');
    assert.equal(verdict(H + '/Studios?x=1', { Studio: 1 }), null);
});

t('the all-types query runs when any one of its types exists, repeated or comma-listed', function () {
    assert.equal(verdict(ALL, { Video: 100 }), 'skip');
    assert.equal(verdict(ALL, { Playlist: 1 }), null);
    assert.equal(verdict(ALL, { Movie: 1 }), null);
    var comma = H + '/Items?includeItemTypes=Movie,Series&searchTerm=a';
    assert.equal(verdict(comma, { Series: 2 }), null);
    assert.equal(verdict(comma, { Episode: 2 }), 'skip');
});

t('a type the census does not cover is never assumed absent', function () {
    assert.equal(verdict(H + '/Items?includeItemTypes=Movie,Recording&searchTerm=a', {}), null);
    assert.equal(verdict(H + '/Items?includeItemTypes=SomethingNew&searchTerm=a', {}), null);
});

t('the videos query runs when any video-bearing kind exists', function () {
    assert.equal(verdict(VID, { Movie: 10, Person: 4 }), 'skip');
    assert.equal(verdict(VID, { Video: 1 }), null);
    assert.equal(verdict(VID, { MusicVideo: 1 }), null);
    assert.equal(verdict(VID, { Trailer: 1 }), null);
});

t('live tv queries need programs or channels', function () {
    assert.equal(verdict(PROG, { Video: 1 }), 'skip');
    assert.equal(verdict(PROG, { LiveTvProgram: 1 }), null);
    assert.equal(verdict(CHAN, { LiveTvProgram: 1 }), 'skip');
    assert.equal(verdict(CHAN, { TvChannel: 1 }), null);
});

t('only search requests are considered', function () {
    // No searchTerm: a listing, never skipped.
    assert.equal(verdict(H + '/Items?includeItemTypes=Movie&limit=10', {}), null);
    assert.equal(verdict(H + '/Items?includeItemTypes=Movie&searchTerm=', {}), null);
    assert.equal(verdict(H + '/Users/u/Items/latest?includeItemTypes=Movie&searchTerm=a', {}), null);
    assert.equal(verdict(H + '/Items/Filters?searchTerm=a', {}), null);
    assert.equal(verdict(H + '/Artists/Instant?searchTerm=a', {}), null);
    // Items with no type constraint at all: could be anything.
    assert.equal(verdict(H + '/Items?searchTerm=a', {}), null);
});

t('zero counts count as absent, positive as present', function () {
    assert.equal(verdict(H + '/Persons?a=1', { Person: 0 }), 'skip');
    assert.equal(verdict(H + '/Persons?a=1', { Person: 1 }), null);
});

t('case of the path and parameter names does not matter', function () {
    assert.equal(verdict(H + '/persons?a=1', {}), 'skip');
    assert.equal(verdict(H + '/items?INCLUDEITEMTYPES=movie&SEARCHTERM=a', {}), 'skip');
});

t('the replacement is an /Items lookup of a nonexistent id for the same user and server', function () {
    var n = nullRequest(H + '/Artists?searchTerm=a&userId=abc&limit=100');
    var p = parts(n);
    assert.equal(p.rawPath, H + '/Items');
    assert.deepEqual(p.q.ids, ['00000000-0000-0000-0000-000000000000']);
    assert.deepEqual(p.q.userid, ['abc']);
    assert.equal(p.q.searchterm, undefined);
    // Relative urls, and no user.
    assert.equal(nullRequest('/Studios?searchTerm=a').indexOf('/Items?ids='), 0);
    assert.equal(parts(nullRequest('/Studios?searchTerm=a')).q.userid, undefined);
});

console.log(passed + ' passed');
