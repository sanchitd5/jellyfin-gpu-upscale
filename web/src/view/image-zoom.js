import { log } from '../lib/log.js';
import { el } from '../lib/dom.js';

/*
 * TAP-TO-ZOOM ON THE ITEM DETAILS POSTER.
 *
 * jellyfin-web 12.1's details page (apps/legacy/controllers/itemDetails) draws the poster as a
 * card inside .detailImageContainer: a .cardImageContainer whose image is lazy-loaded from
 * data-src into an inline background-image, at a quarter of the window width. Nothing happens
 * when it is tapped. This makes a tap open the image full screen, at FULL resolution:
 *
 *  - the image URL is read from that element (data-src, else the background-image) - found by
 *    shape in the DOM, never through a global ApiClient - and the sizing parameters cardBuilder
 *    adds (fillWidth/fillHeight/maxWidth/...) are dropped so the server sends the original;
 *  - the thumbnail already on screen shows at once, the full-size image replaces it when loaded;
 *  - tap the image to toggle fit-to-screen / actual size (panning by scroll or drag); pinch-zoom
 *    is the browser's own;
 *  - close with the X button, a tap on the dark backdrop, or Escape.
 *
 * One delegated click listener and one stylesheet: no observer, no per-page wiring. A zoom_in
 * badge is drawn on the poster by CSS alone so the option is visible, not just discoverable.
 */

var STYLE_ID = 'gpuUpscaleImageZoomStyle';
var OVERLAY_ID = 'gpuUpscaleImageZoom';
var POSTER = '#itemDetailPage .detailImageContainer .cardImageContainer';

// cardBuilder's sizing parameters. Removing them asks the server for the stored image.
var SIZE_PARAMS = /^(fillwidth|fillheight|maxwidth|maxheight|width|height|quality)$/i;

// An item with no primary image still gets the card, with data-src="" (seen live). Badge and
// cursor only where there is an image to open; the lazy loader removes data-src once it loads.
var HAS_IMAGE = ':not([data-src=""])';

var CSS = [
    POSTER + HAS_IMAGE + ' { cursor: zoom-in !important; }',
    '#itemDetailPage .detailImageContainer .cardScalable { position: relative; }',
    '#itemDetailPage .detailImageContainer .cardScalable:has(> .cardImageContainer' + HAS_IMAGE + ')::after {'
        + ' content: "zoom_in"; font-family: "Material Icons"; font-feature-settings: "liga";'
        + ' position: absolute; right: 0.4em; bottom: 0.4em; font-size: 1.4em; line-height: 1;'
        + ' padding: 0.25em; border-radius: 50%; color: #fff; background: rgba(0,0,0,0.55);'
        + ' pointer-events: none; }',
    '#' + OVERLAY_ID + ' { position: fixed; inset: 0; z-index: 100000; background: rgba(0,0,0,0.92);'
        + ' overflow: auto; overscroll-behavior: contain; display: flex; }',
    '#' + OVERLAY_ID + ' img { margin: auto; max-width: 100vw; max-height: 100vh; object-fit: contain;'
        + ' cursor: zoom-in; user-select: none; -webkit-user-drag: none; }',
    '#' + OVERLAY_ID + '.zoomed img { max-width: none; max-height: none; cursor: zoom-out; }',
    '#' + OVERLAY_ID + ' button { position: fixed; top: 0.6em; right: 0.6em; z-index: 1;'
        + ' width: 2.6em; height: 2.6em; border: 0; border-radius: 50%; cursor: pointer;'
        + ' color: #fff; background: rgba(0,0,0,0.6); font-family: "Material Icons";'
        + ' font-feature-settings: "liga"; font-size: 1.4em; line-height: 2.6em; padding: 0; }'
].join('\n');

