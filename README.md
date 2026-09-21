# GPU Upscale for Jellyfin

Realtime GPU super-resolution, sharpening and denoising for Jellyfin transcodes, using libplacebo
GLSL user shaders on Vulkan. A viewer picks a quality level from the player's **Enhance** menu and
the stream is upscaled on the fly — a 540p capture served at 1080p, reconstructed rather than
stretched.

Built and measured against Jellyfin **12.1.0** with an NVIDIA RTX 3090.

> **This is not an official Jellyfin plugin, and it works by runtime-patching Jellyfin.**
> Read [Limitations and risks](#limitations-and-risks) before installing it anywhere you care about.
> It will break on some Jellyfin upgrades — by the nature of the approach, not by accident.

Two things distinguish it from the usual "enable an upscaler" plugin, and both are the reason the
rest of this document is long:

**Every choice here was measured against ground truth, and several popular options lost.** FSR's
EASU, NVScaler, Anime4K below its native ratio, temporal video super-resolution and generative models
were all tested on real footage and rejected with numbers — see
[What was tried and rejected](#what-was-tried-and-rejected). The defaults are what survived, not what
sounded best.

**It never claims to have done something it did not do.** If the concurrency cap, a subtitle burn-in,
a direct-play session or a low scale ratio means enhancement did not run, the session report says so
plainly rather than showing a quality badge that is a lie.

## Contents

**Using it** — [Requirements](#requirements) · [Install](#install) · [The player menu](#the-player-menu) · [Off means direct play](#off-means-direct-play)

**What it does** — [Super-resolution levels](#super-resolution-levels) · [The non-2x ratio problem](#the-non-2x-ratio-problem) · [Sharpening: RCAS](#sharpening-rcas) · [Denoise](#denoise) · [Intel Open Image Denoise (denoise=oidn)](#intel-open-image-denoise-denoiseoidn) · [NVIDIA OptiX (denoise=optix, denoise=optix-temporal)](#nvidia-optix-denoiseoptix-denoiseoptix-temporal)

**Running it** — [Configuration](#configuration) · [Honest reporting](#honest-reporting) · [Measured throughput](#measured-throughput)

**How it works** — [Why it patches Jellyfin](#why-it-patches-jellyfin) · [The filter chain](#the-filter-chain) · [How a viewer's choice reaches the server](#how-a-viewers-choice-reaches-the-server) · [Fallback: the ffmpeg shim](#fallback-the-ffmpeg-shim)

**Before you rely on it** — [Limitations and risks](#limitations-and-risks) · [What was tried and rejected](#what-was-tried-and-rejected) · [Licences and credits](#licences-and-credits)

## Requirements

- Jellyfin **12.1.0** (other versions: see the risks section)
- NVIDIA GPU with NVENC, a driver new enough for your `jellyfin-ffmpeg`, and Vulkan
- `jellyfin-ffmpeg` built with **libplacebo + vulkan + libshaderc** (`jellyfin-ffmpeg8` is)
- .NET SDK matching the server's runtime, to build

There is **no ONNX/OpenVINO/TensorFlow** requirement — and deliberately no dependency on them.
ffmpeg's `sr`/`dnn_processing` filters are not used; everything is GLSL through libplacebo.

## Install

**Full step-by-step guide, including environment checks and troubleshooting: [INSTALL.md](INSTALL.md).**

The custom filters (`oidn`, `optix`) need a patched FFmpeg, which
[`scripts/build-ffmpeg.sh`](scripts/build-ffmpeg.sh) builds in one command. **No binary is
distributed, deliberately**: the build is `--enable-gpl --enable-libx264` so it is GPLv2+, and it
links Apache-2.0 code, which GPLv2 is not compatible with. Building it for yourself carries no such
obligation; publishing it would. The OptiX path additionally sits under NVIDIA's EULA.

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

## The player menu

The Enhance menu has three parts: **Quality** (Automatic / Off / a graded ladder / Custom),
**Advanced**, and **What the server did**.

The ladder is **generated per source**, not fixed, because the right ordering depends on the scale
ratio. Stages are built by adding sharpening, then super-resolution *only where the server would
actually run it*, then denoise, then stronger denoise at the top target — and are sorted by a cost
index derived from measured throughput, so cost is monotonic by construction. Each carries a GPU
cost hint. A stage is stored as a recipe (target rank, SR level, denoise), never as a bare number, so
it survives a change of source.

What that produces in practice:

| Source | Rungs | Recommended |
|---|---|---|
| 960x540 | 10 | 1080p, FSRCNNX + sharpen |
| 1280x720 | 9 | 1080p, sharpen only (1.5x — the network is bypassed, so there is no fake rung) |
| 720x960 (portrait) | 6 | — |
| 1920x1080 | 6 | — |
| 2160p | 0 | "already above the server's upscale limit — nothing to offer" |

Ten rungs need three eligible targets; a 1080p source has two, so it honestly gets six rather than a
padded ten. Nothing that measured worse than the default appears in the ladder — no `fsrcnnx-heavy`,
no Anime4K, no sharpening above `low`, no NVScaler. All of those remain available in **Advanced**,
which exposes upscale target (filtered to what is above the source), unblur, denoise, detail level,
debanding, and the libplacebo scaling kernel (whitelisted — an unknown kernel is ignored rather than
tried, because it would fail the whole job). Choosing anything there flips the indicator to Custom.

Targets are filtered using the server's own numbers from the probe, not values hardcoded in
JavaScript. A target between `MinScaleFactor` and `SrMinScaleFactor` is still offered, labelled
"(plain scaling at this ratio)", because the scale plus sharpener runs and measured well there.

## Off means direct play

The stored preference has three states, and "said nothing" is deliberately different from "said off":

- **unset** — the viewer has never opened the menu. The client sends nothing at all, so the server's
  own default applies (with `RequireClientOptIn = false`, eligible transcodes are still enhanced).
- **off** — an explicit opinion. The client marks the request `upscale=off&deblur=off&denoise=off`
  and **leaves direct play alone**, so the file direct plays exactly as stock Jellyfin would. The
  markers exist only so that a session which transcodes for some unrelated reason knows this is Off
  rather than silence. Server-side this suppresses the dashboard defaults too, so `ForceTranscode`
  has no plan to act on and a would-be stream copy stays a copy. Status: `off-by-client`.
- **a stage** — the client additionally sets `EnableDirectPlay=false` / `EnableDirectStream=false` on
  the PlaybackInfo *request*, because a direct-play response contains no `TranscodingUrl` to mark.

## Super-resolution levels

Level names carry **family and weight**, because these are different networks rather than rungs of
one ladder:

| Level | Shader | Licence |
|---|---|---|
| `off` | plain `ewa_lanczos` | — |
| `fsrcnnx` *(default)* | `FSRCNNX_x2_8-0-4-1` | igv, LGPL-3.0-or-later |
| `fsrcnnx-heavy` | `FSRCNNX_x2_16-0-4-1` | igv, LGPL-3.0-or-later |
| `fsrcnnx-max` | `FSRCNN_x2_r1_32-0-2` (API only, not menued) | igv, LGPL-3.0-or-later |
| `anime4k-s` | `Anime4K_Upscale_CNN_x2_S` | bloc97, MIT |
| `anime4k-m` | `Anime4K_Upscale_CNN_x2_M` | bloc97, MIT |
| `nvscaler` | `NVScaler` (NVIDIA Image Scaling v1.0.2) | NVIDIA, MIT |
| `ravu-zoom` | `ravu-zoom-r3` — **ratio-agnostic**, exempt from the SR bypass | bjin, LGPL-3.0-or-later |
| `cunny-fast` / `cunny` / `cunny-heavy` / `cunny-ds` | CuNNy int8 dp4a builds | funnyplanter, LGPL-3.0 |

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

## The non-2x ratio problem

FSRCNNX and Anime4K are fixed-2x networks. At other ratios libplacebo has to rescale their output,
and the detail they add shrinks with it. Measured detail gain over plain scaling, by ratio:

| Ratio | 1.41 | 1.50 | 1.70 | 1.90 | 2.00 |
|---|---|---|---|---|---|
| detail vs plain | **-2.2%** | **-0.3%** | +3.6% | +7.2% | +19.3% |

Below roughly 1.5x the network is doing nothing useful while costing GPU time. `SrMinScaleFactor`
(default **1.60**) skips it below that ratio; the upscale still happens with plain scaling, and the
session's unblur and denoise still run. The session record reports the bypass rather than implying
super-resolution ran.

Snapping the target so the ratio lands nearer 2x was measured and **rejected** — worse on fidelity,
worse on detail, and 78% more pixels shipped.

The full picture, measured on one clip in one run against a ground-truth detail of 3.5179:

| Ratio | Chain | PSNR | SSIM | detail |
|---|---|---|---|---|
| 1.50 | plain | 43.684 | 0.98583 | 3.2818 |
| 1.50 | plain + RCAS-2.0 | 43.518 | 0.98511 | **3.5950** |
| 1.50 | FSRCNNX + RCAS-2.0 | **43.714** | **0.98591** | 3.4304 |
| 1.50 | FSRCNNX alone | 43.766 | 0.98615 | 3.2726 |

Two things are true at once, which is why earlier readings looked contradictory. On **detail energy**
the network alone is worthless at 1.5x (3.2726 against plain scaling's 3.2818) and the sharpener alone
lands nearest ground truth. On **fidelity** the network never loses: FSRCNNX+RCAS beats plain+RCAS by
0.196 dB at 1.50x, 0.344 dB at 1.70x and 0.473 dB at 1.90x — the gain grows with the ratio and is
smallest exactly where the bypass sits.

So `SrMinScaleFactor = 1.60` is a **cost policy, not a quality cliff**: roughly 0.2 dB for about 15%
GPU, on a card that is usually shared, where the ~1% sharpener already reaches ground-truth detail.
Lower it on the dashboard with no rebuild and the quality ladder follows automatically.

## Two more axes: refine and chroma

Not every shader is a super-resolution level. Two hook different stages and therefore **compose with**
an SR level rather than replacing one, so each has its own control.

**`refine=ssimsuperres`** — SSimSuperRes (Shiandow, via igv; LGPL-3.0-or-later). Hooks `POSTKERNEL`:
it corrects an enlargement rather than producing one, adjusting the upscaled image so that downscaling
it reproduces the source. Because it is ratio-agnostic it is **exempt from `SrMinScaleFactor`**, so it
runs in the 1.15–1.60 band where the fixed-2x networks are bypassed — a band that previously had
nothing but plain scaling plus a sharpener.

**`chroma=krigbilateral`** — KrigBilateral (Shiandow, via igv; LGPL-3.0-or-later). Hooks `CHROMA`.
Every other shader here is luma-only, and these sources are 4:2:0, so chroma arrives at quarter
resolution and is otherwise left to libplacebo's default. This is the only level that touches it.

All four compose: `sr=fsrcnnx&deblur=low&refine=ssimsuperres&chroma=krigbilateral` resolves to a
single composed shader file, because the four hook points (LUMA, LUMA, POSTKERNEL, CHROMA) make
concatenation order bookkeeping rather than semantics. Only `sr` and `deblur` share a hook and remain
order-sensitive.

**`ravu-zoom` is exempt from the SR bypass too**, for a different reason: it is handed its output size
rather than being a fixed-2x network whose result gets shrunk back, which is the whole reason
`SrMinScaleFactor` exists.

## Sharpening: RCAS

| Level | Shader | `SHARPNESS` |
|---|---|---|
| `low` | `RCAS-2.0` | 2.0 |
| `medium` | `RCAS-1.7` | 1.7 |
| `high` | `RCAS-1.4` | 1.4 |

**RCAS's scale is inverted and clamped.** `0.0` is *maximum* sharpening, larger values are gentler,
and AMD's shader hard-clamps it into `[0, 2]` — so anything above 2.0 is silently identical to 2.0.
A gentler rung than `low` is not reachable without editing the clamp and going off-spec.

RCAS replaced this project's own CAS shaders, which measured worse on every axis. Against a 720p
ground truth with FSRCNNX upstream:

| Chain | 1.5x PSNR / SSIM | 2.0x PSNR / SSIM |
|---|---|---|
| **FSRCNNX + RCAS-1.7** | **43.668 / 0.98579** | **41.257 / 0.98108** |
| FSRCNNX + CAS-low | 43.394 / 0.98512 | 40.782 / 0.97924 |

Detail energy at 2.0x (ground truth 3.5179): RCAS 2.0/1.7/1.4 measured 3.709 / 3.793 / 3.883,
against CAS low/medium/high at 4.185 / 4.480 / 5.719. CAS was not finding detail, it was overshooting
— visible as a bright halo on the light side of high-contrast edges, and as flat-area compression
mottle lifted into speckle.

The CAS shaders are still installed and remain reachable through the API as `cas-low` / `cas-medium`
/ `cas-high` as a rollback path. They are not offered in the menu.

**NVSharpen** (NVIDIA Image Scaling v1.0.2, MIT) is also available, as `nvsharpen` and
`nvsharpen-strong` (SHARPNESS 0.25 and 0.65). It was measured against RCAS in the same slot, same
clip, same run at 1.5x: FSRCNNX+NVSharpen 0.25 gave PSNR 43.012 / SSIM 0.98571 / detail 3.5720
against a ground truth of 3.5179, versus FSRCNNX+RCAS-2.0 at 43.714 / 0.98591 / 3.4304, and cost
1.54 s per 300 frames against RCAS's 1.34 s (plain 1.13 s). It lands detail slightly nearer ground
truth but gives up 0.70 dB of fidelity for roughly ten times RCAS's overhead, and at 0.65 it
overshoots badly (detail 4.0118). **RCAS keeps the default slot**; NVSharpen is offered because it is
stable and the difference is a matter of taste.

*Trap, same class as the EASU one:* NVSharpen ships with a `//!WHEN` guard that fires only when there
is no scaling at all in either direction, so in this chain the pass would silently never run — a
no-op that measures as "no difference" and reads like a result. The installer strips the guard and
asserts it is gone.

**NVScaler sharpens inside its own pass**, so when it is selected the server drops the separate
sharpening pass rather than stacking two sharpeners into ringing, and reports that it did.

## Denoise

| Level | Filter | Kind |
|---|---|---|
| `light` | `atadenoise` | adaptive **temporal**, CPU — runs before `hwupload` |
| `strong` | `nlmeans_vulkan` | **spatial**, Vulkan — runs after `hwupload` |
| `max` | `nlmeans_vulkan=s=2.0` | spatial, strongest |
| `oidn` | Intel Open Image Denoise | neural, CUDA — **advanced only, needs a patched ffmpeg** |
| `optix` | NVIDIA OptiX AI denoiser | neural, spatial — advanced only, patched ffmpeg |
| `optix-temporal` | OptiX temporal model | neural, reprojected with NVOFA optical flow |

The ladder climbs in cost **and changes family**, which is deliberate: a temporal filter attacks
flicker between frames, a spatial one attacks per-frame grain, and only the spatial one removed heavy
synthetic grain in testing. The old names remain reachable through the API as `atadenoise`,
`nlmeans` and `nlmeans-strong`.

Measured on stable content at 720p→1440p: `atadenoise` costs 0.20 dB for a 30% flicker reduction at
124 fps, where `nlmeans_vulkan` costs 0.35 dB for 2% at 60 fps — better and roughly twice as fast, so
it takes the cheap rung.

**What this is honestly worth on compressed sources.** On real low-bitrate material (1–2.2 Mbps
sub-1080p, ~0.085 bits/pixel/frame) `atadenoise` still wins — 11–14% flicker removed for essentially
no detail cost, at 10–13% of throughput against nlmeans' 52–54% — but that is about half the gain
measured on cleaner clips, because the encoder has already removed much of the temporal noise. On a
CRF 28 re-encode there is nothing left to denoise at all, and every filter lands within ±0.05 dB.
Against the undenoised chain these outputs differ by around 50 dB, roughly one level in 255: **this
is a cost reduction, not a visible picture improvement.**

**It can also hurt.** On two high-bitrate 1080p sources that were only ~55% still, `atadenoise`
*increased* flicker by 17% and 33% — an adaptive temporal filter appears to add temporal error on
moving content. That is a reason denoise stays off by default and does not sit in a low rung of the
quality ladder.

Measured by degrading a clean source (noise plus a low bitrate), then scoring recovery against the
undegraded original — so noise removal counts as gain rather than as lost "detail".

**`hqdn3d` was retired.** It recovered 0.009 dB of the 3.411 dB the noise cost, and turning it up
made things worse: it trades noise for blur one for one. In side-by-side stills it is hard to
distinguish from no denoising at all.

**`tmix` was rejected too, and deliberately not added despite being cheap.** On a clip that was 96.2%
still, `tmix3` drove temporal error from 0.038 to 0.216 and SSIM from 0.985 to 0.964. A 1.4% moving
region is enough for an unaligned temporal average to ghost. The adaptive filter is the safe one.

Denoise costs roughly 60% of throughput, so it is off by default and belongs as an opt-in tier.

**Guardrail, documented rather than automated:** sharpening a visibly noisy source *without*
denoising first measured worse than not sharpening at all. There is no noise estimate available where
the chain is built, so no heuristic was invented — the config page states it beside the control.

## Intel Open Image Denoise (`denoise=oidn`)

A neural denoiser, running OIDN's RT filter on CUDA. It is **advanced-only, off by default, and needs
a separately built ffmpeg** — see [OIDN.md](OIDN.md) for the filter source, the build patch and full
reproduction instructions.

There is no OIDN filter in upstream FFmpeg and no maintained wrapper anywhere, so
[`ffmpeg/vf_oidn.c`](ffmpeg/vf_oidn.c) is new work. It is published here because that gap is real.

**How it is wired, and why it cannot break normal playback.** The stock `jellyfin-ffmpeg` is left
untouched; the patched build lives beside it, and the ffmpeg shim routes per session — an `oidn` node
in the filter chain goes to the patched binary, everything else to stock. If the patched binary is
missing, the `oidn` node is **stripped from the chain** so that session plays without denoise instead
of failing on an unknown filter name.

**Placement.** OIDN 2.x has no Vulkan backend, so the level emits
`format=gbrpf32le,oidn=quality=high:srgb=0,format=yuv420p` and runs **before** `hwupload`, alongside
`atadenoise`. No hardware round trip is needed. (An after-`hwupload` variant with
`hwdownload`/`hwupload` was also built and measured within ~5% — the round trip is not the expensive
part.)

**Performance, and the one thing that matters if you rewrite this filter.** Handing OIDN plain host
memory via `oidnSetSharedFilterImage` gave **11 fps** at 720p→1080p. Allocating with
`oidnNewBufferWithStorage(..., OIDN_STORAGE_MANAGED)` and packing into the mapped pointer gave
**42 fps** on the same chain. That 4x is the difference between a demo and something borderline usable.

**Is it usable?** Borderline, and it depends on your source framerate. OIDN holds 34–46 output fps
regardless of target resolution — the filter sets the rate, not the scale. On 24–30 fps material that
clears realtime for one session with no room for a second. On 47–60 fps sources it does not sustain
realtime at all.

**What it is actually for.** On compressed sources it is very close to a no-op: against the
undenoised output it measures 56–65 dB with detail energy changed by under 2%, which is the same
picture. On genuinely grainy material it removes the grain completely while leaving hair strands,
highlights and lash lines intact and inventing nothing — where `atadenoise` leaves that grain
visually untouched. A high bitrate alone is not grain, so most libraries will see nothing from it.

## NVIDIA OptiX (`denoise=optix`, `denoise=optix-temporal`)

The counterpart to OIDN, and the only level here with a **temporal** model — it reprojects the
previous denoised frame using motion vectors, which is what a purely spatial denoiser cannot do.
See [OPTIX.md](OPTIX.md) for the filter source and build steps.

`ffmpeg/vf_optix.c` is ours. It needs **no CUDA toolkit**: OptiX and the optical-flow engine are both
`dlopen()`ed out of the display driver, and the filter writes no GPU kernels. Motion vectors come from
**NVOFA**, the fixed-function optical-flow engine on Turing and later, so the flow costs neither SM
time nor CPU time.

**Measured flicker reduction** on a grainy source, against the undenoised chain:

| level | flicker |
|---|---|
| `atadenoise` | −7% |
| `oidn` | −61% |
| `optix` (spatial) | **−66%** |
| `optix-temporal` | −60% |

Two results worth stating plainly. **`atadenoise` holds the cheap rung on cost, not merit** — and on a
clean source it *adds* about 35% flicker. And **the temporal model does not beat the spatial one on
grainy material**, because the flow is estimated from the same noisy picture the denoiser is cleaning.
The reprojection itself is correct: on a clean moving source, real flow beats a zero field (statTD
0.342 against 0.397). Noise defeats the flow, not the plumbing.

A zero-flow temporal mode scores *best* of all on flicker (−74%) and is deliberately **not** the
default: that is stability bought by averaging across motion, the same trap already recorded for
`tmix`. It remains available as `flow=none` for diagnosis.

Throughput on a 1280x720 source (300 frames, shared GPU): `optix` 49.9 / 49.4 / 40.9 fps and
`optix-temporal` 39.6 / 38.1 / 33.1 fps at 1080p / 1440p / 2160p, against `oidn` at 35.7 / 34.7 / 29.7
and no denoise at 120.5 / 107.4 / 64.5.

**Licensing differs from OIDN and matters here.** OIDN is Apache-2.0; OptiX is NVIDIA proprietary. The
filter source is ours and publishes cleanly, but **no NVIDIA headers, binaries or SDK material are
vendored** — you must obtain the OptiX headers (NVIDIA EULA, publicly downloadable but not open
source), the Optical Flow SDK headers (3-clause BSD) and matching `nv-codec-headers` yourself.
OPTIX.md lists exactly what and from where.

**A driver change is a new risk class.** OptiX lives *inside* the driver and negotiates an ABI at
`optixInit()`, with a second handshake for NVOFA — so these levels can change or break with nothing
here rebuilt, which a `jellyfin-ffmpeg` upgrade cannot do. After a driver change, re-run
`-h filter=optix` and a short temporal encode.

## Configuration

Dashboard → Plugins → GPU Upscale. Defaults suit a single busy GPU:

| Setting | Default | Notes |
|---|---|---|
| `TargetHeight` | 1080 | used when a session names no target |
| `MaxTargetHeight` | 2160 | hard ceiling |
| `SrLevel` | `fsrcnnx` | default super-resolution level |
| `DeblurLevel` / `DeblurAllowed` | `off` / true | RCAS sharpening; SR already sharpens, so default off |
| `DenoiseLevel` / `DenoiseAllowed` | `off` / true | `light` = nlmeans_vulkan, `strong` = nlmeans_vulkan s=2.0 |
| `SrMinScaleFactor` | 1.60 | below this ratio the SR network is skipped (see below); 0 disables |
| `Deband` | true | with `grain=0` |
| `MinScaleFactor` | 1.15 | skip near-identity upscales entirely |
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

Optional denoise runs **before** the upscale, on the GPU via `nlmeans_vulkan` after `hwupload`.

Sharpening is **RCAS**, derived from AMD FidelityFX FSR v1.0.2. It hooks `LUMA`, so it runs at the
super-resolution shader's output size rather than at the final output size — at a 4K target that is
a quarter of the pixels, which is why it costs roughly 1% where a `MAIN`-hooked sharpener costs 12%.

## How a viewer's choice reaches the server

Jellyfin's `ParseStreamOptions` copies **every lowercase-initial query parameter** into the request's
`StreamOptions` dictionary, readable server-side via `GetOption(...)`. Nothing clamps or rewrites it.
The injected client therefore appends
`&upscale=1440&sr=fsrcnnx&deblur=medium&denoise=light&deband=on&kernel=ewa_lanczos`.

A requested *bitrate* would not survive — Jellyfin clamps it to the source bitrate before
`EncodingHelper` sees it — which is why an earlier sentinel-bitrate approach was abandoned.

**Direct play has no transcode to enhance**, so when (and only when) a viewer selects enhancement,
the client also sets `EnableDirectPlay=false` / `EnableDirectStream=false` on the PlaybackInfo
*request*. Marking the response cannot work: a direct-play response contains no `TranscodingUrl` to
mark, and clearing `SupportsDirectPlay` there would leave the player with nothing to fall back to.

## Fallback: the ffmpeg shim

`shim/jellyfin-ffmpeg-upscale` is a standalone Python wrapper that rewrites the transcode command
without any Harmony patching, wired in via `JELLYFIN_FFMPEG_OPT=--ffmpeg=...`. It is less capable
(it infers intent from the command line rather than from the session) but survives Jellyfin changes
that break the patches. It stands down automatically while the plugin's patches are active.

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

## What was tried and rejected

**FSR's EASU upscaler.** Correctly isolated, EASU measured *worse than plain `ewa_lanczos`* on
fidelity while adding only modest detail: its directional analysis was designed for clean rasterised
input and locks onto compression-noise gradients in low-bitrate h264. Tuning the sharpening after it
only trades ringing for softness around a worse operating point. Only FSR's **RCAS** pass survived
evaluation, and it is what this project now uses.

*Measurement trap worth knowing if you re-test this:* in the stock `FSR.glsl`, EASU writes to a
scratch texture (`//!SAVE EASUTEX`) and only the RCAS pass writes back to `LUMA`. Strip RCAS to
measure "EASU alone" and you measure a no-op — you get exactly the plain-scaling number. Remove the
`//!SAVE` line so EASU writes back.

**FSR2 / FSR3 / FSR4 and DLSS.** All are temporal upscalers that require renderer data recorded video
does not contain: depth, screen-space motion vectors, and sub-pixel camera jitter. AMD's own API makes
`jitterOffset` mandatory and warns that the jitter sequence must never be a null vector — which is
exactly what a fixed sensor produces on every frame. Motion vectors could be approximated with optical
flow and depth with a monocular estimator, but jitter cannot be synthesised after the fact: temporal
upscalers reconstruct detail by accumulating sub-pixel samples that a renderer deliberately offset,
and a camera sampled the same grid every frame. FSR4 additionally requires RDNA3/4 hardware, and the
current SDK targets DX12 on Windows.

**Temporal video super-resolution** (BasicVSR++, RealBasicVSR). These are the video-native answer to
"use multiple frames": they estimate motion from the frames themselves and need no jitter, depth or
renderer data. They were measured properly, and rejected on two independent grounds.

*There is no quality headroom left.* Against a ground truth of untouched 720p frames, the deployed
shader chain reconstructs **103%** of the reference's detail energy. BasicVSR++ reconstructs **102%**
— a tie — while running **33x slower** (5.9 fps against 196 at a 1440p output on a 640x360 source).
A generous 3x TensorRT win would still leave it under 1x realtime for a *single* session.

*And the temporal behaviour was worse, not better.* Measuring still-pixel variation across frames,
per-frame shaders sit at the same value as plain scaling — they add no crawl. BasicVSR++ raised it
**27%**: its recurrent state carries sensor noise forward and re-injects it. RealBasicVSR failed
outright on low-motion footage (PSNR 15.76 static against 32.64 moving, same model and settings),
which is the documented divergence of recurrent VSR on long static sequences (MRVSR, CVPR 2022,
arXiv:2112.08950). In the stills it appears as oil-paint craquelure that *moves while the face does
not*.

There is also no fast runtime path: **vs-mlrt ships no multi-frame VSR model at all** (its catalogue
is entirely one-frame-in, one-frame-out), and the recurrent hidden state is what blocks ONNX export.

**Generative super-resolution** (Real-ESRGAN family, and diffusion). GAN models are fast enough to
consider — `realesr-animevideov3` reached 127 fps — but they restructure faces. At 4x zoom: skin
airbrushed to flat porcelain with pore mottle and sensor noise erased, eyebrows redrawn as solid
hard-edged shapes with the individual hairs gone, eyelids gaining a drawn outline that is not in the
source. Recognisably the same person, but it reads as *an illustration of her* rather than *a
photograph of her*. They measure 127-195% of ground-truth detail energy, which is invention rather
than recovery, and they score worse on fidelity while doing it.

That trade may be acceptable for stylised content. It is not acceptable if the footage is ever
treated as a record of something: Real-ESRGAN is independently measured to reduce ArcFace identity
similarity while improving perceptual metrics, and AI-enhanced video of this kind was excluded from a
US criminal trial under a Frye hearing (*State of Washington v. Puloka*, 2024) for creating false
detail.

Diffusion is not a candidate at all. One-step distilled models (OSEDiff, AdcSR, TSD-SR) take
0.08-0.15 s for a *512x512* output on an RTX 3090; 1080p is 7.9x the pixels with superlinear
attention, so roughly 0.7-2.5 s per frame — 25-50x off realtime. Multi-step models (SUPIR, StableSR)
take 10-100 s per 512x512 image and carry non-commercial licences.

**Frame generation** was considered and dropped: this project is about upscaling.

**Multi-frame accumulation and FSR2/FSR3's jitter requirement**, closed by a library-scale survey:
430 measurements across 242 recordings and 189 performers. FSR2's `jitterOffset` is a single global
`float2` — there is no per-pixel jitter input anywhere in its API — and it addresses lock creation,
not just the upsample kernel. Measured against that: only 39.8% of textured blocks move within
0.25 px of the frame's global estimate, against a total jitter budget of ±0.5 px, and 57% of pixels
move less than 0.05 px at all.

The tempting counter-argument — that *some* content is handheld and would qualify — was tested and
failed. Applied naively the criteria pass 17% of clips, but that is an artefact: phase correlation
returns a confident peak and every block agrees with it precisely when the global motion is *zero*.
Adding the requirement that the whole frame actually be displaced collapses it to **0.7%, then 0.2%,
then 0.0%** under the full criterion. One measurement in 430 was genuinely handheld, and a classical
multi-frame prototype lost **1.18 dB to plain Lanczos on that clip** while raising temporal error 36%.

Stability is also not a property of a performer: ~2x enrichment between clips five minutes apart,
collapsing to near base rate across dates. Of 183 performers measured more than once, only 10 were
consistently stable. So it cannot be cached as a per-source preset, and detecting it per segment costs
the optical-flow pass it was meant to save.

The useful diagnostic from that work, worth reusing: **if accumulation were recovering real sub-pixel
detail, fidelity would rise with detail energy.** Where detail is bought purely at fidelity's expense,
what is being added is injected error from imperfect alignment, not recovered signal.

### If you want to re-open any of this

Bring a temporal model with released weights, a working TensorRT path, **and** a measured >100 fps at
640x360 on Ampere — or evidence that the deployed chain is leaving detail on the table, which the
ground-truth-referenced measurement says it is not.

Two measurement traps cost a full pass of this work, so they are worth repeating: these captures are
**VFR**, and ffmpeg's `psnr`/`ssim` framesync pairs by PTS, so comparing a CFR model output against a
VFR reference silently compares misaligned frames (it reported a good model at 16-24 dB). Compute
metrics by frame index instead. And **libplacebo shifts luma by about -9/255 on untagged clips**,
which quietly penalises every shader chain against a non-libplacebo reference; `-color_range pc` in,
`tv` out fixes it.

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
