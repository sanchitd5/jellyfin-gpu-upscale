import { log } from '../lib/log.js';
import { showTagDialog } from '../view/bulk-tags-dialog.js';

/*
 * BULK TAG EDITING (QOL_IDEAS #27, with #28 "Edit tags" on a single item's menu).
 *
 * WHY THIS IS CAREFUL. jellyfin-web saves metadata with POST /Items/{id} and a BaseItemDto, and the
 * server (ItemUpdateController.UpdateItem) REPLACES the item's fields from that body. Two kinds of
 * field exist there:
 *   - ASSIGNED UNCONDITIONALLY: Name, ForcedSortName, OriginalTitle, OriginalLanguage, CriticRating,
 *     CommunityRating, IndexNumber, ParentIndexNumber, Overview, EndDate, PremiereDate,
 *     ProductionYear, OfficialRating, CustomRating, PreferredMetadataLanguage/CountryCode,
 *     DisplayOrder, AspectRatio, LockData (absent = false!), Video3DFormat, and the Airs* numbers of
 *     an episode. A field missing from the body is WIPED.
 *   - APPLIED ONLY WHEN NON-NULL: Tags, Genres, Studios, People, ProviderIds, Taglines,
 *     LockedFields, DateCreated, ProductionLocations, SeriesName, AlbumArtists, ArtistItems,
 *     AirDays. Absent = left exactly as stored.
 * So the payload is built to be: the unconditional fields copied from a FRESH single-item GET (the
 * same call and the same full field set the metadata editor itself loads with), plus Tags, and
 * nothing else. Everything in the second group except Tags is deliberately left out, so it cannot
 * be re-written, re-ordered or lost. After the save the item is read back and every field is
 * compared with what it was before; a difference is reported as a failure for that item.
 *
 * Series, Season and MusicAlbum are refused: saving them also pushes OfficialRating/CustomRating (and
 * tag changes) down onto every child, which would overwrite the children's own ratings.
 *
 * The user needs the server's elevation policy (the controller is RequiresElevation); the commands
 * are only offered to administrators, the same check multiSelect applies to "Group versions".
 */

// Item types whose save touches only the item itself and whose DTO round-trip is understood above.
var ALLOWED_TYPES = { Video: 1, Movie: 1, Trailer: 1, Episode: 1, Folder: 1, BoxSet: 1, Photo: 1, Book: 1 };

// Fields the server assigns unconditionally: copied from the fresh GET, never from anywhere else.
var UNCONDITIONAL = [
    'Name', 'OriginalTitle', 'OriginalLanguage', 'ForcedSortName', 'CommunityRating', 'CriticRating',
    'IndexNumber', 'ParentIndexNumber', 'Overview', 'PremiereDate', 'EndDate', 'ProductionYear',
    'OfficialRating', 'CustomRating', 'PreferredMetadataLanguage', 'PreferredMetadataCountryCode',
    'DisplayOrder', 'AspectRatio', 'Video3DFormat', 'AirsAfterSeasonNumber', 'AirsBeforeEpisodeNumber',
    'AirsBeforeSeasonNumber'
];

// Fields that must come back from the save untouched (everything above, plus what we never send).
var UNTOUCHED = UNCONDITIONAL.concat([
    'LockData', 'LockedFields', 'People', 'ProviderIds', 'Genres', 'Studios', 'Taglines', 'DateCreated',
    'ProductionLocations', 'Type'
]);

var MAX_CONCURRENCY = 3;
var CHUNK = 100;

function skipError(message) {
    var e = new Error(message);
    e.skipped = true;
    return e;
}

function lower(s) {
    return String(s).trim().toLowerCase();
}

function sameId(a, b) {
    return String(a || '').replace(/-/g, '').toLowerCase() === String(b || '').replace(/-/g, '').toLowerCase();
}

/* "a, b\nc" -> ['a', 'b', 'c']: trimmed, no blanks, no case-insensitive duplicates. */
export function parseTags(text) {
    var seen = new Set();
    var out = [];
    String(text || '').split(/[,\n]/).forEach(function (part) {
        var t = part.trim();
        if (t && !seen.has(t.toLowerCase())) {
            seen.add(t.toLowerCase());
            out.push(t);
        }
    });
    return out;
}

