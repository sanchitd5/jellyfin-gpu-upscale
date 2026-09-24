import { state } from '../model/state.js';
import { DEFAULT_PREFS } from '../model/controls-data.js';
import { savePrefs } from '../model/prefs-store.js';
import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';
import { player } from './live-apply.js';
import { probeServer } from './probe.js';
import { fetchServerState } from './live-block.js';
import {
    closePanel, ensureStyle, renderPanel, panelEl, applyPanelPos, liveRows, FOCUSABLE, PANEL_ID
} from '../view/panel-dom.js';

export function hookPlaybackEvents() {
    try {
        var pm = player();
        if (!pm || state.playbackHooked) {
            return;
        }

        pm._callbacks = pm._callbacks || {};
        ['playbackstop', 'playbackerror'].forEach(function (name) {
            pm._callbacks[name] = pm._callbacks[name] || [];
            pm._callbacks[name].push(function () {
                try {
                    log('playback ended (' + name + '); closing the panel');
                    closePanel();
                } catch (err) { /* never take playback down with the panel */ }
            });
        });

        state.playbackHooked = true;
    } catch (err) {
        log('could not hook the playback events', err);
    }
}

/*
 * A NEW ITEM RESETS THE UPSCALE TARGET, AND ONLY THAT.
 *
 * The quality ladder is generated FOR THE SOURCE: its targets are filtered against this
 * source's height and the server's own limits. 4K picked on a 540p file is not a choice that
 * means anything on the next item, and can be outside the set this panel would even offer for
 * it. The stage goes back to Automatic with it, because a stage IS a target plus a recipe.
 *
 * Everything else stays exactly as the viewer left it: sr, deblur, denoise, neural, game,
 * refine, chroma, deband, kernel, jitter, depth and reactive are taste, not properties of the
 * source, and none of them is filtered by the source height. Widening this to them would
 * throw away a preference for no reason.
 *
 * Done here, on the PlaybackInfo for a source this script has not seen, rather than on a
 * playback event: this runs BEFORE the parameters are written onto the TranscodingUrl, so the
 * new item is negotiated with the reset value instead of one item's worth of the old one.
 * (This reverses session 12, where a stage followed the viewer from item to item.)
 */
export function resetUpscaleForNewSource(info) {
    try {
        var sources = info && info.MediaSources;
        var id = sources && sources.length ? sources[0].Id : null;
        if (!id || id === state.lastSourceId) {
            return;
        }

        state.lastSourceId = id;
        if (state.stage === 'unset' && state.prefs.upscale === DEFAULT_PREFS.upscale) {
            return;
        }

        log('new item: the upscale target goes back to Automatic');
        state.stage = 'unset';
        state.prefs.upscale = DEFAULT_PREFS.upscale;
        savePrefs();
    } catch (err) {
        log('could not reset the upscale target', err);
    }
}

/*
 * Opening re-probes rather than trusting a cached answer, so a panel opened after a server
 * restart recovers the full control set instead of being stuck on the upscale target. The
 * session record is fetched alongside it, because it is the only honest source for what
 * actually ran, and it keeps being fetched while the panel is open so the live block follows
 * playback instead of freezing at the moment it was opened.
 */
