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
| `controller/network.js` | `wireParams()`, `paramSig()`, `addParams()`, `markHlsUrl()`, `hookFetch()`, `hookXhr()` | `model/state.js`, `model/controls-data.js` (`GAME_OPTION_KEYS`), `model/effective.js` (`effective`, `anyEnhancement`) `<->`, `playback-hooks.js` (`resetUpscaleForNewSource`) `<->`, `search-exclude.js` (`markSearchUrl`), `search-filters.js` (`markSearchFilters`), `lib/log.js` |
| `controller/search-scope.js` | `installSearchScopeFix()` | `lib/log.js` |
| `controller/library-filters.js` | `WINDOW_LIMIT`, `WINDOW_SIZE`, `normalize()`, `listKey()`, `listState()`, `setSearch()`, `applyWindow()`, `ensureWindowed()`, `findFilterContext()`, `readFilters()`, `updateFilters()`, `updateTagState()`, `nameOf()`, `searchEntities()`, `installLibraryFilterHooks()` | `lib/log.js`, `search-exclude.js` (`getQueryClient`), `model/library-filter-marks.js` |
| `model/search-filters.js` | `STORE_KEY`, `SORTS`, `TYPES`, `RESOLUTIONS`, `ADDED_PRESETS`, `RUNTIME_PRESETS`, `defaultState()`, `normalizeState()`, `loadState()`, `saveState()`, `sortInfo()`, `chipsOf()`, `activeGroups()`, `activeRes()`, `addedRange()`, `utcDay()`, `removeChip()`, `typePlan()`, `filterPairs()`, `rewriteSearchUrl()` (the Sort & filter state and its wire-contract serialiser; unit-tested by `model/search-filters.test.mjs`, run with `node`) | none (pure) |
| `controller/search-filters.js` | `currentFilters()`, `onFiltersChanged()`, `searchParentId()`, `markSearchFilters()`, `commit()`, `refreshIfActive()`, `fetchTags()` | `lib/log.js`, `model/search-filters.js`, `search-exclude.js` (`refetchSearch`, `excludeText`) |
| `controller/search-exclude.js` | `excludeText()`, `markSearchUrl()`, `refetchSearch()`, `noteQueryClient()`, `getQueryClient()`, `watchSearchPage()` | `lib/log.js`, `lib/dom.js` (`el`) |
| `controller/live-apply.js` | `repaintPanel()`, `isPlaybackManager()`, `notePlaybackManager()`, `player()`, `playerPresent()`, `watchApplied()`, `replayHere()`, `directPlaying()`, `requestRestream()`, `activeState()`, `APPLY_LABEL`, `APPLY_FAILED_TEXT` | `model/state.js`, `lib/utils.js` (`isOff`), `lib/log.js`, `view/panel-dom.js` (`renderPanel`, `panelEl`) `<->`, `live-block.js` (`LIVE_ROWS`) `<->` |
| `controller/live-block.js` | `LIVE_ROWS`, `staleNote()`, `liveLines()`, `fetchServerState()` | `model/state.js`, `lib/utils.js` (`isOff`), `network.js` (`wireParams`, `paramSig`), `live-apply.js` (`activeState`) `<->` |
| `controller/action-sheet.js` | `isPlayerSettingsSheet()`, `wrapActionSheet()` | `model/state.js`, `model/effective.js` (`summaryText`), `playback-hooks.js` (`openEnhancePanel`) `<->`, `lib/log.js` |
| `controller/playback-hooks.js` | `hookPlaybackEvents()`, `resetUpscaleForNewSource()`, `openEnhancePanel()`, `watchPlaybackInfoDialog()` | `model/state.js`, `model/controls-data.js` (`DEFAULT_PREFS`), `model/prefs-store.js` (`savePrefs`), `lib/log.js`, `lib/dom.js` (`el`), `live-apply.js` (`player`), `probe.js` (`probeServer`), `live-block.js` (`fetchServerState`), `view/panel-dom.js` (`closePanel`, `ensureStyle`, `renderPanel`, `panelEl`, `applyPanelPos`, `liveRows`, `FOCUSABLE`, `PANEL_ID`) |
| `controller/webpack-hook.js` | `hookWebpack()` | `model/state.js`, `lib/log.js`, `action-sheet.js` (`wrapActionSheet`), `live-apply.js` (`notePlaybackManager`), `search-exclude.js` (`noteQueryClient`), `detail-related.js` (`noteCardBuilder`) |
| `controller/play-all.js` | `installPlayAllFix()`, `rewritePlaybackQueryUrl()` | `lib/log.js` |
| `controller/double-tap-seek.js` | `installDoubleTapSeek()` | `model/state.js`, `lib/log.js`, `lib/dom.js` (`el`), `live-apply.js` (`player`, `activePlayer`) |
| `controller/clip-upnext.js` | `installClipUpNext()` | `model/state.js`, `lib/log.js`, `lib/dom.js` (`el`), `live-apply.js` (`player`, `activePlayer`) |
| `controller/detail-related.js` | `installDetailRelated()`, `noteCardBuilder()` | `lib/log.js`, `lib/dom.js` (`el`) |
| `controller/person-videos.js` | `installPersonVideos()`, `rewriteSectionUrl()` | `lib/log.js` |
| `controller/bulk-tags.js` | `parseTags()`, `mergeTags()`, `buildPayload()`, `changedFields()`, `editItemTags()`, `runBulk()`, `loadTagNames()`, `loadSelectionTags()`, `installBulkTags()` | `lib/log.js`, `view/bulk-tags-dialog.js` (`showTagDialog`) |

