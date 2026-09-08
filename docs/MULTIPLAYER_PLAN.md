# Multiplayer lobby system plan

**Status:** Direct-IP core and phase-2 host content delivery implemented; physical-device acceptance remains open. The direct-IP Electron host,
authoritative server, client lockstep, and RA2-style lobby are implemented;
automated socket, UI, and two-engine smokes pass. Physical two-machine/full-match
acceptance remains open. See [implementation and testing](MULTIPLAYER.md).
Work has resumed; [the handoff](MULTIPLAYER_PROGRESS.md) records current
validation, client sync cross-checking and the remaining acceptance work.
The remaining sections describe the target design for
replacing the QR-code WebRTC LAN prototype with an OpenRA-style lobby: one
server per game, a server browser backed by a master server, password-protected
rooms, version and mod checks in the handshake, host-to-client map delivery,
and direct IP/port joining. The [porting playbook](PORTING_PLAYBOOK.md)
records history; this document records intent.

Everything here was written against OpenRA's source at its current `bleed`
branch and its master-server repository. OpenRA is GPL-3.0, the same licence
as this repository, but **no OpenRA code is copied here and none should be
copied without recording it** — see [Attribution](#attribution) at the end.

## 1. Where we are

The tree contains three multiplayer stacks; one is alive.

| Stack | State | Where |
| --- | --- | --- |
| Chrono Divide online (WOL / IRC / gserv) | Dead. `WolConnection.ts` and `IrcConnection.ts` are stubs; the lobby, quick-game, custom-game and login screens exist as source but are never registered in `Gui.ts`. `game/GameTurnManager.ts` does no networking. | `redalert2/src/network/*.ts`, `gui/screen/mainMenu/{lobby,quickGame,customGame,login,ladder}` |
| LAN over WebRTC, QR-code signalling | Wired end to end, never played on two machines. Full mesh, strict same-tick lockstep, no desync detection. | `redalert2/src/network/lan/*`, `gui/screen/mainMenu/lan/*` |
| Solo / replay turn managers | Production. Skirmish, campaign, save/load. | `network/gamestate/*` |

Facts that shape the plan, all verified in this tree or by experiment:

- The sim is deterministic by design and seeded from `gameId` + `timestamp`
  (`GameLoader.ts:45`). Actions already serialize to bytes through
  `network/gameopt/Serializer.ts` and parse back through `Parser.ts`; these
  are the original WOL wire helpers and stay as the order encoding.
- `game.getHash()` (`Game.ts:919`) hashes the whole world and
  `debugGetState()` dumps it. The LAN prototype logs the hash every 300 ticks
  and never compares it.
- Base tick rate is 15/s (`GameSpeed.BASE_TICKS_PER_SECOND`), so one tick is
  about 66 ms.
- `Engine.computeModHash()` (`Engine.ts:364`) already hashes the rules, art,
  AI, theater and mode-override INIs in play. Together with
  `Engine.getActiveMod()` and the engine type (RA2 vs YR) that is our "mod".
- The app's page origin is `ra2app://app`. In the Electron shell this is a
  secure context, and from it a plain `ws://<lan-ip>:<port>` handshake and a
  plain `fetch('http://<lan-ip>:<port>/')` both reach a listener on another
  address — no mixed-content block (tested on Omarchy with `electron43`,
  7 Sep 2026). Loopback works too. WKWebView is untested (spike S1).
- Cheats are already forced off outside single player (`GameScreen.ts:189`),
  the replay recorder already records LAN matches, and
  `LanLoadingScreenApi.ts` already shows per-player load progress.
- Retail assets (~750 MB) are each player's own import and may not be
  redistributed. The handshake compares them; nothing ever transfers them.

## 2. What OpenRA actually does

Read from `OpenRA.Game/Server/Server.cs`, `Server/ProtocolVersion.cs`,
`Server/OrderBuffer.cs`, `Network/{Session,OrderManager,Handshake,GameServer,Nat}.cs`,
`OpenRA.Mods.Common/ServerTraits/{LobbyCommands,MasterServerPinger,PlayerPinger}.cs`,
`Widgets/Logic/{ServerListLogic,DirectConnectLogic,ServerCreationLogic}.cs`,
`Map/MapCache.cs`, and the master server's `ping.php` / `games.php`.

**Topology.** Every game has exactly one server. "Create game" starts a server
inside the host's own process and the host connects to it as an ordinary
client; a dedicated server is the same class run headless. Clients only ever
talk to the server; the server relays. Nothing is peer-to-peer.

**Wire protocol** (`ProtocolVersion.cs`). TCP, packets are
`Int32 length | Int32 clientId (0 = server) | Int32 frame | orders…`, capped at
128 KB. Order types: world order (`0xFF`), sync hash + defeat bitmask (`0x65`),
client disconnected (`0xBF`), handshake / server order as key-value strings
(`0xFE`), order acknowledgement (`0x10`), ping (`0x20`), tick scale (`0x76`).
Frame 0 means "immediate": lobby commands, chat, server messages. Two
protocol numbers are checked separately: the handshake protocol (7, changed
only as a last resort) and the orders protocol (21).

**Handshake** (`Handshake.cs`, `Server.ValidateClient`). Server sends the
handshake version and the new client id, then a `HandshakeRequest {Mod,
Version, AuthToken}`. Client replies `HandshakeResponse {Mod, Version,
Password, OrdersProtocol, Fingerprint, AuthSignature, Client{Name, Color,
PreferredColor}}`. The server rejects, in order: game already started; wrong
or missing password (two distinct messages); mod mismatch; version mismatch;
orders-protocol mismatch; banned IP. The first client to complete becomes
admin. A client with no free slot becomes a spectator if spectators are
allowed, otherwise is rejected as "full". New non-admin clients get a chat
cooldown (flood limit). Dedicated servers send a MOTD.

**Lobby state** (`Session.cs`). One `Session` object, authoritative on the
server, re-broadcast whole on every change (`SyncLobbyInfo`): `Clients[]`
(index, name, colour, faction, spawn, team, handicap, slot or null for
spectator, bot type, bot controller, admin flag, state NotReady/Invalid/Ready,
anonymised IP, GeoIP country, connection quality), `Slots{}` (player
reference, closed, allow bots, lock faction/colour/team/spawn, required) and
`GlobalSettings` (server name, map uid, map status, random seed, allow
spectators, game uid, singleplayer allowed, sync reports on/off, dedicated,
`NetFrameInterval` = 3 for a 120 ms net frame on a 40 ms tick, and a
dictionary of lobby options with per-option lock flags).

**Lobby commands** (`LobbyCommands.cs`). Plain strings in immediate orders:
`state`, `startgame`, `slot`, `allow_spectators`, `spectate`, `slot_close`,
`slot_open`, `slot_bot`, `map`, `option`, `reset_options`, `assignteams`,
`kick`, `vote_kick`, `make_admin`, `make_spectator`, `name`, `faction`,
`team`, `handicap`, `spawn`, `clear_spawn`, `color`, `sync_lobby`. Validation:
no command is accepted after the game starts; a client who has pressed Ready
can only change its ready state or (if admin) start. Changing map or options
resets everyone to NotReady. Start requires: admin, every `Required` slot
filled, at least one player, two humans unless singleplayer is enabled, and
enough enabled spawn points.

**Start and lockstep** (`Server.StartGame`, `OrderManager.cs`). On start the
server drops anyone still invalid, seeds a shared `RandomSeed`, picks
`OrderLatency` from the chosen game speed (2 to 6 net frames; "normal" is 3
frames of 40 ms), and pre-seeds `OrderLatency` empty frames for every client so
that frame numbering can begin. From then on a client's orders for frame `F`
are forwarded to everyone stamped `F + OrderLatency`, and the sender receives
an ack telling it to apply its own queued orders at that frame. A client ticks
the world only when it holds a packet from **every** other client for the next
frame, empty packets included; that is what paces the simulation. Between net
frames the client runs `NetFrameInterval` local ticks. An `OrderBuffer` on the
server measures the median arrival skew per client and tells fast clients to
stretch their tick by up to 10 % so nobody runs ahead and stalls.

**Desync detection.** Every net frame each client sends the world sync hash
plus a defeat bitmask. The server compares the packets byte for byte per frame
and on mismatch invalidates its replay; clients compare the hashes they receive
from each other and on mismatch dump a `SyncReport` (last seven frames of
per-trait synced values and orders), mark the world out of sync and stop.

**Drops.** Pings every 5 s; "connection problems" after 10 s; timeout after
60 s. On drop the server injects a `Disconnect(clientId)` order at that
client's last frame + 1 so every client removes them on the same tick. On a
dedicated server the lowest-index human becomes admin if the admin leaves the
lobby; a host-embedded server shuts down when its admin leaves.

**Master server.** The game server POSTs a MiniYAML `Game:` block to
`/ping` (name, `Address` as `0.0.0.0:port` — the master substitutes the
caller's IP —, mod, version, mod title/website/icon, map uid, state 1
waiting / 2 playing / 3 ended, max players, protected, authentication, and the
client list) on every lobby change, rate-limited to once per second and at
least every 3 minutes; the master's TTL is 5 minutes. For a waiting game the
master **opens a TCP connection back** to the advertised port before listing
it and answers `[001] game server … does not respond`, which the client shows
as "check your port forwarding". State 3 deletes the entry. Clients `GET
/games?protocol=2&engine=…&mod=…&version=…` and receive JSON with a `ttl`,
GeoIP `location`, `playtime` and the clients. The browser colours entries by
compatibility (mod, version, map availability) and filters on
waiting / empty / started / password-protected / incompatible.

**LAN and NAT.** `AdvertiseOnLocalNetwork` broadcasts the same YAML over a UDP
beacon (BeaconLib) and the server browser probes for it. `DiscoverNatDevices`
(off by default) uses Mono.Nat to add a UPnP / NAT-PMP TCP mapping.

**Direct connect.** A dialog with an IP field and a port field (default
1234), remembering the last server; a launch argument or URL can pre-fill a
target so a website link joins directly.

**Maps.** OpenRA does *not* push maps from the host. A map is its SHA-1 uid;
a client that lacks it queries the Resource Center
(`MapRepository/hash/<uids>/yaml`) and downloads it, with a per-user
`AllowDownloading` switch. The server keeps a `MapStatusCache` that lints maps
before they can be selected and can restrict a dedicated server to a
`MapPool`. Bots are ordinary clients whose orders are issued by the client
that added them (`BotControllerClientIndex`).

## 3. Design for this project

### 3.1 Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Topology | OpenRA's: one server per game, clients connect to it. Host-embedded by default, dedicated optional. | Star, not mesh: one place to relay, validate, compare hashes and record. The mesh code goes away. |
| Transport | WebSocket. Clients use the page's `WebSocket`; the listener lives outside the page. | Verified to work from `ra2app://` in the Electron shell to LAN and loopback addresses; works unchanged in browser dev mode against a local server; Node, Bun and Network.framework all speak it. |
| Where the server code lives | One TypeScript package, `redalert2/src/network/server/`, with **no DOM and no Node imports**, behind a `ServerTransport` interface. | The same core runs in the Electron main process (host-embedded), under Bun (dedicated and dev), and inside the host's page behind a native relay on iOS/macOS. |
| Lockstep | OpenRA's order-latency scheme replaces the same-tick barrier: orders for tick `T` apply at `T + L`, server pre-seeds `L` empty frames, clients tick only when every peer's frame is present. | Removes the RTT stall on every tick. `L = 2` on LAN (133 ms), `L = 4` over the internet, chosen per game speed as OpenRA does. |
| Desync handling | Sync hash every net frame, compared on the server and cross-checked on clients; mismatch ends the game with the frame number and writes `debugGetState()` from each client for diffing. | The hash and the state dump already exist; only the comparison is missing. |
| Bots | Keep this project's approach: bots run deterministically on every client, no bot orders on the wire. Fallback is OpenRA's model (only the controlling client runs the bot and sends its actions) if cross-platform determinism proves fragile. | Zero traffic, already how the LAN prototype works. The sync hash tells us within seconds if it is wrong. |
| Retail assets | Never transferred. Handshake compares an *asset fingerprint*. Custom maps and mod overlays are served by the host's server in phase 2. | Legal and practical: retail content stays each player's own import. |
| Identity | Player name only, no accounts. | OpenRA's fingerprint/auth service is out of scope; leave the fields in the handshake for later. |
| Existing WebRTC/QR path | Retire once phase 1 plays end to end on two machines. Keep `qrcode` to render a *join link* QR. | Two transports is double the surface. A QR of `ra2://host:port` gives iPad the same "scan to join" without SDP blobs. |

### 3.2 Components

```
Host machine                                     Guest machine
┌────────────────────────────────────┐           ┌──────────────────────────┐
│ shell (Electron main / Swift / Bun)│           │ page                      │
│  ┌──────────────────────────────┐  │  ws://    │  WebSocketConnection ─────┼─┐
│  │ GameServer  (TS core)        │◄─┼───────────┼─ NetworkTurnManager       │ │
│  │  Session · LobbyCommands     │  │           │  LobbyClient / UI         │ │
│  │  OrderRelay · SyncCheck      │  │           └──────────────────────────┘ │
│  │  MapStore · Announcer        │  │                                        │
│  └──────────────▲───────────────┘  │  ws://127.0.0.1 (Electron/Bun)         │
│                 │ ServerTransport   │  or bridge relay (WKWebView)           │
│ page: host's own client ───────────┘                                        │
└────────────────────────────────────┘                                        │
                                                                              │
Master server (Bun, HTTPS): POST /ping (connect-back check) · GET /games ◄────┘
```

**`network/server/` (new, pure TS).**

- `GameServer` — connection lifecycle, handshake, state machine
  `waiting → started → ended`, admin assignment and transfer, kick/ban, MOTD,
  flood limit, ping/timeout (5 s / 10 s warn / 60 s drop, as OpenRA).
- `Session` — the lobby model. Direct port of the shape of `LanRoomState`
  merged with OpenRA's `Session`: clients (id, name, country, colour, start
  position, team, slot index or observer, bot, admin, ready state, ping,
  anonymised address), slots (open / closed / open-observer / player / AI —
  `SlotInfo.ts` already has the enum), global settings (the existing
  `GameOpts` verbatim, plus server name, random seed, `orderLatency`,
  `netFrameInterval`, allow spectators, map digest and map status).
