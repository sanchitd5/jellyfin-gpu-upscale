/*
 * THEME TOKENS (pure): the --jp-* palette, the width tiers, the contrast maths and the stylesheet
 * text. No DOM, no storage: view/mobile-theme.js installs what this builds, and
 * theme-tokens.test.mjs asserts WCAG AA on every text and accent pair below.
 *
 * Every rule is scoped `html:not(.jp-theme-off):not(.layout-tv)`: the off switch and the TV layout
 * both fall straight through to stock. Other modules read tokens as var(--jp-x, <stock fallback>).
 */

export var TIERS = ['jp-phone', 'jp-tablet', 'jp-desktop'];

// Decided by viewport width, never by layout-mobile: iPads report browser.mobile.
export function tierOf(width) {
    var w = +width;
    if (!(w > 0)) return 'jp-desktop';
    return w < 600 ? 'jp-phone' : w < 1024 ? 'jp-tablet' : 'jp-desktop';
}

export var DARK = {
    bg: '#0f1115', surface: '#181b21', surface2: '#22262e', text: '#f2f4f7', muted: '#aab2bf',
    accent: '#5ccfff', accentHover: '#8fdfff', onAccent: '#0b1a22', error: '#ff6b6b',
    border: '#3a404b', scrim: 'rgba(0,0,0,.6)',
    elev1: '0 0 0 1px rgba(255,255,255,.04)', elev2: '0 -8px 24px rgba(0,0,0,.35)'
};
export var LIGHT = {
    bg: '#f7f8fa', surface: '#ffffff', surface2: '#eef0f4', text: '#15181e', muted: '#4b5563',
    accent: '#0369a1', accentHover: '#075985', onAccent: '#ffffff', error: '#b42318',
    border: '#c9ced6', scrim: 'rgba(0,0,0,.35)',
    elev1: '0 1px 3px rgba(0,0,0,.12)', elev2: '0 -8px 24px rgba(0,0,0,.2)'
};

