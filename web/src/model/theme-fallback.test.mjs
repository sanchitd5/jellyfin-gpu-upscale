// Run: node web/src/model/theme-fallback.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import { fallbackHref } from './theme-fallback.js';

assert.equal(fallbackHref('themes/jellyfinplus/theme.css'), 'themes/dark/theme.css');
assert.equal(fallbackHref('http://h:8096/web/themes/jellyfinplus/theme.css?v=1'), 'http://h:8096/web/themes/dark/theme.css');
assert.equal(fallbackHref('themes/dark/theme.css'), null);
assert.equal(fallbackHref('themes/jellyfinplus/other.css'), null);
assert.equal(fallbackHref(null), null);
console.log('ok   theme-fallback (5 assertions)');
