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

function mode() {
    try {
        var v = localStorage.getItem(KEY);
        return v === 'off' || v === 'light' ? v : '';
    } catch (e) { return ''; }
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
    var m = mode();
    var html = document.documentElement;
    var old = document.getElementById(STYLE_ID);
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
}