/*
 * Existing tags, minus `remove` (case-insensitive), plus `add` (case-insensitive: a tag that is
 * already there is not added again, and the stored spelling wins). Mirrors the server's own
 * trim + case-insensitive de-duplication so the list sent is the list that gets stored.
 */
export function mergeTags(existing, add, remove) {
    var removeSet = new Set((remove || []).map(lower));
    var seen = new Set();
    var tags = [];
    var added = [];
    var removed = [];

    (existing || []).forEach(function (t) {
        var s = String(t).trim();
        if (!s) {
            return;
        }
        var n = s.toLowerCase();
        if (removeSet.has(n)) {
            removed.push(s);
        } else if (!seen.has(n)) {
            seen.add(n);
            tags.push(s);
        }
    });

    (add || []).forEach(function (t) {
        var s = String(t).trim();
        var n = s.toLowerCase();
        if (s && !seen.has(n) && !removeSet.has(n)) {
            seen.add(n);
            tags.push(s);
            added.push(s);
        }
    });

    return { tags: tags, added: added, removed: removed };
}

/* The POST body: Id, the unconditionally-assigned fields from the fresh item, LockData, Tags. */
export function buildPayload(dto, tags) {
    var p = { Id: dto.Id };
    UNCONDITIONAL.forEach(function (k) {
        if (dto[k] !== undefined && dto[k] !== null) {
            p[k] = dto[k];
        }
    });
    p.LockData = !!dto.LockData;
    p.Tags = tags;
    return p;
}

function norm(v) {
    return v === undefined || v === null ? '' : JSON.stringify(v);
}

/* Names of the fields whose value differs between two reads of the same item. */
export function changedFields(before, after) {
    return UNTOUCHED.filter(function (k) {
        var a = before[k];
        var b = after[k];
        // The API omits null and may render an empty string either way: treat them alike.
        if (a === '' || a === null) { a = undefined; }
        if (b === '' || b === null) { b = undefined; }
        return norm(a) !== norm(b);
    });
}

function checkDto(dto, id) {
    if (!dto || typeof dto !== 'object' || !sameId(dto.Id, id)) {
        throw new Error('the server returned a different item');
    }
    if (!ALLOWED_TYPES[dto.Type]) {
        throw skipError(dto.Type + ' items are not supported here (use the metadata editor)');
    }
    if (typeof dto.Name !== 'string' || !dto.Name) {
        throw new Error('item came back without a name (partial data); not saved');
    }
    // These two only exist in the full single-item answer (ItemFields Tags and Settings).
    if (!Array.isArray(dto.Tags) || !Array.isArray(dto.LockedFields)) {
        throw new Error('item came back without its tags/settings (partial data); not saved');
    }
}

function sortedLower(list) {
    return list.map(lower).sort().join('\u0000');
}

function errorText(err) {
    if (!err) { return 'unknown error'; }
    var status = err.status || (err.response && err.response.status);
    if (status === 401 || status === 403) { return 'not allowed (administrator required)'; }
    if (status === 404) { return 'item not found'; }
    if (status) { return 'server error ' + status; }
    return err.message || String(err);
}

/*
 * Fresh GET -> change only Tags -> POST the minimal payload -> read back and compare.
 * Resolves { id, name, status: 'changed' | 'unchanged' }, rejects with an Error otherwise
 * (err.skipped is set for an unsupported type, err.itemName when the name is known).
 */
