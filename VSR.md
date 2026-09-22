# NVIDIA Maxine Video Effects SDK - Video Super Resolution, and why there is no `vf_vsr.c` yet

Status: **blocked at Step 0.** This is a documentation-only stop, matching what `OPTIX.md`/`DLSS.md`
already record for their own proprietary dependencies - except here the blocker is acquisition, not
API shape. Nothing in `ffmpeg/` was touched. No patch file exists. This document exists so the next
session (or the user, fetching the file by hand) doesn't repeat the same research.

## What this would have been

NVIDIA's Maxine VFX SDK ships a Video Super Resolution effect (`NVVFX_FX_SUPER_RES`, string
`"SuperRes"`) that is **pure CUDA** - `NvCVImage` buffers in `NVCV_CUDA` memory, every transfer/run
call takes an explicit `CUstream`, no D3D11 or Vulkan anywhere in the SDK. That makes it a
genuinely different GPU-residency shape from every SR path this project already has: it would sit
in the same category as `vf_optix.c`/`vf_ort.c` (pure CUDA, in principle chainable with them via
`AV_PIX_FMT_CUDA` hw frames per the Tier 1 plan in `ARCHITECTURE.md`), and it targets plain
recorded video rather than needing synthesised motion vectors/depth/jitter the way `vf_dlss.c` and
`vf_fsr2.c` do. Confirmed API surface (read from the actual headers, not guessed) is in
`vfx-sdk-vsr-task.md`.

## What's confirmed present, and how it was checked

- **Not installed anywhere on CT114.** `find / -iname '*maxine*' -o -iname '*nvvfx*' -o -iname
  '*nvVideoEffects*' -o -iname '*nvCVImage*'` inside the container turns up nothing but an
  unrelated music file. `/root/gameupscale/` (where the DLSS/OptiX/FSR2 SDKs live) has no Maxine
  directory.
- **The open-source half is genuinely fetchable, no auth.** `github.com/NVIDIA-Maxine/Maxine-VFX-SDK`
  is a public repo, `curl`/GitHub API reachable from CT114 without credentials. It contains
  `nvvfx/` (the API headers and the proxy-linking source, MIT, `Copyright (c) 2021 NVIDIA
  Corporation` - checked the actual `LICENSE` file and a header's own license block, both plain
  MIT text) and `samples/`. **No model weights and no compiled runtime library live in this repo.**
  Its own `README.MD` says so explicitly: "NVIDIA MAXINE VideoEffects SDK is distributed in the
  following parts: this open source repository ... [and] an installer hosted on NVIDIA Maxine
  End-user Redistributables page that installs the SDK DLLs, the models, and the SDK dependency
  libraries."

## What's not fetchable without an interactive login

- **The redistributables page is Windows-only.** `https://www.nvidia.com/broadcast-sdk-resources`
  lists exactly four Video Effects SDK downloads, all `.exe` installers keyed to Windows GPU
  generation (`nvidia_video_effects_sdk_installer_v0.7.6_{blackwell,ada,ampere,turing}.exe`). No
  login is required for those, but they install nothing that runs on this project's Linux
  container - dead end for CT114 regardless of login.
- **A Linux package does exist, but no direct public URL for it does.** The VFX SDK System Guide
  (`docs.nvidia.com/deeplearning/maxine/vfx-sdk-system-guide/`) has a full "2.2 Installing the
  NVIDIA Video Effects SDK for Linux" section: the SDK is delivered as an
  `NVIDIA_VFX_SDK_<OS>_<version>.tar.gz`, extracted to `/usr/local/VideoFX`, with prerequisite
  links given for CUDA/TensorRT/cudnn (all three `developer.nvidia.com`, no-login public pages).
  The install command in that guide (`sudo tar -xvf NVIDIA_VFX_SDK_<OS>_<version>.tar.gz -C
  /usr/local`) assumes you already have the file - **the guide never gives a URL to fetch it
  from.**
