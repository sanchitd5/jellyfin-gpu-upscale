/*
 * GPU Upscale - jellyfin-web client hook.
 *
 * Adds one "Enhance" entry to the player's settings menu holding four independent controls:
 *
 *     Upscale to   Off / 1080p / 1440p / 4K
 *     Unblur       Off / Low / Medium / High
 *     Denoise      Off / Light (hqdn3d) / Strong (nlmeans)
 *     Detail (SR)  Off / FSRCNNX / FSRCNNX heavy / Anime4K S / Anime4K M
 *
 * One home rather than four widgets, and the Quality menu goes back to meaning bitrate only.
 *
 * The SR entries name a shader FAMILY and a WEIGHT rather than a single opaque quality ladder,
 * because the two families are different networks and which one looks right on this content is a
 * judgement for the eye.
 *
 * How the choices reach the server
 * --------------------------------
 * The picks are appended to the media source's TranscodingUrl as the query parameters
 * "upscale", "deblur", "denoise" and "sr". Jellyfin copies every query parameter whose name starts with a
 * lowercase letter into the streaming request's StreamOptions dictionary
 * (Jellyfin.Api ... ParseStreamOptions), so the server reads them back verbatim with
 * BaseRequest.GetOption(...). Unlike a bitrate or a maxHeight, nothing clamps or rewrites them.
 *
 * Every control also has a server-side default in the plugin dashboard, so the features still work
 * if none of this renders.
 *
 * Everything is wrapped in try/catch: if any of it breaks, the stock menus and normal playback are
 * untouched.
 */
