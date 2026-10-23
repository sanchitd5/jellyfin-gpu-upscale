/*
 * Default tab for Home Videos libraries: Videos instead of Folders.
 *
 * jellyfin-web 12.1 picks a library's opening tab in getDefaultViewIndex()
 * (apps/modern/features/libraries/utils/path.ts): the user's "landing-<libraryId>" setting, read from
 * THIS DEVICE's localStorage only (userSettings.get(name, false) -> "<userId>-landing-<libraryId>"),
 * else the route's isDefault view, which for /homevideos is Folders. The stock Settings > Home
 * "default screen" select writes the same key (and the server's CustomPrefs copy).
 *
 * So the fix is to seed that key where nothing is stored on this device: the user's own choice from
 * the server copy when there is one (an explicit "Folders" stays Folders), else "videos". A key that
 * already has a value is never touched.
 */

export var DEFAULT_LANDING = 'videos';
// /homevideos route view order (libraryRoutes.ts): Folders 0, Photos 1, Photo albums 2, Videos 3.
export var VIDEOS_TAB_INDEX = 3;

export function landingKey(userId, libraryId) {
    return userId + '-landing-' + libraryId;
}

/*
 * The [localStorageKey, value] pairs to write. `views` is the /UserViews Items array, `serverPrefs`
 * the usersettings CustomPrefs object (or null), `localGet(key)` reads localStorage.
 */
export function landingSeeds(userId, views, serverPrefs, localGet) {
    var out = [];
    if (!userId || !Array.isArray(views)) {
        return out;
    }

    views.forEach(function (v) {
        if (!v || v.CollectionType !== 'homevideos' || typeof v.Id !== 'string' || !v.Id) {
            return;
        }

        var key = landingKey(userId, v.Id);
        if (localGet(key) != null) {
            return;
        }

        var server = serverPrefs && serverPrefs['landing-' + v.Id];
        out.push([key, typeof server === 'string' && server ? server : DEFAULT_LANDING]);
    });

    return out;
}

/*
 * For a hash like "#/homevideos?topParentId=X" with no tab= on it, the same hash opened on the
 * Videos tab - used once when the page was already rendered before the key was seeded. Null when
 * the hash is not that.
 */
export function videosTabHash(hash, libraryId) {
    var m = /^#\/homevideos\?(.*)$/.exec(hash || '');
    if (!m) {
        return null;
    }

    var params = new URLSearchParams(m[1]);
    if (params.get('topParentId') !== libraryId || params.has('tab')) {
        return null;
    }

    params.set('tab', String(VIDEOS_TAB_INDEX));
    return '#/homevideos?' + params.toString();
}
