// Run: node web/src/controller/quick-tags.test.mjs   (no framework; exits non-zero on failure)
// The group-source seam and the viewer's stored groups. Neutral names only.
import assert from 'node:assert/strict';

var mem = {};
globalThis.window = {
    localStorage: {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); },
        removeItem: function (k) { delete mem[k]; }
    }
};

var q = await import('./quick-tags.js');
var passed = 0;
async function t(name, fn) {
    try {
        await fn();
        passed++;
        console.log('ok   ' + name);
    } catch (e) {
        console.log('FAIL ' + name + '\n' + e.message);
        process.exitCode = 1;
    }
}

await t('no source registered (the default): no suggestions, groups are the viewer\'s own, ready at once', async function () {
    assert.deepEqual(q.suggestedNow('lib'), []);
    assert.deepEqual(await q.loadSuggested('lib'), []);
    var f = q.groupsFor('lib');
    assert.equal(f.ready, true);
    assert.deepEqual(f.groups, []);
});

await t('saveGroups / groupsNow round-trip through storage and notify listeners', async function () {
    var n = 0;
    q.onGroupsChanged(function () { n++; });
    assert.equal(q.saveGroups([{ name: 'Mine', tags: ['red'], prefix: '' }]), true);
    assert.deepEqual(q.groupsNow(), [{ name: 'Mine', tags: ['red'], prefix: '' }]);
    assert.ok(mem['jellyfinPlus.quickTags']);
    assert.equal(n, 1);
    q.saveGroups([]);
    assert.equal('jellyfinPlus.quickTags' in mem, false);
});

await t('a registered source is asked with the scope; not ready until it answers, then merged under the viewer\'s own', async function () {
    q.saveGroups([{ name: 'Mine', tags: ['red'], prefix: '' }]);
    var asked = [];
    var release;
    q.registerGroupSource(function (parentId) {
        asked.push(parentId);
        if (parentId !== 'libA') { return Promise.resolve([]); }
        return new Promise(function (res) {
            release = function () { res([{ name: 'Auto one', prefix: 'colour-', id: 'k:1', kind: 'prefix' }]); };
        });
    });
    assert.equal(q.suggestedNow('libA'), null);
    var before = q.groupsFor('libA');
    assert.equal(before.ready, false, 'callers must not prune picks yet');
    assert.deepEqual(before.groups.map(function (g) { return g.name; }), ['Mine']);
    await new Promise(function (r) { setTimeout(r, 0); }); // the source is called on a microtask
    release();
    var shown = await q.loadVisible('libA');
    assert.deepEqual(shown.map(function (g) { return g.name; }), ['Mine', 'Auto one']);
    assert.equal(shown[1].auto, true);
    assert.deepEqual(asked, ['libA'], 'one request for the scope, not one per call');
    assert.equal(q.groupsFor('libA').ready, true);
});

await t('hide and rename choices are applied; stored under their own key', async function () {
    q.saveAutoPrefs({ hidden: [], names: { 'k:1': 'Shade' } });
    assert.deepEqual(q.groupsFor('libA').groups.map(function (g) { return g.name; }), ['Mine', 'Shade']);
    q.saveAutoPrefs({ hidden: ['k:1'], names: {} });
    assert.deepEqual(q.groupsFor('libA').groups.map(function (g) { return g.name; }), ['Mine']);
    assert.equal(q.groupsFor('libA').all.length, 1, 'the editor still lists a hidden suggestion');
    q.saveAutoPrefs({ hidden: [], names: {} });
    assert.equal('jellyfinPlus.quickTagsAuto' in mem, false);
});

await t('a source that throws or rejects contributes nothing and breaks nothing', async function () {
    q.registerGroupSource(function () { throw new Error('boom'); });
    q.registerGroupSource(function () { return Promise.reject(new Error('nope')); });
    var shown = await q.loadVisible('libB');
    assert.deepEqual(shown.map(function (g) { return g.name; }), ['Mine']);
});

await t('a source returning garbage is ignored', async function () {
    q.registerGroupSource(function () { return 'not a list'; });
    var shown = await q.loadVisible('libC');
    assert.ok(Array.isArray(shown));
});

await t('suggestion cache is keyed by user: a switch refetches, not reuses', async function () {
    var seen = 0;
    var uid = 'userA';
    globalThis.window.ApiClient = { getCurrentUserId: function () { return uid; } };
    q.registerGroupSource(function (parentId) {
        if (parentId !== 'libU') { return Promise.resolve([]); }
        seen++;
        return Promise.resolve([{ name: 'U' + uid, tags: ['x'], id: 'u:1' }]);
    });
    var a = await q.loadSuggested('libU');
    assert.equal(a[0].name, 'UuserA');
    uid = 'userB';
    assert.equal(q.suggestedNow('libU'), null, 'user B has nothing cached yet');
    var b = await q.loadSuggested('libU');
    assert.equal(b[0].name, 'UuserB');
    assert.equal(seen, 2);
});

await t('namesFresh: fixed groups are always fresh, an unfetched prefix group is not; namesNow of a fixed group is []', async function () {
    assert.equal(q.namesFresh({ tags: ['a'], prefix: '' }), true);
    assert.equal(q.namesFresh({ tags: [], prefix: 'never-fetched' }), false);
    assert.equal(q.namesNow({ tags: [], prefix: 'never-fetched' }), null);
    assert.deepEqual(q.namesNow({ tags: ['a'], prefix: 'p' }), []);
    assert.deepEqual(await q.resolveNames({ tags: ['a'], prefix: 'p' }), [], 'a fixed group (with a prefix) never fetches');
});

console.log(passed +' passed' + (process.exitCode ? ', with failures' : ''));
