import { log } from '../lib/log.js';
import { landingSeeds, videosTabHash, DEFAULT_LANDING } from '../model/library-landing.js';

/*
 * Home Videos libraries open on Videos instead of Folders (see model/library-landing.js for the stock
 * seam). Once per user per page load: read the user's views and the server copy of their settings,
 * then seed "<userId>-landing-<libraryId>" in localStorage wherever this device has nothing, which
 * is exactly what stock getDefaultViewIndex() reads. Anything failing leaves stock behaviour.
 */

var doneFor = null;   // userId seeded this page load
var running = false;

/* The user's /UserViews items once fetched; the bottom bar's Libraries sheet reuses it. */
export var viewsCache = null;

function getJson(client, path, params) {
    return client.ajax({ type: 'GET', url: client.getUrl(path, params), dataType: 'json' });
}

function seed() {
    var client = window.ApiClient;
    if (running || !client || typeof client.getCurrentUserId !== 'function' || typeof client.ajax !== 'function'
        || typeof client.getUrl !== 'function') {
        return;
    }

    var userId = client.getCurrentUserId();
    if (!userId || userId === doneFor) {
        return;
    }

    running = true;
    var prefs = getJson(client, 'DisplayPreferences/usersettings', { userId: userId, client: 'emby' })
        .then(function (p) { return p && p.CustomPrefs; }, function () { return null; });

    Promise.all([getJson(client, 'UserViews', { userId: userId }), prefs]).then(function (r) {
        var views = r[0] && r[0].Items;
        if (views) { viewsCache = views; }
        var seeds = landingSeeds(userId, views, r[1], function (k) { return window.localStorage.getItem(k); });
        seeds.forEach(function (s) {
            window.localStorage.setItem(s[0], s[1]);
            // Already sitting on that library's stock default (rendered before the seed): show Videos.
            var id = s[0].slice((userId + '-landing-').length);
            var next = s[1] === DEFAULT_LANDING ? videosTabHash(window.location.hash, id) : null;
            if (next) {
                window.location.replace(next);
            }
        });
        doneFor = userId;
        if (seeds.length) {
            log('library landing: seeded ' + seeds.length + ' Home Videos librar' + (seeds.length === 1 ? 'y' : 'ies'));
        }
    }).catch(function (err) {
        log('library landing: skipped', err);
    }).then(function () {
        running = false;
    });
}

export function installLibraryLanding() {
    window.addEventListener('hashchange', seed);
    seed();
}