- `LobbyCommands` — the OpenRA command list above minus handicap, vote kick
  and map generation, validated the same way (nothing after start; Ready
  freezes everything but ready/start; map or option change un-readies all).
- `OrderRelay` — frame numbering, `orderLatency`, per-client last frame, ack
  to sender, forward to others, pre-seeded empty frames at start, `Disconnect`
  injection at last frame + 1, server-side replay recording.
- `SyncCheck` — byte compare of sync packets per frame; on mismatch broadcast
  `OutOfSync {frame}` and stop relaying.
- Content store — the current verified map/unit package and manifest, served
  to authenticated clients (see 3.5); currently embedded in `GameServer`.
- `Announcer` — master-server pinger and LAN beacon payload builder (phase 2b
  and 3).
- `ServerTransport` — `listen()`, `onConnection(conn)`, `conn.send(bytes |
  string)`, `conn.close(reason)`, `conn.remoteAddress`. Implementations:
  `NodeWsTransport` (Electron main, `ws` package), `BunWsTransport`
  (`Bun.serve` websocket, no dependency), `ShellRelayTransport` (page side of
  the Apple bridge).

**Client side (page).**

- `WebSocketConnection` implements the existing `IConnection`-shaped role the
  LAN code expects: `send(frame, actions)`, `sendImmediate(msg)`,
  `sendSync(frame, hash)`, `receive()`.