- **The SDK's own "getting started" link goes behind a login wall.** The repo README points to
  `developer.nvidia.com/maxine-getting-started` for more information. That URL 301-redirects to
  `https://catalog.ngc.nvidia.com/orgs/nvidia/teams/maxine/collections/maxine` - NVIDIA's NGC
  (NVIDIA GPU Cloud) catalog. NGC resource downloads are gated behind an NGC/NVIDIA Developer
  Program account; the catalog page itself did not render without one in this session (fetched
  404 through an unauthenticated client, consistent with a login-gated SPA route rather than a
  missing page - the OSS repo's own README links there as the canonical place to get the rest of
  the SDK, so the page exists, it is just not reachable without an account).

This is exactly the shape `DLSS.md` documents for `libnvidia-ngx-dlss.so`: open headers and glue
code are public and MIT, the trained model plus its runtime `.so` are a separate NVIDIA download
gated behind registration, obtained by a human with an NVIDIA Developer Program account, not by a
script running non-interactively on this box.

## What the user needs to fetch and place by hand

1. Create (or use an existing) NVIDIA Developer Program account, log in at
   `catalog.ngc.nvidia.com/orgs/nvidia/teams/maxine/collections/maxine` (reached from
   `developer.nvidia.com/maxine-getting-started`).
2. Find and download the **Linux** Video Effects SDK redistributable package - named
   `NVIDIA_VFX_SDK_<OS>_<version>.tar.gz` per the System Guide's own install command; the exact
   current filename and version were not observed in this session, since the download itself needs
   the login this session does not have. Do not guess the filename - confirm it from the actual
   NGC page or download manager once logged in.
3. Place it on CT114 the same way `DLSS.md` documents for the DLSS runtime: extract to
   `/usr/local/VideoFX` per the System Guide (or mirror this project's existing convention and put
   it under `/root/gameupscale/vfx/` alongside the other unvendored SDKs, then point a `VFX_SDK`
   env var at it - match whichever convention `build-ffmpeg.sh` ends up using once `WITH_VSR` is
   wired, see below).
4. Confirm the driver clears the SDK's own minimum: Linux driver **570.190+, 580.82+, or 590.44+**
   depending on branch (checked directly on `docs.nvidia.com/maxine/vfx/latest/Filters/
   VideoSuperResolution.html`). CT114 runs 595.84 - already clears every branch's minimum.
5. Report back once placed, so `ffmpeg/vf_vsr.c`, the `WITH_VSR` build flag, and the plugin-side
   wiring in `vfx-sdk-vsr-task.md`'s implementation steps can actually be written and verified
   against real headers/model files on the box - not attempted yet, deliberately, per this
   project's "don't write code against an API whose presence hasn't been confirmed" rule
   (`AGENTS.md`, `CLAUDE.md`).

## Licensing, once it is fetched

- `nvvfx/` headers and sample/proxy-linking source from the GitHub repo: **MIT**,
  `Copyright (c) 2021 NVIDIA Corporation`. Copies straight into this repo with the header intact,
  same as any other MIT dependency here (`AGENTS.md`'s licensing section).
- The trained model files and the compiled runtime library from the NGC-gated redistributable:
  **NVIDIA proprietary**, whatever EULA the NGC/Maxine End-user Redistributables download presents
  at accept-time (not read yet - read it before installing, same discipline `DLSS.md` and
  `OPTIX.md` already followed for their own proprietary blobs). Not vendored into this GPL tree,
  same as the DLSS runtime and the OptiX SDK: fetched and placed by the operator, linked against at
  build time, never committed.

## Driver/GPU requirements (confirmed, not guessed)

- Linux driver 570.190+/580.82+/590.44+ depending on branch (`docs.nvidia.com/maxine/vfx/latest/
  Filters/VideoSuperResolution.html`). CT114: 595.84, clears all three.
- `STREAMING_MEDIUM`/`STREAMING_ULTRA` quality modes require Ampere or later. CT114's RTX 3090 is
  Ampere, compute capability 8.6 - qualifies for the best tiers, not just the baseline ones.
- SDK-wide (`README.MD`, "System requirements"): Turing, Ampere, Ada or Blackwell architecture with
  Tensor Cores. RTX 3090 qualifies.

## Nothing measured

No fps number, no filter file, no build. This document is the entire deliverable of this
investigation. See `vfx-sdk-vsr-task.md` for the original task brief and the confirmed API surface
that implementation should follow once the SDK is on the box.
