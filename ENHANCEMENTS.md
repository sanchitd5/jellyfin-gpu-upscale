# What Jellyfin Plus changes in Jellyfin

Jellyfin Plus is a plugin for Jellyfin 12.3 (ported from 12.1) that does two kinds of work. On the server it
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
| Wildcard search (`*` and `?`) | Server patch | `red*car` finds names and tags with "red" followed later by "car"; `?` is exactly one character | On, no switch; a term without `*` or `?` is searched as before |
| Search index (FTS5 trigram) | Server patch + plugin services | Name and tag search answered from an index: provider step about 36 ms to 3 ms on an 80k-item library | On; falls back to the plain query whenever the index is missing, stale or unsupported; see section 7.6 |
| Per-tag exclude on search | Both | "Exclude tags" box under the search field | On; clear the box to stop |
| Search on submit | Client | Searching waits for Enter or the Search button | On, no switch (not on TV layouts) |
| Search Sort and filter | Both | Sort by name, date, runtime, rating, random, play count, last played; filter by tag, cast and crew, studio, runtime, date added, resolution, watched, favourites, type | On; "Reset" in the sheet clears it |
| Search-scoped Cast and Crew list | Both | The cast picker lists only people in the current results, with counts | On; falls back to a global people search if the route is missing |
| Search paging, infinite scroll, virtualised chunks | Both | Page size choice and Prev/Next on desktop; infinite scroll on phones | On; the Paged/Infinite toggle on the results |
| Search result grid | Client | Results as a vertical grid on phone and desktop | On, no switch (TV untouched) |
| Library-scope search fix | Client | Search from inside a Home Videos style library now returns clips | On, no switch |
| Home Videos opens on Videos | Client | Clicking a Home Videos library shows its videos, not folders | On; Settings > Home "default screen" per library overrides it |
| Recent searches | Client | Chips of the last 12 submitted terms on the empty search page; tap to search, x to forget, Clear | On, no switch (not on TV layouts) |
| Longer search box | Client | The search box takes 200 characters instead of 40 | On, no switch (not on TV layouts) |
| Search suggestions include clips | Client | The empty page's Suggestions list also offers random Video items | On, no switch; a changed stock request is left alone |
| Library filter: tag search, exclude, match-all | Both | Search box, per-tag exclude and "match ALL" switch in the filter popover | On, no switch |
| Library filter: studios, people, resolution on Videos-like tabs | Client | Extra sections in the popover where stock hides them | On, no switch |
| Seeded Random sort on library lists | Both | Sorting a list by Random and paging through it gives one shuffle: no repeats, no gaps | On, no switch; falls back to stock Random (re-rolls per page) if the server patch cannot install; see section 3 |
| Sort menu: Random and Recently edited | Both | Legacy lists (tags, people, studios, folders) gain Random; every library list gains "Recently edited" (when an item was last saved, for example after tagging) | On, no switch; see section 3 |
| Tag lists open newest first | Client | A tag's list opens sorted by Date added, newest first, until you pick a sort on a tag list | On, no switch; picking any sort in that menu ends it |
| Favourites sections show 100 | Client | Each Favourites section loads up to 100 items instead of 20 (not on TV) | On, no switch |
| Filter key cache | Server patch + plugin services | Filter lists (tags, genres, years, ratings) load fast | On, no switch; see section 3 |
| More Like This for Video items | Both | A "More Like This" row on a clip's page | On, no switch |
| Tag and person chips on item pages | Client | Chips replace the one-line tag list (not on TV) | On, no switch |
| Person and studio pages list Videos | Client | A "Videos" section appears on person and studio pages | On, no switch |
| Poster zoom | Client | Tap the details poster to open it full size | On, no switch |
| Image look-ahead | Client | Card images are requested before they scroll into view and are not reloaded when you scroll back | On; `localStorage jellyfinPlus.imagePreload = off` (not on TV) |
| Mobile card actions | Client | Always-visible favourite, more and play buttons on phone cards | On, no switch |
| Card badges | Client | Resolution, runtime and the first two tags on video cards, looked up lazily for the cards on screen | On; `localStorage jellyfinPlus.cardBadges = off` (not on TV) |
| Jellyfin Plus theme | Client | `--jp-*` tokens (blue accent `#5ccfff` dark / `#0369a1` light), `jp-phone`/`jp-tablet`/`jp-desktop` width-tier classes on `<html>`, 44 px tap targets on touch tiers, loading skeletons, reduced motion zeroing `--jp-dur*`, pinch-zoom re-enabled (viewport meta rewritten) | On; `localStorage jellyfinPlus.mobileTheme = off` (sets `jp-theme-off`); never on TV |
| Select all N results | Client | "Select all N results" in the selection menu, for Add tags / Remove tags across pages (administrators) | On for administrators; offered only when the list can be identified |
| Select mode entry | Client | A "Select" button on the library toolbar and a `jellyfinplus:select` window event (for the More sheet) arm a one-tap state; the tapped card starts stock multi-select. The selection bar moves to the bottom as a sheet header; the bulk tag dialog is a bottom sheet kept above the keyboard (`visualViewport`) | On; if the stock path does not start, a toast says "Press and hold a card" (`controller/select-mode.js`) |
| Phone tap targets | Client | Selection-bar buttons and the bulk tag dialog's chips and buttons at least 40 px | On, no switch (phone layout) |
| Double-tap seek | Client | Double-tap the side thirds of the video page to seek 10 s | On, no switch (touch only) |
| Saved playback speed | Client | The speed picked in the player menu is remembered across browser sessions | On, no switch; plain 1x clears it |
| Hold for 2x | Client | Press and hold the video (touch or primary mouse button) to play at 2x until release | On, no switch (not on TV layout) |
| Enhance badge in the OSD | Client | A chip under the OSD top bar saying what the server is doing for this stream; tap opens Enhance | On, hidden when the plugin does not answer (not on TV layout) |
| Client-side upscaling | Client | When the stream is shown at 1.15x its decoded size or more, this browser upscales it on its own GPU (WebGL2: deblock + deband, then FSR 1 EASU + RCAS); the badge says "This device: ..." | Auto by default; Off / Auto / Always per device in Enhance > "On this device" (not on TV layout) |
| Swipe volume and brightness | Client | Vertical swipe on the right half of the video changes volume, on the left half brightness | On, no switch (touch only, not on TV layout; volume off where the device ignores it) |
| Clip Up Next | Client | "Next video in N s" card for queued clips | On, no switch |
| Play-all fixes | Client | Play all and Shuffle queue up to 1000 items; Home Videos folders queue videos | On, no switch |
| Bulk tag add/remove, Edit tags | Client | Extra rows in the selection menu and the item menu (administrators) | On for administrators |
| Previous / next on a details page | Client | Skip-back and skip-forward buttons step through the list the item was opened from | On, no switch (not on TV); only when the item is in the remembered list |
| Download button for videos | Client | The stock Download button shows on a video's page when the server allows downloading | On, no switch (not on TV) |
| Tag autocomplete in the metadata editor | Client | The tag prompt suggests existing tags, accepts "a, b, c" as three tags and refuses duplicates | On, no switch (not on TV) |
| Tag counts and count order on `/Items/Filters` | Server patch | `jpTagOrder=count` orders the tag list most-used first; `jpTagCounts=1` adds the counts in a header | Only when the request sends the parameter; counts only from the filter cache (section 7.5) |
| Tag management (config page) | Server route + config page | Dashboard, Plugins, Jellyfin Plus: list tags with item counts, rename, merge, delete across items, with a dry run first | Administrators only; nothing is written without Apply (section 6) |
| Folder covers link instead of copy | Server patch + scheduled tasks | A folder's generated cover is a symlink to the child image it shows, not a 2-3 MB copy of it in `metadata/library`; two tasks convert existing copies ("Jellyfin Plus: link folder images instead of copies", and a "(dry run)" that only counts) | On, no switch; falls back to the stock copy (section 7.9) |
| Maintenance task buttons (config page) | Config page | Start "Scan people" and "Optimize database" from the plugin page | Administrators only; stock endpoints (section 6) |
| Preference sync across devices | Client | Enhance panel choices and search paging choices follow the viewer to other browsers | On, no switch; falls back to localStorage alone if jellyfin-web's settings object is not found (section 6) |

## 1. GPU upscaling and enhancement

Concise on purpose; the existing documents carry the detail: [README.md](README.md) (levels,
configuration, measurements), [ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md), [NEURAL.md](docs/filters/NEURAL.md),
[LIVE_APPLY_DESIGN.md](docs/architecture/LIVE_APPLY_DESIGN.md), [WEB_PANEL_DESIGN.md](docs/architecture/WEB_PANEL_DESIGN.md).

**What it does.** Jellyfin 12.1 and 12.3 have no plugin hook for the video filter graph, so five methods of
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
`markSearch`: the Suggestions clips rewrite, exclude box, then Sort and filter, then paging).

