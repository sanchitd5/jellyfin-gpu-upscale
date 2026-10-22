// Run: node web/src/model/search-filters.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import {
    defaultState, normalizeState, rewriteSearchUrl, chipsOf, activeGroups, removeChip, filterPairs,
    facetPairs, facetKey, filterFacets, facetRows, facetText, offeredRoles, normalizeFacet
} from './search-filters.js';

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

var NOW = new Date('2026-10-22T15:30:00Z');
var G1 = '11111111-2222-3333-4444-555555555555';
var G2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
var ALL = 'http://h/Items?userId=u&recursive=true&includeItemTypes=Movie&includeItemTypes=Series&searchTerm=cat&limit=800&fields=X';
var VID = 'http://h/Items?userId=u&recursive=true&mediaTypes=Video&excludeItemTypes=Movie&excludeItemTypes=Episode&searchTerm=cat&limit=100';

function q(url) {
    var o = {};
    new URLSearchParams(url.split('?')[1]).forEach(function (v, k) { (o[k] = o[k] || []).push(v); });
    return o;
}
function st(patch) { return normalizeState(Object.assign(defaultState(), patch)); }

t('default state leaves every URL byte-identical', function () {
    assert.equal(rewriteSearchUrl(ALL, defaultState(), NOW), ALL);
    assert.equal(rewriteSearchUrl(VID, defaultState(), NOW), VID);
});

t('non-search and non-Items URLs are untouched even with filters on', function () {
    var s = st({ favorites: true });
    ['http://h/Items?userId=u', 'http://h/Items/Filters?searchTerm=a', 'http://h/Persons?searchTerm=a',
        'http://h/Search/Hints?searchTerm=a', 'http://h/Items', null, undefined, 5].forEach(function (u) {
        assert.equal(rewriteSearchUrl(u, s, NOW), u);
    });
});

t('sort: name ascending -> sortBy + sortOrder, relevance sends nothing', function () {
    var p = q(rewriteSearchUrl(ALL, st({ sort: 'SortName', order: 'Ascending' }), NOW));
    assert.deepEqual(p.sortBy, ['SortName']);
    assert.deepEqual(p.sortOrder, ['Ascending']);
    assert.equal(p.jpSeed, undefined);
});

t('sort: date added descending; existing sortBy is replaced, not doubled', function () {
    var u = rewriteSearchUrl(ALL + '&SortBy=Foo&sortorder=Ascending', st({ sort: 'DateCreated', order: 'Descending' }), NOW);
    var p = q(u);
    assert.deepEqual(p.sortBy, ['DateCreated']);
    assert.deepEqual(p.sortOrder, ['Descending']);
    assert.equal((u.match(/sortby=/gi) || []).length, 1);
});

t('sort: random sends jpSeed and no sortOrder', function () {
    var p = q(rewriteSearchUrl(ALL, st({ sort: 'Random', seed: 4242 }), NOW));
    assert.deepEqual(p.sortBy, ['Random']);
    assert.deepEqual(p.jpSeed, ['4242']);
    assert.equal(p.sortOrder, undefined);
});

t('every sort value passes through', function () {
    ['DateCreated', 'SortName', 'Runtime', 'PremiereDate', 'CommunityRating', 'PlayCount', 'DatePlayed'].forEach(function (v) {
        assert.deepEqual(q(rewriteSearchUrl(ALL, st({ sort: v }), NOW)).sortBy, [v]);
    });
});

t('played / unplayed / favourites', function () {
    assert.deepEqual(q(rewriteSearchUrl(ALL, st({ played: 'played' }), NOW)).isPlayed, ['true']);
    assert.deepEqual(q(rewriteSearchUrl(ALL, st({ played: 'unplayed' }), NOW)).isPlayed, ['false']);
    assert.deepEqual(q(rewriteSearchUrl(ALL, st({ favorites: true }), NOW)).isFavorite, ['true']);
    assert.equal(q(rewriteSearchUrl(ALL, st({ favorites: true }), NOW)).isPlayed, undefined);
});

t('tags are pipe-separated exact names; tagMatch=all only with 2+ tags and the switch', function () {
    var p = q(rewriteSearchUrl(ALL, st({ tags: ['Alpha One', 'b&c'], tagAll: true }), NOW));
    assert.deepEqual(p.tags, ['Alpha One|b&c']);
    assert.deepEqual(p.tagMatch, ['all']);
    p = q(rewriteSearchUrl(ALL, st({ tags: ['x', 'y'] }), NOW));
    assert.equal(p.tagMatch, undefined);
    p = q(rewriteSearchUrl(ALL, st({ tags: ['x'], tagAll: true }), NOW));
    assert.equal(p.tagMatch, undefined);
});

