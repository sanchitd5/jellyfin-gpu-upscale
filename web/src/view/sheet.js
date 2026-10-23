import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';

/*
 * THE SHARED SHEET. One modal shell for everything that wants "a sheet": the search page's
 * Sort & filter (view/search-filter-sheet.js), the Enhance panel on a phone (view/panel-dom.js),
 * and whatever the redesign adds (Libraries, More, card actions).
 *
 *   openSheet({ title, content, footer, onClose, tiers, opener, flush, label }) -> { el, body, close }
 *   closeSheet()
 *
 *   title    heading text in the header (also the dialog's aria-label unless `label` is given)
 *   content  a Node put in the scrolling body
 *   footer   optional Node or Node[] in a fixed footer (safe-area padded)
 *   onClose  called once, after the sheet is gone, however it closed: backdrop, close button,
 *            Escape, the browser's Back, a swipe down, or closeSheet(). Receives the reason string.
 *   tiers    tiers that get a BOTTOM SHEET; every other tier gets a centred dialog.
 *            Default ['phone']. Tiers are the contract's classes on <html> (jp-phone < 600 px,
 *            jp-tablet 600-1023, jp-desktop >= 1024); when none is set (the theme module has not
 *            run, or is off) the same widths are measured here.
 *   opener   element to hand the focus back to on close
 *   flush    true: no padding around the body, the content lays itself out
 *
 * One sheet at a time: opening a second closes the first. While open <html> carries
 * `jp-sheet-open`. Closed by Escape, the backdrop, the close button, Back (a history entry is
 * pushed and popped) and, as a bottom sheet, a swipe down on the grip or the header. Focus is
 * trapped inside. Motion runs through the --jp-dur tokens, which the theme zeroes under
 * prefers-reduced-motion; the media query below does the same when the theme is not present.
 *
 * Styled with the --jp-* tokens, each with a stock-equivalent fallback, so it looks right
 * whether or not the theme is on. Nothing here is skipped on a TV layout: callers that must not
 * run there already do not call it.
 */

var STYLE_ID = 'jellyfinPlusSheetStyle';
var OPEN_CLASS = 'jp-sheet-open';
var SWIPE_CLOSE_PX = 96;
var SWIPE_FLING_PX_MS = 0.6;
var LINE = 'var(--jp-border, var(--jf-palette-divider, rgba(128,128,128,0.4)))';

var CSS = [
    '.jp-sheet-backdrop { position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 99990; display: flex;'
        + ' align-items: center; justify-content: center; background: rgba(0,0,0,0.6); touch-action: none;'
        + ' animation: jp-sheet-fade var(--jp-dur, 0.15s) var(--jp-ease, ease-out); }',
    '.jp-sheet-backdrop.jp-sheet-bottom { align-items: flex-end; }',
    '.jp-sheet { display: flex; flex-direction: column; box-sizing: border-box; outline: none; touch-action: auto;'
        + ' width: min(580px, 92vw); max-height: 85vh; max-height: 85dvh;'
        + ' border-radius: var(--jp-radius-l, 12px);'
        + ' background: var(--jp-surface, var(--jf-palette-background-paper, #202020));'
        + ' color: var(--jp-text, var(--jf-palette-text-primary, #fff));'
        + ' box-shadow: var(--jp-elev-2, 0 8px 32px rgba(0,0,0,0.5));'
        + ' animation: jp-sheet-fade var(--jp-dur, 0.15s) var(--jp-ease, ease-out); }',
    '.jp-sheet-bottom .jp-sheet { width: 100%; max-height: 92vh; max-height: 92dvh;'
        + ' border-radius: var(--jp-radius-l, 16px) var(--jp-radius-l, 16px) 0 0;'
        + ' box-shadow: var(--jp-elev-2, 0 -4px 24px rgba(0,0,0,0.45));'
        + ' animation: jp-sheet-rise var(--jp-dur, 0.2s) var(--jp-ease, ease-out); }',
    '.jp-sheet.jp-sheet-dragging { transition: none; animation: none; }',
    '.jp-sheet.jp-sheet-settling { transition: transform var(--jp-dur, 0.2s) var(--jp-ease, ease-out); }',
    '@keyframes jp-sheet-fade { from { opacity: 0; } to { opacity: 1; } }',
    '@keyframes jp-sheet-rise { from { transform: translateY(40px); opacity: 0.6; } to { transform: none; opacity: 1; } }',
    '@media (prefers-reduced-motion: reduce) { .jp-sheet-backdrop, .jp-sheet { animation: none; }'
        + ' .jp-sheet.jp-sheet-settling { transition: none; } }',
    '.jp-sheet-top { flex: none; touch-action: none; -webkit-user-select: none; user-select: none; }',
    '.jp-sheet-grip { display: none; width: 40px; height: 4px; margin: 8px auto 0; border-radius: 2px;'
        + ' background: var(--jp-text-muted, rgba(128,128,128,0.7)); }',
    '.jp-sheet-bottom .jp-sheet-grip { display: block; }',
    '.jp-sheet-head { display: flex; align-items: center; justify-content: space-between;'
        + ' padding: 0.3em 0.4em 0.3em 1.1em; border-bottom: 1px solid ' + LINE + '; }',
    '.jp-sheet-head h2 { margin: 0; font-size: 1.15em; font-weight: 600; }',
    '.jp-sheet-x { flex: none; min-width: var(--jp-tap, 44px); min-height: var(--jp-tap, 44px); padding: 0; border: 0;'
        + ' background: none; color: inherit; font: inherit; font-size: 1.2em; cursor: pointer; opacity: 0.8;'
        + ' border-radius: 22px; }',
    '.jp-sheet-x:focus-visible { outline: 2px solid var(--jp-accent, var(--jf-palette-primary-main, #00a4dc)); outline-offset: 1px; }',
    '.jp-sheet-body { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;'
        + ' padding: 0.3em 1.1em 1em; }',
    '.jp-sheet-body.jp-sheet-flush { padding: 0; }',
    '.jp-sheet-foot { display: flex; gap: 0.7em; flex: none; padding: 0.7em 1.1em;'
        + ' padding-bottom: calc(0.7em + var(--jp-safe-bottom, env(safe-area-inset-bottom, 0px)));'
        + ' border-top: 1px solid ' + LINE + '; }',
    '.jp-sheet-foot > button { flex: 1; min-height: 46px; margin: 0; border-radius: 23px; font: inherit;'
        + ' font-weight: 600; cursor: pointer; }'
].join('\n');

