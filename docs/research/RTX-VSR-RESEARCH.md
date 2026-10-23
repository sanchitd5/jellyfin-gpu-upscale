# Public research: NVIDIA RTX Video Super Resolution architecture

Web research only, no binary work, no CT114, no loader. Retrieval date for everything below,
unless noted otherwise, is 2026-09-23. Content pulled through the WebFetch tool is a *paraphrase*
produced by a small summarizing model, not a verbatim scrape; anywhere that matters I say so and
avoid presenting it as a direct quote. One local artifact (the FFmpeg patch series) I read
verbatim myself, and that is called out explicitly.

## 1. NVIDIA's own public material on RTX VSR

Confirmed public, NVIDIA-authored sources:

- NVIDIA Blog, "Pixel Perfect: RTX Video Super Resolution Now Available for GeForce RTX 40 and
  30 Series GPUs," published 2023-02-28.
  https://blogs.nvidia.com/blog/rtx-video-super-resolution/ (retrieved 2026-09-23).
  Per a WebFetch paraphrase of this page: the network "analyzes the lower-resolution video frame
  and predicts the residual image at the target resolution," which is then overlaid on a
  traditionally upscaled frame to correct compression artifacts (blockiness, ringing, washed-out
  detail, banding) and sharpen edges. The setting lives in NVIDIA Control Panel under "Adjust
  video image settings" -> "RTX video enhancement" -> a Super Resolution checkbox plus a quality
  slider "from one to four," described as trading GPU cost for upscaling strength. Requires an
  RTX 40 or 30 series GPU and a supported Chromium-based browser version.
- NVIDIA Blog, "RTX Video Super Resolution Update Enhances Video Quality, Detail Preservation and
  Expands to GeForce RTX 20 Series," https://blogs.nvidia.com/blog/rtx-video-super-resolution-ai-obs-broadcast/
  (title/URL from WebSearch results, not independently fetched; retrieved 2026-09-23). Per the
  search summary, this update retrains the model to better separate genuine detail from
  compression artifact, and claims up to 30% lower GPU cost at the top quality setting versus the
  original model.
- NVIDIA's RTX Video FAQ exists at https://nvidia.custhelp.com/app/answers/detail/a_id/5448/~/rtx-video-super-resolution-faq
  but returned HTTP 403 when fetched directly on 2026-09-23; I could not retrieve its content and
  am not citing anything from it beyond its existence.
- Distinguishing from a different NVIDIA product with a similar name (per the brief's warning):
  developer.nvidia.com's "Enhancing Low-Resolution SDR Video with the NVIDIA RTX Video SDK" and
  docs.nvidia.com/maxine/vfx's "Video Super Resolution" page describe the **Maxine VFX SDK**'s
  `VideoSuperRes` filter, an SDK integration path for application developers, not the driver
  feature (RTX VSR / AIVP) this project is reverse-engineering. Noted so as not to conflate the
  two, as instructed.

Nothing in NVIDIA's own public material names AIVP, PPE, DLPP, or nvaivpx.dll, and nothing
describes the network's internal structure (layer count, where the bias/residual sits) beyond
the "predicted residual overlaid on a fixed upscale" description above.

## 2. Public references to "AIVP" or "PPE" (Post Processing Engine)

This is the most concrete finding in this research pass. FFmpeg (the open-source project) has a
merged branch, `nvidia-video-filters`, adding CUDA filters that replay the NVIDIA driver's own
video-enhancement networks by extracted cubins, authored by Philip Langdale
(philipl@overt.org), a long-standing FFmpeg NVIDIA-hardware contributor. Two of these filters use
"AIVP" and "PPE" explicitly as NVIDIA's own internal driver component names:

- `vf_vsr_drv_cuda.c` (filter `vsr_drv_cuda`) describes itself as driving "the DXVA/PPE plugin
  nvaivpx.dll, ppe/features/AIVP," calling it "the video super-resolution the NVIDIA driver
  itself runs," distinct from the NGX SDK path (`nvngx_vsr.dll`) that a sibling filter,
  `vsr_cuda`, drives.
- `vf_dlpp_drv_cuda.c` (filter `dlpp_drv_cuda`) describes itself as driving "ppe/features/DLPP,"
  again "driven directly rather than through the AIVP plugin that vsr_drv_cuda uses," and states
  DLPP exposes "its own quality levels, which include two high-quality models the AIVP path does
  not reach."

I read these two patch files verbatim with a local file read (they already exist in this repo at
`ffmpeg-patches/0005-avfilter-add-vsr-drv-cuda-the-driver-rtx-vsr.patch` and
`ffmpeg-patches/0006-avfilter-add-dlpp-drv-cuda-the-driver-dlpp-super.patch`, predating this
research session), so the text above is an exact quote of the patch commit messages and file
header comments, not a paraphrase. Important caveat on independence: because these files were
already in this repo before I started, I did not "discover" them fresh on the web; what I did do
was confirm they also exist publicly, via WebFetch of:
- http://www.mail-archive.com/ffmpeg-cvslog@ffmpeg.org/msg76210.html (05/46, vsr_drv_cuda)
- http://www.mail-archive.com/ffmpeg-cvslog@ffmpeg.org/msg76209.html (06/46, dlpp_drv_cuda)
- http://www.mail-archive.com/ffmpeg-cvslog@ffmpeg.org/msg76207.html (03/46, vsr_cuda)
- https://github.com/FFmpeg/FFmpeg/commit/63ee38cd7f181691c5c374f894768e0dff63a7e9 ("Merge branch
  'nvidia-video-filters'", author philipl, 16 files / 5,930 lines, including
  `libavfilter/vf_vsr_drv_cuda.c` and `libavfilter/vf_dlpp_drv_cuda.c`)

