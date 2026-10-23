/*
 * CARD BADGES, AS PURE FUNCTIONS (QOL_IDEAS #41). No DOM here, so it runs under node
 * (card-badges.test.mjs) exactly as it runs in the browser.
 *
 * A card shows a resolution chip, a runtime chip and the first TAG_COUNT tags of a video. The data
 * is one lookup per batch of cards that scroll into view (controller/card-data.js), never part of a
 * list request: `Fields=Tags` alone is about 0.6 KB per item on the real library (44 tags on average),
 * i.e. roughly 60 KB on every 100-card page, whether or not anyone scrolls to the cards.
 */

export var TAG_COUNT = 2;

// Item types a resolution / runtime / tags badge means something for.
var BADGE_TYPES = { Video: 1, Movie: 1, Episode: 1, MusicVideo: 1, Trailer: 1 };

export function badgeType(type) {
    return !!BADGE_TYPES[type];
}

/*
 * 4K / 1440p / 1080p / 720p / 480p / SD from the pixel size. Judged on both sides, so a cropped
 * widescreen file (1920x800) is 1080p and a vertical phone clip (1080x1920) is too.
 */
export function resolutionLabel(width, height) {
    var w = Number(width);
    var h = Number(height);
    if (!(w > 0) || !(h > 0)) {
        return '';
    }

    var long = Math.max(w, h);
    var short = Math.min(w, h);
    if (long >= 3800 || short >= 2160) { return '4K'; }
    if (long >= 2500 || short >= 1440) { return '1440p'; }
    if (long >= 1900 || short >= 1080) { return '1080p'; }
    if (long >= 1260 || short >= 720) { return '720p'; }
    if (long >= 850 || short >= 480) { return '480p'; }
    return 'SD';
}

function pad2(n) {
    return n < 10 ? '0' + n : String(n);
}

/* RunTimeTicks (100 ns) -> "m:ss" or "h:mm:ss"; '' when there is no runtime. */
export function runtimeLabel(ticks) {
    var t = Number(ticks);
    if (!(t > 0)) {
        return '';
    }

    var s = Math.floor(t / 1e7);
    if (s < 1) {
        return '';
    }

    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    return h > 0 ? h + ':' + pad2(m) + ':' + pad2(sec) : m + ':' + pad2(sec);
}

/* What a card keeps of an item: small on purpose, the cache holds one per card ever seen. */
export function badgeInfo(dto) {
    if (!dto || typeof dto !== 'object') {
        return null;
    }

    var tags = [];
    var list = Array.isArray(dto.Tags) ? dto.Tags : [];
    for (var i = 0; i < list.length && tags.length < TAG_COUNT; i++) {
        var t = typeof list[i] === 'string' ? list[i].trim() : '';
        if (t) {
            tags.push(t);
        }
    }

    return {
        fav: !!(dto.UserData && dto.UserData.IsFavorite),
        res: resolutionLabel(dto.Width, dto.Height),
        runtime: runtimeLabel(dto.RunTimeTicks),
        tags: tags,
        type: dto.Type || ''
    };
}

/* "tag one · tag two". Empty list -> ''. */
export function tagsText(tags) {
    return (tags || []).join(' · ');
}
