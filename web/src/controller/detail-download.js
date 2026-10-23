import { log } from '../lib/log.js';
import { watchDetail } from './detail-page.js';

/*
 * A VISIBLE DOWNLOAD BUTTON FOR VIDEOS (QOL_IDEAS #24).
 *
 * The details page template already carries a Download button (.btnDownload, with `hide`) and the
 * controller already binds its click (onDownloadClick); but only Books ever get it shown
 * (itemDetails/index.js: `item.Type === 'Book' && item.CanDownload && appHost.supports(FileDownload)`).
 * Every other type has Download only inside the "more" menu. This takes `hide` off that same
 * button for a video the viewer may download, so the click is the stock one and nothing is
 * re-implemented.
 *
 * Shown only when all of these hold, which are the stock handler's own needs plus the server's
 * word that downloading is allowed:
 *  - the item is a video (MediaType Video: Video, Movie, Episode, ... not a folder or a series);
 *  - the DTO says CanDownload (the server computes it from the user's EnableContentDownloading
 *    policy, DtoService.cs), so a user who may not download never sees the button;
 *  - the DTO has a Path, because onDownloadClick derives the file name from it and throws without;
 *  - not a TV layout (stock excludes TV browsers from FileDownload, and the D-pad row is untouched).
 * The button is hidden again on a later item that fails the test, but only if this module showed it
 * (a Book's button belongs to stock).
 */

var MARK = 'data-jp-download';

function eligible(item) {
    return !document.documentElement.classList.contains('layout-tv')
        && item.MediaType === 'Video'
        && item.CanDownload === true
        && typeof item.Path === 'string'
        && item.Path !== '';
}

function sync(page, item) {
    var show = eligible(item);
    Array.prototype.forEach.call(page.querySelectorAll('.btnDownload'), function (btn) {
        if (show) {
            btn.setAttribute(MARK, '1');
            btn.classList.remove('hide');
        } else if (btn.hasAttribute(MARK)) {
            btn.removeAttribute(MARK);
            btn.classList.add('hide');
        }
    });
    if (show) {
        log('detail download: button shown');
    }
}

function reset(page) {
    // The previous item's decision must not outlive it while the next one loads.
    Array.prototype.forEach.call(page.querySelectorAll('.btnDownload[' + MARK + ']'), function (btn) {
        btn.removeAttribute(MARK);
        btn.classList.add('hide');
    });
}

export function installDetailDownload() {
    if (!document.body) {
        document.addEventListener('DOMContentLoaded', installDetailDownload, { once: true });
        return;
    }

    try {
        watchDetail({ start: reset, item: sync });
        log('detail download: installed');
    } catch (err) {
        log('detail download: install failed', err);
    }
}
