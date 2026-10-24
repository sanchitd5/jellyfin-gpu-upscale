# Plugin conversion: Jellyfin Plus as a standard plugin

A plan for turning Jellyfin Plus from "a plugin plus a patch set plus five server-side scripts" into
something installable from a repository manifest, with the patching reduced to the minimum the
server leaves no seam for.

Status words: **CONFIRMED** = read in this repo's code or in the decompiled Jellyfin 12.1 assemblies
(`~/dev/jellyfin-bin-12.1`, `ilspycmd`) or fetched source; **ASSUMED** = inferred, not exercised.
Inventory counts: **29 patch/reflection sites** (5 core + 23 optional Harmony incl. 7 scan-timing
hooks, + 1 reflection delegate) and **7 out-of-plugin mechanisms** = 36 rows. Verdicts: 19
REPLACEABLE, 11 PARTIAL, 6 NEEDS-PATCH.

## 1. Goal and non-goals

| | |
|---|---|
| Goal | `Jellyfin.Plugin.Plus.dll` + `meta.json` in `/var/lib/jellyfin/plugins/JellyfinPlus_<ver>/`, installed from a manifest URL in Dashboard → Plugins → Repositories; upgrade = Jellyfin's own installer; no `jellyfin-plus-activate`, no apt hook, no edits under `/usr/share/jellyfin/web`. |
| Goal | Every feature that can run on a supported Jellyfin 12.x extension point does. Harmony stays only where §5 says there is no seam, and is isolated in one optional, separately versioned assembly. |
| Goal | AGENTS.md invariants hold throughout: access never widened (13), faster means identical output on the real DB (14), fail soft to stock (15), plugin tables only (16), request params are a wire contract (17), no library content in the repo (18). A phase that cannot prove one of these does not ship. |
| Non-goal | Dropping the patched ffmpeg. The five filters (`oidn`, `optix`, `ort`, `fsr2`, `dlss`) need a custom binary; the plan changes how it is *named*, not whether it exists. |
| Non-goal | Pre-processing video, batch passes, writing into the library (see `improvements.md`). |
| Non-goal | Supporting Jellyfin < 12.1. `targetAbi` moves with the assemblies we build against (CONFIRMED: `scripts/proxmox-build.sh:240` writes `12.3.0.0`). |
| Non-goal | Changing the wire contract (§9 of ENHANCEMENTS.md). Clients keep sending the same params; only where the server reads them changes. |

## 2. Inventory

### 2.1 Harmony patches (`src/patcher/*`, Harmony id `jellyfin.plugin.jellyfinplus`)

All CONFIRMED from the source unless marked. "Reflection" = private Jellyfin members reached by `AccessTools`/`GetMethod(NonPublic)`, i.e. what breaks on a Jellyfin point release.

