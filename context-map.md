# context-map.md

Full module list for the web client (`web/src/`), one line each: what it exports, what it imports.
Written for the `real-es-modules` pass (2026-09-24, `.agent-briefs/real-es-modules.md`), which
replaced the numbered `cat`-concatenated `web/src/NN-name.js` files with real ES modules bundled by
esbuild into `web/jellyfin-plus.js`. See `CLAUDE.md`'s "Before you change the client" section for the
narrative version and `WEB_PANEL_DESIGN.md` section 9/9.1 for how this came to be.

Layout is MVC-style: `lib/` (dependency-free leaves), `model/` (data + session logic), `controller/`
(orchestration: network, probing, playback/webpack hooks), `view/` (DOM rendering), and one entry
point, `bootstrap.js`, at `web/src/` root.

Real `import`/`export` surfaced genuine circular dependencies the old shared-scope build hid (see
the note in CLAUDE.md). They are marked below with `<->`. Every one of them is a function call
resolved at call time, never a value read at module-evaluation time - the pattern ES modules (and
esbuild) support natively.

## lib/ - dependency-free

| module | exports | imports |
|---|---|---|
| `lib/storage-migrate.js` | none (side effect: one-time rename of the old `gpuUpscale*` localStorage keys to `jellyfinPlus*`) | none |
| `lib/log.js` | `log()` | none |
| `lib/dom.js` | `el(tag, cls, text)` | none |
| `lib/utils.js` | `isOff(v)` | none |

## model/ - data and session logic

| module | exports | imports |
|---|---|---|
| `model/controls-data.js` | `CONTROLS`, `SR_ALIASES`, `GAME_OPTION_KEYS`, `DEFAULT_PREFS` | none (pure data) |
| `model/library-landing.js` | `DEFAULT_LANDING`, `VIDEOS_TAB_INDEX`, `landingKey()`, `landingSeeds()`, `videosTabHash()` | none (pure) |
| `model/library-filter-marks.js` | `MARK_START`, `mark()`, `isMark()`, `parseTags()`, `buildTags()`, `rewriteLibraryUrl()` | none (pure) |
| `model/state.js` | `state` (the mutable session singleton), `LADDER_SHARPEN`, `LADDER_SR`, `FPS`, `DENOISE_COST`, `NEURAL_COST`, `GAME_COST`, `COSTS`, `DEBLOCK_COST` | `controls-data.js` (`DEFAULT_PREFS`, to seed `state.prefs`) |
| `model/prefs-store.js` | `savePrefs()`; loads stored prefs into `state` as a side effect on import | `state.js`, `controls-data.js` (`DEFAULT_PREFS`, `SR_ALIASES`) |
| `model/costing.js` | `serverConfig()`, `eligibleTargets()`, `srWouldRun()`, `stageCost()`, `selectionCost()`, `costHint()` | `state.js`, `controls-data.js` (`CONTROLS`), `effective.js` (`shownPrefs`) `<->`, `lib/utils.js` (`isOff`) |
| `model/ladder.js` | `ladder()`, `recommendedStage()`, `sameStage()`, `currentStage()`, `stageText()` | `state.js`, `costing.js` |
| `model/effective.js` | `effective()`, `displayPrefs()`, `shownPrefs()`, `anyEnhancement()`, `summaryText()`, `advancedText()` | `state.js`, `controls-data.js` (`DEFAULT_PREFS`), `ladder.js`, `costing.js` (`eligibleTargets`), `controller/network.js` (`wireParams`) `<->`, `lib/utils.js` (`isOff`) |
| `model/conflicts.js` | `axisConflict()`, `optionInert()`, `costSuffix()`, `shortName()`, `gameOwnsOutputSize()`, `neuralCudaLevels()`, `neuralCudaDisables()`, `cudaDenoiseLevels()`, `neuralIsCudaNative()` | `state.js` (`COSTS`), `lib/utils.js` (`isOff`), `costing.js` (`eligibleTargets`), `effective.js` (`shownPrefs`) |

## controller/ - orchestration