- `NetworkTurnManager` replaces `LanLockstepTurnManager`: same public surface
  (`doGameTurn`, `onLagStateChange`, `setPassiveMode`) so `GameScreen.ts`
  changes only where it constructs the manager; internally it is OpenRA's
  `OrderManager.TryTick` — queue per client, ready when every queue is
  non-empty, `netFrameInterval` local ticks between net frames, sync hash
  after processing each net frame.
- `LobbyClient` — connects, runs the handshake, holds the last `Session`,
  sends commands, exposes chat. Replaces `LanRoomSession` + `LanMeshSession`.
- `ServerBrowserService` — master list fetch, LAN beacon results, recent
  servers (`LanRecentPlay.ts` extends to store host:port).

**Shells.**

- Electron (`linux/main.js`): start `GameServer` on `NodeWsTransport` when the
  page asks (`__RA2_SHELL__.hostGame(opts)` over `contextBridge`), return the
  listen port; UDP beacon with `dgram`; register `ra2://` with
  `app.setAsDefaultProtocolClient`.
- macOS / iOS (`macos/Sources/main.swift`, `ios/Sources/*.swift`):
  `NWListener` with `NWProtocolWebSocket` accepting connections and relaying
  each connection's messages to the page through `webkit.messageHandlers` /
  `evaluateJavaScript`; the page runs `GameServer` on `ShellRelayTransport`.
  `NSLocalNetworkUsageDescription` is already in `Info.plist`; add
  `NSBonjourServices` only if we advertise over Bonjour. Register
  `CFBundleURLTypes` for `ra2://`.