var current = null;

/* ---- tier ---- */

export function sheetTier() {
    var cl = document.documentElement.classList;
    if (cl.contains('jp-phone')) { return 'phone'; }
    if (cl.contains('jp-tablet')) { return 'tablet'; }
    if (cl.contains('jp-desktop')) { return 'desktop'; }
    var w = window.innerWidth || 1024;
    return w < 600 ? 'phone' : (w < 1024 ? 'tablet' : 'desktop');
}

/*
 * A phone held sideways is 800+ px wide but only ~400 px tall: a centred dialog is cramped there
 * and a bottom sheet capped at 92 dvh is the right shape. Tablets are never this short, so
 * `layout-mobile` plus a short viewport picks out exactly the landscape phone.
 */
function isLandscapePhone() {
    return document.documentElement.classList.contains('layout-mobile') && (window.innerHeight || 1000) < 500;
}

export function isBottomSheet(tiers) {
    return (tiers || ['phone']).indexOf(sheetTier()) !== -1 || isLandscapePhone();
}

function ensureStyle() {
    if (!document.getElementById(STYLE_ID)) {
        var style = el('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);
    }
}

/* ---- swipe down: only from the grip and header, so the body keeps its own scrolling ---- */

function attachSwipe(top, dialog, backdrop, request) {
    var drag = null;

    top.addEventListener('pointerdown', function (e) {
        if (!backdrop.classList.contains('jp-sheet-bottom') || (e.target.closest && e.target.closest('button'))
            || (e.pointerType === 'mouse' && e.button !== 0)) {
            return;
        }

        drag = { id: e.pointerId, y: e.clientY, t: Date.now(), dy: 0 };
        try { top.setPointerCapture(e.pointerId); } catch (err) { /* the move events still reach the target */ }
        dialog.classList.remove('jp-sheet-settling');
        dialog.classList.add('jp-sheet-dragging');
    });
    top.addEventListener('pointermove', function (e) {
        if (!drag || e.pointerId !== drag.id) {
            return;
        }

        drag.dy = Math.max(0, e.clientY - drag.y);
        dialog.style.transform = 'translateY(' + drag.dy + 'px)';
    });
    var end = function (e) {
        if (!drag || e.pointerId !== drag.id) {
            return;
        }

        var d = drag;
        drag = null;
        dialog.classList.remove('jp-sheet-dragging');
        var fling = d.dy / Math.max(1, Date.now() - d.t) > SWIPE_FLING_PX_MS && d.dy > 24;
        if (e.type !== 'pointercancel' && (d.dy > SWIPE_CLOSE_PX || fling)) {
            request('swipe');
        } else {
            dialog.classList.add('jp-sheet-settling');
            dialog.style.transform = '';
        }
    };
    top.addEventListener('pointerup', end);
    top.addEventListener('pointercancel', end);
}

/* ---- open / close ---- */

export function openSheet(opts) {
    opts = opts || {};
    if (current) {
        closeSheet('replaced', true);
    }

    ensureStyle();
    var tiers = opts.tiers;
    var backdrop = el('div', 'jp-sheet-backdrop');
    var dialog = el('div', 'jp-sheet');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', opts.label || opts.title || 'Sheet');
    dialog.tabIndex = -1;

    var top = el('div', 'jp-sheet-top');
    top.appendChild(el('div', 'jp-sheet-grip'));
    var head = el('div', 'jp-sheet-head');
    head.appendChild(el('h2', null, opts.title || ''));
    var closeBtn = el('button', 'jp-sheet-x', '✕');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    head.appendChild(closeBtn);
    top.appendChild(head);

    var body = el('div', 'jp-sheet-body' + (opts.flush ? ' jp-sheet-flush' : ''));
    if (opts.content) {
        body.appendChild(opts.content);
    }

    dialog.appendChild(top);
    dialog.appendChild(body);
    if (opts.footer) {
        var foot = el('div', 'jp-sheet-foot');
        [].concat(opts.footer).forEach(function (n) { foot.appendChild(n); });
        dialog.appendChild(foot);
    }

    backdrop.appendChild(dialog);

    var applyPresentation = function () {
        backdrop.classList.toggle('jp-sheet-bottom', isBottomSheet(tiers));
    };
    applyPresentation();

    var s = {
        backdrop: backdrop,
        opener: opts.opener,
        onClose: opts.onClose,
        pushed: false,
        onKey: function (e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeSheet('escape');
            } else if (e.key === 'Tab') {
                var focusable = Array.prototype.filter.call(
                    dialog.querySelectorAll('button, input, select, summary, [tabindex]:not([tabindex="-1"])'),
                    function (n) { return !n.disabled && n.offsetParent !== null; });
                if (focusable.length) {
                    var first = focusable[0];
                    var last = focusable[focusable.length - 1];
                    if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
                        e.preventDefault();
                        last.focus();
                    } else if (!e.shiftKey && document.activeElement === last) {
                        e.preventDefault();
                        first.focus();
                    }
                }
            }
        },
        onPop: function () { closeSheet('back', true); },
        onResize: applyPresentation
    };
    current = s;

    backdrop.addEventListener('click', function (e) {
        if (e.target === backdrop) {
            closeSheet('backdrop');
        }
    });
    closeBtn.addEventListener('click', function () { closeSheet('button'); });
    attachSwipe(top, dialog, backdrop, function (why) { closeSheet(why); });

    document.addEventListener('keydown', s.onKey, true);
    window.addEventListener('popstate', s.onPop);
    window.addEventListener('resize', s.onResize);
    try {
        window.history.pushState({ jpSheet: true }, '');
        s.pushed = true;
    } catch (err) { /* no history entry: Back leaves the page instead of closing the sheet */ }

    document.body.appendChild(backdrop);
    document.documentElement.classList.add(OPEN_CLASS);
    dialog.focus();
    log('sheet opened', opts.title);
    return { el: dialog, body: body, close: function () { closeSheet('api'); } };
}

export function closeSheet(reason, fromPop) {
    if (!current) {
        return;
    }

    var s = current;
    current = null;
    document.removeEventListener('keydown', s.onKey, true);
    window.removeEventListener('popstate', s.onPop);
    window.removeEventListener('resize', s.onResize);
    if (s.backdrop.parentNode) {
        s.backdrop.parentNode.removeChild(s.backdrop);
    }

    document.documentElement.classList.remove(OPEN_CLASS);

    // Our own history entry is still on top unless Back already took it.
    if (!fromPop && s.pushed) {
        try {
            if (window.history.state && window.history.state.jpSheet) {
                window.history.back();
            }
        } catch (err) { /* nothing to pop */ }
    }

    try {
        if (s.opener && document.contains(s.opener)) {
            s.opener.focus();
        }
    } catch (err) { /* focus is a courtesy */ }

    log('sheet closed', reason);
    if (typeof s.onClose === 'function') {
        try {
            s.onClose(reason || 'api');
        } catch (err) {
            log('sheet onClose failed', err);
        }
    }
}

export function sheetIsOpen() {
    return !!current;
}
