// Run: node web/src/model/select-all.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import {
    normId, isListUrl, isIdsPageUrl, groupKey, idsPageUrl, noteResponse, pickGroup, offerLabel, countText,
    pageStarts, MAX_GROUPS, MAX_IDS
} from './select-all.js';

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
var LIST = H + '/Items?userId=u&parentId=p&includeItemTypes=Video&sortBy=SortName&sortOrder=Ascending&startIndex=0&limit=100&fields=PrimaryImageAspectRatio&enableImageTypes=Primary&imageTypeLimit=1&enableTotalRecordCount=true';

t('list urls: /Items with a real page; not id lookups, tag windows, one-item cuts or other routes', function () {
    assert.equal(isListUrl(LIST), true);
    assert.equal(isListUrl(H + '/Users/u/Items?limit=50'), true);
    assert.equal(isListUrl(H + '/Items?userId=u'), true);
    assert.equal(isListUrl(H + '/Items?userId=u&ids=a,b&limit=40'), false);
    assert.equal(isListUrl(H + '/Items?userId=u&limit=1&includeItemTypes=Video'), false);
    assert.equal(isListUrl(H + '/Items/Filters?userId=u'), false);
    assert.equal(isListUrl(H + '/Items/Filters?jpTagLimit=301'), false);
    assert.equal(isListUrl(H + '/Persons?limit=100'), false);
    assert.equal(isListUrl(undefined), false);
});

t('group key ignores paging and payload parameters, not filters', function () {
    var page2 = LIST.replace('startIndex=0', 'startIndex=100') + '&jpInf=1';
    assert.equal(groupKey(LIST), groupKey(page2));
    assert.equal(groupKey(LIST), groupKey(LIST.replace('limit=100', 'limit=50').replace('&fields=PrimaryImageAspectRatio', '')));
    assert.notEqual(groupKey(LIST), groupKey(LIST + '&tags=a'));
    assert.notEqual(groupKey(LIST), groupKey(LIST.replace('parentId=p', 'parentId=q')));
    assert.notEqual(groupKey(LIST), groupKey(LIST.replace('SortName', 'DateCreated')));
});

t('group key is parameter-order and case insensitive on names', function () {
    assert.equal(groupKey(H + '/Items?a=1&b=2&limit=5'), groupKey(H + '/Items?b=2&a=1&LIMIT=9'));
});

t('idsPageUrl: only the paging and payload change', function () {
    var u = idsPageUrl(LIST, 200, 200);
    assert.ok(u.startsWith(H + '/Items?'));
    assert.ok(u.includes('userId=u&parentId=p&includeItemTypes=Video&sortBy=SortName&sortOrder=Ascending'));
    assert.ok(u.includes('startIndex=200&limit=200'));
    assert.ok(u.includes('enableImages=false') && u.includes('enableUserData=false') && u.includes('jpInf=1'));
    assert.ok(u.includes('enableTotalRecordCount=false'));
    assert.ok(!/fields=/i.test(u));
    assert.ok(!u.includes('startIndex=0'));
    assert.equal(groupKey(u), groupKey(LIST));
    assert.equal(isIdsPageUrl(u), true);
    assert.equal(isIdsPageUrl(LIST), false);
    // idempotent: asking again from our own url gives the same thing for the same page
    assert.equal(idsPageUrl(u, 200, 200), u);
});

t('idsPageUrl keeps filter markers verbatim (names with commas, encoded values)', function () {
    var src = H + '/Items?excludeTagNames=a%2C%20b&tags=x%7Cy&searchTerm=red+car&jpPaged=true&startIndex=0&limit=100';
    var u = idsPageUrl(src, 0, 200);
    assert.ok(u.includes('excludeTagNames=a%2C%20b'));
    assert.ok(u.includes('tags=x%7Cy'));
    assert.ok(u.includes('searchTerm=red+car'));
    assert.ok(u.includes('jpPaged=true'));
});

