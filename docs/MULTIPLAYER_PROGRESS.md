# Multiplayer development progress — 8 September 2026

Development resumed from the existing implementation; this progress record is
included in the local multiplayer implementation commit on `allied-campaign`. The target
covers the direct-IP core and host content delivery in [the plan](MULTIPLAYER_PLAN.md). See [MULTIPLAYER.md](MULTIPLAYER.md)
for setup, architecture, commands and scope. No installs into the applications
directory, external posts or pushes have been made.

## Changes in this continuation

- Finished the previously interrupted UI smoke on the starting tree: actual
  Electron host, Chromium guest, wrong-password retry, map readiness, both
  players ready, host departure and port reuse all passed. The earlier
  wrong-password delay did not reproduce as a failure on this run.
- Added server-stamped binary sync relays and independent client comparison
  against local hashes and defeat masks. Clients detect divergence without a
  server out-of-sync notice. Pending comparisons are bounded, cleaned up after
  disconnects, and tested against malformed, duplicate and skipped packets.
- Orders protocol is now **2**; runtime identity uses the protocol constants.
  Rebuild both players. Older orders-protocol clients are rejected.
- Inline Ready now follows the same map-verification gate as the sidebar.
  Unsupported Observer choices are hidden. Transferred lobby administrators
  can manage slot 0 when it is free. Original RA2 controls, metallic frame,
  red world-map background and yellow text remain in use.
- Expanded the UI smoke with failure screenshots and console/banner diagnostics,
  map changes/reselection, bots, nondefault options, teams, lobby chat and
  starting a real game. This exposed the loss of the validated local map file
  on session updates. Fixed by retaining the verified file for the same digest
  and clearing it when the map changes or the client disconnects.

## Validation

- Full `bun test`: **95 passed, 0 failed, 1,749 assertions, 16 files**.
- Production web build, server bundle and Linux YR packaging succeeded.
  Runnable output: `build/linux/yr/run.sh`.
- Both Bun and Node socket smokes passed: six handshake rejections, loading
  gate, 100 matching frames, 200 ms one-way delay, four retransmission stalls,
  and shared mismatch frame 101.
- Two actual Chromium/V8 engines with two bots matched every hash through
  150 ticks (2,061 objects). Injected divergence was reported at frame 151;
  both stopped at tick 152 on this run. This is an observation, not a guarantee
  of exact same-tick stopping. Artifact: `build/lockstep-engine-smoke.json`.
- Frontend typecheck still reports the 42 previously recorded diagnostics;
  none are in the changed multiplayer/networking paths.
- Expanded UI smoke **passed on the final source/build**: password retry, host
  departure and port reuse, map changes and same-map reselection, Easy AI,
  crates option propagation, teams, all/team chat, readiness and menu-driven
  start. Both clients advanced past 30 ticks; closing the host released the
  port. Lobby and game screenshots are under `build/multiplayer-ui/`. Earlier
  failure artifacts in that directory describe intermediate test iterations.
- Final `git diff --check` and smoke script syntax check passed. The temporary
  Vite server and test applications were stopped after validation.

## Host content delivery — direct-IP extension

Implemented the next milestone before Apple hosting/discovery and the master
server/browser. Hosts can share custom maps and loose custom unit packages from
the lobby; guests verify and mount them before Ready. See [usage](MULTIPLAYER.md#maps-and-custom-units-from-the-host).

- Handshake protocol is now **2**; orders protocol remains **2**. Rebuild both
  players. The base mod/retail identity remains separate from session content.
- Canonical SHA-256 manifests, portable hashing, authenticated 8 KiB chunks,
  atomic publication, transfer cancellation/timeouts, and a bounded verified
  per-file memory cache. Start rejects pending uploads and stale acknowledgements.
- Temporary VFS overlays merge rules/art/AI patches, expose custom resources,
  update strings/sound definitions, and restore baseline state after leaving.
- RA2-style lobby file selection, byte progress, verification, retry/cancel and
  removal. Custom map selection also publishes the selected map.
- The local content smoke creates its map and unit patches from the test
  machine's installed resources plus an original generated cameo. Generated
  files stay under `build/`; no retail map or unit data is committed.

### Content validation

- `bun test`: **115 passed, 0 failed**, 1,854 assertions across 18 files.
- Production web build, server bundle and Linux YR packaging pass.
- Bun and Node socket smokes pass with handshake protocol 2, 100 matching frames,
  artificial delay/stalls, rejection cases and injected desync.
- `node scripts/multiplayer-content-ui-smoke.mjs`: **passes** with a real Electron
  host and fresh Chromium guest. Transfers custom map/rules/art/original cameo,
  removes and reloads content, builds and moves the custom tank through normal
  guest network commands, and matches all 501 captured hashes (ticks 100–600).
  Test setup creates identical factories at paused tick 150. Leaving restores
  baseline resources; a subsequent stock skirmish advances at least 30 ticks.
  The host also imports content, leaves, and recreates a lobby on the same screen;
  it starts with a local map and no stale content package.
- Existing direct-IP UI smoke also passes: password retry, host departure/port
  reuse, map/bot/options/team/chat controls, Ready/Start and running simulation.
- Artifacts: `build/multiplayer-content-ui/report.json`, `host-lobby.png`,
  `guest-lobby.png`, `guest-game.png`, and generated `fixture/` files. Intermediate
  failure artifacts may remain from test-development runs; the final report is
  the passing result. The cameo is visible in the in-game sidebar screenshot.
- `typecheck:entry` retains the same **42 existing diagnostics**, with no new
  diagnostics in the changed multiplayer/resource code. `git diff --check` passes.

## Remaining acceptance and implementation

1. Play a full skirmish on two physical Linux machines and test a cable pull.
   Automated loopback engine/socket/UI runs do not replace these checks.
2. Exact same-tick desync stopping and historical per-frame state snapshots
   remain absent. Reports retain both mismatch frame and actual stopped tick.
3. In-game chat/diplomacy/connection details, real Apple-device validation,
   discovery, master service and dedicated hardening remain open.
   Client sync cross-checking is now implemented.

## Reproduction notes

Start Vite from `redalert2/` with `RA2_HTTP=1 bun run dev`, then run
`node scripts/multiplayer-ui-smoke.mjs`. It uses the packaged YR Electron app,
Chromium at `http://127.0.0.1:4000/?shell=1`, test port 19620, and the isolated
host profile `build/multiplayer-ui-host-profile`. Screenshots and failure
logs go under `build/multiplayer-ui/`. Cold guest asset import/fingerprinting
can take time before the password handshake.

Rebuild the host and restart Vite after source changes so build identities
match. Do not edit frontend modules during a UI run: Vite hot reload can
reset the guest and invalidate the test. Electron uses Wayland in this setup;
its headless Ozone launcher previously crashed.

`docs/MULTIPLAYER_PLAN.md` and
`scripts/determinism-cross-engine-smoke.mjs` contained preceding user work.
Their existing S3 findings and script are preserved. Earlier diagnostics under
`/tmp/ra2-multiplayer-*` and the clean-HEAD typecheck snapshot are optional;
they are not required source files.
