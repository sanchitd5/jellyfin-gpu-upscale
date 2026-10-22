# What Jellyfin Plus changes in Jellyfin

Jellyfin Plus is a plugin for Jellyfin 12.1 that does two kinds of work. On the server it
runtime-patches Jellyfin's own code (with Harmony) so transcodes can be enhanced on the GPU and so
search, library filters, "More Like This" and the filter lists behave better. In the browser it
injects one script, `jellyfin-plus.js`, into jellyfin-web, which adds the Enhance panel and a set of
search, library, card and playback fixes.

This file is a catalogue of every change, written from the code. File paths are relative to the repo
root. Where something was not checked against a running server, it says so. For depth on the GPU
side, follow the links in section 1; for install steps see [INSTALL.md](INSTALL.md).

Contents: [Summary table](#summary-table) · [1 GPU upscaling](#1-gpu-upscaling-and-enhancement) ·
[2 Search](#2-search) · [3 Library browsing and filters](#3-library-browsing-and-filters) ·
[4 Item pages](#4-item-pages) · [5 Cards and playback](#5-cards-and-playback) ·
[6 Tag editing](#6-tag-editing) · [7 Harmony patch reference](#7-harmony-patch-reference) ·
[8 HTTP routes](#8-plugin-http-routes) · [9 Request parameters](#9-request-parameter-reference) ·
[10 Browser storage](#10-client-storage-keys) · [11 Server-side data](#11-data-the-plugin-stores-on-the-server) ·
[12 Known limits](#12-known-limits)

## Summary table

"Server patch" means a Harmony patch in `src/patcher/`. "Client" means the injected script built from
`web/src/`. There is no per-feature switch for the search, library, card and playback changes: they
install when the plugin and script load, and each client feature installs inside its own try/catch
(`web/src/bootstrap.js`) so one failing cannot stop the others. "Turn off" below is therefore either a
setting, a control in the page, or "remove the plugin or script".

| Feature | Where | User-visible effect | On by default? / how to turn off |
|---|---|---|---|
| GPU enhancement of transcodes (14 axes) | Both | Enhance panel in the player; transcodes are upscaled, sharpened, denoised on the GPU | Master switch `Enabled` (default true). With `RequireClientOptIn` false (the default) every eligible transcode is enhanced using the dashboard defaults; the viewer can pick Off in the panel |
| Live apply and A/B swap | Both | Changing a setting mid-playback switches streams without a gap | On. If the swap patch cannot install, live apply falls back to tear-down-and-restart |
| Direct-play override | Server patch | Eligible direct-play sessions become GPU transcodes on every client | Off. Setting `ForceTranscodeForDirectPlay` |
| Tag search | Server patch | Search also matches item tags (substring) | On, no switch |
| Per-tag exclude on search | Both | "Exclude tags" box under the search field | On; clear the box to stop |
| Search on submit | Client | Searching waits for Enter or the Search button | On, no switch (not on TV layouts) |
| Search Sort and filter | Both | Sort by name, date, runtime, rating, random, play count, last played; filter by tag, cast and crew, studio, runtime, date added, resolution, watched, favourites, type | On; "Reset" in the sheet clears it |
| Search-scoped Cast and Crew list | Both | The cast picker lists only people in the current results, with counts | On; falls back to a global people search if the route is missing |
| Search paging, infinite scroll, virtualised chunks | Both | Page size choice and Prev/Next on desktop; infinite scroll on phones | On; the Paged/Infinite toggle on the results |
| Search result grid | Client | Results as a vertical grid on phone and desktop | On, no switch (TV untouched) |
| Library-scope search fix | Client | Search from inside a Home Videos style library now returns clips | On, no switch |
| Library filter: tag search, exclude, match-all | Both | Search box, per-tag exclude and "match ALL" switch in the filter popover | On, no switch |
| Library filter: studios, people, resolution on Videos-like tabs | Client | Extra sections in the popover where stock hides them | On, no switch |
| Filter key cache | Server patch + plugin services | Filter lists (tags, genres, years, ratings) load fast | On, no switch; see section 3 |
| More Like This for Video items | Both | A "More Like This" row on a clip's page | On, no switch |
| Tag and person chips on item pages | Client | Chips replace the one-line tag list (not on TV) | On, no switch |
| Person and studio pages list Videos | Client | A "Videos" section appears on person and studio pages | On, no switch |
| Poster zoom | Client | Tap the details poster to open it full size | On, no switch |
| Mobile card actions | Client | Always-visible favourite, more and play buttons on phone cards | On, no switch |
| Double-tap seek | Client | Double-tap the side thirds of the video page to seek 10 s | On, no switch (touch only) |
| Clip Up Next | Client | "Next video in N s" card for queued clips | On, no switch |
| Play-all fixes | Client | Play all and Shuffle queue up to 1000 items; Home Videos folders queue videos | On, no switch |
| Bulk tag add/remove, Edit tags | Client | Extra rows in the selection menu and the item menu (administrators) | On for administrators |

## 1. GPU upscaling and enhancement

Concise on purpose; the existing documents carry the detail: [README.md](README.md) (levels,
configuration, measurements), [ARCHITECTURE.md](ARCHITECTURE.md), [NEURAL.md](NEURAL.md),
[LIVE_APPLY_DESIGN.md](LIVE_APPLY_DESIGN.md), [WEB_PANEL_DESIGN.md](WEB_PANEL_DESIGN.md).

**What it does.** Jellyfin 12.1 has no plugin hook for the video filter graph, so five methods of
`MediaBrowser.Controller.MediaEncoding.EncodingHelper` are patched to replace the `-vf` chain with a
libplacebo (Vulkan) chain, swap the device arguments, drop the hardware decoder, and turn a stream
copy into a real encode when enhancement was asked for. The chain is built in
`src/patcher/UpscaleEngine.cs` and `src/patcher/ShaderLibrary.cs`.

**The 14 axes.** `upscale`, `sr`, `deblur`, `denoise`, `deblock`, `neural`, `game`, `refine`,
`chroma`, `deband`, `kernel`, `jitter`, `depth`, `reactive`. Each travels as a lowercase query
parameter (Jellyfin copies lowercase-initial query parameters into the request's stream options); an
axis is real only when `UpscaleEngine.Option(state, ...)` reads it (`UpscaleEngine.cs`, `Decide`).
`maxHeight` is also accepted as a legacy synonym for a numeric `upscale`. The client writes them in
`web/src/controller/network.js` (`wireParams`).

**The patched ffmpeg binary.** The five custom filters `vf_oidn`, `vf_optix`, `vf_ort`, `vf_fsr2`,
`vf_dlss` live in a separately built ffmpeg beside the stock one. The server asks that binary which
filters it carries and strips chain nodes it lacks, so a missing filter means that level is not
offered rather than a failed session. Two more opt-in filters (`dlpp_rtcuda`, `vsr_rtcuda`) exist in
the same binary but are not among the 14 axes and are not wired into the plugin's five-place settings
checklist (see `CLAUDE.md`, "What this project is made of now"). All of the stock-binary axes
(`upscale`, `sr`, `deblur`, `refine`, `chroma`, `deband`, `kernel`, and the `nlmeans_vulkan` and
`hqdn3d` denoise levels) run on the stock `jellyfin-ffmpeg`.

**The Enhance panel.** A flat panel opened from the player settings sheet's "Enhance" entry
(`web/src/controller/action-sheet.js`, `web/src/view/panel-dom.js`). Controls are generated from data
in `web/src/model/controls-data.js`; targets and levels come from the server probe
(`GET /JellyfinPlus/Session/probe`), never from numbers hard-coded in JavaScript. The panel also shows
what the server actually did for the running session, including negatives such as
`concurrency-cap`, `subtitle-burn-in`, `stream-copy`, `not-requested` and `off-by-client`.

**Live apply and the A/B swap.** Changing a setting mid-playback makes the player renegotiate its
stream. The client marks that request with `swapfrom=<old PlaySessionId>`. On the server the swap
patches (section 7.2) hold back the old ffmpeg process's teardown until the new one has produced its
first segment, so playback does not gap. Admission is limited by `MaxConcurrentSwaps` (default 4) on
top of `MaxConcurrent`; past the cap the session reports `swap-capacity` and live apply falls back to
tear-down-and-restart. A swap whose new process never arrives is torn down after 15 seconds
(`UpscaleEngine.SwapTimeout`) and reported as `swap-timeout`.

**Direct play.** A direct-playing file has no transcode to enhance. The stored preference has three
states: unset (client sends nothing), Off (client sends `upscale=off&deblur=off&denoise=off` and
leaves direct play alone), and a chosen stage (client sets `EnableDirectPlay=false` and
`EnableDirectStream=false` on the PlaybackInfo request,
`web/src/controller/network.js` `forceTranscodeBody`). Clients without the script are not enhanced
unless `ForceTranscodeForDirectPlay` is on (section 7.1).

**Fallback.** `shim/jellyfin-ffmpeg-upscale` is a Python wrapper that rewrites the command without
Harmony. The plugin tells it to stand down while the patches are active, by writing
`plugin_patch_active` and the main settings into `/etc/jellyfin-upscale.json` if that file exists
(`src/ShimBridge.cs`).

**Defaults to know.** From `src/Configuration/PluginConfiguration.cs`: `Enabled` true, `TargetHeight`
1080, `MaxTargetHeight` 2160, `SrLevel` `fsrcnnx`, `MaxConcurrent` 4, `MaxConcurrentSwaps` 4,
`RequireClientOptIn` false, `ForceTranscode` false, `ForceTranscodeForDirectPlay` false, `Encoder`
`hevc_nvenc`, `MinScaleFactor` 1.15, `SrMinScaleFactor` 1.60, `MaxSourceHeight` 1440. Deblur, denoise,
deblock, neural, game, refine and chroma defaults are all `off`. The README configuration table lists
`MaxConcurrent` 2 and `RequireClientOptIn` true; the code says 4 and false.

## 2. Search

All of this applies to jellyfin-web's search page (`#/search`) and, for the server parts, to the
requests it sends. The server cannot change what the page asks for, so most client modules rewrite the
outgoing request URLs through the shared fetch and XHR hooks (`web/src/controller/network.js`,
`markSearch`: exclude box, then Sort and filter, then paging).

**Tag matching** (`src/patcher/SearchPatches.cs`). Stock search matches item names only. This adds
items whose tag contains the search term, as a case-insensitive, diacritic-insensitive substring
(both sides go through Jellyfin's `GetCleanValue()`). A tag-only match scores 40, below a stock name
match (50), so a title match ranks above a tag-only match. It runs through the stock provider's own
type, media, parent, user-access and alternate-version filters, so a tag match is limited to what a
name match could return. It applies to both `/Items?searchTerm=` and `/Search/Hints`.

**Per-tag exclude.** The "Exclude tags (comma-separated)" box
(`web/src/controller/search-exclude.js`) sends `excludeTags`. The rule is per tag, not per item:
searching "cat" with "red" excluded drops a match made through a tag such as "red cat" but keeps a
match through "black cat", even if that item also carries another tag containing "red". Stock name
matches are dropped if any of their tags contains an exclude term (a name-matched item is still
returned if it has a qualifying tag match). The text is saved in `localStorage` and applied to every
search request while it has text.

**The submit button and Enter.** jellyfin-web searches 500 ms after every pause in typing. The script
holds the box's `input` events in a window-level capture listener so typing alone searches nothing; the
Search button, or Enter in either box, replays one `input` event so React runs its normal flow
(`search-exclude.js`, `holdTyping`, `submitSearch`). Not applied on TV layouts.

**Sort** (`src/patcher/SearchSortPatches.cs`). On Jellyfin 12.1 the search page's `sortBy` is thrown
away: `ItemsController` re-orders loaded items by relevance. The patch re-scores the candidates so that
score order equals the requested order. Sort keys: `SortName`, `DateCreated`, `PremiereDate`,
`CommunityRating`, `Runtime`, `Random`, `PlayCount`, `DatePlayed` (names outside this list are
ignored; none left means relevance). Items with an unknown value sort last in either direction; ties
fall to name, then id. `Random` with a `jpSeed` gives the same order for the same ids, across restarts.
The set of items returned is the stock set; only the order changes.

**The Sort and filter sheet** (`web/src/view/search-filter-sheet.js`,
`web/src/controller/search-filters.js`, `web/src/model/search-filters.js`). A button, a badge and
chips under the search box, and a sheet (bottom sheet on a phone, centred panel on a wide window). It
edits a draft; nothing is sent until Apply. Sections: Sort by; Tags (searchable list from
`/Items/Filters`, with an "any/all" match); Cast and Crew (people, role pills, any/all); Studio;
Runtime (minutes); Date added; Resolution; Watched; Type (All, Videos, Movies, Episodes). Favourites
is also a filter. The state is saved in `localStorage` (`jellyfinPlus.searchFilters`) and applies until
reset. Skipped on TV layouts. Because jellyfin-web's React Query keys do not include these parameters,
each Apply re-runs the page's queries with a two-phase refetch.

**Type filter.** jellyfin-web sends two result queries (a Videos query marked `mediaTypes=Video`, and
one all-types query). The Type filter steers them: the query that should show nothing is cut down to a
one-item stock request whose result the page discards (`typePlan`).

**Cast and Crew, and search-scoped facets** (`src/SearchFacetsController.cs`). The Cast and Crew
picker asks `GET /JellyfinPlus/Search/Facets` for the people credited on the items this search
returns, with counts. A facet ignores its own filter, so picking one person does not shrink the list to
that person's co-stars. Role pills offer only roles that occur in the listed people (plus any already
chosen). If the route is missing (an older server), the sheet falls back to a global people search and
says so. The Studio picker is not scoped to the results: it lists studios from `/Studios` (40 at a
time). The route also supports `kind=studios` and `kind=tags`; this client only asks for `people`.

**Pagination** (`web/src/controller/search-pager.js`, `web/src/model/search-paging.js`,
`web/src/view/search-pager.js`). A pager under each result grid: Prev/Next, "Page X of Y", and a page
size choice. Videos: 50, 100 (default) or 200. All-types: 200, 400 or 800 (default). The defaults are
the page's own stock limits. Requests carry `startIndex`, `limit`, `enableTotalRecordCount=true` and
`jpPaged=true`. Page state is not kept in the URL; Back, Forward and reload start from page 1. It
resets on a new term, library scope, exclude text, or Sort and filter commit.

**Infinite scroll and virtualisation** (`web/src/view/search-infinite.js`,
`web/src/view/virtual-chunks.js`). The default on a phone (`html.layout-mobile`) unless the viewer
chose otherwise with the Paged/Infinite switch. React's own queries ask for a small first slice (50 for
Videos, 200 for all-types); the next slices are fetched as the viewer nears the bottom (sentinel with a
two-screen margin) and drawn with jellyfin-web's own card builder into `.jpChunk` wrappers of 12 cards.
A chunk more than three viewport heights from the screen is emptied and pinned to its measured height
so memory stays bounded; it is rebuilt when it comes back.

**Grid** (`web/src/view/search-grid.js`). Results become a vertical CSS grid: 2 columns up to 50 em,
`auto-fill` above (wider minimum for landscape cards). CSS only; cards and scrollers stay jellyfin-web's
own. TV layouts are left alone.

**Library-scope fix** (`web/src/controller/search-scope.js`). Searching from inside a Home Videos
(or music videos, mixed, photos) library puts `collectionType` in the search URL, which makes stock
disable the Videos query and ask for a type list without `Video`, so clips can never match. The script
drops `collectionType` for types other than movies, tvshows, music, livetv, books, boxsets and
playlists, keeping `parentId`, so the search is scoped to that library and clips are returned.

## 3. Library browsing and filters

**Filter popover additions** (`web/src/view/library-filter-panel.js`,
`web/src/controller/library-filters.js`, `web/src/model/library-filter-marks.js`):

- Tags accordion: a search box, an exclude button on each tag row, excluded tags as removable chips, and
  a "match ALL selected tags" switch (stock is "any"). Not offered on tabs served by their own endpoint
  (artists, album artists, authors, studios), where the parameters would be ignored.
- Long tag lists are windowed: a list over 300 tags is shrunk to the selected and excluded tags plus
  the first 100 that match the search text, so React does not render thousands of checkboxes. Typing
  recomputes the window; the stock checkboxes and selection handling are used throughout.
- Resolution (HD, 4K, SD), Studios and People on the tabs where stock hides them: Videos, Folders,
  Mixed and Music videos. Resolution uses the stock `IsHD`/`Is4K`/`IsSD` filters, labelled "HD (1200 px
  wide or more)".

**How the extra state travels.** The page keeps filters in its own per-tab settings object, which has
no field for these. The extra state rides as marker strings inside `Filters.Tags` (which is persisted,
is part of the query key and is cleared by the stock reset button). Outgoing `/Items` requests are
rewritten to `excludeTagNames` (one parameter per tag, taken verbatim), `tagMatch=all` and `personIds`.
Markers are removed from every other URL, and a marker that is never rewritten reaches the server as a
tag nothing has: an empty list, not a wrong one.

**Server side** (`src/patcher/LibraryFilterPatches.cs`, section 7.4). `excludeTagNames` is an exact
match on the cleaned tag name, unlike the search page's substring `excludeTags`.

**Filter key cache** (`src/patcher/FilterCacheEngine.cs`, `src/patcher/FilterCachePatches.cs`,
`src/FilterCache.cs`). Stock recomputes `/Items/Filters` and `/Items/Filters2` (tags, genres, years,
official ratings) on every request, which the code comments measure at 4 to 7 seconds on a library of
about 47 000 items and 12 000 tags. The cache stores the keys in two tables inside Jellyfin's
`jellyfin.db` (section 11) and answers from them when that is safe, otherwise stock runs untouched.

- It is checked, not assumed: each library has a fingerprint (row count plus newest `DateLastSaved`),
  compared on every request that would be served from the cache. A mismatch means stale, and the
  request goes to stock.
- It builds at scan time (a post-scan task runs after every library scan and rebuilds libraries whose
  fingerprint changed), 30 seconds after any item is added, updated or removed (debounce), and about 3
  seconds after a request found it stale or missing (at most once a minute).
- Manual rebuild: the scheduled task "Jellyfin Plus: rebuild filter cache" (Dashboard, Scheduled Tasks,
  category Library; no default trigger) rebuilds every library, and `POST /JellyfinPlus/FilterCache/Rebuild`
  does the same in the background. `GET /JellyfinPlus/FilterCache/Status` shows per-library state.
- Not served from the cache (stock runs): a user with a maximum parental rating, blocked unrated
  items, or allowed/blocked tags; a query narrowed by anything beyond libraries and item types; a scope
  narrower than a whole library (a series, a collection, a folder); a library the user cannot open;
  by-name item kinds (people, genres, studios, music artists); and any query field the code does not
  know (it compares every settable `InternalItemsQuery` property against a default, so a new Jellyfin
  field defaults to stock). The reason is counted in `Outcomes` on the status endpoint.
- There is no setting to turn the cache off. If the patch cannot install, or a rebuild fails, stock
  serves the lists.

## 4. Item pages

**More Like This for Video items** (server: `src/patcher/SimilarPatches.cs`; client:
`web/src/controller/detail-related.js`). Stock has no similar-items provider for the base `Video`
type, and the web page hides the section for it. The server ranks other Videos by shared tags and
people: score = 5 per shared tag plus 15 per shared person, each weighted by `1 / ln(2 + postings)` so
a tag carried by thousands of clips cannot outvote a rare one. The client asks `getSimilarItems` for
12 and renders the result into the stock section.

**Tag and person chips.** On a Video's page the one-line comma tag list is replaced by chips: people
(linking to the person's page) and tags (linking to a search for that tag). The first 40 of each show;
the rest fold behind "+N more". Not on TV. The stock tag line is hidden only after the chips exist.

**Person and studio pages list Videos** (`web/src/controller/person-videos.js`). Stock builds a fixed
set of sections with no Video type. The always-built Audio Books section's request is rewritten to
`IncludeItemTypes=Video`, newest first, 24 items, then retitled "Videos". The trade is stated in the
code: on a server that does hold audiobooks by that person or studio, that section shows their videos
instead. The rewrite matches only an Audiobook request carrying `personIds` or `studioIds` on a
`#/details` page.

**Poster zoom** (`web/src/view/image-zoom.js`). Tapping the details poster opens it full screen at
full resolution (sizing parameters are stripped from the image URL). Tap to toggle fit/actual size;
close with the X, the backdrop, or Escape.

## 5. Cards and playback

**Mobile card actions** (`web/src/view/card-actions.js`). Under `html.layout-mobile`, a row of
favourite, more and play buttons on each card in an items container (stock shows favourite and more
only in a desktop hover overlay). More and Play use the stock `itemAction` handlers; Favourite calls
`ApiClient.updateFavoriteStatus`, with the heart state read in small batches for cards that scroll into
view. Tap targets are 40 px. The row is hidden during multi-select.

**Double-tap seek** (`web/src/controller/double-tap-seek.js`). On the video page, touch only: a double
tap on the left third seeks back 10 s, the right third forward 10 s; more taps on the same side within
the window keep adding, with a hint. The middle third, controls and non-touch pointers are left to
jellyfin. A single tap is untouched.

**Clip Up Next** (`web/src/controller/clip-upnext.js`). Stock shows its Up Next card only for Episodes
of 10 minutes or more. For items of type `Video` with a next item in the queue, a small card appears
when 8 seconds remain ("Start now", "Hide"), for items of 20 seconds or longer. It only announces: the
stock playback manager still advances if the viewer's auto-play setting is on. It respects the
viewer's "next video info" overlay setting.

**Play-all fixes** (`web/src/controller/play-all.js`). Two playback-queue requests are rewritten.
(1) Stock caps Play all and Shuffle at 300 items; a request with the playback signature
(`Fields` containing Chapters and MediaSources, `ExcludeLocationTypes=Virtual`,
`EnableTotalRecordCount=false`) and `Limit=300` becomes `Limit=1000`. (2) For a Home Videos folder
stock queues `MediaTypes=Photo` only; a recursive `MediaTypes=Photo` request with a `parentId` and no
limit becomes `MediaTypes=Video,Photo`.

**Playback Info annotation.** The Playback Info dialog gets a line reporting what the server did for
the session (`web/src/controller/playback-hooks.js`).

## 6. Tag editing

`web/src/controller/bulk-tags.js`, `web/src/view/bulk-tags-dialog.js`. Administrators only (the client
checks the same elevation the server enforces on `POST /Items/{id}`).

- **Bulk add/remove.** With items selected, the selection menu gains "Add tags..." and "Remove
  tags...". Add suggests existing tag names; Remove suggests the selection's tags.
- **Edit tags.** The single-item menu gains "Edit tags" next to "Edit metadata".

Why it is careful: jellyfin-web saves with `POST /Items/{id}` and the server replaces many fields from
the body (a missing field is wiped). The payload is built from a fresh GET of the item: the fields the
server assigns unconditionally, `LockData`, and `Tags`, and nothing else. After saving, the item is read
back and every protected field is compared; a difference is reported as a failure for that item.
Series, Season and MusicAlbum are refused (saving them pushes ratings and tags to children). Allowed
types: Video, Movie, Trailer, Episode, Folder, BoxSet, Photo, Book. Saves run 3 at a time.

## 7. Harmony patch reference

All patches are installed by `UpscalePatches.Apply` / `ApplyOptional` (`src/patcher/UpscalePatches.cs`)
when the plugin loads, in the patch assembly at `/usr/lib/jellyfin-plus/`. Harmony id:
`jellyfin.plugin.jellyfinplus`. The result is reported as `PatchStatus` by `GET /JellyfinPlus/Status`,
for example `active (5 EncodingHelper methods patched); optional: tag search, ...; optional UNAVAILABLE: ...`.

Every patch is fail-soft by construction: targets are resolved by name (some by `AccessTools.TypeByName`,
so there is no compile-time version pin), a target that cannot be resolved logs a warning naming it and
leaves Jellyfin untouched, and every patch body is wrapped in try/catch that leaves Jellyfin's own value
or result in place. A Jellyfin upgrade that renames or changes the meaning of a target can still break a
patch silently (Harmony cannot detect a changed meaning); re-verify after upgrades.

### 7.1 Transcoding: the core set (all-or-nothing) and the direct-play override

**Core set: `MediaBrowser.Controller.MediaEncoding.EncodingHelper`**, five postfixes
(`UpscalePatches.cs`). They are interdependent: the filter chain only works because the other four put
a Vulkan device and system-memory frames in place. If any of the five cannot be resolved, none are
installed and the status names the missing methods. If a throw happens mid-install, the whole set is
rolled back (`UnpatchAll`).

| Target | Kind | Change | Active when |
|---|---|---|---|
| `EncodingHelper.GetVideoProcessingFilterParam` | postfix | Replaces `-vf` with the libplacebo chain, keeping Jellyfin's non-scaling nodes. Records the session outcome. | The session's shared verdict says act |
| `EncodingHelper.GetInputVideoHwaccelArgs` | postfix | Swaps CUDA device setup for Vulkan (or CUDA for a CUDA-native neural level) | Same |
| `EncodingHelper.GetHwaccelType` | postfix | Empties the decode `-hwaccel`, except on the CUDA-native branch | Same |
| `EncodingHelper.GetHardwareVideoDecoder` | postfix | Returns null (drops `*_cuvid`), except on the CUDA-native branch | Same |
| `EncodingHelper.GetVideoEncoder` | postfix | Turns a stream `copy` into a real encoder when the session explicitly asked for enhancement or `ForceTranscode` is on; on an ordinary transcode being enhanced, applies the configured `Encoder` only if ffmpeg has it and the client declared it playable (otherwise Jellyfin's choice stays); swaps AV1 where the GPU cannot encode it | The encoder is not already `copy` (configured-encoder path), or is `copy` and the session asked |

One verdict per session (`VerdictFor`, memoised by play session id, table cleared at 256 entries)
drives all four command-shaping patches so they cannot disagree. The verdict does not act when: the
plugin is disabled; the request is not a video request or the source size is unknown; the viewer chose
Off; nothing was requested and `RequireClientOptIn` is on; subtitles are burned in (Jellyfin builds a
`-filter_complex` graph, which is left alone); or all `MaxConcurrent` enhancement slots are busy. Each
of those is recorded with a status (`disabled`, `ineligible`, `off-by-client`, `not-requested`,
`subtitle-burn-in`, `concurrency-cap`).

Permission guarantees: these patches change ffmpeg arguments only. They read no user data, add no
endpoint and do not alter who may play what.

**Direct-play override: `Jellyfin.Api.Helpers.MediaInfoHelper.SetDeviceSpecificData`**, prefix
(optional). Sets `enableDirectPlay` and `enableDirectStream` to false for a session whose video stream
`UpscaleEngine.WouldEnhanceSource` says the engine would enhance, so a transcode exists. Active only
when `Enabled` and `ForceTranscodeForDirectPlay` are both true (default off). It can only turn direct
play off, never on. Fail-soft: any exception leaves Jellyfin's decision alone; if the target cannot be
resolved the status reads `optional UNAVAILABLE: MediaInfoHelper.SetDeviceSpecificData (direct-play
override)` and the setting does nothing. The cost is real: each such session is a GPU transcode subject
to `MaxConcurrent`; sessions past the cap fall back to stock transcoding, which is dearer than the
direct play they replaced.

### 7.2 Live-apply swap: `MediaBrowser.MediaEncoding.Transcoding.TranscodeManager` (`SwapPatches.cs`)

| Target | Kind | Change | Active when |
|---|---|---|---|
| `TranscodeManager.KillTranscodingJobs(string, string, Func<string,bool>)` | prefix | Skips the immediate teardown of the old session and returns a completed Task | A swap was admitted for exactly that old play session id (from the `swapfrom` marker) and is pending |
| `TranscodeManager.StartFfMpeg` | postfix | Wraps the returned Task so that, once the new job is ready (stock already waits for its first segment), the deferred kill of the old job is replayed | Every call; it only acts if a deferred swap exists for the device |

Fail-soft: any exception in the prefix returns true (the normal kill runs). A swap that never completes
is swept after 15 s and the old job is torn down, so nothing is orphaned. Both targets are required; if
either is missing the swap is "unavailable" and live apply uses tear-down-and-restart. Permissions:
affects only sessions this plugin admitted, keyed by play session id and device id.

### 7.3 Search: tag match and exclude, sort and wide pool

**`Emby.Server.Implementations.Library.Search.SqlSearchProvider.SearchAsync(SearchProviderQuery, CancellationToken)`**,
postfix (`SearchPatches.cs`, optional "tag search"). Wraps the returned Task. Adds items whose tag
contains the cleaned search term and applies `excludeTags`. Active on every search that reaches the SQL
provider (item searches and `/Search/Hints`) and on `/JellyfinPlus/Search/Facets`; exclusion only when
`excludeTags` is present. Terms: split on comma or pipe, trimmed, at most 100 characters each, at most 20
terms. Fail-soft: on any error (except cancellation) the stock name results are returned unchanged,
without exclusions, with a warning. If every name match was excluded and nothing else matched, it
returns one result with an empty id so the controller does not fall back to its own name-only query that
would bring the excluded items back. Access: the tag query is built through the provider's own private
type, media, parent, user-access and alternate-version filters; the patch is not installed if the
access filter cannot be resolved.

**`Emby.Server.Implementations.Library.Search.SearchManager.GetSearchResultsAsync(SearchProviderQuery, CancellationToken)`**,
prefix and postfix (`SearchSortPatches.cs`, optional "search sort"). Acts only when the request path
ends in `/Items`.
- Prefix: raises `SearchProviderQuery.Limit` (an init-only property, set by reflection) to the
  candidate pool: 2000 when a supported `sortBy` or any contract filter is present; stock limit plus
  `startIndex` (capped at 5000) when `startIndex` is past the stock window; 5000 when `jpPaged=true`.
  It never lowers a limit. Filter parameters that trigger the widening: `isPlayed`, `isFavorite`, `tags`,
  `tagMatch`, `excludeTagNames`, `personIds`, `personTypes`, `jpPersonMatch`, `studioIds`, `jpMinRuntime`,
  `jpMaxRuntime`, `jpMinDateAdded`, `jpMaxDateAdded`, `jpResolution`.
- Postfix: only when a sort key or an all-of people match is present. Re-scores the candidates
  (score = count minus rank), and with `jpPersonMatch=all` and two or more distinct `personIds` first
  narrows candidates to items credited with every person (respecting `personTypes` on the same credit
  row; if nobody qualifies it returns one placeholder id so the controller does not fall back).
- With none of these parameters the request is untouched.
- Fail-soft: any failure returns the stock candidates in stock order; the warning is logged once.
- Access: only ids and scores change hands. The set returned is the stock set; user-access filtering
  still happens afterwards in stock `folder.GetItems`.

### 7.4 Library filters: `Jellyfin.Server.Implementations.Item.BaseItemRepository.TranslateQuery(IQueryable<BaseItemEntity>, JellyfinDbContext, InternalItemsQuery)`

Prefix and postfix (`LibraryFilterPatches.cs`, optional "library tag exclude / match-all"). Resolved by
exact signature, so a changed overload is not patched. Acts only when the current HTTP request's path
ends in `/Items` or `/Search/Facets` and carries one of the parameters; a client that never sends them
sees no change.
- Prefix: unions the request's `excludeTagNames` (up to 100 terms, 200 characters each) into
  `filter.ExcludeTags`, so Jellyfin's own `NOT EXISTS` is used. Whatever the caller or the user's own
  restrictions put there stays.
- Postfix: narrows the already-built query. `tagMatch=all` with two or more `tags` requires every tag
  (stock is any); `jpMinRuntime`/`jpMaxRuntime` (whole minutes, inclusive; an item with no runtime
  matches neither); `jpMinDateAdded`/`jpMaxDateAdded` (`YYYY-MM-DD`, inclusive by UTC day);
  `jpResolution` (comma list of `sd`, `hd`, `4k`, any bucket matches). The buckets copy stock's:
  sd is width above 0 and under 1200; hd is 1200 or more and not 4K; 4k is width 3800 or more or height
  2100 or more; an item's resolution is the best any of its versions offers and a folder answers on its
  children. Malformed values are ignored.
- It can only add `Where` clauses, never widen a result, and user-access filtering is a separate stock
  step on the same query. Fail-soft: an exception leaves the query as stock built it (logged once).

### 7.5 Filter key cache: `BaseItemRepository.GetQueryFiltersLegacy`, `GetTagNames`, `GetGenres`

Three prefixes, each taking an `InternalItemsQuery` (`FilterCachePatches.cs`, optional "filter key
cache"). A prefix returns false (skips stock) only when the cache can answer; true (or a throw) leaves
stock to run.
- `GetQueryFiltersLegacy`: serves tags, genres, years and official ratings (`/Items/Filters`).
- `GetTagNames`: serves tags (`/Items/Filters2`).
- `GetGenres`: serves genre entities (id and name only) and only when the request path ends in
  `/Items/Filters2`.

Active only when the safety conditions in section 3 hold. Access guarantees: no cache for a user with any
item-level restriction; every library in scope must be one the user can open
(`CollectionFolder.IsVisible`), which stock does not check for an explicit `parentId`; a no-parent
request is answered for the libraries the user can open, never wider than stock. Fail-soft: the first
failure is logged once, stock serves, and a stale or missing cache requests a background rebuild.

### 7.6 Video similar items: `Emby.Server.Implementations.Library.SimilarItems.SimilarItemsManager.GetSimilarItemsAsync`

Prefix (`SimilarPatches.cs`, optional "video similar items"). Handles only items whose exact type is
`Video` (Movie, Episode, MusicVideo and Trailer keep their own providers); everything else runs stock.
Active on `GET /Items/{id}/Similar` for a Video, with a known user. Limit clamped to 1 to 50. Work is
bounded: at most 12 rarest source tags and 12 rarest source people take part, a value carried by more
than 3000 items is skipped, and at most 60 source values are read.
Access: candidates are only a ranking; the returned items are loaded through
`ILibraryManager.GetItemList` after `ConfigureUserAccess`, the candidate SQL is limited to the user's
accessible top-level libraries, and the manager's own `FilterByLibraryAccessAsync` runs over the result.
The patch is not installed if any of those pieces is missing. With no user it keeps stock behaviour
(empty), never an unfiltered answer. Fail-soft: errors return an empty list, which is the stock answer
for a Video.

## 8. Plugin HTTP routes

All under the Jellyfin API root. "Administrator" is the `RequiresElevation` policy.

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /JellyfinPlus/Status` | Administrator | Patch status (`PatchActive`, `PatchStatus`), shim sync result and recent sessions. Used by the dashboard page. |
| `GET /JellyfinPlus/Session/{playSessionId}` | Any authenticated user | What the server actually did for one play session. The id `probe` returns the capability lists with no session (used by the client probe); `dashboard` is used by the config page. A session recorded for a different user is reported as unknown. If either side has no user id (for example an API key), it answers as before the check existed. |
| `GET /JellyfinPlus/FilterCache/Status` | Administrator | Per-library, per-kind cache state: built time, key counts, dirty flag, run state, last error, and outcome counters. |
| `POST /JellyfinPlus/FilterCache/Rebuild?force=true` | Administrator | Starts a background rebuild and returns 202 with the status JSON. `force` (default true) rebuilds every library, not only stale ones. 409 when a rebuild is running or the cache is not ready. |
| `GET /JellyfinPlus/Search/Facets` | Any authenticated user | People, studios or tags credited on the items a search matches: `[{id, name, roles, count}]`, count descending then name. Parameters in section 9. 400 for a bad `kind` or no resolvable user; 403 if a non-administrator asks for another user's view; 404 for an unknown user or a `parentId` the user cannot see; an empty array when `searchTerm` is blank. Sets a `Server-Timing` header. |

The plugin also serves its configuration page (Dashboard, Plugins, Jellyfin Plus) from an embedded
resource (`src/Configuration/configPage.html`); changing it needs a rebuild and a Jellyfin restart.

## 9. Request parameter reference

Parameters that stock Jellyfin does not define, or that are used here in a non-stock way. "Sender" is
the client module that writes them. Names are matched case-insensitively by the server's query reader.
Stock Jellyfin ignores a query parameter it does not know, which is why a client sending these to a
server without the plugin sees no error.

| Parameter | Meaning | Honoured by | Sent by |
|---|---|---|---|
| `excludeTags` | Comma- or pipe-separated substrings. Drop tag matches whose tag contains one, and name matches with any such tag. At most 20 terms of 100 characters. | Search: `SqlSearchProvider.SearchAsync` (item search, `/Search/Hints`); `/JellyfinPlus/Search/Facets` | `search-exclude.js` (`markSearchUrl`), `model/search-filters.js` (`facetPairs`) |
| `excludeTagNames` | Exact tag names (cleaned), one per parameter value, verbatim so a name may contain commas. Drop items carrying any. At most 100 of 200 characters. | `/Items` and `/Search/Facets` through `TranslateQuery`; also triggers search pool widening | `model/library-filter-marks.js` (library popover). The search sheet does not send it |
| `tagMatch` | `all` makes stock's `tags` list an AND (needs 2+ tags) | Same as above | `library-filter-marks.js`, `model/search-filters.js` |
| `jpMinRuntime`, `jpMaxRuntime` | Whole minutes, inclusive, digits only | Same as above | `model/search-filters.js` (`filterPairs`) |
| `jpMinDateAdded`, `jpMaxDateAdded` | `YYYY-MM-DD`, UTC day, inclusive | Same | `model/search-filters.js` |
| `jpResolution` | Comma list of `sd`, `hd`, `4k` | Same | `model/search-filters.js` |
| `jpSeed` | Positive integer seeding the `Random` sort; same seed and ids give the same order | `SearchManager.GetSearchResultsAsync` (needs `sortBy=Random`) | `model/search-filters.js`; a new seed on each Apply |
| `jpPaged` | `true`: widen the candidate pool to 5000 so the total is meaningful from page 1 | `SearchManager.GetSearchResultsAsync` | `model/search-paging.js` (`rewritePagedUrl`) |
| `jpPersonMatch` | `all`: with 2+ `personIds`, every person must be credited (stock is any-of) | `SearchManager.GetSearchResultsAsync` | `model/search-filters.js` |
| `jpInf` | `1`: marks the client's own follow-up request in infinite mode | Nothing on the server (the plugin never reads it); the client uses it to skip its own rewrite and response watchers | `controller/search-pager.js` (`fetchMore`) |
| `swapfrom` | Old `PlaySessionId` on the renegotiation a live-apply triggers | `UpscalePatches.BuildVerdict`, swap patches | `controller/network.js` (`wireParams`) |
| `upscale`, `sr`, `deblur`, `denoise`, `deblock`, `neural`, `game`, `refine`, `chroma`, `deband`, `kernel`, `jitter`, `depth`, `reactive` | The 14 enhancement axes (section 1). `maxHeight` is a legacy synonym for numeric `upscale`. | `UpscaleEngine.Decide` | `controller/network.js` |

Stock parameters the client uses in a non-obvious way: `sortBy`/`sortOrder` on search (now honoured,
section 2); `tags` (pipe-separated exact names), `personIds`, `personTypes` (case-sensitive PersonKind
names such as `Actor`, applied together with `personIds` on one credit row), `studioIds`; `startIndex`,
`limit` and `enableTotalRecordCount` for paging; `limit=1` plus `includeItemTypes` to cut the query the
Type filter wants discarded.

Parameters of `GET /JellyfinPlus/Search/Facets` itself: `searchTerm` (required for any result), `kind`
(`people` default, `studios`, `tags`), `q` (typeahead needle, 100 characters at most), `limit` (default
50, 1 to 200), `userId`, `parentId`, `includeItemTypes`, `excludeItemTypes`, `mediaTypes`, `isPlayed`,
`isFavorite`, `tags` (pipe-separated), `studioIds`, plus `excludeTags`, `excludeTagNames`, `tagMatch`
and the `jp*` filters read from the same request by the patches above. Without `includeItemTypes` or
`excludeItemTypes` it considers Movie, Series, Episode, Video and MusicVideo.

## 10. Client storage keys

Browser `localStorage`, per browser and per origin. Every read and write is in try/catch, so a browser
that refuses storage still works. `web/src/lib/storage-migrate.js` renames the pre-rename `gpuUpscale*`
keys once.

| Key | Holds | Module |
|---|---|---|
| `jellyfinPlusPrefs` | JSON: Enhance panel stage and the per-axis choices, plus the panel position | `model/prefs-store.js` |
| `jellyfinPlusOpen` | JSON map of which panel sections the viewer left open | `view/panel-dom.js` |
| `jellyfinPlusDebug` | Any value switches on console debug logging (the old `gpuUpscaleDebug` is also read) | `lib/log.js` |
| `jellyfinPlus.searchExclude` | The text of the search page's exclude box | `controller/search-exclude.js` |
| `jellyfinPlus.searchFilters` | JSON: committed Sort and filter state | `model/search-filters.js` |
| `jellyfinPlus.searchPageSize` | JSON: chosen page size for Videos and all-types | `model/search-paging.js` |
| `jellyfinPlus.searchPaging` | `paged` or `infinite`; empty means the layout decides (infinite on phone) | `model/search-paging.js` |
| `jellyfinPlus.libFilterNames` | JSON map of studio and person ids to names, up to 400, for the library filter chips | `controller/library-filters.js` |

Keys that belong to jellyfin-web but are read or written by Jellyfin Plus:
`<viewType> - <parentId>` (the library tab's own settings object; the extra marker entries ride in its
`Filters.Tags`, so the stock reset button clears them) and `<userId>-enableNextVideoInfoOverlay` (read
only, by Clip Up Next).

## 11. Data the plugin stores on the server

| What | Where | Rebuild or clear |
|---|---|---|
| Filter key cache | Two tables in Jellyfin's `jellyfin.db`: `JellyfinPlus_FilterKeys(LibraryId, Kind, ItemType, CleanValue, Value, ItemCount, RefId)` and `JellyfinPlus_FilterKeysMeta(LibraryId, Kind, BuiltAtUtc, SourceItemCount, KeyCount, Fingerprint)`. Created with `CREATE TABLE IF NOT EXISTS` by raw SQL; Jellyfin's own schema and migrations are never touched. One row per distinct key per library per item type. Kinds: tags, genres, years, ratings, genre entities. | Rebuild: `POST /JellyfinPlus/FilterCache/Rebuild` or the scheduled task. A forced rebuild deletes and rewrites each library's rows in one transaction, so readers see old or new rows, never a mix. Rows of libraries that no longer exist are removed on each rebuild. Nothing in the plugin drops the tables, including on uninstall. To remove them, stop Jellyfin, back up `jellyfin.db`, and drop both tables by hand (not exercised here; the engine recreates them on its next run). |
| Plugin settings | XML at `plugins/configurations/Jellyfin.Plugin.Plus.xml` under Jellyfin's data directory (`/var/lib/jellyfin/plugins/configurations/` in the install scripts). On first start the constructor copies `Jellyfin.Plugin.GpuUpscale.xml` over if the new file is absent. | Edit on the dashboard page; changes are pushed to the patches live. Delete the file with Jellyfin stopped to return to the defaults in section 1. |
| Shader cache | `ShaderCacheDirectory`, default `/var/cache/jellyfin/jellyfin-plus-shaders`: composed shader files named `<level>+<level>.glsl`, and a `plcache/` subdirectory where libplacebo keeps its compiled-shader scratch files. A composed file is rewritten if any input shader is newer. | Safe to delete the contents; composed files are rebuilt on demand and libplacebo recompiles, so the first sessions afterwards start slower (inferred from the code, not timed). |
| Shaders and models (inputs) | `ShaderDirectory` `/usr/share/jellyfin-shaders`; neural models, DLSS runtime, depth model, DLPP and VSR DLL paths under `/usr/lib/jellyfin-ffmpeg-oidn/` (all configurable). Not shipped with the plugin. | `scripts/install-shaders.sh`; see INSTALL.md |
| Patch assembly | `/usr/lib/jellyfin-plus/`: `Jellyfin.Plugin.Plus.Patcher.dll`, `0Harmony.dll`, the client bundle source `jellyfin-plus.js`, and `staged/`, `previous/`, `legacy/` used by the activate and migrate scripts. It lives outside `plugins/` because Harmony cannot patch from the collectible context Jellyfin loads plugins into. | `scripts/jellyfin-plus-activate` (with `--rollback`), `scripts/proxmox-build.sh` |
| Plugin assembly | `/var/lib/jellyfin/plugins/JellyfinPlus_<version>/` | Same scripts |
| Served client script | `/usr/share/jellyfin/web/jellyfin-plus.js`, plus a `<script defer src="jellyfin-plus.js?v=<10 hex of sha256>">` tag inserted first in `index.html`. Backups: `index.html.jellyfin-plus-orig` (pristine, taken once) and `index.html.jellyfin-plus-bak`. | `scripts/jellyfin-plus-webinject` (installed at `/usr/local/sbin/`). The apt hook `/etc/apt/apt.conf.d/99-jellyfin-plus` reruns it after package operations, because a jellyfin-web upgrade replaces `index.html`. The cache-buster is derived from the file's content. Build the bundle first with `scripts/build-web-panel.sh`. |
| Shim sync file | `/etc/jellyfin-upscale.json`, only if it already exists | Rewritten on each settings change |

## 12. Known limits

Search:
- **Candidate pools are capped.** Sort and filter work on at most 2000 relevance-ranked candidates;
  paged search on at most 5000 (`SearchSortPatches.MaxCandidates`, `MaxPagedCandidates`); the Cast and
  Crew facets on 2000 (`SearchFacetsController.MaxCandidates`). Beyond that the result is truncated, not
  wrong: `TotalRecordCount` means "matches among the first N candidates", exact when it is below N and a
  lower bound when it equals what N candidates can yield. A very broad term with a narrow filter can
  therefore miss items that rank beyond the cap.
- **Tag-only matches are capped at the request limit and picked by item id**, not by relevance
  (`SearchPatches` orders by `Id` before taking `Limit`, default 100).
- **Exclude semantics differ by place.** The search box's `excludeTags` is a substring match per tag;
  the library popover's `excludeTagNames` is an exact tag name.
- **Cast and Crew needs real credit data.** The list is built from stored credits and only lists people
  who also exist as Person items. Role pills filter on the stored credit role, so a credit with no role
  cannot match a role pill, and a library with no credits shows "No cast or crew are listed for these
  results". The list needs a committed search term first ("Search first to see who appears"). Only the
  first 200 people are fetched; typeahead beyond that asks the server (100). The Studio picker is not
  scoped to the results.
- **Resolution buckets are the server's 1200 and 3800 pixel widths** (and 2100 height for 4K). The
  helper text in the Sort and filter sheet reads "SD is under 1260 px wide, HD 1260 to 3799"; that text
  does not match the server code, which uses 1200.
- **Paging state is not in the URL**; Back, Forward and reload return to page 1. In "all types" mode a
  page is a slice of one relevance-ranked mix, so a page boundary can fall inside a section.
- **Not on TV layouts:** search submit-on-Enter, Sort and filter, paging, the grid, chips.
- **Search from a library of an unlisted collection type** is rescoped by dropping `collectionType`;
  movies, tvshows, music, livetv, books, boxsets and playlists keep stock behaviour.

Library and filters:
- Tag windowing applies to lists over 300 tags; the full list stays in the script. Library-popover
  exclude and match-all are not offered on artist, album artist, author and studio tabs.
- The filter key cache is bypassed for restricted users, narrowed queries and sub-library scopes
  (section 3), and for a stale or unbuilt library until the next rebuild. It has no off switch. It is
  not described in README.md, ARCHITECTURE.md or the other existing documents (a search for it found
  nothing); this file and the code comments are the only descriptions.

Item pages and playback:
- More Like This covers only items of exact type `Video`, at most 50 results, and returns nothing
  without a user. Chips carry no counts (by design: it would be one query per chip).
- The person and studio "Videos" section borrows the Audio Books slot (section 4).
- **Play all.** The rewrite covers the two requests built by jellyfin-web's playback manager (the 300
  cap, and the Home Videos photo-only queue). The new cap is 1000, not unlimited. The modern Videos
  tab's own Play all and Shuffle buttons special-case that tab in jellyfin-web (per `QOL_IDEAS.md`,
  item 38, an unverified note from a delegated reader); whether they route through the rewritten
  request was not checked here, so Play all on the Videos tab should be treated as unverified.
- Clip Up Next only announces; it does not advance playback. Double-tap seek is touch only, 10 s.
- Bulk tag editing handles only the item types in section 6, only items still on the page, and only for
  administrators.

Enhancement (from README.md, "Limitations and risks", and the code):
- The patches match Jellyfin methods by name and can break on any Jellyfin upgrade; targets are pinned
  to 12.1. A jellyfin-web package upgrade deletes the injected script until the injector reruns.
- The client hooks depend on minified jellyfin-web internals (the `webpackChunk` global; modules matched
  by export shape). They fail safe: normal playback and menus are unaffected.
- Subtitle burn-in sessions are never enhanced. Clients without the script are not enhanced unless
  `ForceTranscodeForDirectPlay` is on.
- The concurrency cap is advisory: it counts live ffmpeg processes carrying `libplacebo` at command-build
  time, so two sessions starting together can both pass. Linux only.
- A silent client-side failure looks like a server bug: if a selection never reaches the request, the
  server applies its dashboard default and reports honestly on that. Check the built ffmpeg command
  first (`journalctl -u jellyfin | grep libplacebo`).
- The patched ffmpeg degrades quietly by design; verify with `-filters` after rebuilding it.

Not verified by this document: behaviour on a running server. Everything above was read from the
source, not exercised.
