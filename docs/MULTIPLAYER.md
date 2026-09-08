# Direct multiplayer implementation

**Development resumed:** See [the progress handoff](MULTIPLAYER_PROGRESS.md)
for the latest validation and remaining phase-1 acceptance work.

Phase 1 of [the multiplayer plan](MULTIPLAYER_PLAN.md) is implemented as an
initial working slice. It has automated two-client coverage, including actual
engine instances, but has not completed the plan's physical two-machine,
full-skirmish, cable-pull, or Apple-device acceptance tests. The QR LAN prototype
remains available from the Multiplayer sidebar.

## Play on macOS or Linux

Build and launch the Mac app:

```sh
bash scripts/build-macos.sh
open "build/macos/yr/Red Alert 2.app"
```

Or build and launch the Linux Electron app:

```sh
bash scripts/build-linux.sh
build/linux/yr/run.sh
```

For classic RA2, use `--ra2` and `build/linux/ra2/run.sh`. Both players need the
same build, engine variant, imported retail archives, active mod, and map.

1. Select **Multiplayer**, enter a unique player name, game name, password
   (optional), and port (default **1620**), then **Create Game**.
2. Give the other player the address displayed above the lobby. The guest
   selects **Multiplayer**, enters that address and password, then **Join Game**.
3. Select the map, game options, factions, colours, positions, teams, and bots.
   Each player clicks **Ready**; the host clicks **Start Game**. Two humans are
   required; bots can occupy the remaining map slots.

The macOS and Linux shells host through the menu. Browser development clients
and iPhone/iPad builds can join by address; physical cross-device full-match
validation remains pending. Addresses accept hostnames, `host:port`, `[IPv6]:port`, `ra2://host:port`,
and explicit WebSocket URLs. Passwords are entered separately and never saved
in recent addresses. IPv6-capable external listeners can be joined; the embedded
Mac and Linux listeners currently bind IPv4. The host's TCP port must be reachable.

Leaving as the physical host ends the server, even after transferring lobby
administration. Guests cannot keep a host-embedded match alive independently.

## Implemented

- Runtime-independent `src/network/server/`: authoritative lobby, separately
  versioned handshake/orders, password/version/mod/asset checks, name uniqueness,
  map readiness, slot/bot controls, ready-state locking, chat routing, host
  administration, loading progress, ping and timeout handling.
- Binary order relay with two frames of latency by default, pre-seeded empty
  frames, ordered bounded buffering, server-stamped disconnect frames, and sync
  hash/defeat-mask comparison on both server and clients. Server-stamped sync
  relays use orders protocol 2; older protocol clients are rejected. Packet sizes, future-frame windows, client count,
  command rate, and socket backpressure are bounded.
- `src/network/client/`: direct address parsing, WebSocket lifecycle/retry,
  lobby client, frame buffer, and `NetworkTurnManager`. GameScreen selects it
  for new connections while retaining the LAN manager for the QR prototype.
  Client replay recording continues through the existing recorder.
- Electron IPC hosting with a bundled `ws` adapter, plus a native Bun adapter
  for tests and future dedicated hosting. `bun run build:server` creates
  `dist-server/multiplayer.cjs`; the Linux packaging script stages that bundle
  and the ws MIT licence. No server runtime dependency installation is needed
  in the packaged app.
