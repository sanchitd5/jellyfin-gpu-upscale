# GPU Upscale for Jellyfin

Realtime GPU super-resolution, sharpening and denoising for Jellyfin transcodes, using libplacebo
GLSL user shaders on Vulkan. A viewer picks a target from the player's **Enhance** menu and the
stream is upscaled on the fly.

Built and measured against Jellyfin **12.1.0** with an NVIDIA RTX 3090.

> **This is not an official Jellyfin plugin, and it works by runtime-patching Jellyfin.**
> Read the [Limitations and risks](#limitations-and-risks) section before installing it anywhere
> you care about. It will break on some Jellyfin upgrades, by design of the approach rather than by
> accident.

## Why it patches Jellyfin

Jellyfin 12.1 exposes **no plugin interface for the video filter graph**. Inspecting the shipped
assemblies shows provider interfaces (`IAuthenticationProvider`, `IMediaSourceProvider`,
`IMetadataProvider`, …) and an audio-filter hook, but nothing for video filters or the encoding
graph. A stock plugin therefore cannot inject a scaling chain.

So this plugin uses [Lib.Harmony](https://github.com/pardeike/Harmony) to patch
`MediaBrowser.Controller.MediaEncoding.EncodingHelper` at runtime:

| Method | What the postfix does |
|---|---|
| `GetVideoProcessingFilterParam` | replaces `-vf` with the libplacebo chain; bails out on `-filter_complex` (subtitle burn-in) |
| `GetInputVideoHwaccelArgs` | swaps CUDA device setup for `-init_hw_device vulkan=vk:0 -filter_hw_device vk` |
| `GetHwaccelType` | drops `-hwaccel cuda -hwaccel_output_format cuda` |
| `GetHardwareVideoDecoder` | drops `*_cuvid`, so frames reach `hwupload` in system memory |
| `GetVideoEncoder` | turns a stream `copy` into a real encode when enhancement was requested |

Every postfix is individually try/caught: a throw leaves Jellyfin's own value in place.

### Two obstacles worth knowing about

**Plugins load into a collectible `AssemblyLoadContext`.** Harmony cannot emit detours against one
(`System.NotSupportedException: Resolving to a collectible assembly is not supported`). The patch
code therefore lives in a **second assembly outside the plugin directory**, loaded into the default
context. It must be outside, because Jellyfin enumerates plugin DLLs with `SearchOption.AllDirectories`
— even a subfolder gets pulled into the collectible context. The two sides exchange only primitives
(JSON strings, an `object`-typed logger), so no type crosses the boundary.

**Lib.Harmony 2.4.1 refuses .NET 10** (`CoreCLR version 10.0.12 is not supported`). Use **2.4.2** or
newer.

## The filter chain

```
setparams(kept),format=yuv420p,hwupload,
libplacebo=w=W:h=H:upscaler=ewa_lanczos
         :deband=1:deband_threshold=3:deband_grain=0
         :custom_shader_path=<shader>,
hwdownload,format=yuv420p  →  h264_nvenc / hevc_nvenc
```

`deband_grain=0` is deliberate: libplacebo defaults it to 6, which adds synthetic grain that is
wrong for already-noisy source material.

Optional denoise runs **before** the upscale — `hqdn3d` in software before `hwupload`, or
`nlmeans_vulkan` on the GPU after it.

## Super-resolution levels

Level names carry **family and weight**, because these are different networks rather than rungs of
one ladder:

| Level | Shader |
|---|---|
| `off` | plain `ewa_lanczos` |
| `fsrcnnx` *(default)* | `FSRCNNX_x2_8-0-4-1` |
| `fsrcnnx-heavy` | `FSRCNNX_x2_16-0-4-1` |
| `fsrcnnx-max` | `FSRCNN_x2_r1_32-0-2` (accepted by the API, not offered in the menu) |
| `anime4k-s` | `Anime4K_Upscale_CNN_x2_S` |
| `anime4k-m` | `Anime4K_Upscale_CNN_x2_M` |

The legacy names `light` / `standard` / `max` still resolve.

### Choosing between them

Measured on real low-bitrate webcam captures (mean |Laplacian|, deployed chain):

| Source | Ratio | plain | `fsrcnnx` | `anime4k-m` |
|---|---|---|---|---|
| 540p → 1080p | 2.0x | 2.1911 | **2.5572** | 2.5462 |
| 720p → 1080p | 1.5x | 2.5802 | **2.6190** | 2.5120 |
| 720p → 1080p | 1.5x | 4.0242 | **4.2571** | 4.0093 |
| 960 → 1440 | 1.5x | 4.8638 | **5.0704** | 4.7706 |
| 960 → 1440 | 1.5x | 3.7583 | **3.8805** | 3.7033 |

**Anime4K is only competitive at its native 2.0x ratio.** At 1.5x it falls *below plain lanczos* on
every source tested: off its native ratio it softens rather than reconstructs, lowering both flat-area
and edge detail. On real footage its output looks smoother and slightly waxy — flattened skin mottling,
but softer eyelash and eyebrow detail too. FSRCNNX beats plain scaling at every ratio tested, which is
why it is the default. Both families ship; pick per session.

Some shaders carry `//!WHEN` guards that skip the pass below a minimum scale factor (FSRCNNX 1.300,
Anime4K 1.200), so e.g. a 1.125x scale fires neither.

## Requirements

- Jellyfin **12.1.0** (other versions: see the risks section)
- NVIDIA GPU with NVENC, a driver new enough for your `jellyfin-ffmpeg`, and Vulkan
- `jellyfin-ffmpeg` built with **libplacebo + vulkan + libshaderc** (`jellyfin-ffmpeg8` is)
- .NET SDK matching the server's runtime, to build

There is **no ONNX/OpenVINO/TensorFlow** requirement — and deliberately no dependency on them.
ffmpeg's `sr`/`dnn_processing` filters are not used; everything is GLSL through libplacebo.

## Install

**Full step-by-step guide, including environment checks and troubleshooting: [INSTALL.md](INSTALL.md).**
The short version:

```bash
# 1. shaders (fetches FSRCNNX and Anime4K from upstream, installs the bundled CAS shaders)
sudo ./scripts/install-shaders.sh

# 2. build
export DOTNET_ROOT=/opt/dotnet   # wherever your SDK lives
dotnet publish src -c Release -p:JellyfinBin=/usr/lib/jellyfin/bin -o ./out
dotnet publish src/patcher -c Release -p:JellyfinBin=/usr/lib/jellyfin/bin -o ./out-patcher

# 3. deploy
#    plugin  -> /var/lib/jellyfin/plugins/GpuUpscale_<version>/   (owned jellyfin:jellyfin)
#    patcher -> /usr/lib/jellyfin-gpuupscale/                     (NOT under plugins/)
#    client  -> /usr/share/jellyfin/web/gpu-upscale.js + a <script> tag in index.html
sudo ./scripts/jellyfin-gpuupscale-webinject
sudo systemctl restart jellyfin
```

`scripts/jellyfin-gpuupscale-activate` swaps a staged build in place with a backup, and
`--rollback` reverts it.

## Configuration

Dashboard → Plugins → GPU Upscale. Defaults suit a single busy GPU:

| Setting | Default | Notes |
|---|---|---|
| `TargetHeight` | 1080 | used when a session names no target |
| `MaxTargetHeight` | 2160 | hard ceiling |
| `SrLevel` | `fsrcnnx` | default super-resolution level |
| `DeblurLevel` / `DeblurAllowed` | `off` / true | CAS sharpening; SR already sharpens, so default off |
| `DenoiseLevel` / `DenoiseAllowed` | `off` / true | `light` = hqdn3d, `strong` = nlmeans_vulkan |
| `Deband` | true | with `grain=0` |
| `MinScaleFactor` | 1.15 | skip near-identity upscales |
| `MaxSourceHeight` | 1440 | never upscale sources taller than this |
| `MaxConcurrent` | 2 | beyond this, stock transcoding is used |
| `Encoder` | `hevc_nvenc` | falls back to the client's codec when unsupported |
| `RequireClientOptIn` | true | off = enhance every eligible transcode |
| `ForceTranscode` | false | turn a would-be stream copy into a real transcode |
| `ForceTranscodeForDirectPlay` | false | see below — stops clients direct playing eligible material |

### Enhancing direct play

A direct-playing file has no transcode, so there is nothing to enhance. The injected client handles
this for web viewers by disabling direct play on the PlaybackInfo *request* when a selection is made.
Clients without the script (Android, TV, mobile) are unaffected and play unenhanced.

`ForceTranscodeForDirectPlay` closes that gap server-side, via a Harmony **prefix** on
`Jellyfin.Api.Helpers.MediaInfoHelper.SetDeviceSpecificData` that flips its `enableDirectPlay` /
`enableDirectStream` parameters for eligible material, on every client.

It defaults to **false**, and the cost is real: each such session becomes a GPU transcode subject to
`MaxConcurrent`, and sessions past that limit fall back to stock transcoding — *more* expensive than
the direct play they replaced. Eligibility reuses the engine's own arithmetic
(`UpscaleEngine.WouldEnhanceSource`), so the override cannot force a transcode for material the
engine would then decline to enhance.

The target is resolved by name with `AccessTools.TypeByName`, so there is no compile-time reference
to `Jellyfin.Api` and no version pin to a web-API assembly.

### How patch failures degrade

The five core `EncodingHelper` patches are **interdependent, not five independent features** — the
filter chain only works because the hwaccel and decoder patches put frames where `hwupload` expects
them. Installing a subset would emit ffmpeg command lines that fail outright, which is worse than
leaving playback unenhanced. So they stay all-or-nothing: if any core method cannot be resolved,
none are patched, Jellyfin is left alone, and the log **names the missing methods**.

Optional patches (currently just the direct-play override) install separately, after the core set is
live, each in its own try/catch. One failing degrades that feature alone:

```
active (5 EncodingHelper methods patched); optional: direct-play override
active (5 EncodingHelper methods patched); optional UNAVAILABLE: MediaInfoHelper.SetDeviceSpecificData
```

## How a viewer's choice reaches the server

Jellyfin's `ParseStreamOptions` copies **every lowercase-initial query parameter** into the request's
`StreamOptions` dictionary, readable server-side via `GetOption(...)`. Nothing clamps or rewrites it.
The injected client therefore appends `&upscale=1440&sr=fsrcnnx&deblur=medium&denoise=light`.

A requested *bitrate* would not survive — Jellyfin clamps it to the source bitrate before
`EncodingHelper` sees it — which is why an earlier sentinel-bitrate approach was abandoned.

**Direct play has no transcode to enhance**, so when (and only when) a viewer selects enhancement,
the client also sets `EnableDirectPlay=false` / `EnableDirectStream=false` on the PlaybackInfo
*request*. Marking the response cannot work: a direct-play response contains no `TranscodingUrl` to
mark, and clearing `SupportsDirectPlay` there would leave the player with nothing to fall back to.

## Honest reporting

The playback-info row and `GET /GpuUpscale/Session/{playSessionId}` report what the server **actually
did**, with explicit statuses: `applied`, `concurrency-cap`, `subtitle-burn-in`, `stream-copy`,
`disabled`, `not-requested`, `ineligible`. Negatives are recorded too, so a session that asked for 4K
and hit the concurrency cap says so rather than claiming success.

## Measured throughput

960x540 source, RTX 3090, filter-only, measured on a **shared** GPU — absolute figures are good to
about ±25%, so treat the ratios as the reliable part.

| Level | 1080p | 1440p | 2160p |
|---|---|---|---|
| SR off | 264 fps | 242 fps | 152 fps |
| `fsrcnnx` (light weights) | 227 fps | 187 fps | 138 fps |
| `fsrcnnx-heavy` | 191 fps | 154 fps | 115 fps |
| + unblur medium | 176 fps | 147 fps | 93 fps |

Denoise costs roughly: `hqdn3d` 5.5x realtime, `nlmeans_vulkan` 2.9x realtime.

## Limitations and risks

- **Patches match `EncodingHelper` methods by name.** A rename or refactor in a later Jellyfin makes
  them resolve to nothing; the plugin logs it and does not patch. Worse, a method could survive by
  name and change meaning — Harmony cannot detect that. **Re-verify after every Jellyfin upgrade.**
- **A `jellyfin-web` package upgrade replaces `index.html` and deletes the injected script**, so the
  Enhance menu silently disappears. `scripts/99-jellyfin-gpuupscale` re-applies it after dpkg runs.
- **The client hooks depend on minified bundle internals** (the `webpackChunk` global, the module
  exporting `getVideoQualityOptions`). Modules are matched on export shape rather than by id, but a
  web rebuild can still break the menu. It fails safe: normal playback and menus are unaffected.
- **Subtitle burn-in is never enhanced** — those jobs build a `-filter_complex` graph and are skipped.
- **Clients without the injected script** (Android, TV, mobile) direct-play and are never enhanced.
- **The concurrency cap is advisory** — it counts live ffmpeg processes carrying `libplacebo` at
  command-build time, so two sessions starting simultaneously can both pass. Linux-only by construction.
- `targetAbi` pins the plugin to a Jellyfin version; a later server may refuse to load it until raised.

## Fallback: the ffmpeg shim

`shim/jellyfin-ffmpeg-upscale` is a standalone Python wrapper that rewrites the transcode command
without any Harmony patching, wired in via `JELLYFIN_FFMPEG_OPT=--ffmpeg=...`. It is less capable
(it infers intent from the command line rather than from the session) but survives Jellyfin changes
that break the patches. It stands down automatically while the plugin's patches are active.

## Licences and credits

This project is licensed under **GPL-2.0** — see [LICENSE](LICENSE). Jellyfin is GPL-2.0, and this
plugin references its assemblies and patches its code at runtime, so a compatible licence is required.

- **Jellyfin** — GPL-2.0 — https://github.com/jellyfin/jellyfin
- **Lib.Harmony** — MIT — https://github.com/pardeike/Harmony
- **FSRCNNX** — © igv, LGPL-3.0-or-later — https://github.com/igv/FSRCNN-TensorFlow
  *Fetched at install time, not redistributed here.*
- **Anime4K** — © 2019-2021 bloc97, MIT — https://github.com/bloc97/Anime4K
  *Fetched at install time, not redistributed here.*
- **CAS shaders** in `shaders/` are this project's own work, implementing AMD's Contrast Adaptive
  Sharpening approach as an mpv/libplacebo user shader.
