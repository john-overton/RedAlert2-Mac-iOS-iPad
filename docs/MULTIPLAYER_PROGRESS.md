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


## macOS hosting (September 8, 2026)

The native Mac shell now exposes `hostGame`/`stopHosting` through a reply-capable
WKWebView bridge. `scripts/build-macos.sh` compiles and signs a standalone ARM64
Bun helper, reusing GameServer and BunWsTransport. No installed runtime is needed
when launching the app. Hosting is supported by both Mac variants; iOS hosting,
physical cross-device full matches and NAT/relay support remain pending.

See [Mac hosting and validation](MACOS.md#hosting-multiplayer) for lifecycle,
network reachability, tests and output locations. Generated binaries and retail
resources remain ignored. Bun runtime notices are packaged with the app.


Validated locally: 116 unit tests; 100 matched lockstep frames with delayed
socket delivery and the expected mismatch at frame 101; standalone Mac helper
host/guest, password rejection, chat, custom map/unit content, match start,
port conflict, invalid port, EOF/termination cleanup and port reuse; native
WKWebView bridge startup/cancellation/iframe checks; native built-game UI Create
Game, guest join, Leave Game and same-port rehosting. Both Mac app variants were
rebuilt and their nested helper/app signatures verified. Native UI checks use
a separate persistent test profile because WebKit ephemeral storage does not
support the game's OPFS asset import. Logs are in ignored `build/macos/hosting-*.log`.
These do not constitute physical two-machine or full-skirmish acceptance.


## Lobby resilience and visible ping (September 8, 2026)

Fixed a reproducible false `invalidPacket`: an old pong was rejected after the
next five-second probe replaced its timestamp. GameServer now tracks bounded
outstanding probes, ignores duplicate/stale replies without refreshing liveness,
and publishes lobby RTT/idle state separately from full session updates. Lobby
UI shows measured milliseconds, stalled-player warnings and slot grace time.
Connection/handshake limits are 30 seconds, established-peer timeout 120 seconds,
and individual content request timeout 60 seconds. Concurrent content requests
receive an error without being kicked. Client errors retain server details after
socket close. No automatic session reconnect or frame-validation relaxation was
added.

Validation: 123 tests pass; entry typecheck retains 42 baseline diagnostics. The
native built-game lobby test delays guest heartbeat replies for 16 seconds,
requires the stalled warning, then verifies recovery, measured ping and continued
membership before testing leave/rehost. The Node/ws transport lockstep test still
matches 100 frames with delayed delivery and the expected mismatch at frame 101.
Logs: ignored `build/macos/resilience-*.log`. Both Mac variants rebuilt; a physical
Mac/Linux session with the user's friend remains the next manual check.

### Match shutdown crash follow-up

- Fixed trailing sync sends after game-end callbacks close the connection inside
  the current simulation tick. A departed/disposed session stops accepting work.
- Convert transport send failures into a single match error and notify the match
  before lobby close listeners can dispose it. Preserve server rejection details.
- Send desync evidence before notifying fatal-error listeners that may close the
  transport; keep diagnostic export failure from hiding the original error.
- Regression coverage includes late sends after leaving, failure before the socket
  close event, synchronous desync cleanup, and lobby cleanup listener ordering.
- Unit tests: 127 passed. Node transport smoke: 100 matched frames with delayed
  delivery, then the expected mismatch at frame 101. Native macOS helper hosting
  smoke passed. Both Mac variants rebuilt and signatures verified. Entry typecheck
  retains the 42 existing errors, with none in the changed networking modules.
- Real Chromium engine smoke on a fresh development server: two clients and two
  bots matched all 150 ticks; injected divergence stopped both at mismatch frame
  151. Production turn-manager shutdown and diagnostic-export regressions passed
  in the browser. The smoke now rejects missing tick instrumentation after HMR.

### In-game chat and spy-plane HUD

- Connected the Enter chat handler to direct-server matches and enabled the HUD
  composer's previously missing composing-state prop. Moved input above the
  bottom command bar; messages remain at the top left. Tab remembers audience,
  Escape/blur cancels, and typing stops held arrow scrolling and command hotkeys.
- Added a direct-server chat adapter with server echoes, muted-player filtering,
  and public-only replay recording; chat packets remain outside lockstep orders.
- Use YR's extended cursor sheet and spy-plane frames 504–511. Bound beacon frames
  to their original animation and retain an aircraft fallback for classic assets.
- Show the local spy-plane countdown/ready timer without exposing hidden enemy
  timers or changing simulation rules.
- Validation: 131 unit tests passed; entry typecheck retains the 42 baseline
  errors. Two real engine clients verified chat send/cancel/audience persistence,
  opponent filtering, cursor selection and local countdown visibility while
  matching all 150 simulation ticks. Injected mismatch handling also passed.
- Packaged native WebKit lobby hosting/heartbeat recovery smoke passed. YR and
  classic Mac apps rebuilt and both code signatures verified. Browser checks also
  covered the classic aircraft fallback, beacon animation bounds and timer ready
  state. Screenshot: `build/macos/chat-popout.png`.

### Captured outpost range indicator

- Allow the existing selection range ring for captured armed tech structures,
  whose `TechLevel=-1` previously suppressed it. Uses the actual weapon range and
  the same renderer as SAM/flak defenses; no weapon balance changes.
- Added `scripts/outpost-aa-smoke.mjs`: captures an Amazon Delta outpost using an
  engineer, checks missile damage against an airborne Kirov, and verifies the
  range ring appears on selection and hides on deselection.
- Browser regression passed: six-tile weapon ring and selection/deselection
  verified. YR and classic Mac apps rebuilt and signatures verified.

### Chat history, production options, targeting and destruction effects

- Expanded the Enter chat panel with the last ten chat messages. Preserve sender
  colors and audience labels after top-left notices expire, scroll wrapped text
  to the newest message, and grow upward above the command bar.
- Keep YR battle labs and their advanced-unit prerequisites available with
  superweapons off. Disable the labs' Force Shield ability separately, including
  captured/preplaced buildings; retain Spy Plane and other non-disableable powers.
- Mark the minimap canvas texture as sRGB to avoid a second brightness conversion.
  A GPU sample now displays gray 128 as 128 rather than 188 (32% lower).
- Include batched sprite layer 1 in picking, so building graphics can be targeted
  above their foundation. Anchor infantry/tank hitboxes above their feet.
- Align engineer cursor and entry-time eligibility, including selling buildings
  and the multi-engineer tech-building exception.
- Remove incorrect weather-storm flags from debris and Psychic Dominator blasts;
  actual Lightning Storm strikes retain their lightning effects.
- Validation: 134 unit tests passed; entry typecheck retains 42 baseline errors.
  Asset-backed browser checks passed for all three factions' labs/advanced units,
  disabled powers, building sprite picking, capture eligibility and destruction
  flags. Actual engineer capture/outpost AA regression passed. Two engine clients
  verified ten-message history, reopening, audience routing and panel bounds,
  matched 150 ticks, and stopped on injected divergence at frame 151.
- YR and classic macOS apps rebuilt; both code signatures verified. Screenshot:
  `build/macos/chat-popout.png`. These shared engine changes also apply to Linux;
  both players must rebuild matching source/revision before reconnecting.

### Solo multiplayer starts

- Permit a ready host to start alone or against bots. The UI no longer requires
  two connected clients; the server defaults to one human while retaining an
  explicit `allowSinglePlayer: false` opt-out. Map/content and guest readiness
  requirements remain enforced.
- Validation: 137 unit tests passed, including solo loading/order relay, a bot
  opponent, and blocking an unready guest. `RA2_SOLO_SMOKE=1` runs the real engine
  smoke with one client and no opponents: it loaded and advanced 150 ticks without
  premature victory. Entry typecheck retains 42 baseline errors. Both Mac variants
  rebuilt and signatures verified.

### In-game connection stalls and AI takeover

- Add a centered synchronization overlay after 1.5 seconds of stalled turns.
  Only the host receives per-player progress/ping attribution and sees Keep
  waiting / Kick & replace with AI. Ordinary players see a generic wait message.
  The wall-clock UI continues updating while simulation ticks are blocked and
  disappears automatically when the connection recovers.
- Add the pre-game `disconnectAi` option: destroy a departed commander's assets
  (default) or replace them with Normal AI. Guests cannot change it, and it is
  locked once play starts. Explicit host kick-to-AI overrides the option.
- Schedule replacement/destruction on the first frame without an order from the
  departed peer. Surviving clients preserve already accepted orders and execute
  the same control action on the same tick. AI retains army, structures, credits,
  country and alliances. Destruction does not redistribute assets to allies.
- Record control actions in replays; reject player-injected control actions.
  Direct multiplayer Quit bypasses the legacy resign action, which previously
  destroyed/transferred assets before the selected disconnect policy could run.
- Validation: 142 unit tests pass; entry typecheck retains 42 baseline errors.
  Three-client engine smokes passed for host kick, natural recovery, Quit-to-AI
  and Quit-to-destruction: both survivors matched all 450 ticks. Takeover retained
  assets/credits, started Normal AI, and recorded its control action for replay.
  Native helper hosting/content/cleanup smoke passed. Both Mac variants rebuilt.
- This does not implement reconnect/resume, observers, persistent rooms or host
  migration. Quitting the embedded host still stops the server. Guest connection
  timeouts retain the existing 120-second deadline and follow the chosen policy.
- Browser scenarios: `RA2_TAKEOVER_SMOKE=1` on `scripts/lockstep-engine-smoke.mjs`;
  add `RA2_DROP_POLICY=ai` or `RA2_DROP_POLICY=destroy` for real Quit handlers.
  Do not combine this mode with the solo or two-client HUD mode. Logs/screenshots
  are ignored under `build/macos/stall-*`, `quit-*-engine-smoke.log`, and
  `network-stall-{host,guest}.png`.