all retrieved 2026-09-23, and all returning content consistent with the local patch text
(WebFetch paraphrase in each case, but consistent across three independent mail-archive messages
and the GitHub merge commit, and consistent with the verbatim local file). I have moderate-to-high
confidence this is genuinely public and not a summarizer hallucination, on the strength of that
cross-consistency, but I could not do a byte-level fetch to prove it beyond doubt, and the
WebFetch summaries elsewhere in this session visibly picked up unrelated context from my own
system prompt (see the caveat at the top of this document), so some residual doubt is warranted.
If this matters for anything load-bearing, re-fetch these URLs yourself and check them directly.

The patch comments also describe, in NVIDIA's own internal vocabulary as reconstructed by this
FFmpeg work: the driver numbers its VSR networks 0-4, index 0 is a byte-identical duplicate of
index 4, and by fidelity (not by index order) the ranking is quality 1 (most faithful) > 3 > 4 > 2
(most aggressive detail synthesis), default 1. DLPP's own path (driven directly, bypassing AIVP)
exposes qualities 1-4 where 1-2 are fixed-2x "base" models behaving like the AIVP path, and 3-4 are
"high-quality" models that upscale natively at an integer factor via what the patch calls "the
driver's own params[0x38] float, which selects the pixel_shuffle2/3/4 super-resolution head." Both
filters note a shared quirk: each kernel launch must be issued using the *kernel's own*
`EIATTR_CBANK_PARAM_SIZE` rather than the driver's captured argument-buffer size, because the
driver "over-reports by 8 bytes for the two DLPP tex/surf kernels," which otherwise makes
`cuLaunchKernel` fail with `CUDA_ERROR_LAUNCH_OUT_OF_RESOURCES`. The graph itself has only two
bindless slots total: the input texture bound at a kernel named `dlpp_preProcess`, and the output
surface bound at `dlpp_postProcess` (exact output size) or `ResampleAndComposeFP16` (any other
size).

## 3. Is "DLPP" a name NVIDIA uses publicly, and what does it stand for

