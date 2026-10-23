import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';
import { closeSheet } from './sheet.js';
import { activeSlot, isVideoPath, isPublicPath } from '../model/nav-routes.js';
import { openLibrariesSheet, openMoreSheet } from '../controller/more-sheet.js';

/*
 * BOTTOM BAR (P3): Home, Libraries, Search, Favourites, More. Phone (jp-phone) and portrait tablet
 * (jp-tablet while the stock drawer is temporary); never on desktop, TV or with the theme off.
 * Spec: redesign-nav-decision.md. Destinations are plain hash links (the stock router does the
 * rest); Libraries and More open the shared sheet. The stock header, hamburger and avatar menu are
 * untouched. While the bar is laid out, --jp-nav-h carries its height so pages and the stock music
 * bar can make room.
 *
 * Hidden (display: none, --jp-nav-h 0) on the video page, public routes, while selecting
 * (html.jp-selecting) and while the player is locked (html.jp-player-locked). Slid out, not removed,
 * while the virtual keyboard is up. Under a sheet it stays laid out, inert, covered by the scrim.
 */

var STYLE_ID = 'jellyfinPlusBottomNavStyle';
var NAV_ID = 'jellyfinPlusBottomNav';
var ON = 'jp-nav-on';
var SLOTS = [
    { id: 'home', label: 'Home', icon: 'home', href: '#/home' },
    { id: 'libraries', label: 'Libraries', icon: 'video_library', sheet: openLibrariesSheet },
    { id: 'search', label: 'Search', icon: 'search', href: '#/search' },
    { id: 'favourites', label: 'Favourites', icon: 'favorite', href: '#/home?tab=1' },
    { id: 'more', label: 'More', icon: 'more_horiz', sheet: openMoreSheet }
];

var CSS = [
    'html { --jp-navbar-h: 56px; }',
    '@media (max-height: 480px) { html { --jp-navbar-h: 48px; } }',
    '#' + NAV_ID + ' { position: fixed; left: 0; right: 0; bottom: 0; z-index: 1200; display: none; box-sizing: border-box;'
        + ' justify-content: center; height: calc(var(--jp-navbar-h) + var(--jp-safe-bottom, env(safe-area-inset-bottom, 0px)));'
        + ' padding-bottom: var(--jp-safe-bottom, env(safe-area-inset-bottom, 0px));'
        + ' background: var(--jp-surface, var(--jf-palette-background-paper, #202020));'
        + ' border-top: 1px solid var(--jp-border, rgba(128,128,128,0.4)); touch-action: manipulation;'
        + ' transition: transform var(--jp-dur-fast, 120ms) var(--jp-ease, ease-out); }',
    'html.' + ON + ' #' + NAV_ID + ' { display: flex; }',
    'html.jp-nav-kbd #' + NAV_ID + ' { transform: translateY(100%); }',
    '#' + NAV_ID + ' .jp-nav-slot { flex: 1 1 0; max-width: 168px; min-width: 0; display: flex; flex-direction: column;'
        + ' align-items: center; justify-content: center; gap: 2px; margin: 0; padding: 0; border: 0; background: none;'
        + ' font: inherit; font-size: var(--jp-font-small, 12px); line-height: 1.1; text-decoration: none; cursor: pointer;'
        + ' color: var(--jp-text-muted, var(--jf-palette-text-secondary, #aaa)); -webkit-tap-highlight-color: transparent; }',
    '#' + NAV_ID + ' .jp-nav-slot[aria-current="page"], #' + NAV_ID + ' .jp-nav-slot[aria-expanded="true"] {'
        + ' color: var(--jp-accent, var(--jf-palette-primary-main, #00a4dc)); }',
    '#' + NAV_ID + ' .jp-nav-slot:focus-visible { outline: 2px solid var(--jp-accent, #00a4dc); outline-offset: -3px; }',
    '#' + NAV_ID + ' .material-icons { font-size: 24px; }',
    '@media (max-width: 359px) { #' + NAV_ID + ' .jp-nav-slot { font-size: 11px; } }',
    '@media (max-height: 480px) { #' + NAV_ID + ' .jp-nav-slot { flex-direction: row; gap: 6px; } }',
    // Room for the bar: the stock rule reserves 5em for the music bar; stack the music bar on top.
    'html.' + ON + ' .content-primary, html.' + ON + ' .padded-bottom-page, html.' + ON + ' .page,'
        + ' html.' + ON + ' .pageWithAbsoluteTabs .pageTabContent {'
        + ' padding-bottom: calc(env(safe-area-inset-bottom) + 5em + var(--jp-nav-h, 0px)); }',
    'html.' + ON + ' .nowPlayingBar:not(.hide) { bottom: var(--jp-nav-h, 0px); }'
].join('\n');