t('idsPageUrl: unseeded Random becomes SortName, seeded Random is kept', function () {
    var unseeded = idsPageUrl(H + '/Items?sortBy=Random&limit=100', 0, 200);
    assert.ok(unseeded.includes('sortBy=SortName') && !/random/i.test(unseeded));
    var seeded = idsPageUrl(H + '/Items?sortBy=Random&jpSeed=42&limit=100', 0, 200);
    assert.ok(seeded.includes('sortBy=Random') && seeded.includes('jpSeed=42'));
    var multi = idsPageUrl(H + '/Items?sortBy=Random,SortName&limit=100', 0, 200);
    assert.ok(multi.includes('sortBy=SortName') && !/random/i.test(multi));
    var other = idsPageUrl(H + '/Items?sortBy=PlayCount&limit=100', 0, 200);
    assert.ok(other.includes('sortBy=PlayCount'));
});

t('normId', function () {
    assert.equal(normId('ABCDEF01-2345-6789-abcd-ef0123456789'), 'abcdef0123456789abcdef0123456789');
    assert.equal(normId(undefined), '');
});

t('noteResponse accumulates pages into one group and keeps the count', function () {
    var groups = new Map();
    var g = noteResponse(groups, LIST, [{ Id: 'AA' }, { Id: 'bb' }], 450, 1);
    noteResponse(groups, LIST.replace('startIndex=0', 'startIndex=100'), [{ Id: 'cc' }], 450, 2);
    assert.equal(groups.size, 1);
    assert.equal(g.ids.size, 3);
    assert.equal(g.total, 450);
    assert.equal(g.touched, 2);
    // a response with no count does not zero the total
    noteResponse(groups, LIST, [{ Id: 'dd' }], 0, 3);
    assert.equal(g.total, 450);
    assert.equal(g.ids.size, 4);
});

t('noteResponse drops the least recently touched group beyond the cap', function () {
    var groups = new Map();
    for (var i = 0; i < MAX_GROUPS + 3; i++) {
        noteResponse(groups, H + '/Items?parentId=p' + i + '&limit=10', [{ Id: 'id' + i }], 10, i);
    }
    assert.equal(groups.size, MAX_GROUPS);
    assert.ok(!groups.has(groupKey(H + '/Items?parentId=p0&limit=10')));
    assert.ok(groups.has(groupKey(H + '/Items?parentId=p' + (MAX_GROUPS + 2) + '&limit=10')));
    // touching an old one keeps it
    noteResponse(groups, H + '/Items?parentId=p5&limit=10', [], 10, 100);
    for (var j = 0; j < MAX_GROUPS - 1; j++) {
        noteResponse(groups, H + '/Items?parentId=n' + j + '&limit=10', [{ Id: 'n' + j }], 10, 200 + j);
    }
    assert.ok(groups.has(groupKey(H + '/Items?parentId=p5&limit=10')));
});

t('pickGroup: newest group holding every ticked id; none for no ids or a foreign id', function () {
    var groups = new Map();
    noteResponse(groups, H + '/Items?parentId=a&limit=10', [{ Id: 'x1' }, { Id: 'x2' }, { Id: 'x3' }], 30, 1);
    noteResponse(groups, H + '/Items?parentId=b&limit=10', [{ Id: 'x2' }, { Id: 'y1' }], 20, 2);
    assert.equal(pickGroup(groups, ['x2']).total, 20);
    assert.equal(pickGroup(groups, ['x1', 'X2']).total, 30);
    assert.equal(pickGroup(groups, ['x1', 'y1']), null);
    assert.equal(pickGroup(groups, []), null);
    assert.equal(pickGroup(groups, ['nope']), null);
});

t('offer label only when there is more than what is ticked', function () {
    assert.equal(offerLabel(null, 3), '');
    assert.equal(offerLabel({ total: 3 }, 3), '');
    assert.equal(offerLabel({ total: 1234 }, 3), 'Select all 1,234 results');
    assert.equal(countText(1234567), '1,234,567');
    assert.equal(countText(12), '12');
});

t('pageStarts covers the total, and refuses a selection over the cap', function () {
    assert.deepEqual(pageStarts(450, 200), [0, 200, 400]);
    assert.deepEqual(pageStarts(200, 200), [0]);
    assert.deepEqual(pageStarts(0, 200), []);
    assert.deepEqual(pageStarts(MAX_IDS + 1, 200), []);
    assert.equal(pageStarts(MAX_IDS, 200).length, MAX_IDS / 200);
});

console.log(passed + ' passed');
