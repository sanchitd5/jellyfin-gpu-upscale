import { log } from '../lib/log.js';
import { TIERS, tierOf, themeCss, zoomableViewport } from '../model/theme-tokens.js';

/*
 * JELLYFIN PLUS THEME (P1, P10): the --jp-* tokens, the width tiers, pinch-zoom, reduced motion.
 *
 *  - ONE <style id="jellyfinPlusMobileThemeStyle"> built by model/theme-tokens.js. Every rule is
 *    scoped html:not(.jp-theme-off):not(.layout-tv), so the off switch and the TV layout are stock.
 *  - Tier classes on <html> from window.innerWidth: jp-phone (<600), jp-tablet (600-1023),
 *    jp-desktop (>=1024). Width, not layout-mobile: iPads report browser.mobile. None on layout-tv.
 *  - Pinch-zoom: the viewport meta loses user-scalable=no and maximum-scale (original kept and
 *    restored on TV). Never on TV.
 *  - localStorage jellyfinPlus.mobileTheme: "off" = stock (no style, no tier classes, jp-theme-off
 *    set so other modules know); "light" = light scheme whatever the stock theme; absent = follow
 *    the stock theme (data-theme=light) or the OS while no stock theme is pinned. Read at load.
 *
 * Fail soft: storage, meta or class access throwing leaves stock behaviour.
 */

var KEY = 'jellyfinPlus.mobileTheme';
var STYLE_ID = 'jellyfinPlusMobileThemeStyle';

/*
 * A URL switch for getting back when the look is off (the bottom bar and its More sheet are hidden
 * then): `?jpTheme=on|off|light`, in the query string or in the hash's query (`#/home?jpTheme=on`).
 * "on" clears the stored value (= the default look).
 */
function urlSwitch() {
    var m = /[?&]jpTheme=(on|off|light)\b/.exec((window.location.search || '') + ' ' + (window.location.hash || ''));
    if (!m) {
        return;
    }
    try {
        if (m[1] === 'on') {
            localStorage.removeItem(KEY);
        } else {
            localStorage.setItem(KEY, m[1]);
        }
    } catch (e) { /* storage blocked: nothing to switch */ }
}

function mode() {
    try {
        var v = localStorage.getItem(KEY);
        return v === 'off' || v === 'light' ? v : '';
    } catch (e) { return ''; }
}

/*
 * A "Jellyfin Plus look" row on the stock Settings page (#myPreferencesMenuPage, after Display), in
 * BOTH states, so every tier (desktop has no bottom bar) and the off state have a way to switch.
 */
var SETTINGS_ROW_ID = 'jellyfinPlusLookRow';

function settingsRow(m) {
    var page = document.getElementById('myPreferencesMenuPage');
    var anchor = page && page.querySelector('.lnkDisplayPreferences');
    if (!anchor || document.getElementById(SETTINGS_ROW_ID)) {
        return;
    }
    var off = m === 'off';
    var a = document.createElement('a');
    a.id = SETTINGS_ROW_ID;
    a.href = '#';
    a.className = 'listItem-border';
    a.style.display = 'block';
    a.style.margin = '0';
    a.style.padding = '0';
    a.innerHTML = '<div class="listItem"><span class="material-icons listItemIcon listItemIcon-transparent palette" aria-hidden="true"></span>'
        + '<div class="listItemBody"><div class="listItemBodyText">Jellyfin Plus look</div>'
        + '<div class="listItemBodyText secondary">' + (off ? 'Off - tap to turn on' : 'On - tap to turn off') + '</div></div></div>';
    a.addEventListener('click', function (e) {
        e.preventDefault();
        try {
            if (off) {
                localStorage.removeItem(KEY);
            } else {
                localStorage.setItem(KEY, 'off');
            }
        } catch (err) { return; }
        window.location.reload();
    });
    anchor.parentNode.insertBefore(a, anchor.nextSibling);
}