var nav = null;
var slotEls = {};
var sheetOwner = null;

function hasClass(c) { return document.documentElement.classList.contains(c); }

function shouldShow() {
    if (hasClass('jp-theme-off') || hasClass('layout-tv')) { return false; }
    var phone = hasClass('jp-phone');
    var tablet = hasClass('jp-tablet');
    if (!phone && !tablet) { return false; }
    if (tablet && document.querySelector('.MuiDrawer-docked')) { return false; }
    if (hasClass('jp-selecting') || hasClass('jp-player-locked')) { return false; }
    var hash = window.location.hash;
    if (isVideoPath(hash) || isPublicPath(hash) || document.querySelector('.videoOsdPage')) { return false; }
    return true;
}

function keyboardUp() {
    var vv = window.visualViewport;
    var a = document.activeElement;
    if (!vv || !a || vv.height >= window.innerHeight - 150) { return false; }
    return a.isContentEditable || /^(input|textarea)$/i.test(a.tagName);
}

function render() {
    if (!nav) { return; }
    var html = document.documentElement;
    var show = shouldShow();
    if (html.classList.contains(ON) !== show) {
        html.classList.toggle(ON, show);
        if (show) {
            html.style.setProperty('--jp-nav-h', 'calc(var(--jp-navbar-h) + var(--jp-safe-bottom, env(safe-area-inset-bottom, 0px)))');
        } else {
            html.style.removeProperty('--jp-nav-h');
        }
    }
    html.classList.toggle('jp-nav-kbd', show && keyboardUp());
    var sheet = hasClass('jp-sheet-open');
    nav.inert = sheet;
    if (sheet) { nav.setAttribute('aria-hidden', 'true'); } else { nav.removeAttribute('aria-hidden'); }
    var active = sheetOwner || activeSlot(window.location.hash);
    SLOTS.forEach(function (s) {
        var n = slotEls[s.id];
        if (s.id === active) { n.setAttribute('aria-current', 'page'); } else { n.removeAttribute('aria-current'); }
        if (s.sheet) { n.setAttribute('aria-expanded', s.id === sheetOwner ? 'true' : 'false'); }
    });
}

function scrollTop() {
    var page = document.querySelector('.mainAnimatedPage:not(.hide)');
    [page, document.scrollingElement].forEach(function (n) {
        if (n && n.scrollTop > 0) { n.scrollTo ? n.scrollTo({ top: 0, behavior: 'smooth' }) : (n.scrollTop = 0); }
    });
}

function build() {
    var bar = el('nav');
    bar.id = NAV_ID;
    bar.setAttribute('aria-label', 'Primary');
    SLOTS.forEach(function (s) {
        var n;
        if (s.href) {
            n = el('a', 'jp-nav-slot');
            n.href = s.href;
            n.addEventListener('click', function () {
                if (activeSlot(window.location.hash) === s.id) { scrollTop(); }
            });
        } else {
            n = el('button', 'jp-nav-slot');
            n.type = 'button';
            n.setAttribute('aria-haspopup', 'dialog');
            n.addEventListener('click', function () {
                if (sheetOwner === s.id) { closeSheet('slot'); return; }
                sheetOwner = s.id;
                s.sheet(n, function () { sheetOwner = null; render(); });
                render();
            });
        }
        var ic = el('span', 'material-icons', s.icon);
        ic.setAttribute('aria-hidden', 'true');
        n.appendChild(ic);
        n.appendChild(el('span', 'jp-nav-label', s.label));
        slotEls[s.id] = n;
        bar.appendChild(n);
    });
    // A fixed overlay must not feed the player's wheel-volume or page gestures.
    ['wheel', 'touchmove'].forEach(function (t) {
        bar.addEventListener(t, function (e) { e.stopPropagation(); }, { passive: true });
    });
    return bar;
}

export function installBottomNav() {
    if (document.getElementById(NAV_ID)) { return; }
    if (!document.body) {
        document.addEventListener('DOMContentLoaded', installBottomNav, { once: true });
        return;
    }
    var style = el('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
    nav = build();
    document.body.appendChild(nav);

    var timer = null;
    var later = function () {
        if (timer) { return; }
        timer = setTimeout(function () { timer = null; render(); }, 100);
    };
    window.addEventListener('hashchange', render);
    window.addEventListener('popstate', render);
    window.addEventListener('resize', later);
    if (window.visualViewport) { window.visualViewport.addEventListener('resize', render); }
    document.addEventListener('focusin', render);
    document.addEventListener('focusout', later);
    // Drawer, video page and html-class changes (tier, selecting, locked, sheet) arrive as DOM changes.
    new MutationObserver(later).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    new MutationObserver(later).observe(document.body, { childList: true });
    render();
    log('bottom nav installed');
}