| # | Site | Hooks (type.method) | Why | Feature | Candidate seam | Verdict |
|---|---|---|---|---|---|---|
| 1 | `UpscalePatches.cs:109` → `:676` | `MediaBrowser.Controller.MediaEncoding.EncodingHelper.GetVideoProcessingFilterParam` postfix | Appends the libplacebo/`vf_*` chain to `-vf`; the whole enhancement engine hangs off this | Every axis (`upscale`…`reactive`), session status | None. `EncodingHelper` is `AddSingleton<EncodingHelper>()` concrete, not sealed, **zero virtual members** (CONFIRMED). A DI subclass cannot intercept non-virtual calls from `MediaEncoder`/`DynamicHlsController`, which take the concrete type. Only alternative: an ffmpeg wrapper on `EncoderAppPath` (§3.3 option B) | **NEEDS-PATCH**. Upstream PR: make the five `Get*` methods virtual, or add `IEncodingArgumentsProvider` hook (none exists in 12.x, CONFIRMED by grep) |
| 2 | `:109` → `:752` | `EncodingHelper.GetInputVideoHwaccelArgs` postfix | Replaces decode hwaccel with the Vulkan (or CUDA) device the chain needs | Every axis | same as #1 | NEEDS-PATCH |
| 3 | `:109` → `:772` | `EncodingHelper.GetHwaccelType` postfix | Drops `-hwaccel` unless CUDA-native neural | Every axis | same | NEEDS-PATCH |
| 4 | `:109` → `:791` | `EncodingHelper.GetHardwareVideoDecoder` postfix | Drops `*_cuvid` decoder | Every axis | same | NEEDS-PATCH |
| 5 | `:109` → `:818` | `EncodingHelper.GetVideoEncoder` postfix | `copy` → configured encoder when enhancing; AV1 guard | Every axis, configured encoder | same | NEEDS-PATCH |
| 6 | `UpscalePatches.cs:404` | `Jellyfin.Api.Helpers.MediaInfoHelper.SetDeviceSpecificData` prefix | Forces transcode for direct-play-eligible sources when `ForceTranscodeForDirectPlay` | Direct-play override (default off) | Client already sends `EnableDirectPlay=false`/`EnableDirectStream=false` in `PlaybackInfo` when opted in (CONFIRMED ENHANCEMENTS §1). Server-side force exists only for clients without the script | **PARTIAL**: drop the patch, keep client-side; lost = enforcement for script-less clients |
| 7 | `SwapPatches.cs:68` | `MediaBrowser.MediaEncoding.Transcoding.TranscodeManager.KillTranscodingJobs` prefix | Defers the kill so the old job overlaps the new one (A/B swap) | Live apply smoothness | `TranscodeManager` is `AddSingleton<ITranscodeManager, TranscodeManager>()` (ASSUMED registration shape; interface exists). DI-replace `ITranscodeManager` with a wrapper that delegates everything and defers kills | **PARTIAL**: wrapper only sees interface calls; `StartFfMpeg` (#8) is internal to the class. Without #8 the fallback is "tear down and restart" which already works (CONFIRMED `SwapPatches` fail-soft) |
| 8 | `SwapPatches.cs:71` | `TranscodeManager.StartFfMpeg` postfix | Tears down the deferred job once the new one is ready | Live apply | none via DI (private method). Wrapper could poll segment files instead (ASSUMED) | PARTIAL |
| 9 | `SearchPatches.cs:159` | `Emby.Server.Implementations.Library.Search.SqlSearchProvider.SearchAsync` prefix+postfix | Tag matches, `excludeTags`, wildcard, FTS candidate narrowing | Search tag match/exclude/wildcards, FTS speed | `MediaBrowser.Controller.Library.ISearchProvider` is a multi-export: `SearchManager.AddParts` orders by `Priority`, `CanSearch(query)` gates (CONFIRMED). Plugin provider with lower priority answers the query itself | **REPLACEABLE** (own provider). Reflection today: `_dbProvider`, `ApplyTypeFilter`, `ApplyMediaTypeFilter`, `ApplyParentFilter`, `ApplyUserAccessFilter`, `ExcludeVersionsOfMatchedPrimaries` — must be re-implemented in the provider; access filter re-implementation is invariant-13 risk, digest-prove it |
| 10 | `SearchSortPatches.cs:149` | `SearchManager.GetSearchResultsAsync` prefix+postfix | Widens pool to 2000/5000, re-scores by `sortBy`, records pool for deep paging | Search sort | Own provider (#9) can return the wide, sorted pool directly; `SearchManager` fallback semantics after a provider answers ASSUMED | REPLACEABLE (folds into #9) |
| 11 | `SearchDeepPagePatches.cs:116` | `Jellyfin.Server.Implementations.Item.BaseItemRepository.GetItemList` prefix | Loads only the page's entities, stubs the rest | Deep search paging | A plugin controller (`JellyfinPlus/Search`) returning the page itself; `/Items?searchTerm=` stays stock. Client routes paged search to the plugin route | **PARTIAL**: stock `/Items?searchTerm=` loses deep paging; plugin route keeps it. Wire contract: new route, same params |
| 12 | `SearchDeepPagePatches.cs:126` | `MediaBrowser.Controller.Entities.Folder.SortItemsByRequest` (private static) prefix | O(n²) → dictionary | Deep paging perf | moot once #11 serves from plugin route | REPLACEABLE (drop) |
| 13 | `ServerTimingPatches.cs:161` | `SearchManager.GetSearchResultsAsync` prefix/postfix (First/Last) | `Server-Timing` header on search | Diagnostics | ASP.NET middleware via `IStartupFilter` registered from `IPluginServiceRegistrator` (CONFIRMED pattern in JS-Injector/File Transformation) can time whole requests; per-stage split needs the patches | PARTIAL (whole-request only); or drop, diagnostic only |
| 14 | `ServerTimingPatches.cs:221` ×4 | `SqlSearchProvider.SearchAsync`, `Folder.GetItems`, `Emby.Server.Implementations.Dto.DtoService.GetBaseItemDtos` | stage timings | Diagnostics | as #13 | PARTIAL / drop |
| 15 | `LibraryFilterPatches.cs:117` | `BaseItemRepository.TranslateQuery(IQueryable<BaseItemEntity>, JellyfinDbContext, InternalItemsQuery)` prefix+postfix | `excludeTagNames`, `tagMatch=all`, `jpMinRuntime`/`jpMaxRuntime`, `jpMinDateAdded`/`jpMaxDateAdded`, `jpResolution`, `jpTagAnyOf` on `/Items` | Library filters | No query hook in 12.x (CONFIRMED absence). Option: plugin route `JellyfinPlus/Items` that builds its own `InternalItemsQuery` + applies the extra clauses via `IDbContextFactory<JellyfinDbContext>` LINQ, returns DTOs via `IDtoService`. Client already sends these params; it would send them to the new route | **PARTIAL**: stock `/Items` loses the params (contract §9 says unknown params are ignored, so fail-soft holds); re-implementing access filtering = invariant-13 risk |
| 16 | `ListSortPatches.cs:105` | `Jellyfin.Server.Implementations.Item.OrderMapper.MapOrderByField` postfix | `jpListSeed` seeded random, `jpSortKey=DateLastSaved` | List sort | same route as #15 | PARTIAL (same) |
| 17 | `FilterCachePatches.cs:110/111/112` | `BaseItemRepository.GetQueryFiltersLegacy`, `.GetTagNames`, `.GetGenres` prefixes | Serve `/Items/Filters` from `JellyfinPlus_FilterKeys` | Filter key cache | Plugin route `JellyfinPlus/Filters` served from the cache; client calls it instead of `/Items/Filters` (it already calls `/JellyfinPlus/Search/Facets`) | **REPLACEABLE**: client-routed. Stock `/Items/Filters` reverts to stock speed for script-less clients (acceptable: fail-soft) |
| 18 | `FilterCachePatches.cs:144/145` | `Jellyfin.Api.Controllers.FilterController.GetQueryFiltersLegacy`/`GetQueryFilters` postfixes | Tag window `jpTagLimit`/`jpTagQuery`/`jpTagOrder`/`jpTagCounts` + `X-JellyfinPlus-*` headers | Filter pane | same plugin route | REPLACEABLE |
| 19 | `SimilarPatches.cs:132` | `Emby.Server.Implementations.Library.SimilarItems.SimilarItemsManager.GetSimilarItemsAsync` prefix | Tag+people ranking for Video | More Like This | `ISimilarItemsProvider` is an export collected by `AddParts` (CONFIRMED `ApplicationHost.cs:540`); priority/`CanHandle` shape ASSUMED | **REPLACEABLE** (provider). Reflection today: `_dbProvider`, `_libraryManager`, `FilterByLibraryAccessAsync` → re-implement access filter (invariant 13, prove) |
| 20–26 | `ScanTimingPatches.cs:141` ×7 | `Folder.ValidateChildrenInternal2`, `.GetNonCachedChildren`, `.ValidateSubFolders`, `.RefreshMetadataRecursive`, `LibraryManager.ResolvePath`, `.ValidateMediaLibraryInternal`, `VideoMetadataService.RefreshMetadata` | Scan phase timing | Diagnostics only | `ILibraryManager` events + `ITaskManager` task progress give coarse timing | **REPLACEABLE** (drop; coarse timing via events) |
| 27 | `FolderImageLinkPatches.cs:114` | `MediaBrowser.Providers.Manager.ImageSaver.SaveImageToLocation` prefix | Write guard: never write through a symlink | Folder covers (safety) | none for ImageSaver. If #28 goes, the guard is unnecessary (no links are made) | REPLACEABLE by dropping #28 |
| 28 | `FolderImageLinkPatches.cs:123` | `ImageSaver.SetImagePath` prefix | Link folder Primary to child image instead of copying | Folder covers (disk) | `IImageProvider`/`IDynamicImageProvider` for `Folder` with higher priority can *supply* the image but the saver still copies (ASSUMED) | **PARTIAL**: keep as scheduled task (`JellyfinPlusFolderImageLink` already exists, CONFIRMED) that links after the fact; lose on-save linking |
| 29 | `FilterCacheEngine.cs:173` (delegate, not patch) | `BaseItemRepository.TranslateQuery` bound by reflection | Build cache with stock access semantics | Filter key cache correctness | Own LINQ over `JellyfinDbContext`; digest-prove vs stock | PARTIAL (reflection, not Harmony; same risk class as #15) |

### 2.2 Out-of-plugin mechanisms

| # | Mechanism | What it does | Feature | Replacement seam | Verdict |
|---|---|---|---|---|---|
| M1 | `src/PatcherLoader.cs` → `AssemblyLoadContext.Default.LoadFromAssemblyPath("/usr/lib/jellyfin-plus/{0Harmony,Jellyfin.Plugin.Plus.Patcher}.dll")` | Harmony needs a non-collectible ALC; `PluginLoadContext` is `isCollectible: true` (CONFIRMED) | All patches | None while any patch remains. Reduce to one small "shim patch" assembly carrying only §5 patches | NEEDS-PATCH (shrinks) |
| M2 | `/usr/local/sbin/jellyfin-plus-activate` staged swap + restart | Atomic DLL swap outside Jellyfin's installer | Deploy | Jellyfin installer: manifest `versions[].sourceUrl` zip, MD5 `checksum`, `targetAbi <= ApplicationVersion` (CONFIRMED `InstallationManager`). Restart still required (Jellyfin's own rule) | **REPLACEABLE** for the plugin DLL; M1's residual assembly still needs a copy step |
| M3 | `/usr/local/sbin/jellyfin-plus-webinject` + `/etc/apt/apt.conf.d/99-jellyfin-plus` | Rewrites `/usr/share/jellyfin/web/index.html` (script tag + splash `<style>`), `config.json` (`themes[]`), writes `themes/jellyfinplus/theme.css`, copies `jellyfin-plus.js`, sha-based buster | Entire client, theme, splash | `IStartupFilter` middleware registered from `IPluginServiceRegistrator` that rewrites `/web/index.html` in memory (CONFIRMED pattern: JS-Injector `ScriptInjectionStartupFilter`, File Transformation `FileTransformationMiddleware`). Script served from a plugin controller route. Theme: `BrandingOptions.CustomCss` (CONFIRMED, CSS only) or served CSS + injected `<link>` | **REPLACEABLE** (requires Jellyfin to host `/web` itself, ASSUMED true on CT114) |
| M4 | Patched ffmpeg at `/usr/lib/jellyfin-ffmpeg-oidn/ffmpeg` + `shim/jellyfin-ffmpeg-upscale` on `JELLYFIN_FFMPEG_OPT=--ffmpeg=` | Routes per command to patched/stock binary; strips nodes the binary lacks | The five patched-filter levels | `EncodingOptions.EncoderAppPath` settable via `POST /System/Configuration/encoding` (CONFIRMED); `EncoderValidator` accepts any ffmpeg ≥ 4.4 (CONFIRMED, no jellyfin-ffmpeg check). `--ffmpeg=` CLI overrides it (CONFIRMED INSTALL.md:274) so the systemd line must be cleared | **PARTIAL**: binary still built out of band; naming it moves into the dashboard |
| M5 | `src/ShimBridge.cs` → `/etc/jellyfin-upscale.json` | Config mirror for the shim | Shim fallback | Goes with the shim decision (§3.3) | REPLACEABLE (drop if shim becomes plugin-driven) |
| M6 | `scripts/install-shaders.sh` → `/usr/share/jellyfin-shaders/`; cache `/var/cache/jellyfin/jellyfin-plus-shaders` | GLSL hooks for libplacebo | SR/sharpen levels | Ship shaders as embedded resources, extract to `BasePlugin.DataFolderPath` on first run; `ShaderDirectory` default → there | **REPLACEABLE** (licence check per shader before embedding) |
| M7 | Plugin tables in `jellyfin.db` (`JellyfinPlus_FilterKeys`, `_FilterKeysMeta`, `_FtsNames`, `_FtsTags`, `_FtsMeta`) via raw SQL | Filter cache, FTS5 | Search/filter speed | Plugins cannot add EF entities/migrations to `JellyfinDbContext` (`ApplyConfigurationsFromAssembly(core)` only, migration services `internal`, CONFIRMED). Raw SQL on the same file is the only route and is already invariant 16 | **REPLACEABLE** as-is (keep raw SQL; move DDL into plugin, versioned by `_FtsMeta`/`_FilterKeysMeta` rows) |

Counts: REPLACEABLE 19 (#9, 10, 12, 17, 18, 19, 20–26 ×7, 27, M2, M3, M5, M6, M7); PARTIAL 11 (#6, 7, 8, 11, 13, 14, 15, 16, 28, 29, M4); NEEDS-PATCH 6 (#1–5, M1).

## 3. Target architecture

### 3.1 Packaging

| Item | Target |
|---|---|
| Assembly | `Jellyfin.Plugin.Plus.dll` only, in `/var/lib/jellyfin/plugins/JellyfinPlus_<ver>/`; `meta.json` with `guid 6f2a9c31-4d7b-4e2a-9d15-8a1c0b7e3f44`, `targetAbi` = build target (`12.3.0.0`), `assemblies: ["Jellyfin.Plugin.Plus.dll"]` (whitelist, CONFIRMED `PluginManifest.assemblies`) |
| Manifest | `manifest.json` on GitHub Pages/raw: `PackageInfo{guid, name, versions[{version, targetAbi, sourceUrl, checksum(MD5), changelog, timestamp}]}` (CONFIRMED shape). One version entry per Jellyfin minor we build against, like File Transformation does |
| Residual patch assembly | `Jellyfin.Plugin.Plus.Patcher.dll` + `0Harmony.dll` in `/usr/lib/jellyfin-plus/`, optional. Plugin works without it (enhancement off, everything else on). Its own version pin: `PatcherHost.Apply` refuses a mismatched plugin version |
| Build | add `src/Jellyfin.Plugin.Plus.csproj` build.yaml for `jprm` (ASSUMED tool; standard for community plugins). `proxmox-build.sh` becomes "build zip + manifest", not "install" |

### 3.2 Web client delivery

| Step | Mechanism |
|---|---|
| Script bytes | `GET /JellyfinPlus/web/jellyfin-plus.js` from a plugin controller (`[AllowAnonymous]`; index.html is anonymous too). ETag = sha256 of the embedded resource = today's buster |
| Injection | `IStartupFilter` from `IPluginServiceRegistrator`: wrap `/web/index.html` response, insert `<script defer src="JellyfinPlus/web/jellyfin-plus.js?v=<sha>">` before the first `<script defer="defer">`, and the splash `<style id="jellyfinPlusSplash">` before `</head>` (same edits the injector makes today, CONFIRMED) |
| Theme | `themes[]` in `config.json` cannot be added without editing the file. Options: (a) inject `<link rel="stylesheet" href="JellyfinPlus/web/theme.css">` + the existing `html:not(.jp-theme-off)` off switch (CONFIRMED present); (b) `BrandingOptions.CustomCss` set via API, admin-visible and editable (weaker: one global CSS, no theme picker entry). Choose (a); lose the "Jellyfin Plus" entry in Display → Theme (PARTIAL) |
| Coexistence | If JS-Injector or File Transformation is installed, register through File Transformation's `PluginInterface.RegisterTransformation` (reflection, CONFIRMED API) instead of our own filter, to avoid double-wrapping. Detect by assembly name at startup |
| Fail-soft | Filter wraps in try/catch; on any error the original bytes pass through → stock web |

### 3.3 ffmpeg

| Option | Shape | 5-filter guarantee | Verdict |
|---|---|---|---|
| A. Named binary | Plugin config `FfmpegPath` (default `/usr/lib/jellyfin-ffmpeg-oidn/ffmpeg`); at startup the plugin probes `-filters`, and only if all five present sets `EncodingOptions.EncoderAppPath` via `IServerConfigurationManager.SaveConfiguration("encoding", …)` (ASSUMED API; the HTTP equivalent is CONFIRMED). `--ffmpeg=` must be removed from `/etc/default/jellyfin` (one-time, documented) | Probe at startup + on config save; status line "ffmpeg: 5/5" in `/JellyfinPlus/Status`; refuse to switch, keep stock, log | Preferred. Jellyfin probes the binary itself (`EncoderValidator`), but its whitelist never includes `vf_*` → `SupportsFilter` false for ours (CONFIRMED) — harmless, the engine already bypasses it |
| B. Wrapper on EncoderAppPath (today's shim, plugin-driven) | Plugin writes per-session intent to `BasePlugin.DataFolderPath/intent/<key>.json`; wrapper reads it and rewrites the command | Same probe | Only way to run the enhancement chain with **zero** Harmony. Loss: no session key in the command line (ASSUMED: output path is an MD5 of request fields, mapping is fragile), no live-apply swap, no `GetVideoEncoder` fix-ups. Keep as the documented "no-patch" degraded mode |
| C. Ship binary in plugin zip | ~hundreds of MB + OIDN/ORT/DLSS runtimes, licence mix | n/a | Rejected |

### 3.4 Config, DB, migrations

| Area | Target |
|---|---|
| Config | `PluginConfiguration` unchanged (214 lines, CONFIRMED). `UpscaleSettings` mirror stays only while the patcher assembly exists; JSON over the ALC boundary unchanged |
| Config page | `IHasWebPages` (`MediaBrowser.Model.Plugins`, CONFIRMED) already used; no change. (Another agent is editing `configPage.html` now; out of scope here) |
| Tables | Keep raw SQL `CREATE … IF NOT EXISTS` for the five `JellyfinPlus_*` tables; add a `SchemaVersion` key in `_FtsMeta`/`_FilterKeysMeta`; migrations = ordered SQL steps in the plugin, idempotent, run from the hosted services' `StartAsync` |
| DB access | Keep `IDbContextFactory<JellyfinDbContext>` (pooled, CONFIRMED) via DI, not `_dbProvider` reflection |
| Uninstall | `BasePlugin.OnUninstalling` drops the five tables and `DataFolderPath` (new; today nothing cleans up) |

## 4. Phased migration

Each phase ships alone, is verified on CT114 by the "prove the whole chain" standard, and leaves the previous mechanism as fallback until the next phase removes it. Ordered by risk (lowest first) then user value.

| Phase | Change | Removes | Verification on CT114 | Effort |
|---|---|---|---|---|
| 0 | `build.yaml`/csproj + `manifest.json` on GitHub; `proxmox-build.sh --package` emits zip + MD5 + manifest entry. Keep `activate` | nothing | Dashboard → Repositories → add URL → plugin listed with correct version; install into a scratch Jellyfin (CT clone) loads `Loaded plugin: Jellyfin Plus` with the same `optional:` line as today | 1–2 d |
| 1 | Shaders embedded, extracted to `DataFolderPath/shaders`; `ShaderDirectory` default moves | M6 | `journalctl -u jellyfin \| grep libplacebo` shows `custom_shader_path=/var/lib/jellyfin/plugins/configurations/…`; served segment 1920x1080 identical hash to pre-change for same source/level | 1 d |
| 2 | Web delivery via `IStartupFilter` + `/JellyfinPlus/web/*`; injector left in place but inert (its tag removed by the filter if both present) | — | Fetch `/web/index.html` through the API: one script tag, our `?v=` sha; panel opens during playback, wheel does not change volume, live apply restreams; `curl` the script route anonymous → 200 with ETag; stop plugin → stock index.html byte-identical to `index.html.jellyfin-plus-orig` | 2–3 d |
| 3 | Remove `webinject` + apt hook from the install; `--restore-conffile` run once to put stock `config.json`/`index.html` back; theme via injected `<link>` | M3 | `dpkg --verify jellyfin-web` clean; theme on/off switch still works; `apt install --reinstall jellyfin-web` leaves client working | 0.5 d |
| 4 | ffmpeg option A: `FfmpegPath` setting, 5-filter probe, set `EncoderAppPath` via config manager; clear `JELLYFIN_FFMPEG_OPT`; shim retained but not on the path | M4 routing, M5 | `/System/Configuration/encoding` shows our path; `JellyfinPlus/Status` says `ffmpeg: 5/5`; a session with `neural=…` (patched-only) produces segments; a session with a Vulkan denoise + patched filter no longer dies with exit 234 only because the guard still drops it (unchanged); rename the binary → status `ffmpeg: 0/5`, enhancement refuses, stock transcode still plays | 2 d |
| 5 | Filter cache + tag window on `/JellyfinPlus/Filters`; client re-pointed; drop #17/#18 | 5 patches | Digest: `/Items/Filters` stock vs `/JellyfinPlus/Filters` on the real-DB copy, identical sets per library/user incl. a restricted user (invariant 13); timing ≤ today | 2 d |
| 6 | Search as `ISearchProvider` (priority below SQL); drop #9/#10; deep paging via `/JellyfinPlus/Search` (#11/#12) | 4 patches | Digest on real DB: top-N for 50 recorded queries identical to today incl. tag matches, `excludeTags`, wildcards, for admin and a restricted user; `Server-Timing` ≤ today; `JELLYFINPLUS_NO_DEEP_PAGE` path removed | 4–5 d |
| 7 | More Like This as `ISimilarItemsProvider`; drop #19 | 1 | Digest on 200 Video items, identical lists for restricted user | 1 d |
| 8 | Library filters/sort via `/JellyfinPlus/Items` (#15/#16); client routes only when a `jp*`/`excludeTagNames`/`tagMatch` param is present, else stock `/Items` | 2 | Digest: for every recorded filter combination, result ids + order identical to patched `/Items`; stock `/Items` with the params → ignores them (contract) | 4 d |
| 9 | Folder covers: drop on-save link (#27/#28); keep scheduled task | 2 | Dry-run task reports same candidates as today; no symlink ever written through (guard test from ENHANCEMENTS §7.9 rerun) | 0.5 d |
| 10 | Drop scan timing (#20–26) and search stage timing (#13/#14); whole-request `Server-Timing` from middleware | 9 | Header present on `/Items?searchTerm=`; scan still completes | 0.5 d |
| 11 | Live apply: `ITranscodeManager` DI wrapper for kill deferral; drop `SwapPatches` if segment-readiness polling proves equal | 2 | Live apply on a direct-playing and a transcoding session: no black gap > today's; orphan ffmpeg count 0 after 60 s (`SweepExpiredSwaps` still runs) | 3 d, may stay PARTIAL |
| 12 | Direct-play override: drop #6, document "clients without the script are not forced" | 1 | Script client: enhanced; `curl` PlaybackInfo without the flags → direct play (expected) | 0.5 d |
| 13 | Shrink patcher assembly to #1–5 only; its own version check; `activate` reduced to copying two DLLs; upstream PR drafted | — | `optional:` line lists nothing; status `active (5 EncodingHelper methods patched)`; plugin loads and all QoL works with the patcher directory removed | 1 d + PR |

Total ≈ 25–30 working days, serial. Phases 5–8 are the digest-heavy ones and can run as parallel agent worktrees (shared brief, disjoint files) per CLAUDE.md.

## 5. What cannot become plugin-only today

| Item | Why no seam | Keep minimal patch | Upstream PR | Drop |
|---|---|---|---|---|
| Transcode filter chain (#1–5) | `EncodingHelper` concrete, non-virtual, no argument-provider interface (CONFIRMED) | **Yes** — the five postfixes, one assembly, nothing else | Yes: "make `EncodingHelper` filter/hwaccel/encoder getters virtual" or `IEncodingArgumentsProvider` export consumed by `EncodingHelper`. Small diff, plausible for 12.x | Only via option B wrapper (degraded) |
| Non-collectible ALC (M1) | Harmony cannot detour from `PluginLoadContext(isCollectible: true)` (CONFIRMED) | Follows #1–5 | Same PR removes the need | — |
| Live-apply overlap (#7/#8) | `StartFfMpeg` private | Optional patch, separate `Available` flag (already) | Low priority | Acceptable: fallback is restart-at-position |
| `/Items` query extensions on the stock route (#15/#16) | No `InternalItemsQuery` → SQL hook | No: plugin route instead | "IItemQueryExtension" is a large ask | Stock route loses them; contract tolerates |
| On-save folder-image linking (#28) | `ImageSaver` not extensible | No | No | Yes; task-based linking remains |
| Stage-level timings (#13/#14/#20–26) | Internal methods | No | No | Yes |

## 6. Risks, open questions, effort

| Risk | Mitigation |
|---|---|
| Re-implementing `ApplyUserAccessFilter`/`FilterByLibraryAccessAsync` in our provider widens access (inv. 13) | Digest against a restricted user on the real DB copy before every merge; refuse to ship phases 5–8 without it |
| `IStartupFilter` from a plugin runs outermost; buffering `index.html` breaks `ETag`/`Content-Length` | Follow JS-Injector's handling (drop ETag, reset length); test with reverse proxy + gzip |
| Jellyfin not hosting `/web` (external web host) | Detect 404 on `/web/index.html` at startup; status "web injection unavailable" |
| `EncoderAppPath` overridden by `--ffmpeg=` CLI | Phase 4 checks `EncoderAppPathDisplay` after save; refuse and explain |
| `ISearchProvider` fallback semantics unknown (ASSUMED) | Phase 6 spike first: register a no-op provider, log what `SearchManager` does with its result |
| `ISimilarItemsProvider` shape ASSUMED | Decompile before phase 7 |
| Patcher/plugin version drift once installer updates the plugin | Version handshake in `PatcherHost.Apply`; mismatch = patcher off, plugin on |
| Two web injectors (ours + JS-Injector) | Assembly-name detection, defer to File Transformation when present |
| Install docs rot (INSTALL.md already disagrees with `install-shaders.sh` and `MaxConcurrent` default, CONFIRMED) | Phase 0 rewrites INSTALL.md to "add repository, install, set ffmpeg path" |

Open questions for the user:

1. Keep option B (plugin-driven wrapper) as a supported degraded mode, or document "no patcher = no enhancement"?
2. Theme picker entry vs. injected `<link>`: is losing the Display → Theme row acceptable?
3. Is removing direct-play enforcement for script-less clients (#6) acceptable, or keep it as an optional patch?
4. Draft the upstream PR now (unblocks everything in §5 row 1 in a future 12.x) or after phase 13?