- Dedicated (`redalert2/server/dedicated.ts`, `bun run server`): `GameServer`
  on `BunWsTransport`, CLI/env flags mirroring OpenRA's `launch-dedicated.sh`
  (name, port, password, map, advertise, record replays, MOTD).

### 3.3 Protocol

Text frames (JSON) for everything immediate, binary frames for order and sync
packets. Version the two independently, as OpenRA does.

```
client → server   hello      { protocol: 1, name, password?, mod, version, modHash,
                               assetFingerprint, engine: 'ra2' | 'yr', preferredCountry, preferredColor }
server → client   welcome    { clientId, session }              // or
server → client   error      { code: 'gameStarted' | 'passwordRequired' | 'passwordWrong'
                             | 'modMismatch' | 'versionMismatch' | 'assetMismatch'
                             | 'protocolMismatch' | 'full' | 'banned' | 'kicked' }
either            command    { name, args }                     // lobby commands (3.2)
server → client   session    { session }                        // full re-sync on every change
either            chat       { to: 'all' | 'team' | clientId, text }
server → client   message    { key, args }                      // system lines
server → client   startGame  { gameId, timestamp, gameOpts, orderLatency, netFrameInterval }
client → server   loaded     { percent }                        // keeps LanLoadingScreenApi
server → client   ack        { frame, count }
server → client   disconnect { clientId, frame }
server → client   outOfSync  { frame }
server ↔ client   ping/pong  { t, queueLength }
server → client   tickScale  { scale }                          // phase 4

binary  order packet:  u8 kind=0x01 | u32 clientId | u32 frame | actionBytes (Serializer.serializePlayerActions)
binary  sync packet:   u8 kind=0x02 | u32 frame | u32 hash | u64 defeatMask
```