t('tag names containing the pipe separator are dropped (cannot be expressed on the wire)', function () {
    assert.deepEqual(normalizeState({ tags: ['a|b', 'ok'] }).tags, ['ok']);
});

t('people and studios are comma-separated guids; malformed ids are dropped', function () {
    var s = st({ people: [{ id: G1, name: 'P' }, { id: G2, name: 'Q' }, { id: 'x', name: 'bad' }], studios: [{ id: G2, name: 'S' }] });
    var p = q(rewriteSearchUrl(ALL, s, NOW));
    assert.deepEqual(p.personIds, [G1 + ',' + G2]);
    assert.deepEqual(p.studioIds, [G2]);
});

t('cast & crew: roles ride as personTypes next to personIds, canonical order, unknown names dropped', function () {
    var ppl = [{ id: G1, name: 'P' }, { id: G2, name: 'Q' }];
    var u = rewriteSearchUrl(ALL, st({ people: ppl, roles: ['Writer', 'Director', 'Bogus', 'GuestStar'] }), NOW);
    var p = q(u);
    assert.deepEqual(p.personIds, [G1 + ',' + G2]);
    assert.deepEqual(p.personTypes, ['Director,Writer,GuestStar']);
    assert.equal(p.jpPersonMatch, undefined);
    assert.equal(rewriteSearchUrl(u, st({ people: ppl, roles: ['Writer', 'Director', 'GuestStar'] }), NOW), u);
    assert.equal(q(rewriteSearchUrl(ALL, st({ people: ppl }), NOW)).personTypes, undefined);
});

t('cast & crew: roles without people send nothing (stock would ignore them anyway)', function () {
    assert.equal(rewriteSearchUrl(ALL, st({ roles: ['Actor'] }), NOW), ALL);
    assert.deepEqual(chipsOf(st({ roles: ['Actor'], peopleAll: true })), []);
});

t('cast & crew: All of -> jpPersonMatch=all, only with two or more people', function () {
    var two = [{ id: G1, name: 'P' }, { id: G2, name: 'Q' }];
    assert.deepEqual(q(rewriteSearchUrl(ALL, st({ people: two, peopleAll: true }), NOW)).jpPersonMatch, ['all']);
    assert.equal(q(rewriteSearchUrl(ALL, st({ people: two }), NOW)).jpPersonMatch, undefined);
    assert.equal(q(rewriteSearchUrl(ALL, st({ people: [two[0]], peopleAll: true }), NOW)).jpPersonMatch, undefined);
    // a stale value already in the URL is replaced, never doubled
    var u = rewriteSearchUrl(ALL + '&jpPersonMatch=all&personTypes=Actor', st({ people: two }), NOW);
    assert.equal(q(u).jpPersonMatch, undefined);
    assert.equal(q(u).personTypes, undefined);
});

t('cast & crew: chips read "Cast: Name (Role)", All of is its own chip, one badge group', function () {
    var s = st({ people: [{ id: G1, name: 'P' }, { id: G2, name: 'Q' }], roles: ['Director', 'GuestStar'], peopleAll: true });
    assert.deepEqual(chipsOf(s).map(function (c) { return c.label; }),
        ['Cast: P (Director / Guest star)', 'Cast: Q (Director / Guest star)', 'Match all people']);
    assert.deepEqual(activeGroups(s), ['people']);
    assert.equal(chipsOf(st({ people: [{ id: G1, name: 'P' }] }))[0].label, 'Cast: P');
});

t('cast & crew: removing the last person clears roles and All of; All of chip clears alone', function () {
    var s = st({ people: [{ id: G1, name: 'P' }, { id: G2, name: 'Q' }], roles: ['Actor'], peopleAll: true });
    var n = removeChip(s, 'person:' + G1);
    assert.deepEqual(n.roles, ['Actor']);
    n = removeChip(n, 'person:' + G2);
    assert.deepEqual([n.people, n.roles, n.peopleAll], [[], [], false]);
    n = removeChip(s, 'peopleAll');
    assert.equal(n.peopleAll, false);
    assert.equal(n.people.length, 2);
});

