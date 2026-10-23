// Run: node web/src/model/nav-routes.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import { parseHash, activeSlot, libraryHref, isVideoPath, isPublicPath } from './nav-routes.js';
import { DARK, LIGHT, contrast } from './theme-tokens.js';

assert.equal(parseHash('#/Home.html?tab=1').path, 'home');
assert.equal(activeSlot('#/home'), 'home');
assert.equal(activeSlot('#/home?tab=0'), 'home');
assert.equal(activeSlot('#/home?tab=1'), 'favourites');
assert.equal(activeSlot('#/home?tab=2'), null);
assert.equal(activeSlot('#/search?query=x'), 'search');
assert.equal(activeSlot('#/movies?topParentId=1'), 'libraries');
assert.equal(activeSlot('#/list?parentId=1'), 'libraries');
assert.equal(activeSlot('#/queue'), 'more');
assert.equal(activeSlot('#/mypreferencesmenu'), 'more');
assert.equal(activeSlot('#/dashboard'), 'more');
assert.equal(activeSlot('#/details?id=1'), null);
assert.ok(isVideoPath('#/video'));
assert.ok(!isVideoPath('#/videos'));
assert.ok(isPublicPath('#/login.html'));
assert.ok(!isPublicPath('#/home'));

assert.equal(libraryHref({ Id: 'a b', ServerId: 's', CollectionType: 'movies' }, false),
    '#/movies?topParentId=a%20b&collectionType=movies');
assert.equal(libraryHref({ Id: '1', CollectionType: 'livetv' }, true), '#/livetv');
assert.equal(libraryHref({ Id: '1', CollectionType: 'books' }, true), '#/books?topParentId=1&collectionType=books');
assert.equal(libraryHref({ Id: '1', ServerId: 's', CollectionType: 'books' }, false), '#/list?parentId=1&serverId=s');
assert.equal(libraryHref({ Id: '1', CollectionType: 'homevideos' }, true), '#/homevideos?topParentId=1');
assert.equal(libraryHref({ Id: '1', Type: 'CollectionFolder' }, true), '#/mixed?topParentId=1&collectionType=mixed');
assert.equal(libraryHref({ Id: '1', ServerId: 's', Type: 'CollectionFolder' }, false), '#/list?parentId=1&serverId=s');

// inactive label colour (muted on surface) must pass AA at 12px
assert.ok(contrast(DARK.muted, DARK.surface) >= 4.5, 'dark muted on surface');
assert.ok(contrast(LIGHT.muted, LIGHT.surface) >= 4.5, 'light muted on surface');
console.log('ok   nav-routes');
