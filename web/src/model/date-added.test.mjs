// Run: node web/src/model/date-added.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import { PRESETS, encode, decode, normalize, rangeOf, labelOf, paramPairs, validDay, utcDay } from './date-added.js';
import { buildTags, parseTags, rewriteLibraryUrl, mark } from './library-filter-marks.js';

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

var NOW = new Date(Date.UTC(2026, 9, 23, 23, 59, 0)); // 2026-10-23 23:59 UTC
var LIB = 'http://h/jf/Items?userId=u&ParentId=p&StartIndex=0&Limit=100&SortBy=SortName';

t('presets resolve to rolling UTC day bounds', function () {
    assert.deepEqual(rangeOf({ kind: 'preset', id: 'today' }, NOW), { from: '2026-10-23', to: '' });
    assert.deepEqual(rangeOf({ kind: 'preset', id: '7d' }, NOW), { from: '2026-10-16', to: '' });
    assert.deepEqual(rangeOf({ kind: 'preset', id: '30d' }, NOW), { from: '2026-09-23', to: '' });
    assert.deepEqual(rangeOf({ kind: 'preset', id: '90d' }, NOW), { from: '2026-07-25', to: '' });
    assert.deepEqual(rangeOf({ kind: 'preset', id: 'ytd' }, NOW), { from: '2026-01-01', to: '' });
});

t('a relative preset moves with the clock; a custom range does not', function () {
    var later = new Date(NOW.getTime() + 3 * 86400000);
    assert.equal(rangeOf('7d', later).from, '2026-10-19');
    assert.deepEqual(rangeOf('c:2026-10-01~2026-10-15', later), { from: '2026-10-01', to: '2026-10-15' });
});

t('day boundary is UTC, not local', function () {
    // 00:30 UTC on the 24th is still "the 23rd" in New York, but the contract is UTC
    assert.equal(utcDay(new Date(Date.UTC(2026, 9, 24, 0, 30))), '2026-10-24');
    assert.equal(rangeOf('today', new Date(Date.UTC(2026, 9, 24, 0, 30))).from, '2026-10-24');
});

t('encode / decode round-trip; garbage and "any" decode to null', function () {
    ['today', '7d', '30d', '90d', 'ytd', 'c:2026-10-01~2026-10-15', 'c:2026-10-01~', 'c:~2026-10-15'].forEach(function (s) {
        assert.equal(encode(decode(s)), s);
    });
    ['', 'any', 'nope', 'c:', 'c:x~y', 'c:2026-02-30~', 'c:2026-10-01', 'c:a~b~c', null, undefined, 5].forEach(function (s) {
        assert.equal(decode(s), null, String(s));
    });
});

t('a reversed custom range is swapped; an impossible day is dropped', function () {
    assert.equal(encode({ kind: 'custom', from: '2026-10-15', to: '2026-10-01' }), 'c:2026-10-01~2026-10-15');
    assert.equal(encode({ kind: 'custom', from: '2026-02-30', to: '2026-03-01' }), 'c:~2026-03-01');
    assert.equal(validDay('2024-02-29'), true);
    assert.equal(validDay('2026-02-29'), false);
});

t('labels', function () {
    assert.equal(labelOf('7d', NOW), 'Last 7 days');
    assert.equal(labelOf('ytd', NOW), 'This year');
    assert.equal(labelOf('c:2026-10-01~2026-10-15', NOW), '1 Oct – 15 Oct');
    assert.equal(labelOf('c:2026-10-05~2026-10-05', NOW), '5 Oct');
    assert.equal(labelOf('c:2026-10-01~', NOW), 'From 1 Oct');
    assert.equal(labelOf('c:~2026-10-15', NOW), 'Until 15 Oct');
    assert.equal(labelOf('c:2025-12-30~2026-01-02', NOW), '30 Dec 2025 – 2 Jan 2026');
    assert.equal(labelOf('c:2025-03-01~2025-03-09', NOW), '1 Mar 2025 – 9 Mar 2025');
    assert.equal(labelOf(null, NOW), 'Date');
    assert.equal(PRESETS[0].label, 'Any time');
});