function lin(c) {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function lum(hex) {
    var n = parseInt(hex.slice(1), 16);
    return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
// WCAG 2.x contrast ratio of two #rrggbb colours.
export function contrast(a, b) {
    var x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

var BASE = 'html:not(.jp-theme-off):not(.layout-tv)';
var LIGHT_SEL = [
    BASE + '[data-theme="light"]',
    BASE + '.jp-scheme-light'
];

function scheme(p) {
    return '--jp-bg:' + p.bg + ';--jp-surface:' + p.surface + ';--jp-surface-2:' + p.surface2
        + ';--jp-text:' + p.text + ';--jp-text-muted:' + p.muted + ';--jp-accent:' + p.accent
        + ';--jp-accent-hover:' + p.accentHover + ';--jp-on-accent:' + p.onAccent
        + ';--jp-error:' + p.error + ';--jp-border:' + p.border + ';--jp-scrim:' + p.scrim
        + ';--jp-elev-1:' + p.elev1 + ';--jp-elev-2:' + p.elev2;
}

// Stock palette variables (every themes/<id>/theme.css and MUI read these), re-pointed at the tokens.
var MAP = '--jf-palette-background-default:var(--jp-bg);--jf-palette-background-paper:var(--jp-surface)'
    + ';--jf-palette-text-primary:var(--jp-text);--jf-palette-text-secondary:var(--jp-text-muted)'
    + ';--jf-palette-primary-main:var(--jp-accent);--jf-palette-secondary-main:var(--jp-accent)'
    + ';--jf-palette-primary-contrastText:var(--jp-on-accent);--jf-palette-error-main:var(--jp-error)'
    + ';--jf-palette-divider:var(--jp-border);--jf-palette-AppBar-defaultBg:var(--jp-surface)'
    + ';--jf-palette-AppBar-transparentBg:var(--jp-scrim)'
    + ';--jf-palette-action-hover:color-mix(in srgb,var(--jp-accent) 12%,transparent)'
    + ';--jf-palette-action-focus:color-mix(in srgb,var(--jp-accent) 24%,transparent)'
    + ';--jf-card-borderRadius:var(--jp-radius-m)';

var STRUCT = '--jp-radius-s:6px;--jp-radius-m:10px;--jp-radius-l:16px;--jp-radius-pill:999px'
    + ';--jp-space-1:4px;--jp-space-2:8px;--jp-space-3:12px;--jp-space-4:16px;--jp-space-5:20px;--jp-space-6:24px'
    + ';--jp-tap:44px;--jp-dur-fast:120ms;--jp-dur:200ms;--jp-dur-slow:320ms;--jp-ease:cubic-bezier(.2,.8,.2,1)'
    + ';--jp-safe-bottom:env(safe-area-inset-bottom,0px);--jp-nav-h:0px'
    + ';--jp-font-family:"Noto Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';

// Sizes, not families: --jp-font-body / -small / -title are font-size values.
function type(body, small, title) {
    return '--jp-font-body:' + body + 'px;--jp-font-small:' + small + 'px;--jp-font-title:' + title + 'px';
}

var TAP_TARGETS = [
    '.paper-icon-button-light', '.emby-tab-button', '.cardOverlayButton', '.btnSelectionPanelOptions',
    '.btnCloseSelectionPanel', '.detailButton'
].join(',');

export function themeCss() {
    var light = LIGHT_SEL.join(',');
    var coarse = 'html.jp-phone:not(.jp-theme-off):not(.layout-tv),html.jp-tablet:not(.jp-theme-off):not(.layout-tv)';
    var out = [];
    out.push(BASE + '{color-scheme:dark;' + STRUCT + ';' + scheme(DARK) + ';' + type(15, 13, 22) + ';' + MAP + '}');
    // Follow the OS only while the stock theme is not pinned (no data-theme yet / none set).
    out.push('@media (prefers-color-scheme:light){' + BASE + ':not([data-theme]){color-scheme:light;' + scheme(LIGHT) + '}}');
    out.push(light + '{color-scheme:light;' + scheme(LIGHT) + '}');
    out.push(BASE + '.jp-tablet{' + type(16, 14, 24) + '}');
    out.push(BASE + '.jp-desktop{' + type(15, 13, 22) + '}');
    // Stock shrinks the root to 93% then 90% on mobile (about 13.4px body); put it back at 100%.
    out.push('html.layout-mobile:not(.jp-theme-off){font-size:100%}');
    // Tap targets: touch tiers only, a mouse on a desktop window keeps stock sizes.
    out.push(coarse.split(',').map(function (s) {
        return s + ' :is(' + TAP_TARGETS + ')';
    }).join(',') + '{min-width:var(--jp-tap);min-height:var(--jp-tap)}');
    out.push(coarse.split(',').map(function (s) {
        return s + ' .listItem';
    }).join(',') + '{min-height:var(--jp-tap)}');
    // Loading skeletons: a placeholder row while a section is still empty. Only on elements the view
    // marks `.jpSkel` when they first appear, for at most SKELETON_MS (view/mobile-theme.js): a pure
    // `:empty` rule cannot tell "still loading" from "empty for good" and left a permanent grey band
    // under Continue Watching on Home.
    out.push(BASE + ' .jpSkel:empty:not(.hide){'
        + 'min-height:12em;border-radius:var(--jp-radius-m);'
        + 'background:linear-gradient(90deg,var(--jp-surface) 0,var(--jp-surface-2) 50%,var(--jp-surface) 100%) 0 0/200% 100%;'
        + 'animation:jpSkelShimmer calc(var(--jp-dur)*7) linear infinite}');
    out.push('@keyframes jpSkelShimmer{to{background-position:-200% 0}}');
    out.push('@media (prefers-reduced-motion:reduce){' + BASE + '{--jp-dur-fast:0ms;--jp-dur:0ms;--jp-dur-slow:0ms}'
        + BASE + ' .jpSkel:empty{animation:none}}');
    return out.join('\n');
}

// Drop user-scalable=no and maximum-scale from a viewport content string (pinch-zoom back on).
export function zoomableViewport(content) {
    return String(content || '').split(',').map(function (s) { return s.trim(); }).filter(function (s) {
        return s && !/^(user-scalable|maximum-scale)\s*=/i.test(s);
    }).join(',');
}
