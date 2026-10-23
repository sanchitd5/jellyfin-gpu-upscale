import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';

/*
 * AN EXPLICIT "SELECT" ENTRY, AND A SELECTION MODE YOU CAN SEE (docs/roadmap/mobile-redesign.md P8).
 *
 * Stock multi-select (components/multiSelect/multiSelect.js) has one way in: a 550 ms press-and-hold
 * on a card. That is undiscoverable and fights scroll-start. This adds:
 *
 *  1. enterSelectMode(): arms a one-shot "tap a card" state with a visible hint bar. The first card
 *     tapped is NOT opened; instead the stock long-press path is run on it, so the stock module still
 *     owns the selection (its checkboxes, its count, its command menu, bulk tags and select-all all keep
 *     working unchanged). The stock path is reached the way the stock module itself listens:
 *       a. a `contextmenu` event on the card (what it binds on touch devices that are not Safari), then
 *       b. if no selection bar appeared, a `mousedown` held past its 550 ms timer and released (what it
 *          binds everywhere else, Safari and desktop included).
 *     A real touch sequence is not synthesised: the stock module registers the mouse listeners in every
 *     branch where it does not use `contextmenu`, so (b) reaches the same timer callback without Touch
 *     objects, which browsers construct inconsistently.
 *     If neither stage produces a selection bar the entry says "Press and hold a card" (the stock hint)
 *     and leaves the page as it was.
 *  2. A "Select" button on the library toolbar (found by shape: the MUI toolbar of a library page) and a
 *     `jellyfinplus:select` window event / enterSelectMode() export the More sheet calls.
 *  3. html.jp-selecting while a selection bar exists, which the CSS below uses to move the bar to the
 *     bottom (a sheet header: thumb zone, safe-area aware), outline ticked cards and label the count.
 *
 * Everything fails soft: with no cards on the page the entry says so; with the theme off
 * (html.jp-theme-off) the stock top bar is left alone, the entry still works.
 */

var STYLE_ID = 'jellyfinPlusSelectModeStyle';
var HTML_SELECTING = 'jp-selecting';
var HTML_ARMED = 'jp-select-armed';
var BTN_CLASS = 'jpSelectBtn';
var HINT_CLASS = 'jpSelectHint';