function watchSettingsRow(m) {
    var start = function () {
        if (!document.body) {
            return;
        }
        new MutationObserver(function () {
            if (!document.documentElement.classList.contains('layout-tv')) {
                settingsRow(m);
            }
        }).observe(document.body, { childList: true, subtree: true });
    };
    if (document.body) {
        start();
    } else {
        document.addEventListener('DOMContentLoaded', start);
    }
}

function setClass(html, cls, on) {
    if (html.classList.contains(cls) !== on) html.classList.toggle(cls, on);
}

var originalViewport = null;

function viewport(tv) {
    var m = document.querySelector('meta[name="viewport"]');
    if (!m) return;
    var cur = m.getAttribute('content') || '';
    if (tv) {
        if (originalViewport != null && cur !== originalViewport) m.setAttribute('content', originalViewport);
        return;
    }
    var next = zoomableViewport(cur);
    if (next !== cur) {
        if (originalViewport == null) originalViewport = cur;
        m.setAttribute('content', next);
    }
}

function apply(m) {
    var html = document.documentElement;
    var tv = html.classList.contains('layout-tv');
    var off = m === 'off';
    setClass(html, 'jp-theme-off', off);
    setClass(html, 'jp-scheme-light', m === 'light');
    var tier = off || tv ? '' : tierOf(window.innerWidth || html.clientWidth);
    TIERS.forEach(function (c) { setClass(html, c, c === tier); });
    if (!off) viewport(tv);
}

export function installMobileTheme() {
    urlSwitch();
    var m = mode();
    var html = document.documentElement;
    var old = document.getElementById(STYLE_ID);
    watchSettingsRow(m);
    if (m === 'off') {
        if (old) old.remove();
        apply(m);
        log('mobile theme: off');
        return;
    }
    if (!old) {
        var st = document.createElement('style');
        st.id = STYLE_ID;
        st.textContent = themeCss();
        (document.head || html).appendChild(st);
    }
    apply(m);
    var run = function () { apply(m); };
    // iOS reports the old width inside orientationchange itself, so look again once it settles.
    var settle = function () { run(); setTimeout(run, 250); };
    window.addEventListener('resize', run);
    window.addEventListener('orientationchange', settle);
    document.addEventListener('DOMContentLoaded', run);
    // layout-tv is set after this script runs; follow it (apply() only writes on a real change).
    new MutationObserver(run).observe(html, { attributes: true, attributeFilter: ['class'] });
    watchSkeletons();
}

/*
 * Loading skeletons: a section or row container that APPEARS empty gets `.jpSkel` for at most
 * SKELETON_MS. The CSS shows the shimmer only while it is both marked and empty, so it vanishes the
 * moment cards land, and a section that stays empty for good loses it when the mark expires. The mark
 * is given once per element, so a re-render that empties a live section never brings it back.
 */
var SKELETON_MS = 2000;
var SKEL_SELECTOR = '.verticalSection, .verticalSection .itemsContainer';
var skelSeen = new WeakSet();

function markSkeleton(el) {
    if (skelSeen.has(el) || el.firstElementChild) {
        return;
    }
    skelSeen.add(el);
    el.classList.add('jpSkel');
    setTimeout(function () { el.classList.remove('jpSkel'); }, SKELETON_MS);
}

function watchSkeletons() {
    var start = function () {
        if (!document.body) {
            return;
        }
        new MutationObserver(function (records) {
            if (document.documentElement.classList.contains('layout-tv')) {
                return;
            }
            records.forEach(function (r) {
                Array.prototype.forEach.call(r.addedNodes, function (n) {
                    if (n.nodeType !== 1) {
                        return;
                    }
                    if (n.matches && n.matches(SKEL_SELECTOR)) {
                        markSkeleton(n);
                    }
                    if (n.querySelectorAll) {
                        Array.prototype.forEach.call(n.querySelectorAll(SKEL_SELECTOR), markSkeleton);
                    }
                });
            });
        }).observe(document.body, { childList: true, subtree: true });
    };
    if (document.body) {
        start();
    } else {
        document.addEventListener('DOMContentLoaded', start);
    }
}
