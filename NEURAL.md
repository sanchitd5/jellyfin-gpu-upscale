# Neural super-resolution levels, and the ONNX Runtime backend that carries them

`neural=realesr-anime-x2`, `neural=realesr-anime-x4` and `neural=realesr-general-x4` run a
super-resolution convolutional network over the frame before the libplacebo scaling pass. They are
**advanced, opt-in levels**: off by default, not rungs of the generated quality ladder, and nothing
selects one automatically. Read "What these cost" before switching one on - none of them reaches
realtime for a single session on the hardware they were measured on.

## The backend, and why it is ONNX Runtime and not TensorRT

FFmpeg's own DNN module (`libavfilter/dnn`) speaks TensorFlow, OpenVINO and libtorch. None of those
is a good fit for a box that has an NVIDIA display driver and no CUDA toolkit, so a backend had to
be added. Both candidates were sized before either was downloaded, by reading the wheel and tarball
central directories over HTTP range requests rather than by downloading them:

| | download | unpacked | what else it needs |
|---|---|---|---|
| **ONNX Runtime 1.30.0, CUDA 13 build** | 236 MB | 337 MB | cuBLAS 856 MB, cuDNN 9 (the subset used) ~800 MB, cuRAND 169 MB, cudart 10 MB |
| TensorRT 11.3.0.99 (`tensorrt-cu12-libs`) | **4.39 GB** | **6.70 GB** | the same cuBLAS and cuDNN on top |

ONNX Runtime was chosen, and it would still have been chosen with unlimited disk:

* **It is a C API.** `onnxruntime_c_api.h` is one header, and the filter is C, like the rest of
  `libavfilter`. TensorRT's is C++ only.
* **There is no engine build step.** TensorRT compiles a plan for the exact GPU, driver and TRT
  version it will run on. That is a 30-120 second stall the first time a viewer selects a level,
  a cache to invalidate, and a third thing a driver upgrade can break. ONNX Runtime loads the
  `.onnx` and runs.
* **The model file stays a model file.** Anyone can drop a different `.onnx` in the models
  directory and select it; a TensorRT plan is not portable off the machine that built it.
* **The door stays open.** ONNX Runtime ships a TensorRT execution provider in the same package. If
  the throughput below is ever worth chasing, it is a provider swap inside the filter, not a
  rewrite.

Two thirds of the runtime cost is cuBLAS and cuDNN, which TensorRT would also have needed. About
1.8 GB is installed at `/usr/lib/jellyfin-ffmpeg-oidn/ort/lib`.

## The filter

There is no ONNX Runtime filter in FFmpeg, so this repository carries one: `ffmpeg/vf_ort.c`,
LGPL-2.1-or-later like the rest of `libavfilter`. It is a standalone filter rather than a fourth
backend inside `libavfilter/dnn`, deliberately: a DNN backend means implementing the async
`DNNModule` interface and its queues, and it would still not give a 3-channel RGB model that
changes the frame size without further patching `vf_sr`. One new file plus a three-hunk build patch
is the shorter path, and it matches `vf_oidn.c` and `vf_optix.c`, which are in this tree for the
same reason.

| option | values | default | note |
|---|---|---|---|
| `model` | path | *(required)* | the `.onnx` file |
| `device` | `cuda`, `cpu` | `cuda` | falls back to CPU with a warning if the CUDA provider will not load, rather than failing the session |
| `device_id` | int | `0` | CUDA device index |
| `scale` | 0-8 | `0` | `0` asks the model: nothing in an ONNX graph states the scale factor of a super-resolution net, so one 32x32 probe frame is run at configure time and the ratio read off the output |
| `threads` | int | `0` | intra-op threads, only meaningful for the CPU provider |

Accepted pixel format is `gbrpf32le` only. Pack and unpack are slice threaded; inference is
synchronous, one frame at a time, because these models are small enough that queueing machinery
would buy nothing. Output is clamped to [0,1] on the way out - residual SR networks overshoot by
design (about -0.45 to +1.59 was measured on these weights) and that is ringing, not a bug.

One implementation note worth keeping: ONNX Runtime is left to its default thread pool only if you
ask it to be, and its default is one thread per core, each pinned with
`pthread_setaffinity_np`. Inside an LXC container with a restricted cpuset every one of those calls
fails and logs. The filter therefore always sets the intra-op thread count explicitly.

## Where it sits in the chain

