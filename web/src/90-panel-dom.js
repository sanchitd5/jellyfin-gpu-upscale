    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }

        var s = el('style');
        s.id = STYLE_ID;
        s.textContent = CSS;
        (document.head || document.documentElement).appendChild(s);
    }

    /*
     * WHICH DISCLOSURES THIS VIEWER LEAVES OPEN. Kept apart from the preferences so that a corrupt
     * or absent entry costs a closed section and nothing else, and wrapped in try/catch like every
     * other storage read here: a browser that refuses localStorage still gets a working panel.
     */
    var OPEN_STORE = 'gpuUpscaleOpen';

    function openState() {
        try {
            var raw = window.localStorage && window.localStorage.getItem(OPEN_STORE);
            var parsed = raw ? JSON.parse(raw) : null;
            return (parsed && typeof parsed === 'object') ? parsed : {};
        } catch (e) {
            return {};
        }
    }

    function isOpen(id) {
        return !!openState()[id];
    }

    function setOpen(id, on) {
        try {
            var map = openState();
            map[id] = !!on;
            window.localStorage.setItem(OPEN_STORE, JSON.stringify(map));
        } catch (e) { /* the section simply opens closed next time */ }
    }

    /*
     * A native <details>, so the keyboard, the screen reader and the remote all behave without a
     * line of code here: it is a real disclosure widget rather than a div pretending to be one.
     * Its open state is remembered per viewer, and the summary carries a count of what is set
     * inside it - a control hidden at a non-default value must still announce itself.
     */
    function disclosure(id, title, changed) {
        var d = el('details', 'gpuup-more');
        d.open = isOpen(id);
        var sum = el('summary', null, title);
        if (changed > 0) {
            sum.appendChild(document.createTextNode(' '));
            sum.appendChild(el('span', 'gpuup-changed', '(' + changed + ' changed)'));
        }

        d.appendChild(sum);
        d.addEventListener('toggle', function () { setOpen(id, d.open); });
        return d;
    }

    /* How many of these controls are away from their own neutral value. */
    function changedCount(controls) {
        var shown = shownPrefs();
        return controls.filter(function (c) {
            var v = shown[c.key];
            return v != null && v !== c.fallback;
        }).length;
    }

    /* One axis row: chips, a picker, or both. onPick receives the chosen level id. */
    function controlRow(c, onPick) {
        var cur = shownPrefs()[c.key] || c.fallback;
        var ids = c.options.map(function (o) { return o.id; });
        var grade = (c.grade || []).filter(function (id) { return ids.indexOf(id) >= 0; });
        // Chips only where the data says the short form is safe to show, because a chip drops
        // everything after " (" - and on the neural and game axes that parenthesis is where the
        // honesty lives ("degraded: synthesised motion vectors", "0.24x realtime"). Those axes are
        // pickers, which show the server's wording whole.
        var chipIds = grade.length >= 2 ? grade : (c.chips && c.options.length <= 4 ? ids : []);
        var rest = c.options.filter(function (o) { return chipIds.indexOf(o.id) < 0; });

        // Inert because of another axis, not because of this one. Shown rather than hidden: a
        // control that vanishes when an unrelated pick changes is harder to understand than one
        // that stays put and says why it cannot act. The stored preference is untouched, so
        // undoing the conflicting pick brings this axis straight back.
        var conflict = axisConflict(c.key);

        var row = el('div', 'gpuup-row' + (conflict ? ' gpuup-inert' : ''));
        row.appendChild(el('div', 'gpuup-label', c.label));
        var box = el('div', 'gpuup-chips');
        row.appendChild(box);

        if (chipIds.length) {
            // Without this a screen reader hears one unlabelled button per level and no axis at
            // all, and the pick is carried only by a CSS class, which it cannot see. The group
            // takes the control's OWN label, so a new axis is announced with no code here.
            box.setAttribute('role', 'radiogroup');
            box.setAttribute('aria-label', c.label);
        }

        chipIds.forEach(function (id) {
            var o = c.options.filter(function (x) { return x.id === id; })[0];
            // WEB_PANEL_DESIGN.md section 3.3: an option can be inert on its own (today only
            // denoise, on the CUDA-native branch) even while the row as a whole is not - unlike
            // `conflict`, which greys every option in the row.
            var optInert = optionInert(c, id);
            var b = el('button', 'gpuup-chip' + (id === cur ? ' on' : ''), shortName(o.name));
            b.title = o.name;
            b.type = 'button';
            b.setAttribute('role', 'radio');
            b.setAttribute('aria-checked', id === cur ? 'true' : 'false');
            if (conflict || optInert) {
                b.disabled = true;
                b.setAttribute('aria-disabled', 'true');
                b.title = o.name + ' - ' + (conflict || optInert);
            } else {
                b.onclick = function () { onPick(id); };
            }
            box.appendChild(b);
        });

        if (rest.length) {
            var sel = el('select', 'gpuup-sel');
            sel.setAttribute('aria-label', c.label);
            if (chipIds.length) {
                // A placeholder so the picker never looks like it owns a value the chips hold.
                var ph = el('option', null, rest.length === 1 ? 'more...' : 'more levels...');
                ph.value = '';
                sel.appendChild(ph);
            }

            var makeOption = function (o) {
                var opt = el('option', null, o.name + costSuffix(c, o.id));
                opt.value = o.id;
                if (o.id === cur) { opt.selected = true; }
                var optInert = optionInert(c, o.id);
                if (optInert) {
                    opt.disabled = true;
                    opt.title = optInert;
                }
                return opt;
            };

            if (c.families) {
                // WEB_PANEL_DESIGN.md section 1.3(b): 'off' and any id the probe assigned no
                // family render flat (Off first, ungrouped ids last); everything else groups under
                // an <optgroup>, in the order its family was first seen in `rest` - which is the
                // order the probe listed the levels in, since `rest` inherits CONTROLS/probe order.
                var headOptions = [];
                var tailOptions = [];
                var groupOrder = [];
                var groups = {};
                rest.forEach(function (o) {
                    var fam = o.id !== 'off' ? c.families[o.id] : null;
                    if (!fam) {
                        (o.id === 'off' ? headOptions : tailOptions).push(o);
                        return;
                    }

                    if (!groups[fam]) {
                        groups[fam] = [];
                        groupOrder.push(fam);
                    }

                    groups[fam].push(o);
                });

                headOptions.forEach(function (o) { sel.appendChild(makeOption(o)); });
                groupOrder.forEach(function (fam) {
                    var og = el('optgroup');
                    og.label = (c.familyLabels && c.familyLabels[fam]) || fam;
                    groups[fam].forEach(function (o) { og.appendChild(makeOption(o)); });
                    sel.appendChild(og);
                });
                tailOptions.forEach(function (o) { sel.appendChild(makeOption(o)); });
            } else {
                rest.forEach(function (o) { sel.appendChild(makeOption(o)); });
            }

            if (conflict) {
                sel.disabled = true;
                sel.setAttribute('aria-disabled', 'true');
                sel.title = conflict;
            } else {
                sel.onchange = function () {
                    if (sel.value) { onPick(sel.value); }
                };
            }
            box.appendChild(sel);
        }

        // The reason comes first: a greyed row with no explanation is worse than no greying, since
        // the viewer is left to guess which other pick did it.
        if (conflict) {
            row.appendChild(el('div', 'gpuup-note', conflict));
        }

        // WEB_PANEL_DESIGN.md section 3.4: the consequence of the current pick, stated once, right
        // under the control that caused it - not discovered row by row while Advanced stays closed.
        // Only ever non-empty on the axis that OWNS the CUDA-native branch (`neural`), and only
        // when something the branch forces off is actually set to a non-default value. Section
        // 4.3 orders this ahead of the level note below when both fire: this one is about loss.
        if (c.key === 'neural' && neuralIsCudaNative(shownPrefs())) {
            var suppressed = cudaSuppressedLabels();
            if (suppressed.length) {
                var levelName = shortName((c.options.filter(function (o) { return o.id === cur; })[0] || {}).name || cur);
                row.appendChild(el('div', 'gpuup-note',
                    levelName + ' runs on the CUDA path. For this session the server will turn off: '
                    + suppressed.join(', ') + '. Your picks are kept and come back when you choose'
                    + ' Off or a level that is not CUDA-native.'));
            }
        }

        // WEB_PANEL_DESIGN.md section 2.2/2.3: a one-line, server-worded caveat for the CURRENT
        // level, when the probe sent one (today only the RTX DLPP/VSR levels have one). Shown
        // whether or not the row is also inert for an unrelated reason.
        if (c.notes && c.notes[cur]) {
            row.appendChild(el('div', 'gpuup-note', c.notes[cur]));
        }

        var note = controlNote(c.key);
        if (note) {
            row.appendChild(el('div', 'gpuup-note', note));
        }

        return row;
    }

    /*
     * The CONTROLS[].label strings for every axis NeuralCudaDisables names that the viewer has
     * actually set away from its own fallback - WEB_PANEL_DESIGN.md section 3.4's "state it once,
     * up front" note. Reads state.caps directly rather than the rendered `controls` list, so it
     * works out the same whether or not this render's Advanced disclosure happens to be open.
     */
    function cudaSuppressedLabels() {
        var p = shownPrefs();
        return neuralCudaDisables()
            .filter(function (key) {
                var def = DEFAULT_PREFS[key];
                return p[key] != null && p[key] !== def;
            })
            .map(function (key) {
                var c = CONTROLS.filter(function (x) { return x.key === key; })[0];
                return c ? c.label : key;
            });
    }

    /*
     * The quality stage, as a slider over the ladder that is already generated for this source.
     * The ladder itself is untouched: same stages, same order, same cost sort - only the way it is
     * presented changed, from a list of sheet rows to one control.
     */
    function qualitySection(rerender) {
        var wrap = el('div');
        wrap.appendChild(el('h3', null, 'Quality'));

        var modes = [
            { id: 'unset', name: 'Automatic', title: 'Send nothing: the server\'s own defaults decide.' },
            { id: 'off', name: 'Off', title: 'Play the file as it is. Direct play is left alone and no GPU is used.' },
            { id: 'manual', name: 'Manual', title: 'Choose a stage on the ladder, or set the axes below.' }
        ];
        var manual = state.stage !== 'unset' && state.stage !== 'off';
        var box = el('div', 'gpuup-chips');
        box.setAttribute('role', 'radiogroup');
        box.setAttribute('aria-label', 'Quality');
        modes.forEach(function (m) {
            var on = m.id === 'manual' ? manual : state.stage === m.id;
            var b = el('button', 'gpuup-chip' + (on ? ' on' : ''), m.name);
            b.title = m.title;
            b.type = 'button';
            b.setAttribute('role', 'radio');
            b.setAttribute('aria-checked', on ? 'true' : 'false');
            b.onclick = function () {
                if (m.id === 'manual') {
                    if (!manual) {
                        var rec = recommendedStage();
                        state.stage = rec ? { rank: rec.rank, sr: rec.sr, denoise: rec.denoise } : 'custom';
                    }
                } else {
                    state.stage = m.id;
                }

                savePrefs();
                requestRestream();
                rerender();
            };
            box.appendChild(b);
        });
        wrap.appendChild(box);

        if (!manual) {
            wrap.appendChild(el('div', 'gpuup-note', state.stage === 'off'
                ? 'The file plays as it is. The server is told this is Off, not silence, so its own defaults stay out of it.'
                : 'Nothing is sent. The server\'s dashboard defaults apply, exactly as for a player without this script.'));
            return wrap;
        }

        var l = ladder();
        if (l === null) {
            // Two different reasons, and they are not the same problem: say which one it is.
            wrap.appendChild(el('div', 'gpuup-note', serverConfig()
                ? 'Quality stages need the source size. Start playback, then open this again.'
                : 'The server has not reported its own limits yet, so the stages cannot be built'
                  + ' honestly. Open this again in a moment. The axes below still work.'));
            return wrap;
        }

        if (!l.length) {
            // Say what is NOT available and what still is. The old wording stopped at "nothing to
            // offer", which reads as "this server can do nothing for a source this size" and is
            // false: everything that works without an enlargement still does.
            wrap.appendChild(el('div', 'gpuup-note',
                'This source is at or above the server\'s upscale limit, so there is no larger size'
                + ' to scale to and the quality stages do not apply. The passes that work at the'
                + ' source size are below: unblur, denoise, compression cleanup, chroma, debanding,'
                + ' and DLAA, which runs at 1:1 by design.'));
            return wrap;
        }

        var cur = currentStage();
        var rec = recommendedStage();
        var slider = el('input', 'gpuup-slider');
        slider.type = 'range';
        slider.min = 1;
        slider.max = l.length;
        slider.step = 1;
        slider.value = cur ? cur.n : (rec ? rec.n : 1);
        var caption = el('div', 'gpuup-note');

        function describe(n) {
            var st = l.filter(function (x) { return x.n === n; })[0];
            if (!st) {
                return '';
            }

            return st.n + ' of ' + l.length + '. ' + stageText(st)
                + '  (GPU ' + costHint(st.cost) + ')'
                + (sameStage(st, rec) ? '  recommended' : '');
        }

        caption.textContent = state.stage === 'custom'
            ? 'Custom: ' + advancedText() + '. Move the slider to go back to a stage.'
            : describe(parseInt(slider.value, 10));

        slider.oninput = function () {
            caption.textContent = describe(parseInt(slider.value, 10));
        };
        slider.onchange = function () {
            var st = l.filter(function (x) { return x.n === parseInt(slider.value, 10); })[0];
            if (!st) {
                return;
            }

            // Stored as a RECIPE, not as a number: stage 7 on this item is not stage 7 on the next
            // one, whose ladder may be a different length.
            state.stage = { rank: st.rank, sr: st.sr, denoise: st.denoise };
            savePrefs();
            log('quality stage', st.n);
            requestRestream();
            rerender();
        };

        wrap.appendChild(slider);
        wrap.appendChild(caption);
        return wrap;
    }

    /*
     * ONE SOURCE OF TRUTH FOR "WHAT RAN". Both the panel's live block and the row added to
     * Jellyfin's own Playback Info come through here, so a row added to LIVE_ROWS appears in both
     * and neither can drift into claiming something the other does not.
     *
     * `make` builds one row out of a label and a value, because the two hosts want different
     * markup; the lines themselves are never rebuilt.
     */
    function liveRows(make, skip) {
        return liveLines()
            .filter(function (pair) { return !skip || skip.indexOf(pair[0]) < 0; })
            .map(function (pair) { return make(pair[0], pair[1]); });
    }

    function liveSection() {
        var wrap = el('div');
        wrap.appendChild(el('h3', null, 'What the server is doing'));
        var box = el('div', 'gpuup-live');
        // This block is the confirmation of what actually ran, and it changes on its own as the
        // session record follows playback. Polite, never assertive: it must not cut across the
        // control the viewer is on.
        box.setAttribute('aria-live', 'polite');
        liveRows(function (label, value) {
            var d = el('div');
            d.appendChild(el('b', null, label));
            d.appendChild(el('span', null, value));
            return d;
        }).forEach(function (d) { box.appendChild(d); });
        wrap.appendChild(box);
        return wrap;
    }

    /* --------------------------------------------------------------- moving the panel */

    /*
     * The panel is moved by its header. Pointer events, so ONE code path covers mouse, touch and
     * pen. Three things it must not do, and each is why the code is the shape it is:
     *
     *   - It must not swallow a click on a header control. A drag is only entered once the pointer
     *     has travelled DRAG_SLOP pixels; below that nothing is captured and the button gets its
     *     click as usual. When a drag DID happen, the click that follows is eaten once in the
     *     capture phase, so letting go over the close button does not also close the panel.
     *   - It must not put the panel anywhere it cannot be reached. Every position - dragged,
     *     restored from localStorage, or left over after the window was resized - goes through
     *     clampPos() before it is used.
     *   - It must not be the only way to move it. A television has no pointer, so the grip is a
     *     real focusable button: arrow keys move the panel, Enter or Space puts it back, and
     *     double-clicking the header does the same. Nothing about the panel depends on dragging,
     *     so a remote is not locked out of anything - it simply leaves the panel where it is.
     *
     * All of it is inside try/catch: a broken drag must never escape into the player.
     */
    var DRAG_SLOP = 4;
    var KEY_STEP = 24;
    var EDGE = 4;

    function clampPos(x, y, w, h) {
        var maxX = Math.max(EDGE, (window.innerWidth || 0) - w - EDGE);
        var maxY = Math.max(EDGE, (window.innerHeight || 0) - h - EDGE);
        return {
            x: Math.min(Math.max(x, EDGE), maxX),
            y: Math.min(Math.max(y, EDGE), maxY)
        };
    }

    function applyPanelPos(panel) {
        try {
            panel = panel || panelEl();
            if (!panel) {
                return;
            }

            if (!state.panelPos) {
                // Back to the stylesheet's own corner: clear the inline overrides, do not guess
                // at what the CSS said.
                panel.style.left = '';
                panel.style.top = '';
                panel.style.right = '';
                panel.style.bottom = '';
                return;
            }

            var r = panel.getBoundingClientRect();
            var pos = clampPos(state.panelPos.x, state.panelPos.y, r.width, r.height);
            state.panelPos = pos;
            panel.style.left = pos.x + 'px';
            panel.style.top = pos.y + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        } catch (err) {
            log('could not place the panel', err);
        }
    }

    function movePanelBy(dx, dy) {
        try {
            var panel = panelEl();
            if (!panel) {
                return;
            }

            var r = panel.getBoundingClientRect();
            state.panelPos = { x: r.left + dx, y: r.top + dy };
            applyPanelPos(panel);
            savePrefs();
        } catch (err) {
            log('could not move the panel', err);
        }
    }

    function resetPanelPos() {
        try {
            state.panelPos = null;
            applyPanelPos();
            savePrefs();
            log('panel position reset');
        } catch (err) {
            log('could not reset the panel position', err);
        }
    }

    /* A pointerdown that landed on something clickable is that control's, not the drag's. */
    function isControl(node) {
        for (var n = node; n && n !== document; n = n.parentNode) {
            var t = n.tagName && String(n.tagName).toLowerCase();
            if (t === 'button' || t === 'select' || t === 'input' || t === 'textarea' || t === 'a') {
                return true;
            }
        }

        return false;
    }

    function makeDraggable(head) {
        try {
            head.addEventListener('dblclick', function (ev) {
                if (!isControl(ev.target)) {
                    resetPanelPos();
                }
            });

            if (!window.PointerEvent) {
                // No pointer events: the panel simply stays where it is, and the grip's keyboard
                // path still moves it. Nothing is broken, one way of moving it is absent.
                return;
            }

            head.addEventListener('pointerdown', function (ev) {
                try {
                    if (ev.button != null && ev.button !== 0) {
                        return;
                    }

                    if (isControl(ev.target)) {
                        return;
                    }

                    var panel = panelEl();
                    if (!panel) {
                        return;
                    }

                    var r = panel.getBoundingClientRect();
                    var d = {
                        id: ev.pointerId,
                        ox: ev.clientX - r.left,
                        oy: ev.clientY - r.top,
                        sx: ev.clientX,
                        sy: ev.clientY,
                        moved: false
                    };

                    var eatClick = function (e3) {
                        e3.stopPropagation();
                        e3.preventDefault();
                    };

                    function end() {
                        try {
                            document.removeEventListener('pointermove', onMove, true);
                            document.removeEventListener('pointerup', onUp, true);
                            document.removeEventListener('pointercancel', onUp, true);
                            try { head.releasePointerCapture(d.id); } catch (e) { /* ignore */ }
                            if (d.moved) {
                                savePrefs();
                                window.addEventListener('click', eatClick, true);
                                setTimeout(function () {
                                    window.removeEventListener('click', eatClick, true);
                                }, 0);
                            }
                        } catch (err) {
                            log('drag cleanup failed', err);
                        }

                        state.drag = null;
                    }

                    var onMove = function (e2) {
                        try {
                            if (!state.drag || e2.pointerId !== d.id) {
                                return;
                            }

                            if (!d.moved
                                && Math.abs(e2.clientX - d.sx) < DRAG_SLOP
                                && Math.abs(e2.clientY - d.sy) < DRAG_SLOP) {
                                return;
                            }

                            if (!d.moved) {
                                d.moved = true;
                                try { head.setPointerCapture(d.id); } catch (e) { /* not fatal */ }
                            }

                            if (e2.cancelable) { e2.preventDefault(); }
                            state.panelPos = { x: e2.clientX - d.ox, y: e2.clientY - d.oy };
                            applyPanelPos();
                        } catch (err) {
                            log('drag failed', err);
                            end();
                        }
                    };

                    var onUp = function (e4) {
                        if (e4.pointerId === d.id) {
                            end();
                        }
                    };

                    state.drag = d;
                    document.addEventListener('pointermove', onMove, true);
                    document.addEventListener('pointerup', onUp, true);
                    document.addEventListener('pointercancel', onUp, true);
                } catch (err) {
                    log('drag failed to start', err);
                    state.drag = null;
                }
            });
        } catch (err) {
            log('could not make the panel draggable', err);
        }
    }

    /* The grip: the pointerless way to do everything dragging does. */
    function gripButton() {
        var g = el('button', 'gpuup-grip', '\u283f');
        g.type = 'button';
        g.title = 'Drag to move. Arrow keys move it; Enter puts it back.';
        g.setAttribute('aria-label', 'Move panel. Arrow keys move it, Enter resets its position.');
        g.onkeydown = function (ev) {
            var step = ev.shiftKey ? KEY_STEP * 3 : KEY_STEP;
            var dx = 0;
            var dy = 0;
            if (ev.key === 'ArrowLeft') { dx = -step; } else if (ev.key === 'ArrowRight') { dx = step; } else if (ev.key === 'ArrowUp') { dy = -step; } else if (ev.key === 'ArrowDown') { dy = step; } else { return; }

            ev.preventDefault();
            ev.stopPropagation();
            movePanelBy(dx, dy);
        };
        g.onclick = function (ev) {
            ev.stopPropagation();
            resetPanelPos();
        };
        return g;
    }

    function renderPanel(panel, caps) {
        state.caps = caps;
        var body = el('div');

        var head = el('div', 'gpuup-head');
        head.appendChild(gripButton());
        head.appendChild(el('div', 'gpuup-title', 'Enhance'));
        head.appendChild(el('div', 'gpuup-sum', summaryText()));
        if (state.applying) {
            head.appendChild(el('div', 'gpuup-applying', state.applying));
        }

        var x = el('button', 'gpuup-x', '×');
        x.title = 'Close';
        x.onclick = closePanel;
        head.appendChild(x);
        body.appendChild(head);

        // THE ONE LINE A VIEWER WANTS, AND IT COMES FROM THE SERVER. Everything else in this panel
        // is either a selection or a detail; this says whether any of it is running right now, and
        // it is built from the session record rather than from what was picked, so it cannot claim
        // a chain the server refused. aria-live, because it changes without the viewer acting.
        var act = activeState();
        var badge = el('div', 'gpuup-active is-' + act.key);
        badge.setAttribute('aria-live', 'polite');
        badge.appendChild(el('span', 'gpuup-dot'));
        badge.appendChild(el('span', 'gpuup-active-label', act.label));
        body.appendChild(badge);
        body.appendChild(el('div', 'gpuup-note', act.why));

        if (state.applyFailed) {
            body.appendChild(el('div', 'gpuup-note', APPLY_FAILED_TEXT));
        }

        function rerender() {
            renderPanel(panel, caps);
        }

        body.appendChild(qualitySection(rerender));

        // What this render shows, BEFORE axisControls reads the game value for showWhen -
        // otherwise jitter/depth/reactive render against a stale game value on first paint and only
        // catch up on the next 3s live poll. It is a separate object: state.prefs holds the
        // viewer's overrides and nothing else ever writes the stage into it.
        state.shown = displayPrefs();

        var controls = axisControls(caps);

        // A level that has gone away (an uninstalled shader, an old localStorage value, or a
        // target this source is too tall for) must not leave a control showing something the
        // server would refuse.
        controls.forEach(function (c) {
            var current = state.shown[c.key];
            // Only when the probe POSITIVELY listed this axis. A probe that answered without Game
            // is silence, not a withdrawal, and resetting on silence rewrote a stored level to off.
            // Never persisted either: a level dropped because this server cannot serve it now must
            // come back when it can, so the reset lives on the display object alone.
            var listed = !c.probeKey || !!(caps.levels && caps.levels[c.probeKey]
                && caps.levels[c.probeKey].length);
            if (current && listed && !c.options.some(function (o) { return o.id === current; })) {
                log('dropping unavailable preference', c.key, current);
                state.shown[c.key] = c.fallback;
            }
        });

        function pick(c) {
            return controlRow(c, function (id) {
                state.prefs[c.key] = String(id);
                // A technical value now owns the settings, so the header says Custom instead of
                // naming a stage these values no longer match.
                state.stage = 'custom';
                savePrefs();
                log('axis', c.key, id);
                requestRestream();
                rerender();
            });
        }

        // TIERED FROM THE DATA, not from a list of axis names here. A control carrying `basic`
        // is always visible, in that number's order; everything else is behind one disclosure,
        // and a cluster naming an `expert` group is one row inside it that opens its own inputs.
        // A new axis is still one entry in CONTROLS: with no tier field it lands in Advanced.
        //
        // WHEN THERE IS NOTHING TO UPSCALE TO, THE TIERS ARE WRONG. A source at or above the
        // server's limit gets no target, which makes the upscale row and everything that only
        // corrects an enlargement useless, while the passes that work at 1:1 - sharpening,
        // denoise, compression cleanup, chroma, debanding, and DLAA - are the only things left
        // worth offering. Leaving those behind a closed disclosure reads as "this server can do
        // nothing for 4K", which is false. So the visible set is chosen from `atSource` instead,
        // still from the control's own data rather than from a list of axis names here.
        var upscalable = eligibleTargets();
        var atLimit = !upscalable || !upscalable.length;
        var tier = function (c) { return atLimit ? (c.atSource || 0) : (c.basic || 0); };
        var basics = controls.filter(function (c) { return tier(c); })
            .sort(function (a, b) { return tier(a) - tier(b); });
        var rest = controls.filter(function (c) { return !tier(c); });

        basics.forEach(function (c) { body.appendChild(pick(c)); });

        // A chain that cannot keep up does not fail, it buffers, and nothing in the panel said so
        // until now: a viewer stacking compression cleanup, OptiX and DLSS got 0.22x realtime and
        // an unexplained stutter. The number is an estimate from the cost tables, not a
        // measurement of this server, and the wording says which it is.
        var cost = selectionCost();
        if (cost >= 4) {
            body.appendChild(el('div', 'gpuup-note',
                'This combination is estimated at roughly ' + Math.round(cost)
                + ' times the cheapest upscale. That is very likely below realtime here, which shows'
                + ' up as buffering and dropped frames rather than as an error. The estimate comes'
                + ' from measured costs per pass, not from this stream: check what the server'
                + ' reports below once it has negotiated.'));
        }

        if (rest.length) {
            var adv = disclosure('advanced', 'Advanced', changedCount(rest));
            // Grouped by intent inside the disclosure, in the order the groups first appear in
            // CONTROLS: another thing a new axis gets for free by naming a group in its own data.
            var groups = [];
            rest.forEach(function (c) {
                if (groups.indexOf(c.group) < 0) { groups.push(c.group); }
            });

            groups.forEach(function (g) {
                var inGroup = rest.filter(function (c) { return c.group === g && !c.expert; });
                if (!inGroup.length) {
                    return;
                }

                adv.appendChild(el('h3', null, g));
                inGroup.forEach(function (c) { adv.appendChild(pick(c)); });
            });

            // The expert clusters last, each one row until it is opened. The head control's own
            // label names the cluster, so nothing here knows what a game upscaler is.
            var clusters = [];
            rest.forEach(function (c) {
                if (c.expert && clusters.indexOf(c.expert) < 0) { clusters.push(c.expert); }
            });

            clusters.forEach(function (name) {
                var members = rest.filter(function (c) { return c.expert === name; });
                var head = members.filter(function (c) { return c.expertHead; })[0] || members[0];
                var sub = disclosure('expert-' + name, head.label, changedCount(members));
                var inner = el('div', 'gpuup-sub');
                members.forEach(function (c) { inner.appendChild(pick(c)); });
                sub.appendChild(inner);
                adv.appendChild(sub);
            });

            body.appendChild(adv);
        }

        if (!caps.full) {
            // TWO DIFFERENT THINGS, AND ONLY ONE OF THEM IS ABOUT THIS SERVER'S CAPABILITIES.
            // A server that answered "no such endpoint" really is the older generation. A probe
            // that got no answer at all - which is what happens while Jellyfin restarts - says
            // nothing about what this server can do, and claiming it did was a lie.
            body.appendChild(el('div', 'gpuup-note', caps.targetOnly
                ? 'This server understands the upscale target only, so the other axes are not offered.'
                : 'The server has not answered the capability probe, which is what happens while it'
                  + ' is restarting, so only the upscale target is offered until it does. Close this'
                  + ' and open it again to ask.'));
        }

        body.appendChild(liveSection());

        // The panel re-renders itself every few seconds to follow the session record. On a
        // television that would throw the focus away three times a minute, so the focused
        // control's position is carried across the swap.
        var focusIndex = -1;
        try {
            var before = panel.querySelectorAll(FOCUSABLE);
            for (var fi = 0; fi < before.length; fi++) {
                if (before[fi] === document.activeElement) { focusIndex = fi; break; }
            }
        } catch (e) { /* ignore */ }

        panel.innerHTML = '';
        panel.appendChild(body);
        makeDraggable(head);
        applyPanelPos(panel);

        if (focusIndex >= 0) {
            try {
                var after = panel.querySelectorAll(FOCUSABLE);
                if (after[focusIndex]) { after[focusIndex].focus(); }
            } catch (e) { /* ignore */ }
        }
    }

    function closePanel() {
        try {
            if (state.liveTimer) {
                clearInterval(state.liveTimer);
                state.liveTimer = null;
            }

            var p = document.getElementById(PANEL_ID);
            if (p && p.parentNode) {
                p.parentNode.removeChild(p);
            }

            if (state.panelKeyHandler) {
                document.removeEventListener('keydown', state.panelKeyHandler, true);
                state.panelKeyHandler = null;
            }

            if (state.onPanelResize) {
                window.removeEventListener('resize', state.onPanelResize);
                state.onPanelResize = null;
            }

            var opener = state.panelOpener;
            state.panelOpener = null;
            if (opener && typeof opener.focus === 'function'
                && document.contains && document.contains(opener)) {
                opener.focus();
            }

            state.drag = null;
        } catch (err) {
            log('close failed', err);
        }
    }

    /*
     * THE PANEL IS A PLAYBACK CONTROL, so it closes when there is no playback left to control.
     *
     * Hooked, not polled. jellyfin-web's Events helper is a plain callback registry kept ON THE
     * OBJECT (events.js: obj._callbacks[type] = [] and Events.on pushes onto that array), so
     * subscribing to the playback manager's own events needs no module access at all - pushing
     * onto the same array is exactly what Events.on does, and the module is not exported anywhere
     * this script can reach.
     *
     * PAUSE IS DELIBERATELY NOT IN THE LIST. Pausing to go and change a setting is the whole
     * reason this panel exists; closing it under the viewer's hand would be hostile. Stop, end and
     * leaving the player all raise "playbackstop", which is the event this listens to.
     */