t('older stored state (no roles / peopleAll) loads with defaults', function () {
    var n = normalizeState({ people: [{ id: G1, name: 'P' }] });
    assert.deepEqual([n.roles, n.peopleAll], [[], false]);
});

t('runtime min/max in whole minutes, either side optional, swapped if reversed', function () {
    var p = q(rewriteSearchUrl(ALL, st({ minRuntime: 5, maxRuntime: 20 }), NOW));
    assert.deepEqual([p.jpMinRuntime, p.jpMaxRuntime], [['5'], ['20']]);
    p = q(rewriteSearchUrl(ALL, st({ minRuntime: 60 }), NOW));
    assert.deepEqual(p.jpMinRuntime, ['60']);
    assert.equal(p.jpMaxRuntime, undefined);
    p = q(rewriteSearchUrl(ALL, st({ maxRuntime: 5.9 }), NOW));
    assert.deepEqual(p.jpMaxRuntime, ['5']);
    p = q(rewriteSearchUrl(ALL, st({ minRuntime: 30, maxRuntime: 10 }), NOW));
    assert.deepEqual([p.jpMinRuntime, p.jpMaxRuntime], [['10'], ['30']]);
});

t('date added presets resolve to a UTC day relative to now', function () {
    assert.deepEqual(q(rewriteSearchUrl(ALL, st({ added: '24h' }), NOW)).jpMinDateAdded, ['2026-10-21']);
    assert.deepEqual(q(rewriteSearchUrl(ALL, st({ added: '7d' }), NOW)).jpMinDateAdded, ['2026-10-15']);
    assert.deepEqual(q(rewriteSearchUrl(ALL, st({ added: '30d' }), NOW)).jpMinDateAdded, ['2026-09-22']);
    assert.deepEqual(q(rewriteSearchUrl(ALL, st({ added: '1y' }), NOW)).jpMinDateAdded, ['2025-10-22']);
    assert.equal(q(rewriteSearchUrl(ALL, st({ added: '7d' }), NOW)).jpMaxDateAdded, undefined);
});

t('date added custom range, either side, bad dates dropped', function () {
    var p = q(rewriteSearchUrl(ALL, st({ added: 'custom', addedFrom: '2026-01-02', addedTo: '2026-02-03' }), NOW));
    assert.deepEqual([p.jpMinDateAdded, p.jpMaxDateAdded], [['2026-01-02'], ['2026-02-03']]);
    p = q(rewriteSearchUrl(ALL, st({ added: 'custom', addedTo: '2026-02-03' }), NOW));
    assert.equal(p.jpMinDateAdded, undefined);
    assert.deepEqual(p.jpMaxDateAdded, ['2026-02-03']);
    assert.equal(normalizeState({ added: 'custom', addedFrom: '02/03/2026' }).addedFrom, '');
    assert.equal(rewriteSearchUrl(ALL, st({ added: 'custom' }), NOW), ALL);
});

t('resolution: comma list in sd,hd,4k order; all three or none sends nothing', function () {
    assert.deepEqual(q(rewriteSearchUrl(ALL, st({ res: ['4k', 'sd'] }), NOW)).jpResolution, ['sd,4k']);
    assert.deepEqual(q(rewriteSearchUrl(ALL, st({ res: ['hd'] }), NOW)).jpResolution, ['hd']);
    assert.equal(rewriteSearchUrl(ALL, st({ res: ['sd', 'hd', '4k'] }), NOW), ALL);
    assert.equal(rewriteSearchUrl(ALL, st({ res: ['bogus'] }), NOW), ALL);
});

t('type=videos: Video query keeps filters; all-types query becomes a one-item Video request', function () {
    var s = st({ type: 'videos', favorites: true, sort: 'SortName' });
    var pv = q(rewriteSearchUrl(VID, s, NOW));
    assert.deepEqual(pv.isFavorite, ['true']);
    assert.deepEqual(pv.sortBy, ['SortName']);
    assert.deepEqual(pv.excludeItemTypes, ['Movie', 'Episode']);
    var pa = q(rewriteSearchUrl(ALL, s, NOW));
    assert.deepEqual(pa.includeItemTypes, ['Video']);
    assert.deepEqual(pa.limit, ['1']);
    assert.equal(pa.isFavorite, undefined);
    assert.equal(pa.sortBy, undefined);
    assert.deepEqual(pa.searchTerm, ['cat']);
});