| module | exports | imports |
|---|---|---|
| `controller/probe.js` | `probeServer()`, `axisControls()`, `controlNote()` | `model/state.js`, `model/controls-data.js` (`CONTROLS`), `model/costing.js` (`eligibleTargets`, `srWouldRun`), `model/effective.js` (`shownPrefs`), `lib/log.js`, `lib/utils.js` (`isOff`) |
| `controller/network.js` | `wireParams()`, `paramSig()`, `addParams()`, `markHlsUrl()`, `hookFetch()`, `hookXhr()` | `model/state.js`, `model/controls-data.js` (`GAME_OPTION_KEYS`), `model/effective.js` (`effective`, `anyEnhancement`) `<->`, `playback-hooks.js` (`resetUpscaleForNewSource`) `<->`, `search-exclude.js` (`markSearchUrl`), `search-filters.js` (`markSearchFilters`), `search-pager.js` (`markSearchPaging`, `watchPagedXhr`, `watchPagedFetch`), `model/search-suggest.js` (`suggestVideoUrl`), `lib/log.js` |
| `controller/search-pager.js` | `onPagerChanged()`, `markSearchPaging()`, `watchPagedXhr()`, `watchPagedFetch()`, `isInfinite()`, `infOf()`, `pagerOf()`, `hasItem()`, `takeUserNav()`, `goTo()`, `fetchMore()`, `setMode()`, `setSize()` (search paging: rewrites the Videos and all-types `/Items` queries to a page, reads TotalRecordCount, and in infinite mode fetches and caches the following slices) | `lib/log.js`, `model/search-paging.js`, `search-exclude.js` (`getQueryClient`, `excludeText`), `search-filters.js` (`onFiltersChanged`, `searchParentId`) |
| `model/search-paging.js` | `STORE_KEY`, `MODE_KEY`, `SIZES`, `DEFAULT_SIZES`, `INF_SIZES`, `CHUNK`, `KINDS`, `kindOf()`, `searchTermOf()`, `normalizeSize()`, `normalizeSizes()`, `loadSizes()`, `saveSizes()`, `normalizeMode()`, `loadMode()`, `saveMode()`, `rewritePagedUrl()`, `pagingOf()`, `pageCount()`, `summarize()`, `worthShowing()`, `reachedEnd()`, `rangeText()`, `pageAfterEmpty()`, `chunkItems()`, `typeTitle()`, `shapeForType()`, `cardOptionsFor()` (pure; unit-tested by `model/search-paging.test.mjs`, run with `node`) | none (pure) |
| `controller/search-scope.js` | `installSearchScopeFix()` | `lib/log.js` |
| `controller/library-landing.js` | `installLibraryLanding()` (Home Videos libraries open on the Videos tab) | `lib/log.js`, `model/library-landing.js` |
| `controller/library-filters.js` | `WINDOW_LIMIT`, `WINDOW_SIZE`, `normalize()`, `listKey()`, `listState()`, `setSearch()`, `applyWindow()`, `ensureWindowed()`, `findFilterContext()`, `readFilters()`, `updateFilters()`, `updateTagState()`, `nameOf()`, `searchEntities()`, `installLibraryFilterHooks()` | `lib/log.js`, `search-exclude.js` (`getQueryClient`), `tag-window.js` (`fetchTagWindow`, `TOTAL_HEADER`), `model/library-filter-marks.js` |
| `controller/tag-window.js` | `TOTAL_HEADER`, `normalize()`, `localWindow()`, `fetchTagWindow()` (a window of `/Items/Filters` tags via `jpTagLimit` / `jpTagQuery`, with the match count from `X-JellyfinPlus-TagTotal`; filters locally against a server that ignores them) | `lib/log.js` |
| `controller/search-census.js` | `adjustSearchUrl()`, `installSearchCensus()` (fetches `GET /JellyfinPlus/Library/Census`, rewrites search requests that cannot match to a nil-id `/Items` lookup; installed before `hookFetch`/`hookXhr` so it sees the final url) | `lib/log.js`, `model/search-census.js` |
| `model/search-census.js` | `parts()`, `verdict()`, `nullRequest()` (pure; unit-tested by `model/search-census.test.mjs`, run with `node`) | none (pure) |
| `model/search-filters.js` | `STORE_KEY`, `SORTS`, `TYPES`, `ROLES`, `RESOLUTIONS`, `ADDED_PRESETS`, `RUNTIME_PRESETS`, `defaultState()`, `normalizeState()`, `loadState()`, `saveState()`, `sortInfo()`, `chipsOf()`, `activeGroups()`, `activeRes()`, `activeRoles()`, `matchAllPeople()`, `addedRange()`, `utcDay()`, `removeChip()`, `typePlan()`, `filterPairs()`, `rewriteSearchUrl()`, `facetPairs()`, `facetKey()`, `filterFacets()`, `facetRows()`, `facetText()`, `offeredRoles()`, `normalizeFacet()` (the Sort & filter state and its wire-contract serialiser; unit-tested by `model/search-filters.test.mjs`, run with `node`) | none (pure) |
| `controller/search-filters.js` | `currentFilters()`, `onFiltersChanged()`, `searchParentId()`, `committedTerm()`, `markSearchFilters()`, `commit()`, `refreshIfActive()`, `fetchTags(parentId, query, limit)` (one server-side window of tags), `fetchPeopleFacets()` (Cast & Crew list from `GET /JellyfinPlus/Search/Facets`, cached per term + filters) | `lib/log.js`, `model/search-filters.js`, `search-exclude.js` (`refetchSearch`, `excludeText`), `tag-window.js` (`fetchTagWindow`) |
| `model/search-suggest.js` | `suggestVideoUrl()` (adds `Video` to the empty search page's Suggestions request, recognised by shape; pure; unit-tested by `model/search-suggest.test.mjs`, run with `node`) | none (pure) |
| `model/search-recent.js` | `STORE_KEY`, `MAX_RECENT`, `MAX_TERM`, `cleanTerm()`, `normalizeList()`, `pushTerm()`, `removeTerm()`, `loadRecent()`, `saveRecent()`, `listSig()` (recent search terms; pure, storage injected; unit-tested by `model/search-recent.test.mjs`, run with `node`) | none (pure) |
| `controller/search-exclude.js` | `excludeText()`, `markSearchUrl()`, `refetchSearch()`, `noteQueryClient()`, `getQueryClient()`, `runSearch()`, `watchSearchPage()` | `lib/log.js`, `lib/dom.js` (`el`) |
| `controller/live-apply.js` | `repaintPanel()`, `isPlaybackManager()`, `notePlaybackManager()`, `player()`, `playerPresent()`, `watchApplied()`, `replayHere()`, `directPlaying()`, `requestRestream()`, `activeState()`, `APPLY_LABEL`, `APPLY_FAILED_TEXT` | `model/state.js`, `lib/utils.js` (`isOff`), `lib/log.js`, `view/panel-dom.js` (`renderPanel`, `panelEl`) `<->`, `live-block.js` (`LIVE_ROWS`) `<->` |
| `controller/live-block.js` | `LIVE_ROWS`, `staleNote()`, `liveLines()`, `fetchServerState()` | `model/state.js`, `lib/utils.js` (`isOff`), `network.js` (`wireParams`, `paramSig`), `live-apply.js` (`activeState`) `<->` |
| `controller/action-sheet.js` | `isPlayerSettingsSheet()`, `wrapActionSheet()` | `model/state.js`, `model/effective.js` (`summaryText`), `playback-hooks.js` (`openEnhancePanel`) `<->`, `lib/log.js` |
| `controller/playback-hooks.js` | `hookPlaybackEvents()`, `resetUpscaleForNewSource()`, `openEnhancePanel()`, `watchPlaybackInfoDialog()` | `model/state.js`, `model/controls-data.js` (`DEFAULT_PREFS`), `model/prefs-store.js` (`savePrefs`), `lib/log.js`, `lib/dom.js` (`el`), `live-apply.js` (`player`), `probe.js` (`probeServer`), `live-block.js` (`fetchServerState`), `view/panel-dom.js` (`closePanel`, `ensureStyle`, `renderPanel`, `panelEl`, `applyPanelPos`, `liveRows`, `FOCUSABLE`, `PANEL_ID`) |
| `controller/webpack-hook.js` | `hookWebpack()` | `model/state.js`, `lib/log.js`, `action-sheet.js` (`wrapActionSheet`), `live-apply.js` (`notePlaybackManager`), `search-exclude.js` (`noteQueryClient`), `detail-related.js` (`noteCardBuilder`) |
| `controller/play-all.js` | `installPlayAllFix()`, `rewritePlaybackQueryUrl()` | `lib/log.js` |
| `controller/double-tap-seek.js` | `installDoubleTapSeek()` | `model/state.js`, `lib/log.js`, `lib/dom.js` (`el`), `live-apply.js` (`player`, `activePlayer`) |
| `controller/clip-upnext.js` | `installClipUpNext()` | `model/state.js`, `lib/log.js`, `lib/dom.js` (`el`), `live-apply.js` (`player`, `activePlayer`) |
| `controller/detail-related.js` | `installDetailRelated()`, `noteCardBuilder()`, `getCardBuilder()` | `lib/log.js`, `lib/dom.js` (`el`) |
| `controller/person-videos.js` | `installPersonVideos()`, `rewriteSectionUrl()` | `lib/log.js` |
| `controller/bulk-tags.js` | `parseTags()`, `mergeTags()`, `buildPayload()`, `changedFields()`, `editItemTags()`, `runBulk()`, `loadTagNames()`, `loadSelectionTags()`, `installBulkTags()` | `lib/log.js`, `view/bulk-tags-dialog.js` (`showTagDialog`) |

## view/ - DOM rendering

| module | exports | imports |
|---|---|---|
| `view/panel-dom.js` | `FOCUSABLE`, `PANEL_ID`, `panelEl()`, `ensureStyle()`, `liveRows()`, `applyPanelPos()`, `renderPanel()`, `closePanel()` | `lib/dom.js` (`el`), `lib/log.js`, `model/state.js`, `model/controls-data.js` (`CONTROLS`, `DEFAULT_PREFS`), `model/conflicts.js`, `model/effective.js`, `model/ladder.js`, `model/costing.js`, `model/prefs-store.js` (`savePrefs`), `controller/live-apply.js` (`requestRestream`, `activeState`, `APPLY_LABEL`, `APPLY_FAILED_TEXT`) `<->`, `controller/live-block.js` (`liveLines`), `controller/probe.js` (`axisControls`, `controlNote`) |
| `view/search-grid.js` | `installSearchGrid()` (vertical card grid on phone and desktop; 2 columns up to 50em, `auto-fill` above; TV left alone; `.jpChunk` rules for infinite scroll) | `lib/log.js` |
| `view/search-recent.js` | `installSearchRecent()` (recent-search chips on the empty search page, records each committed `?query=`, and raises the search box's 40-character cap to 200; skipped on TV) | `lib/log.js`, `lib/dom.js` (`el`), `model/search-recent.js`, `controller/search-exclude.js` (`runSearch`), `controller/search-filters.js` (`committedTerm`) |
| `view/search-pager.js` | `installSearchPager()` (the Prev/Next pager and page-size choice under each result grid, and the Paged / Infinite switch; calls into `search-infinite.js` in infinite mode) | `lib/log.js`, `lib/dom.js` (`el`), `model/search-paging.js`, `controller/search-pager.js`, `view/search-infinite.js` |
| `view/search-infinite.js` | `syncInfinite()`, `teardownInfinite()` (infinite scroll DOM: cards drawn with cardBuilder into `.jpChunk` wrappers, the sentinel / loading / end row, sections for new types) | `lib/log.js`, `lib/dom.js` (`el`), `model/search-paging.js`, `controller/search-pager.js` (`infOf`, `fetchMore`), `controller/detail-related.js` (`getCardBuilder`), `view/virtual-chunks.js` |
| `view/virtual-chunks.js` | `addChunk()`, `removeChunk()`, `estimateChunkHeight()` (evicts card chunks more than three screens away and pins their height; DOM only) | none |
| `view/search-filter-sheet.js` | `installSearchFilterBar()` (the "Sort & filter" button, badge, active-filter chips and bottom sheet on `#searchPage`) | `lib/log.js`, `lib/dom.js` (`el`), `controller/library-filters.js` (`normalize`, `WINDOW_SIZE`, `searchEntities`), `controller/search-filters.js`, `model/search-filters.js` |
| `view/image-zoom.js` | `fullSizeUrl()`, `installImageZoom()` | `lib/log.js`, `lib/dom.js` (`el`) |
| `view/library-filter-panel.js` | `installLibraryFilterPanel()` | `lib/log.js`, `lib/dom.js` (`el`), `controller/library-filters.js` |
| `view/card-actions.js` | `installCardActions()` | `lib/log.js`, `lib/dom.js` (`el`) |
| `view/bulk-tags-dialog.js` | `showTagDialog()` | `lib/dom.js` (`el`), `lib/log.js` |

## Entry point

| module | exports | imports |
|---|---|---|
| `bootstrap.js` | none (runs the install try/catch as a side effect) | `lib/storage-migrate.js` (first import; must run before `prefs-store.js` loads), `model/state.js`, `lib/log.js`, `model/prefs-store.js` (for its load-on-import side effect), `controller/webpack-hook.js` (`hookWebpack`), `controller/search-census.js` (`installSearchCensus`, through `feature()`, installed BEFORE `hookFetch`/`hookXhr`), `controller/network.js` (`hookFetch`, `hookXhr`), `controller/playback-hooks.js` (`watchPlaybackInfoDialog`), `controller/probe.js` (`probeServer`), `controller/search-exclude.js` (`watchSearchPage`), `controller/search-scope.js` (`installSearchScopeFix`), `view/search-grid.js` (`installSearchGrid`), `view/search-pager.js` (`installSearchPager`, through `feature()`), `view/search-filter-sheet.js` (`installSearchFilterBar`, through `feature()`), `view/image-zoom.js` (`installImageZoom`), and the QoL installers: `controller/play-all.js`, `view/card-actions.js`, `controller/double-tap-seek.js`, `controller/clip-upnext.js`, `controller/detail-related.js`, `controller/person-videos.js`, `controller/bulk-tags.js` (each through `feature()`, its own try/catch) |
| `banner.txt` | n/a - not a module, injected as the bundle's leading comment via esbuild's `--banner:js` | none |

## Build

`scripts/build-web-panel.sh` runs `web/node_modules/.bin/esbuild src/bootstrap.js --bundle
--format=iife --target=es2018 --banner:js="$(cat src/banner.txt)"` from `web/`, producing
`web/jellyfin-plus.js`. esbuild is a build-time-only dependency: `web/package.json` +
`web/package-lock.json` are checked in, `web/node_modules/` is gitignored and installed with
`npm install` in `web/` on whichever machine runs the build.