export function openEnhancePanel() {
    state.menuShown++;
    hookPlaybackEvents();
    return probeServer().then(function (caps) {
        return fetchServerState().then(function () { return caps; },
            function () { return caps; });
    }).then(function (caps) {
        try {
            caps = caps || { full: false, failed: true };
            closePanel();
            // After closePanel, which restores and clears it: whatever opened this gets the
            // focus back when it closes, so a keyboard or a remote is not dropped at the top
            // of the page.
            state.panelOpener = document.activeElement;
            ensureStyle();
            var panel = el('div');
            panel.id = PANEL_ID;
            panel.setAttribute('role', 'dialog');
            panel.setAttribute('aria-label', 'Enhance');
            // The player binds the wheel to volume, and this panel sits over the player, so
            // scrolling its own list was turning the sound up and down. The panel scrolls
            // itself (max-height plus overflow-y), so a wheel inside it is never the player's
            // business. Same for touch, where the gesture would otherwise reach the player's
            // own handlers. Not passive: stopping propagation is the entire point, and a
            // passive listener cannot preventDefault at the edges either.
            var eatScroll = function (ev) { ev.stopPropagation(); };
            panel.addEventListener('wheel', eatScroll, { passive: false });
            panel.addEventListener('touchmove', eatScroll, { passive: false });

            (document.body || document.documentElement).appendChild(panel);
            renderPanel(panel, caps);

            // A dialog nobody is focused inside is a dialog a screen reader never enters.
            try {
                var firstControl = panel.querySelector(FOCUSABLE);
                if (firstControl) { firstControl.focus(); }
            } catch (e) { /* focus is never worth breaking the panel for */ }

            // The panel opens over the video and calls itself a dialog, so Tab must not walk out
            // of it into the page behind, which is still there and still focusable. Nothing is
            // made focusable that was not already: the same list the render uses to carry focus
            // across a repaint is the one the tab order wraps around.
            state.panelKeyHandler = function (ev) {
                if (ev.key === 'Escape' || ev.keyCode === 27) {
                    closePanel();
                    return;
                }

                if (ev.key !== 'Tab' && ev.keyCode !== 9) {
                    return;
                }

                var p = panelEl();
                var items = p ? p.querySelectorAll(FOCUSABLE) : null;
                if (!items || !items.length) {
                    return;
                }

                var first = items[0];
                var last = items[items.length - 1];
                if (!p.contains(document.activeElement)) {
                    ev.preventDefault();
                    first.focus();
                } else if (ev.shiftKey && document.activeElement === first) {
                    ev.preventDefault();
                    last.focus();
                } else if (!ev.shiftKey && document.activeElement === last) {
                    ev.preventDefault();
                    first.focus();
                }
            };
            document.addEventListener('keydown', state.panelKeyHandler, true);

            state.onPanelResize = function () { applyPanelPos(); };
            window.addEventListener('resize', state.onPanelResize);

            state.liveTimer = setInterval(function () {
                try {
                    // Never re-render out from under a drag or an open dropdown.
                    if (state.drag) { return; }
                    var a = document.activeElement;
                    if (a && a.tagName === 'SELECT' && panel.contains(a)) { return; }
                    fetchServerState().then(function () {
                        var p = document.getElementById(PANEL_ID);
                        if (p) { renderPanel(p, caps); }
                    }, function () { /* keep the last answer */ });
                } catch (e) { /* ignore */ }
            }, 3000);
            return null;
        } catch (err) {
            // The panel is never allowed to take playback or the stock menus with it.
            log('panel failed to open', err);
            closePanel();
            return null;
        }
    }, function () { return null; });
}

/*
 * Adds the record of what ran to the playback info dialog. Done by watching the DOM for the
 * dialog rather than hooking the module that builds it: the rows are appended to the list the
 * dialog already renders, and a shape that is not recognised is left alone entirely.
 */