t('type=movies / episodes: all-types query narrowed + filtered; Video query discarded', function () {
    ['movies', 'episodes'].forEach(function (ty) {
        var kind = ty === 'movies' ? 'Movie' : 'Episode';
        var s = st({ type: ty, played: 'unplayed' });
        var pa = q(rewriteSearchUrl(ALL, s, NOW));
        assert.deepEqual(pa.includeItemTypes, [kind]);
        assert.deepEqual(pa.isPlayed, ['false']);
        assert.deepEqual(pa.limit, ['800']);
        var pv = q(rewriteSearchUrl(VID, s, NOW));
        assert.deepEqual(pv.includeItemTypes, [kind]);
        assert.deepEqual(pv.limit, ['1']);
        assert.equal(pv.isPlayed, undefined);
    });
});

t('type=all leaves includeItemTypes and limit alone', function () {
    var p = q(rewriteSearchUrl(ALL, st({ favorites: true }), NOW));
    assert.deepEqual(p.includeItemTypes, ['Movie', 'Series']);
    assert.deepEqual(p.limit, ['800']);
});

t('searchTerm and unrelated params survive, and nothing is duplicated', function () {
    var s = st({ sort: 'Runtime', played: 'played', tags: ['t'], minRuntime: 1, res: ['hd'], favorites: true });
    var u = rewriteSearchUrl(ALL, s, NOW);
    var u2 = rewriteSearchUrl(u, s, NOW);
    assert.equal(u2, u, 'rewriting twice is a no-op');
    var p = q(u);
    Object.keys(p).forEach(function (k) {
        if (k !== 'includeItemTypes') { assert.equal(p[k].length, 1, k); }
    });
    assert.deepEqual(p.searchTerm, ['cat']);
    assert.deepEqual(p.fields, ['X']);
});

t('a hash fragment is kept at the end', function () {
    var u = rewriteSearchUrl(ALL + '#frag', st({ favorites: true }), NOW);
    assert.ok(u.endsWith('#frag'));
});

t('chips + badge groups', function () {
    var s = st({ sort: 'Runtime', tags: ['a', 'b'], tagAll: true, people: [{ id: G1, name: 'P' }], minRuntime: 5, maxRuntime: 20,
        added: '7d', res: ['hd'], played: 'played', favorites: true, type: 'movies' });
    var groups = activeGroups(s);
    assert.deepEqual(groups, ['sort', 'tags', 'people', 'runtime', 'added', 'res', 'played', 'favorites', 'type']);
    assert.equal(chipsOf(s).length, 11); // 2 tags + match-all + 8 others
    assert.equal(activeGroups(defaultState()).length, 0);
});

t('removeChip clears exactly one filter', function () {
    var s = st({ tags: ['a', 'b'], tagAll: true, favorites: true, sort: 'Runtime' });
    var n = removeChip(s, 'tag:a');
    assert.deepEqual(n.tags, ['b']);
    assert.equal(n.favorites, true);
    assert.equal(removeChip(s, 'sort').sort, 'relevance');
    assert.equal(removeChip(s, 'favorites').favorites, false);
    assert.equal(removeChip(s, 'tagAll').tagAll, false);
});

t('garbage state normalises to defaults', function () {
    assert.deepEqual(normalizeState('x'), defaultState());
    assert.deepEqual(normalizeState({ sort: 'Bogus', played: 5, res: 'hd', tags: 'x', type: '<script>' }), defaultState());
    assert.deepEqual(filterPairs(defaultState(), NOW), []);
});

/* ---- Cast & Crew facets ---- */

function obj(pairs) {
    var o = {};
    pairs.forEach(function (kv) { o[kv[0]] = kv[1]; });
    return o;
}

t('facetPairs: term only', function () {
    assert.deepEqual(facetPairs(defaultState(), 'cat', '', '', NOW), [['searchTerm', 'cat']]);
});

t('facetPairs: carries the filters but not the cast filter, sort or seed', function () {
    var s = st({
        sort: 'Random', seed: 5, played: 'unplayed', favorites: true, tags: ['a', 'b'], tagAll: true, studios: [{ id: G2, name: 'S' }],
        people: [{ id: G1, name: 'P' }], roles: ['Actor'], peopleAll: true, minRuntime: 5, res: ['hd'], type: 'movies'
    });
    var o = obj(facetPairs(s, 'cat', G2, 'red, blue ', NOW));
    assert.deepEqual(o, {
        searchTerm: 'cat', parentId: G2, includeItemTypes: 'Movie', isPlayed: 'false', isFavorite: 'true', tags: 'a|b',
        tagMatch: 'all', studioIds: G2, jpMinRuntime: '5', jpResolution: 'hd', excludeTags: 'red, blue'
    });
    ['sortBy', 'jpSeed', 'personIds', 'personTypes', 'jpPersonMatch'].forEach(function (k) {
        assert.equal(o[k], undefined, k);
    });
});