var CSS = [
    // The command bar becomes a bottom sheet header.
    'html.' + HTML_SELECTING + ':not(.jp-theme-off) .selectionCommandsPanel {',
    '  top: auto; bottom: 0; padding: 0.4em 0.5em calc(0.4em + var(--jp-safe-bottom, env(safe-area-inset-bottom, 0px)));',
    '  background: var(--jp-surface, #202020); color: var(--jp-text, #eee);',
    '  border-top: 1px solid var(--jp-border, rgba(255,255,255,0.14));',
    '  border-radius: var(--jp-radius-l, 16px) var(--jp-radius-l, 16px) 0 0;',
    '  box-shadow: var(--jp-elev-2, 0 -4px 18px rgba(0,0,0,0.5)); }',
    'html.' + HTML_SELECTING + ':not(.jp-theme-off) .selectionCommandsPanel button {',
    '  min-width: var(--jp-tap, 44px); min-height: var(--jp-tap, 44px); }',
    'html.' + HTML_SELECTING + ' .itemSelectionCount { font-size: 1.15em; padding: 0 0.4em; }',
    'html.' + HTML_SELECTING + ' .itemSelectionCount::after { content: " selected"; font-weight: normal; opacity: 0.75; }',
    // The select-all banner sits above the bar now, not below it.
    'html.' + HTML_SELECTING + ':not(.jp-theme-off) .selectionCommandsPanel .jpSelAll {',
    '  top: auto; bottom: 100%; margin-top: 0; margin-bottom: 0.5em; }',
    // The page can scroll clear of the bar.
    'html.' + HTML_SELECTING + ':not(.jp-theme-off) body { padding-bottom: calc(4.5em + var(--jp-safe-bottom, env(safe-area-inset-bottom, 0px))); }',
    // Ticked cards read as ticked at a glance.
    'html.' + HTML_SELECTING + ' .itemSelectionPanel:has(.chkItemSelect:checked) {',
    '  box-shadow: inset 0 0 0 3px var(--jp-accent, var(--theme-primary-color, #00a4dc)); background-color: rgba(0,0,0,0.12); }',
    // The armed hint.
    '.' + HINT_CLASS + ' { position: fixed; left: 0.5em; right: 0.5em; z-index: 99999; box-sizing: border-box;',
    '  bottom: calc(0.5em + var(--jp-nav-h, 0px) + var(--jp-safe-bottom, env(safe-area-inset-bottom, 0px)));',
    '  display: flex; align-items: center; gap: 0.6em; padding: 0.5em 0.5em 0.5em 1em; max-width: 30em; margin: 0 auto;',
    '  border-radius: var(--jp-radius-m, 12px); background: var(--jp-surface-2, #2a2a2a); color: var(--jp-text, #eee);',
    '  border: 1px solid var(--jp-accent, #00a4dc); box-shadow: var(--jp-elev-2, 0 4px 18px rgba(0,0,0,0.5)); }',
    '.' + HINT_CLASS + ' span { flex: 1; min-width: 0; }',
    '.' + HINT_CLASS + ' button, .' + BTN_CLASS + ' { min-width: var(--jp-tap, 44px); min-height: var(--jp-tap, 44px);',
    '  padding: 0 1em; border: 0; border-radius: var(--jp-radius-s, 8px); background: var(--jp-surface, #3a3a3a);',
    '  color: inherit; font: inherit; cursor: pointer; }',
    '.' + BTN_CLASS + ' { display: inline-flex; align-items: center; gap: 0.4em; margin-left: 0.5em; background: transparent; }',
    '.' + BTN_CLASS + ' .material-icons { font-size: 1.3em; }',
    'html.' + HTML_ARMED + ' .card { cursor: pointer; }',
    'html.' + HTML_ARMED + ' .card .cardBox { outline: 1px dashed var(--jp-accent, #00a4dc); outline-offset: -2px; }'
].join('\n');

var armed = null; // { hint, onClick, onKey, onHash } while waiting for the first tap

function root() {
    return document.documentElement;
}

function selectionBar() {
    return document.querySelector('.selectionCommandsPanel');
}

/* Cards stock multi-select can select: the ones it gives a checkbox (a card with a data-id). */
export function selectableCards() {
    return document.querySelectorAll('.card[data-id], [data-id] .card');
}

function toast(text) {
    var t = el('div', HINT_CLASS, '');
    t.setAttribute('role', 'status');
    t.appendChild(el('span', '', text));
    document.body.appendChild(t);
    setTimeout(function () {
        if (t.parentNode) { t.parentNode.removeChild(t); }
    }, 3500);
}

function disarm() {
    if (!armed) { return; }
    document.removeEventListener('click', armed.onClick, true);
    document.removeEventListener('keydown', armed.onKey, true);
    window.removeEventListener('hashchange', armed.onHash);
    if (armed.hint.parentNode) { armed.hint.parentNode.removeChild(armed.hint); }
    root().classList.remove(HTML_ARMED);
    armed = null;
}

function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/* Resolves true once the stock selection bar exists, polling for at most `ms`. */
function barAppears(ms) {
    var until = Date.now() + ms;
    return new Promise(function (resolve) {
        (function poll() {
            if (selectionBar()) { return resolve(true); }
            if (Date.now() >= until) { return resolve(false); }
            setTimeout(poll, 30);
        }());
    });
}

function mouseEvent(type, card, x, y) {
    return new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 });
}

/* Runs the stock long-press path on `card`. Resolves true when the stock selection bar came up. */
export function pressAndHold(card) {
    var r = card.getBoundingClientRect();
    var x = Math.round(r.left + r.width / 2);
    var y = Math.round(r.top + r.height / 2);

    card.dispatchEvent(mouseEvent('contextmenu', card, x, y));
    return barAppears(250).then(function (ok) {
        if (ok) { return true; }
        // Stock timer is 550 ms; hold a little longer, then release like a finger lifting.
        card.dispatchEvent(mouseEvent('mousedown', card, x, y));
        return wait(620).then(function () {
            card.dispatchEvent(mouseEvent('mouseup', card, x, y));
            return barAppears(300);
        });
    });
}