**Tag matching** (`src/patcher/SearchPatches.cs`). Stock search matches item names only. This adds
items whose tag contains the search term, as a case-insensitive, diacritic-insensitive substring
(both sides go through Jellyfin's `GetCleanValue()`). A tag-only match scores 40, below a stock name
match (50), so a title match ranks above a tag-only match. It runs through the stock provider's own
type, media, parent, user-access and alternate-version filters, so a tag match is limited to what a
name match could return. It applies to both `/Items?searchTerm=` and `/Search/Hints`.

**Wildcards.** In the search term `*` means any run of characters (none included) and `?` exactly one
character; a term with neither is searched exactly as before. `red*car` is `LIKE '%red%car%'`: the
pattern is unanchored at both ends, like the plain contains. Each literal piece between wildcards is
cleaned like stored names (`GetCleanValue()`: lowercase, diacritics stripped, punctuation to spaces), so
the match is case- and diacritic-insensitive, and the same pattern is matched against item names and
OriginalTitle, and against tag values (with the per-tag exclude rule below). Stock search cannot do this (its cleaning turns `*` into a space and
it searches the literal text), so for a wildcard term the stock results are dropped, not merged: they
would be a subset of the real matches at best, and wrong (one space where `??` needs two) at worst. Name
matches keep the stock score tiers (exact 100, prefix 80, word prefix 75, contains 50), tag-only
matches 40. A term with no literal text (`*`, `**`, `?`, `*-*`) is no search, as stock; more than 8
literal pieces is not treated as a pattern. A wildcard term with no match returns one empty-id result
so the items controller does not fall back to the stock literal search. Matching uses `LIKE ... ESCAPE`,
never `GLOB` (case-sensitive), with `%`, `_` and `\` escaped inside literals. OriginalTitle is matched as
the stock provider does, with the diacritic-stripped but uncleaned literals through SQLite's
ASCII-case-insensitive LIKE. When the search index (7.6) is fresh and a column has a literal piece of 3 or
more characters, the index narrows the candidates first (about 37 ms to 1.5 ms median); otherwise the plain LIKE runs.

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

**Sort** (`src/patcher/SearchSortPatches.cs`). On Jellyfin 12.1 and 12.3 the search page's `sortBy` is thrown
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
Finished answers are cached in server memory (`FacetResultCache`): key is the user, a digest of that
user's access settings (folders, tag and rating limits) and every query parameter (sorted, credentials
removed); invalidated by any item add/update/remove or user-data save; 5 minute TTL; LRU of 200 entries.
A hit reports `facets-cache` in `Server-Timing`.

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

**Tag picker window** (`web/src/controller/search-filters.js`, `web/src/controller/tag-window.js`). The
Tags section of the sheet no longer downloads the library's whole tag list: it asks `/Items/Filters` for
the first 100 tags containing the typed text (`jpTagLimit`, `jpTagQuery`, section 7.5) on opening and on
every pause in typing, and shows "Showing N of M matching tags". Picked tags stay visible as chips.
Without server support it falls back to filtering the full list in the browser.

**Skipping searches that cannot match** (`web/src/controller/search-census.js`,
`web/src/model/search-census.js`, `src/LibraryCensusController.cs`). The search page sends a request per
result kind (artists, people, studios, programs, videos, all-types) whether or not the library has any.
`GET /JellyfinPlus/Library/Census` says which item kinds the user has; a request whose kinds are all
known to the census and all absent is rewritten to an `/Items?ids=<nil guid>` lookup, which returns the
stock empty result for no real work. Examples: Artists with no music, Studios with none, Live TV
programs and channels with none, the all-types list when none of its types exist. A kind the census
does not cover is never assumed absent. The census is cached per user for 5 minutes in the browser
and on the server (the server drops it on item add or remove). With no census yet, or on an error,
nothing is skipped. It runs innermost in the fetch/XHR chain, so it judges the URL after Sort and
filter and paging have rewritten it.

**Library-scope fix** (`web/src/controller/search-scope.js`). Searching from inside a Home Videos
(or music videos, mixed, photos) library puts `collectionType` in the search URL, which makes stock
disable the Videos query and ask for a type list without `Video`, so clips can never match. The script
drops `collectionType` for types other than movies, tvshows, music, livetv, books, boxsets and
playlists, keeping `parentId`, so the search is scoped to that library and clips are returned.

**Recent searches** (`web/src/view/search-recent.js`, `web/src/model/search-recent.js`). Every term the
page commits (`?query=` in the hash; with search-on-submit that is exactly what was submitted) is kept,
newest first, up to 12, de-duplicated ignoring case, terms of 2 to 200 characters. While no term is
committed (the empty page that shows Suggestions) a row of chips sits under the search fields, below
the exclude box and the Sort and filter bar. Tap a chip to search it (it goes through the same submit
path as Enter, `runSearch()` in `search-exclude.js`); the x forgets one, "Clear" forgets all. Terms
only: the exclude text and filters are not part of a recent search. The URL is read from the page's
DOM mutations, not `hashchange`: react-router changes the hash with `pushState`, which fires no
`hashchange`. Not on TV layouts (the alpha picker searches letter by letter). If storage is refused the
row still works for the page view.

**Search box length**: dropped in the 12.3 port. jellyfin-web 12.1 put `maxLength={40}` on
`#searchTextInput` and `view/search-recent.js` raised it to 200; jellyfin-web 12.3 removed the cap itself
(PR #8412), so the plugin no longer touches the input.

**Suggestions for clip libraries** (`web/src/model/search-suggest.js`, called from `markSearch` in
`controller/network.js`). The empty search page's Suggestions asks for 20 random items, favourites
first, of types Movie, Series and MusicArtist, so a Home Videos library gets an empty list. On the
search page the script adds `Video` to that request's `includeItemTypes` and changes nothing else. The
request is recognised by shape (an `/Items` path, no `searchTerm`, `sortBy` naming IsFavoriteOrLiked
and Random, `includeItemTypes` naming all three types); any other request, or a changed stock request,
is left exactly as it is. It adds `Video` in the form the request already uses (a repeated key, or one
comma-separated value, which is the only form the server's binder splits). A mixed library keeps its
movies and series. The server cost is a random-order query of 20 items; on the 47k-video real database
a raw SQLite `ORDER BY random() LIMIT 20` over Video is about 35 ms.

**Type filter and the People and Studios rows.** The Type filter steers only the two `/Items`
queries. The People and Studios rows come from `/Persons` and `/Studios`, so they stay on screen
under Type: Videos, and there is no People-only or Studios-only type. Not changed: it needs entries in
`TYPES` and `typePlan` in `model/search-filters.js`.

## 3. Library browsing and filters

**Home Videos libraries open on Videos** (`web/src/controller/library-landing.js`,
`web/src/model/library-landing.js`): stock `getDefaultViewIndex()` reads the per-library default
screen from this device's localStorage (`<userId>-landing-<libraryId>`, the key the Settings > Home
"default screen" select writes) and otherwise opens Folders. Once per user per page load the client
reads `/UserViews` and the server copy of the user's settings (`DisplayPreferences/usersettings`,
client `emby`), and writes that key for every Home Videos library where this device has none: the
user's server-side choice if there is one, else `videos`. A stored value is never overwritten, so
picking Folders in Settings > Home sticks. If the library page was already open on its stock default
when the key got seeded, it switches to the Videos tab (`&tab=3`) once. Fails soft to stock.

**Filter popover additions** (`web/src/view/library-filter-panel.js`,
`web/src/controller/library-filters.js`, `web/src/model/library-filter-marks.js`):

- Tags accordion: a search box, an exclude button on each tag row, excluded tags as removable chips, and
  a "match ALL selected tags" switch (stock is "any"). Not offered on tabs served by their own endpoint
  (artists, album artists, authors, studios), where the parameters would be ignored.
- Long tag lists are windowed: a list over 300 tags is shrunk to the selected and excluded tags plus
  the first 100 that match the search text, so React does not render thousands of checkboxes. The
  window comes from the server (`jpTagLimit` / `jpTagQuery` on `/Items/Filters`, section 7.5): the
  popover's request asks for at most 301 tags (a library with fewer gets its whole list), and typing
  fetches the next 100 matching the text instead of filtering a downloaded list. A server without the
  parameters answers in full and the old client-side windowing runs. The stock checkboxes and selection
  handling are used throughout (`web/src/controller/tag-window.js`, `library-filters.js`).
- Resolution (HD, 4K, SD), Studios and People on the tabs where stock hides them: Videos, Folders,
  Mixed and Music videos. Resolution uses the stock `IsHD`/`Is4K`/`IsSD` filters, labelled "HD (1200 px
  wide or more)".

**How the extra state travels.** The page keeps filters in its own per-tab settings object, which has
no field for these. The extra state rides as marker strings inside `Filters.Tags` (which is persisted,
is part of the query key and is cleared by the stock reset button, which 12.3 moved from the filter popover to the library toolbar and which sets `Filters` to undefined). Outgoing `/Items` requests are
rewritten to `excludeTagNames` (one parameter per tag, taken verbatim), `tagMatch=all` and `personIds`.
Markers are removed from every other URL, and a marker that is never rewritten reaches the server as a
tag nothing has: an empty list, not a wrong one.

**Server side** (`src/patcher/LibraryFilterPatches.cs`, section 7.4). `excludeTagNames` is an exact
match on the cleaned tag name, unlike the search page's substring `excludeTags`.

**List pages: sort and paging** (`web/src/controller/list-requests.js`, `web/src/controller/list-sort.js`,
models `web/src/model/list-requests.js` and `list-sort.js`; server `src/patcher/ListSortPatches.cs`, section 7.8).

- **Random that pages without repeats.** Stock sorts Random with SQLite's `random()` per query, so
  every page is a new shuffle and page 2 repeats page 1. A list-page `/Items` request that sorts by
  Random and carries `startIndex` and `limit` now also carries `jpListSeed=<n>`; the server then orders
  by a fixed function of (item id, n). The seed is per list (the URL without `startIndex`/`limit`), kept
  for the page load: every page of one list is one shuffle, the other sort direction or another filter
  is its own, a page reload or the list page's Shuffle button reshuffles. Requests that must stay
  truly random are left alone: the playback queue (asks for Chapters), home rows and screensavers
  (no `startIndex`), searches (`searchTerm` / `jpSeed`), requests that opt out of the total count.
- **Sort menu.** The legacy list page (tag, person, studio, genre and folder lists) gets Random and
  Recently edited appended to its sort menu, on lists that already offer Date added (not Live TV);
  the modern library tabs already have Random and gain Recently edited (Movies, Videos, Music videos,
  Folders, Mixed, Photos, Photo albums, Favourites) as one more row in the sort popover. Recently
  edited sorts by the item's `DateLastSaved` (the server's sort list has no such key; see 7.8); in
  the modern popover the first pick is newest first and picking it again flips the direction.
  The legacy menu is found by shape (the list controller's default export class and the sort menu
  class are located among webpack module exports and wrapped on their prototypes).
- **Tag lists open newest first.** The tag link goes to `#/list?type=tag&tag=...`, which reads its sort
  from saved view settings only. While a tag list's saved sort is the stock default (Name, ascending)
  and no sort has been picked on it through the menu, it opens as Date added, newest first. A sort
  you pick is remembered as picked (`jellyfinPlus.listSortChosen`) and then rules, including Name.
- **Favourites.** Each section on the Favourites page requests 20 items (`Limit=20`, no total count,
  a signature nothing else sends); on non-TV layouts that becomes 100. The section title still links
  to the full list.
- **Measured, not shipped: skipping `TotalRecordCount` (QOL 34).** On the real library the count is about
  half of a list page's server time (page of 100: 118 ms with the count against 65 ms without for a
  Videos list; 213 against 113 ms for a 40k-item tag list; 30 to 100 ms in every shape tried). Both
  pagers need the number, though (the legacy one for "x-y of N" and to enable Next, the modern one for
  its page count), so it could only be skipped by inventing a total, or on page 2 onwards by remembering
  page 1's. A saving of 50 ms on a click that takes a human a second was judged not worth rewriting
  response bodies. A server-side memo of the count per filtered set would be the clean route.
- **Not changed: `IncludeItemTypes=tag` (QOL 40).** The legacy list sends the list type as an item
  type for `type=tag`. The server's `CommaDelimitedCollectionModelBinder` catches the `FormatException`
  an unknown enum name raises and drops the value, so the request is an unfiltered (all types) one,
  exactly what stripping it would give. Cosmetic; nothing is rewritten.
- **Not changed: filter button on tag lists (QOL 16).** Stock already shows it: the legacy list's
  `getVisibleFilters` only special-cases Live TV programs and Next Up. The Alpha picker is the real gap
  (`initAlphaPicker` runs only when the list has a parent item, and tag lists have none) and is not
  added: it lives in closure state of the list controller that a wrapper cannot reach safely.

**Filter key cache** (`src/patcher/FilterCacheEngine.cs`, `src/patcher/FilterCachePatches.cs`,
`src/FilterCache.cs`). Stock recomputes `/Items/Filters` and `/Items/Filters2` (tags, genres, years,
official ratings) on every request, which the code comments measure at 4 to 7 seconds on a library of
about 47 000 items and 12 000 tags. The cache stores the keys in two tables inside Jellyfin's
`jellyfin.db` (section 11) and answers from them when that is safe, otherwise stock runs untouched.

