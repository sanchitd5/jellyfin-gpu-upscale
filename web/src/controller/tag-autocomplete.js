import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';
import { fetchTagWindow, normalize } from './tag-window.js';
import { currentToken, withToken, planAdd, sortLikeEditor, pickSuggestions } from '../model/tag-input.js';

/*
 * TAG AUTOCOMPLETE AND COMMA-SEPARATED INPUT IN THE METADATA EDITOR (QOL_IDEAS #26).
 *
 * Stock (components/metadataEditor/metadataEditor.js addElementToList) adds a tag through a bare
 * prompt dialog ("Value:") and pushes whatever was typed as ONE tag, so a typo makes a near
 * duplicate and "a, b" becomes a single tag named "a, b". The editor's Save then reads the tag list
 * back from the DOM (getListValues over #listTags .textValue), which is what makes this safe to do
 * from outside: the list the viewer sees is the list that is saved.
 *
 * What it does, only for the prompt opened by the Tags section's "+" button:
 *  - SUGGESTIONS under the box for the tag being typed (the text after the last comma): names that
 *    contain it, prefix matches first, minus tags already in the list or already typed. They come
 *    from GET /Items/Filters with jpTagLimit and jpTagQuery through controller/tag-window.js, so a
 *    library with 12,000 tags costs a few KB per keystroke, never the whole list (against a server
 *    without the parameters tag-window.js narrows the full list itself, as it does everywhere).
 *    Answers are cached per typed text for the dialog's life and a late answer for older text is dropped.
 *  - COMMA SPLITTING. On submit the text is parsed by the bulk tag editor's own parseTags/mergeTags
 *    (trim, drop blanks, case-insensitive de-duplication, the stored spelling wins) and each new tag
 *    is added to the list as its own row, in the editor's own sort order, then the prompt is closed
 *    through its own Back button (the way Cancel does, so stock's .then never sees a half value).
 *    When every typed tag is already in the list the prompt stays open and says so.
 *
 * How the prompt is recognised: a capture-phase click on `.btnAddTextItem` inside #tagsCollapsible
 * arms a short-lived MutationObserver; the first dialog it sees that holds #txtInput (the prompt's
 * own input) while armed is the one. Genres and studios use the same prompt and are left to stock.
 *
 * Fail soft: if anything is missing - the list, the Back button, the input - nothing is attached or
 * intercepted and the stock prompt behaves exactly as before. A failed suggestion request only means
 * no suggestions. Not on TV layouts.
 */

var STYLE_ID = 'jellyfinPlusTagSuggestStyle';
var ARMED_MS = 15000;
var SUGGEST_MAX = 8;
var FETCH_LIMIT = 20;
var DEBOUNCE_MS = 180;

function isTv() {
    return document.documentElement.classList.contains('layout-tv');
}

function installStyle() {
    if (document.getElementById(STYLE_ID)) {
        return;
    }

    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
        '.jpTagSuggest { display: flex; flex-wrap: wrap; gap: 0.45em; margin: 0.6em 0 0; }',
        '.jpTagChip { box-sizing: border-box; max-width: 100%; min-height: 2.1em; padding: 0.2em 0.85em; margin: 0;'
            + ' border-radius: 999px; border: 1px solid rgba(128, 128, 128, 0.45); background: rgba(128, 128, 128, 0.16);'
            + ' color: inherit; font: inherit; font-size: 92%; overflow-wrap: anywhere; cursor: pointer; }',
        '.jpTagChip:hover, .jpTagChip:focus-visible { background: rgba(128, 128, 128, 0.32); outline: none; }',
        'html.layout-mobile .jpTagChip { min-height: 2.5em; padding: 0.35em 1em; }'
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
}

function listValues(list) {
    return Array.prototype.map.call(list.querySelectorAll('.textValue'), function (n) { return n.textContent; });
}

/* A new row for the list, copied from an existing one so it matches the editor's markup of the day. */
function newRow(list, text) {
    var proto = list.querySelector('.listItem');
    var row;
    if (proto) {
        row = proto.cloneNode(true);
    } else {
        var holder = document.createElement('div');
        holder.innerHTML = '<div class="listItem"><span class="material-icons listItemIcon live_tv" aria-hidden="true" style="background-color:#333;"></span>'
            + '<div class="listItemBody"><div class="textValue"></div></div>'
            + '<button type="button" is="paper-icon-button-light" class="btnRemoveFromEditorList autoSize"><span class="material-icons delete" aria-hidden="true"></span></button></div>';
        row = holder.firstChild;
    }

    row.querySelector('.textValue').textContent = text;
    return row;
}

/* Adds rows for `tags`, then puts the whole list in the editor's order. Existing rows are moved, not rebuilt. */
function addRows(list, tags) {
    var rows = Array.prototype.filter.call(list.children, function (n) { return n.classList.contains('listItem'); });
    tags.forEach(function (t) { rows.push(newRow(list, t)); });
    sortLikeEditor(rows, function (r) { return r.querySelector('.textValue').textContent; }).forEach(function (r, i) {
        var btn = r.querySelector('.btnRemoveFromEditorList');
        if (btn) {
            btn.setAttribute('data-index', String(i));
        }

        list.appendChild(r);
    });
}

