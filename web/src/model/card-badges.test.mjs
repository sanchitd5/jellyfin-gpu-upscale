// Run: node web/src/model/card-badges.test.mjs   (no framework; exits non-zero on failure)
import assert from 'node:assert/strict';
import { resolutionLabel, runtimeLabel, badgeInfo, badgeType, tagsText, TAG_COUNT } from './card-badges.js';

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

t('resolution tiers on common sizes', function () {
    assert.equal(resolutionLabel(3840, 2160), '4K');
    assert.equal(resolutionLabel(3840, 1600), '4K');
    assert.equal(resolutionLabel(2560, 1440), '1440p');
    assert.equal(resolutionLabel(1920, 1080), '1080p');
    assert.equal(resolutionLabel(1280, 720), '720p');
    assert.equal(resolutionLabel(854, 480), '480p');
    assert.equal(resolutionLabel(640, 480), '480p');
    assert.equal(resolutionLabel(720, 576), '480p');
    assert.equal(resolutionLabel(480, 360), 'SD');
    assert.equal(resolutionLabel(320, 240), 'SD');
});

t('cropped widescreen and vertical clips are judged on both sides', function () {
    assert.equal(resolutionLabel(1920, 800), '1080p');
    assert.equal(resolutionLabel(1280, 536), '720p');
    assert.equal(resolutionLabel(1080, 1920), '1080p');
    assert.equal(resolutionLabel(720, 1280), '720p');
    assert.equal(resolutionLabel(2160, 3840), '4K');
});

t('no or bad size gives no label', function () {
    assert.equal(resolutionLabel(undefined, undefined), '');
    assert.equal(resolutionLabel(0, 1080), '');
    assert.equal(resolutionLabel(1920, null), '');
    assert.equal(resolutionLabel('x', 'y'), '');
});

t('runtime formatting', function () {
    assert.equal(runtimeLabel(0), '');
    assert.equal(runtimeLabel(undefined), '');
    assert.equal(runtimeLabel(5e6), '');
    assert.equal(runtimeLabel(1e7), '0:01');
    assert.equal(runtimeLabel(59 * 1e7), '0:59');
    assert.equal(runtimeLabel(61 * 1e7), '1:01');
    assert.equal(runtimeLabel((12 * 60 + 34) * 1e7), '12:34');
    assert.equal(runtimeLabel(3600 * 1e7), '1:00:00');
    assert.equal(runtimeLabel((2 * 3600 + 5 * 60 + 9) * 1e7), '2:05:09');
});

t('badgeInfo keeps the first tags only, trimmed, no blanks', function () {
    var i = badgeInfo({ Tags: [' a ', '', 'b', 'c', 'd'], Width: 1920, Height: 1080, RunTimeTicks: 600 * 1e7, UserData: { IsFavorite: true } });
    assert.deepEqual(i.tags, ['a', 'b']);
    assert.equal(TAG_COUNT, 2);
    assert.equal(i.res, '1080p');
    assert.equal(i.runtime, '10:00');
    assert.equal(i.fav, true);
});

t('badgeInfo survives a sparse or odd dto', function () {
    assert.equal(badgeInfo(null), null);
    assert.equal(badgeInfo('x'), null);
    var i = badgeInfo({});
    assert.deepEqual(i, { fav: false, res: '', runtime: '', tags: [], type: '' });
    assert.deepEqual(badgeInfo({ Tags: [1, null, 'ok'] }).tags, ['ok']);
    assert.deepEqual(badgeInfo({ Tags: 'not a list' }).tags, []);
});

t('tagsText and badgeType', function () {
    assert.equal(tagsText(['a', 'b']), 'a · b');
    assert.equal(tagsText([]), '');
    assert.equal(tagsText(undefined), '');
    assert.equal(badgeType('Video'), true);
    assert.equal(badgeType('Movie'), true);
    assert.equal(badgeType('Series'), false);
    assert.equal(badgeType('Person'), false);
});

console.log(passed + ' passed');
