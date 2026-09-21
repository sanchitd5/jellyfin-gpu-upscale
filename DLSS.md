# DLSS Super Resolution and DLAA as video filters, and what you must obtain yourself

`game=dlss` and `game=dlaa` run **NVIDIA DLSS** through NGX's Vulkan path. Both are **advanced,
opt-in levels**: off by default, not rungs of the generated quality ladder, never selected
automatically, and labelled degraded everywhere they are shown.

**Everything `FSR2.md` says about synthesised inputs applies here unchanged.** DLSS takes the same
four things a renderer supplies and a recording does not - exact screen-space motion vectors, a
depth buffer, the per-frame sub-pixel jitter, and a mask marking where history is a lie - and this
filter estimates all four from the picture. Read that document's second section before enabling
either level; it is not repeated here.

## DLAA has a second problem of its own

DLAA is DLSS at a **1:1 scale factor**. At 1:1 there is no resolution to recover, so the entire
gain has to come from two places:

1. **accumulating samples taken at different sub-pixel positions across frames** - which is exactly
   the input that cannot be supplied, measured in `the jitter measurements (see the README)`; and
2. **the aliasing the network was trained to undo**, which is *rasterisation* aliasing. A camera
   does not produce rasterisation aliasing. It produces compression artefacts, sensor noise and
   lens blur, none of which the network has seen.

So the expected result is close to a pass-through with a mild temporal blur. It is exposed because
it was asked for with that understood, and because it is the one of the three that is worth trying
as a **restoration pass rather than an upscaler**: `dlaa` runs at the source size *before* the
libplacebo scale, so it composes with whatever Detail shader is selected instead of replacing it.
`fsr2` and `dlss` produce the target size themselves and therefore drop the SR shader.

## Options

Same as `vf_fsr2` (`jitter`, `depth`, `dmodel`, `reactive`, `sharpness`, `device`, `w`, `h`), plus:

| option | values | default | note |
|---|---|---|---|
| `mode` | `sr`, `dlaa` | `sr` | `dlaa` ignores `w`/`h` and runs 1:1 |
| `quality` | `maxperf`, `balanced`, `quality`, `ultraperf` | `balanced` | NGX perf/quality preset; ignored in `dlaa` |
| `sdk` | path | `/usr/lib/jellyfin-ffmpeg-oidn/dlss` | where **you** installed the DLSS runtime |

The reactive mask goes to DLSS's `pInBiasCurrentColorMask`, which is its analogue of FSR2's
reactive input. Motion vectors are current -> previous in render-resolution pixels, so
`InMVScaleX/Y` are 1. Only the sub-pixel residual is passed as `InJitterOffsetX/Y`, for the same
reason `FSR2.md` gives.

## `XDG_RUNTIME_DIR` - read this, it is a hang and not an error

NGX takes a per-user lock under `$XDG_RUNTIME_DIR`, and hard-codes `/run/user/<uid>` when the
variable is unset. **In a container with no logind session that directory does not exist, and NGX
does not fail: it retries the `O_CREAT|O_EXCL` forever.** `NVSDK_NGX_VULKAN_Init` never returns,
the transcode hangs with no log line, and nothing in the NGX API reports it. That was found with
`strace`, not guessed:

```
openat(AT_FDCWD, "/run/user/0/.nvidia-ngx-lock-ngx_update_api", O_WRONLY|O_CREAT|O_EXCL, 0644) = -1 ENOENT
```

repeated until killed. `vf_dlss` therefore checks `XDG_RUNTIME_DIR` at configure time and, if it is
unset or not a directory, creates `/tmp/.ngx-runtime` and points the variable at it. No operator
action is needed, but if you ever see an NGX-era hang somewhere else, this is why.

A second trap in the same area: `NVSDK_NGX_VULKAN_Init`'s **application-ID** form is for titles
NVIDIA has registered. Called with an arbitrary id it hangs the same way. The filter uses
`NVSDK_NGX_VULKAN_Init_with_ProjectID` with `NVSDK_NGX_ENGINE_TYPE_CUSTOM`, which is the documented
path for anything unregistered. The project id must be a **GUID string**; a free-form name returns
`0xbad00005` (`NVSDK_NGX_Result_FAIL_InvalidParameter`).

## Licensing - NOTHING FROM NVIDIA IS IN THIS REPOSITORY

`ffmpeg/vf_dlss.c` and `ffmpeg/gu_inputs.h` are **our own code**, LGPL-2.1-or-later, and contain no
NVIDIA material. They are published here.

