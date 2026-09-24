import { state } from '../model/state.js';
import { GAME_OPTION_KEYS } from '../model/controls-data.js';
import { effective, anyEnhancement } from '../model/effective.js';
import { resetUpscaleForNewSource } from './playback-hooks.js';
import { log } from '../lib/log.js';

/*
 * WHAT THIS SESSION WOULD SEND, as a plain object and with no URL involved. Split out so that the
 * live block can compare what is on the wire NOW against what was on the wire when the stream
 * that is playing was negotiated. The same code builds both, so the comparison cannot drift from
 * what is actually sent.
 */
export function wireParams() {
    var e = effective();
    if (!e) {
        return null;
    }

    var params = {};
    // A null target means "no opinion on the size": the marker is left off entirely so the
    // server's own TargetHeight applies, exactly as it does for a client without this script.
    if (e.upscale != null) {
        params.upscale = e.upscale;
    }

    // UNKNOWN CAPABILITIES ARE NOT "NO CAPABILITIES". A failed probe is not cached on purpose,
    // so serverCaps stays undefined while the server restarts; gating on it meant that one
    // failed boot probe dropped every axis but the target from every request for the life of
    // the page, silently. Sending them is safe - a server that does not read a parameter
    // ignores it - and re-probing from here is not, since this is called synchronously while a
    // URL is being built. Only a probe that positively answered "target only" suppresses them.
    if (!state.serverCaps || state.serverCaps.full) {
        params.deblur = e.deblur || 'off';
        params.denoise = e.denoise || 'off';
        params.sr = e.sr || 'off';
        if (state.prefs.deband && state.prefs.deband !== 'default') {
            params.deband = state.prefs.deband;
        }

        if (state.prefs.kernel && state.prefs.kernel !== 'default') {
            params.kernel = state.prefs.kernel;
        }

        // Refine and chroma ride alongside the ladder rather than inside it: they compose with
        // every stage, so they are sent from the preference regardless of which stage is in
        // force, exactly as Debanding and the scaling kernel already are. 'default' sends
        // nothing at all, so the dashboard's own value applies.
        if (state.prefs.refine && state.prefs.refine !== 'default') {
            params.refine = state.prefs.refine;
        }

        if (state.prefs.chroma && state.prefs.chroma !== 'default') {
            params.chroma = state.prefs.chroma;
        }

        // The neural and game axes ride alongside the ladder exactly as refine and chroma do:
        // they compose with every stage, so they are sent from the preference whichever stage
        // is in force - unless the viewer said Off, where `effective()` has already made them
        // off and this sends that. Compression cleanup rides alongside the ladder for the same
        // reason: no generated stage sets it, so it is sent from the preference whichever stage
        // is in force, and Off is sent as off because `effective()` has already made it so.
        params.deblock = e.deblock != null ? e.deblock : (state.prefs.deblock || 'off');
        params.neural = e.neural != null ? e.neural : (state.prefs.neural || 'off');
        params.game = e.game != null ? e.game : (state.prefs.game || 'off');

        // The three game-upscaler inputs, on the same rule that hides their rows: sent only
        // while the level in force is one the server says they act on, and only when the
        // viewer picked something other than "Server default". Otherwise nothing is written
        // and the dashboard value stands.
        GAME_OPTION_KEYS.forEach(function (k) {
            var acts = (state.serverCaps && state.serverCaps.levels
                && state.serverCaps.levels.GameOptionLevels) || [];
            if (acts.indexOf(params.game) >= 0 && state.prefs[k] && state.prefs[k] !== 'default') {
                params[k] = state.prefs[k];
            }
        });
    }

    // Compatibility: the first server-side version of this plugin keyed off maxHeight. Sending
    // both means this script works against either server build; the newer one prefers
    // "upscale" and only falls back to maxHeight.
    if (params.upscale && params.upscale !== 'off' && /^\d+$/.test(params.upscale)) {
        params.maxHeight = params.upscale;
    }

    // The A/B live-apply swap marker: the OLD PlaySessionId, present only for the one
    // re-negotiation live-apply.js just triggered (see doApply()), riding the same lowercase-
    // query-parameter transport as every other axis here rather than a new one. Rides on the
    // negotiation request AND the HLS requests it produces for the same reason the other axes
    // do (see markHlsUrl below): the server reads it wherever a session's own options are read.
    if (state.swapFrom) {
        params.swapfrom = state.swapFrom;
    }

    return params;
}

/*
 * The same object as one comparable string. Order-independent, so it can never report a
 * difference that is only key order.
 */
export function paramSig(params) {
    return params === null ? null : Object.keys(params).sort().map(function (k) {
        return k + '=' + params[k];
    }).join('&');
}

export function addParams(url) {
    var params = wireParams();
    if (!url || !params) {
        return url;
    }

    // Only a negotiation records what was sent. The HLS marking below runs per playlist and
    // per segment, and letting it write here would keep resetting the comparison the stale
    // note depends on, so a changed selection would stop announcing itself.
    state.sentSig = paramSig(params);
    return applyParams(url, params);
}

/* The same append, without claiming a negotiation happened. */
export function markHlsUrl(url) {
    var params = wireParams();
    return (!url || !params) ? url : applyParams(url, params);
}