Rejection order and messages follow OpenRA's `ValidateClient` exactly, with
`assetMismatch` added after the version check.

**Versioning.** `version.ts` is a hard-coded `0.0.1`. Stamp it at build time
(`git describe --tags --always` through a Vite `define`) so the handshake and
the master list carry a real value, and keep `Engine.getModHash()` as the mod
identity. The server-list entry shows `version` and a short `modHash`; a
mismatch greys the entry as "incompatible" instead of failing at join.

**Asset fingerprint.** Hash of the seeded asset manifest
(`gameres/manifest.json`: names, sizes, CRCs) plus the engine type. Computed
once at boot and cached in `LocalPrefs`. Different retail sources (Origin vs
Steam, RA2 vs YR, a patched `ra2md.mix`) fail the handshake with a message
that says which side differs. This replaces "the host pushes assets".

### 3.4 Lockstep details

- `orderLatency` and `netFrameInterval` come from the game speed the host
  picks, in a table like OpenRA's `GameSpeeds` (`mods/ra/mod.yaml`), tuned
  for our 66 ms tick: LAN `L = 2, N = 1`; internet `L = 4, N = 1`; a "slow
  link" option `L = 6, N = 2`.
- On `startGame` the server pre-seeds `L` empty frames per client. The client
  begins ticking when all clients report `loaded: 100` (our existing gate)
  **and** frame 1 is complete.
- Sync hash every net frame. Measure `game.getHash()` first (spike S3); if it
  is more than ~1 ms on an iPad it moves to every 5th net frame and the
  `syncFrame` cadence goes into `startGame`.
- Drop: server injects `disconnect {clientId, frame}`; `NetworkTurnManager`
  turns it into the existing `ActionType.DropPlayer` at that frame, exactly as
  `LanLockstepTurnManager.processResolvedTurn` does today.
- Lag: `onLagStateChange` fires when a frame is incomplete for more than one
  tick; the overlay names the missing players, using the server's last ping
  data (`ConnectionInfoScreen.ts` already renders this shape).
- Replays: the client-side `ReplayRecorder` keeps working unchanged; the
  dedicated server records too (phase 4).

### 3.5 Maps, mods, assets

- **Official maps** remain local. Existing map-list and replay keys retain CRC-32
  compatibility; transferable files and package manifests use SHA-256, with a
  portable TypeScript fallback when `crypto.subtle` is unavailable.
- **Custom maps**: the host uploads a canonical manifest and bounded chunks through
  its authenticated lobby WebSocket. The server verifies and atomically publishes
  a complete package; clients request missing files on the same connection.
  SHA-keyed verified memory caching avoids repeated transfers (64 MiB bound).
  Ready is blocked until map and current package acknowledgements both match.
  This replaces the originally proposed HTTP map endpoint and avoids a second
  transport for delivery. Apple shell integration remains future work.
- **Mod overlays** (custom `rules`/`art` INIs, the [modding](MODDING.md)
  layer) ride the same path in phase 2: the session lists overlay files by
  digest and clients fetch what they lack. This is host-to-client, unlike
  OpenRA, because there is no resource centre; a repository service can be
  added later with the same digests.
