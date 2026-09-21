# CLAUDE.md

Read **[AGENTS.md](AGENTS.md)** first — it holds the architecture invariants, the verification
standards and the list of things that have already gone wrong here. Everything in it applies.

This file adds only what is specific to working on this repo with Claude Code.

## Where the work actually happens

This project is developed against a **live Jellyfin server**, not locally. There is no meaningful
local test suite: the plugin cannot do anything useful without Jellyfin's assemblies, a GPU and a
real transcode. Expect to build on, deploy to, and verify against a running server over SSH.

That has consequences:

- **A build that compiles proves almost nothing.** See the verification section of AGENTS.md — probe
  the served segment.
- **Deploy atomically.** Half-applied state is visible to whoever is using the server. Copying new
  assemblies and only then discovering the config page needs rebuilding means users see a broken
  dashboard in the meantime.
- **Restarts are expensive and visible.** Batch changes that need one. A restart kills in-flight
  transcodes, cancels library scans and logs dashboard users out.

## Before you change the config page

`src/Configuration/configPage.html` is an embedded resource compiled into the plugin DLL, so a
change needs a rebuild *and* a restart — it is not a static file you can edit in place. Fetch the
**served** page through the Jellyfin API when diagnosing, because the on-disk source may not be what
is running.

Adding a setting means touching all of these together, or the page breaks:

1. `src/Configuration/PluginConfiguration.cs` — the property and its default
2. `src/patcher/UpscaleSettings.cs` — the patcher-side mirror (settings cross the ALC boundary as JSON)
3. `src/Configuration/configPage.html` — **both** the form control and the load/save script lines
4. The session/status reporting, if the setting changes what the server does

## Reporting back

When summarising work here, state plainly what was verified versus assumed. "Deployed and the
service restarted cleanly" is not the same as "a served segment came back at 1920x1080". If a
verification could not be run — no browser available, a restart not authorised — say so rather than
implying coverage. Several bugs in this project's history were found only because someone re-checked
a claim that had already been reported as working.

If a user's objection contradicts a measurement, take the objection seriously and design a test that
could prove them right. The Anime4K-versus-FSRCNNX question was settled that way: the original
benchmark measured only at the shader's native ratio, and the user's instinct about their own
content turned out to be correct.