- It is checked, not assumed: each library has a fingerprint (row count plus newest `DateLastSaved`),
  compared on every request that would be served from the cache. A mismatch means stale, and the
  request goes to stock. The fingerprint itself is memoized in memory per library: recomputed only after
  an item event, after a rebuild, or after 60 seconds (safety TTL), instead of per request (~35 ms on a
  47k-item library, ~0.0002 ms when remembered). Same value, same semantics.
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

**Previous / next** (`web/src/controller/detail-nav.js`, `model/detail-nav.js`, shared page watcher
`controller/detail-page.js`). Stock has no "the list I came from". A click that opens an item from a
card or list row (the stock handler's own test: `data-action="link"`) stores, in `sessionStorage`
(section 10), the ids of the cards in that card's items container in page order, plus the route the
list was on. On a details page the item is looked up in that list: if it is there, skip-back and
skip-forward buttons (a copy of the stock Replay button, so they look and focus like the rest) appear
before Download and go to the neighbour's `#/details?id=...&serverId=...`, as a card link would, so the
browser's Back button steps back through the clips. The list is only what was in the DOM at the click:
a paged list gives the current page, the infinite and virtualised search results give the gap-free run
around the click (an evicted chunk is a gap), at most 1000 ids. At either end there is no button, and an
item outside the list, or a page opened another way, gets none. The "More like this", cast, collections
and additional-parts rows are never captured; a list of one card clears the stored list. TV untouched.

**Download button** (`web/src/controller/detail-download.js`). The stock template already carries a
hidden `.btnDownload` and binds its click, but stock only shows it for Books. It is shown for a video
(`MediaType` Video) whose DTO says `CanDownload` (the server's answer, from the user's
`EnableContentDownloading` policy) and has a `Path` (the stock click handler derives the file name from
it and throws without), and hidden again on a later item that fails the test. Not on TV. The click is
stock's; nothing is re-implemented.

**Primary Play and sticky action bar** (`web/src/view/detail-actions.js`, redesign P7). Nothing is
re-created: the stock Play/Resume button (else the stock Replay button) in `.mainDetailButtons` gets
`jpPrimaryPlay` and a visible label copied from its title, and CSS draws it as an accent button first
in the row (full width on phone/tablet, the other buttons as 44 px icons). A bar inside
`#itemDetailPage` docks under `.skinHeader` once the row has scrolled out above it (IntersectionObserver):
title, previous / next (twins of detail-nav's `.jpNavBtn` buttons), favourite heart, Play, More. Every bar
button only calls `.click()` on its stock twin, so Play resumes at the stored position, the heart runs
stock's `emby-ratingbutton` handler (`updateFavoriteStatus`) and is read back from its `data-isfavorite`
(also kept current by stock's UserDataChanged subscription), and Download stays in the row. Stock shows
the favourite button for any item `canRate` accepts (everything with UserData except Program, Timer,
Channel, CollectionFolder, UserView); it is not hidden on phone. Scoped to
`html:not(.jp-theme-off):not(.layout-tv)`; hidden while `html.jp-sheet-open`. No storage keys.

## 5. Cards and playback

**Image look-ahead** (`web/src/controller/image-preload.js`, `web/src/model/image-preload.js`). Stock
jellyfin-web starts a card image only when the card is within half a viewport, and empties it again
when it scrolls back out, so returning to it fetches and fades it in a second time. The server pays
about 0.3 s per image the first time a size is requested (it resizes, then caches; measured on CT114:
291 ms mean, 445 ms max cold, 1 ms warm). The client patches every LazyLoader-shaped class it finds
(found by shape, one level into module exports, because the class sits on the default-export object
`{LazyLoader, lazyChildren}`; the same in the 12.1 and 12.3 builds). For each loader:
- **Look-ahead pass:** a second observer, 250% of the viewport wide, requests the cards' own `data-src`
  image URLs early. The requests are low priority, at most 4 in flight, nearest to the viewport first,
  and each URL is fetched once per page load. The server resizes ahead of need, and the browser caches
  the result, since tagged image URLs are served `max-age=31536000, immutable`. When stock's own fill
  arrives, it hits the cache.
- **No unloading:** a loaded image is no longer emptied when it scrolls out of range. Only elements
  actually showing an image are kept; genre rows, which use the same loader for other content, behave
  exactly as stock.

Stock's own observer and the URLs it asks for are unchanged. Off switch:
`localStorage jellyfinPlus.imagePreload = off`. Not active on the TV layout.

**Library grid, card treatment, phone filter sheet, hearts everywhere** (redesign P5/P6; no storage
keys). `view/library-grid.js` turns wrapping card lists (`.itemsContainer.vertical-wrap`, not home,
details or Search) into a grid on phone/tablet tiers; columns = `columnsFor(width, shape)`
(`model/grid-density.js`, minimum card width per shape in rem, never a fixed 2/3), recomputed on
resize. Under `.jpGrid` the title sits over the picture, chips top-left, heart + more bottom-right
(play is dropped; a tap on the picture opens or plays). Image requests are unchanged (cardBuilder's
own `getPostersPerRow`). Search's phone grid is `auto-fill` too. On phones the library filter popover
is restyled as a bottom sheet (same stock MUI Popover, so state and request are stock's; Done presses
the stock backdrop); `html.jp-sheet-open` is set while open. The card-actions heart now shows on every
non-TV tier (44 px) and on `.listItem` rows that have no stock heart, kept in step with stock's
hearts through `data-isfavorite`.

**Mobile card actions** (`web/src/view/card-actions.js`). Under `html.layout-mobile`, a row of
favourite, more and play buttons on each card in an items container (stock shows favourite and more
only in a desktop hover overlay). More and Play use the stock `itemAction` handlers; Favourite calls
`ApiClient.updateFavoriteStatus`, with the heart state read in small batches for cards that scroll into
view. Tap targets are 40 px. The row is hidden during multi-select. The heart state comes from the
shared lookup in `controller/card-data.js` (below), which also feeds the badges, so one request serves
both. Beyond the row, the same file gives the stock selection bar's two buttons a 44 px minimum and the
bulk tag dialog's suggestion chips and buttons 40 / 44 px under `html.layout-mobile` (padding and
minimum sizes only; QOL_IDEAS #17). Not changed: tablets that report the desktop layout still have no
always-visible card buttons, and the footer "more" button some cardLayout lists draw is left in place
next to the row's own (checked against the v12.1 sources, not on a device).

**Card badges** (`web/src/view/card-badges.js`, `web/src/controller/card-data.js`,
`web/src/model/card-badges.js`; QOL_IDEAS #41). On Video, Movie, Episode, MusicVideo and Trailer cards:
a chip group at the top left of the thumbnail ("1080p" and the runtime, "12:34" or "1:02:03") and one
footer line under the title with the first two tags ("tag one - tag two"). Resolution is judged on
both pixel sides (1920x800 is 1080p, a vertical 1080x1920 clip is too): 4K, 1440p, 1080p, 720p, 480p,
SD. The chips ignore pointer events; a card with no footer under the thumbnail gets no tag line. Not
on TV layouts.
- **Data is NOT added to list requests.** A card is watched with an IntersectionObserver (300 px
  margin); near the screen, its id joins a batch of up to 40 that goes out after 150 ms as one plain
  `Users/{id}/Items?Ids=..&Fields=Tags,Width,Height&EnableImages=false&EnableTotalRecordCount=false`.
  `UserData` and `RunTimeTicks` are in the default DTO. The answer is reduced to a small record and
  cached for the page (4000 records), so redrawn cards (virtual chunks, React re-render) cost nothing.
- **Measured why.** On the real library (46,375 of 47,622 videos carry tags, 44 on average) the
  `Tags` array alone is 635 bytes per item as JSON (95th percentile 1.0 KB, maximum 2.5 KB): about
  65 KB on a random 100-card page (three samples: 64.9, 65.6, 65.9 KB), against about 2.5 KB for
  `Width` + `Height`. The server does no extra work for it (`BaseItemMapper` maps the `Tags` column
  onto the DTO on every read; `Fields` only gates serialisation), so the cost is bytes on the wire and
  parsing, paid on every page view if it rode on the list request. Looked up per visible card, only
  what scrolls into view is paid for. Estimated from the database, not measured as a served response.
- **Caveat.** Tags are shown in stored order, and an item has 44 on average, so "the first two" is
  whatever was stored first, not the most informative.
- **Off switch.** `localStorage jellyfinPlus.cardBadges` = `off` (read at load): no badges, and the
  lookup then asks for no extra `Fields` (the favourite hearts still use it).

**Select all N results** (`web/src/controller/select-all.js`, `web/src/model/select-all.js`;
QOL_IDEAS #42; administrators only, because the only thing that reads it is the bulk tag flow). Stock
"Select all" ticks the cards that are drawn. With cards ticked, the selection menu gains "Select all N
results" under it when N is more than what is ticked. Choosing it re-asks the list's own query, page by
page (200 at a time), for ids only and holds them; a banner under the selection bar reads "All N
results selected for Add tags / Remove tags" with Clear. "Add tags" / "Remove tags" then run over all N
(dialog note "All N results of this list") instead of the ticked cards, through the same careful
per-item flow as section 6.
- **Finding the list.** XHR and fetch responses of list queries (GET `.../Items` with a page size, no
  `ids`, not a one-item cut or a tag-window request) are read on a side branch, never altered, into at
  most 12 "groups": the request's final url without its paging (`xhr.responseURL`, `response.url`, so
  every other hook's rewrite is in it), the ids its pages brought and `TotalRecordCount`. The ticked
  ids pick the most recent group holding all of them. No match (the list came from React Query's
  cache and never crossed the network here) or no more results than ticked: the row is not offered and
  stock behaviour is untouched.
- **Collecting.** Only paging and payload change: `startIndex`, `limit=200`,
  `enableTotalRecordCount=false`, `enableImages=false`, `enableUserData=false`, no `Fields`, and
  `jpInf=1` so the search page's own rewrite and response watchers ignore the request (the same way
  `fetchMore` does). A `Random` sort without a `jpSeed` becomes `SortName` (reshuffling between pages
  would drop and repeat items; the set is the same); a seeded one is kept. The run must return at least
  the counted total, or nothing is selected and the banner says how many it got.
- **Limits.** At most 5000 results: over that nothing is selected and the banner says to narrow the list
  (a partial selection presented as "all" would tag the wrong set). The selection is dropped when a
  card is ticked or unticked, Clear is tapped, the selection bar closes, or the page changes. The other
  commands in the same menu (playlist, delete, mark played, group versions) are stock and still act on
  the ticked cards only: nothing here pretends to tick them. In the all-types search the ids include
  types the tag editor refuses (Series, Season, MusicAlbum, People ...); the run reports those as skipped.
  Remove-tag suggestions read the tags of every selected item, at most 4 requests at a time.

**Video page gestures** (`web/src/controller/player-gestures.js`, arbiter in
`web/src/model/player-gesture.js`, actions in `controller/player-actions.js`, overlays in
`view/player-hud.js`). One arbiter classifies every press on the video surface, so the four gestures
below cannot overlap. Stock (`apps/legacy/controllers/playback/video/index.js`) acts on the press
itself: a touch toggles the OSD at once, a mouse press arms a 300 ms play/pause timer. So for a press
on `#videoOsdPage` (not on a control, the bottom OSD or the header; primary pointer; touch or primary
mouse button; not `html.layout-tv`; needs `window.PointerEvent`) the listener runs first in the capture
phase, stops the stock `pointerdown`, and watches the press. A tap, a horizontal or diagonal move, a
mouse drag, and a refused hold or swipe are handed back by **replaying the original pointerdown** (a
synthetic `PointerEvent` with the same type, button and position) to its target, so stock handles it as
before, at release for a tap and at the verdict otherwise. Stock therefore sees a tap a press-length
late, and never sees a hold or a swipe. The thresholds, all in `THRESHOLDS`:

| Constant | Value | Meaning |
|---|---|---|
| `HOLD_MS` | 400 ms | a press that stays within the slop this long is a hold |
| `HOLD_SLOP_PX` | 10 px | jitter below this is still the same press; past it, a vertical touch move is a swipe, anything else is a pass |
| `DOUBLE_TAP_MS` / `DOUBLE_TAP_SLOP_PX` | 280 ms / 60 px | second tap on the same side third, down to down (under stock's 300 ms OSD debounce) |
| `VERTICAL_RATIO` | 1.5 | `\|dy\|` must be at least 1.5 x `\|dx\|` to be a swipe |
| `SWIPE_RANGE` | 0.7 | a swipe of 70% of the page height sweeps the full range |

- **Double-tap seek.** Touch only. A double tap on the left third seeks back 10 s, the right third
  forward 10 s; more taps on the same side within the window keep adding, with a hint. The middle third,
  controls and the mouse are left to jellyfin. The first tap of a pair is a normal tap.
- **Hold for 2x.** Touch or primary mouse button, on the video surface (any third). After 400 ms a
  "2x" pill shows at the top centre and the player plays at 2x until release, then the previous rate
  returns (only if the rate is still 2x; a rate picked meanwhile is left alone). A paused video, or a
  player without the rate API, refuses the hold and the press goes to stock. The 2x is set on the
  player object (`setPlaybackRate`), not through `playbackManager.setPlaybackRate`, so it is never
  written to sessionStorage and never saved. The mouse hold has a cost: the stock mouse press is
  replayed at release, so a plain click pauses/plays about one press-length later than before. The
  context menu is suppressed during a hold or swipe, and a moving mouse does not pop the OSD during a
  hold.
- **Swipe volume and brightness.** Touch only. A vertical swipe starting on the right half changes the
  volume (`playbackManager.setVolume`, found by shape, unmuting if needed) and on the left half the
  brightness, with a level bar at that edge. Brightness is a CSS `filter: brightness()` on the video
  element, 0.3 to 1.5, snapping to 1 (no filter at all), saved per device in `jellyfinPlusBrightness`
  and restored at startup. Volume is disabled when assigning `audio.volume` does not stick (iOS) and
  after a swipe whose volume change did not read back; the swipe then goes to stock. The page gets
  `touch-action: pan-x pinch-zoom` so the browser does not cancel vertical swipes; horizontal moves,
  controls and the bottom OSD stay stock.

**Saved playback speed** (`web/src/controller/player-speed.js`, `model/player-speed.js`). Stock stores
the speed in sessionStorage `playbackRateSpeed` (`playbackManager.setPlaybackRate`, from the speed menu
and the remote command) and the video page re-applies it on each player state change. At startup, when
that key is absent, the saved rate is copied into it (a rate chosen earlier in the tab is never
overwritten); on every `ratechange` of a `<video>` the session value is mirrored to localStorage
`jellyfinPlusPlaybackRate` (1x removes it; values outside 0.25 to 4 are ignored). The mirror reads the
session key, so the hold-for-2x is never saved.

**Enhance badge in the OSD** (`web/src/controller/player-badge.js`, `model/player-badge.js`). A chip
under the top bar, shown with the OSD (it follows jellyfin-web's `SHOW_VIDEO_OSD` event through
`document._callbacks`, the same seam `playback-hooks.js` uses on the playbackManager; one fixed element
on `<body>`, so it works in both the legacy and the MUI OSD header). Its text is the server's own
`Summary` for the session record (including the honest negatives: not applied for stream copy, burn-in,
concurrency cap, viewer chose Off) or, when there is no record, the client's existing `activeState()`
label ("Not enhancing", "Waiting for the server", "Enhancement unavailable"); nothing is derived from
the panel's selection. Long text is clipped with an ellipsis and carried in full in the tooltip. Tap
opens the Enhance panel (`openEnhancePanel`). It refreshes when the OSD appears, when the play session id
changes (playback start and landed live applies, with a few one-second follow-ups while the server
writes its record), and every 5 s while shown, using `GET /JellyfinPlus/Session/{id}` (section 8); it
is hidden when the probe does not answer fully, off the video page and on the TV layout. Client-side
upscaling (below) adds its own line, always worded "This device: ...", and can be the chip's only line
when the plugin does not answer (client upscaling needs no server).

**Client-side upscaling** (`web/src/controller/client-upscale.js`, `controller/client-upscale-gl.js`,
`model/client-upscale.js`, `model/shaders/fsr1.js`, `model/shaders/cleanup.js`,
`view/client-upscale-panel.js`). For low-bandwidth viewing: when the decoded video is meaningfully
smaller than its on-screen size in device pixels, the viewer's own GPU upscales it. Nothing reaches the
server: no request parameter, not a server axis, no restream. The bitrate stays the viewer's choice.
- *Pipeline*, WebGL2, driven by `requestVideoFrameCallback` (fallback `requestAnimationFrame` plus a
  `currentTime` check, only while playing): `texImage2D(video)` -> deblock (8px block edges, both sides
  flat and a small step only) -> deband (4-tap random cross, threshold, sub-LSB dither), both at source
  resolution -> FSR 1 EASU to output resolution -> FSR 1 RCAS -> the canvas. FSR 1 is ported from AMD's
  `ffx_fsr1.h` (MIT, header kept in `fsr1.js`); the cleanup shaders are this project's own.
- *Placement*: a `<canvas>` inserted directly after `video.htmlvideoplayer` in the same parent, sized to
  the `object-fit` content rect (contain letterbox, cover crop) in device pixels, capped at 3840x2160
  pixels. The video keeps playing under it (it is covered, never hidden, so decode and frame callbacks
  continue). Subtitle layers jellyfin-web appends after the video stay above it; the OSD is above all of
  it. The brightness swipe's filter applies to the canvas too.
- *Auto rule* (`decide()`): on when the displayed scale is >= 1.15 on either axis (Always: > 1.0); never
  when it would minify. A server that already sends display-sized frames leaves Auto off by itself.
  Re-evaluated on the video's `resize`/`loadedmetadata`, a ResizeObserver on the video and its
  container, window resize, text-track changes, PiP and fullscreen events, and a 1 s watchdog.
- *Governor*: per ~48-frame window it counts frames the render loop missed (`presentedFrames` gaps),
  dropped frames (`getVideoPlaybackQuality()`) and, where available, GPU time
  (`EXT_disjoint_timer_query_webgl2`). Two bad windows (>8% lost, or GPU > 85% of the frame interval)
  step down: drop cleanup, then RCAS, then off; twenty good windows step back up. Off stays off for that
  video. The badge says "(reduced: GPU too slow)" / "off (GPU too slow)".
- *Fail soft*: no WebGL2, a shader/GL error, a lost context (restored on `webglcontextrestored`), a
  `texImage2D` that throws (cross-origin without CORS), iOS native fullscreen, Picture-in-Picture, a
  native (`::cue`) text track showing, the TV layout: the canvas is hidden, the stock video shows, the
  reason is logged once and named in the badge. Mode Off and the TV layout attach nothing at all.
- *Settings*: "On this device" in the Enhance panel, below the server section: Upscale here Off / Auto /
  Always, Cleanup Off / Low / High, Sharpness Strong / Default / Gentle / Light (RCAS 0 / 0.25 / 0.5 / 1
  stops). Applied at once, stored per device (section 10), never synced.

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

**Autocomplete in the metadata editor** (`web/src/controller/tag-autocomplete.js`,
`model/tag-input.js`). Stock adds a tag through a bare "Value:" prompt and stores whatever is typed as
one tag, so "a, b" becomes a tag named "a, b" and a typo makes a near duplicate. For the prompt opened
by the Tags section's "+" button only (genres and studios use the same prompt and stay stock):
- Suggestions appear under the box for the tag being typed (the text after the last comma): names
  containing it, prefix matches first, minus tags already in the list or already typed. They come from
  `GET /Items/Filters` with `jpTagLimit=20` and `jpTagQuery` through `controller/tag-window.js`, after
  180 ms of quiet, so the 12,000-tag list is never downloaded; a server without those parameters
  returns the full list and `tag-window.js` narrows it in the browser. Answers are cached per typed text
  for the dialog's life; a late answer for older text is dropped.
- Adding splits on commas and uses the bulk editor's `parseTags` and `mergeTags` (trim, drop blanks,
  case-insensitive de-duplication, the spelling already stored wins). Each new tag becomes its own row,
  in the editor's own order, and the prompt is closed through its Back button. If every typed tag is
  already in the list the prompt stays open and says which. An empty box is left to stock.
- The editor's Save reads the tag list from the DOM, which is why rows added here are saved like any
  other. How the prompt is recognised: the click on "+" arms a 15 second MutationObserver that
  attaches to the first dialog holding `#txtInput`. If the prompt's shape is unexpected (no Back
  button, no form), nothing is attached or intercepted. Not on TV.
- Not changed: the bulk and single "Add tags" dialog above still loads the whole tag list once per
  page (`loadTagNames`) for its suggestions.
**Normalisation on save (QOL_IDEAS 29): already stock, nothing added.** Checked against the 12.1
assemblies: `ItemUpdateController.UpdateItem` does `request.Tags.Select(Trim).Distinct(OrdinalIgnoreCase)`
(first casing kept), and the item persistence layer drops blank values when it writes `ItemValues`.
So `Foo`, `foo ` and `foo` already end up as one tag on any save through the editor or the bulk dialog.
What stock does not do is clean up tags that already exist (case or punctuation variants on different
items); the tag management page below does that.

### Tag management (config page and `/JellyfinPlus/Tags`)

`src/TagAdminController.cs`, the "Tags" section of `src/Configuration/configPage.html`.
Administrators only (`RequiresElevation` on the whole controller; the page itself is the dashboard's).

- **List.** Every stored tag spelling that at least one item carries, with its item count, searchable
  (case-insensitive substring), ordered by count or name, 100 per page. "Foo" and "foo" are separate rows;
  the `spellings` note marks tags that share Jellyfin's cleaned form (lower case, no punctuation) with
  another row, which is what the filters treat as one tag. The list is read from `ItemValues` /
  `ItemValuesMap` (one grouped query, about 0.15 to 0.6 s on 15,000 tags and 2.3 M map rows) and kept in
  memory for 2 minutes or until an item changes.
- **Edit.** Rename (one source), Merge (one or more sources into a target spelling) and Delete (remove
  from every item), always matched by exact stored spelling. The page does Preview first: a dry run that
  returns how many items carry the tags, how many would change, and how many are skipped because `Tags`
  is in their `LockedFields`. Apply sends the same request with `dryRun: false` and the previewed count;
  if the live count differs the server answers 409 and writes nothing. `dryRun` defaults to true, so a
  request that forgets the flag only counts.
- **How it writes.** The new tag array of every changed item is computed first, then applied and saved
  with one `ILibraryManager.UpdateItemsAsync` (a single repository transaction, update reason
  `MetadataEdit`, the path the stock editor takes), not one save per item. The parent passed is the
  items' shared parent when they have one, otherwise none (it is only reported on the `ItemUpdated`
  event). If the call throws, the in-memory items are restored. One edit runs at a time (409 otherwise),
  at most 20,000 items, the target may not contain `|` (it separates names in a `tags=` filter) or
  control characters. An item that would carry the target twice keeps one, spelled as the target.
  Because `UpdateItemsAsync` runs the metadata savers, a server set to write NFO files rewrites the NFO
  of every changed item. Since 12.3 (jellyfin PR #18279) it also recomputes each saved item's stored
  parental-rating score (`OnMetadataChanged`), as every stock save does; a score that was stale before
  the edit is corrected by it.
- **Series and albums** are edited as items in their own right; stock's editor pushes tag changes down
  to children, this does not need to, since every child carrying the tag is matched itself.

### Maintenance buttons (config page)

"Library maintenance" under the tags section: buttons for the stock scheduled tasks `RefreshPeople`
("Scan people": validates people and removes orphans) and `OptimizeDatabaseTask`. Tasks are found by
`Key` in `GET /ScheduledTasks`, started with `POST /ScheduledTasks/Running/{id}` (both stock,
administrator-only), and the state (Idle, Running with percent, last result) is shown and polled every 3 s
while one runs. Optimize asks for confirmation. There is no "collection cleanup" button: the 12.1
assemblies have no such task (the closest are `CleanupUserDataTask` and the people task above), so the
idea's third button was not built. Adding another is one entry in `TASKS` in the page script.

### Preference sync (client)

`web/src/controller/prefs-sync.js`, `web/src/model/prefs-sync.js`. The Enhance panel's choices
(`jellyfinPlusPrefs`, minus the panel position, which stays per device), the search page size
(`jellyfinPlus.searchPageSize`) and the paged/infinite choice (`jellyfinPlus.searchPaging`) are mirrored
to the viewer's `DisplayPreferences.CustomPrefs` (`jellyfinPlus.prefs`, `jellyfinPlus.searchPageSize`,
`jellyfinPlus.searchPaging`), so they follow the viewer to another browser.

- **Local first.** Modules still read and write localStorage exactly as before; the page boots with no
  extra request. After login the server copy jellyfin-web already holds is compared with the local one in a
  `setTimeout`, so nothing waits on it.
- **Writes go through jellyfin-web's own `userSettings` object**, found by shape (an instance with
  `setUserInfo`, `get`, `set`, `loadQuerySettings`) in the module exports like the query client. Reason:
  the stock `POST /DisplayPreferences` deletes every custom pref not in the body and jellyfin-web posts its
  cached copy on each of its own saves, so a write made behind its back would be erased by its next save.
  Not found: nothing syncs, a log line says so (when debug logging is on), preferences stay in localStorage.
- **Conflicts: the most recent write wins, per key.** Each server value is `{"t": <ms>, "v": <value>}`.
  This device keeps the time of its own last write per user (`jellyfinPlus.syncMeta`). On login (and on a
  user switch) a newer server value is adopted into localStorage (the local panel position is kept and the
  panel state reloaded), a newer local value is pushed, equal values do nothing, and a tie goes to the
  server. A value this device has no time for loses to a recorded server value. A change made on this
  device is pushed 1.5 s after the last edit, and is never given a time earlier than the server's copy it
  last saw. Position-only changes (dragging the panel) are not changes. Clocks are the devices' own.
- Deliberately not synced: the committed search filters and exclude box (query state), the panel's open
  sections, the debug flag, the name cache.

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

**Verified on 12.3.** Every target in this section was resolved and patched against the 12.3 server
assemblies with the exact signature given here. No signature changed between 12.1 and 12.3, and the
installed set is the same on both. One target changed meaning:
`SqlSearchProvider.SearchAsync`, whose name match also tests `SortName` in 12.3 (jellyfin PR #18223).
The FTS prefix mirrors that test (7.3, 7.6). `MetadataService.RefreshMetadata` (scan timing) fails to
patch on both 12.1 and 12.3 because the method is declared on the generic base, so scan timing runs
without that one stage.

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
- Postfix, also on a plain search: when the request has a `limit` and deep paging is installed, the final
  candidates (ids, scores), `startIndex` and `limit` are remembered on the request (`HttpContext.Items`)
  for the next patch. The returned list is not changed.

**`Jellyfin.Server.Implementations.Item.BaseItemRepository.GetItemList(InternalItemsQuery)`**, prefix
(`SearchDeepPagePatches.cs`, optional "deep search paging"). Stock `ItemsController` hands a search's
candidate ids (up to 5000 with `jpPaged`, 2400 for the all-types query) to `folder.GetItems`, which loads
EVERY one as a full entity, only for the controller to order by score, skip `startIndex`, take `limit` and
build DTOs for those few. This patch makes the load page-sized. It acts only when the request recorded a
candidate pool (see above) of at least 200 ids with a page smaller than the pool, and the query matches it
exactly (same ids in the same order, no limit, start, search term or adjacency).
- It asks the repository for the filtered ids (`GetItemIdsList`: the same query, every filter and
  user-access rule applied, nothing materialised) and for `(Id, SortName, Type)` of those ids only; works
  out the controller's own order (score descending, then SortName; preceded by `Folder`'s order-by-request
  step when the query has no `OrderBy`); loads just the page's entities with the stock `GetItemList`
  (query `ItemIds` narrowed to the page); and returns a list of the stock length and order in which only
  the page positions are real entities, the rest are stubs carrying `Id` and `SortName`. The controller's
  count, order, skip and take then land on exactly the stock page, and the total is the stock total. Stubs
  never reach a DTO.
- Falls back to the stock path (returns control to stock) when: no pool is recorded or it does not match;
  the page covers the pool; a candidate row is missing, has a null `SortName` or a `Type` that does not
  resolve (stock would drop or recompute those); the page load returns a different count; any exception
  (logged once). `JELLYFINPLUS_NO_DEEP_PAGE=1` turns the patch off.
- Measured on the real library (8 terms x 2 type filters x 5 sorts x 3 page sizes x 7 offsets, 1520 requests):
  identical page digests, totals and counts to stock in all of them. Entity load for a 5000-id pool:
  about 200 ms to about 42 ms (page 4 of 100); for the all-types 2400-id pool 117 ms to 58 ms. A page that
  reaches the end of the pool (startIndex 4800, limit 200) has nothing to save and takes the stock path.

**`MediaBrowser.Controller.Entities.Folder.SortItemsByRequest(InternalItemsQuery, IReadOnlyList<BaseItem>)`**
(private static), prefix (same file). Stock orders the loaded items by `Array.IndexOf(query.ItemIds, id)`
per item, quadratic in the id count (about 45 ms for 5000 ids). For 256 or more ids it is replaced by the
same stable ordering from a first-index dictionary. Shorter lists keep the stock code.

**Server-Timing** (`ServerTimingPatches.cs`, optional "search Server-Timing"). Every
`/Items?searchTerm=...` response carries a `Server-Timing` header with the stage durations in
milliseconds, visible in the browser's Network tab (Timing) and in `curl -i`: `search`
(`SearchManager.GetSearchResultsAsync` end to end, includes `sort`), `name` (stock SQL name match), `tags`
(what the tag-match postfix added to it), `sort` (sort / all-of-people re-score, only when one ran), `load`
(`Folder.GetItems`), `dto` (`DtoService.GetBaseItemDtos`, summed over its calls), and `total` (from the start
of the search stage to the header being sent; excludes routing, authentication and body serialisation).
With deep paging, `deep-ids` (with `pool=` and `filtered=` counts), `deep-rows` and `deep-page` (with
`loaded=`) break `load` down. Hooks: `SearchManager.GetSearchResultsAsync` (prefix First creates the
per-request bag and registers `Response.OnStarting`; postfix Last), `SqlSearchProvider.SearchAsync`
(postfixes First and Last, to split name from tags), `Folder.GetItems`, `DtoService.GetBaseItemDtos`. A
request that is not a search never gets a bag, so every hook costs one dictionary lookup on it. Only
durations and two counts are exposed. A stage whose target cannot be resolved is left out; the others
still work.

**Prefix on the same method** (`SearchPatches.SearchAsyncPrefix`). (1) A wildcard term skips the stock
query (the postfix computes name and tag matches from the pattern). (2) Otherwise, when the FTS index (7.6)
is usable and the term is one a trigram index can answer, the prefix replaces the stock query by the same
query with one more condition, "id is among the index's candidates for the term", placed straight after the
name predicate; the predicate, filters, version exclusion, score and ordering are the stock ones, so the
result is identical. Any other case runs the stock method untouched. The name predicate mirrored is 12.3's:
`CleanName` contains the cleaned term, or `OriginalTitle LIKE %term%`, or (new in 12.3, when
`BaseItem.GetSortName(term, true, server configuration)` is not blank) `SortName LIKE %shape%`. Since 12.3
also tests `SortName`, the index must answer the shape too: a term whose shape is under 3 characters or
holds `%`/`_` takes the stock path.

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

Tag window: postfixes on `Jellyfin.Api.Controllers.FilterController.GetQueryFiltersLegacy` and
`GetQueryFilters` (`FilterCachePatches.cs`), so they cover the cache-served and the stock path alike.
Two optional query parameters: `jpTagLimit` (1 to 5000) and `jpTagQuery` (a substring, matched
case- and diacritic-insensitively against each tag's `GetCleanValue()`, the same normalisation as the
stored clean values). The response's `Tags` becomes the first `jpTagLimit` matching tags, in the usual
order, and the header `X-JellyfinPlus-TagTotal` carries how many tags matched in all. The count is in a
header because the actions are declared to return `QueryFilters(Legacy)`, whose serialiser would drop
a subclass's extra property. With neither parameter, or an unusable one, the response is unchanged.
Installed even when the cache is unavailable; if the controller cannot be resolved the full list is
served.

Tag counts and count order (same postfixes, QOL_IDEAS 31): `jpTagOrder=count` puts the tags in count
descending order (name ordinal within equal counts) before `jpTagQuery` and `jpTagLimit` are applied, so
`jpTagOrder=count&jpTagLimit=50` is the 50 most used tags. `jpTagCounts=1` (implied by `jpTagOrder=count`)
adds header `X-JellyfinPlus-TagCounts`: the item counts of the returned tags, comma-separated, in the
order of `Tags`, only when 1000 tags or fewer are returned. The count is the sum of the cache's
per-(library, item type) counts, which is a distinct-item count because an item has one library and one
type; it is as stale as the cache is allowed to be (a build-time snapshot; on the real 12,210-tag library
198 keys differed from a live count). Counts exist ONLY when the filter cache answered the request: the
cache prefixes stash them for the request (`HttpContext.Items`), so they carry the cache's access
guarantees (no restricted users, only libraries the user can open) and a request answered by stock gets
none. Then the list stays in name order and header `X-JellyfinPlus-TagOrder` says `name` instead of
`count` (it is sent whenever `jpTagOrder` was given, so the client can tell). No client sends these yet:
the library filter popover is not changed by this item.

### 7.6 Search index: FTS5 trigram over names and tags (`FtsIndexEngine.cs`, `src/FtsIndex.cs`)

Three plugin-owned tables in `jellyfin.db`, created with `IF NOT EXISTS` (Jellyfin's schema is never touched):
`JellyfinPlus_FtsNames(ItemId UNINDEXED, CleanName, OriginalTitle, SortName)` (virtual, `fts5` trigram, one row per
BaseItems row; `SortName` added for 12.3's name match: a names table without it, built by a 12.1-era
plugin, is dropped with its recorded signature on start-up and rebuilt whole, about 0.6 s on 80k items),
`JellyfinPlus_FtsTags(ValueId UNINDEXED, CleanValue)` (one row per distinct tag VALUE, not per
item-tag pair: 15k rows against 2.3M map rows; the item join stays on the ItemValuesMap primary key) and
`JellyfinPlus_FtsMeta`. The index is only a PREFILTER: a trigram match returns a superset of the rows that
contain the text, and the stock predicate still runs on the real columns, so results equal the stock
results. Terms under 3 characters, and plain terms containing the LIKE wildcards `%` or `_`, are not
answered by the index (stock path). The default `detail=full` is required: trigram phrase queries fail with
`detail=column` or `none`.

Freshness is checked, not assumed. The index is used only when it was built, its recorded signature
(BaseItems row count, newest DateLastSaved, distinct tag-value count) was re-verified within the last 100 s
(a background timer re-reads it every 30 s), no library change is waiting and no refresh is running. Item
added/updated/removed events mark the item pending at once (index unused until applied); a 2 s debounced flush
(15 s cap) deletes and re-inserts those items and rewrites the small tag table in one transaction. A signature
mismatch while idle (a missed event, a change behind Jellyfin's back) schedules a full rebuild. Anything not
fresh, or any index error, falls back to the stock query. Built at start-up when stale, at the end of each library
scan (post-scan task) and by the scheduled task "Jellyfin Plus: rebuild search index". Measured on the 80k-item,
15k-tag library: full build 0.4-1.0 s, index about 45 MB (about 5% of the database), incremental flush about 120 ms.

### 7.7 Video similar items: `Emby.Server.Implementations.Library.SimilarItems.SimilarItemsManager.GetSimilarItemsAsync`

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

### 7.8 List sort keys: `Jellyfin.Server.Implementations.Item.OrderMapper.MapOrderByField(ItemSortBy, InternalItemsQuery, JellyfinDbContext)`

Postfix (`ListSortPatches.cs`, optional "list sort (seeded random, recently edited)"). Public static, the one
place a Random or DateLastContentAdded ORDER BY term is built; resolved by exact signature, so a changed
overload is not patched. It replaces the returned key expression and nothing else.
- **Seeded Random.** Sort is Random, the request path ends in `/Items`, `jpListSeed` is a positive
  integer (digits only, at most 2147483647) and the query has no search term: the key becomes the
  concatenation of 16 of the 32 hex digits of the item id, at positions chosen by a seeded shuffle
  (SplitMix64), i.e. `substr(CAST(Id AS TEXT), p0 + 1, 1) || ... ` with the 16 positions as SQL
  parameters (one EF query shape for every seed). Item ids are 36-character upper-case text (an MD5
  formatted as a guid), so the digits are uniform and the key is a seeded pseudo-random total order. 64
  bits of key: no two of the 47,621 Videos of the real library share one.
- **Recently edited.** Sort is DateLastContentAdded, `jpSortKey=DateLastSaved` is present, same path and
  search-term conditions: the key becomes the item's own `DateLastSaved`. The client cannot ask for this
  sort by name: the enum has no such member and the query binder silently drops a sortBy name it does not
  know, so the client sends the placeholder plus `jpSortKey` (`list-requests.js`). Without the patch the
  placeholder keeps its stock meaning (`DateLastMediaAdded`, empty on a Video), i.e. name order.
- **Order only.** No Where clause is added, removed or widened, so what a user may see (library access,
  parental rating, tags) is exactly what stock decided. Every other caller of Random (Suggestions, similar
  items, splash screen, image providers, playback shuffle) has no `jpListSeed` and keeps the real random order.
- **Fail soft.** Any exception leaves the stock expression (logged once); an unresolved target logs a
  warning and installs nothing.
- **Proof on the real database** (80,464-row copy, a harness compiling the patcher source against the
  server's DLLs, the real `BaseItemRepository`): the SQL translates (`ORDER BY substr(CAST("b"."Id" AS TEXT), @P0 + 1, 1) || ...,
  "b"."SortName"`); for seeds 1, 7 and 2147483647, paging the 47,621 Videos 100 at a time (477 pages) gives
  47,621 rows, all distinct, equal to the unpaged set, and the same order as a C# model of the key; seed 7
  with page size 250 gives the same order; seeds 1 and 7 share 1 of their first 100 rows; the first 2,000
  rows spread evenly over the SortName range; descending is the exact reverse; `GetItems` (with total),
  `GetItemList` and `GetItemIdsList` agree and the total is unchanged; an `ExcludeTags` filter and a type
  filter return the same row set as stock. Negative cases return stock random (two calls differ) or stock
  order: no parameter, seed 0, negative, non-numeric, overflowing, another path, no HTTP context, a search
  term, a non-Random sort. Recently edited: same row set, descending by `DateLastSaved` with `SortName` as the
  tiebreaker (zero inversions), ascending non-decreasing, and stock for another `jpSortKey` value, another
  path, a search term and other sorts. Cost: a page of 100 over 47,621 rows is about 88 ms seeded against 56 ms
  for stock random (a string key sorts slower than a float). Not exercised: the live HTTP route end to end.

### 7.9 Folder covers: `MediaBrowser.Providers.Manager.ImageSaver.SetImagePath` and `SaveImageToLocation` (`FolderImageLinkPatches.cs`)

Two prefixes (optional "folder image links"), both on `ImageSaver`, which is non-generic and resolved by name
and exact signature.

**Why.** On the live library, 19,094 of the 20,342 `poster.jpg` files under `metadata/library` (40 GB) were
the Primary image of a `Folder` (one per recording day). Each was a byte-for-byte copy of one child's contact
sheet. Stock makes them in `FolderImageProvider`: `BaseFolderImageProvider<T>.GetItemsWithImages` picks the
first child with a Primary (recursive, `IsFolder` then `SortName` ascending, `Limit = 1`),
`BaseDynamicImageProvider<T>.CreateSingleImage` `File.Copy`s it to a temp file, and
`ProviderManager.SaveImage` streams that temp file through `ImageSaver` into the metadata directory.

**Why not `CreateSingleImage`.** Its output is only the temp file. `ImageSaver` then reads it and writes the bytes
with its own `FileStream`, so a link at the temp path would still end up as a copy. It is also declared on a
generic base, which is where `MetadataService<,>.RefreshMetadata` could not be patched (section 7.3). `ImageSaver`
is a plain class and every image Jellyfin saves goes through it.

- **Link: `SetImagePath(BaseItem, ImageType, int?, string)`, prefix.** This runs after the bytes are written and
  before the image is recorded. Only an item whose exact type is `Folder` qualifies, and only its Primary
  (index 0) at a path under the item's own internal metadata directory. The prefix runs stock's child pick
  again. It links only when that child's image resolves to an existing file outside Jellyfin's program data,
  data, cache, image cache, temp, metadata, trickplay, log, configuration, plugins, program and web directories
  (from `IServerApplicationPaths`), has the same size, and has the same bytes (full streaming compare). The
  link is created under a temp name beside the copy and renamed over it. The original then records
  `FileSystem.GetFileInfo(link)`, which follows the link, so the stored `DateModified` is the target's mtime.
  In every other case, on any exception, or when the write guard is missing, the stock copy stays.
- **Write guard: `SaveImageToLocation(Stream, string, CancellationToken)`, prefix.** `ImageSaver` opens its
  destination with `FileMode.Create`, which follows a symlink and truncates the target. Without the guard,
  regenerating a linked cover would write into the library's contact sheet, or replace it with another sheet
  if the child pick had changed. When the destination is a symlink under the internal metadata directory, the
  guard deletes the link (never its target) before stock writes. If the link cannot be deleted, the write is
  refused with an `IOException`. Destinations outside the metadata directory, and regular files, are left to
  stock. The guard is installed first. The link patch is installed only if the guard is live, checks for it
  on every call, and so does the conversion task. "Live" is read from Harmony's patch table, not from a flag.

**Regeneration.** `HasChangedByDate` compares the stored `DateModified` with `FileSystem.GetLastWriteTimeUtc(path)`.
`ManagedFileSystem` resolves both through the link to the target, so a link is exactly as stable as a copy.
It is not regenerated on every refresh. When the target is modified, the dates differ and Jellyfin regenerates
(the guard removes the link, stock writes a copy, the link patch relinks). When the target is deleted, the
dangling link reports as missing and its date differs, so Jellyfin regenerates from the next child rather than
serve a broken image. The link's own mtime is deliberately left alone. `LibraryManager.UpdateImagesAsync`
re-reads size, blurhash and date through the link.

**Serving.** `ImageController` serves an unresized original with `PhysicalFile(path, type)`. Range processing
is off, and ASP.NET resolves the link for the length and the bytes. `ImageProcessor` checks `File.Exists`,
which follows the link, and `SkiaEncoder` opens the path natively. Both read the target.

**Conversion tasks** (Scheduled Tasks, Library): "Jellyfin Plus: link folder images instead of copies" and
"... (dry run)". No default triggers. They go through every exact `Folder` whose Primary is a regular file
(not already a link) under its metadata directory. Candidates are stock's child pick first, then every file
with the same extension in the folder's own directory, in ordinal order. The first candidate that passes the
checks above (outside Jellyfin's directories, same size, same bytes) replaces the copy with a link at the same
path, so the database row stays valid. `UpdateImagesAsync` then stores the target's date, so the next refresh
does not regenerate. The tasks run two folders at a time, because the source is on FUSE. The dry run makes
every check, including the byte compare, so it reads as much as the real run and writes nothing. Both log
one line: folders scanned, linked (or "would be linked"), MiB freed, and skipped by reason (`no-image`,
`remote-image`, `not-in-metadata`, `already-linked`, `image-missing`, `no-source`, `source-missing`,
`source-in-jellyfin-dirs`, `size-differs`, `content-differs`, `error`). A re-run is a no-op (`already-linked`).
The real run refuses to start, changing nothing, if the write guard is not installed. Only one run at a time.

**Verified** against the 12.3 DLLs in a harness (synthetic images on temp directories). The harness uses the
real `FolderImageProvider`, `ImageSaver`, `ManagedFileSystem` and `SkiaEncoder` with a faked library manager:
- Both targets patch.
- A new cover is a link to the stock pick, and the stored date is the target's.
- `HasChanged` is false after a save and after a regeneration, and the source's bytes and mtime are unchanged.
- Without the guard, a plain `FileMode.Create` truncates a link's target (the negative control).
- An undeletable link refuses the write.
- A modified target regenerates and settles. A deleted target regenerates from the next child.
- The fallbacks stay copies: a `Folder` subclass, a source in the data directory, a link that cannot be
  created, and no guard.
- `PhysicalFile` serves the target's full bytes. Skia reads the size, cold-resizes to 300x200 and computes a
  blurhash through the link.
- On mixed fixtures, the conversion links identical copies (the stock pick and a sibling) and skips copies
  whose size or last byte differs. The dry run writes nothing. A re-run is a no-op.

Not exercised: a live server, the real library query (`GetItemList`/`GetItemIds` were faked), and FUSE.

## 8. Plugin HTTP routes

All under the Jellyfin API root. "Administrator" is the `RequiresElevation` policy.

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /JellyfinPlus/Status` | Administrator | Patch status (`PatchActive`, `PatchStatus`), shim sync result and recent sessions. Used by the dashboard page. |
| `GET /JellyfinPlus/Session/{playSessionId}` | Any authenticated user | What the server actually did for one play session. The id `probe` returns the capability lists with no session (used by the client probe); `dashboard` is used by the config page. A session recorded for a different user is reported as unknown. If either side has no user id (for example an API key), it answers as before the check existed. |
| `GET /JellyfinPlus/FilterCache/Status` | Administrator | Per-library, per-kind cache state: built time, key counts, dirty flag, run state, last error, and outcome counters. |
| `POST /JellyfinPlus/FilterCache/Rebuild?force=true` | Administrator | Starts a background rebuild and returns 202 with the status JSON. `force` (default true) rebuilds every library, not only stale ones. 409 when a rebuild is running or the cache is not ready. |
| `GET /JellyfinPlus/FtsIndex/Status` | Administrator | Search index state: usable now, verified, dirty, pending items, row counts, signature, built time, last refresh kind and duration, unsupported reason (no FTS5 trigram in this SQLite), outcome counters (`name:fts`, `tag:fts`, `wild-name:fts`, fallbacks). |
| `POST /JellyfinPlus/FtsIndex/Rebuild?force=true` | Administrator | Rebuilds the search index in the background; 202 with the status JSON, 409 when a run is in flight or the index is off. |
| `GET /JellyfinPlus/Search/Facets` | Any authenticated user | People, studios or tags credited on the items a search matches: `[{id, name, roles, count}]`, count descending then name. Parameters in section 9. 400 for a bad `kind` or no resolvable user; 403 if a non-administrator asks for another user's view; 404 for an unknown user or a `parentId` the user cannot see; an empty array when `searchTerm` is blank. Sets a `Server-Timing` header. |
| `GET /JellyfinPlus/Library/Census[?userId=..]` | Any authenticated user | Which item kinds the user has: `{counts: {Movie: n, Person: n, ...}}`, absent kinds omitted. Library-resident kinds are counted under the libraries the user can open; kinds stored outside libraries (people, studios, genres, artists, playlists, collections, live TV) are counted library-wide, so they can overstate for a restricted user, never understate. Cached per user (5 minutes, dropped on item add or remove). 403 for another user's view unless administrator; 404 for an unknown user. |

| `GET /JellyfinPlus/Tags[?q=..&order=count\|name&limit=100&offset=0]` | Administrator | Every stored tag spelling with its item count: `{total, offset, items: [{name, count, clean, variants}]}`. `limit` 1 to 500. Used by the config page. |
| `POST /JellyfinPlus/Tags/Edit` | Administrator | `{op: rename\|merge\|delete, from: [..], to: "..", dryRun: true, expectChanged: n}` -> `{dryRun, committed, op, matchedItems, changedItems, lockedSkipped, notLoaded}`. `dryRun` defaults to true. 400 for a bad request or more than 20,000 items; 409 when another edit is running or `expectChanged` no longer matches (nothing written). Section 6. |

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
| `jpTagLimit` | Return at most this many tags (1 to 5000) from `/Items/Filters` or `/Items/Filters2`; the match count comes back in header `X-JellyfinPlus-TagTotal` | `FilterController` postfixes (`FilterCachePatches.cs`) | `controller/tag-window.js`, `library-filters.js`, `controller/tag-autocomplete.js` (through `tag-window.js`) |
| `jpTagQuery` | Return only tags containing this text (case- and diacritic-insensitive) | Same | `controller/tag-window.js`, `controller/tag-autocomplete.js` (through `tag-window.js`) |
| `jpTagOrder` | `count`: order `/Items/Filters` tags most-used first (needs the filter cache; header `X-JellyfinPlus-TagOrder` reports `count` or `name`) | `FilterController` postfixes (`FilterCachePatches.cs`) | none yet |
| `jpTagCounts` | `1`: add header `X-JellyfinPlus-TagCounts` (counts aligned with the returned tags, at most 1000 tags, cache path only) | Same | none yet |
| `jpMinRuntime`, `jpMaxRuntime` | Whole minutes, inclusive, digits only | Same as above | `model/search-filters.js` (`filterPairs`) |
| `jpMinDateAdded`, `jpMaxDateAdded` | `YYYY-MM-DD`, UTC day, inclusive | Same | `model/search-filters.js` |
| `jpResolution` | Comma list of `sd`, `hd`, `4k` | Same | `model/search-filters.js` |
| `jpSeed` | Positive integer seeding the `Random` sort; same seed and ids give the same order | `SearchManager.GetSearchResultsAsync` (needs `sortBy=Random`) | `model/search-filters.js`; a new seed on each Apply |
| `jpListSeed` | Positive integer seeding the `Random` sort of a library listing (not a search; search uses `jpSeed`); same seed and same ids give the same order | `OrderMapper.MapOrderByField` postfix (`ListSortPatches.cs`), `/Items` only | `controller/list-requests.js` (one seed per list per page load) |
| `jpSortKey` | `DateLastSaved`: with `sortBy=DateLastContentAdded`, order by the item's own DateLastSaved ("Recently edited") | Same | `model/list-requests.js` (`rewriteListUrl`, from a `sortBy=DateLastSaved` the sort menus produce) |
| `jpPaged` | `true`: widen the candidate pool to 5000 so the total is meaningful from page 1 | `SearchManager.GetSearchResultsAsync` | `model/search-paging.js` (`rewritePagedUrl`) |
| `jpPersonMatch` | `all`: with 2+ `personIds`, every person must be credited (stock is any-of) | `SearchManager.GetSearchResultsAsync` | `model/search-filters.js` |
| `jpInf` | `1`: marks the client's own follow-up request in infinite mode | Nothing on the server (the plugin never reads it); the client uses it to skip its own rewrite and response watchers | `controller/search-pager.js` (`fetchMore`), `controller/select-all.js` (id collection; those requests also carry `enableImages=false` and `enableUserData=false`, which is how the recorder tells them from list pages) |
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
| `jellyfinPlus.searchRecent` | JSON array of up to 12 recent search terms, newest first | `model/search-recent.js` |
| `jellyfinPlus.searchPageSize` | JSON: chosen page size for Videos and all-types | `model/search-paging.js` |
| `jellyfinPlus.searchPaging` | `paged` or `infinite`; empty means the layout decides (infinite on phone) | `model/search-paging.js` |
| `jellyfinPlus.cardBadges` | `off` switches the card badges off (read at load; never written by the script) | `controller/card-data.js`, `view/card-badges.js` |
| `jellyfinPlus.mobileTheme` | `off` returns every visual change to stock and sets `html.jp-theme-off`; `light` forces the light scheme (read at load; never written by the script) | `view/mobile-theme.js` |
| `jellyfinPlus.imagePreload` | `off` switches the image look-ahead off (read at load; never written by the script) | `controller/image-preload.js` |
| `jellyfinPlus.libFilterNames` | JSON map of studio and person ids to names, up to 400, for the library filter chips | `controller/library-filters.js` |
| `jellyfinPlusPlaybackRate` | The saved playback speed, a number from 0.25 to 4; absent means 1x | `controller/player-speed.js` |
| `jellyfinPlusBrightness` | The swipe brightness, 0.3 to 1.5; absent means 1 (no filter) | `controller/player-actions.js` |
| `jellyfinPlus.listSortChosen` | JSON map of list sort settings keys (for example `items-tag`) on which the viewer picked a sort through the sort menu; a tag list opens newest first until its key is here | `model/list-sort.js` (written from `controller/list-sort.js`) |
| `jellyfinPlusClientUpscale` | JSON `{mode: off\|auto\|always, cleanup: off\|low\|high, sharpness: "0"\|"0.25"\|"0.5"\|"1"}`; absent means Auto, Low, 0.25. Per device on purpose (a GPU capability), never sent to the server | `model/client-upscale.js`, `controller/client-upscale.js` |

Browser `sessionStorage` (per tab, gone when the tab closes; also in try/catch):

| Key | Holds | Module |
|---|---|---|
| `jellyfinPlus.detailNav` | JSON `{v:1, src, ids}`: the route of the list a card was last opened from and the ids of up to 1000 consecutive cards (32 hex characters each, about 35 KB at most), for the details page's previous / next buttons | `controller/detail-nav.js`, `model/detail-nav.js` |
| `jellyfinPlus.syncMeta` | JSON `{userId: {localKey: ms}}`: when this device last changed each synced key, per user | `controller/prefs-sync.js` |

Synced keys: `jellyfinPlusPrefs` (without `pos`), `jellyfinPlus.searchPageSize` and `jellyfinPlus.searchPaging`
are mirrored to the server (section 11); `controller/prefs-sync.js` watches writes to them through a wrapper
on `Storage.prototype.setItem` / `removeItem` (the original always runs first).
jellyfin-web's own `userSettings` also keeps a copy of each synced value under `<userId>-<name>` in
localStorage, because the sync writes through `userSettings.set`.

Keys that belong to jellyfin-web but are read or written by Jellyfin Plus:
`<viewType> - <parentId>` (the library tab's own settings object; the extra marker entries ride in its
`Filters.Tags`, so the stock reset button clears them) and `<userId>-enableNextVideoInfoOverlay` (read
only, by Clip Up Next).

## 11. Data the plugin stores on the server

| What | Where | Rebuild or clear |
|---|---|---|
| Filter key cache | Two tables in Jellyfin's `jellyfin.db`: `JellyfinPlus_FilterKeys(LibraryId, Kind, ItemType, CleanValue, Value, ItemCount, RefId)` and `JellyfinPlus_FilterKeysMeta(LibraryId, Kind, BuiltAtUtc, SourceItemCount, KeyCount, Fingerprint)`. Created with `CREATE TABLE IF NOT EXISTS` by raw SQL; Jellyfin's own schema and migrations are never touched. One row per distinct key per library per item type. Kinds: tags, genres, years, ratings, genre entities. | Rebuild: `POST /JellyfinPlus/FilterCache/Rebuild` or the scheduled task. A forced rebuild deletes and rewrites each library's rows in one transaction, so readers see old or new rows, never a mix. Rows of libraries that no longer exist are removed on each rebuild. Nothing in the plugin drops the tables, including on uninstall. To remove them, stop Jellyfin, back up `jellyfin.db`, and drop both tables by hand (not exercised here; the engine recreates them on its next run). |
| Search index | Three objects in `jellyfin.db`: virtual tables `JellyfinPlus_FtsNames`, `JellyfinPlus_FtsTags` (FTS5, trigram) and `JellyfinPlus_FtsMeta(Key, Value)`, holding the signature the index was built at. Created with `IF NOT EXISTS`; Jellyfin's schema is untouched. About 45 MB on an 80k-item library. | Rebuild: `POST /JellyfinPlus/FtsIndex/Rebuild` or the scheduled task. Safe to drop by hand with Jellyfin stopped (search falls back to the stock queries; the engine recreates and rebuilds it). The plugin drops nothing on uninstall; the only drop is the one-time rebuild of a `JellyfinPlus_FtsNames` that predates its `SortName` column (7.6). |
| Synced preferences | The viewer's own `DisplayPreferences` (display preferences id `usersettings`, client `emby`), as three `CustomPrefs` entries: `jellyfinPlus.prefs`, `jellyfinPlus.searchPageSize`, `jellyfinPlus.searchPaging`, each `{"t": ms, "v": value}`. Written through jellyfin-web's `userSettings.set`, so Jellyfin stores them in its `CustomItemDisplayPreferences` table (key length limit 64; ours are 27 or fewer). | Delete the entries by saving display preferences without them, or ignore them: nothing on the server reads them. Removing the plugin leaves them as inert strings. |
| Plugin settings | XML at `plugins/configurations/Jellyfin.Plugin.Plus.xml` under Jellyfin's data directory (`/var/lib/jellyfin/plugins/configurations/` in the install scripts). On first start the constructor copies `Jellyfin.Plugin.GpuUpscale.xml` over if the new file is absent. | Edit on the dashboard page; changes are pushed to the patches live. Delete the file with Jellyfin stopped to return to the defaults in section 1. |
| Shader cache | `ShaderCacheDirectory`, default `/var/cache/jellyfin/jellyfin-plus-shaders`: composed shader files named `<level>+<level>.glsl`, and a `plcache/` subdirectory where libplacebo keeps its compiled-shader scratch files. A composed file is rewritten if any input shader is newer. | Safe to delete the contents; composed files are rebuilt on demand and libplacebo recompiles, so the first sessions afterwards start slower (inferred from the code, not timed). |
| Shaders and models (inputs) | `ShaderDirectory` `/usr/share/jellyfin-shaders`; neural models, DLSS runtime, depth model, DLPP and VSR DLL paths under `/usr/lib/jellyfin-ffmpeg-oidn/` (all configurable). Not shipped with the plugin. | `scripts/install-shaders.sh`; see INSTALL.md |
| Patch assembly | `/usr/lib/jellyfin-plus/`: `Jellyfin.Plugin.Plus.Patcher.dll`, `0Harmony.dll`, the client bundle source `jellyfin-plus.js`, and `staged/`, `previous/`, `legacy/` used by the activate and migrate scripts. It lives outside `plugins/` because Harmony cannot patch from the collectible context Jellyfin loads plugins into. | `scripts/jellyfin-plus-activate` (with `--rollback`), `scripts/proxmox-build.sh` |
| Plugin assembly | `/var/lib/jellyfin/plugins/JellyfinPlus_<version>/` | Same scripts |
| Served client script | `/usr/share/jellyfin/web/jellyfin-plus.js`, plus a `<script defer src="jellyfin-plus.js?v=<10 hex of sha256>">` tag inserted first in `index.html`. Backups: `index.html.jellyfin-plus-orig` (pristine, taken once) and `index.html.jellyfin-plus-bak`. | `scripts/jellyfin-plus-webinject` (installed at `/usr/local/sbin/`). The apt hook `/etc/apt/apt.conf.d/99-jellyfin-plus` reruns it after package operations, because a jellyfin-web upgrade replaces `index.html`. The cache-buster is derived from the file's content. Build the bundle first with `scripts/build-web-panel.sh`. |
| Shim sync file | `/etc/jellyfin-upscale.json`, only if it already exists | Rewritten on each settings change |
| Folder cover links | Jellyfin's own `metadata/library/<xx>/<id>/poster.jpg` (Folder items only), now a symlink to a child image beside the media instead of a copy. Same path, so the database row is unchanged | Self-healing: Jellyfin regenerates a cover whose target changes or disappears. To turn every link back into a copy (needs the disk back, about 2 MB per folder), stop Jellyfin and run `find /var/lib/jellyfin/metadata/library -type l -name 'poster.*' -exec sh -c 'cp --remove-destination "$(readlink -f "$1")" "$1"' _ {} \;` as the jellyfin user. Not exercised |

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

- **List pages.** Random keeps one shuffle per list for the life of the page only (a reload, or the
  Shuffle button, reshuffles); it is not remembered across visits. The seeded order costs about 30 ms more
  per page than stock random on a 47k-item list. "Recently edited" in the modern popover is a cloned
  stock menu row and had not been driven in a live browser when this was written. The tag
  list default treats a saved "Name, ascending" as unset, so someone who deliberately chose that before
  this plugin existed gets newest first until they pick a sort again. There is no Alpha picker on tag
  lists, and no skipping of the total count (section 3 gives the measurement).

Item pages and playback:
- More Like This covers only items of exact type `Video`, at most 50 results, and returns nothing
  without a user. Chips carry no counts (by design: it would be one query per chip).
- The person and studio "Videos" section borrows the Audio Books slot (section 4).
- **Play all.** The rewrite covers the two requests built by jellyfin-web's playback manager (the 300
  cap, and the Home Videos photo-only queue). The new cap is 1000, not unlimited. The modern Videos
  tab's own Play all and Shuffle buttons special-case that tab in jellyfin-web (per `docs/roadmap/QOL_IDEAS.md`,
  item 38, an unverified note from a delegated reader); whether they route through the rewritten
  request was not checked here, so Play all on the Videos tab should be treated as unverified.
- Clip Up Next only announces; it does not advance playback. Double-tap seek is touch only, 10 s.
- **Video page gestures were exercised only against a scripted fake DOM and the pure arbiter's unit
  tests, not in a real browser.** Things only a device can confirm: that a vertical swipe is not
  cancelled by the browser (`touch-action: pan-x pinch-zoom` is the mechanism), that the replayed
  pointerdown makes stock toggle the OSD / play-pause exactly as a native press does, and that a long
  press raises no context menu. Brightness is a CSS filter on the video element only (subtitles and
  the OSD are not dimmed), and a filter can cost hardware video overlay on some browsers while it is
  not 1. The badge sits on `<body>`, so it does not move with the header's slide animation.
- Bulk tag editing handles only the item types in section 6 and only administrators. It edits the ticked
  cards, or, after "Select all N results" (section 5), every result of the list up to 5000.
- **Client-side upscaling** was measured in desktop Chrome (headless, real GPU and SwiftShader) on
  synthetic clips only, not yet on a phone or in Safari. Native (`::cue`) subtitles switch it off
  while they show, because they render inside the `<video>` the canvas covers; custom-element, ASS
  (libass) and PGS/VobSub subtitles stay above it. Picture-in-Picture and iOS native fullscreen show
  the stock video. An UNTAGGED source can show a colour difference against stock (Chrome's WebGL
  upload and its compositor assume different matrices for untagged video); BT.709-tagged streams,
  which is what a transcode carries, matched exactly in the test. The governor cannot tell a slow GPU
  from a busy main thread: both read as "GPU too slow". Once it reaches off it stays off until the next
  item (or reload).
- Card badges show the first two stored tags (a clip has 44 on average on the real library) and need a
  looked-up record, so a card shows nothing until it has been near the screen for about 150 ms.

Folder covers (section 7.9):
- A linked cover depends on the pool mount. While `/mnt/drivePool` is unmounted, links dangle: covers fail to
  load, and a refresh in that window regenerates nothing (no child image exists) or drops the image. After
  the pool remounts, the next refresh regenerates the covers as links. Nothing is lost, but a cover can be
  missing until then.
- The write guard is what stops Jellyfin writing through a link. If the patcher stops loading (for example a
  Jellyfin upgrade that breaks the core patches), stock Jellyfin regenerating a linked cover would write
  through the link: the same bytes when the pick is unchanged, but **another sheet's bytes** when the pick
  has changed, and it would recreate a deleted target. Stock only regenerates when the target's date changes
  or on "Replace all images". Before running Jellyfin without the patcher, convert the links back to copies
  (section 11).
- Only exact `Folder` items are linked. Box sets, albums, playlists, collection folders and videos keep stock
  behaviour. Covers that "save artwork into media folders" writes beside the media are never linked.
- `FileInfo.Length` on a link is the link's own size. Jellyfin's image route is unaffected (range processing
  is off), but a range-enabled `PhysicalFile` through a link fails in ASP.NET's `SendFileFallback`. Nothing
  in Jellyfin's image path does that today.
- Each new folder cover costs one more read of the child image, for the byte compare. The conversion (and its
  dry run) reads every candidate and every copy in full.

Enhancement (from README.md, "Limitations and risks", and the code):
- The patches match Jellyfin methods by name and can break on any Jellyfin upgrade; targets are pinned
  to 12.3 (ported from 12.1; each upgrade needs the seams re-checked). A jellyfin-web package upgrade deletes the injected script until the injector reruns.
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

**Touch OSD, portrait player, rotate, lock, favourite** (`web/src/view/portrait-osd.js`,
`controller/player-rotate.js`, `controller/player-favorite.js`, `controller/player-item.js`; P4, P12).
Chip moves bottom-left above the OSD controls and (landscape) shows only with the OSD; OSD buttons 44px
on a coarse pointer; portrait pulls the controls under the picture (`html.jp-portrait-osd`); the gesture
arbiter has a 24px edge dead zone (`THRESHOLDS.EDGE_DEAD_PX`, touch only, judged on screen coordinates);
a lock (`html.jp-player-locked`) turns the gestures and stock tap-to-toggle off; a rotate button
(phone/tablet) tries `screen.orientation.lock`, else rotates `<body>` by CSS (`html[data-jp-rot]`, pointer
coordinates mapped by `toContent`); a heart toggles `UserData.IsFavorite` via `ApiClient.updateFavoriteStatus`.
No storage keys: rotation and lock are per play session and reset on item change / leaving the page.
Off switch: `jp-theme-off` (rotate and lock excluded too). TV untouched.
