import { state } from '../model/state.js';
import { summaryText } from '../model/effective.js';
import { openEnhancePanel } from './playback-hooks.js';
import { log } from '../lib/log.js';

/*
 * Rather than hooking the minified module that builds the player's settings list, the shared
 * action-sheet component is wrapped and the sheet is recognised by its SHAPE: the player
 * settings sheet is the one carrying an item with id "quality" or "aspectratio". That survives
 * module renumbering, and an unrecognised sheet is passed straight through.
 *
 * The sheet is the ENTRY POINT ONLY. Choosing "Enhance" opens one flat panel of this script's
 * own making - every control on one surface, no drill-down, no back buttons - so nothing below
 * depends on the action sheet's shape beyond that single entry.
 */
export function isPlayerSettingsSheet(items) {
    return Array.isArray(items) && items.some(function (i) {
        return i && (i.id === 'quality' || i.id === 'aspectratio' || i.id === 'playbackrate');
    });
}

export function wrapActionSheet(ns) {
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

                    var self = this;
                    return originalShow.apply(self, arguments).then(function (chosen) {
                        if (chosen !== 'gpuupscale-enhance') {
                            return chosen;
                        }

                        openEnhancePanel();
                        return Promise.reject();
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
