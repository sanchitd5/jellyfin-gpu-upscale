// Run: node web/src/model/library-landing.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import { DEFAULT_LANDING, landingKey, landingSeeds, videosTabHash } from './library-landing.js';

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

var U = 'u1';
var views = [
    { Id: 'a', CollectionType: 'homevideos' },
    { Id: 'b', CollectionType: 'movies' },
    { Id: 'c', CollectionType: 'homevideos' }
];
function get(store) { return function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; }; }

t('key matches stock appSettings shape', function () {
    assert.equal(landingKey(U, 'a'), 'u1-landing-a');
});

t('seeds videos for every homevideos library with nothing stored', function () {
    assert.deepEqual(landingSeeds(U, views, null, get({})), [['u1-landing-a', DEFAULT_LANDING], ['u1-landing-c', DEFAULT_LANDING]]);
});

t('never touches a key already stored on this device', function () {
    assert.deepEqual(landingSeeds(U, views, null, get({ 'u1-landing-a': 'folders' })), [['u1-landing-c', 'videos']]);
});

t('copies the user\'s server-side choice instead of the default', function () {
    assert.deepEqual(landingSeeds(U, views, { 'landing-a': 'folders', 'landing-c': '' }, get({})),
        [['u1-landing-a', 'folders'], ['u1-landing-c', 'videos']]);
});

t('other library types and junk are ignored', function () {
    assert.deepEqual(landingSeeds(U, [{ CollectionType: 'homevideos' }, null, { Id: 'b', CollectionType: 'movies' }], null, get({})), []);
    assert.deepEqual(landingSeeds('', views, null, get({})), []);
    assert.deepEqual(landingSeeds(U, null, null, get({})), []);
});

t('videosTabHash adds tab=3 only for that library without a tab', function () {
    assert.equal(videosTabHash('#/homevideos?topParentId=a', 'a'), '#/homevideos?topParentId=a&tab=3');
    assert.equal(videosTabHash('#/homevideos?topParentId=a&tab=0', 'a'), null);
    assert.equal(videosTabHash('#/homevideos?topParentId=b', 'a'), null);
    assert.equal(videosTabHash('#/movies?topParentId=a', 'a'), null);
    assert.equal(videosTabHash('', 'a'), null);
});

console.log(passed + ' passed');