function attach(dlg, input, list) {
    var cancel = dlg.querySelector('.btnCancel');
    var form = dlg.querySelector('form');
    var container = dlg.querySelector('.inputContainer');
    if (!cancel || !form || !container) {
        log('tag autocomplete: prompt has an unexpected shape; left to stock');
        return;
    }

    installStyle();

    var hint = dlg.querySelector('.fieldDescription');
    if (hint) {
        hint.classList.remove('hide');
        hint.textContent = 'Separate several tags with commas.';
    }

    var box = el('div', 'jpTagSuggest');
    container.parentNode.insertBefore(box, container.nextSibling);

    var cache = Object.create(null);
    var seq = 0;
    var timer = null;
    var warned = false;

    function lookup(token) {
        var key = normalize(token);
        if (cache[key]) {
            return Promise.resolve(cache[key]);
        }

        return fetchTagWindow({ query: token, limit: FETCH_LIMIT }).then(function (w) {
            cache[key] = w.tags;
            return w.tags;
        });
    }

    function render(names) {
        box.textContent = '';
        names.forEach(function (n) {
            var chip = el('button', 'jpTagChip', n);
            chip.type = 'button';
            chip.addEventListener('click', function () {
                input.value = withToken(input.value, n);
                input.focus();
                box.textContent = '';
            });
            box.appendChild(chip);
        });
    }

    function refresh() {
        var token = currentToken(input.value);
        if (!token) {
            seq++;
            box.textContent = '';
            return;
        }

        var mine = ++seq;
        lookup(token).then(function (names) {
            if (mine === seq && dlg.isConnected) {
                render(pickSuggestions(names, input.value, listValues(list), SUGGEST_MAX));
            }
        }, function (err) {
            if (!warned) {
                warned = true;
                log('tag autocomplete: suggestions unavailable', err);
            }
        });
    }

    input.addEventListener('input', function () {
        clearTimeout(timer);
        timer = setTimeout(refresh, DEBOUNCE_MS);
    });

    // Capture phase on the dialog: runs before the prompt's own submit handler on the form.
    dlg.addEventListener('submit', function (e) {
        try {
            if (!input.value.trim()) {
                return; // stock rejects an empty value itself
            }

            var plan = planAdd(input.value, listValues(list));
            e.preventDefault();
            e.stopImmediatePropagation();
            if (!plan.add.length) {
                if (hint) {
                    hint.textContent = plan.dupes.length ? 'Already in the list: ' + plan.dupes.join(', ') : 'Type a tag name.';
                }

                return;
            }

            addRows(list, plan.add);
            log('tag autocomplete: added ' + plan.add.length + (plan.dupes.length ? ' (' + plan.dupes.length + ' already there)' : ''));
            cancel.click();
        } catch (err) {
            log('tag autocomplete: submit failed', err);
        }
    }, true);

    log('tag autocomplete: attached to the tag prompt');
}

var armed = null;

function findPrompt(root) {
    if (root.nodeType !== 1) {
        return null;
    }

    return root.id === 'txtInput' ? root : (root.querySelector ? root.querySelector('#txtInput') : null);
}

function arm(list) {
    if (armed) {
        armed.stop();
    }

    var observer = new MutationObserver(function (records) {
        try {
            for (var i = 0; i < records.length; i++) {
                for (var j = 0; j < records[i].addedNodes.length; j++) {
                    var input = findPrompt(records[i].addedNodes[j]);
                    if (input) {
                        var dlg = input.closest('.dialog, dialog, .formDialog') || input.closest('form');
                        stop();
                        if (dlg) {
                            attach(dlg, input, list);
                        }

                        return;
                    }
                }
            }
        } catch (err) {
            log('tag autocomplete: attach failed', err);
            stop();
        }
    });
    var timeout = setTimeout(stop, ARMED_MS);

    function stop() {
        observer.disconnect();
        clearTimeout(timeout);
        if (armed && armed.stop === stop) {
            armed = null;
        }
    }

    armed = { stop: stop };
    observer.observe(document.body, { childList: true, subtree: true });
}

function onClick(e) {
    try {
        var t = e.target;
        var btn = t && t.closest && t.closest('.btnAddTextItem');
        var section = btn && btn.closest('#tagsCollapsible');
        var list = section && section.querySelector('#listTags');
        if (list && !isTv()) {
            arm(list);
        }
    } catch (err) {
        log('tag autocomplete: click handler failed', err);
    }
}

export function installTagAutocomplete() {
    if (!document.body) {
        document.addEventListener('DOMContentLoaded', installTagAutocomplete, { once: true });
        return;
    }

    try {
        document.addEventListener('click', onClick, true);
        log('tag autocomplete: installed');
    } catch (err) {
        log('tag autocomplete: install failed', err);
    }
}