function imageUrl(node) {
    var url = node.getAttribute('data-src');
    if (!url) {
        var bg = node.style && node.style.backgroundImage;
        var m = bg && /url\(["']?(.*?)["']?\)/.exec(bg);
        url = m ? m[1] : '';
    }

    return url || null;
}

export function fullSizeUrl(url) {
    try {
        var u = new URL(url, window.location.href);
        Array.from(u.searchParams.keys()).forEach(function (k) {
            if (SIZE_PARAMS.test(k)) {
                u.searchParams.delete(k);
            }
        });
        return u.toString();
    } catch (e) {
        return url;
    }
}

function close() {
    var overlay = document.getElementById(OVERLAY_ID);
    if (overlay) {
        overlay.remove();
    }

    document.removeEventListener('keydown', onKey, true);
}

function onKey(e) {
    if (e.key === 'Escape' || e.key === 'Backspace') {
        // Stopped here so jellyfin does not ALSO treat it as "back" and leave the page.
        e.preventDefault();
        e.stopPropagation();
        close();
    }
}

function toggleZoom(overlay, img, e) {
    var zoomingIn = !overlay.classList.contains('zoomed');
    // Where on the image was tapped, as a fraction, so actual size opens on that spot.
    var r = img.getBoundingClientRect();
    var fx = r.width ? (e.clientX - r.left) / r.width : 0.5;
    var fy = r.height ? (e.clientY - r.top) / r.height : 0.5;

    overlay.classList.toggle('zoomed', zoomingIn);
    if (zoomingIn) {
        overlay.scrollLeft = Math.max(0, img.naturalWidth * fx - overlay.clientWidth / 2);
        overlay.scrollTop = Math.max(0, img.naturalHeight * fy - overlay.clientHeight / 2);
    }
}

function open(thumbUrl) {
    close();

    var overlay = el('div');
    overlay.id = OVERLAY_ID;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Image');

    var img = el('img');
    img.alt = '';
    img.src = thumbUrl;

    var closeBtn = el('button', null, 'close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');

    overlay.appendChild(img);
    overlay.appendChild(closeBtn);
    document.body.appendChild(overlay);

    // Full resolution in the background; swapped in only once it has actually loaded.
    var full = fullSizeUrl(thumbUrl);
    if (full !== thumbUrl) {
        var loader = new Image();
        loader.onload = function () {
            if (img.isConnected) {
                img.src = full;
            }
        };
        loader.src = full;
    }

    // Drag to pan while zoomed (mouse). Touch pans natively through the scrolling overlay.
    var drag = null;
    var moved = false;
    overlay.addEventListener('mousedown', function (e) {
        if (overlay.classList.contains('zoomed') && e.button === 0) {
            drag = { x: e.clientX, y: e.clientY, l: overlay.scrollLeft, t: overlay.scrollTop };
            moved = false;
            e.preventDefault();
            // On window, so releasing outside the overlay still ends the drag.
            window.addEventListener('mouseup', function () { drag = null; }, { once: true });
        }
    });
    overlay.addEventListener('mousemove', function (e) {
        if (drag) {
            moved = moved || Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4;
            overlay.scrollLeft = drag.l - (e.clientX - drag.x);
            overlay.scrollTop = drag.t - (e.clientY - drag.y);
        }
    });
    overlay.addEventListener('click', function (e) {
        e.stopPropagation();
        if (e.target === img) {
            if (!moved) {
                toggleZoom(overlay, img, e);
            }

            moved = false;
            return;
        }

        close();
    });

    document.addEventListener('keydown', onKey, true);
    closeBtn.focus();
    log('image zoom opened: ' + full);
}

function onClick(e) {
    var node = e.target && e.target.closest && e.target.closest(POSTER);
    if (!node) {
        return;
    }

    var url = imageUrl(node);
    if (!url) {
        return;
    }

    e.preventDefault();
    e.stopPropagation();
    open(url);
}

export function installImageZoom() {
    try {
        if (!document.getElementById(STYLE_ID)) {
            var style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = CSS;
            (document.head || document.documentElement).appendChild(style);
        }

        document.addEventListener('click', onClick, true);
        // Leaving the page (back button, link) must not leave the overlay behind.
        window.addEventListener('hashchange', close);
        window.addEventListener('popstate', close);
        log('image zoom installed');
    } catch (err) {
        log('image zoom install failed', err);
    }
}