- **Retail assets**: compared by fingerprint, never sent. Say so in the UI when
  a join fails for that reason.
- **Custom units and dependencies**: the host selects a content package containing
  custom maps, rules/art overrides, and the supported graphics, cameos, palettes,
  animations, sounds and strings those units reference. Reusing installed retail
  resources is supported; transferring a map alone is not sufficient for units
  with new artwork. Only engine-supported definitions are in scope; downloadable
  executable code and new engine mechanics are outside this milestone.
- **Package identity and loading**: use a canonical manifest with normalized paths,
  file sizes, SHA-256 digests and explicit overlay order, plus a digest for the
  manifest itself. The implementation uses sorted flat filenames and a fixed
  base/variant/project INI patch order. Keep base engine/version/retail compatibility checks separate
  from downloadable session content so a missing overlay can be fetched instead
  of failing the initial mod-hash check. Verify the effective content identity
  after mounting and before Ready. Implement and verify the resource-loading path;
  the existing mod importer/menu is not a completed end-user workflow.
- **Session lifecycle**: stage verified files in a digest-keyed cache and mount
  them as a session overlay without replacing the retail import or another mod.
  Rebuild rules and affected resource caches before loading the match. Unmount
  and restore the previous resource configuration on leave, failure or host change.
  Changing the package clears Ready for everyone; stale transfers cannot satisfy
  the new manifest. The server gates Start on every participant's current content
  acknowledgement. Cache reuse must still verify the requested identity.
- **Transfer handling and UI**: authenticated lobby clients fetch only files in
  the selected manifest. Bound file/package sizes, chunk sizes and concurrent
  transfers; reject invalid paths, duplicate normalized names, corrupt data and
  unsupported files. Show package name, size, download/verification progress,
  retry/cancel and a concrete failure reason using existing RA2 menu controls.
  Disconnects and cancellation clean up partial files and keep Ready disabled.

### 3.6 Direct IP and discovery

- **Join by address**: one field accepting `host`, `host:port`,
  `[v6]:port` or `ra2://host:port`; default port `1620`; password prompt on
  `passwordRequired`; last five targets remembered. This is the phase-1 UI,
  before any browser exists.
- **`ra2://host:port[?password=…]`** handled by all three shells; the page
  reads it from `__RA2_SHELL__.launchUrl` at boot and goes straight to the
  join flow, as OpenRA's launch-argument path does. The host screen renders
  this URL as a QR code for iPads and phones.
- **LAN discovery** (phase 2b): UDP broadcast beacon every 2 s on a fixed port
  carrying the same announce JSON; Electron main uses `dgram`, the Apple
  shells `NWListener`/`NWConnection` over UDP. Bonjour is an alternative on
  Apple only; the beacon is the same code everywhere, so prefer it.
- **NAT**: document port forwarding and let the master server's connect-back
  check tell the host it is unreachable. UPnP / NAT-PMP is phase 4 and
  Electron-only.

### 3.7 Master server and browser

- Bun, one process, SQLite via `bun:sqlite`, behind Caddy for TLS. Endpoints
  mirror OpenRA's master: `POST /ping` (announce JSON; connect-back TCP check
  when `state === 'waiting'`; 5-minute TTL; returns `[code] message` with
  `1 = not reachable`), `GET /games?protocol=1&engine=&version=` (JSON list
  with `ttl`, `playtime`, optional GeoIP), `GET /versioncheck?version=`
  (`latest | outdated | unknown`). Rate limit `/ping` per source address.
- `Announcer` in the server core pings on every session change, at most once
  per second and at least every 3 minutes; on `ended` it pings once more to
  delist.
- Configuration: `public/config.ini` already has `serversUrl` and friends;
  add `masterUrl` and `advertiseOnline` (default on for dedicated, prompt on
  first host for embedded).
- Browser UI: `GameBrowser.tsx` (201 lines, from the old WOL screens) shows
  name, players/max with bots and spectators, map, version, lock icon,
  location and compatibility colour; filters waiting / started / protected /
  incompatible; sections for master, LAN beacon and recent. Join runs the same
  `LobbyClient.connect` as direct IP. A `PasswordBox.tsx` already exists.

### 3.8 Lobby UI