export function editItemTags(client, userId, id, add, remove) {
    var name = '';
    var before;
    var merged;

    return Promise.resolve(client.getItem(userId, id)).then(function (dto) {
        name = (dto && typeof dto.Name === 'string' && dto.Name) || '';
        checkDto(dto, id);
        before = dto;
        merged = mergeTags(dto.Tags, add, remove);
        if (!merged.added.length && !merged.removed.length) {
            return { id: id, name: name, status: 'unchanged' };
        }

        var payload = buildPayload(dto, merged.tags);
        var saved = typeof client.updateItem === 'function'
            ? client.updateItem(payload)
            : client.ajax({
                type: 'POST',
                url: client.getUrl('Items/' + encodeURIComponent(id)),
                data: JSON.stringify(payload),
                contentType: 'application/json'
            });

        return Promise.resolve(saved).then(function () {
            return client.getItem(userId, id);
        }).then(function (after) {
            if (!after || !Array.isArray(after.Tags) || sortedLower(after.Tags) !== sortedLower(merged.tags)) {
                throw new Error('saved, but the tags read back differ from what was sent');
            }
            var diff = changedFields(before, after);
            if (diff.length) {
                // Data-safety event: always logged, with the previous values, so it can be undone by hand.
                var was = {};
                diff.forEach(function (k) { was[k] = before[k]; });
                console.error('[jellyfin-plus] bulk tags: unexpected change on ' + id + '; previous values:', JSON.stringify(was));
                throw new Error('saved, but these fields changed unexpectedly: ' + diff.join(', '));
            }
            return { id: id, name: name, status: 'changed' };
        });
    }).catch(function (err) {
        // The API client rejects with a Response (has .status), not an Error.
        var e = err instanceof Error ? err : new Error(errorText(err));
        e.itemName = name;
        throw e;
    });
}

/*
 * Applies the change to every id, at most MAX_CONCURRENCY at a time. Never rejects and never stops
 * quietly: the summary always accounts for every id (changed + unchanged + skipped + failed +
 * notRun === total). opts.onProgress(done, total, summary); opts.shouldStop() stops STARTING items.
 */
export function runBulk(client, userId, ids, add, remove, opts) {
    opts = opts || {};
    var list = [];
    var seen = new Set();
    ids.forEach(function (id) {
        if (!seen.has(id)) { seen.add(id); list.push(id); }
    });

    var summary = { total: list.length, changed: 0, unchanged: 0, skipped: [], failed: [], notRun: 0 };
    var next = 0;
    var done = 0;

    function progress() {
        try {
            if (opts.onProgress) { opts.onProgress(done, summary.total, summary); }
        } catch (e) { /* a broken progress callback must not stop the run */ }
    }

    function worker() {
        if ((opts.shouldStop && opts.shouldStop()) || next >= list.length) {
            return Promise.resolve();
        }
        var id = list[next++];
        return editItemTags(client, userId, id, add, remove).then(function (r) {
            summary[r.status]++;
        }, function (err) {
            var entry = { id: id, name: err.itemName || id, message: err.message || errorText(err) };
            (err.skipped ? summary.skipped : summary.failed).push(entry);
            log('bulk tags: ' + id + ' ' + entry.message);
        }).then(function () {
            done++;
            progress();
            return worker();
        });
    }

    var workers = [];
    for (var i = 0; i < Math.min(MAX_CONCURRENCY, list.length); i++) {
        workers.push(worker());
    }
    return Promise.all(workers).then(function () {
        summary.notRun = list.length - done;
        return summary;
    });
}

var tagNamesCache = null;

/* Every tag name the server knows for this user (cached for the page's lifetime; cheap). */
export function loadTagNames(client, userId) {
    if (!tagNamesCache) {
        tagNamesCache = Promise.resolve(client.ajax({
            type: 'GET',
            url: client.getUrl('Items/Filters', { userId: userId }),
            dataType: 'json'
        })).then(function (res) {
            return ((res && res.Tags) || []).filter(function (t) { return typeof t === 'string' && t; });
        }).catch(function (err) {
            log('bulk tags: tag list unavailable', err);
            tagNamesCache = null;
            return [];
        });
    }
    return tagNamesCache;
}

/* The union of the tags the given items carry, most common first (for "remove" suggestions). */
export function loadSelectionTags(client, userId, ids) {
    var counts = new Map();
    var chunks = [];
    for (var i = 0; i < ids.length; i += CHUNK) {
        chunks.push(ids.slice(i, i + CHUNK));
    }
    return Promise.all(chunks.map(function (chunk) {
        return Promise.resolve(client.ajax({
            type: 'GET',
            url: client.getUrl('Items', { userId: userId, ids: chunk.join(','), fields: 'Tags' }),
            dataType: 'json'
        })).then(function (res) {
            ((res && res.Items) || []).forEach(function (it) {
                (it.Tags || []).forEach(function (t) {
                    counts.set(t, (counts.get(t) || 0) + 1);
                });
            });
        });
    })).then(function () {
        return Array.from(counts.keys()).sort(function (a, b) { return counts.get(b) - counts.get(a); });
    }).catch(function (err) {
        log('bulk tags: selection tags unavailable', err);
        return [];
    });
}

