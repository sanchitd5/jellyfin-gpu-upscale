# Jellyfin Plus

An all-round upgrade for a Jellyfin server and its web client. It makes the picture better, on the
server's GPU and in the viewer's browser, and it improves the player, search, library browsing and
tag management. It ships as one plugin plus one injected client script. Every feature installs on its
own and falls back to stock Jellyfin when it cannot attach.

Built and measured against Jellyfin **12.1.0**. The server-side video enhancement was measured on an
NVIDIA RTX 3090.

> **This is not an official Jellyfin plugin, and it works by runtime-patching Jellyfin.**
> Read [Limitations and risks](#limitations-and-risks) before installing it anywhere you care about.
> It will break on some Jellyfin upgrades — by the nature of the approach, not by accident.

## What it adds

| Area | Highlights | Details |
|---|---|---|
| **Video enhancement (server GPU)** | Realtime super-resolution, sharpening, denoise, deblock and deband inside the transcode, from an **Enhance** panel in the player. Fourteen composable axes, switchable mid-playback without a gap. libplacebo shaders on Vulkan, plus optional OIDN, OptiX, ONNX, FSR2 and DLSS filters. | [manual](docs/video-enhancement.md) · [catalogue](ENHANCEMENTS.md#1-gpu-upscaling-and-enhancement) |
| **Upscaling in the browser** | For slow connections. When the stream is smaller than the screen, the player removes blocking and banding and upscales with AMD FSR 1 on the viewer's GPU (WebGL2). Auto by default, set per device, steps down when the device can't keep up. | [catalogue](ENHANCEMENTS.md#5-cards-and-playback) |
| **Player** | Hold for 2× speed. Swipe for volume (right half) and brightness (left half). Double-tap a side to seek. Speed remembered. An OSD chip showing what the server and the browser are actually doing to the picture. | [catalogue](ENHANCEMENTS.md#5-cards-and-playback) |
| **Search** | Matches tags as well as names, with `*` and `?` wildcards, from a full-text index. Per-tag exclude. A Sort & filter sheet. Recent searches. A results grid, paged on desktop and infinite on phones. | [catalogue](ENHANCEMENTS.md#2-search) |
| **Library browsing** | Home Videos opens on Videos. Tag search, exclude and match-all in the filter popover. A Random sort that doesn't repeat across pages, and a "Recently edited" sort. Card badges for resolution, runtime and tags. Phone-friendly card buttons. | [catalogue](ENHANCEMENTS.md#3-library-browsing-and-filters) |
| **Item pages** | Previous and next through the list you came from. A Download button for videos. More Like This for clips. Tag and person chips. | [catalogue](ENHANCEMENTS.md#4-item-pages) |
| **Tags and admin** | Bulk tag edit, including "Select all N results". Tag autocomplete. A tag manager on the plugin page (rename, merge, delete, with a dry run). Maintenance task buttons. Preferences synced across browsers. | [catalogue](ENHANCEMENTS.md#6-tag-editing) |

**Two rules run through all of it.** Every choice was measured against ground truth. On the video
side, several popular options lost and are documented with numbers in
[What was tried and rejected](docs/video-enhancement.md#what-was-tried-and-rejected). On the library
side, every faster query was proved to return exactly the same rows as stock. And it never claims to
have done what it did not do. When enhancement did not run, the session report and the OSD chip say
why; a feature that cannot attach leaves stock Jellyfin in place.

## Documentation

| Read | For |
|---|---|
| [INSTALL.md](INSTALL.md) | Installing from scratch, with environment checks and troubleshooting |
| [docs/video-enhancement.md](docs/video-enhancement.md) | The video-enhancement manual: levels, axes, configuration, throughput, how it works |
| [ENHANCEMENTS.md](ENHANCEMENTS.md) | Every change to Jellyfin: patches, routes, request parameters, storage keys, fail-soft rules |
| [AGENTS.md](AGENTS.md) | Invariants and verification standards, before changing code |
| [docs/](docs/README.md) | Design documents, one document per custom filter, research, roadmap, task logs |

## Requirements

- Jellyfin **12.1.0** (other versions: see [Limitations and risks](#limitations-and-risks))
- .NET SDK matching the server's runtime, plus Node.js and npm, on the build machine
- The jellyfin-web client in a browser for the client features; other apps get only the server-side
  changes
- For browser upscaling: a browser with WebGL2
- For server video enhancement: an NVIDIA GPU with NVENC and Vulkan, and `jellyfin-ffmpeg` built
  with libplacebo + vulkan + libshaderc (`jellyfin-ffmpeg8` is). The extra filters need a patched
  ffmpeg you build yourself; see
  [what the shader axes need](docs/video-enhancement.md#what-the-shader-axes-need).

The search, library, player and tag features do not use the GPU. Running them on a server without
one has not been tested.

## Install

**Step by step, with checks and troubleshooting: [INSTALL.md](INSTALL.md).** The short version:

```bash
# 1. shaders (fetches FSRCNNX and Anime4K from upstream, installs the bundled CAS shaders)
sudo ./scripts/install-shaders.sh

# 2. build
export DOTNET_ROOT=/opt/dotnet   # wherever your SDK lives
dotnet publish src -c Release -p:JellyfinBin=/usr/lib/jellyfin/bin -o ./out
dotnet publish src/patcher -c Release -p:JellyfinBin=/usr/lib/jellyfin/bin -o ./out-patcher
(cd web && npm install) && ./scripts/build-web-panel.sh   # writes web/jellyfin-plus.js (not in git)

# 3. deploy
#    plugin  -> /var/lib/jellyfin/plugins/JellyfinPlus_<version>/   (owned jellyfin:jellyfin)
#    patcher -> /usr/lib/jellyfin-plus/                     (NOT under plugins/)
#    client  -> web/jellyfin-plus.js into /usr/lib/jellyfin-plus/; the injector below copies it to
#               /usr/share/jellyfin/web/ and adds a <script> tag (content-hash cache-buster) to index.html
sudo ./scripts/jellyfin-plus-webinject
sudo systemctl restart jellyfin
```

`scripts/jellyfin-plus-activate` swaps a staged build in place with a backup, and `--rollback`
reverts it. On a Proxmox LXC, `scripts/proxmox-build.sh` does all of it from the GitHub repo in one
command.

The optional patched ffmpeg (`scripts/build-ffmpeg.sh`) is never distributed as a binary: it is
GPLv2+ and links Apache-2.0 code. Build it for yourself.

## Limitations and risks

- **It patches Jellyfin internals by name.** A later Jellyfin can rename a method, so the patch
  finds nothing and logs it. Worse, it can keep the name and change the meaning, which Harmony cannot
  detect. Re-verify after every Jellyfin upgrade.
- **A `jellyfin-web` upgrade replaces `index.html` and drops the injected script.**
  `scripts/99-jellyfin-plus` re-applies it after dpkg runs.
- **The client hooks depend on minified jellyfin-web internals.** Modules are matched by the shape of
  what they export, not by id, but a web rebuild can still break a feature. Each one fails safe to
  stock.
- **Other apps** (Android, iOS, TV, third-party players) direct-play, are never enhanced, and get none
  of the client features. Server-side search changes and faster filter lists apply to them.
- **Server enhancement limits:**
  - subtitle burn-in is never enhanced;
  - the concurrency cap is advisory;
  - without the patched ffmpeg, the extra levels quietly disappear (check with `-filters`).

  More in [the manual](docs/video-enhancement.md).
- **Browser upscaling** switches off while native subtitles show, in iOS native fullscreen and in
  picture-in-picture. It is measured only on a desktop GPU.
- `targetAbi` pins the plugin to a Jellyfin version; a later server may refuse to load it until raised.

## Licences and credits

This project is licensed under **GPL-2.0** — see [LICENSE](LICENSE). Jellyfin is GPL-2.0, and this
plugin references its assemblies and patches its code at runtime, so a compatible licence is required.

- **Jellyfin** — GPL-2.0 — https://github.com/jellyfin/jellyfin
- **Lib.Harmony** — MIT — https://github.com/pardeike/Harmony
- **FSRCNNX** — © igv, LGPL-3.0-or-later — https://github.com/igv/FSRCNN-TensorFlow
  *Fetched at install time, not redistributed here.*
- **Anime4K** — © 2019-2021 bloc97, MIT — https://github.com/bloc97/Anime4K
  *Fetched at install time, not redistributed here.*
- **AMD FidelityFX Super Resolution 1 (EASU + RCAS)** — © 2021 Advanced Micro Devices, Inc., MIT —
  https://github.com/GPUOpen-Effects/FidelityFX-FSR. Ported to WebGL2 for client-side upscaling in
  `web/src/model/shaders/fsr1.js`, which carries AMD's copyright and licence text. The cleanup
  shaders beside it (`cleanup.js`) are this project's own.
- **CAS shaders** in `shaders/` are this project's own work, implementing AMD's Contrast Adaptive
  Sharpening approach as an mpv/libplacebo user shader.