Reuse the old screen components rather than the LAN prototype's:
`PregameController`, `LobbyForm.tsx` (slot rows: name, country, colour,
start position, team, ready), `CreateGameBox.tsx` (name, password, port,
advertise online / on LAN), `MapSelScreen`, `ChatHistory`. Host-only controls:
map, options, slot open/close/AI, kick, make admin, start. Everyone: own slot
settings, ready, chat, leave. In game: `DiploScreen.ts` and
`ConnectionInfoScreen.ts` get their `gservCon` replaced by `LobbyClient`.

## 4. Phases

Each phase ends playable and has a smoke script under `scripts/`, in the
style of the campaign smokes and `ai-liveness-probe.js`.

**S. Spikes (before phase 1, about two days).**
S1 On the Mac: does `new WebSocket('ws://<lan-ip>:port')` from
`ra2app://app` in WKWebView connect, and does `fetch` to it? S2 A 100-line
Swift `NWListener` WebSocket relay that echoes into the page. S3 Cost of
`game.getHash()` per tick on iPad mini and on the Linux box, and confirm
`getHash()` is identical across V8 and JavaScriptCore for the same game
(the first real cross-engine determinism test this engine has had). S4 Build-time
version stamping.

**S3 result (7 Sep 2026): the simulation is deterministic across V8 and
JavaScriptCore.** `scripts/determinism-cross-engine-smoke.mjs` runs the same
seeded skirmish headlessly (Stormy Weather, idle human, Brutal/Normal/Easy
bots, seed `spike-s3/1757000000000`) and records `game.getHash()` every 100
ticks. Chromium 151 (V8) and Playwright WebKit 26 (JavaScriptCore, WPE) agree
on all 61 checkpoints through tick 6000, about 6.7 minutes of game time with
combat under way, and two Chromium passes agree with each other. Three
findings explain why and bound the cost:

- Raw `Math.sin/cos/atan2/asin/acos/hypot/exp/log` differ between V8 and
  JavaScriptCore on 2 to 36 % of inputs (1 ulp, 2 ulp for `hypot`; only
  `sqrt` matches). The sim never calls them: everything routes through
  `game/math/GameMath.ts` (sine lookup table, Newton `sqrt`, polynomial
  `atan2`, integer-scaled `pow`), which is pure IEEE add/multiply. Keep it that
  way: the remaining raw calls on the sim side are `Math.hypot` in
  `game/campaign/CampaignTeams.ts` (campaign only, but it orders a sort) and a
  `Math.random` fallback in `GameApi` that bots do not use.
- `game.getHash()` costs 1.1 ms on the desktop (V8) and 1.8 ms (JSC) with
  about 2,100 objects; the sim itself runs at 0.4 to 0.6 ms per tick headless.
  Hashing every net frame is affordable on desktop; measure on iPad mini
  before deciding the cadence.
- Running WebKit on Arch needs Playwright's Ubuntu build plus Ubuntu's
  `libicu74`, `libxml2` (2.9) and `libflite1` shared objects dropped into
  `minibrowser-wpe/sys/lib`, an in-page shim for `navigator.storage.getDirectory`
  (that build has no OPFS; the smoke uses the repo's `file-system-access`
  ponyfill over IndexedDB), and the menu video stubbed out, because its
  MediaSource fallback aborts WPE's GStreamer web process. The smoke does all
  of this for `webkit`; see its header for the commands.

