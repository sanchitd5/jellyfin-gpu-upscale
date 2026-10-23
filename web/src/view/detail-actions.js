import { log } from '../lib/log.js';
import { watchDetail } from '../controller/detail-page.js';

/*
 * PRIMARY PLAY AND A STICKY ACTION BAR ON THE ITEM PAGE (docs/roadmap/mobile-redesign.md, P7).
 *
 * Nothing is re-created. The stock buttons in .mainDetailButtons keep their own handlers; this only
 *
 *  - marks the one that starts playback (btnPlay: Play or Resume, else the stock btnReplay) with
 *    jpPrimaryPlay and puts its title in a visible label, so CSS can draw it as a wide accent
 *    button first in the row with the other buttons as icons after it;
 *  - builds a compact bar inside #itemDetailPage that docks under the app bar once the button row
 *    has scrolled out above it: the title, previous / next (when detail-nav.js added them to the
 *    row), Play and More. Each bar button only calls .click() on its stock twin, so Play starts at
 *    the resume position exactly as the row's button does, and the Download button and the
 *    prev/next buttons stay where they are in the row.
 *
 * The bar lives inside the page element, so it disappears with the page and needs no route
 * tracking. CSS is scoped to html:not(.jp-theme-off):not(.layout-tv): the off switch and the TV
 * layout see stock. Tokens are --jp-* with stock-equivalent fallbacks. Fail soft: a page without
 * the row, or without IntersectionObserver, simply gets no bar.
 */

var STYLE_ID = 'jpDetailActionsStyle';
var PRIMARY = 'jpPrimaryPlay';
var LABEL = 'jpPlayLabel';
var BAR = 'jpStickyBar';

var ON = 'html:not(.jp-theme-off):not(.layout-tv)';
var NARROW = ON + ':is(.jp-phone, .jp-tablet, .layout-mobile)';

var CSS = [
    ON + ' .mainDetailButtons .' + PRIMARY + '{order:-1;background:var(--jp-accent,#00a4dc)!important;color:var(--jp-on-accent,#fff)!important;' +
        'border-radius:var(--jp-radius-m,8px);min-height:var(--jp-tap,44px);padding:0 1.1em!important;margin-right:.5em!important}',
    ON + ' .mainDetailButtons .' + PRIMARY + ':hover{background:var(--jp-accent-hover,var(--jp-accent,#00a4dc))!important}',
    ON + ' .' + PRIMARY + ' .detailButton-content{flex-direction:row;gap:.35em}',
    ON + ' .' + PRIMARY + ' .detailButton-icon{font-size:1.5em!important}',
    ON + ' .' + LABEL + '{font-weight:600;font-size:var(--jp-font-body,1rem);line-height:1;white-space:nowrap}',
    NARROW + ' .mainDetailButtons{flex-wrap:wrap;row-gap:var(--jp-space-1,.25em)}',
    NARROW + ' .mainDetailButtons .' + PRIMARY + '{flex:1 1 100%;margin:0 0 var(--jp-space-1,.25em)!important}',
    NARROW + ' .mainDetailButtons .detailButton{min-width:var(--jp-tap,44px);min-height:var(--jp-tap,44px)}',
    '.' + BAR + '{display:none}',
    ON + ' .' + BAR + '{position:fixed;left:0;right:0;top:0;z-index:998;align-items:center;gap:var(--jp-space-1,.25em);' +
        'box-sizing:border-box;min-height:52px;padding:0 max(var(--jp-space-3,.75em),env(safe-area-inset-right)) 0 max(var(--jp-space-3,.75em),env(safe-area-inset-left));' +
        'background:var(--jp-surface,#202020);color:var(--jp-text,#fff);border-bottom:1px solid var(--jp-border,rgba(255,255,255,.12));box-shadow:var(--jp-elev-1,0 2px 6px rgba(0,0,0,.4))}',
    ON + ' .' + BAR + '.jpShow{display:flex}',
    'html.jp-sheet-open .' + BAR + '{display:none!important}',
    ON + ' .' + BAR + ' .jpBarTitle{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:var(--jp-font-body,1rem)}',
    ON + ' .' + BAR + ' button{display:inline-flex;align-items:center;justify-content:center;gap:.3em;flex:0 0 auto;min-width:var(--jp-tap,44px);min-height:var(--jp-tap,44px);' +
        'margin:0;padding:0 .5em;border:0;border-radius:var(--jp-radius-m,8px);background:transparent;color:inherit;font:inherit;cursor:pointer}',
    ON + ' .' + BAR + ' button.jpBarPlay{background:var(--jp-accent,#00a4dc);color:var(--jp-on-accent,#fff);font-weight:600;padding:0 .9em}',
    ON + ' .' + BAR + ' button.jpBarFav{opacity:.65}',
    ON + ' .' + BAR + ' button.jpBarFav.jpFav{opacity:1;color:var(--jp-fav,#f4516c)}',
    ON + ' .' + BAR + ' button[hidden]{display:none}'
].join('\n');

