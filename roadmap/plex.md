# Plex support

Part of the [roadmap](README.md).

**Status: not started. Nothing below has been tested against a Plex server.**

The patched ffmpeg and its filters do not depend on Jellyfin. Only the plugin (config page, probe,
client panel, `StreamOptions`, the shim's routing) is Jellyfin-specific. So the filters could serve
Plex too, but the way they get into a transcode would be entirely different.

## How Plex differs (assumptions to verify first)

- **Plex runs its own transcoder fork.** It calls `Plex Transcoder`, under
  `/usr/lib/plexmediaserver/`. It is not a stock ffmpeg, and Plex has no setting to point it at
  another binary.
- **Plex has no plugin system to hook into.** Server plugins were retired years ago, so there is no
  equivalent of `UpscaleEngine` or the web-injected client panel.
- **The command line is Plex-specific.** Plex passes its own flags and output formats (progress
  URLs, its segmenting and logging options). A stock-based ffmpeg may reject some of them.
- **Plex updates replace the binary.** Anything installed in its directory is overwritten on update.

## Possible routes

| Route | How | Risk |
|---|---|---|
| A. Wrapper around `Plex Transcoder` | Rename the real binary and put a script in its place. The script injects our filter into the chain, then runs either our ffmpeg or the real transcoder | Must understand Plex's flags. Updates undo it, so a reinstall hook is needed |
| B. Build our filters into Plex's transcoder | Plex publishes its transcoder source for licence compliance. Apply our `vf_*` patches to that tree | Depends on whether the published source builds and matches what ships. Heaviest option |
| C. Server-wide default only | Route A with one fixed enhancement chain from a config file, no per-user choice | Simplest. No UI, so no per-session control |

The likely first step is **C, built on route A**. A small spike would:

1. Capture real `Plex Transcoder` command lines for direct stream, transcode and hardware transcode.
2. Check whether our ffmpeg accepts them unchanged.
3. If it does not, map the flags that differ.

Only then design the wrapper.

## Carried over from this project's rules

- **Degrade, don't fail.** If our binary or filter is missing, the wrapper runs the real transcoder
  unchanged. A dead stream is worse than an unenhanced one.
- **Prove the chain.** Log the built command and check that the filter is present when on and absent
  when off, the same audit as `journalctl -u jellyfin | grep libplacebo`.
- **Stay out of the GPL tree.** No NVIDIA binaries and no Plex binaries go into this repo.