Still open from S3: the same run on a real Mac/iPad (WKWebView's JSC on
Apple's libm) — the desktop WebKit result makes a difference there unlikely
but not impossible, and `getHash()` cost on the iPad is unmeasured.

**1. Core protocol, host-embedded on Electron, direct IP.**
`network/server/` core with unit tests; `NodeWsTransport` in Electron main;
`WebSocketConnection`, `NetworkTurnManager`, `LobbyClient`; handshake with
password, version, mod hash, asset fingerprint; lobby commands; order latency
lockstep; sync check; drop handling; join-by-address screen; host screen with
name/password/port. Acceptance: two Linux machines play a full skirmish with
bots by IP; a deliberately injected divergence stops both clients at the same
frame with a state dump; pulling a cable drops the player on the same tick on
both sides; a wrong password, a different version and a different retail
import are each refused with the right message.
`scripts/lockstep-smoke.mjs`: two headless engine instances against a Bun
server in-process, with an artificial 200 ms delay and 2 % loss on one link.

**2. Host-to-client maps and custom unit content (direct-IP extension).**
Deliver custom maps and complete custom unit packages from the Electron host to
joining clients using the content manifest, verified cache and session overlay
in section 3.5. Implement map transfer first, then custom rules/art and supported
resource dependencies, within this same milestone. Preserve RA2 menu styling.
Acceptance: a clean guest with only matching retail assets joins a host with a
custom map and a custom unit with original artwork; it downloads missing content,
sees the same unit/cameo, builds and uses it, and matches simulation hashes with
the host. Rejoining reuses verified content. Map/package changes clear Ready;
corruption, interruption, cancellation and stale acknowledgements cannot start
a match. Leaving restores the prior content, verified by starting a stock game.
Add automated transfer/lifecycle tests and an engine/UI smoke with an original
small custom-content fixture. Physical-machine acceptance remains required.

**2b. Apple hosts and LAN discovery.**
Swift relay transport on macOS and iOS (local-network permission prompt
verified); `ShellRelayTransport`; UDP beacon and the LAN section of the
browser; extend phase-2 content delivery to the Swift relay with the chunked
fallback; `ra2://` deep links
and the join-link QR; recent servers. Acceptance: iPad hosts, Mac and Linux
join by scanning the QR and by browsing the LAN list, with a custom map the
guests do not have.

**3. Master server and server browser.**
Bun master with connect-back check and TTL; `Announcer`; `GameBrowser.tsx`
against the live list with filters and compatibility colours; version check
notice on the main menu. Acceptance: a game hosted behind a forwarded port
appears within 3 s, greys out for a client on another version, and shows
"not reachable" to a host without forwarding.

**4. Dedicated server and internet hardening.**
`bun run server`; MOTD, flood limits, IP bans, admin transfer, server-side
replays, adaptive tick scale (`OrderBuffer`), vote kick, UPnP on Electron,
`wss://` behind a reverse proxy. Acceptance: a four-player game on a VPS with
one player on a 150 ms link runs an hour without a stall over one second.

**5. Repositories and identity (optional).**
A map/mod repository service using the phase-2 content digests, and player
identity if ever wanted. Host-to-client mod delivery belongs to phase 2.

## 5. Risks and open questions

- **Cross-engine determinism.** Resolved by spike S3 (see phase S): V8 and
  JavaScriptCore hash identically through 6000 ticks because the sim only uses
  `GameMath`. The residual risk is a future change that calls `Math.*`
  directly on the sim side; the smoke script is the regression test for that,
  and a Mac/iPad run of it is still owed.
- **WKWebView networking from a custom scheme** (S1). If `ws://` to a LAN
  address is blocked there, Apple *clients* also go through the native bridge
  and the relay transport becomes the Apple default in both directions.
- **iOS as host.** A backgrounded WKWebView is suspended; an iPad host that
  switches apps stalls everyone until the 60 s timeout. Say so in the host
  screen; do not try to run the server in a background task.
- **Bots on all clients** doubles as a determinism amplifier: any per-client
  state the bot touches (wall clock, `Math.random`, iteration order of a
  `Map` filled in different orders) desyncs. The playbook already fixed the
  wall-clock case; the sync hash finds the rest.
- **Password in the clear.** Same as OpenRA over TCP. Acceptable on a LAN;
  dedicated internet servers terminate TLS in front of Bun.
- **Map keys** retain CRC-32 for compatibility. Host delivery verifies both the
  manifest and file bytes with SHA-256; use those digests for future repository
  keys rather than the legacy map identifier.
- **Time budget.** Phase 1 is the bulk: the server core plus the turn manager
  rewrite is roughly the size of the existing `network/lan` tree (about
  3,000 lines) and touches `GameScreen.ts` construction only.

## 6. Attribution

The design above is derived from reading OpenRA's source; no OpenRA code was
copied, and the README and `THIRD-PARTY-NOTICES.md` already record OpenRA
under "Designs studied, not copied". Rules for the implementation:

- If any OpenRA code (including yaml tables such as `GameSpeeds`, or the
  master server's PHP logic) is ported rather than reimplemented from the
  description here, add a section to `THIRD-PARTY-NOTICES.md` naming the
  file(s), commit and licence (GPL-3.0, compatible with this repository), and
  extend the OpenRA credit in `README.md`.
- New dependencies proposed here and their licences, to be added to the
  notices when introduced: `ws` (MIT, Electron main only), optionally
  `nat-upnp` or `nat-api` (MIT, phase 4). Bun's WebSocket server and
  `bun:sqlite` are part of the runtime.
- The existing `jsqr` and `qrcode` dependencies stay for the join-link QR;
  `jsqr` can be dropped with the SDP scanner if camera scanning is not kept.
