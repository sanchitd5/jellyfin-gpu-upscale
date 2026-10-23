# Mobile redesign: UI and theme

A plan, not an implementation. Target: jellyfin-web **12.3** as served by the plugin's injector, on
phones (`html.layout-mobile`). The TV layout is untouched throughout (AGENTS.md invariants), every
change fails soft to stock, and nothing here widens access.

Evidence conventions: `jfweb/...` is the jellyfin-web 12.3 source checkout; `jfwebdist123/...` the
built 12.3 client; `web/src/...` this repo. "In the 12.3 build" means the selector was found by grep
in `jfwebdist123` (count in brackets). Line numbers are from the 12.3 tag.

Contents: 1 audit · 2 theme direction and delivery · 3 proposals · 4 wireframes · 5 phases ·
6 open questions.

---

## 1. Audit: the phone experience today (stock 12.3 + the plugin)

### 1.0 What "mobile" is, mechanically

| Fact | Source |
|---|---|
| `html.layout-mobile` is set by `layoutManager.setLayout` from `browser.mobile` (user-agent), unless the viewer forced a layout in Display settings (`auto`/`desktop`/`mobile`/`mobile-legacy`/`tv`). iPads report as desktop Safari and are patched back to mobile. | `jfweb/src/components/layoutManager.js:43`, `jfweb/src/scripts/browser.js:273-281`, `jfweb/src/constants/layoutMode.ts` |
| The `mobile` layout runs the **modern** React app for `home`, `movies`, `tv`, `music`, `homevideos`, `mixed`, `boxsets`, `playlists`, `livetv`, `mypreferencesdisplay`; **legacy** controllers for `details`, `list`, `video`, `queue`, `lyrics` and the other preference pages; `search` is a React page under the legacy app. `mobile-legacy` runs everything legacy. | `jfweb/src/apps/modern/routes/asyncRoutes/user.ts`, `.../legacyRoutes/user.ts`, `jfweb/src/apps/legacy/routes/legacyRoutes/user.ts` |
| Root font size is 93% (fonts.scss:7) and **90% again** under `.layout-mobile` (fonts.scss:49): body text lands at about 13.4 px on a 16 px device default. | `jfweb/src/styles/fonts.scss` |
| `user-select: none` and `-webkit-touch-callout: none` on the whole mobile layout. | `jfweb/src/styles/site.scss:82-86` |
| Viewport: `width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover`. Pinch zoom is off everywhere, including on text pages. | `jfwebdist123/index.html` |
| **No `prefers-reduced-motion` handling anywhere in stock** (grep of `jfweb/src`: zero hits). The only one in the served page is the plugin's search sheet. | `web/src/view/search-filter-sheet.js:83` |
| Safe areas: page bottom padding `calc(env(safe-area-inset-bottom) + 5em)`; the footer and the video OSD pad left/right/bottom. Nothing pads the top of `.skinHeader`. | `jfweb/src/styles/site.scss:122-126`, `components/appfooter/appfooter.scss:9-11`, `styles/videoosd.scss:4-34` |
| Theme = one per-user setting (`theme`, plus `dashboardTheme`) applied on every device the user signs in on. The chosen id becomes `html[data-theme=<id>]` plus a `<link href="themes/<id>/theme.css">`; MUI reads its colour scheme from the same attribute. | `jfweb/src/scripts/themeManager.js:30-54`, `components/ThemeCss.tsx:10-31`, `themes/index.ts` (`colorSchemeSelector: '[data-theme="%s"]'`) |

### 1.1 Home (modern route, legacy sections inside)

`apps/modern/routes/home.tsx` mounts the legacy `homesections` and the legacy `maintabsmanager`
tabs (Home / Favorites) inside the modern shell: MUI dense `AppToolbar` (hamburger, back, buttons,
user menu; wraps to two lines on `xs`, `AppToolbar.tsx:50-53`) and a temporary drawer below the
`md` breakpoint (900 px, `apps/modern/AppLayout.tsx:26-27`).

Problems:

- **Navigation depth and reach.** Libraries, Favorites and settings are behind the hamburger at the
  top-left, the hardest point to reach one-handed; Search is a top-right icon (`.headerSearchButton`,
  in the 12.3 build [1]). There is no persistent bottom navigation (`.MuiBottomNavigation-root`: 0
  hits in the build).
- **Two scroll axes.** Every section is a horizontal `emby-scroller` [128] inside a vertical page.
  Horizontal rows on a phone show 2-3 posters and need a swipe per row.
- **Swipe between tabs is off** on the modern app (`maintabsmanager.js:50`: returns when
  `layoutManager.modern`), so Home / Favorites is tap-only on a tab strip sized for mouse.
- **No loading state.** Sections render empty and fill as requests return; the page jumps.
- Plugin additions here: card badges (`view/card-badges.js`), the phone card button row
  (`view/card-actions.js`), image look-ahead. They work, but the badge row plus the button row add
  about 2.5 em under each poster, so a 2-column row costs most of a screen.

### 1.2 Library tabs (modern `LibraryPage`)

`LibraryPage.tsx:50` renders `mainAnimatedPage libraryPage pageWithAbsoluteTabs withTabs`; tabs are
the legacy `emby-tabs` strip in the header [29 in build], and sort / filter / view-mode live in the
MUI `LibraryToolbar` inside the app bar (`AppLayout.tsx:52`).

Problems:

- **Filter UI is inconsistent with search.** The library filter is a MUI Popover; the plugin
  already has to force it to `min(94vw, 440px)` wide and `max-height: 75%`
  (`web/src/view/library-filter-panel.js:75-76`), while Search uses a real bottom sheet
  (`view/search-filter-sheet.js`). Two different gestures for the same job.
- **Grid density is fixed** by em breakpoints (`components/cardbuilder/card.scss:539-660`) and
  `getPostersPerRow` (`cardBuilder.js:71`); the viewer cannot choose 2 or 3 columns.