// ---------------------------------------------------------------------------------------------
// Hooking into jellyfin-web's own action sheets, found by shape (never by a global name).
// ---------------------------------------------------------------------------------------------

var TRIGGER = '[data-action="menu"], .btnMoreCommands';
var lastTrigger = null;

function client() {
    var c = window.ApiClient;
    return c && typeof c.getItem === 'function' && typeof c.getUrl === 'function' ? c : null;
}

function isAdmin(c) {
    return Promise.resolve(c.getCurrentUser()).then(function (u) {
        return !!(u && u.Policy && u.Policy.IsAdministrator);
    }, function () { return false; });
}

/* Ids ticked in the multi-select UI, read from the checkboxes it draws on every card. */
function selectedIds() {
    var ids = [];
    var boxes = document.querySelectorAll('.itemSelectionPanel .chkItemSelect');
    for (var i = 0; i < boxes.length; i++) {
        if (boxes[i].checked) {
            var holder = boxes[i].closest('[data-id]');
            var id = holder && holder.getAttribute('data-id');
            if (id && ids.indexOf(id) === -1) { ids.push(id); }
        }
    }
    return ids;
}

function counterValue() {
    var c = document.querySelector('.itemSelectionCount');
    var n = c ? parseInt(String(c.textContent).replace(/[^\d]/g, ''), 10) : NaN;
    return isNaN(n) ? null : n;
}

var GUID = /^[0-9a-f]{32}$|^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/* The item a single-item menu was opened for: the nearest data-id above the button, else the page's. */
function triggerItemId(el) {
    var holder = el && el.closest && el.closest('[data-id]');
    var id = holder && holder.getAttribute('data-id');
    if (id && GUID.test(id)) { return id; }

    var hash = window.location.hash || '';
    var q = hash.indexOf('?');
    if (q !== -1) {
        var pid = new URLSearchParams(hash.slice(q + 1)).get('id');
        if (pid && GUID.test(pid)) { return pid; }
    }
    return null;
}

var ICON_BASE = { actionsheetMenuItemIcon: 1, listItemIcon: 1, 'listItemIcon-transparent': 1, 'material-icons': 1 };

/* A new row styled exactly like a sibling row of the same sheet. */
function makeRow(sibling, dataId, label, icon) {
    var row = sibling.cloneNode(true);
    row.setAttribute('data-id', dataId);
    var text = row.querySelector('.actionSheetItemText');
    if (text) { text.textContent = label; }
    var ic = row.querySelector('.actionsheetMenuItemIcon');
    if (ic) {
        Array.prototype.slice.call(ic.classList).forEach(function (c) {
            if (!ICON_BASE[c]) { ic.classList.remove(c); }
        });
        ic.classList.add(icon);
        ic.style.visibility = '';
    }
    var second = row.querySelector('.secondary');
    if (second) { second.remove(); }
    return row;
}

/* The sheet was sized before we added rows; keep it on screen. */
function keepOnScreen(dlg) {
    try {
        if (dlg.style.position !== 'fixed') { return; }
        var top = parseFloat(dlg.style.top);
        var h = dlg.offsetHeight;
        var limit = window.innerHeight - 10;
        if (!isNaN(top) && h && top + h > limit) {
            dlg.style.top = Math.max(10, limit - h) + 'px';
        }
    } catch (e) { /* cosmetic only */ }
}

function openMulti(mode, ids) {
    var c = client();
    if (!c) { return; }
    var userId = c.getCurrentUserId();
    var counter = counterValue();
    var note = ids.length + (ids.length === 1 ? ' item selected' : ' items selected');
    if (counter !== null && counter !== ids.length) {
        note += ' (the counter says ' + counter + '; only items still on this page can be edited)';
    }
    showTagDialog({
        mode: mode,
        title: mode === 'add' ? 'Add tags' : 'Remove tags',
        note: note,
        count: ids.length,
        suggest: mode === 'add' ? loadTagNames(c, userId) : loadSelectionTags(c, userId, ids),
        run: function (add, remove, hooks) {
            return runBulk(c, userId, ids, add, remove, hooks).then(function (s) {
                if (s.changed) { tagNamesCache = null; }
                return s;
            });
        }
    });
}

