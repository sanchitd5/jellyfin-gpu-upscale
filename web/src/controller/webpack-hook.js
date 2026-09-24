import { state } from '../model/state.js';
import { log } from '../lib/log.js';
import { wrapActionSheet } from './action-sheet.js';
import { notePlaybackManager } from './live-apply.js';

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
                        notePlaybackManager(exports);
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
    log('hookChunkGlobal: start, key=' + key);
    var chunks = window[key] = window[key] || [];
    if (chunks.__gpuUpscaleHooked) {
        log('hookChunkGlobal: end, ' + key + ' already hooked');
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
    log('hookChunkGlobal: end, hooked ' + key + ', ' + chunks.length + ' pre-existing chunks wrapped');
}

// wrapChunkModules() itself is NOT logged at entry/exit: it runs once per chunk pushed, and each
// chunk wraps every one of its module factories - thousands of calls during a normal page boot
// (state.chunks/state.modulesWrapped already count them). A log line per call would drown out
// everything else; the meaningful events (a match found) are already logged inside
// notePlaybackManager()/wrapActionSheet() themselves.
export function hookWebpack() {
    log('hookWebpack: start');
    GLOBALS.forEach(function (key) {
        try {
            hookChunkGlobal(key);
        } catch (err) {
            log('webpack hook failed for ' + key, err);
        }
    });
    log('hookWebpack: end, globals=' + state.globals.join(','));
}