function injectStyle() {
    if (document.getElementById(STYLE_ID)) {
        return;
    }

    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
}

function isHidden(btn) {
    return !btn || btn.classList.contains('hide');
}

/* Resume/Play when it is shown, else the stock Replay button; never a detail-nav clone. */
function primaryOf(row) {
    var play = row.querySelector('.btnPlay');
    if (!isHidden(play)) {
        return play;
    }

    var replay = row.querySelector('.btnReplay:not(.jpNavBtn)');
    return isHidden(replay) ? null : replay;
}

function markPrimary(row) {
    var primary = primaryOf(row);
    Array.prototype.forEach.call(row.querySelectorAll('.' + PRIMARY), function (b) {
        if (b !== primary) {
            b.classList.remove(PRIMARY);
        }
    });
    if (!primary) {
        return null;
    }

    if (!primary.classList.contains(PRIMARY)) {
        primary.classList.add(PRIMARY);
    }

    var content = primary.querySelector('.detailButton-content');
    if (content) {
        var label = content.querySelector('.' + LABEL);
        if (!label) {
            label = document.createElement('span');
            label.className = LABEL;
            label.setAttribute('aria-hidden', 'true');
            content.appendChild(label);
        }

        var text = primary.title || '';
        if (label.textContent !== text) {
            label.textContent = text;
        }
    }

    return primary;
}

function proxyButton(cls, icon, title, getTarget) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.title = title;
    b.setAttribute('aria-label', title);
    var g = document.createElement('span');
    g.className = 'material-icons ' + icon;
    g.setAttribute('aria-hidden', 'true');
    b.appendChild(g);
    b.addEventListener('click', function (ev) {
        ev.preventDefault();
        var target = getTarget();
        if (target) {
            target.click();
        }
    });
    return b;
}

function navTwin(row, icon) {
    var glyph = row.querySelector('.jpNavBtn .' + icon);
    return glyph ? glyph.closest('.jpNavBtn') : null;
}