Partially, with an unresolved inconsistency. An NVIDIA NGC Catalog page,
https://catalog.ngc.nvidia.com/orgs/nvidia/multimedia/models/dlpp/- (retrieved 2026-09-23, via
WebFetch paraphrase), describes "DLPP" as "a family of lightweight deep-learning networks trained
for video post-processing," expanding it there as "Deep-Learning Post-Processing," architecture
"U-Net-based," supporting Turing through Blackwell, input 640x360 to 3840x2160, with
low/medium/high/ultra tiers and sub-millisecond to ~2.6ms inference on an RTX 4090. Separately, a
WebSearch summary of the FFmpeg `dlpp_drv_cuda` mailing-list post rendered the same acronym as
"Deep-Learning Pre-Processing" instead. I cannot reconcile these two expansions from what I
retrieved; the FFmpeg patch text I read verbatim (see section 2) never expands the acronym at all,
it only ever writes "DLPP" bare. Treat the "Deep-Learning Post-Processing" reading as the better
starting point, since it comes from what NVIDIA's own catalog page calls itself, but flag the
expansion as unconfirmed and possibly a summarizer artifact rather than NVIDIA's own words. I did
not find NVIDIA using "DLPP" in a driver release note, patent, or paper, only on that one catalog
page.

## 4. How NVIDIA Control Panel / NVIDIA app settings actually get plumbed to the network

Mostly unanswered; this is the weakest section. What is solid: NVIDIA's own blog post (section 1)
confirms the user-facing control is a checkbox plus a 1-4 quality slider inside NVIDIA Control
Panel's "Adjust video image settings" -> "RTX video enhancement" page, and the NVIDIA app has
since grown an equivalent slider (per an unfetched WebSearch hit, "NVIDIA App Beta Adds RTX Video
Super Resolution, RTX Video HDR Sliders, and Display Settings," nvidia.com/en-us/geforce/news,
not independently verified).

What I could not confirm from any public source: whether that setting reaches the network via a
per-application driver profile in the existing NVIDIA "application profiles" registry/DRS
database, via an NvAPI call issued at runtime by a separate process (NVIDIA Control Panel Client
or `nvcontainer`), or by some other path. A general WebSearch summary asserted that "per-app
settings live in NVIDIA's proprietary DRS (Driver Settings) profile database, which can be edited
via NVAPI (`NvAPI_DRS_*`)" -- this is true as a general statement about how NVIDIA driver
per-application settings work generically (the public NVAPI SDK, https://github.com/NVIDIA/nvapi,
does expose an `NvAPI_DRS_*` family for driver settings profiles), but I found nothing tying RTX
VSR's specific quality/enable setting to that mechanism by name. This is speculation carried over
from general NVAPI knowledge, not a confirmed fact about RTX VSR specifically, and should be
labeled as such if used.

