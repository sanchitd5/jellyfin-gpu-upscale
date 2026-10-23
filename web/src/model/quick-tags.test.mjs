// Run: node web/src/model/quick-tags.test.mjs   (no framework; exits non-zero on failure)
// Neutral names only (red, blue, colour-...): no library content belongs in this repo.
import assert from 'node:assert/strict';
import {
    parseGroups, startsWithPrefix, labelFor, chipsFor, toggleSelection, isSelected, selectedIn,
    pruneSelection, anyOfValues, usableTag, SEP, MAX_GROUPS, MAX_NAMES, MAX_EDIT_TAGS, STORE_KEY,
    encodeGroups, decodeGroups, validateDraft, moveGroup, AUTO_KEY, parseSuggested, decodeAuto, encodeAuto,
    mergeGroups, pinSuggestion
} from './quick-tags.js';
import { SYNCED, MAX_KEY_LENGTH, encode, decode } from './prefs-sync.js';
import { buildTags, parseTags, rewriteLibraryUrl, mark } from './library-filter-marks.js';
import {
    defaultState, normalizeState, chipsOf, activeGroups, removeChip, filterPairs, rewriteSearchUrl, facetPairs
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

/* ---- groups from the server ---- */

t('parseGroups accepts camel and Pascal case, drops groups with neither tags nor prefix', function () {
    var g = parseGroups([
        { name: 'Colour', tags: ['red', 'blue'], prefix: '' },
        { Name: 'Size', Tags: [], Prefix: 'size-' },
        { name: 'Empty', tags: [], prefix: '' },
        { name: '', tags: ['x'] },
        null, 'junk'
    ]);
    assert.deepEqual(g, [
        { name: 'Colour', tags: ['red', 'blue'], prefix: '' },
        { name: 'Size', tags: [], prefix: 'size-' }
    ]);
});

t('a fixed list wins over a prefix; duplicate group names and unusable tags are dropped', function () {
    var g = parseGroups([
        { name: 'A', tags: ['red', 'a|b', 'red', ' blue '], prefix: 'zzz' },
        { name: 'A', tags: ['other'] }
    ]);
    assert.deepEqual(g, [{ name: 'A', tags: ['red', 'blue'], prefix: '' }]);
});

t('parseGroups caps groups and names, and ignores non-arrays', function () {
    var many = [];
    for (var i = 0; i < 30; i++) { many.push({ name: 'g' + i, tags: ['t'] }); }
    assert.equal(parseGroups(many).length, MAX_GROUPS);
    var names = [];
    for (var j = 0; j < 300; j++) { names.push('n' + j); }
    assert.equal(parseGroups([{ name: 'x', tags: names }])[0].tags.length, MAX_NAMES);
    assert.deepEqual(parseGroups(undefined), []);
    assert.deepEqual(parseGroups({}), []);
});

/* ---- prefix chips ---- */

t('startsWithPrefix is case- and accent-insensitive and never matches an empty prefix', function () {
    assert.equal(startsWithPrefix('Colour-Red', 'colour'), true);
    assert.equal(startsWithPrefix('café-x', 'CAFE'), true);
    assert.equal(startsWithPrefix('xcolour', 'colour'), false);
    assert.equal(startsWithPrefix('anything', ''), false);
});

t('labelFor shows the remainder, minus gluing separators; the whole tag when nothing is left', function () {
    assert.equal(labelFor('colourred', 'colour'), 'red');
    assert.equal(labelFor('colour-red', 'colour'), 'red');
    assert.equal(labelFor('colour_dark blue', 'colour'), 'dark blue');
    assert.equal(labelFor('colour', 'colour'), 'colour');
    assert.equal(labelFor('other', 'colour'), 'other');
});

t('chipsFor (prefix) keeps only names that START with the prefix, labelled and sorted', function () {
    var g = { name: 'Colour', tags: [], prefix: 'colour-' };
    var chips = chipsFor(g, ['colour-red', 'mycolour-x', 'colour-blue', 'colour-10', 'colour-9', 'colour-a|b'], []);
    assert.deepEqual(chips.map(function (c) { return c.tag; }), ['colour-9', 'colour-10', 'colour-blue', 'colour-red']);
    assert.deepEqual(chips.map(function (c) { return c.label; }), ['9', '10', 'blue', 'red']);
});

t('chipsFor (fixed) lists the configured order; a saved pick that fell out of the list is appended', function () {
    var g = { name: 'Colour', tags: ['red', 'blue'], prefix: '' };
    assert.deepEqual(chipsFor(g, ['ignored'], []).map(function (c) { return c.tag; }), ['red', 'blue']);
    assert.deepEqual(chipsFor(g, null, ['green']).map(function (c) { return c.tag; }), ['red', 'blue', 'green']);
    var p = { name: 'P', tags: [], prefix: 'p-' };
    var withPick = chipsFor(p, ['p-a'], ['p-gone']);
    assert.deepEqual(withPick.map(function (c) { return c.label; }), ['a', 'gone']);
});

/* ---- selections and the wire value ---- */

t('anyOfValues: one value per group with a pick, OR inside (pipe), groups in first-seen order', function () {
    var sel = [
        { group: 'A', tag: 'red' }, { group: 'B', tag: 'big' }, { group: 'A', tag: 'blue' }, { group: 'A', tag: 'red' }
    ];
    assert.deepEqual(anyOfValues(sel), ['red|blue', 'big']);
    assert.deepEqual(anyOfValues([]), []);
});

t('anyOfValues never emits a tag the wire cannot carry, and caps groups and names', function () {
    assert.deepEqual(anyOfValues([{ group: 'A', tag: 'a|b' }, { group: 'A', tag: '' }]), []);
    var sel = [];
    for (var i = 0; i < 25; i++) { sel.push({ group: 'g' + i, tag: 't' }); }
    assert.equal(anyOfValues(sel).length, MAX_GROUPS);
    var one = [];
    for (var j = 0; j < 150; j++) { one.push({ group: 'g', tag: 'n' + j }); }
    assert.equal(anyOfValues(one)[0].split('|').length, MAX_NAMES);
    assert.equal(usableTag('x'.repeat(201)), false);
});

t('toggleSelection / isSelected / selectedIn / pruneSelection', function () {
    var s = toggleSelection([], 'A', 'red', true);
    s = toggleSelection(s, 'B', 'big', true);
    assert.equal(isSelected(s, 'A', 'red'), true);
    assert.deepEqual(selectedIn(s, 'B'), ['big']);
    assert.equal(toggleSelection(s, 'A', 'red', false).length, 1);
    assert.deepEqual(pruneSelection(s, [{ name: 'B' }]), [{ group: 'B', tag: 'big' }]);
    assert.deepEqual(pruneSelection(s, []), []);
});

/* ---- library: the marker rides in Filters.Tags and becomes jpTagAnyOf ---- */

var LIB = 'http://h/jf/Items?userId=u&StartIndex=0&Limit=100&IncludeItemTypes=Video&Recursive=true';

t('library markers round-trip through parseTags / buildTags', function () {
    var p = parseTags(['real'].concat([mark('a', 'Colour' + SEP + 'red'), mark('x', 'ex')]));
    assert.deepEqual(p.tags, ['real']);
    assert.deepEqual(p.any, [{ group: 'Colour', tag: 'red' }]);
    assert.deepEqual(p.exclude, ['ex']);
    assert.equal(buildTags(p).length, 3);
    assert.deepEqual(parseTags(buildTags(p)).any, p.any);
});

t('library /Items request gets one jpTagAnyOf per group; stock tags are kept; markers are gone', function () {
    var tags = ['real', mark('a', 'Colour' + SEP + 'red'), mark('a', 'Size' + SEP + 'big'), mark('a', 'Colour' + SEP + 'blue')];
    var url = LIB + '&tags=' + encodeURIComponent(tags.join('|'));
    var out = rewriteLibraryUrl(url);
    assert.ok(out.indexOf('\u0001') === -1 && out.indexOf('%01') === -1, out);
    assert.ok(/[?&]tags=real(&|$)/.test(out), out);
    assert.deepEqual(out.split('&').filter(function (x) { return x.indexOf('jpTagAnyOf=') === 0; }), [
        'jpTagAnyOf=' + encodeURIComponent('red|blue'),
        'jpTagAnyOf=' + encodeURIComponent('big')
    ]);
});

t('infinite scroll replays the page request with only StartIndex changed: the param rides along', function () {
    var tags = [mark('a', 'Colour' + SEP + 'red')];
    var recorded = LIB + '&tags=' + encodeURIComponent(tags.join('|'));
    var next = recorded.replace('StartIndex=0', 'StartIndex=100') + '&jpInf=1';
    var out = rewriteLibraryUrl(next);
    assert.ok(out.indexOf('StartIndex=100') !== -1 && out.indexOf('jpInf=1') !== -1);
    assert.ok(out.indexOf('jpTagAnyOf=red') !== -1, out);
    // the already-rewritten form (hooks applied once) is left alone, not doubled
    assert.equal(rewriteLibraryUrl(out), out);
});

t('only a path ending in /Items turns the marker into the parameter; elsewhere it is just removed', function () {
    var tags = [mark('a', 'Colour' + SEP + 'red')];
    var out = rewriteLibraryUrl('http://h/jf/Items/Filters?userId=u&tags=' + encodeURIComponent(tags.join('|')));
    assert.ok(out.indexOf('jpTagAnyOf') === -1 && out.indexOf('%01') === -1 && out.indexOf('tags=') === -1, out);
});

t('a malformed marker (no group or no tag) adds nothing', function () {
    assert.deepEqual(parseTags([mark('a', 'nogroup')]).any, []);
    assert.deepEqual(parseTags([mark('a', SEP + 'x')]).any, []);
    assert.deepEqual(parseTags([mark('a', 'g' + SEP)]).any, []);
});

/* ---- search: committed state, chips, badge, the request ---- */

var SEARCH = 'http://h/jf/Items?userId=u&searchTerm=abc&limit=24&startIndex=0';
var quickState = function () {
    var s = defaultState();
    s.quick = [
        { group: 'Colour', tag: 'colour-red', label: 'red' },
        { group: 'Colour', tag: 'colour-blue', label: 'blue' },
        { group: 'Size', tag: 'big', label: 'big' }
    ];
    return s;
};

t('search request carries one jpTagAnyOf per group; stock tags and the quick picks coexist', function () {
    var s = quickState();
    s.tags = ['plain'];
    var out = rewriteSearchUrl(SEARCH, s);
    assert.ok(out.indexOf('tags=plain') !== -1, out);
    assert.ok(out.indexOf('jpTagAnyOf=' + encodeURIComponent('colour-red|colour-blue')) !== -1, out);
    assert.ok(out.indexOf('jpTagAnyOf=big') !== -1, out);
    // re-marking an already marked url does not double the parameter
    assert.equal(rewriteSearchUrl(out, s), out);
});

t('search chips and badge: each picked tag is a removable chip, each group counts once', function () {
    var s = quickState();
    assert.equal(chipsOf(s).length, 3);
    assert.equal(activeGroups(s).length, 2);
    assert.ok(chipsOf(s)[0].label.indexOf('Colour') === 0);
    var after = removeChip(s, chipsOf(s)[0].id);
    assert.deepEqual(after.quick.map(function (q) { return q.tag; }), ['colour-blue', 'big']);
    assert.equal(removeChip(after, chipsOf(after)[0].id).quick.length, 1);
});

t('normalizeState drops malformed quick picks and keeps labels', function () {
    var s = normalizeState({ quick: [
        { group: 'A', tag: 'x', label: 'X' }, { group: 'A', tag: 'x' }, { group: '', tag: 'y' },
        { group: 'A', tag: 'a|b' }, { tag: 'z' }, null
    ] });
    assert.deepEqual(s.quick, [{ group: 'A', tag: 'x', label: 'X' }]);
    assert.deepEqual(normalizeState({}).quick, []);
});

t('no quick picks: a search request without other filters is untouched, and nothing is added', function () {
    assert.equal(rewriteSearchUrl(SEARCH, defaultState()), SEARCH);
    assert.deepEqual(filterPairs(defaultState()).filter(function (p) { return p[0] === 'jpTagAnyOf'; }), []);
});

t('the cast facet request respects the quick picks (it is computed over the filtered set)', function () {
    var pairs = facetPairs(quickState(), 'abc', '', '');
    assert.equal(pairs.filter(function (p) { return p[0] === 'jpTagAnyOf'; }).length, 2);
});

/* ---- the viewer's own groups: stored form, validation, ordering, sync ---- */

t('encodeGroups / decodeGroups round-trip, compact, tags or prefix', function () {
    var g = [{ name: 'Colour', tags: ['red', 'blue'], prefix: '' }, { name: 'Size', tags: [], prefix: 'size-' }];
    var raw = encodeGroups(g);
    assert.equal(raw, '[{"n":"Colour","t":["red","blue"]},{"n":"Size","p":"size-"}]');
    assert.deepEqual(decodeGroups(raw), g);
    assert.deepEqual(decodeGroups(null), []);
    assert.deepEqual(decodeGroups('not json'), []);
    assert.deepEqual(decodeGroups('{"n":"x"}'), []);
    assert.deepEqual(decodeGroups('[null, 5, {"n":"A"}]'), []);
});

t('validateDraft: names, duplicates, empty sources, count and size', function () {
    assert.equal(validateDraft([]), null);
    assert.equal(validateDraft([{ name: 'A', tags: ['x'], prefix: '' }]), null);
    assert.match(validateDraft([{ name: ' ', tags: ['x'], prefix: '' }]), /name/);
    assert.match(validateDraft([{ name: 'A', tags: ['x'] }, { name: 'A', prefix: 'p' }]), /Two groups/);
    assert.match(validateDraft([{ name: 'A', tags: [], prefix: '' }]), /needs tags or a prefix/);
    var many = [];
    for (var i = 0; i < MAX_GROUPS + 1; i++) { many.push({ name: 'g' + i, tags: ['t'] }); }
    assert.match(validateDraft(many), /At most/);
    var big = [];
    for (var j = 0; j < MAX_GROUPS; j++) {
        var tags = [];
        for (var k = 0; k < 30; k++) { tags.push('x'.repeat(190) + k + 'g' + j); }
        big.push({ name: 'g' + j, tags: tags });
    }
    assert.match(validateDraft(big), /more than can be saved/);
});

t('the worst editable value stays under the server sync limit; the key fits CustomPrefs', function () {
    var groups = [];
    for (var j = 0; j < MAX_GROUPS; j++) {
        var tags = [];
        for (var k = 0; k < MAX_EDIT_TAGS; k++) { tags.push('x'.repeat(30) + k + 'g' + j); }
        groups.push({ name: 'n'.repeat(38) + j, tags: tags });
    }
    assert.equal(validateDraft(groups), null);
    var def = SYNCED.filter(function (d) { return d.local === STORE_KEY; })[0];
    assert.ok(def, 'quick tags are in the synced set');
    assert.ok(def.remote.length <= MAX_KEY_LENGTH);
    var env = encode(encodeGroups(groups), Date.now());
    assert.ok(env.length < 20000, String(env.length));
    // and it survives the sync envelope round trip
    assert.equal(decode(def, env).v, encodeGroups(groups));
});

t('moveGroup swaps neighbours and does nothing at the ends', function () {
    assert.deepEqual(moveGroup(['a', 'b', 'c'], 1, -1), ['b', 'a', 'c']);
    assert.deepEqual(moveGroup(['a', 'b', 'c'], 1, 1), ['a', 'c', 'b']);
    assert.deepEqual(moveGroup(['a', 'b'], 0, -1), ['a', 'b']);
    assert.deepEqual(moveGroup(['a', 'b'], 1, 1), ['a', 'b']);
});

/* ---- suggested ("auto") groups: pin, hide, rename ---- */

var SUG = [
    { name: 'Colour', prefix: 'colour-', id: 'p:colour', kind: 'prefix' },
    { name: 'Size', tags: ['big', 'small'], id: 'f:size' },
    { name: 'Bad', tags: [], prefix: '' },
    { name: 'Colour', prefix: 'dup-', id: 'p:colour' }
];

t('parseSuggested keeps the group shape, adds id / kind / auto, drops malformed and duplicate ids', function () {
    var s = parseSuggested(SUG);
    assert.deepEqual(s.map(function (g) { return g.id; }), ['p:colour', 'f:size']);
    assert.equal(s[0].auto, true);
    assert.equal(s[0].kind, 'prefix');
    assert.equal(s[1].kind, '');
    assert.equal(parseSuggested([{ name: 'X', prefix: 'x' }])[0].id, 'auto:X');
    assert.deepEqual(parseSuggested(null), []);
});

t('auto prefs: decode is forgiving, encode is null when empty, both are capped', function () {
    assert.deepEqual(decodeAuto('garbage'), { hidden: [], names: {} });
    var p = decodeAuto('{"h":["a","a",5,""],"r":{"b":" New ","c":"","d":7}}');
    assert.deepEqual(p, { hidden: ['a'], names: { b: 'New' } });
    assert.equal(encodeAuto({ hidden: [], names: {} }), null);
    assert.deepEqual(decodeAuto(encodeAuto(p)), p);
    var many = { hidden: [], names: {} };
    for (var i = 0; i < 80; i++) { many.hidden.push('h' + i); many.names['n' + i] = 'x'.repeat(100); }
    var round = decodeAuto(encodeAuto(many));
    assert.equal(round.hidden.length, 50);
    assert.equal(Object.keys(round.names).length, 50);
});

t('the worst auto prefs stay under the sync limit', function () {
    var worst = { hidden: [], names: {} };
    for (var i = 0; i < 50; i++) {
        worst.hidden.push('h'.repeat(79) + (i % 10));
        worst.names['n'.repeat(78) + (i < 10 ? '0' : '') + i] = 'x'.repeat(100);
    }
    var def = SYNCED.filter(function (d) { return d.local === AUTO_KEY; })[0];
    assert.ok(def && def.remote.length <= MAX_KEY_LENGTH);
    assert.ok(encode(encodeAuto(worst), Date.now()).length < 20000);
});

t('mergeGroups: own groups first, renamed and hidden applied, clashing names dropped', function () {
    var user = [{ name: 'Mine', tags: ['x'], prefix: '' }];
    var s = parseSuggested(SUG);
    var m = mergeGroups(user, s, { hidden: [], names: {} });
    assert.deepEqual(m.visible.map(function (g) { return g.name; }), ['Mine', 'Colour', 'Size']);
    var h = mergeGroups(user, s, { hidden: ['f:size'], names: { 'p:colour': 'Shade' } });
    assert.deepEqual(h.visible.map(function (g) { return g.name; }), ['Mine', 'Shade']);
    assert.deepEqual(h.all.map(function (g) { return g.hidden; }), [false, true]);
    assert.equal(h.all[0].original, 'Colour');
    var clash = mergeGroups([{ name: 'Colour', tags: ['y'], prefix: '' }], s, { hidden: [], names: {} });
    assert.deepEqual(clash.all.map(function (g) { return g.id; }), ['f:size']);
});

t('pinSuggestion copies a suggestion in as an own group, uniquely named, and respects the cap', function () {
    var s = parseSuggested(SUG);
    var one = pinSuggestion([], s[0]);
    assert.deepEqual(one, [{ name: 'Colour', tags: [], prefix: 'colour-' }]);
    var two = pinSuggestion(one, s[0]);
    assert.equal(two[1].name, 'Colour (2)');
    assert.deepEqual(pinSuggestion([], s[1])[0], { name: 'Size', tags: ['big', 'small'], prefix: '' });
    var full = [];
    for (var i = 0; i < MAX_GROUPS; i++) { full.push({ name: 'g' + i, tags: ['t'], prefix: '' }); }
    assert.equal(pinSuggestion(full, s[0]).length, MAX_GROUPS);
    assert.equal(s[0].tags.length, 0, 'the suggestion itself is not changed');
});

console.log(passed + ' passed' + (process.exitCode ? ', with failures' : ''));