(function () {
    'use strict';

    var STORE = 'gpuUpscalePrefs';

    var CONTROLS = [
        {
            key: 'upscale', label: 'Upscale to', fallback: 'off',
            options: [
                { id: 'off', name: 'Off' },
                { id: '1080', name: '1080p' },
                { id: '1440', name: '1440p' },
                { id: '2160', name: '4K (2160p)' }
            ]
        },
        {
            key: 'deblur', label: 'Unblur', fallback: 'off',
            options: [
                { id: 'off', name: 'Off' },
                { id: 'low', name: 'Low' },
                { id: 'medium', name: 'Medium' },
                { id: 'high', name: 'High' }
            ]
        },
        {
            key: 'denoise', label: 'Denoise', fallback: 'off',
            options: [
                { id: 'off', name: 'Off' },
                { id: 'light', name: 'Light (hqdn3d)' },
                { id: 'strong', name: 'Strong (nlmeans)' }
            ]
        },
        {
            // Two different networks, not one quality ladder. The name says which family and
            // which weight, so the viewer can tell them apart rather than trusting an opaque
            // "Light / Standard / Max" that hid a family swap.
            key: 'sr', label: 'Detail (super-resolution)', fallback: 'fsrcnnx',
            options: [
                { id: 'off', name: 'Off (plain scaling)' },
                { id: 'fsrcnnx', name: 'FSRCNNX' },
                { id: 'fsrcnnx-heavy', name: 'FSRCNNX heavy' },
                { id: 'anime4k-s', name: 'Anime4K S' },
                { id: 'anime4k-m', name: 'Anime4K M' }
            ]
        }
    ];

    // Names the previous build wrote into localStorage. Mapped on load so an existing viewer does
    // not come back to a control showing a level that is no longer in its own option list.
    var SR_ALIASES = { light: 'fsrcnnx', standard: 'fsrcnnx', max: 'fsrcnnx-max' };

    var state = {
        version: 8,
        installed: false,
        globals: [],
        chunks: 0,
        modulesWrapped: 0,
        sheetsSeen: 0,
        menuShown: 0,
        marked: [],
        playSessionId: null,
        lastServerState: null,
        prefs: { upscale: 'off', deblur: 'off', denoise: 'off', sr: 'fsrcnnx' }
    };
    window.__gpuUpscale = state;

    function log() {
        try {
            if (window.localStorage && window.localStorage.getItem('gpuUpscaleDebug')) {
                console.log.apply(console, ['[gpu-upscale]'].concat(Array.prototype.slice.call(arguments)));
            }
        } catch (e) { /* ignore */ }
    }

    try {
        var saved = window.localStorage && window.localStorage.getItem(STORE);
        if (saved) {
            var parsed = JSON.parse(saved);
            if (parsed && typeof parsed === 'object') {
                Object.keys(state.prefs).forEach(function (k) {
                    if (parsed[k] != null) { state.prefs[k] = parsed[k]; }
                });
                if (SR_ALIASES[state.prefs.sr]) { state.prefs.sr = SR_ALIASES[state.prefs.sr]; }
            }
        }
    } catch (e) { /* defaults stand */ }

    function savePrefs() {
        try { window.localStorage.setItem(STORE, JSON.stringify(state.prefs)); } catch (e) { /* ignore */ }
    }

    function anyEnhancement() {
        return state.prefs.upscale !== 'off' || state.prefs.deblur !== 'off' || state.prefs.denoise !== 'off';
    }

    /* ------------------------------------------------------------ the Enhance settings menu */

    /*
     * Rather than hooking the minified module that builds the player's settings list, the shared
     * action-sheet component is wrapped and the sheet is recognised by its SHAPE: the player
     * settings sheet is the one carrying an item with id "quality" or "aspectratio". That survives
     * module renumbering, and an unrecognised sheet is passed straight through.
     */
    function isPlayerSettingsSheet(items) {
        return Array.isArray(items) && items.some(function (i) {
            return i && (i.id === 'quality' || i.id === 'aspectratio' || i.id === 'playbackrate');
        });
    }

    function summaryText() {
        var bits = [];
        if (state.prefs.upscale !== 'off') { bits.push(state.prefs.upscale + 'p'); }
        if (state.prefs.deblur !== 'off') { bits.push('unblur ' + state.prefs.deblur); }
        if (state.prefs.denoise !== 'off') { bits.push('denoise ' + state.prefs.denoise); }
        return bits.length ? bits.join(', ') : 'Off';
    }

    function wrapActionSheet(ns) {
        try {
            if (!ns || typeof ns !== 'object' || ns.__gpuUpscaleSheet || typeof ns.show !== 'function') {
                return;
            }

            // Webpack defines ES module exports as non-configurable getters, so only a plain object
            // (such as an "export default { show }" component) can be wrapped. Check before
            // assigning rather than throwing inside the module factory.
            var own = Object.getOwnPropertyDescriptor(ns, 'show');
            if (own && !own.writable && !own.configurable) {
                return;
            }

            var originalShow = ns.show;
            ns.show = function (options) {
                try {
                    if (options && isPlayerSettingsSheet(options.items) && !options.__gpuUpscaleOwn) {
                        state.sheetsSeen++;
                        options.items = options.items.concat([{
                            name: 'Enhance', id: 'gpuupscale-enhance', asideText: summaryText()
                        }]);

                        var positionTo = options.positionTo;
                        var self = this;
                        return originalShow.apply(self, arguments).then(function (chosen) {
                            if (chosen !== 'gpuupscale-enhance') {
                                return chosen;
                            }

                            return openEnhanceMenu(originalShow.bind(self), positionTo).then(
                                function () { return Promise.reject(); },
                                function () { return Promise.reject(); });
                        });
                    }
                } catch (err) {
                    log('sheet wrap failed', err);
                }

                return originalShow.apply(this, arguments);
            };

            ns.__gpuUpscaleSheet = true;
            state.sheetWraps = (state.sheetWraps || 0) + 1;
        } catch (err) {
            log('could not wrap action sheet', err);
        }
    }

    /*
     * The server-side half of this plugin ships in two generations. The older one only understands
     * an upscale target (signalled with maxHeight); the newer one also honours "deblur" and "sr"
     * and serves /GpuUpscale/Session/{id}. Probe for the newer endpoint and only offer the controls
     * the running server can actually act on, so the menu never promises something that will
     * silently do nothing.
     */
    /*
     * Only a SUCCESSFUL probe is cached. A failure is deliberately not remembered: the probe fails
     * while the server is restarting, and caching that for the life of the page left the Enhance
     * menu showing nothing but "Upscale to" until the viewer reloaded, with no way to tell why.
     * A failed probe is retried the next time the menu is opened.
     */
    function probeServer() {
        if (state.serverCaps && state.serverCaps.full) {
            return Promise.resolve(state.serverCaps);
        }

        var no = { full: false };
        try {
            var client = window.ApiClient;
            if (!client || typeof client.getUrl !== 'function') {
                return Promise.resolve(no);
            }

            return client.ajax({
                type: 'GET',
                url: client.getUrl('GpuUpscale/Session/probe'),
                dataType: 'json'
            }).then(function () {
                state.serverCaps = { full: true };
                log('server probe: full capabilities');
                return state.serverCaps;
            }, function (err) {
                log('server probe failed; will retry on next menu open', err);
                return no;
            });
        } catch (err) {
            return Promise.resolve(no);
        }
    }

    function openEnhanceMenu(show, positionTo) {
        state.menuShown++;
        // Re-probe here rather than trusting a cached answer, so a menu opened after a server
        // restart recovers the full control set instead of being stuck on "Upscale to".
        return probeServer().then(function (caps) {
            return buildEnhanceMenu(show, positionTo, caps || { full: false });
        });
    }

    function buildEnhanceMenu(show, positionTo, caps) {
        var controls = caps.full ? CONTROLS : CONTROLS.filter(function (c) { return c.key === 'upscale'; });
        var items = controls.map(function (c) {
            var current = state.prefs[c.key] || c.fallback;
            var opt = c.options.filter(function (o) { return o.id === current; })[0];
            return { name: c.label, id: c.key, asideText: opt ? opt.name : current };
        });
        if (caps.full) {
            items.push({ name: 'What the server did', id: 'gpuupscale-what' });
        }

        return show({ items: items, positionTo: positionTo, __gpuUpscaleOwn: true }).then(function (chosen) {
            if (chosen === 'gpuupscale-what') {
                return describeServerState();
            }

            var control = controls.filter(function (c) { return c.key === chosen; })[0];
            if (!control) {
                return null;
            }

            var current = state.prefs[control.key] || control.fallback;
            var opts = control.options.map(function (o) {
                return { id: o.id, name: o.name, selected: o.id === current };
            });
            return show({ items: opts, positionTo: positionTo, __gpuUpscaleOwn: true }).then(function (picked) {
                if (picked == null) {
                    return null;
                }

                state.prefs[control.key] = String(picked);
                savePrefs();
                log('preference', control.key, picked);
                // The choice applies to the next stream negotiation; nudge the player to re-fetch.
                requestRestream();
                return null;
            });
        });
    }

    /*
     * Making the choice take effect means getting a fresh PlaybackInfo. jellyfin-web re-requests it
     * when the max streaming bitrate changes, so the smallest honest nudge is to re-apply the value
     * it already has. If the hook is not reachable the viewer can simply restart playback, which is
     * also what the menu says.
     */
    function requestRestream() {
        try {
            var pm = window.playbackManager;
            if (pm && typeof pm.getMaxStreamingBitrate === 'function' && typeof pm.setMaxStreamingBitrate === 'function') {
                var current = pm.getMaxStreamingBitrate();
                pm.setMaxStreamingBitrate({ enableAutomaticBitrateDetection: false, maxBitrate: current });
                log('asked the player to renegotiate');
            }
        } catch (err) {
            log('could not nudge the player; playback restart needed', err);
        }
    }

    /* ------------------------------------------------- what the server actually did (honest) */

    function fetchServerState() {
        if (!state.playSessionId) {
            return Promise.resolve(null);
        }

        try {
            var client = window.ApiClient;
            if (!client || typeof client.getUrl !== 'function') {
                return Promise.resolve(null);
            }

            return client.ajax({
                type: 'GET',
                url: client.getUrl('GpuUpscale/Session/' + encodeURIComponent(state.playSessionId)),
                dataType: 'json'
            }).then(function (s) {
                state.lastServerState = s;
                return s;
            }, function () { return null; });
        } catch (err) {
            return Promise.resolve(null);
        }
    }

    function describeServerState() {
        return fetchServerState().then(function (s) {
            var text = s && s.Summary ? s.Summary : 'Not known for this session';
            try {
                if (window.Dashboard && window.Dashboard.alert) {
                    window.Dashboard.alert({ title: 'Enhance', message: text });
                } else {
                    window.alert(text);
                }
            } catch (e) { /* ignore */ }

            return null;
        });
    }

    /*
     * Adds a row to the playback info dialog. Done by watching the DOM for the dialog rather than
     * hooking the module that builds it: the row is appended to whatever list the dialog already
     * renders, and if the shape is not recognised nothing is added and the dialog renders normally.
     */
    function watchPlaybackInfoDialog() {
        try {
            var observer = new MutationObserver(function (records) {
                records.forEach(function (record) {
                    Array.prototype.forEach.call(record.addedNodes || [], function (node) {
                        if (!node || node.nodeType !== 1 || !node.querySelectorAll) {
                            return;
                        }

                        var dialogs = node.matches && node.matches('.dialog, [is="emby-dialog"], .actionSheet')
                            ? [node] : Array.prototype.slice.call(node.querySelectorAll('.dialog, .actionSheet'));
                        dialogs.forEach(maybeAnnotate);
                    });
                });
            });
            observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
        } catch (err) {
            log('dialog observer failed', err);
        }
    }

    function maybeAnnotate(dialog) {
        try {
            if (!dialog || dialog.__gpuUpscaleAnnotated) {
                return;
            }

            var text = dialog.textContent || '';
            // The playback info dialog is the one listing the player and the play method.
            if (!/Playback Info|Play method|Player:/i.test(text)) {
                return;
            }

            dialog.__gpuUpscaleAnnotated = true;
            fetchServerState().then(function (s) {
                try {
                    if (!s) {
                        return;
                    }

                    var row = document.createElement('div');
                    row.className = 'gpuUpscaleStatsRow';
                    row.style.padding = '0.35em 0';
                    row.textContent = 'Enhance: ' + (s.Summary || 'No enhancement');
                    var host = dialog.querySelector('.dialogContent, .formDialogContent, .actionSheetContent') || dialog;
                    host.appendChild(row);
                    log('annotated playback info with', s.Summary);
                } catch (err) {
                    log('annotate failed', err);
                }
            });
        } catch (err) {
            log('annotate check failed', err);
        }
    }

    /* ---------------------------------------------------------------- webpack module wrapping */

    function wrapChunkModules(chunk) {
        try {
            if (!chunk || chunk.__gpuUpscaleSeen) {
                return;
            }

            chunk.__gpuUpscaleSeen = true;
            var modules = chunk[1];
            if (!modules) {
                return;
            }

            Object.keys(modules).forEach(function (id) {
                var factory = modules[id];
                if (typeof factory !== 'function') {
                    return;
                }

                state.modulesWrapped++;
                modules[id] = function (module, exports) {
                    var result = factory.apply(this, arguments);
                    try {
                        if (exports) {
                            wrapActionSheet(exports.Ay);
                            wrapActionSheet(exports.default);
                            wrapActionSheet(exports);
                        }
                    } catch (err) {
                        log('module wrap failed', err);
                    }

                    return result;
                };
            });
        } catch (err) {
            log('chunk wrap failed', err);
        }
    }

    /*
     * Webpack registers a chunk's modules and only then calls the previous push, so simply wrapping
     * push before webpack boots would be too late. The push property is defined with an accessor
     * instead, so webpack's own jsonp callback lands in `installed` while callers keep getting our
     * wrapper, which rewrites the chunk's modules before handing it on.
     *
     * This build's chunk-loading global is the bare "webpackChunk" (runtime.bundle.js:
     * self.webpackChunk=self.webpackChunk||[]); the jellyfin-web source name is kept as a fallback.
     */
    var GLOBALS = ['webpackChunk', 'webpackChunkjellyfin_web'];

    function hookChunkGlobal(key) {
        var chunks = window[key] = window[key] || [];
        if (chunks.__gpuUpscaleHooked) {
            return;
        }

        var nativePush = Array.prototype.push;
        var installed = null;
        var reentrant = false;

        var wrapper = function (chunk) {
            state.chunks++;
            wrapChunkModules(chunk);
            if (installed && !reentrant) {
                reentrant = true;
                try {
                    return installed.call(chunks, chunk);
                } finally {
                    reentrant = false;
                }
            }

            return nativePush.call(chunks, chunk);
        };

        Object.defineProperty(chunks, 'push', {
            configurable: true,
            get: function () { return wrapper; },
            set: function (value) { installed = value; }
        });

        chunks.__gpuUpscaleHooked = true;
        chunks.forEach(wrapChunkModules);
        state.globals.push(key);
    }

    function hookWebpack() {
        GLOBALS.forEach(function (key) {
            try {
                hookChunkGlobal(key);
            } catch (err) {
                log('webpack hook failed for ' + key, err);
            }
        });
    }

    /* ------------------------------------------------------- PlaybackInfo response rewriting */

    function addParams(url) {
        if (!url) {
            return url;
        }

        var out = url;
        var params = { upscale: state.prefs.upscale || 'off' };
        if (state.serverCaps && state.serverCaps.full) {
            params.deblur = state.prefs.deblur || 'off';
            params.denoise = state.prefs.denoise || 'off';
            params.sr = state.prefs.sr || 'fsrcnnx';
        }

        // Compatibility: the first server-side version of this plugin keyed off maxHeight. Sending
        // both means this script works against either server build; the newer one prefers
        // "upscale" and only falls back to maxHeight.
        if (params.upscale !== 'off' && /^\d+$/.test(params.upscale)) {
            params.maxHeight = params.upscale;
        }

        Object.keys(params).forEach(function (k) {
            var re = new RegExp('([?&])' + k + '=[^&]*');
            if (re.test(out)) {
                out = out.replace(re, '$1' + k + '=' + encodeURIComponent(params[k]));
            } else {
                out += (out.indexOf('?') === -1 ? '?' : '&') + k + '=' + encodeURIComponent(params[k]);
            }
        });

        return out;
    }

    function rewriteBody(bodyText) {
        var info = JSON.parse(bodyText);
        if (!info) {
            return null;
        }

        if (info.PlaySessionId) {
            state.playSessionId = info.PlaySessionId;
        }

        if (!info.MediaSources || !anyEnhancement()) {
            return null;
        }

        var touched = false;
        info.MediaSources.forEach(function (source) {
            if (source.TranscodingUrl) {
                source.TranscodingUrl = addParams(source.TranscodingUrl);
                // Make sure the client actually uses the transcode we just marked.
                source.SupportsDirectPlay = false;
                source.SupportsDirectStream = false;
                touched = true;
            }
        });

        if (!touched) {
            log('no TranscodingUrl to mark; playing without enhancement');
            return null;
        }

        state.marked.push(state.prefs.upscale + '/' + state.prefs.deblur + '/' + state.prefs.denoise + '/' + state.prefs.sr);
        return JSON.stringify(info);
    }

    /*
     * THE DIRECT-PLAY PROBLEM.
     *
     * When the client can direct play a file, Jellyfin's PlaybackInfo response carries NO
     * TranscodingUrl at all - not an unused one, none. There is therefore nothing for this script
     * to mark, no ffmpeg command is ever built, and the server honestly reports "No enhancement"
     * however many options the viewer picked. Clearing SupportsDirectPlay on the RESPONSE does not
     * help either: without a TranscodingUrl the player has nothing to fall back to.
     *
     * So the marking has to happen on the REQUEST. Jellyfin's PlaybackInfo accepts
     * EnableDirectPlay / EnableDirectStream; setting both to false makes it return a real
     * TranscodingUrl, which the response rewrite below then marks as usual.
     *
     * This is only done when the viewer actually asked for enhancement - otherwise direct play is
     * left alone, because forcing a transcode nobody asked for would burn GPU for nothing.
     */
    var DIRECT_PLAY_OFF = { EnableDirectPlay: false, EnableDirectStream: false };

    function forceTranscodeUrl(url) {
        if (!url || !anyEnhancement()) {
            return url;
        }

        var out = url;
        // The GET form of the endpoint reads these from the query string.
        ['enableDirectPlay', 'enableDirectStream'].forEach(function (k) {
            var re = new RegExp('([?&])' + k + '=[^&]*', 'i');
            if (re.test(out)) {
                out = out.replace(re, '$1' + k + '=false');
            } else {
                out += (out.indexOf('?') === -1 ? '?' : '&') + k + '=false';
            }
        });
        return out;
    }

    function forceTranscodeBody(bodyText) {
        if (!anyEnhancement()) {
            return null;
        }

        try {
            if (typeof bodyText !== 'string' || !bodyText) {
                return null;
            }

            var body = JSON.parse(bodyText);
            if (!body || typeof body !== 'object') {
                return null;
            }

            if (body.EnableDirectPlay === false && body.EnableDirectStream === false) {
                return null;
            }

            body.EnableDirectPlay = false;
            body.EnableDirectStream = false;
            log('forcing a transcode for PlaybackInfo so there is something to enhance');
            return JSON.stringify(body);
        } catch (err) {
            log('could not rewrite PlaybackInfo request body', err);
            return null;
        }
    }

    function hookFetch() {
        if (!window.fetch) {
            return;
        }

        var originalFetch = window.fetch;
        window.fetch = function (input, init) {
            var url;
            try {
                url = typeof input === 'string' ? input : (input && input.url);
            } catch (e) {
                url = null;
            }

            var args = arguments;
            if (url && url.indexOf('/PlaybackInfo') !== -1 && anyEnhancement()) {
                try {
                    var newUrl = forceTranscodeUrl(url);
                    if (typeof input === 'string') {
                        var newInit = init || {};
                        var rewrittenBody = forceTranscodeBody(newInit.body);
                        if (rewrittenBody) {
                            newInit = Object.assign({}, newInit, { body: rewrittenBody });
                        }

                        args = [newUrl, newInit];
                        url = newUrl;
                    } else if (input && typeof Request !== 'undefined' && input instanceof Request) {
                        // A Request body can only be read asynchronously, so rebuild it from the
                        // clone and hand the whole call over to that promise.
                        var self = this;
                        return input.clone().text().then(function (text) {
                            var rb = forceTranscodeBody(text);
                            var req = new Request(newUrl, {
                                method: input.method,
                                headers: input.headers,
                                body: rb || (input.method === 'GET' || input.method === 'HEAD' ? undefined : text),
                                mode: input.mode,
                                credentials: input.credentials,
                                cache: input.cache,
                                redirect: input.redirect,
                                referrer: input.referrer
                            });
                            return handlePlaybackInfo(originalFetch.call(self, req));
                        }, function () {
                            return handlePlaybackInfo(originalFetch.apply(self, args));
                        });
                    }
                } catch (err) {
                    log('could not force a transcode on the PlaybackInfo request', err);
                }
            }

            var promise = originalFetch.apply(this, args);
            if (!url || url.indexOf('/PlaybackInfo') === -1) {
                return promise;
            }

            return handlePlaybackInfo(promise);
        };

        function handlePlaybackInfo(promise) {

            return promise.then(function (response) {
                try {
                    return response.clone().text().then(function (text) {
                        try {
                            var rewritten = rewriteBody(text);
                            if (!rewritten) {
                                return response;
                            }

                            return new Response(rewritten, {
                                status: response.status,
                                statusText: response.statusText,
                                headers: new Headers(response.headers)
                            });
                        } catch (err) {
                            log('rewrite failed', err);
                            return response;
                        }
                    }, function () { return response; });
                } catch (err) {
                    return response;
                }
            });
        };
    }

    function hookXhr() {
        if (!window.XMLHttpRequest) {
            return;
        }

        var proto = window.XMLHttpRequest.prototype;
        var originalOpen = proto.open;
        var originalSend = proto.send;

        proto.open = function (method, url) {
            try {
                this.__gpuUpscaleUrl = url;
                if (url && url.indexOf('/PlaybackInfo') !== -1 && anyEnhancement()) {
                    var forced = forceTranscodeUrl(url);
                    if (forced !== url) {
                        this.__gpuUpscaleUrl = forced;
                        var args = Array.prototype.slice.call(arguments);
                        args[1] = forced;
                        return originalOpen.apply(this, args);
                    }
                }
            } catch (e) { /* ignore */ }
            return originalOpen.apply(this, arguments);
        };

        proto.send = function (body) {
            var outgoing = body;

            try {
                var url = this.__gpuUpscaleUrl;
                if (url && url.indexOf('/PlaybackInfo') !== -1) {
                    // Request side: make sure a TranscodingUrl will exist to mark.
                    var rewrittenBody = forceTranscodeBody(body);
                    if (rewrittenBody) {
                        outgoing = rewrittenBody;
                    }

                    // Response side: mark the TranscodingUrl that now comes back.
                    var xhr = this;
                    Object.defineProperty(xhr, 'responseText', {
                        configurable: true,
                        get: function () {
                            var raw = Object.getOwnPropertyDescriptor(
                                window.XMLHttpRequest.prototype, 'responseText').get.call(xhr);
                            try {
                                return rewriteBody(raw) || raw;
                            } catch (err) {
                                return raw;
                            }
                        }
                    });
                }
            } catch (err) {
                log('xhr hook failed', err);
            }

            return originalSend.call(this, outgoing);
        };
    }

    try {
        hookWebpack();
        hookFetch();
        hookXhr();
        watchPlaybackInfoDialog();
        probeServer();
        state.installed = true;
        log('installed on', state.globals.join(', '));
    } catch (err) {
        /* never break the web client */
    }
})();
