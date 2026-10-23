// Run: node web/src/model/image-preload.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import { isLazyLoaderClass, isImageUrl, enabled, createQueue, PREF_KEY } from './image-preload.js';

var passed = 0;
var pending = [];
function t(name, fn) {
    pending.push(Promise.resolve().then(fn).then(function () {
        passed++;
        console.log('ok   ' + name);
    }, function (e) {
        console.log('FAIL ' + name + '\n' + e.message);
        process.exitCode = 1;
    }));
}
function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }
function deferredLoader() {
    var calls = [];
    var load = function (url) {
        return new Promise(function (resolve) { calls.push({ url: url, resolve: resolve }); });
    };
    return { calls: calls, load: load };
}

t('recognises the LazyLoader shape only', function () {
    class LazyLoader { createObserver() {} addElements() {} destroyObserver() {} destroy() {} }
    class Other { addElements() {} }
    assert.equal(isLazyLoaderClass(LazyLoader), true);
    assert.equal(isLazyLoaderClass(Other), false);
    assert.equal(isLazyLoaderClass({}), false);
    assert.equal(isLazyLoaderClass(null), false);
});

t('only Jellyfin image urls qualify', function () {
    assert.equal(isImageUrl('https://h/Items/abc/Images/Primary?fillWidth=300&tag=x'), true);
    assert.equal(isImageUrl('/Users/u/Items?ParentId=1'), false);
    assert.equal(isImageUrl(null), false);
});

t('enabled unless switched off; storage errors mean on', function () {
    assert.equal(enabled({ getItem: function () { return null; } }), true);
    assert.equal(enabled({ getItem: function (k) { return k === PREF_KEY ? 'off' : null; } }), false);
    assert.equal(enabled({ getItem: function () { throw new Error('blocked'); } }), true);
});

t('runs at most max at once, nearest first', async function () {
    var d = deferredLoader();
    var q = createQueue(d.load, 2);
    q.add('far', 900);
    q.add('near', 10);
    q.add('mid', 300);
    await tick();
    // 'far' was alone when added so it started; then 'near' filled the second slot.
    assert.deepEqual(d.calls.map(function (c) { return c.url; }), ['far', 'near']);
    d.calls[1].resolve();
    await tick();
    assert.deepEqual(d.calls.map(function (c) { return c.url; }), ['far', 'near', 'mid']);
});

t('each url fetched once; drop forgets a waiting one', async function () {
    var d = deferredLoader();
    var q = createQueue(d.load, 1);
    q.add('a', 1);
    q.add('a', 1);
    q.add('b', 2);
    q.add('c', 3);
    q.drop('b');
    await tick();
    d.calls[0].resolve();
    await tick();
    d.calls[1].resolve();
    await tick();
    assert.deepEqual(d.calls.map(function (c) { return c.url; }), ['a', 'c']);
    q.add('a', 0);
    await tick();
    assert.equal(d.calls.length, 2);
});

t('a failing load frees its slot', async function () {
    var n = 0;
    var q = createQueue(function () { n++; return Promise.reject(new Error('404')); }, 1);
    q.add('x', 1);
    q.add('y', 2);
    await tick();
    await tick();
    assert.equal(n, 2);
    assert.equal(q.stats().running, 0);
});

Promise.all(pending).then(function () { console.log(passed + ' passed'); });