function startFrom(card) {
    disarm();
    pressAndHold(card).then(function (ok) {
        if (!ok) {
            log('select mode: stock selection did not start');
            toast('Press and hold a card to select it.');
            return;
        }
        // The stock first-tick quirk swallows the first real tap on the card; our tap is already spent.
        var chk = card.querySelector('.chkItemSelect.checkedInitial');
        if (chk) { chk.classList.remove('checkedInitial'); }
        log('select mode: started from card');
    }).catch(function (err) {
        log('select mode: failed', err);
        toast('Press and hold a card to select it.');
    });
}

/* Arms the entry: the next card tapped starts selection. No-op when selecting already. */
export function enterSelectMode() {
    try {
        if (selectionBar() || armed) { return false; }
        if (!selectableCards().length) {
            toast('Nothing to select on this page.');
            return false;
        }

        var hint = el('div', HINT_CLASS, '');
        hint.setAttribute('role', 'status');
        hint.appendChild(el('span', '', 'Tap a card to start selecting'));
        var cancel = el('button', '', 'Cancel');
        cancel.type = 'button';
        cancel.addEventListener('click', function (e) { e.stopPropagation(); disarm(); });
        hint.appendChild(cancel);
        document.body.appendChild(hint);
        root().classList.add(HTML_ARMED);

        armed = {
            hint: hint,
            onClick: function (e) {
                var t = e.target;
                if (!t || !t.closest || t.closest('.' + HINT_CLASS)) { return; }
                var card = t.closest('.card[data-id]') || t.closest('.card');
                if (!card) { return; }
                // The tap picks the first card; it must not also open it.
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                startFrom(card);
            },
            onKey: function (e) {
                if (e.key === 'Escape') { disarm(); }
            },
            onHash: disarm
        };
        document.addEventListener('click', armed.onClick, true);
        document.addEventListener('keydown', armed.onKey, true);
        window.addEventListener('hashchange', armed.onHash);
        return true;
    } catch (err) {
        log('select mode: could not arm', err);
        return false;
    }
}

/* ---- the library toolbar entry ---- */

function addToolbarButton() {
    var bar = document.querySelector('.MuiToolbar-root');
    if (!bar || bar.querySelector('.' + BTN_CLASS) || !selectableCards().length) { return; }
    // The row of sort/filter buttons is the last button group in the toolbar's stack.
    var groups = bar.querySelectorAll('.MuiButtonGroup-root');
    var last = groups.length ? groups[groups.length - 1] : null;
    if (!last || !last.parentNode) { return; }

    var btn = el('button', BTN_CLASS, '');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Select items');
    btn.appendChild(el('span', 'material-icons', 'checklist'));
    btn.appendChild(el('span', '', 'Select'));
    btn.addEventListener('click', enterSelectMode);
    last.parentNode.insertBefore(btn, last.nextSibling);
}

export function installSelectMode() {
    try {
        if (!document.getElementById(STYLE_ID)) {
            var style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = CSS;
            (document.head || document.documentElement).appendChild(style);
        }

        window.addEventListener('jellyfinplus:select', enterSelectMode);

        var pending = false;
        function syncButton() {
            pending = false;
            try {
                if (!selectionBar()) { addToolbarButton(); }
            } catch (err) {
                log('select mode: toolbar entry failed', err);
            }
        }

        // The class follows the bar at once (no frame with the bar still at the top); the toolbar
        // entry is debounced because React re-renders the toolbar in bursts.
        new MutationObserver(function () {
            try {
                var on = !!selectionBar();
                if (root().classList.contains(HTML_SELECTING) !== on) { root().classList.toggle(HTML_SELECTING, on); }
            } catch (err) { /* cosmetic */ }
            if (!pending) {
                pending = true;
                setTimeout(syncButton, 150);
            }
        }).observe(document.body || document.documentElement, { childList: true, subtree: true });
        log('select mode installed');
    } catch (err) {
        log('select mode install failed', err);
    }
}
