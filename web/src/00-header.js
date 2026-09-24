/*
 * GPU Upscale - jellyfin-web client hook.
 *
 * Adds one "Enhance" entry to the player's settings menu. Choosing it opens ONE FLAT PANEL over
 * the video - no nested sheets, no back buttons - carrying, in this order:
 *
 *     Quality     Automatic / Off / Manual, and when Manual, a slider over the graded ladder
 *                 generated for the source now playing
 *     Three axes  the ones a viewer mid-film actually reaches for - the target, the detail
 *                 network and denoise - one row each, the control type chosen from the data
 *     Advanced    ONE disclosure, closed by default, holding every other axis, with the game
 *                 upscaler and its three synthesised inputs as one row inside it. Nothing is
 *                 lost behind it: the summary says how many controls in there are set.
 *     What the    the server's own record for the session playing, OUTSIDE the disclosure and
 *     server is   always visible, refreshed while the panel is open, including the negatives:
 *     doing       bypassed, requested but not applied, no chain built at all
 *
 * A NEW LEVEL IS DATA. Adding one means an entry in an options array; adding a whole axis means an
 * entry in CONTROLS (with its probe key, its group and, if it grades, its rungs) plus one line in
 * LIVE_ROWS. Neither needs a line of rendering code, which is the point: levels and axes have
 * arrived in four of the last five sessions.
 *
 * THREE STATES, NOT TWO. "Automatic" means the viewer has expressed no opinion, so nothing is sent
 * and the server's own dashboard defaults decide - that is what RequireClientOptIn=false is for.
 * "Off" is an opinion: it is sent as upscale=off, which makes the server skip its defaults too, so
 * the file DIRECT PLAYS exactly as stock Jellyfin would. Silence and Off are not the same answer
 * and this script never conflates them.
 *
 * THE OPTION LISTS BELOW ARE A CEILING, NOT THE MENU. The server reports, in its probe response,
 * which levels it can actually deliver on this machine - a super-resolution level whose shader file
 * was never installed is not in that list - and the menu is the intersection. An option that
 * silently does nothing is worse than an absent one.
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