```
format=yuv420p, [denoise], format=gbrpf32le, ort=model=..., format=yuv420p, hwupload, libplacebo=w=..:h=.., hwdownload, format=yuv420p
```

After denoise, because a network handed noise turns it into structure. Before `hwupload`, because
the filter takes planar float RGB on the CPU - exactly as `oidn` does, and for the same reason: it
carries no `_vulkan` in its name, which is what the existing routing invariant keys on.

libplacebo then scales whatever the network produced to the size the session actually asked for, so
**the network's own factor never has to match the target ratio**. A x4 model on a 540p source at a
1080p target does not waste its work - it produces 2160p and libplacebo takes it down to 1080p -
but it does pay for pixels the viewer will not see. `realesr-anime-x2` is the one whose factor
matches that case exactly, and it is also the cheapest.

Neural super-resolution and the `sr` shader levels are **separate axes and compose**: the network
runs first, the shader runs inside the scaling pass afterwards. Selecting one does not turn off the
other.

## What these cost

One reading per level, taken in the deployed chain on a 960x540 source at a 1080p target, purely so
the cost hint is a measured number rather than an invented one:

| level | model | fps | vs realtime |
|---|---|---|---|
| *(off)* | - | 265 | 6.09x |
| `realesr-anime-x2` | `realesr-animevideo-x2-fp16.onnx` | **24** | **0.56x** |
| `realesr-anime-x4` | `realesr-animevideov3-x4-fp16.onnx` | **15** | **0.34x** |
| `realesr-general-x4` | `realesr-general-x4v3-fp16.onnx` | **10** | **0.24x** |

Read that plainly. **None of these sustains realtime for one session**, let alone two, and they are
roughly an order of magnitude more expensive than the FSRCNNX shader that ships as the default -
which is itself a super-resolution network, just one small enough to run as a fragment shader
inside the scaling pass. They are here because a level that exists and is labelled honestly is
better than a level that does not exist, which is the same reason NVScaler, OIDN and OptiX are
here. No quality stage will ever select one.

fp16 is what makes even these numbers possible: the same x2 model at fp32 measured 19 fps against
24. The conversion keeps fp32 graph inputs and outputs and casts at the boundary, so the filter
does not need to know.

## The weights are not in this repository, and you have to export them

No model weights are vendored here. The three levels are exported from the **official Real-ESRGAN
checkpoints**, published by the author of Real-ESRGAN:

| level | upstream checkpoint | sha256 |
|---|---|---|
| `realesr-anime-x2` | `https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.3.0/RealESRGANv2-animevideo-xsx2.pth` | `27985aa2198711ecd72f9bb274ec7b164e018fc9ce2933daaa7c7ab36a2bd3fe` |
| `realesr-anime-x4` | `https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-animevideov3.pth` | `b8a8376811077954d82ca3fcf476f1ac3da3e8a68a4f4d71363008000a18b75d` |
| `realesr-general-x4` | `https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth` | `8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292` |

Real-ESRGAN is BSD-3-Clause. All three are `SRVGGNetCompact`; the architecture comes from upstream
source (`realesrgan/archs/srvgg_arch.py`), with the `ARCH_REGISTRY` decorator and the `basicsr`
import stripped so it is plain torch, and `out += base` written as `out = out + base` so the traced
graph has no in-place op. The constructor arguments are read out of each state dict rather than
guessed: `num_feat` from `conv0.weight.shape[0]`, `num_conv` from the count of 4-D weights minus
two, `upscale` from `sqrt(last_conv.out_channels / 3)`. All three wrap their weights under a
`params` key.

Export with `torch.onnx.export`, opset 17, `dynamo=False` (torch 2.14's default dynamo exporter
does not take the classic `dynamic_axes` dict), dynamic axes on batch, height and width, then
`onnxsim`. Then convert to fp16 with `onnxconverter_common.float16.convert_float_to_float16(...,
keep_io_types=True, disable_shape_infer=True)` **and clear `graph.value_info` afterwards** - the
converter leaves per-tensor shapes behind that pin the graph to whatever resolution it last saw,
and the filter then fails on the second frame size it meets with "Shape mismatch attempting to
re-use buffer".

Put the results in `/usr/lib/jellyfin-ffmpeg-oidn/models/` under the names in the table above. A
level whose `.onnx` is not there is not listed by the probe, does not appear in the dashboard or
the Advanced row, and cannot be selected.