- **Paging, not scrolling.** Library pages use `libraryPageSize` (default 100) and a pager; the
  plugin gives Search infinite scroll on phones (`controller/search-pager.js:72`) but not the
  libraries (QOL_IDEAS #12, unshipped).
- **Selection mode is a 550 ms long-press** (`components/multiSelect/multiSelect.js:473, 520`),
  undiscoverable and in conflict with scroll-start; the command bar is `position: fixed; top: 0`
  (`multiSelect.scss:13-15`), over the app bar. The plugin enlarges its buttons to 44 px
  (`card-actions.js:74-75`) and adds the "Select all N" banner (`controller/select-all.js:42`).
- Hover-only affordances: the card hover menu is desktop-only (`cardBuilder.js:984`,
  `Card/useCard.ts:91 card-hoverable`); stock mobile cards get only a play button
  (`cardBuilder.js:828-847`). The plugin's button row is the fix, but it is a bolt-on under the
  card rather than part of the card.

### 1.3 List and tag pages (legacy `list`)

`apps/legacy/controllers/list.js` under the legacy `.skinHeader` [33] with `.headerTabs` [10].
Plugin: Random / Recently edited sorts (`controller/list-sort.js`), the tag-window chips, person
videos.

Problems: pager at the foot; sort is an `actionSheet` [42] anchored to a 24 px icon; the legacy
filter is a full dialog; the alphabet picker takes a column of width on narrow screens; header
buttons are `paper-icon-button-light` (mouse-sized).

### 1.4 Search (React page in the legacy app)

Plugin owns most of this page: 2-column grid under 50 em (`view/search-grid.js:80`), infinite on
phones, the Sort & filter bottom sheet (`search-filter-sheet.js:71-91`: fixed backdrop, 92 dvh,
`safe-area-inset-bottom`, reduced-motion aware), recent searches, the exclude box (blurs the
keyboard on phones, `search-exclude.js:251`).

Problems: two text fields (term + exclude) and the chip row sit above the results and scroll away
with them, so after a few pages the viewer has no way back to the query without scrolling up; the
plugin's button row under each card shrinks the visible result count; the sheet is the right
pattern but exists only here.

### 1.5 Item details (legacy `details`)

Mobile branches: a header backdrop is rendered (`itemDetails/index.js:566-568`); the modern shell
pulls it up under the app bar with a gradient (`apps/modern/AppOverrides.scss:26-45`); name, misc
info and the button row are centred (`styles/librarybrowser.scss:702-730`); the detail ribbon
becomes a static block (`:758`); the header is opaque on mobile
(`libraryMenu.setTransparentMenu(!layoutManager.mobile)`, `:2127`). Several affordances are
suppressed on mobile (`:1444-1449`). Plugin: previous / next (`controller/detail-nav.js`),
Download, More Like This, tag and person chips (`detail-related.js:381`, 2.5 em chips).

Problems:

- **Play is not the primary action visually.** `.mainDetailButtons` [24] is a row of equal round
  icon buttons; Play, Shuffle, Favourite, Played, More look alike.
- Track selections (`.trackSelections` selects, `librarybrowser.scss:1447`) are dense native
  selects; tech details are a long table.
- Nothing sticks: once the viewer scrolls into More Like This there is no Play without scrolling
  back.
- Loading: poster, backdrop and sections arrive at different times with layout shift.

### 1.6 Video player and OSD (legacy `video`)

Stock: `styles/videoosd.scss` hides poster and info under 30 em, volume buttons under 43 em,
rewind / fast-forward under 50 em (`:202-227`); no `.layout-mobile` rule at all (grep). A tap on
the surface toggles the OSD (`playback/video/index.js:387, 1801` resolve pointer type from
`layoutManager.mobile`). The controller tries `screen.orientation.lock` on fullscreen
(`onOrientationChangeSuccess` / `onOrientationChangeError`). OSD bottom bar `.videoOsdBottom` [12]
carries the `emby-slider` seek bar [`.mdl-slider` 138].

Plugin: gestures (hold 2x, swipe volume on the right half and brightness on the left, double-tap
seek; `controller/player-gestures.js`, `model/player-gesture.js`), the HUD overlays
(`view/player-hud.js:27-55`, fixed, safe-area aware), the OSD chip (`controller/player-badge.js:43-45`,
fixed at `top: 3.75em + inset`, `left: 1em + inset`), the speed menu, Clip Up Next, and the
**Enhance** entry in the player settings `actionSheet` (`controller/action-sheet.js:42`).

Problems:

- **Portrait is a strip.** A 16:9 video on a portrait phone occupies the top third; the OSD bottom
  bar sits at the screen bottom, far from the picture, and the dead black area has no use.
- **Gesture crowding.** Stock tap-to-toggle, the plugin's hold / double-tap / swipe zones, the OS
  edge-swipe for back, and the seek bar's thin hit area all share one surface. The arbiter handles
  the plugin's own four; the OS edge and the stock seek bar are not in its model.
- **The chip collides with the OSD header** when both are visible (chip at 3.75 em from the top,
  `.osdHeader` [4] in the same band).
- **Mouse-sized controls**: `paper-icon-button-light` buttons and a thin slider thumb; the
  `volumeButtons` are hidden on phones but the volume *slider* logic remains.
- **Landscape**: the OSD takes a full-width bar with the title at the top-left under the notch
  area; `videoosd.scss` pads left/right insets, the plugin HUD does too, the chip does.

### 1.7 Enhance panel

`view/panel-dom.js:39-40`: `position: fixed; right: 1.2em; bottom: 5.5em; width: 44em;
max-width: calc(100vw - 2.4em); max-height: 72vh; overflow-y: auto`, a draggable header
(`touch-action: none`), one-column grid under 640 px (`:74`). Opened from the settings action
sheet; the sheet is "entry point only" (`action-sheet.js:12`).

Problems: it is a desktop floating window. On a phone it covers the OSD and most of the picture,
drag has no purpose, its disclosure sections (`jellyfinPlusOpen`) need precise taps, and the Quality
ladder, Advanced axes and the Live block stack into a 72 vh scroll. The entry needs
`settings icon -> sheet -> Enhance` (three taps) with the OSD timing out underneath.

### 1.8 Selection mode and bulk tags

Entry by long-press only (1.2). The command bar `.selectionCommandsPanel` [78] is a top strip with
`btnSelectionPanelOptions` [17] opening an action sheet; the plugin adds Select all and the bulk-tag
dialog (`controller/bulk-tags.js`, a stock `dialogHelper` dialog, `:415` checks it is `fixed`) with
autocomplete chips (`tag-autocomplete.js:60`). Problems: no visible way in; checkboxes only appear
once active; a text-input dialog on a phone puts the Save button under the keyboard (needs a device
check); exiting selection mode is a small X at the top-left.

### 1.9 Settings

`mypreferencesmenu` (legacy) lists six pages; Display is modern (`DisplayPreferences.tsx`, theme and
layout selects), the rest legacy forms with native selects and `checkboxContainer` rows.
`AppOverrides.scss:9-15` hides the drawer-duplicated sections. Problems: one theme setting per
user for every device (1.0), so a phone-tuned theme chosen here would also apply on that user's
desktop; dense forms; no search.

---

## 2. Theme direction and how it ships

### 2.1 Tokens

All tokens are CSS custom properties with a `--jp-` prefix, defined once on `html.layout-mobile`
and mapped onto the stock `--jf-palette-*` and `--jf-card-borderRadius` variables that the stock
SCSS already reads (`jfweb/src/themes/_base/_theme.scss:57-62, 69-140`, compiled into every
`themes/<id>/theme.css`). Overriding those variables restyles legacy pages and MUI components alike
without touching a stock selector.

**Colour** (two schemes; ratios computed with the WCAG 2.x formula, script kept in the task
scratchpad):

| Token | Dark | Light | Role |
|---|---|---|---|
| `--jp-bg` | `#0f1115` | `#f7f8fa` | page |
| `--jp-surface` | `#181b21` | `#ffffff` | cards, sheets, app bar |
| `--jp-surface-2` | `#22262e` | `#eef0f4` | chips, inputs, pressed |
| `--jp-text` | `#f2f4f7` | `#15181e` | primary text |
| `--jp-text-2` | `#aab2bf` | `#4b5563` | secondary text |
| `--jp-accent` | `#5ccfff` | `#0369a1` | links, active tab, focus ring, primary button |
| `--jp-on-accent` | `#0b1a22` | `#ffffff` | text on accent |
| `--jp-error` | `#ff6b6b` | `#b42318` | destructive |
| `--jp-stroke` | `#3a404b` | `#c9ced6` | hairlines (decorative, not a contrast carrier) |
| `--jp-scrim` | `rgba(0,0,0,.6)` | `rgba(0,0,0,.35)` | sheet backdrop, poster title gradient |

Contrast (WCAG AA needs 4.5:1 text, 3:1 large text and UI):

| Pair | Dark | Light |
|---|---|---|
| text / bg | 17.2 | 16.7 |
| text / surface-2 | 13.8 | 14.6 |
| text-2 / surface | 8.1 | 7.6 |
| accent / surface | 9.7 | 5.9 |
| on-accent / accent | 10.0 | 5.9 |
| error / bg | 6.8 | 6.2 |

Every text pair clears AA; the dark scheme clears AAA. For comparison, stock `#00a4dc` on white is
2.9:1 (fails as text in the stock Light theme) and 6.7:1 on `#101010`. The accent stays in the
Jellyfin blue family on purpose; whether to keep the brand purple-blue gradient anywhere is open
question 1. Mapping: `--jf-palette-background-default` <- `--jp-bg`, `-paper` <- `--jp-surface`,
`-text-primary/secondary` <- `--jp-text/-2`, `-primary-main`/`-secondary-main` <- `--jp-accent`,
`-primary-contrastText` <- `--jp-on-accent`, `-error-main` <- `--jp-error`, `-divider` <-
`--jp-stroke`, `-AppBar-defaultBg` <- `--jp-surface`, `-AppBar-transparentBg` <- `--jp-scrim`,
`-action-hover/-focus` <- accent at 12% / 24%.

**Type scale** (px at the device default; counteracts the 93% x 90% stock shrink by setting
`font-size: 100%` on `html.layout-mobile` and sizing explicitly):

| Token | Size / line | Use |
|---|---|---|
| `--jp-fs-xs` | 12 / 16 | badges, chip counts |
| `--jp-fs-sm` | 13 / 18 | card titles (2-line clamp), meta |
| `--jp-fs-md` | 15 / 22 | body, list rows, sheet items |
| `--jp-fs-lg` | 17 / 24 | section titles, tab labels |
| `--jp-fs-xl` | 22 / 28 | item name |
| `--jp-fs-2xl` | 28 / 34 | page title (rare) |

Font family stays `Noto Sans` (stock MUI `typography.fontFamily`, `_base/theme.ts:38`) with the
system stack as fallback; no web font is added.

**Spacing**: a 4 px grid, tokens `--jp-sp-1..8` = 4, 8, 12, 16, 20, 24, 32, 40. Page gutter 16 px;
card gap 8 px (12 at 3 columns); tap target minimum **44 x 44 px** (`--jp-tap`), applied to every
`paper-icon-button-light`, `emby-tab-button`, `cardOverlayButton`, chip and sheet row under the
mobile layout.

**Radii**: `--jp-r-sm` 6 (chips, inputs), `--jp-r-md` 10 (cards; also written to
`--jf-card-borderRadius`), `--jp-r-lg` 16 (sheets' top corners, dialogs), `--jp-r-pill` 999.

**Elevation**: dark uses surface tiers, not shadows (bg < surface < surface-2); sheets and the
bottom bar get one shadow `0 -8px 24px rgba(0,0,0,.35)`; light uses `0 1px 3px rgba(0,0,0,.12)`
on cards and the same sheet shadow at .2.

**Motion**: `--jp-t-fast` 120 ms (press, toggle), `--jp-t-base` 200 ms (sheet, tab), `--jp-t-slow`
320 ms (page), easing `cubic-bezier(.2,.8,.2,1)`; sheets translate from the bottom, never scale.
`@media (prefers-reduced-motion: reduce)` sets all three to 0 ms and removes transforms and the
skeleton shimmer, in the same injected block (the pattern already in `search-filter-sheet.js:83`).

**Cards and posters**: posters stay 2:3, thumbs 16:9, `object-fit: cover`, radius `--jp-r-md`, a
bottom scrim (`--jp-scrim` to transparent over the lower 45%) carrying the title *inside* the image
on poster cards, with the stock `.cardText` footer hidden on phones to recover the two text lines;
the plugin's badges move to the top-left of the image, its button row becomes two 44 px icons in the
bottom-right of the image (favourite, more) with Play as the whole-card tap. Progress bars become a
3 px accent line on the image's bottom edge. Person cards round (`$rounded-person-cards` exists in
`_theme.scss:6` but is per theme; set `border-radius: 50%` on `.personCard .cardImageContainer`).

### 2.2 Delivery mechanisms, weighed

| Mechanism | How | Survives a jellyfin-web upgrade? | TV untouched? | Fails soft? | Verdict |
|---|---|---|---|---|---|
| **A. Script-injected CSS**, one `<style id="jellyfinPlusMobileThemeStyle">` from a new `web/src/view/mobile-theme.js`, every rule scoped `html.layout-mobile` | Same path as the 17 `jellyfinPlus*Style` blocks already shipped | Yes: the injector re-applies the script after every package operation (apt hook), the buster is content-hashed, and the 12.1 -> 12.3 port touched only JS seams (`8164828`: 5 client files), not the `--jf-palette-*` variables or the layout classes | Yes by construction (`.layout-tv` is a different class) | Yes: one `feature()` try/catch; the off switch removes the style node; script missing = stock | **Primary carrier** |
| **B. A jellyfin-web theme** (`config.json` `themes[]` entry + `themes/jellyfinplus/theme.css` written by the injector) | Selectable in Display settings; sets `html[data-theme=jellyfinplus]` | Partly: both files are package-owned and are replaced on upgrade, so the injector must write them too (a second surface to keep idempotent). The `themes/<id>/theme.css` link and `data-theme` contract have held since 10.9 | Yes if the file scopes anything structural under `.layout-mobile`; colours would apply on TV too, which is a *theme choice* the viewer made, not a layout change | Weak: base rules are compiled *into* each theme.css (`themes/dark/theme.css` carries `.skinHeader`), so a 404 leaves legacy pages unthemed until the viewer picks another theme; MUI vars for an unknown id fall back to the default scheme | Optional later phase for **desktop parity** of the colour tokens; never the carrier for layout |
| **C. Dashboard branding Custom CSS** (`BrandingOptions.CustomCss`, rendered by `components/CustomCss.tsx` with a per-user disable) | Admin pastes CSS | Yes (stored in the server DB) | Only if scoped by hand | Partly: it renders after the branding fetch (a flash of stock), it is an un-versioned textbox outside the repo, applies to every user and the desktop, and the injector cannot own it | Rejected as a carrier; documented as the admin's **escape hatch** for one-off overrides |
| **D. Patching `index.html` beyond the script tag** (viewport meta) | Injector edit | Yes (injector) | n/a | n/a | Only if open question 5 says yes |

**Recommendation: A, with B as a later optional add-on.** A is the only mechanism the repo already
re-applies, hashes, tests and can switch off per viewer; it is layout-scoped, so the same user keeps
stock on their desktop (1.9 makes this decisive: the theme setting is per user, not per device).
B adds nothing a phone needs and adds a second package-owned surface to the injector; it earns its
place only if the user wants the same colours on desktop (open question 2).

Order and size matter in A: the token block must be the **first** style the script installs (before
`card-actions`, `player-hud` and the sheets read tokens) and must stay under ~12 KB minified so the
bundle's load-to-hook window is unchanged. Install it from `bootstrap.js` as `feature('mobileTheme',
installMobileTheme)` immediately after `storage-migrate`.

### 2.3 Off switch

- `localStorage` `jellyfinPlus.mobileTheme` = `off` returns the viewer to stock (read at load, the
  `jellyfinPlus.cardBadges` pattern, `controller/card-data.js:36`). A "Stock look" row in the More
  sheet (3.3) writes it and reloads; it is never synced to the server, since it is a per-device
  choice.
- `jellyfinPlus.mobileTheme` = `light` picks the light scheme regardless of the stock theme;
  absent = follow `data-theme` (`light` -> light, anything else -> dark).
- A plugin setting is **not** proposed for phase 1 (it would touch the 5-place config checklist
  for no viewer benefit); phase 3 may add `MobileThemeDefault` to the probe if an admin wants to
  default everyone to stock.

---

## 3. Proposals, prioritised

Effort S < 1 day, M 1-3 days, L > 3 days of one agent. Risk is to stock behaviour, not to the
feature. Every proposal is phone-verified on the real server with the stock Dark theme and then
with the viewer's own theme.

### P1. Tokens, touch targets, reduced motion (Phase 1)

- **Problem**: 1.0 (13.4 px text, no reduced motion), mouse-sized controls everywhere (1.3, 1.6).
- **Change**: `view/mobile-theme.js` installs the tokens (2.1), the `--jf-palette-*` mapping,
  `min-width/min-height: var(--jp-tap)` on `paper-icon-button-light`, `.emby-tab-button`,
  `.cardOverlayButton`, `.btnSelectionPanelOptions`, `.btnCloseSelectionPanel`, `.detailButton`,
  `.listItem` rows, and chip classes the plugin owns; the reduced-motion block; `font-size: 100%`.
- **Seam**: `--jf-palette-*` custom properties (present in every `themes/*/theme.css` in the 12.3
  build) and the class names above (all in the build: `.emby-tab-button` [59], `.detailButton` [9],
  `.listItem` [64]).
- **Effort** S. **Risk** low: pure CSS, additive, one node to remove.
- **Verify**: on the phone, Settings > Display shows Dark; open Home, Library, Search, Details,
  Player; measure a tab button and a card button with the DevTools device toolbar (>= 44 px); toggle
  "Reduce motion" in the OS and confirm the search sheet and panel appear without animation; set
  `jellyfinPlus.mobileTheme=off`, reload, confirm pixel-identical stock.

### P2. Enhance panel as a bottom sheet on phones (Phase 1)

- **Problem**: 1.7.
- **Change**: extract the sheet shell from `search-filter-sheet.js` into `view/sheet.js`
  (`openSheet({title, body, actions})`: backdrop, drag-handle, 92 dvh cap, safe-area padding,
  focus trap, Escape / backdrop / swipe-down close, reduced motion). `panel-dom.js` renders the
  same panel body into a sheet when `html.layout-mobile`; the drag header and `pos` are skipped;
  sections become full-width rows with 44 px option pills; the Live block pins to the sheet
  footer. Desktop rendering is unchanged.
- **Seam**: the panel is entirely plugin DOM; the only stock seam is the existing settings
  `actionSheet` entry (`controller/action-sheet.js:42`, `.actionSheet` [42] in the build).
- **Effort** M. **Risk** low-medium: `panel-dom.js` is shared with the desktop path; keep one render
  function with a `sheet` flag rather than two.
- **Verify**: start playback, settings > Enhance; the sheet rises from the bottom and the OSD stays
  interactive above it; pick a level and watch `journalctl -u jellyfin | grep libplacebo` change;
  rotate to landscape (sheet caps at 92 dvh, scrolls); swipe down closes; the panel on desktop is
  unchanged.

### P3. Bottom navigation bar (Phase 2)

- **Problem**: 1.1 (reach, depth, no persistent navigation).
- **Change**: a 5-slot bar on phones, hidden on the video page and while a sheet is open:
  **Home** (`#/home`), **Libraries** (a sheet listing `/UserViews`, already fetched by
  `controller/library-landing.js`), **Search** (`#/search`), **Now playing** (shows only while
  `nowPlayingBar` is visible; otherwise **Favourites** `#/home?tab=1`), **More** (a sheet: Settings
  pages, Stock look, Select mode entry, admin dashboard if the user is an admin by the stock menu's
  own presence). Navigation is by plain `<a href="#/...">` links, so the stock router handles them;
  nothing calls a global. The stock header keeps its buttons; the hamburger is left in place
  (removing it would hide the admin and user sections that `AppOverrides.scss:9-15` already
  depends on). Page bottom padding is raised by the bar height (stock already reserves 5 em +
  inset for the music bar; the bar stacks above `.nowPlayingBar` [8]).
- **Seam**: `document.body` for the bar; `.nowPlayingBar` visibility by class (`hide`); route by
  `location.hash`. All present in the build.
- **Effort** L. **Risk** medium: a fixed bar must not cover the stock `appfooter` [3] (volume /
  now-playing) and must disappear on `video-osd` pages (`.videoOsdPage` route type `video-osd`,
  `legacyRoutes/user.ts`).
- **Verify**: every tab reaches its page with one tap on a 6" phone held in one hand; play audio
  (now-playing bar) and video (bar hidden); back gesture returns to the previous tab; deep link
  `#/details?id=` still works; with `jellyfinPlus.mobileTheme=off` no bar.

### P4. Touch OSD and portrait player (Phase 1 for the chip and sizes, Phase 2 for layout)

- **Problem**: 1.6.
- **Change**: (a) chip moves to the bottom-left *above* `.videoOsdBottom` and hides while the OSD
  is hidden unless its state is `degraded`; (b) `.videoOsdBottom` buttons 44 px, seek thumb 20 px
  with a 44 px hit area, times at `--jp-fs-sm`; (c) portrait: the bottom bar is pulled up to sit
  under the picture (`top: calc(56.25vw + env(safe-area-inset-top))` when the video element's
  aspect is wider than the viewport), with the dead area carrying title, Up Next and the Enhance
  shortcut; (d) a lock button that disables the plugin's gestures and stock tap-to-toggle for
  pocketing; (e) the gesture arbiter gains a dead zone of 24 px on both horizontal edges so the OS
  back-swipe never starts a brightness swipe.
- **Seam**: `.videoOsdBottom` [12], `.osdHeader` [4], `.emby-slider` / `.mdl-slider` [138], the
  plugin's own `player-badge.js`, `player-hud.js`, `model/player-gesture.js` (`zoneOf`).
- **Effort** S (a, b, e) + M (c, d). **Risk** low for a/b/e; medium for c (the OSD controller
  measures nothing about layout, so a moved bar must still receive its `videoOsdBottom-hidden`
  transitions).
- **Verify**: portrait and landscape on a notched phone; the seek thumb is draggable with a thumb;
  hold / double-tap / swipe still work and `journalctl` shows no stream re-negotiation from an
  accidental Enhance change; the chip never overlaps the title; edge swipe goes back without
  changing brightness.

### P5. Library filter as the same bottom sheet as Search (Phase 2)

- **Problem**: 1.2 (two filter UIs).
- **Change**: on phones, `library-filter-panel.js` renders its tag / exclude / match-all section
  and the stock filter groups into `view/sheet.js` instead of forcing the Popover's size; the
  Popover remains on desktop.
- **Seam**: the MUI Popover the plugin already finds by shape (`.MuiPopover-paper`, present in the
  build), the stock filter button in `LibraryToolbar`.
- **Effort** M. **Risk** medium: the stock Popover owns the filter state; the sheet must mirror
  into the same DOM controls (or reuse them by moving nodes), not keep a second state.
- **Verify**: set a tag filter from the sheet, see the request carry `tags=`; reset from the stock
  reset button clears the plugin's marker entries; desktop unchanged.

### P6. Library grid density and card treatment (Phase 2)

- **Problem**: 1.1, 1.2 (fixed density, bolt-on button row).
- **Change**: a 2 / 3 / list choice stored in `jellyfinPlus.gridColumns` (per device); CSS sets
  `.itemsContainer` [150] to a grid under `html.layout-mobile` and the card treatment from 2.1
  (title in-image, badges top-left, two icons bottom-right). `card-actions.js` renders into the
  image container instead of under the card.
- **Seam**: `.itemsContainer`, `.cardImageContainer` [10], `.cardText` [2], the plugin's own row.
- **Effort** M. **Risk** medium: `cardBuilder`'s `getPostersPerRow` still decides image resolution
  requests by width; 3 columns must not trigger a larger image than 2 did (check `maxWidth` in the
  image URL).
- **Verify**: count visible cards per screen at 2 and 3 columns; tap a card plays / opens as before;
  the favourite icon toggles and the stock `data-action` handler runs; TV unchanged.

### P7. Item page: primary Play and a sticky action bar (Phase 2)

- **Problem**: 1.5.
- **Change**: `.mainDetailButtons` becomes a full-width primary Play (accent, label) with the rest
  as 44 px icons in a row; when the row scrolls out, a compact sticky bar (title + Play + More)
  docks under the app bar; track selections render as rows inside a sheet; the technical table
  collapses behind a disclosure.
- **Seam**: `.mainDetailButtons` [24], `.detailRibbon` [8], `.trackSelections`, the plugin's
  `detail-nav.js` (previous / next into the sticky bar).
- **Effort** M. **Risk** low-medium: the buttons are re-styled, not re-created, so every stock
  handler stays.
- **Verify**: Play from the sticky bar starts playback at the resume position; the download button
  still appears for videos; previous / next still follow the list the item was opened from.

### P8. Selection mode you can see (Phase 3)

- **Problem**: 1.8.
- **Change**: a "Select" entry (More sheet and the library toolbar) enters multi-select by
  dispatching the stock long-press path on the first tapped card (the stock `onTouchStartTimerFired`
  is the only entry; the plugin triggers it by firing the same timer callback through a synthetic
  `touchstart`/wait/`touchend` on the card). The command bar moves to the bottom as a sheet
  header; the bulk-tag dialog becomes a sheet whose Save button sits above the keyboard
  (`visualViewport` resize listener).
- **Seam**: `.selectionCommandsPanel` [78], `.btnSelectionPanelOptions` [17], the plugin's
  `bulk-tags.js`, `select-all.js`, `multiSelect.js:473`.
- **Effort** M. **Risk** medium: synthetic touch sequences are brittle across browsers; if the
  synthetic path fails the entry simply shows the stock hint "press and hold a card".
- **Verify**: enter selection from the More sheet, select 3 cards, bulk-tag them, confirm with
  `/Items/<id>` that tags changed on exactly those 3; the keyboard never hides Save.

### P9. Library infinite scroll with a sticky "page N of M" (Phase 3)

- **Problem**: 1.2 (pager), QOL_IDEAS #12.
- **Change**: reuse `view/search-infinite.js`'s chunk approach on library pages under
  `html.layout-mobile`: when the pager enters the viewport, request the next page through the
  plugin's existing fetch hook and append; the pager becomes a sticky pill.
- **Seam**: `.itemsContainer`, the stock pager (`.paging` buttons), `controller/list-requests.js`.
- **Effort** M. **Risk** medium: the library view re-renders on sort changes; appended chunks must
  be discarded on any stock re-render (search solved this with `.jpChunk` markers).
- **Verify**: scroll 300 items without a tap; change sort and confirm the list resets; memory in
  DevTools stays flat (images released by the look-ahead's unobserve).

### P10. Loading skeletons (Phase 1, small)

- **Problem**: 1.1, 1.5 (empty-then-jump).
- **Change**: CSS-only shimmer on `.verticalSection:empty` / `.itemsContainer:empty` with a fixed
  min-height equal to one card row; removed by the content arriving. Reduced motion disables the
  shimmer, keeps the placeholder.
- **Seam**: `.verticalSection` [3], `.itemsContainer` [150]. **Effort** S. **Risk** low.
- **Verify**: throttle to 3G in DevTools; no layout jump when the first row arrives.

### P11. Search: sticky query and a quieter exclude (Phase 2, small)

- **Problem**: 1.4.
- **Change**: the search field sticks under the app bar; the exclude box moves into the Sort &
  filter sheet (its storage key and request contract unchanged); the chip row stays with the field.
- **Seam**: `.searchFields` (plugin already wraps it), `search-filter-sheet.js`, `search-exclude.js`.
- **Effort** S. **Risk** low. **Verify**: exclude still strips results (the request still carries
  `excludeTags`); the field is reachable after 10 infinite pages.

### P12. Landscape player polish (Phase 2, small)

- **Problem**: 1.6 (notch, chip, HUD bars).
- **Change**: the HUD volume / brightness bars inset by `max(env(safe-area-inset-*), 12px)`; the
  chip hides in landscape until the OSD shows; the Up Next card docks bottom-right above the OSD.
- **Seam**: the plugin's own HUD and chip, `.upNextDialog` [9]. **Effort** S. **Risk** low.
- **Verify**: on a notched phone in both landscape orientations, nothing sits under the notch and
  the Up Next card does not cover the seek bar.

**Top five by value / effort**: P1, P2, P4(a,b,e), P3, P6.

---

## 4. Wireframes

ASCII, 390 x 844 logical pixels in mind. Titles are placeholders.

### 4.1 Home with the bottom bar (P3, P6, P10)

```
┌──────────────────────────────────────┐
│ ≡   Jellyfin Plus              ⌕  ◯  │  app bar (stock, 56px, tokens)
│  Home   Favourites                   │  stock tab strip, 44px tabs, accent underline
├──────────────────────────────────────┤
│ Continue watching               See all│
│ ┌────────────┐ ┌────────────┐ ┌──    │  16:9 thumbs, progress line on the edge
│ │  Title A   │ │  Title B   │ │      │  title inside the image over a scrim
│ │▬▬▬▬▬▬░░░░░░│ │▬▬▬░░░░░░░░░│ │      │
│ └────────────┘ └────────────┘ └──    │
│ Recently added                  See all│
│ ┌───────┐ ┌───────┐ ┌───────┐ ┌─     │  2:3 posters, 3 per row + peek
│ │ 1080p │ │  4K   │ │       │ │      │  badge top-left (plugin)
│ │       │ │       │ │       │ │      │
│ │Title C│ │Title D│ │Title E│ │      │
│ │    ♡ ⋮│ │    ♡ ⋮│ │    ♡ ⋮│ │      │  44px icons bottom-right
│ └───────┘ └───────┘ └───────┘ └─     │
│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  skeleton row while loading
├──────────────────────────────────────┤
│   ⌂        ▦        ⌕        ♡     ⋯ │  bottom bar 56px + safe-area
│  Home   Libraries Search  Favourites More
└──────────────────────────────────────┘
```

### 4.2 Library grid with the filter sheet (P5, P6)

```
┌──────────────────────────────────────┐        ┌──────────────────────────────────────┐
│ ←  Movies            ⇅  ⚲2  ▦ ◯     │        │ ░░░░░░░░░░░░ scrim ░░░░░░░░░░░░░░░░░ │
│  Movies  Suggestions  Genres  …      │        │ ┌────────────────────────────────────┐ │
├──────────────────────────────────────┤        │ │           ━━━━                     │ │ handle
│ ┌───────────┐ ┌───────────┐ ┌─────   │        │ │ Sort & filter                 Reset│ │
│ │ 1080p     │ │           │ │        │        │ │ Sort     Name ▾   Ascending ▾      │ │
│ │           │ │           │ │        │        │ │ Tags     [ type to search… ]       │ │
│ │ Title A   │ │ Title B   │ │ Title  │        │ │          (tagA ×) (tagB ×)         │ │
│ │       ♡ ⋮ │ │       ♡ ⋮ │ │        │        │ │ Match    ● any   ○ all             │ │
│ └───────────┘ └───────────┘ └─────   │        │ │ Exclude  [ type to search… ]       │ │
│ ┌───────────┐ ┌───────────┐ ┌─────   │        │ │ Genres   ▸                         │ │
│ │           │ │           │ │        │        │ │ Years    ▸                         │ │
│ ...                                  │        │ │ Played   ○ all ● unplayed ○ played │ │
│        page 3 of 12  (sticky pill)   │        │ │                                    │ │
├──────────────────────────────────────┤        │ │ [       Show 1,284 results       ] │ │ 48px
│   ⌂        ▦        ⌕        ♡     ⋯ │        │ └──────────── safe-area ────────────┘ │
└──────────────────────────────────────┘        └──────────────────────────────────────┘
```

### 4.3 Search (P11)

```
┌──────────────────────────────────────┐
│ ←  [ ⌕  search term            × ]   │  sticky under the app bar
│ (Videos) (Movies) (Shows)  ⚲ Sort & filter 2 │  type chips + sheet button with badge
├──────────────────────────────────────┤
│ Recent: term one · term two · …      │  only while the field is empty
│ ┌────────────────┐ ┌────────────────┐│  2 columns under 50em (existing)
│ │ 16:9 thumb     │ │                ││
│ │ Title A        │ │ Title B        ││
│ │ 12:34 · 1080p  │ │ 03:10 · 720p   ││  badges as a text line, not a second row
│ └────────────────┘ └────────────────┘│
│ ┌────────────────┐ ┌────────────────┐│
│ ...                                  │  infinite (existing)
│              loading…                │
├──────────────────────────────────────┤
│   ⌂        ▦        ⌕        ♡     ⋯ │
└──────────────────────────────────────┘
```

### 4.4 Item details (P7)

```
┌──────────────────────────────────────┐
│ ←                              ⋮     │  transparent over the backdrop
│ ┌──────────────────────────────────┐ │
│ │        backdrop 16:9, scrim      │ │
│ └──────────────────────────────────┘ │
│ ┌──────┐  Title of the item         │  xl 22px
│ │poster│  2024 · 1h 52m · 1080p     │  text-2
│ │      │  ★ 7.8   ◉ Unplayed        │
│ └──────┘                            │
│ [ ▶  Play                   ] ♡ ✓ ⋮ │  full-width primary + 44px icons
│ ‹ prev                        next › │  plugin detail-nav
│ Overview text ... ... ... more      │
│ (tagA) (tagB) (tagC) (+12)          │  chips 44px
│ Audio: English 5.1 ▾  Subs: Off ▾   │  rows open a sheet
│ ▸ Technical details                 │  collapsed
│ More like this                      │
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌─       │
├──────────────────────────────────────┤
│ Title of the item   [ ▶ Play ]   ⋮   │  sticky bar after the row scrolls out
└──────────────────────────────────────┘
```

### 4.5 Player, portrait and landscape (P4, P12)

```
portrait                                    landscape
┌──────────────────────────────────────┐    ┌────────────────────────────────────────────────┐
│ ←  Title of the item            ⚙  ✦ │    │▌←  Title                              ⚙  ✦  ◯▐│  insets
│ ┌──────────────────────────────────┐ │    │                                                │
│ │                                  │ │    │   ‹‹ 10          ▶            10 ››            │  gesture hints
│ │            video 16:9            │ │    │                                                │
│ │                                  │ │    │                                                │
│ └──────────────────────────────────┘ │    │▌ Server: Balanced · Browser: FSR 1.0      ✦ ▐│  chip, OSD only
│ ◉━━━━━━━━━●━━━━━━━━━━━━━━━━━━━━━━━  │    │▌ 12:34 ◉━━━━━━●━━━━━━━━━━━━━━━━━━━ 1:52:10 ▐│
│ 12:34                        1:52:10 │    │▌  ⏮   ‹‹    ▶    ››   ⏭        CC  ♪  ⤢  🔒 ▐│  44px each
│   ⏮    ‹‹     ▶     ››    ⏭         │    └────────────────────────────────────────────────┘
│ Server: Balanced · Browser: FSR 1.0  │  chip under the bar
│ ┌──────────────────────────────────┐ │
│ │ Up next: Next title       ▶  ×   │ │  uses the dead area
│ └──────────────────────────────────┘ │
│ [ ✦ Enhance ]  [ 1.0× ]  [ CC ] [🔒] │  shortcuts, 44px
└──────────────────────────────────────┘
```

### 4.6 Enhance panel as a sheet (P2)

```
┌──────────────────────────────────────┐
│          video keeps playing         │
│ ░░░░░░░░░░░░░ scrim ░░░░░░░░░░░░░░░░ │
│ ┌────────────────────────────────────┐
│ │              ━━━━                  │
│ │ Enhance                 Balanced  ×│  title + summaryText
│ │ Quality                             │
│ │ (Off) (Light) (●Balanced) (Max) (Custom)   44px pills, horizontal scroll
│ │ "Balanced: FSRCNNX ×2, light denoise"      server wording from the probe
│ │ ▸ Advanced                          │  disclosure (state in jellyfinPlusOpen)
│ │   Detail      fsrcnnx ▾             │
│ │   Denoise     light ▾               │
│ │   ...                               │
│ │ ▸ Browser upscaling     Auto · Low  │
│ ├─────────────────────────────────────┤
│ │ Live: 1920×1080 → 3840×2160 · ok    │  pinned Live block (existing LIVE_ROWS)
│ │ [            Apply now            ] │  48px, only when a change is pending
│ └──────────── safe-area ─────────────┘
└──────────────────────────────────────┘
```

---

## 5. Phased rollout

Rules carried over from the QoL work (CLAUDE.md "Working with parallel agents"): a shared brief
file; disjoint file ownership; shared files take additive edits only; agents never deploy; the main
thread merges, builds (`npm install` in `web/`, `scripts/build-web-panel.sh`), deploys once and
runs the live checks on a real phone against CT114.

### Phase 1: tokens and the safest wins (P1, P2, P4 a/b/e, P10)

| Agent | Owns | Delivers |
|---|---|---|
| T (theme) | new `web/src/view/mobile-theme.js`; one line in `bootstrap.js` (additive) | tokens, palette mapping, tap targets, reduced motion, skeletons, the `jellyfinPlus.mobileTheme` switch |
| S (sheet) | new `web/src/view/sheet.js`; `view/search-filter-sheet.js` (extract the shell, behaviour unchanged); `view/panel-dom.js` (sheet mode) | the shared sheet; the Enhance panel as a sheet on phones |
| O (OSD) | `controller/player-badge.js`, `view/player-hud.js`, `model/player-gesture.js` (+ its `.test.mjs`) | chip relocation and visibility rule, OSD button and thumb sizes, the edge dead zone |
| Main | `context-map.md`, `ENHANCEMENTS.md` section 10 (new keys), `docs/README.md` | merge, build, deploy, live checks |

Live-check list (phone, stock Dark, then one other theme):

1. Stock look restored by `jellyfinPlus.mobileTheme=off` + reload: no `#jellyfinPlusMobileThemeStyle`
   node, no visual difference from a build without the module (compare screenshots).
2. Desktop and TV layouts: zero diff (force layout in Display settings; the TV layout gets no
   `html.layout-mobile`, so no rule applies).
3. Home, Movies, a tag list, Search, Details: every tappable control >= 44 px in the device toolbar.
4. Player: hold / double-tap / swipe unchanged (`model/player-gesture.test.mjs` passes; on device,
   each gesture once); edge swipe back does not change brightness; chip never over the title.
5. Enhance sheet: pick Balanced, `journalctl -u jellyfin | grep libplacebo` shows the new command;
   pick Off, the command loses the filter; the session record agrees; desktop panel unchanged.
6. Reduced motion on: no animated sheet, no shimmer.
7. Bundle size delta and the hook window: the `webpackChunk` hook still lands before the first
   chunk (`jellyfinPlusDebug` log line order).

### Phase 2: navigation and browsing (P3, P5, P6, P7, P11, P12, P4 c/d)

| Agent | Owns |
|---|---|
| N (nav) | new `web/src/view/bottom-nav.js`, new `controller/more-sheet.js`; one line in `bootstrap.js` |
| L (library) | `view/library-filter-panel.js`, `view/card-actions.js`, `view/card-badges.js`, new `model/grid-density.js` |
| D (details) | `controller/detail-nav.js`, new `view/detail-actions.js` |
| Q (search) | `controller/search-exclude.js`, `view/search-filter-sheet.js` (after S's extraction has merged) |
| O (player) | `view/player-hud.js`, `controller/clip-upnext.js`, new `view/portrait-osd.js` |

Live-check list: one-handed reach test on every bar slot; the bar hides on `#/video` and while any
sheet is open; the music now-playing bar and the nav bar never overlap; library filter from the
sheet produces the identical request to the Popover (compare the `Items` URL); 2 and 3 columns
request the same image size; Play from the sticky bar resumes; exclude still carries `excludeTags`;
landscape on a notched device; portrait OSD transitions still fire `videoOsdBottom-hidden`.

### Phase 3: selection, infinite libraries, desktop parity (P8, P9, optional theme entry)

| Agent | Owns |
|---|---|
| M (multi-select) | `controller/bulk-tags.js`, `controller/select-all.js`, new `controller/select-mode.js` |
| I (infinite) | `controller/list-requests.js`, new `view/library-infinite.js` (modelled on `search-infinite.js`) |
| W (web theme, only if open question 2 says yes) | `scripts/jellyfin-plus-webinject` (write `themes/jellyfinplus/theme.css` + the `config.json` entry idempotently, with a backup of `config.json` like `index.html`), new `web/theme/jellyfinplus.css` built from the same tokens |

Live-check list: bulk-tag 3 items from the phone and verify tags by `/Items/<id>`; selection exits
cleanly on back; 300 items scrolled with flat memory; sort change resets the list; if W ships: the
theme appears in Display settings, a 404 of its css (rename the file) leaves the client usable and
the stock Dark selectable, an apt reinstall of jellyfin-web re-creates both files.

### Order of merges and what each needs

Phase 1 ships the client only: no C# change, no restart; publish the script and the hash-buster
does the rest. Phase 2 and 3 are also client-only except W (injector script). No proposal above
needs a server route, a Harmony patch or a plugin setting; if P8's synthetic entry proves brittle,
it degrades to the stock hint rather than needing server help.

---

## 6. Open questions for the user

1. **Brand colour.** Keep the stock Jellyfin blue (`#00a4dc`) as the accent, use the proposed
   lighter `#5ccfff` on dark / `#0369a1` on light (both AA), or something else? Does the
   purple-to-blue brand gradient appear anywhere (app bar, splash)?
2. **Desktop parity.** Phone-only (mechanism A) is the recommendation. Do you also want the same
   colours on desktop as a selectable "Jellyfin Plus" theme (mechanism B, Phase 3 agent W)?
3. **Bottom navigation: yes or no**, and which five slots? Proposed: Home, Libraries, Search,
   Favourites / Now playing, More. Alternative: Enhance as a slot (opens the sheet only during
   playback; greyed otherwise).
4. **Light scheme.** Ship both schemes in Phase 1, or dark first and light later?
5. **Pinch zoom.** Stock sets `user-scalable=no`. Allowing the injector to rewrite the viewport
   meta (mechanism D) restores zoom for accessibility but is a second edit to `index.html`. Leave it?
6. **Grid density default** on phones: 2 or 3 columns of posters? Keep the title inside the image
   (loses the stock two-line footer) or under it?
7. **Selection mode.** Keep the stock long-press as the only entry, or add the explicit Select entry
   (P8, synthetic touch path, medium risk)?
8. **Tablets.** `browser.mobile` is true for iPads, so everything here applies to them. Treat tablets
   as phones (bottom bar, 3 columns) or exclude widths above 50 em from the layout proposals and
   keep only the tokens?
9. **What to cut.** Candidates if time is short: P9 (libraries keep paging), P12, the light scheme,
   the Now playing slot.
10. **Chip in portrait.** Keep the OSD chip always visible on phones (it is the honesty signal), or
    show it only while the OSD is open?