export function watchPlaybackInfoDialog() {
    try {
        var observer = new MutationObserver(function (records) {
            records.forEach(function (record) {
                Array.prototype.forEach.call(record.addedNodes || [], function (node) {
                    if (!node || node.nodeType !== 1 || !node.querySelectorAll) {
                        return;
                    }

                    // The stats overlay is named, and it is not a dialog: watching only
                    // dialogs meant the container we were told to write into never arrived.
                    var SEL = '.dialog, [is="emby-dialog"], .actionSheet, .playerStats, .playerStats-stats';
                    var hosts = node.matches && node.matches(SEL)
                        ? [node] : Array.prototype.slice.call(node.querySelectorAll(SEL));
                    hosts.forEach(maybeAnnotate);
                });
            });
        });
        observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch (err) {
        log('dialog observer failed', err);
    }
}

/*
 * FINDING THE PLAYBACK INFO DIALOG BY ITS SHAPE.
 *
 * Matching its textContent against /Playback Info|Play method|Player:/ matched ANY dialog
 * quoting those words - an error message naming the play method, a subtitle sheet listing a
 * player - and this script then appended a media filename and a filter chain to it. So the
 * dialog is recognised the way the action sheet already is: by structure.
 *
 * Jellyfin's Playback Info is a list of LABEL/VALUE ROWS. A candidate row is an element with
 * exactly two element children whose first child reads as one of the field names that dialog
 * is made of; two or more of those in one container is the dialog and nothing else is. Their
 * shared parent is the host, and their own class names are borrowed for the rows added below,
 * so the addition looks like the dialog rather than like a patch on it.
 *
 * Recognising nothing means annotating nothing. A missing row is a smaller failure than a row
 * about the wrong thing in the wrong dialog.
 */
var STATS_FIELDS = [
    'play method', 'player', 'protocol', 'stream type', 'player dimensions',
    'video codec', 'audio codec', 'video bitrate', 'audio bitrate', 'transcoding',
    'transcode reason', 'transcode reasons', 'container', 'size', 'bitrate'
];

function statsFieldName(row) {
    var first = row.children[0];
    var text = first ? String(first.textContent || '') : '';
    return text.replace(/[:\s]+$/, '').trim().toLowerCase();
}

function playbackInfoHost(dialog) {
    // Jellyfin's own stats overlay names its container, so use the name it gives rather than
    // inferring one: everything belongs inside playerStats-stats, beside the rest of the
    // numbers a viewer opened that overlay to read. The shape search below stays as the
    // fallback for anything that does not carry the class, since a renamed class is exactly
    // the kind of thing a web update changes and a shape survives.
    var named = dialog.querySelector
        ? (dialog.querySelector('.playerStats-stats') || dialog.querySelector('.playerStats'))
        : null;
    var scope = named || dialog;

    var rows = Array.prototype.filter.call(
        scope.querySelectorAll('div,li,tr,p'),
        function (r) {
            return r.children.length === 2 && STATS_FIELDS.indexOf(statsFieldName(r)) >= 0;
        });

    // A named container with no recognisable rows yet is still the right host: the overlay
    // builds itself as playback starts, and refusing it would mean never annotating the very
    // container we were told to use.
    if (rows.length < 2) {
        return named
            ? { host: named, rowClass: '', labelClass: '', valueClass: '',
                labelTag: 'div', valueTag: 'div', rowTag: 'div' }
            : null;
    }

    // The container the rows themselves live in, not the dialog shell: appending beside them
    // is what puts the addition in the same column and the same rhythm as the rest.
    var parent = rows[0].parentNode;
    var together = rows.filter(function (r) { return r.parentNode === parent; });
    if (together.length < 2 || !parent) {
        return null;
    }

    var sample = together[0];
    return {
        host: parent,
        rowClass: sample.className || '',
        labelClass: (sample.children[0] && sample.children[0].className) || '',
        valueClass: (sample.children[1] && sample.children[1].className) || '',
        labelTag: (sample.children[0].tagName || 'div').toLowerCase(),
        valueTag: (sample.children[1].tagName || 'div').toLowerCase(),
        rowTag: (sample.tagName || 'div').toLowerCase()
    };
}

function maybeAnnotate(dialog) {
    try {
        if (!dialog || dialog.__gpuUpscaleAnnotated) {
            return;
        }

        var shape = playbackInfoHost(dialog);
        if (!shape) {
            return;
        }

        dialog.__gpuUpscaleAnnotated = true;
        fetchServerState().then(function (s) {
            try {
                if (!s) {
                    return;
                }

                // The same rows the panel shows, from the SESSION RECORD: the sizes, the
                // passes that ran, the ones asked for that did not, the bypass and why, the
                // kernel, the encoder and its reason, and the server's own summary. Nothing
                // here reads what the panel asked for.
                //
                // The stale-selection line is the one row that is about the panel rather than
                // about the stream, and it says "the selections above", which is meaningless
                // in a dialog that has none. It stays in the panel.
                var rows = liveRows(function (label, value) {
                    var row = el(shape.rowTag, shape.rowClass);
                    // textContent throughout: the record carries a media filename, and this
                    // is a dialog built by somebody else.
                    row.appendChild(el(shape.labelTag, shape.labelClass, 'Enhance - ' + label));
                    row.appendChild(el(shape.valueTag, shape.valueClass, value));
                    return row;
                }, ['Not this selection']);

                rows.forEach(function (row) { shape.host.appendChild(row); });
                log('annotated playback info with', rows.length, 'rows');
            } catch (err) {
                log('annotate failed', err);
            }
        });
    } catch (err) {
        log('annotate check failed', err);
    }
}