function openSingle(id) {
    var c = client();
    if (!c) { return; }
    var userId = c.getCurrentUserId();
    Promise.resolve(c.getItem(userId, id)).then(function (dto) {
        checkDto(dto, id);
        showTagDialog({
            mode: 'edit',
            title: 'Edit tags',
            note: dto.Name,
            count: 1,
            currentTags: dto.Tags.slice(),
            suggest: loadTagNames(c, userId),
            run: function (add, remove, hooks) {
                return runBulk(c, userId, [id], add, remove, hooks).then(function (s) {
                    if (s.changed) { tagNamesCache = null; }
                    return s;
                });
            }
        });
    }).catch(function (err) {
        window.alert('Cannot edit tags here: ' + ((err && err.message) || errorText(err)));
    });
}

function decorate(dlg) {
    var c = client();
    if (!c || !dlg || dlg.getAttribute('data-gpu-tags')) { return; }

    var multi = dlg.querySelector('[data-id="selectall"]') && document.querySelector('.selectionCommandsPanel');
    var editRow = dlg.querySelector('[data-id="edit"]');
    if (!multi && !editRow) { return; }

    var trigger = lastTrigger && Date.now() - lastTrigger.t < 5000 ? lastTrigger.el : null;
    var singleId = !multi && trigger ? triggerItemId(trigger) : null;
    if (!multi && !singleId) { return; }
    dlg.setAttribute('data-gpu-tags', '1');

    // The same permission the server enforces on POST /Items/{id}. For the single-item menu,
    // jellyfin-web only lists "Edit metadata" when itemHelper.canEdit(user, item) held, which
    // is why that row is the precondition above.
    isAdmin(c).then(function (admin) {
        if (!admin || !dlg.isConnected) { return; }

        if (multi) {
            var sib = dlg.querySelector('[data-id="playlist"]') || dlg.querySelector('[data-id="selectall"]');
            var before = dlg.querySelector('[data-id="markplayed"]');
            var parent = sib.parentNode;
            [['gpuaddtags', 'Add tags…', 'label', 'add'], ['gpuremovetags', 'Remove tags…', 'label_off', 'remove']].forEach(function (d) {
                var row = makeRow(sib, d[0], d[1], d[2]);
                // Read the ticks NOW; the sheet's own click handler runs after this one and closes it.
                row.addEventListener('click', function () {
                    var ids = selectedIds();
                    setTimeout(function () { openMulti(d[3], ids); }, 0);
                });
                parent.insertBefore(row, before || null);
            });
        } else {
            var row = makeRow(editRow, 'gpuedittags', 'Edit tags', 'label');
            row.addEventListener('click', function () {
                setTimeout(function () { openSingle(singleId); }, 0);
            });
            editRow.parentNode.insertBefore(row, editRow.nextSibling);
        }
        keepOnScreen(dlg);
        log('bulk tags: rows added to action sheet (' + (multi ? 'multi-select' : 'item ' + singleId) + ')');
    });
}

function scan(node) {
    if (node.nodeType !== 1) { return; }
    if (node.classList.contains('actionSheet')) {
        decorate(node);
    } else if (node.querySelector) {
        var inner = node.querySelector('.actionSheet');
        if (inner) { decorate(inner); }
    }
}

export function installBulkTags() {
    if (!document.body) {
        document.addEventListener('DOMContentLoaded', installBulkTags, { once: true });
        return;
    }
    try {
        var remember = function (e) {
            try {
                var t = e.target;
                if (t && t.closest && (e.type === 'contextmenu' || t.closest(TRIGGER))) {
                    lastTrigger = { el: t, t: Date.now() };
                }
            } catch (err) { /* ignore */ }
        };
        document.addEventListener('click', remember, true);
        document.addEventListener('contextmenu', remember, true);

        new MutationObserver(function (records) {
            try {
                for (var i = 0; i < records.length; i++) {
                    for (var j = 0; j < records[i].addedNodes.length; j++) {
                        scan(records[i].addedNodes[j]);
                    }
                }
            } catch (err) {
                log('bulk tags: scan failed', err);
            }
        }).observe(document.body, { childList: true });
        log('bulk tags: installed');
    } catch (err) {
        log('bulk tags: install failed', err);
    }
}