t('facetPairs: type mapping', function () {
    assert.equal(obj(facetPairs(st({ type: 'videos' }), 'x', '', '', NOW)).includeItemTypes, 'Video');
    assert.equal(obj(facetPairs(st({ type: 'episodes' }), 'x', '', '', NOW)).includeItemTypes, 'Episode');
    assert.equal(obj(facetPairs(st({ type: 'all' }), 'x', '', '', NOW)).includeItemTypes, undefined);
});

t('facetKey: changes with the term, a filter or q, and with nothing else', function () {
    var a = facetKey(facetPairs(defaultState(), 'cat', '', '', NOW), '');
    assert.equal(a, facetKey(facetPairs(defaultState(), 'cat', '', '', NOW), ''));
    assert.notEqual(a, facetKey(facetPairs(defaultState(), 'dog', '', '', NOW), ''));
    assert.notEqual(a, facetKey(facetPairs(st({ favorites: true }), 'cat', '', '', NOW), ''));
    assert.notEqual(a, facetKey(facetPairs(defaultState(), 'cat', '', '', NOW), 'al'));
    // Picking people or changing the sort does not change who appears.
    assert.equal(a, facetKey(facetPairs(st({ people: [{ id: G1, name: 'P' }], sort: 'Runtime' }), 'cat', '', '', NOW), ''));
});

var LIST = [
    { id: G1, name: 'Alice Ames', roles: ['Actor', 'Director'], count: 12 },
    { id: G2, name: 'Bob Bell', roles: ['Writer'], count: 3 }
];
var G3 = '33333333-3333-3333-3333-333333333333';

t('filterFacets: case-insensitive substring, empty keeps all', function () {
    assert.deepEqual(filterFacets(LIST, 'BELL').map(function (f) { return f.name; }), ['Bob Bell']);
    assert.equal(filterFacets(LIST, '  ').length, 2);
    assert.equal(filterFacets(LIST, 'zzz').length, 0);
});

t('facetRows: picked people missing from the list stay, first, with no count', function () {
    var rows = facetRows(LIST, [{ id: G3, name: 'Carol Cole' }, { id: G2, name: 'Bob Bell' }], '');
    assert.deepEqual(rows.map(function (r) { return [r.name, r.count, r.picked]; }), [
        ['Carol Cole', null, true], ['Alice Ames', 12, false], ['Bob Bell', 3, true]
    ]);
    // A needle narrows the picked extras too.
    assert.deepEqual(facetRows(LIST, [{ id: G3, name: 'Carol Cole' }], 'alice').map(function (r) { return r.name; }), ['Alice Ames']);
});

t('facetText', function () {
    assert.equal(facetText({ name: 'Alice', count: 12 }), 'Alice · 12');
    assert.equal(facetText({ name: 'Carol', count: null }), 'Carol');
});

t('offeredRoles: only roles that occur, plus selected ones, in ROLES order; all when unknown', function () {
    assert.deepEqual(offeredRoles(LIST, []), ['Actor', 'Director', 'Writer']);
    assert.deepEqual(offeredRoles(LIST, ['Composer']), ['Actor', 'Director', 'Writer', 'Composer']);
    assert.equal(offeredRoles(null, []).length, 10);
    assert.deepEqual(offeredRoles([], []), []);
});

t('normalizeFacet: both casings, junk dropped', function () {
    assert.deepEqual(normalizeFacet({ id: G1, name: 'A', roles: ['Actor'], count: 2 }), { id: G1, name: 'A', roles: ['Actor'], count: 2 });
    assert.deepEqual(normalizeFacet({ Id: G1, Name: 'A', Roles: ['Actor', 5], Count: 2 }), { id: G1, name: 'A', roles: ['Actor'], count: 2 });
    assert.equal(normalizeFacet({ id: 'nope', name: 'A' }), null);
    assert.equal(normalizeFacet({ id: G1, name: '' }), null);
    assert.equal(normalizeFacet(null), null);
    assert.equal(normalizeFacet({ id: G1, name: 'A' }).count, 0);
});

console.log(passed + ' passed');