**SPAN was not shipped.** `github.com/hongyuanyu/SPAN` publishes no releases and no tags, and
carries no weights in its tree; the only weights link in its README is a Google Drive file. That is
not an official plain-HTTP upstream, so no SPAN level exists here rather than one built from a
mirror.

## Building it

Do `OIDN.md`'s steps 1-5 and `OPTIX.md`'s header steps first - this is the third filter in that one
binary, not a separate build. Then:

```bash
# ONNX Runtime, official upstream release, MIT. Match the CUDA major version to the driver:
# nvidia-smi reported CUDA 13.2 here, so the cuda13 build.
curl -LO https://github.com/microsoft/onnxruntime/releases/download/v1.30.0/onnxruntime-linux-x64-gpu_cuda13-1.30.0.tgz
tar xf onnxruntime-linux-x64-gpu_cuda13-1.30.0.tgz          # -> $ORT

cd ffmpeg-8.1.2
cp .../ffmpeg/vf_ort.c libavfilter/
patch -p1 < .../ffmpeg/0003-add-ort-filter-to-build.patch    # apply AFTER 0001 and 0002

./configure ... --enable-libonnxruntime \
  --extra-cflags="... -I$ORT/include" \
  --extra-ldflags="... -L$ORT/lib -Wl,-rpath,/usr/lib/jellyfin-ffmpeg-oidn/ort/lib"
make -j"$(nproc)"
install -D -m755 ffmpeg /usr/lib/jellyfin-ffmpeg-oidn/ffmpeg
```

Then the runtime, into `/usr/lib/jellyfin-ffmpeg-oidn/ort/lib`: `libonnxruntime.so.1*`,
`libonnxruntime_providers_cuda.so`, `libonnxruntime_providers_shared.so`, plus `libcudart.so.13`,
`libcublas.so.13`, `libcublasLt.so.13`, `libcurand.so.10` and the cuDNN 9 libraries
(`libcudnn.so.9` and the `graph`, `ops`, `cnn`, `heuristic`, `engines_precompiled`,
`engines_runtime_compiled`, `engines_tensor_ir` modules), from NVIDIA's own wheels
(`nvidia-cublas`, `nvidia-cuda-runtime`, `nvidia-curand`, `nvidia-cudnn-cu13`).

**One thing is easy to miss.** `libonnxruntime_providers_cuda.so` is `dlopen`ed and ships with an
empty `RUNPATH`, so it will not find the CUDA libraries sitting next to it and the filter silently
falls back to the CPU provider. Fix it in place:

```bash
patchelf --set-rpath '$ORIGIN' /usr/lib/jellyfin-ffmpeg-oidn/ort/lib/libonnxruntime_providers_cuda.so
```

Check it:

```bash
/usr/lib/jellyfin-ffmpeg-oidn/ffmpeg -h filter=ort
```

and watch a real encode at `-v verbose` for `CUDA execution provider unavailable`, which is the
line that says it is running on the CPU.

## What breaks it

* **A rebuild of the patched binary that forgets `vf_ort.c`** would leave a binary that exists and
  runs but has no `ort` filter. The shim handles this: it asks the binary what filters it has,
  caches the answer against the binary's size and mtime, and strips the node if the filter is
  missing - so those sessions play without the network instead of failing. The same check covers
  `oidn` and `optix`.
* **Deleting `/usr/lib/jellyfin-ffmpeg-oidn`** degrades the same way, as it already did.
* **Deleting a `.onnx`** removes that level from the probe, the dashboard and the Advanced row, and
  a session naming it falls back to the configured default. Nothing fails.
* **An NVIDIA driver upgrade** is the real risk, and it is a smaller one than OptiX's. ONNX Runtime
  talks to cuDNN and cuBLAS, which are bundled here and not in the driver, so only the CUDA driver
  API contract matters: a driver too old for the CUDA 13 runtime would make the CUDA provider fail
  to load, and the filter would warn and run on the CPU, which is unusably slow rather than broken.
  Re-run `-h filter=ort` and one short encode at `-v verbose` after a driver change.
* **A `jellyfin-ffmpeg` upgrade** cannot touch it - this binary is separate - but it can move
  Jellyfin's generated command onto options this build lacks, which would fail these sessions only.
* **A Jellyfin upgrade** that moves the Harmony patch targets disables all enhancement, these
  levels included. Existing failure mode, not a new one.