## view/ - DOM rendering

| module | exports | imports |
|---|---|---|
| `view/panel-dom.js` | `FOCUSABLE`, `PANEL_ID`, `panelEl()`, `ensureStyle()`, `liveRows()`, `applyPanelPos()`, `renderPanel()`, `closePanel()` | `lib/dom.js` (`el`), `lib/log.js`, `model/state.js`, `model/controls-data.js` (`CONTROLS`, `DEFAULT_PREFS`), `model/conflicts.js`, `model/effective.js`, `model/ladder.js`, `model/costing.js`, `model/prefs-store.js` (`savePrefs`), `controller/live-apply.js` (`requestRestream`, `activeState`, `APPLY_LABEL`, `APPLY_FAILED_TEXT`) `<->`, `controller/live-block.js` (`liveLines`), `controller/probe.js` (`axisControls`, `controlNote`) |
| `view/search-grid.js` | `installSearchGrid()` | `lib/log.js` |
| `view/search-filter-sheet.js` | `installSearchFilterBar()` (the "Sort & filter" button, badge, active-filter chips and bottom sheet on `#searchPage`) | `lib/log.js`, `lib/dom.js` (`el`), `controller/library-filters.js` (`normalize`, `WINDOW_SIZE`, `searchEntities`), `controller/search-filters.js`, `model/search-filters.js` |
| `view/image-zoom.js` | `fullSizeUrl()`, `installImageZoom()` | `lib/log.js`, `lib/dom.js` (`el`) |
| `view/library-filter-panel.js` | `installLibraryFilterPanel()` | `lib/log.js`, `lib/dom.js` (`el`), `controller/library-filters.js` |
| `view/card-actions.js` | `installCardActions()` | `lib/log.js`, `lib/dom.js` (`el`) |
| `view/bulk-tags-dialog.js` | `showTagDialog()` | `lib/dom.js` (`el`), `lib/log.js` |

## Entry point

| module | exports | imports |
|---|---|---|
| `bootstrap.js` | none (runs the install try/catch as a side effect) | `lib/storage-migrate.js` (first import; must run before `prefs-store.js` loads), `model/state.js`, `lib/log.js`, `model/prefs-store.js` (for its load-on-import side effect), `controller/webpack-hook.js` (`hookWebpack`), `controller/network.js` (`hookFetch`, `hookXhr`), `controller/playback-hooks.js` (`watchPlaybackInfoDialog`), `controller/probe.js` (`probeServer`), `controller/search-exclude.js` (`watchSearchPage`), `controller/search-scope.js` (`installSearchScopeFix`), `view/search-grid.js` (`installSearchGrid`), `view/search-filter-sheet.js` (`installSearchFilterBar`, through `feature()`), `view/image-zoom.js` (`installImageZoom`), and the QoL installers: `controller/play-all.js`, `view/card-actions.js`, `controller/double-tap-seek.js`, `controller/clip-upnext.js`, `controller/detail-related.js`, `controller/person-videos.js`, `controller/bulk-tags.js` (each through `feature()`, its own try/catch) |
| `banner.txt` | n/a - not a module, injected as the bundle's leading comment via esbuild's `--banner:js` | none |

## Build

`scripts/build-web-panel.sh` runs `web/node_modules/.bin/esbuild src/bootstrap.js --bundle
--format=iife --target=es2018 --banner:js="$(cat src/banner.txt)"` from `web/`, producing
`web/jellyfin-plus.js`. esbuild is a build-time-only dependency: `web/package.json` +
`web/package-lock.json` are checked in, `web/node_modules/` is gitignored and installed with
`npm install` in `web/` on whichever machine runs the build.
