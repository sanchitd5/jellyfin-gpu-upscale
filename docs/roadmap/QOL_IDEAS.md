# QOL ideas — Jellyfin 12.1 patch candidates

Ranked ease-of-life improvements patchable with this repo's two mechanisms: Harmony prefix/postfix
on the server (`src/patcher/`, fail-soft, `AccessTools` by name) and the injected client script
(`web/src/`, DOM-by-shape + MutationObserver, CSS, fetch/XHR hooks, webpack exports by shape).

Checkouts read: server tag v12.1 (`scratchpad/jf`), web tag v12.1 (`scratchpad/jfweb`). Paths below
are relative to those two roots. **[V]** = seam opened and read in the source. **[I]** = inferred
from neighbouring code, not run. **[RS]** = needs a running server to confirm.

Rule honoured throughout: nothing here reads or rewrites media files.

## Top 10 by value ÷ effort

| # | Idea | Where | Value | Effort | Risk |
|---|---|---|---|---|---|
| 1 | Search inside a Home Videos library returns **no videos, people or studios** (#36) | client | high | S | low |
| 2 | Tag **exclude** in the library filter (and `?excludeTags=` on list pages) (#1) | client + S server | high | S | low |
| 3 | Searchable tag list in both filter UIs (thousands of checkboxes today) (#2) | client | high | S | low |
| 4 | Studio / resolution / people filters unlocked for the Videos tab (#37) | client | high | S | low |
| 5 | Mobile card overlay: favourite / ⋮ / play without a long-press (#9) | client | high | S | low |
| 6 | AND-mode tag filter (`tags=a\|b` is OR on the server) (#3) | both | high | M | low |
| 7 | "More Like This" + person chips for Type=`Video` clips (#25, #30) | both | high | M | low |
| 8 | Play-all/shuffle: 300 cap, Photo-only queue on Home Videos folders, no Tag case (#18, #38) | client | med-high | S | low |
| 9 | Bulk tag add/remove from multi-select (#27) | client | high | M | med |
| 10 | Up Next overlay + double-tap seek for clips (#19, #20) | client | med | S | low |

Honourable mentions: #11 seeded Random sort (server, M), #21 persistent playback speed, #24 Download
button on video details, #26 tag autocomplete in the metadata editor, #39 search box 40-char cap.

**Which UI is live matters:** in 12.1 a Home Videos library's tab views are the *modern* React
pages (`apps/modern/features/libraries/`), while tag / person / studio drill-downs and the search page
are the *legacy* controllers (`apps/legacy/controllers/list.js`, `features/search/`). Ideas below say
which one they patch; several need both.

---

## Search & filtering

### 1. Tag exclude in the library filter dialog
- **Problem:** I can filter a library view *to* a tag but never *away* from one; exclude only exists on the search page we patched.
- **Seam:** [V] `jfweb/src/components/filterdialog/filterdialog.js:53-56` renders `.tagFilters` checkboxes (`chkTagFilter`, `|`-joined into `query.Tags`); [V] `apps/legacy/controllers/list.js:76-98` `modifyQueryWithFilters` builds the `/Items` query; [V] server `Jellyfin.Api/Controllers/ItemsController.cs:224` takes `tags` (pipe-delimited) but has **no** `excludeTags` parameter (grep: none); [V] `Jellyfin.Server.Implementations/Item/BaseItemRepository.TranslateQuery.cs:204` already reads `filter.ExcludeTags`.
- **Client / server:** client-only if routed through the existing `SearchPatches` `excludeTags` seam is not possible (that patch is on `SqlSearchProvider.SearchAsync`, search only). For `/Items` either (a) **server** prefix on `ItemsController.GetItems` reading `excludeTags` from `HttpContext.Request.Query` into `InternalItemsQuery.ExcludeTags` (S, mirrors `SearchPatches.cs`), or (b) **client-only** post-filter of the page result (lossy with paging — avoid).
- **Patch shape:** add an "Exclude" collapse beside `.tagFilters` in the dialog (same checkbox list, second class), join into an `ExcludeTags` query key, fetch hook adds `excludeTags=` to `/Items` requests; server prefix maps it onto `ExcludeTags`. Reuses the same access filtering because it rides the stock query.
- **Value / effort / risk:** high / S (client) + S (server) / low. Fragility: the dialog's class names (`tagFilters`, `chkTagFilter`) have been stable since the Emby days.

### 2. Searchable tag list in the filter dialog
- **Problem:** With thousands of tags the Tags section is an unbounded checkbox wall that takes seconds to render and cannot be searched.
- **Seam (modern Videos tab — the one the library opens):** [V] `apps/modern/features/libraries/components/filter/FiltersTags.tsx:42` one MUI `Checkbox` per tag, no search box; [V by subagent] `filter/FilterButton.tsx:398-425` Tags accordion inside a Popover `maxHeight: '50%', width: 250` (`:211-215`), gated by `isFiltersLegacyEnabled` (`:132`, includes Videos/Folders/Mixed) and fed by `GET /Items/Filters` (`hooks/useFetchItems.ts:121`). **Legacy dialog (tag/person drill-downs):** [V] `components/filterdialog/filterdialog.js:63-71` `loadDynamicFilters` → `Items/Filters`, template `:98` `.tagFilters`. **Server:** [V] `Jellyfin.Api/Controllers/FilterController.cs:240` `filters.Tags = _libraryManager.GetTagNames(tagQuery)` → `BaseItemRepository.ByName.cs:121` — all names, no count, no limit.
- **Client / server:** client.
- **Patch shape:** MutationObserver on `#filtersTags-content` (modern) and `.filterDialogContent` (legacy); insert an `<input>` that hides non-matching `label`s, plus a "selected only" toggle. Optional lazy-render of the first 200 + matches. Widen the MUI Popover on `html.layout-mobile` by CSS.
- **Value / effort / risk:** high / S / low.

### 3. AND-mode tag filter
- **Problem:** Picking two tags shows clips with *either* tag; I want clips with *both*.
- **Seam:** [V] `BaseItemRepository.TranslateQuery.cs:203` `var tags = filter.Tags.ToList()`; the matching block applies `ItemValueType.Tags` with `Any` over clean values (OR). [I] Exact predicate line not pinned (file is 700+ lines; the Tags branch sits after the `IsMovie/IsSeries/IsSports` block at 206-230).
- **Client / server:** both.
- **Patch shape:** server postfix/prefix on `ItemsController.GetItems` reading `tagsMatchAll=true` from the raw query string and, when set, replacing `Tags` with one `ExcludeTags`-style loop: run `GetItems` once per tag? No — cheaper: prefix the query translation (`BaseItemRepository.TranslateQuery` is `private`, patch via `AccessTools.Method`) and add a `Where(e => e.ItemValues.Any(tag1)) .Where(... tag2)` chain. Client: a mode toggle in the dialog, fetch hook adds the flag.
- **Value / effort / risk:** high / M / low-med — touches the private translator; must keep `ApplyUserAccessFilter` untouched (it runs on the same query, so it is). Fragile across server minor versions; guard with try/catch like `ApplyOptional`.

### 4. Search scope: people / studios / tags toggles
- **Problem:** The search page always runs People + Studios + every media type; on a clip library I mostly want "videos matching this tag" or "people only".
- **Seam:** [V] `jfweb/src/apps/legacy/features/search/api/useSearchItems.ts:70-80` one `fetchItemsByType` call with `limit: 800`, then bucketed by `itemType` client-side; [V] server `Jellyfin.Api/Controllers/SearchController.cs:97-100,110-112` `includePeople/includeMedia/includeStudios` already exist on `/Search/Hints` but the web client does not use them for the main grid.
- **Client / server:** client.
- **Patch shape:** chips next to the search input (same injection point as `search-exclude.js`), persisted in localStorage; fetch hook adds `includeItemTypes=Video` / drops People+Studio queries when off; alternatively hide the row sections by title via the `SearchResultsRow` DOM.
- **Value / effort / risk:** med / S / low.

### 5. Search suggestions are useless for a clip library
- **Problem:** The empty search page suggests Movies/Series/MusicArtists only — none exist here.
- **Seam:** [V] `useSearchSuggestions.ts:19-26` `includeItemTypes: [Movie, Series, MusicArtist]`, `sortBy: [IsFavoriteOrLiked, Random]`, `limit: 20`.
- **Client / server:** client.
- **Patch shape:** fetch hook rewriting that request's `includeItemTypes` to `Video` (match on `sortBy=IsFavoriteOrLiked,Random&limit=20`), or replace the `SearchSuggestions` block with recent searches / top tags.
- **Value / effort / risk:** med / S / low — the hook matches a query signature, not a module.

### 6. Recent searches / search history
- **Problem:** No memory of what I searched last; typing the same tag names again on mobile.
- **Seam:** [V] `apps/legacy/routes/search.tsx:22` `useDebounceValue(query, 500)`; no `localStorage` use anywhere in `features/search` (grep: none).
- **Client / server:** client.
- **Patch shape:** observe the search input, push committed queries into localStorage, render a chip row under the input when empty.
- **Value / effort / risk:** med / S / low.

### 7. Raise the search-hit cap / show "showing N of M"
- **Problem:** Hits silently cap at 100 (provider) or 800 (grid); a broad tag term with 2,000 hits shows a subset with no hint.
- **Seam:** [V] `Emby.Server.Implementations/Library/Search/SqlSearchProvider.cs:26` `DefaultSearchLimit = 100`, `:101` `query.Limit ?? DefaultSearchLimit`; [V] `useSearchItems.ts:78` `limit: 800`.
- **Client / server:** client (fetch hook raising `limit`) or server postfix on `SearchAsync`.
- **Patch shape:** fetch hook rewrites `limit=800` → paged fetches, and the grid patch (`search-grid.js`) appends; or simpler: show a count banner from `TotalRecordCount`.
- **Value / effort / risk:** med / S-M / med — a larger grid costs render time on mobile; pair with #2's lazy render.

### 8. Substring vs. prefix search is a server choice
- **Problem:** `/Items?searchTerm=` only matches `CleanName`/`OriginalTitle` substrings; no "starts with" and no multi-word AND.
- **Seam:** [V] `BaseItemRepository.TranslateQuery.cs:260-273` — `SearchWildcardTerms` path uses `EF.Functions.Like`, otherwise `CleanName.Contains(cleanedSearchTerm)`.
- **Client / server:** server.
- **Patch shape:** already partly covered by `SearchPatches.cs`; extending to split on spaces and AND the terms is a postfix on `SqlSearchProvider.SearchAsync` scoring.
- **Value / effort / risk:** low-med / M / low. Lower priority: the existing patch handles the tag side.

## Browsing & mobile UI

### 9. Mobile card overlay: favourite / ⋮ / play
- **Problem:** On the phone a card has only the small play button; favourite and the context menu need a 550 ms long-press (which iOS Safari turns into multiselect).
- **Seam:** [V] `jfweb/src/components/cardbuilder/cardBuilder.js:984` `if (layoutManager.desktop && !options.disableHoverMenu) additionalCardContent += getHoverMenuHtml(item, action)`; [V by subagent] `:828-847` mobile adds only the play button; [V] `components/multiSelect/multiSelect.js:473/520` long-press 550 ms, `:556-560` Safari has no `contextmenu`.
- **Client / server:** client.
- **Patch shape:** MutationObserver on `.card` under `html.layout-mobile`; inject `.cardOverlayButton` buttons with `data-action="menu"` / `"favorite"` so the stock `shortcuts.js` click handler (`:404` resolves `.itemAction[data-action]`) executes them. CSS makes them always visible.
- **Value / effort / risk:** high / S / low — relies on `data-action` dispatch, which has been stable.

### 10. Sort menu gaps: Random on legacy tag/person lists; DateLastSaved / Path nowhere
- **Problem:** The modern Videos tab already offers Random, DateAdded, DatePlayed etc. ([V] `apps/modern/features/libraries/components/SortButton.tsx:54-64`), but tag/person drill-down lists (legacy) have no Random, and neither UI offers "recently edited" (`DateLastSaved`) — useful right after a tagging session.
- **Seam:** [V] `apps/legacy/controllers/list.js:1010-1110` `getSortMenuOptions` (DateAdded 1041, Runtime 1075, PlayCount 1101, CommunityRating 1128); [V] `:288` `Tags: params.tag`; [V] `:1007` default `IsFolder,SortName`; [V by subagent] modern `SortButton.tsx:66` module-level `sortOptionsMapping`, `:194-196` click-again toggles order.
- **Client / server:** client.
- **Patch shape:** legacy — wrap `getSortMenuOptions` on the list controller (module by shape: exports `getSortValues`/`getSortMenuOptions`) and push `{name:'Random', value:'Random'}`, `{name:'Recently edited', value:'DateLastSaved,SortName'}`; modern — push into `sortOptionsMapping` (grab by shape) before first render, or rewrite `sortBy` in the fetch hook.
- **Value / effort / risk:** med / S / low-med (modern mapping is a const captured at module load; patch must run before the first library render).

### 11. Random sort that pages without repeats
- **Problem:** "Random" + paging re-rolls each page, so page 2 repeats items from page 1 and misses others.
- **Seam:** [V] `Jellyfin.Server.Implementations/Item/OrderMapper.cs:55` `(ItemSortBy.Random, _) => e => EF.Functions.Random()`; [V] `BaseItemRepository.Querying.cs:82-96` only re-orders the fetched page.
- **Client / server:** server.
- **Patch shape:** prefix on `OrderMapper.MapOrderByField` (or wherever Random is built) substituting a deterministic hash of `(Id, seed)` where `seed` comes from a request query `randomSeed` (client sends one per browsing session via the fetch hook). Keeps user-access filtering (ordering only).
- **Value / effort / risk:** med / M / med — EF expression translation to SQLite; needs [RS] confirmation that the expression compiles (`substr(hex(Id))`-style). Prior art: upstream issue requests exist; no shipped PR known.

### 12. Page size above 100 and "load more" instead of pager on mobile
- **Problem:** 100 cards per page then a tiny pager; endless scrolling would suit a clip grid.
- **Seam:** [V] `scripts/settings/userSettings.js:517-529` `libraryPageSize` default 100, user-settable (0 = unlimited); [V] `list.js:278-289` `StartIndex/Limit` query.
- **Client / server:** client.
- **Patch shape:** IntersectionObserver on the pager; when visible, trigger the "next page" button and append results instead of replacing — or the simpler path: set `libraryPageSize` to 200 via the existing settings UI and only patch the pager position (sticky). Mark: the unbounded option already exists; this is UX, not capability.
- **Value / effort / risk:** med / M / med (DOM replacement races with the view's own render).

### 13. Person / Studio page shows nothing for Type=Video clips
- **Problem:** Opening a person or studio gives empty sections; my items are `Video`, and the page only has sections for Program/Movie/MusicVideo/Trailer/Series/MusicAlbum/Audiobook/Book/MusicArtist/Episode.
- **Seam:** [V] `jfweb/src/scripts/itemsByName.js:110-285` `renderSection` switch — `IncludeItemTypes` values listed above, each `Limit: 10` (MusicArtist 8, Episode 6), with a "More" link (`:96`). No `Video` case. [I] Whether 12.1 routes Person to this script or to `itemDetails/index.js` for every entry needs a [RS] check — either way, no `Video` section exists in either file (subagent grep).
- **Client / server:** client.
- **Patch shape:** on a Person/Studio details view, inject one `verticalSection` fetching `/Items?PersonIds=|StudioIds=&IncludeItemTypes=Video&Recursive=true&SortBy=DateCreated&SortOrder=Descending&Limit=…` and render with `cardBuilder` (grab by shape: export with `buildCards`/`getCardsHtml`).
- **Value / effort / risk:** high / M / low-med.

### 14. Tag chips with counts on the details page
- **Problem:** Tags render as one comma-joined line of links with no cap and no counts; on a clip with 30 tags it is unreadable on mobile.
- **Seam:** [V by subagent] `apps/legacy/controllers/itemDetails/index.js:1311-1337` `renderTags` → `appRouter.getRouteUrl('tag', …)`, `TagsValue` join; `index.html:124` `.itemTags` inline styles.
- **Client / server:** client.
- **Patch shape:** CSS: `.itemTags a.button-link` as chips (wrap, padding, `!important` for the inline margin). Optional counts from `Items/Filters2`? No — counts aren't exposed; skip counts.
- **Value / effort / risk:** med / S / low.

### 15. Tag link opens a pre-sorted list
- **Problem:** Tapping a tag opens the generic list in SortName order; I want newest first.
- **Seam:** [V by subagent] `components/router/appRouter.js:396-397` `#/list?type=tag&tag=…`; [V] `list.js:288` applies `Tags: params.tag`.
- **Client / server:** client.
- **Patch shape:** intercept clicks on `.itemTags a` (or hook `getRouteUrl` by shape) and append `&sortBy=DateCreated&sortOrder=Descending`, which `getSortValues` reads from saved settings — [I] whether the list honours URL sort params or only saved settings; if only saved, pre-write the `userSettings` sort key for `tag` views.
- **Value / effort / risk:** med / S / low.

### 16. Alpha picker + filter button on tag lists
- **Problem:** Tag result pages hide filters a normal library view has.
- **Seam:** [V] `list.js:349` `['Recordings','Programs','nextup','tag'].includes(params.type)` takes a reduced path; `:1134-1160` `getVisibleFilters` pushes IsUnplayed/IsPlayed/IsFavorite/IsResumable/VideoType/… except for `nextup`. [I] Which of these apply to `type=tag` needs reading `:349-370`.
- **Client / server:** client.
- **Patch shape:** force `.btnFilter` visible and feed the filter dialog the same query (it reads `instance.getFilters()`); S if the controller instance is reachable by shape, M otherwise.
- **Value / effort / risk:** med / S-M / med.

### 17. Bigger tap targets + hide hover-only affordances on mobile
- **Problem:** Several controls assume a mouse (card hover menu, `.btnCardOptions` only with `cardLayout`).
- **Seam:** [V by subagent] `cardBuilder.js:380-381` `.btnCardOptions` only when `cardLayout && layoutManager.mobile && cardFooterAside !== 'none'`; `layoutManager.js:8-14` sets `html.layout-mobile`.
- **Client / server:** client.
- **Patch shape:** CSS under `html.layout-mobile` (same mechanism as the 2-column grid patch).
- **Value / effort / risk:** low-med / S / low.

## Playback & navigation

### 18. Play-all / shuffle cap of 300 and no Tag case
- **Problem:** "Play all" from a tag or studio stops after 300 clips and sorts by name; shuffle from a tag page is name-sorted then shuffled client-side.
- **Seam:** [V by subagent] `components/playback/playbackmanager.js:150` `query.Limit = query.Limit || 300`; `:1904-1917` `translateItemsForPlayback` has Studio/Person cases (`MediaTypes: Video`, `SortBy = shuffle ? Random : SortName`) but no Tag case → `getNonItemTypePromise` (`:1928`).
- **Client / server:** client.
- **Patch shape:** fetch hook on `/Items` requests carrying `Fields=…Chapters,MediaSources…` (the playback-query signature) to raise `Limit`; for tag pages inject a Play/Shuffle button that calls `playbackManager.play({items})` with a `Tags=` query built the same way.
- **Value / effort / risk:** med / S / low.

### 19. Up Next overlay and auto-advance for clips
- **Problem:** The "next video in N s" overlay only shows for Episodes ≥ 10 min, so queues of clips just stop or jump without warning.
- **Seam:** [V by subagent] `apps/legacy/controllers/playback/video/index.js:660-672` `showComingUpNextIfNeeded` gated on `Type === 'Episode' && enableNextVideoInfoOverlay()` and `runtimeTicks >= 10*TICKS_PER_MINUTE`; `playbackmanager.js:3545-3600` auto-advance for Video depends on `EnableNextEpisodeAutoPlay`.
- **Client / server:** client.
- **Patch shape:** on `playbackstart`, if the item is `Video`, schedule our own call into `components/upnextdialog/upnextdialog` (import grabbed by shape: export with `show`/`hide`) a few seconds before the end; or patch the predicate by wrapping the OSD module's export.
- **Value / effort / risk:** med / S-M / low.

### 20. Double-tap to seek ±10 s on mobile
- **Problem:** No gesture seeks; only OSD buttons.
- **Seam:** [V by subagent] `video/index.js:1795-1835` pointerdown: touch → `toggleOsd()` (300 ms debounce), mouse → `playPause`; `:1837` dblclick → fullscreen only; `:1780-1782` `touchHelper` destroyed but never created.
- **Client / server:** client.
- **Patch shape:** capture-phase `pointerdown` on `.videoPlayerContainer`, detect double-tap by time+position, call `inputManager.handleCommand('fastforward'|'rewind')` (`scripts/inputManager.js:55`, exported) — uses the user's own skip lengths (`userSettings.js:405/418`).
- **Value / effort / risk:** med / S / low.

### 21. Persistent playback speed
- **Problem:** Speed resets every browser session.
- **Seam:** [V by subagent] `playbackmanager.js:4121-4126` `sessionStorage.setItem('playbackRateSpeed', …)`, re-applied `video/index.js:1611-1615`.
- **Client / server:** client.
- **Patch shape:** mirror to localStorage on `playbackstart`/rate change; seed sessionStorage before the player reads it.
- **Value / effort / risk:** low-med / S / low.

### 22. Resume for short clips — **config, not a patch**
- **Problem:** Clips under 5 min never resume; mid-clip stop is marked Played.
- **Seam:** [V] `Emby.Server.Implementations/Library/UserDataManager.cs:453-471` `MinResumePct` (5) / `MaxResumePct` (90) / `MinResumeDurationSeconds` (300, `MediaBrowser.Model/Configuration/ServerConfiguration.cs:145`); [V] exposed in Dashboard → Playback → Resume (`jfweb/src/apps/dashboard/routes/playback/resume.tsx:25-31`).
- **Patch shape:** none — set `MinResumeDuration` to e.g. 30 s in the dashboard. Listed so nobody patches it.
- **Value / effort / risk:** high / 0 / none.

### 23. Previous / next clip buttons on the details page
- **Problem:** Walking through a tag's clips means back-to-list every time.
- **Seam:** [V by subagent] `itemDetails/index.js` has only `renderNextUp` (`:786`, Series); `.mainDetailButtons` at `index.html:18`; `bindAll` lifecycle hooks `:2105-2155`.
- **Client / server:** client.
- **Patch shape:** remember the last list query + the item's index (from the list page's card order, captured on card click via `shortcuts.js` `.itemAction`); inject prev/next buttons into `.mainDetailButtons` that `appRouter.showItem`.
- **Value / effort / risk:** med / M / med — depends on capturing list state before navigation.

### 24. Download button for videos
- **Problem:** Download is in the ⋮ menu only; Books get a visible button.
- **Seam:** [V by subagent] `itemDetails/index.js:670` `if (item.Type === 'Book' && item.CanDownload && …) hideAll(page,'btnDownload',true)`; `:2112` `onDownloadClick` already bound.
- **Client / server:** client.
- **Patch shape:** on `viewshow`, unhide `.btnDownload` when `CanDownload` (DTO already carries it — server `LibraryController.cs:688` gates on `EnableContentDownloading`).
- **Value / effort / risk:** low-med / S / low.

### 25. "More Like This" for `Video` items
- **Problem:** Similar row never appears for clips.
- **Seam:** [V by subagent] `itemDetails/index.js:1233-1246` type allow-list without `Video`, `limit: 12`; server `Jellyfin.Api/Controllers/LibraryController.cs:801-830` `GetSimilarItems` returns empty unless a provider `Supports` the type; `Emby.Server.Implementations/Library/SimilarItemsProvider.cs` (local provider) scores shared Genres/Tags/Studios/People (`:29-33`, `:258-281` per subagent).
- **Client / server:** both — client unhides `#similarCollapsible` and fetches; server postfix on `SimilarItemsProvider.Supports` (or the local provider's type check) to accept `Video`.
- **Patch shape:** Harmony postfix `Supports(BaseItem) → result || item is Video`; client renders the row with `cardBuilder` by shape.
- **Value / effort / risk:** high / M / low (read-only query, user filter applies via `GetItemList`). [RS] confirm the local provider's method name on the running build.

## Metadata & tags

### 26. Tag autocomplete in the metadata editor
- **Problem:** Adding a tag is a bare prompt; typos create near-duplicate tags.
- **Seam:** [V by subagent] `components/metadataEditor/metadataEditor.js:216-224` `addElementToList` → `prompt({label:'Value:'})`; `:940-975` `populateListView`; template `:237-244` `#tagsCollapsible` / `.btnAddTextItem` / `#listTags`.
- **Client / server:** client.
- **Patch shape:** MutationObserver on the prompt dialog opened from `#tagsCollapsible`; attach a `<datalist>` fed by `Items/Filters?IncludeItemTypes=Video` (cached once per session); accept comma-separated bulk input and split before `items.push`.
- **Value / effort / risk:** med-high / S / low.

### 27. Bulk tag add/remove from multi-select
- **Problem:** Tagging 40 clips means 40 editor dialogs.
- **Seam:** [V] `components/multiSelect/multiSelect.js:194-256` commands (selectall, addtocollection, playlist, delete, groupvideos, markplayed, markunplayed, refresh) — no edit/tag; [V] server `Jellyfin.Api/Controllers/ItemUpdateController.cs:72-75` `POST Items/{itemId}` full-DTO update, `:239` internal `UpdateItem`.
- **Client / server:** client (loops GET `/Users/{u}/Items/{id}` → merge `Tags` → POST `/Items/{id}`); optional server endpoint later.
- **Patch shape:** push a `{id:'addtags'}` entry into the multi-select action sheet (observe `.actionSheet` when `.itemsContainer.multiSelect` is active), prompt for tags, run the loop with concurrency 4, toast progress.
- **Value / effort / risk:** high / M / med — POST of the full DTO can clobber concurrent edits and triggers a metadata save per item; respect `LockedFields`. Admin-only by server policy (`RequiresElevation` on the controller — [I], check attribute).

### 28. "Edit tags" in the ⋮ context menu
- **Problem:** Editing tags means the full metadata editor.
- **Seam:** [V by subagent] `components/itemContextMenu.js:44` `getCommands`, `:377` `executeCommand`, `:236` `edit`.
- **Client / server:** client.
- **Patch shape:** wrap the exported `getCommands` (by shape) to append `{name:'Edit tags', id:'edittags', icon:'label'}`; handle the id in a wrapped `executeCommand` with a small dialog that reuses #26's datalist and POSTs via #27's path.
- **Value / effort / risk:** med / M / low.

### 29. Tag normalisation on save (server)
- **Problem:** `Foo`, `foo ` and `foo` become three tags.
- **Seam:** [V] `ItemUpdateController.cs:239` `internal UpdateItem(BaseItemDto request, BaseItem item)` copies `request.Tags`; `MediaBrowser.Controller/Library/ILibraryManager.cs:338` `UpdateItemAsync`.
- **Client / server:** server.
- **Patch shape:** Harmony prefix on `ItemUpdateController.UpdateItem(BaseItemDto, BaseItem)` trimming/deduping `request.Tags` (case-insensitive, keep first casing). Fails soft like `ApplyOptional`.
- **Value / effort / risk:** med / S / low — only touches the request DTO.

### 30. People: show cast/person chips on clips, mergeable types
- **Problem:** People on a clip render only in the horizontal cast scroller; no quick "all clips with X" link in the header.
- **Seam:** [V by subagent] `itemDetails/index.js:1001+` `renderDetails` metadata list limited to Author/Creator/Director/Writer/Studio/Genre; `:858-889` people merging; `:1846` `renderCast` unbounded.
- **Client / server:** client.
- **Patch shape:** render a chip row of `item.People` (deduped by Id) under `.itemTags`, linking to `#/details?id=<personId>`.
- **Value / effort / risk:** med / S / low.

## Admin & server

### 31. `Items/Filters` with counts and a limit
- **Problem:** Every filter dialog open pulls every tag name; no popularity ordering.
- **Seam:** [V] `FilterController.cs:240` `GetTagNames(tagQuery)`; `BaseItemRepository.ByName.cs:121` `GetTagNames`.
- **Client / server:** server.
- **Patch shape:** postfix on `FilterController.GetQueryFiltersLegacy` honouring `?tagLimit=` / `?tagOrder=count` from the raw query (sorting needs a grouped query on `ItemValues` — [I] via `AccessTools` to the EF context; M). Pairs with #2 so the client can request top-N.
- **Value / effort / risk:** med / M / low.

### 32. Server-side storage of panel/search prefs
- **Problem:** Our prefs live in `localStorage`, so they differ per browser/phone.
- **Seam:** [V by subagent] `Jellyfin.Api/Controllers/DisplayPreferencesController.cs:48` GET, `:112` POST, `CustomPrefs` dictionary persisted (`ItemDisplayPreferences.cs:103` key `MaxLength(64)`).
- **Client / server:** client.
- **Patch shape:** read/write `CustomPrefs["jellyfinPlus.*"]` through the stock endpoint at boot and on change; fall back to localStorage.
- **Value / effort / risk:** low-med / S / low.

### 33. Dashboard: tag management page (rename / merge / delete)
- **Problem:** No UI lists tags with counts or renames one across items.
- **Seam:** [V] `GetTagNames` as above for listing; rename = loop of `POST Items/{id}` (#27) — no server rename endpoint exists (grep `Tags` in Controllers: only `ItemsController`, `FilterController`).
- **Client / server:** both for a proper rename (server endpoint doing one `UpdateItemsAsync` call — `ILibraryManager.cs:328`); client-only works but is N requests.
- **Patch shape:** plugin config page tab listing tags (count via `/Items?Tags=x&Limit=0&EnableTotalRecordCount=true`), rename → server endpoint added by the plugin (standard plugin controller, no Harmony needed).
- **Value / effort / risk:** med / L / med — writes to many items; must run as admin and honour `LockedFields`.

### 34. Faster list pages: skip `TotalRecordCount` when unneeded
- **Problem:** Each list page runs a count query over the filtered set; with endless-scroll (#12) the count is unnecessary.
- **Seam:** [V] `list.js:278-289` no `EnableTotalRecordCount` set (defaults true); [V] `ItemsController.cs` `enableTotalRecordCount` parameter (per subagent `:261`).
- **Client / server:** client.
- **Patch shape:** fetch hook adds `EnableTotalRecordCount=false` once #12 is in place; keep the pager working by requesting `Limit+1`.
- **Value / effort / risk:** low-med / S / low. [RS] measure first — may be negligible on SQLite with indexes.

### 35. Scheduled-task QoL: expose `PeopleValidationTask` / `CleanupCollectionAndPlaylistTask` triggers in our config page
- **Problem:** Tag/people clean-ups need the Dashboard → Scheduled Tasks page, several taps away on mobile.
- **Seam:** [V by subagent] `Emby.Server.Implementations/ScheduledTasks/Tasks/` — `PeopleValidationTask`, `CleanupCollectionAndPlaylistTask`, `OptimizeDatabaseTask`; stock `ScheduledTasksController` `POST /ScheduledTasks/Running/{id}`.
- **Client / server:** client (config page buttons).
- **Patch shape:** buttons calling the stock endpoints.
- **Value / effort / risk:** low / S / none.

## Late additions (from the browse/search reader; spot-checked where marked [V])

### 36. Search inside a Home Videos library returns no videos, people or studios
- **Problem:** Tap search from inside the clips library and nothing relevant comes back; only the global search (top-level) finds clips.
- **Seam:** [V] `apps/legacy/features/search/api/useVideoSearch.ts:55` `enabled: !!api && !!userId && !collectionType` — the video query is disabled whenever the search is library-scoped; [V by subagent] `usePeopleSearch.ts:37` and `useStudiosSearch.ts:36` gate on `!collectionType || isMovies || isTVShows`; [V] `utils/search.ts:110-139` `getItemTypesFromCollectionType` never includes `Video` (no `homevideos` case, default list has no `Video`); [V by subagent] `apps/modern/components/AppToolbar/SearchButton.tsx:14-28` always passes `collectionType` into the `/search` URL.
- **Client / server:** client.
- **Patch shape:** cheapest — rewrite the search link (observe the toolbar search button / hook `history.push`) to drop `collectionType` and keep `parentId`; the stock queries then run scoped to the library. Alternative: fetch hook on `/Items?searchTerm=` appending `,Video` to `includeItemTypes`.
- **Value / effort / risk:** high / S / low — pure URL change; falls back to stock behaviour if the param shape changes.

### 37. Studio / resolution / people filters hidden on the Videos tab
- **Problem:** The modern filter button on a clips library offers tags but not studios, HD/4K, or people — all of which the `/Items` query already supports.
- **Seam:** [V] `FilterButton.tsx:151` `isFiltersStudiosEnabled` (Movies/Series/Books/music only — excludes Videos/Folders/Mixed); `:163` `isFiltersFeaturesEnabled` (Movies/Series/Episodes only) gates the VideoTypes/HD/4K accordion at `:287-322`; [V by subagent] `utils/items.ts:138-157` `getFiltersQuery` already sends `studioIds`, `videoTypes`, `isHd`, `is4K` but never `personIds`; server `ItemsController.cs` takes `personIds` / `minWidth` / `minHeight` (subagent).
- **Client / server:** client.
- **Patch shape:** inject Studio / Resolution / People accordions into the Popover by DOM (`useGetStudios` data is already in the React Query cache under the library key — read it by grabbing the query client by shape, as `search-exclude.js` does), and add the chosen ids to the `/Items` request via the fetch hook keyed on `parentId`.
- **Value / effort / risk:** high / S-M / low-med — DOM-injected MUI lookalikes drift visually across updates; keep them plain.

### 38. Home Videos folder play/shuffle queues only photos
- **Problem:** "Play all" / "Shuffle" on a Home Videos folder plays nothing (or only photos).
- **Seam:** [V] `components/playback/playbackmanager.js:1960` `MediaTypes: 'Photo'` in `getNonItemTypePromise` for homevideos folders (`Limit: UNLIMITED_ITEMS`, `:1937`); [V by subagent] modern `ShuffleButton.tsx:39-51` / `PlayAllButton.tsx:38-60` special-case the Videos *tab* only because of this.
- **Client / server:** client.
- **Patch shape:** fetch hook: when an `/Items` request carries `MediaTypes=Photo` **and** the playback-field signature (`Fields=…Chapters…`), rewrite to `MediaTypes=Video,Photo`. Pairs with #18.
- **Value / effort / risk:** med-high / S / low.

### 39. Search box capped at 40 characters
- **Seam:** [V] `features/search/components/SearchFields.tsx:53` `maxLength={40}` on `#searchTextInput`.
- **Patch shape:** DOM patch removing the attribute. Client, S, no risk. Value low-med (long tag combos).

### 40. `type=tag` list sends `IncludeItemTypes=tag`
- **Seam:** [V] `list.js:283` `IncludeItemTypes: params.type === 'MusicArtist' || params.type === 'Person' ? null : params.type` with `params.type === 'tag'`. [RS] confirm what the server does with an unknown `BaseItemKind` in `CommaDelimitedCollectionModelBinder` — if it 400s or empties the list, the fetch hook should strip it; if it is ignored, this is cosmetic.
- **Value / effort / risk:** unknown until [RS] / S / low.

### 41. Cards cannot show tags, resolution or runtime
- **Problem:** Nothing on a card distinguishes a 4K clip from a 480p one, or shows its tags.
- **Seam:** [V by subagent] modern `utils/items.ts:89-120` `getItemFieldsEnum` requests only `MediaSourceCount` + `PrimaryImageAspectRatio`; `cardBuilder.js:514-516` `showRuntime` already supported (`RunTimeTicks` is in the default DTO), `:387-584` text lines never read `Tags`/`Width`/`Height`.
- **Client / server:** client.
- **Patch shape:** fetch hook appends `fields=Tags,Width,Height` for library `/Items` requests; MutationObserver adds a small badge to `.cardFooter` (resolution from `Width`/`Height`, first 2 tags). Cost: bigger DTOs per page — [RS] measure on a 100-card page.
- **Value / effort / risk:** med / M / low-med.

### 42. Multi-select "Select all" only selects the rendered page
- **Seam:** [V] `components/multiSelect/multiSelect.js:276` checks `getBoundingClientRect().width != 0`.
- **Patch shape:** a "Select all N results" entry that re-runs the current list query with `Limit=0`… no — `Limit=0` returns nothing; use the page's `TotalRecordCount` and a paged fetch of ids, then feed `startMultiSelect` (exported `:627/:631`) — M. Pairs with #27 for bulk tagging across pages.
- **Value / effort / risk:** med / M / med.

### 43. Favourites page capped at 20 per section, no favourite tags
- **Seam:** [V by subagent] `apps/legacy/controllers/favorites.js:62-63` `HeaderVideos` section, `:195-201` `Limit = 20`.
- **Patch shape:** fetch hook raising `Limit` for `IsFavorite=true` requests from that view, or a "More" link to `#/list?type=Video&IsFavorite=true`. Client, S, low. Value low-med.

### 44. Modern Videos tab: mobile card has play only, no ⋮
- **Seam:** [V by subagent] `cardBuilder.js:828-847` — more button only with `options.overlayMoreButton`; `apps/modern/features/libraries/components/ItemsView.tsx:141-143` sets play for Movies and more for Series/Studios, **nothing for Videos**.
- **Patch shape:** same injection as #9 (`data-action="menu"` overlay button). Folded into #9; listed so the modern seam is on record.

---

## Dropped

- Anything touching media files (batch re-encode, thumbnail re-generation outside stock Trickplay) — project rule.
- Server-side tag AND via multiple `GetItems` calls — correctness ok but N queries; superseded by #3.
- Patching `SqlSearchProvider` further for tag search — already shipped in `SearchPatches.cs`.

## Verification notes

- Every `[V]` seam was opened with `sed`/`grep` in the v12.1 checkouts during this task; `[V by subagent]` lines were reported by a delegated reader with line numbers and spot-checked where cheap (`cardBuilder.js:984`, `multiSelect.js:194-256`, `useSearchItems.ts:78`, `useSearchSuggestions.ts:19-26`).
- `[I]` items name the exact function but not the predicate line; `[RS]` items need the running server (EF expression compile for #11, provider method name for #25, routing for #13, timing for #34).
- The web browse/sort/filter reader reported after the first draft; its findings are folded in as #36-44 and into #2 and #10. Spot-checked directly: `useVideoSearch.ts:55`, `SearchFields.tsx:53`, `FiltersTags.tsx:42`, `FilterButton.tsx:132/151/163`, `SortButton.tsx:54-64`, `playbackmanager.js:1960`, `multiSelect.js:276`, `list.js:283`.