t('marker round-trips through parseTags / buildTags next to other state', function () {
    var p = parseTags(['real', mark('x', 'ex'), mark('d', '7d')]);
    assert.equal(p.added, '7d');
    assert.deepEqual(p.tags, ['real']);
    var again = parseTags(buildTags(p));
    assert.equal(again.added, '7d');
    assert.deepEqual(again.exclude, ['ex']);
    // cleared: no marker left, nothing stored
    p.added = '';
    assert.deepEqual(buildTags(p), ['real', mark('x', 'ex')]);
    // unreadable payloads vanish rather than filter
    assert.equal(parseTags([mark('d', 'garbage')]).added, '');
    assert.deepEqual(buildTags({ tags: [], exclude: [], people: [], any: [], all: false, added: 'garbage' }), []);
});

function params(url) {
    var o = {};
    url.slice(url.indexOf('?') + 1).split('&').forEach(function (kv) {
        var i = kv.indexOf('=');
        o[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
    });
    return o;
}

t('library /Items request carries jpMinDateAdded for a preset; marker gone', function () {
    var url = LIB + '&tags=' + encodeURIComponent(['real', mark('d', '7d')].join('|'));
    var out = rewriteLibraryUrl(url, NOW);
    assert.ok(out.indexOf('\u0001') === -1 && out.indexOf('%01') === -1, out);
    var q = params(out);
    assert.equal(q.jpMinDateAdded, '2026-10-16');
    assert.equal(q.jpMaxDateAdded, undefined);
    assert.equal(q.tags, 'real');
});

t('library /Items request carries both bounds for a custom range', function () {
    var url = LIB + '&tags=' + encodeURIComponent(mark('d', 'c:2026-10-01~2026-10-15'));
    var q = params(rewriteLibraryUrl(url, NOW));
    assert.equal(q.jpMinDateAdded, '2026-10-01');
    assert.equal(q.jpMaxDateAdded, '2026-10-15');
    assert.equal(q.tags, undefined);
});

t('infinite scroll page 2 replays the marked request: both kinds still carry the params', function () {
    ['7d', 'c:2026-10-01~2026-10-15'].forEach(function (d) {
        var recorded = LIB + '&tags=' + encodeURIComponent(mark('d', d));
        var next = recorded.replace('StartIndex=0', 'StartIndex=100') + '&jpInf=1';
        var out = rewriteLibraryUrl(next, NOW);
        var q = params(out);
        assert.equal(q.StartIndex, '100');
        assert.equal(q.jpInf, '1');
        assert.ok(q.jpMinDateAdded, out);
        assert.equal(q.jpMaxDateAdded, d === '7d' ? undefined : '2026-10-15');
        assert.equal(rewriteLibraryUrl(out, NOW), out); // already rewritten: not doubled
    });
});

t('only a path ending in /Items turns the marker into parameters; elsewhere it is removed', function () {
    var out = rewriteLibraryUrl('http://h/jf/Items/Filters?userId=u&tags=' + encodeURIComponent(mark('d', '7d')), NOW);
    assert.ok(out.indexOf('jpMinDateAdded') === -1 && out.indexOf('%01') === -1 && out.indexOf('tags=') === -1, out);
});

t('a malformed date marker adds nothing', function () {
    var out = rewriteLibraryUrl(LIB + '&tags=' + encodeURIComponent(mark('d', 'c:nope~nope')), NOW);
    assert.ok(out.indexOf('jpMinDateAdded') === -1 && out.indexOf('jpMaxDateAdded') === -1, out);
});

t('rewrite without a clock uses the real clock', function () {
    var out = rewriteLibraryUrl(LIB + '&tags=' + encodeURIComponent(mark('d', 'today')));
    assert.equal(params(out).jpMinDateAdded, utcDay(new Date()));
    assert.deepEqual(paramPairs('c:2026-10-01~', NOW), [['jpMinDateAdded', '2026-10-01']]);
});

console.log(passed + ' passed');