function applyParams(url, params) {
    var out = url;

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

/*
 * The source height, out of the media source the server just described. The client DOES know
 * this: PlaybackInfo carries MediaStreams with Height for every source, and this script already
 * reads that response. Knowing it is what lets the menu drop targets at or below the source
 * instead of offering a downscale as an improvement.
 */
function noteSourceHeight(info) {
    try {
        var sources = info && info.MediaSources;
        if (!sources || !sources.length) {
            return;
        }

        for (var i = 0; i < sources.length; i++) {
            var streams = sources[i] && sources[i].MediaStreams;
            if (!streams) {
                continue;
            }

            for (var j = 0; j < streams.length; j++) {
                var st = streams[j];
                if (st && st.Type === 'Video' && st.Height > 0) {
                    if (state.sourceHeight !== st.Height) {
                        log('source height', st.Height);
                    }

                    state.sourceHeight = st.Height;
                    return;
                }
            }
        }
    } catch (err) {
        log('could not read the source height', err);
    }
}

function rewriteBody(bodyText) {
    var info = JSON.parse(bodyText);
    if (!info) {
        return null;
    }

    if (info.PlaySessionId) {
        // The swap marker has done its job once a session id actually comes back on this
        // negotiation - clearing it here (not right after sending) is what lets it also ride
        // the HLS master/variant requests this same negotiation produces, without leaking onto
        // a later, unrelated one.
        if (info.PlaySessionId !== state.playSessionId) {
            state.swapFrom = null;
        }

        state.playSessionId = info.PlaySessionId;
    }

    // Before any early return: the menu needs this even for a session it does not mark.
    noteSourceHeight(info);
    resetUpscaleForNewSource(info);

    var e = effective();
    if (!info.MediaSources || !e) {
        // No opinion from this viewer, so nothing is marked and the server's defaults stand.
        return null;
    }

    var enhancing = anyEnhancement();
    var touched = false;
    info.MediaSources.forEach(function (source) {
        if (!source.TranscodingUrl) {
            return;
        }

        source.TranscodingUrl = addParams(source.TranscodingUrl);
        if (enhancing) {
            // Make sure the client actually uses the transcode we just marked.
            source.SupportsDirectPlay = false;
            source.SupportsDirectStream = false;
        }
        // WHEN THE VIEWER SAID OFF, DIRECT PLAY IS LEFT EXACTLY AS JELLYFIN DECIDED IT.
        // The URL still carries upscale=off so that IF this session ends up transcoding for
        // some other reason, the server knows this is "off" and not "said nothing", and so
        // leaves its own defaults out of it. Nothing here pushes the session off direct play.

        touched = true;
    });

    if (!touched) {
        log(enhancing ? 'no TranscodingUrl to mark; playing without enhancement' : 'off: nothing to mark, direct play stands');
        return null;
    }

    state.marked.push([e.upscale, e.deblur, e.denoise, e.sr, e.neural, e.game].join('/'));
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

// Case-insensitive, and shared by both hooks: a match that depends on the endpoint's exact
// spelling fails silently and completely, which is the worst shape a failure can take here.
var IS_PLAYBACK_INFO = /\/playbackinfo(\?|$|\/)/i;

/*
 * THE REQUEST THAT BUILDS THE COMMAND IS NOT THE ONE THIS SCRIPT MARKS.
 *
 * The TranscodingUrl marked on the PlaybackInfo response is the MASTER playlist. Jellyfin then
 * writes the VARIANT urls into that playlist itself, carrying the parameters it knows about and
 * dropping ours, and it is the variant request that actually starts ffmpeg. So a session whose
 * axes were marked perfectly still transcoded on the dashboard defaults, and reported honestly
 * on those, while the panel showed the viewer's own picks: the server never saw them.
 *
 * hls.js fetches that variant through the same fetch and XHR this script already wraps, so the
 * axes are appended there too. Marking the request that builds the command is the only place
 * that cannot be undone by a playlist somebody else generates.
 */
var IS_HLS_MEDIA = /\/videos\/[^?]*\/(main\.m3u8|master\.m3u8|hls1\/|live\.m3u8)/i;

export function hookFetch() {
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

        // Any HLS request for this session, not only the one this script handed over.
        if (url && IS_HLS_MEDIA.test(url) && !IS_PLAYBACK_INFO.test(url)) {
            try {
                var marked = markHlsUrl(url);
                if (marked !== url) {
                    if (typeof input === 'string') {
                        args = [marked, init];
                    } else if (input && typeof Request !== 'undefined' && input instanceof Request) {
                        args = [new Request(marked, input), init];
                    }

                    url = marked;
                }
            } catch (err) {
                log('could not mark the HLS request', err);
            }
        }

        if (url && IS_PLAYBACK_INFO.test(url) && anyEnhancement()) {
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
        if (!url || !IS_PLAYBACK_INFO.test(url)) {
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

export function hookXhr() {
    if (!window.XMLHttpRequest) {
        return;
    }

    var proto = window.XMLHttpRequest.prototype;
    var originalOpen = proto.open;
    var originalSend = proto.send;

    proto.open = function (method, url) {
        try {
            this.__gpuUpscaleUrl = url;
            // Case-insensitive: the endpoint is spelled PlaybackInfo today, and a match that
            // depends on that spelling fails silently and completely, which is the worst shape
            // a failure can take here.
            // Same reason as the fetch hook: the variant playlist is where the command is
            // built, and it is fetched without the axes unless they are put back here.
            if (url && IS_HLS_MEDIA.test(url) && !IS_PLAYBACK_INFO.test(url)) {
                var markedUrl = markHlsUrl(url);
                if (markedUrl !== url) {
                    this.__gpuUpscaleUrl = markedUrl;
                    var hlsArgs = Array.prototype.slice.call(arguments);
                    hlsArgs[1] = markedUrl;
                    return originalOpen.apply(this, hlsArgs);
                }
            }

            if (url && IS_PLAYBACK_INFO.test(url) && anyEnhancement()) {
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
            if (url && IS_PLAYBACK_INFO.test(url)) {
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
