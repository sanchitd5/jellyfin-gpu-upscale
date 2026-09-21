# Installing GPU Upscale from scratch

A complete walkthrough, from a plain Jellyfin server to working realtime upscaling.

Everything here was done on **Jellyfin 12.1.0**, Ubuntu 24.04, an **NVIDIA RTX 3090** with driver
595.84, inside an **unprivileged Proxmox LXC** with GPU passthrough. Adjust paths to your setup.

> This installs software that patches Jellyfin's running code. Take a backup of
> `/var/lib/jellyfin` and `/usr/share/jellyfin/web/index.html` before you start, and read
> [Uninstalling](#uninstalling) so you know the way out.

---

## 0. Check your server can actually do this

Three things must be true before anything else is worth trying.

**ffmpeg needs libplacebo, Vulkan and shaderc:**

```bash
/usr/lib/jellyfin-ffmpeg/ffmpeg -hide_banner -buildconf | grep -E "libplacebo|vulkan|libshaderc"
```

Expect `--enable-libplacebo`, `--enable-vulkan`, `--enable-libshaderc`. `jellyfin-ffmpeg8` ships
with all three. If they are missing, stop — nothing here will work.

**The GPU must be usable from wherever Jellyfin runs.** In a container that means the NVIDIA
*userspace* driver, matching the host kernel module version exactly:

```bash
nvidia-smi                       # must print your GPU and driver version
ls /usr/lib/x86_64-linux-gnu/ | grep -c libnvidia-encode
```

A container with `/dev/nvidia*` passed through but no userspace libraries will show the devices and
still fail to encode. Install the same driver version as the host with
`./NVIDIA-Linux-x86_64-<version>.run --no-kernel-module --silent`.

**A quick end-to-end proof, as the jellyfin user:**

```bash
sudo -u jellyfin /usr/lib/jellyfin-ffmpeg/ffmpeg -hide_banner -loglevel error \
  -init_hw_device vulkan=vk:0 -filter_hw_device vk \
  -f lavfi -i testsrc=size=1280x720:rate=30 -t 2 \
  -vf "format=yuv420p,hwupload,libplacebo=w=1920:h=1080:upscaler=ewa_lanczos,hwdownload,format=yuv420p" \
  -c:v hevc_nvenc -f null - && echo OK
```

If that prints `OK`, the hard part of your environment is already right. If it fails on permissions,
add the service user to the `video` and `render` groups.

---

## 1. Install the shaders

```bash
sudo ./scripts/install-shaders.sh
```

This fetches FSRCNNX (igv, LGPL-3.0-or-later) and Anime4K (bloc97, MIT) from their upstream
releases, derives the RCAS sharpening shaders from AMD's FSR (MIT, via agyild's mpv port) using
`shaders/make-rcas.sh`, and installs this project's CAS shaders as a rollback path. Nothing upstream
is vendored, so each licence stays attached to the file it belongs to.

Result, in `/usr/share/jellyfin-shaders/`:

```
FSRCNNX_x2_8-0-4-1.glsl        FSRCNNX_x2_16-0-4-1.glsl
Anime4K_Upscale_CNN_x2_S.glsl  Anime4K_Upscale_CNN_x2_M.glsl
RCAS-2.0.glsl  RCAS-1.7.glsl  RCAS-1.4.glsl
CAS-low.glsl   CAS-medium.glsl  CAS-high.glsl
```

The installer verifies the fetched FSR file carries AMD's version string and MIT header before
deriving anything. `FSR_GLSL=/path/to/FSR.glsl` installs from a local copy for an offline build.

The directory must be readable by the Jellyfin service user.

---

## 2. Build the two assemblies