I also checked an mpv issue tracker thread (github.com/mpv-player/mpv/issues/11390, "RTX Video
Enhancement support," opened 2023-03-01, retrieved 2026-09-23) hoping for community
reverse-engineering discussion of the invocation path; per a WebFetch paraphrase it is a bare
feature request with no technical replies at all.

## 5. Patents

Mixed results, and I want to flag a real problem I hit here: two USPTO document IDs that a
WebSearch turned up under promising titles ("System and method for providing real-time
super-resolution for compressed videos," 10,547,873, and "System and method for real-time
processing of compressed videos," 10,897,633) could not be confirmed as NVIDIA's. A follow-up
WebSearch for the assignee of 10,897,633 returned a summary claiming it belongs to MIT with
inventors "Hannah A. Clevenson and Dirk Englund" -- researchers whose public work is in quantum
photonics, not video codecs, which does not fit the title at all. I think that assignee lookup
either hit a wrong/stale index entry or the summarizer conflated two different documents. I am
not citing either patent number as NVIDIA's; treat both as unverified and possibly misattributed
in the source data I could reach, retrieved 2026-09-23.

One patent I could verify directly by fetching Google Patents itself:
- US20210073944A1, "Video upsampling using one or more neural networks," assignee NVIDIA
  Corporation, filed 2019-09-09, published 2021-03-11.
  https://patents.google.com/patent/US20210073944A1/en (retrieved 2026-09-23).
  Per a WebFetch paraphrase, this describes a hybrid pipeline for temporal-anti-aliased upscaling
  (TAAU): a fixed/traditional upsample of the current frame, historical-frame motion warping,
  YCoCg color conversion, and a trained network that -- this is the structurally interesting
  part -- "generates a blending factor and a number of kernels" used to blend the current
  upsampled frame with the warped history frame, rather than emitting the final pixels directly.
  That is architecturally close to what the brief describes wanting (a fixed base plus a
  learned, gated contribution) but this patent is about temporal upscaling for rendered/game
  content (the DLSS-family TAAU line), not the compressed-video compositor pipeline the brief
  says to keep separate from DLSS. I am flagging it as a plausible architectural cousin, not
  as a description of RTX VSR/AIVP itself; nothing here confirms it's the same network family.

I did not find a patent that clearly and verifiably describes a bicubic-base-plus-near-zero-
weighted-learned-residual structure specific to the driver's compressed-video pipeline.

## 6. Independent reverse-engineering writeups

Yes, and this is the same material as section 2: the FFmpeg `nvidia-video-filters` branch (Philip
Langdale, merged, commits visible on the public FFmpeg mailing list and GitHub, see section 2 for
URLs) is a genuine independent public reverse-engineering effort against this exact driver
feature. Per the patch text I read verbatim, the method was "running the plugin on Linux via
`loader_ppe` and intercepting the live CUDA Driver-API launches," with a companion tool named
`rtx-video-re` used to derive and validate, byte-exact against the loader, how the captured launch
graph (grids, scratch allocations, packed argument-buffer scalars, weight-upload targets, pointer
fixups) scales with input/output width and height. The patch comments reference internal
documentation of their own, `docs/FINDINGS-vsr-drv-params.md`, describing sentinel-probed
parameter offsets for detail/smoothing pre-processing controls -- but I could not locate that
`rtx-video-re` tool or its findings doc as a separate public repository through search; it may not
be published on its own, or my searches for "rtx-video-re" simply didn't surface it (results came
back generic, unrelated RTX-VSR GitHub topic pages).

I found no other independent public writeup (blog, conference talk, security research) describing
this driver feature's internals beyond the FFmpeg patch series.

## 7. Academic papers

No NVIDIA Research paper was found that clearly matches "real-time video super-resolution for the
driver/compositor pipeline" as its own named project. The closest adjacent material found by
search were general video-SR literature hits (an AIM 2024 challenge on efficient video SR for AV1
content, a "compression-informed video super-resolution" (COMISR) paper, and general surveys of
deep-learning video SR) plus NVIDIA's own DLSS/TAAU patent already covered in section 5. None of
these were confirmed as describing AIVP/DLPP specifically. I'm marking this section as
substantially unanswered rather than stretching adjacent papers to fit.

## Relevance to our blocker

Limited, but not zero.

1. The FFmpeg patch series (sections 2 and 6) confirms, from an independent source, exact
   agreement with what this project has already reverse-engineered: the internal names AIVP, PPE,
   and DLPP, the quirky `EIATTR_CBANK_PARAM_SIZE`-vs-argsize launch bug, and the "AIVP plugin
   drives DLPP kernels; DLPP can also be driven directly, bypassing AIVP, unlocking two additional
   quality models" relationship. If our host-side work has been treating AIVP and DLPP as the
   same thing, or hasn't tried invoking DLPP's quality 3/4 heads directly (native integer-factor
   heads, not routed through AIVP), that is a concrete, testable difference worth trying: the
   near-zero-bias problem might be specific to the path we've been driving, not to the network
   family as a whole.
2. Nothing here explains *why* the final layer's contribution would collapse to a near-zero
   residual under our parameters, and nothing here found NVIDIA Control Panel's actual plumbing
   mechanism (registry profile vs NvAPI vs nvcontainer) with any confidence -- section 4 is a
   genuine gap, not a soft-pedaled one. If NVCP is setting something other than what we've been
   setting (a different offset, a different launch's argument, or a value gating the residual's
   scale rather than the quality-level selector we assumed), that would be consistent with our
   symptom, but nothing found here identifies what that something is.
3. The one architecturally suggestive patent (section 5, US20210073944A1) shows NVIDIA elsewhere
   building blend-factor/gating outputs into a learned network on top of a fixed base, which is at
   least existence proof that "final output dominated by a near-zero-weighted correction" is a
   real design NVIDIA uses elsewhere (their TAAU blend factor can legitimately sit near a
   pass-through value under many conditions) -- but this is a different product family (game
   rendering, not compressed video), so treat it as a weak analogy, not a mechanism explanation.
