// Run: node web/src/controller/smart-tags.test.mjs   (no framework; exits non-zero on failure)
// Cache keyed by user + scope, and stale-while-revalidate past the TTL. Neutral names only.
import assert from 'node:assert/strict';

var user = 'userA';
var calls = 0;
var answer = [{ id: 'exclusive:1', label: 'Group A', kind: 'exclusive', tags: [{ name: 'red' }] }];
var gate = null;
globalThis.window = {
    ApiClient: {
        getCurrentUserId: function () { return user; },
        getUrl: function (p) { return p; },
        ajax: function () {
            calls++;
            var body = answer;
            return gate ? gate.then(function () { return body; }) : Promise.resolve(body);
        }
    }
};

var s = await import('./smart-tags.js');
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

await t('a user switch does not reuse the previous user\'s categories', async function () {
    var a = await s.getCategories('');
    assert.equal(a[0].tags[0].name, 'red');
    assert.equal(calls, 1);
    await s.getCategories('');
    assert.equal(calls, 1, 'same user: cached');
    user = 'userB';
    answer = [{ id: 'exclusive:2', label: 'Group B', kind: 'exclusive', tags: [{ name: 'blue' }] }];
    assert.equal(s.categoriesNow(''), null, 'user B starts empty');
    var b = await s.getCategories('');
    assert.equal(b[0].tags[0].name, 'blue');
    assert.equal(calls, 2);
    user = '';
    assert.equal(s.categoriesNow(''), null, 'a missing user id has its own key');
    await s.getCategories('');
    user = 'userA';
    assert.equal(s.categoriesNow('')[0].tags[0].name, 'red');
});

await t('past the TTL the old list keeps being returned while the refetch runs', async function () {
    var realNow = Date.now;
    var t0 = realNow();
    Date.now = function () { return t0 + 11 * 60 * 1000; };
    try {
        var before = calls;
        answer = [{ id: 'exclusive:3', label: 'Group C', kind: 'exclusive', tags: [{ name: 'green' }] }];
        var release;
        gate = new Promise(function (r) { release = r; });
        var stale = s.categoriesNow('');
        assert.ok(stale && stale[0].tags[0].name === 'red', 'stale list, not null');
        assert.equal(calls, before + 1, 'one refetch started');
        assert.equal(s.categoriesNow('')[0].tags[0].name, 'red', 'still stale while in flight');
        assert.equal(calls, before + 1, 'not refetched twice');
        gate = null;
        release();
        await new Promise(function (r) { setTimeout(r, 0); });
        assert.equal(s.categoriesNow('')[0].tags[0].name, 'green', 'fresh once the refetch lands');
    } finally {
        Date.now = realNow;
    }
});

console.log(passed + ' passed' + (process.exitCode ? ', with failures' : ''));