function buildBar(page, row, item) {
    var bar = document.createElement('div');
    bar.className = BAR;
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Item actions');

    var title = document.createElement('span');
    title.className = 'jpBarTitle';
    title.textContent = item.Name || '';

    var prev = proxyButton('jpBarPrev', 'skip_previous', 'Previous', function () { return navTwin(row, 'skip_previous'); });
    var next = proxyButton('jpBarNext', 'skip_next', 'Next', function () { return navTwin(row, 'skip_next'); });
    var play = proxyButton('jpBarPlay', 'play_arrow', 'Play', function () { return primaryOf(row); });
    var label = document.createElement('span');
    label.className = 'jpBarPlayLabel';
    play.appendChild(label);
    var more = proxyButton('jpBarMore', 'more_vert', 'More', function () { return row.querySelector('.btnMoreCommands'); });

    // The heart is a twin of the stock rating button: a click runs ITS handler (apiClient.updateFavoriteStatus),
    // and the state is read back from it (data-isfavorite, kept current by stock's own UserDataChanged subscription).
    var heart = proxyButton('jpBarFav', 'favorite', 'Favorite', function () { return row.querySelector('.btnUserRating'); });
    var fav0 = !!(item.UserData && item.UserData.IsFavorite);
    [prev, title, next, heart, play, more].forEach(function (n) { bar.appendChild(n); });
    page.appendChild(bar);

    // Copy the stock buttons' current state onto the bar. Idempotent, so safe on every mutation.
    bar.__jpSync = function () {
        var primary = markPrimary(row);
        play.hidden = !primary;
        if (primary) {
            var text = primary.title || 'Play';
            if (label.textContent !== text) {
                label.textContent = text;
            }

            play.title = text;
            play.setAttribute('aria-label', text);
        }

        var pTwin = navTwin(row, 'skip_previous');
        var nTwin = navTwin(row, 'skip_next');
        prev.hidden = !pTwin;
        next.hidden = !nTwin;
        if (pTwin) { prev.title = pTwin.title; prev.setAttribute('aria-label', pTwin.title); }
        if (nTwin) { next.title = nTwin.title; next.setAttribute('aria-label', nTwin.title); }
        var rating = row.querySelector('.btnUserRating');
        heart.hidden = isHidden(rating);
        var isFav = rating && rating.hasAttribute('data-isfavorite') ? rating.getAttribute('data-isfavorite') === 'true' : fav0;
        heart.classList.toggle('jpFav', isFav);
        heart.setAttribute('aria-pressed', isFav ? 'true' : 'false');
        if (rating && rating.title) {
            heart.title = rating.title;
            heart.setAttribute('aria-label', rating.title);
        }

        more.hidden = isHidden(row.querySelector('.btnMoreCommands'));
    };
    bar.__jpSync();
    return bar;
}

function headerBottom() {
    var h = document.querySelector('.skinHeader');
    var r = h && h.getBoundingClientRect();
    return r && r.height > 0 ? Math.max(0, Math.round(r.bottom)) : 0;
}

function teardown(page) {
    if (page.__jpActIO) {
        page.__jpActIO.disconnect();
        page.__jpActIO = null;
    }

    if (page.__jpActMO) {
        page.__jpActMO.disconnect();
        page.__jpActMO = null;
    }

    Array.prototype.forEach.call(page.querySelectorAll('.' + BAR), function (b) {
        b.parentNode.removeChild(b);
    });
}

function setup(page, item) {
    teardown(page);
    if (document.documentElement.classList.contains('layout-tv')) {
        return;
    }

    var row = page.querySelector('.mainDetailButtons');
    if (!row) {
        log('detail actions: no button row');
        return;
    }

    var bar = buildBar(page, row, item);

    // Stock and detail-nav toggle `hide`, titles and children after this runs: follow them.
    if (typeof MutationObserver === 'function') {
        page.__jpActMO = new MutationObserver(function () { bar.__jpSync(); });
        page.__jpActMO.observe(row, { attributes: true, attributeFilter: ['class', 'title', 'data-isfavorite'], childList: true, subtree: true });
    }

    if (typeof IntersectionObserver !== 'function') {
        return;
    }

    var top = headerBottom();
    page.__jpActIO = new IntersectionObserver(function (entries) {
        var e = entries[entries.length - 1];
        var offset = headerBottom();
        // Out of view AND above the bar's line: scrolled past, not merely below the fold.
        var past = !e.isIntersecting && e.boundingClientRect.bottom <= offset + 1 && e.boundingClientRect.height > 0;
        bar.style.top = offset + 'px';
        bar.classList.toggle('jpShow', past);
    }, { rootMargin: '-' + top + 'px 0px 0px 0px', threshold: [0, 1] });
    page.__jpActIO.observe(row);
}

export function installDetailActions() {
    if (!document.body) {
        document.addEventListener('DOMContentLoaded', installDetailActions, { once: true });
        return;
    }

    try {
        injectStyle();
        watchDetail({ start: teardown, item: setup });
        log('detail actions: installed');
    } catch (err) {
        log('detail actions: install failed', err);
    }
}