There are **two** projects, and they must stay separate — see
[Why two assemblies](#why-two-assemblies) if you are tempted to merge them.

```bash
export DOTNET_ROOT=/opt/dotnet            # wherever your SDK lives
export PATH="$DOTNET_ROOT:$PATH"

# match the runtime Jellyfin itself uses
cat /usr/lib/jellyfin/bin/jellyfin.runtimeconfig.json

dotnet publish src          -c Release -p:JellyfinBin=/usr/lib/jellyfin/bin -o ./out
dotnet publish src/patcher  -c Release -p:JellyfinBin=/usr/lib/jellyfin/bin -o ./out-patcher
```

`JellyfinBin` points at your server's assemblies, which the projects reference directly rather than
guessing NuGet versions.

**Lib.Harmony must be 2.4.2 or newer.** 2.4.1 refuses .NET 10 outright with
`CoreCLR version 10.0.12 is not supported`.

---

## 3. Put the files where they belong

```bash
V=1.0.0.0

# the plugin, in Jellyfin's plugin directory
sudo mkdir -p /var/lib/jellyfin/plugins/GpuUpscale_$V
sudo cp out/Jellyfin.Plugin.GpuUpscale.dll out/Jellyfin.Plugin.GpuUpscale.deps.json \
        /var/lib/jellyfin/plugins/GpuUpscale_$V/

# the patcher, deliberately OUTSIDE the plugin directory
sudo mkdir -p /usr/lib/jellyfin-gpuupscale
sudo cp out-patcher/Jellyfin.Plugin.GpuUpscale.Patcher.dll out-patcher/0Harmony.dll \
        /usr/lib/jellyfin-gpuupscale/

# the client script — this copy is CANONICAL
sudo cp web/gpu-upscale.js /usr/lib/jellyfin-gpuupscale/gpu-upscale.js

sudo chown -R jellyfin:jellyfin /var/lib/jellyfin/plugins/GpuUpscale_$V
```

Write `/var/lib/jellyfin/plugins/GpuUpscale_$V/meta.json`:

```json
{
  "guid": "6f2a9c31-4d7b-4e2a-9d15-8a1c0b7e3f44",
  "name": "GPU Upscale",
  "version": "1.0.0.0",
  "targetAbi": "12.1.0.0",
  "owner": "",
  "overview": "Realtime GPU super-resolution upscaling",
  "category": "General"
}
```

`targetAbi` pins the plugin to a Jellyfin version — a later server may refuse to load it until you
raise this.

---

## 4. Inject the client script

```bash
sudo cp scripts/jellyfin-gpuupscale-webinject /usr/local/sbin/
sudo chmod +x /usr/local/sbin/jellyfin-gpuupscale-webinject
sudo /usr/local/sbin/jellyfin-gpuupscale-webinject
```

This copies `/usr/lib/jellyfin-gpuupscale/gpu-upscale.js` into `/usr/share/jellyfin/web/`, adds a
`<script>` tag to `index.html`, and bumps a cache-busting version.

**Never edit `/usr/share/jellyfin/web/gpu-upscale.js` directly.** The injector overwrites it from
the canonical copy in `/usr/lib/jellyfin-gpuupscale/`, so a direct edit gets silently reverted while
the cache-buster still advances — meaning browsers cache the *old* script under a *new* URL. Edit
the canonical copy, then re-run the injector.

Survive package upgrades, which replace `index.html` and delete the script:

```bash
sudo cp scripts/99-jellyfin-gpuupscale /etc/apt/apt.conf.d/
```

---

## 5. Start it and confirm the patches installed

```bash
sudo systemctl restart jellyfin
sudo journalctl -u jellyfin --since "-2 minutes" | grep GpuUpscale
```

You want to see:

```
GpuUpscale: patched GetVideoProcessingFilterParam
GpuUpscale: patched GetInputVideoHwaccelArgs
GpuUpscale: patched GetHwaccelType
GpuUpscale: patched GetHardwareVideoDecoder
GpuUpscale: patched GetVideoEncoder
GpuUpscale: Harmony patches installed, plugin owns the transcode filter chain.
GpuUpscale: active (5 EncodingHelper methods patched); optional: direct-play override
```

If instead it names methods it could not resolve, your Jellyfin version has moved them — see
[Troubleshooting](#troubleshooting).

---

## 6. Configure

Dashboard → Plugins → **GPU Upscale**. Sensible starting point:

- `SrLevel` = `fsrcnnx` (the default; Anime4K only competes at its native 2x ratio)
- `SrMinScaleFactor` = 1.60 — below this ratio the SR network is skipped, because fixed-2x networks
  measure at or below plain scaling there. Sharpening and denoise still run
- `MaxConcurrent` = 2 to start, raise once you have watched real GPU load
- `RequireClientOptIn` = true, so nothing is enhanced until a viewer asks
- `ForceTranscodeForDirectPlay` = false until you have read what it costs

---

## 7. Prove it actually works

Do not trust the dashboard. Play something, then look at what was served.

```bash
# what command did Jellyfin build?
sudo journalctl -u jellyfin --since "-5 minutes" | grep -E "libplacebo|GpuUpscale:"

# what resolution did the viewer receive?
/usr/lib/jellyfin-ffmpeg/ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height -of csv=p=0 \
  /var/cache/jellyfin/transcodes/<id>0.ts
```

A served segment **larger than the source file** is the only proof that matters. The log line reads
like `GpuUpscale: Upscaled 1280x720 to 1920x1080 (fsrcnnx), deband`.

In the browser: hard-reload (Ctrl/Cmd-Shift-R), play something, open the quality/settings menu and
look for **Enhance**. In the console, `window.__gpuUpscale` should report `installed: true` and
`serverCaps {full: true}`.

---

## Why two assemblies

Jellyfin loads plugins into a **collectible** `AssemblyLoadContext`, and Harmony cannot emit detours
against one:

```
System.NotSupportedException: Resolving to a collectible assembly is not supported
```

So the patching code lives in a second assembly that the plugin loads into the *default* context
with `AssemblyLoadContext.Default.LoadFromAssemblyPath(...)`.

It must sit **outside** `/var/lib/jellyfin/plugins/`, because Jellyfin enumerates plugin DLLs with
`SearchOption.AllDirectories` — even a subfolder would be pulled into the collectible context and
the patching would fail again. The two sides exchange only primitives (JSON strings, an
`object`-typed logger), so no type crosses the boundary.

---

## Optional: the ffmpeg shim fallback

`shim/jellyfin-ffmpeg-upscale` rewrites the transcode command without any Harmony patching. It is
less capable — it infers intent from the command line rather than the session — but it survives
Jellyfin changes that break the patches.

```bash
sudo cp shim/jellyfin-ffmpeg-upscale /usr/local/bin/
sudo chmod +x /usr/local/bin/jellyfin-ffmpeg-upscale
sudo ln -sf /usr/lib/jellyfin-ffmpeg/ffprobe /usr/local/bin/ffprobe   # required, see below
sudo sed -i 's#JELLYFIN_FFMPEG_OPT=.*#JELLYFIN_FFMPEG_OPT="--ffmpeg=/usr/local/bin/jellyfin-ffmpeg-upscale"#' \
  /etc/default/jellyfin
sudo systemctl restart jellyfin
```

Two traps:

- The encoder path **cannot be changed through the API** — systemd passes `--ffmpeg=` on the command
  line and that wins. Edit `/etc/default/jellyfin`.
- Jellyfin derives the **ffprobe** path from the ffmpeg directory, so it will look for
  `/usr/local/bin/ffprobe` and fail without that symlink.

The shim stands down automatically while the plugin's patches are active
(`plugin_patch_active: true` in `/etc/jellyfin-upscale.json`).

---

## Troubleshooting

**"Enhance" missing from the player menu.** Almost always a stale browser cache — hard-reload first.
Then check the script is actually served: `curl -I http://<server>:8096/web/gpu-upscale.js` should be
200. Note the web root is `/web/`, so `/gpu-upscale.js` at the root is correctly a 404. If
`window.__gpuUpscale` is undefined, the tag is missing — re-run the injector. If it exists but shows
no controls, the server-side capability probe failed.

**Enhance shows "No enhancement" even with options selected.** The session is direct playing, so
there is no transcode to enhance. Selecting a target should disable direct play automatically; if
the client cannot (a non-web client, for instance), enable `ForceTranscodeForDirectPlay`.

**Config page blank, or Save does nothing.** The page throws if its script reads an element id that
is not in the markup — one missing control breaks load *and* save for every field, silently. Check
the browser console, and compare the ids the script touches against the markup in the *served* page.

**Patches did not install.** The log names the unresolved methods. A Jellyfin upgrade can rename or
refactor them; the five core patches are all-or-nothing on purpose, because a partial install would
emit ffmpeg commands that fail outright. Upscaling stops; playback keeps working.

**Nothing is upscaled but everything looks fine.** Check `MinScaleFactor` (a target too close to the
source is skipped), `SrMinScaleFactor` (below it the SR network is deliberately bypassed — the
session record will say so), `MaxSourceHeight`, and the shaders' own `//!WHEN` guards — FSRCNNX needs 1.300x
and Anime4K 1.200x, so a 1.125x scale (720x960 → 810x1080) fires neither. Portrait sources often
need a 1440 target rather than 1080.

**Playback breaks after enabling something.** Roll back:

```bash
sudo /usr/local/sbin/jellyfin-gpuupscale-activate --rollback
```

---

## Uninstalling

```bash
sudo rm -rf /var/lib/jellyfin/plugins/GpuUpscale_*
sudo rm -rf /usr/lib/jellyfin-gpuupscale
sudo rm -f  /etc/apt/apt.conf.d/99-jellyfin-gpuupscale
sudo rm -f  /usr/share/jellyfin/web/gpu-upscale.js
# restore the pristine web index saved by the injector
sudo cp /usr/share/jellyfin/web/index.html.gpuupscale-orig /usr/share/jellyfin/web/index.html
# if you used the shim, put the encoder path back
sudo sed -i 's#JELLYFIN_FFMPEG_OPT=.*#JELLYFIN_FFMPEG_OPT="--ffmpeg=/usr/lib/jellyfin-ffmpeg/ffmpeg"#' \
  /etc/default/jellyfin
sudo systemctl restart jellyfin
```

Shaders in `/usr/share/jellyfin-shaders/` are inert once the plugin is gone; remove them or leave
them.

---

## After a Jellyfin upgrade

Re-check, in this order:

1. `journalctl -u jellyfin | grep GpuUpscale` — did all five core patches resolve?
2. Is the script tag still in `index.html`? A `jellyfin-web` upgrade removes it; the apt hook should
   re-apply it, but confirm.
3. Play something and probe a served segment. A patch can survive by *name* and change meaning,
   which no log line will tell you — only the output resolution will.