- macOS WebKit hosting through a bundled standalone Bun helper, with startup
  error reporting, duplicate-host prevention, cancellation, and cleanup on
  departure/app shutdown/content-process failure. See [Mac hosting](MACOS.md#hosting-multiplayer).
- Menus reuse the original LobbyForm controls, metallic sidebar, red world-map
  background and RA2 button art, with settings-style create/join forms.
- Build identity combines the Git description and source-content digest, so
  two different uncommitted implementations cannot share a generic `-dirty`
  version. Retail identity contains a sorted name/size/content-CRC manifest of
  the actually imported MIX/BAG/IDX/CSF files, tagged by engine. CRC computation
  streams large files and caches per-file results by size and modification
  time. It does not trust the shipped size-only seed manifest. These are
  compatibility checks, not cryptographic authentication; no retail bytes are
  transferred.

## Validation

```sh
cd redalert2
bun test
bun run build
bun run build:server
cd ..
bun scripts/lockstep-smoke.mjs
bun scripts/lockstep-smoke.mjs node
```

The socket smoke uses real Bun or Node WebSockets, checks six handshake
rejections, the loading gate, exact echoed payloads and latency, 100 matching
frames under 200 ms one-way delay, and deliberate sync mismatch. It models
2% packet loss as extra retransmission delay while preserving TCP order;
dropping WebSocket application frames would misrepresent the transport.

For engine and menu smokes, start the HTTP development server in another terminal:

```sh
cd redalert2
RA2_HTTP=1 bun run dev
```

Then:

```sh
bun scripts/lockstep-engine-smoke.mjs 150
# Build the Linux YR app first; requires Electron and a Wayland session:
node scripts/multiplayer-ui-smoke.mjs
```

The engine smoke drives two actual loaded games through LobbyClient,
NetworkTurnManager and a Bun listener, with two deterministic bots. Rendering
is stopped after loading to allow fast headless stepping. All 150 frame hashes
matched (about 2,061 objects); a PRNG fault reported divergence at frame 151
on both clients. Results are written to `build/lockstep-engine-smoke.json`.
It validates a short running skirmish, not a completed match or AI combat over
an hour.

The UI smoke creates a real Electron server, joins with Chromium, verifies
wrong-password retry, host departure/recreation on the same port, map changes
and reselection, bot selection, option propagation, teams, all/team lobby chat,
and both ready states. It starts the match through the menu, waits for both
clients to advance at least 30 ticks, then checks host shutdown releases the port.
Screenshots and failure diagnostics are written under `build/multiplayer-ui/`.
Environment overrides: `RA2_ELECTRON`, `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.
Use identical source versions for the built host and development guest.
Restart the development server after source changes when comparing it with a
fresh packaged build, so its build-time identity is refreshed too.

The production web and server bundles build, and all 95 repository tests pass.
The repository-wide frontend TypeScript check reports 42 diagnostics, identical
to a clean HEAD snapshot with the same browser typings; there are no new
diagnostics in the multiplayer paths. Browser build typings
are explicitly separated from Node transport typings.

## Maps and custom units from the host

In the direct-IP lobby, open **Maps and Custom Units** and select **Host content
files**. Select one custom `.map`, `.mpr` or `.yrm` and its loose resource files
in the same file-picker operation. A rules/art-only package applies to the current
map. Custom maps selected through Change Map are shared automatically.

Use `rulescd.ini` and `artcd.ini` for small rule/art patches; variant retail INI
names are also merged as patches. Include the supported resources referenced by
new unit definitions: `.shp`, `.vxl`, `.hva`, `.pal`, `.tmp`, `.wav`, and `.csf`.
Files use flat, case-insensitive names; archives and executable code are not
accepted. Units must use mechanics implemented by this engine. See [MODDING.md](MODDING.md)
for definition and dependency guidance.

The host uploads a manifest and files to its embedded server over the existing
WebSocket connection. Guests automatically download missing files, verify SHA-256
checksums, and mount a temporary resource overlay. Ready and Start require the
current content acknowledgement and matching selected map. The lobby shows byte
progress and verification/errors, with **Cancel Transfer**, **Verify Content**
(retry) and host **Remove Content** controls using the RA2 menu styling.

Limits are 256 files, 32 MiB per file and 64 MiB per package. Verified files are
cached in memory up to 64 MiB and reused by digest, including across package
changes; restarting the app clears this cache. Changing content clears Ready.
Leaving the lobby or match restores prior rules, art, strings, sound definitions
and resource caches. Retail imports are not overwritten or transferred.

The transfer manifest uses SHA-256 while existing map-list/replay CRC keys remain
compatible. This implementation uses chunked WebSocket transfer on the same port,
without requiring a separate HTTP listener or master server. iPhone/iPad host transport
and real-device acceptance remain separate work.

### Local content smoke

Build with `bash scripts/build-linux.sh`. Start `RA2_HTTP=1 bun run dev` from
`redalert2/`, then run `node scripts/multiplayer-content-ui-smoke.mjs` from the
repository root. The test uses the staged Electron host, a fresh Chromium guest,
and port 19621. It generates fixture files under `build/multiplayer-content-ui/fixture`
that can also be selected manually using **Host content files**. Both test
clients must use the same build; restart Vite after rebuilding changed source.

## Remaining acceptance and scope

- A desync stops each client on receipt and records both the server's mismatch
  frame and the actual stopped tick. Earlier runs stopped at ticks 152/153 for
  a frame-151 fault because of in-flight orders; the latest run with client
  cross-checking stopped both at tick 152. Exact same-tick stopping and
  historical frame snapshots for state comparison are not implemented.
  The report is available as `window.__RA2_NETWORK_SYNC_REPORT__` and a JSON
  download where supported. Both server and clients compare hashes. Clients also compare relays against
  their own computed values and detect mismatches without a server notice;
  pending comparisons are bounded and released when a peer disconnects.
- Deterministic disconnect frames are unit-tested. Cable-pull behaviour,
  long-running matches, real cross-platform devices, and iPad hashing cost
  still need acceptance testing. In-game chat/diplomacy/connection-detail
  integration remains separate from the implemented lobby chat and lag signal.
- Phase 1 uses one simulation tick per network frame. Spectators and custom bot
  uploads are explicitly disabled. Official maps must already be present and match. Custom maps and unit
  content can now be delivered by the host. Existing CRC map keys remain unchanged;
  delivery manifests and file verification use SHA-256.
- iPhone/iPad hosting, relay, LAN discovery, join-link scanning/deep-link registration,
  the master browser/service, dedicated CLI, server-side replays, adaptive
  pacing/NAT, and a public mod repository are not implemented by this slice. The runtime
  adapters and protocol provide the foundation without presenting those
  unfinished features as available.

No OpenRA source was copied. The implementation follows the recorded design;
`THIRD-PARTY-NOTICES.md` records the new ws dependency.


## Lobby ping and stalled connections

The lobby shows each player's round-trip ping to the host in milliseconds.
`Measuring…` appears before the first reply. Probes are sent every five seconds;
health updates do not replace lobby options, map verification or readiness.
After ten seconds without player traffic, the host reports a stalled connection
and the remaining slot-hold time. Slots are retained for up to two minutes without
traffic. A guest also sees a warning if it stops hearing from the host. Initial
connection/handshake attempts allow 30 seconds; individual content requests allow
60 seconds.

Delayed pong replies are matched against a bounded set of outstanding probes.
Previously, sending the next ping invalidated the preceding one, so a browser
stall or delayed connection could produce `invalidPacket` and an unnecessary
kick. Duplicate/stale replies are ignored without extending liveness. Malformed
packets, oversized messages and invalid game-frame sequences are still rejected.
An overlapping content request now returns a retryable transfer error instead
of disconnecting the player. Rejection details survive the subsequent socket
close, so an unexplained code is no longer the only diagnostic shown.

This preserves existing connections through temporary stalls. It does not resume
a fully closed WebSocket session; return to Join Game if the connection is lost.
Both host and guest must rebuild from the same commit to use these changes.

Match shutdown handling: leaving a room during victory/defeat stops subsequent
sync/order/load sends, including the remainder of the current simulation tick.
Unexpected send failures enter the match error path; lobby cleanup forwards the
original server rejection or close reason before disposing the match. Diagnostic
export failures cannot suppress the error dialog. These changes do not reconnect
a closed WebSocket or resume an interrupted match.