Everything DLSS needs at build time and at run time is **NVIDIA proprietary and is not vendored,
and must not be**. This is the same rule `OPTIX.md` states, and it is stricter here because the DLSS
runtime is a redistributable-by-licence *binary* rather than a driver component: it would be easy to
ship and it is still not shipped.

### What you must fetch yourself

| what | from | licence |
|---|---|---|
| NGX headers (`nvsdk_ngx*.h`) | `https://github.com/NVIDIA/DLSS`, `include/` | NVIDIA proprietary (`LICENSE.txt` in that repo) |
| `libnvsdk_ngx.a` | same repo, `lib/Linux_x86_64/` | NVIDIA proprietary |
| the DLSS runtime `libnvidia-ngx-dlss.so.<version>` | same repo, `lib/Linux_x86_64/rel/` | NVIDIA proprietary |
| NVIDIA driver 5xx with `libnvidia-ngx.so.1`, Turing or later | you already have it | proprietary |
| NVIDIA Optical Flow SDK headers | `https://github.com/NVIDIA/NVIDIAOpticalFlowSDK`, branch `nvof_2_0_bsd` | 3-clause BSD |

Verified here against DLSS SDK runtime **310.9.1** on driver **595.84**, RTX 3090 (Ampere - DLSS SR
runs on it; DLSS Frame Generation does not and is not exposed).

Install the runtime by hand:

```bash
mkdir -p /usr/lib/jellyfin-ffmpeg-oidn/dlss
cp libnvidia-ngx-dlss.so.310.9.1 /usr/lib/jellyfin-ffmpeg-oidn/dlss/
chmod 755 /usr/lib/jellyfin-ffmpeg-oidn/dlss/*.so*
```

**Until that file is present, `dlss` and `dlaa` are not listed and not offered** - the probe, the
dashboard dropdown and the player menu all read the same `AvailableGameLevels()`, which checks for
it. That is the same rule the neural weights follow: an option that would fail is not an option.

## Building it

Add to the same patched binary the other filters live in, patches **in order** - `0001` oidn,
`0002` optix, `0003` ort, `0004` fsr2 and dlss together:

```bash
cp ffmpeg/vf_dlss.c ffmpeg/gu_inputs.h ffmpeg-8.1.2/libavfilter/
patch -p1 < ffmpeg/0004-add-fsr2-and-dlss-filters-to-build.patch
./configure ... --enable-libngx \
  --extra-cflags="... -I<DLSS repo>/include" \
  --extra-ldflags="... -L<dir holding libnvsdk_ngx.a>"
```

`0004-add-fsr2-and-dlss-filters-to-build.patch` adds `libngx` to `EXTERNAL_LIBRARY_LIST`,
`dlss_filter_deps="libngx ffnvcodec vulkan"`, a header-presence check, `-lnvsdk_ngx -lvulkan
-lstdc++ -ldl`, the `vf_dlss.o` Makefile rule and the `allfilters.c` declaration.

Check it:

```bash
/usr/lib/jellyfin-ffmpeg-oidn/ffmpeg -h filter=dlss
/usr/lib/jellyfin-ffmpeg-oidn/ffmpeg -v verbose -i in.mkv -frames:v 8 \
  -vf format=gbrpf32le,dlss=w=960:h=720:depth=flat:sdk=/usr/lib/jellyfin-ffmpeg-oidn/dlss,format=yuv420p \
  -f null -
# expect: "Vulkan device ... for NGX", then the DEGRADED banner, then frames
```

## Own Vulkan device, and why

`vf_dlss` creates its own `VkInstance`/`VkDevice`. `NVSDK_NGX_VULKAN_RequiredExtensions()` dictates
the instance and device extension lists and has to be asked **before** either is created, which is
why the filter cannot borrow FFmpeg's Vulkan hwcontext.

## What breaks it

* **A driver change.** NGX is implemented partly in the display driver (`libnvidia-ngx.so.1`), so
  these levels can change or break with nothing here rebuilt - the same, larger, failure mode
  `OPTIX.md` records for OptiX. Re-run the 8-frame check above after any driver change.
* **Removing the runtime** from `/usr/lib/jellyfin-ffmpeg-oidn/dlss`: the levels stop being listed.
* **Deleting `/usr/lib/jellyfin-ffmpeg-oidn`**: the shim strips the node and the session plays
  unenhanced.
