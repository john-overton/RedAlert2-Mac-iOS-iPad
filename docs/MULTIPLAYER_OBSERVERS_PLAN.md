# Multiplayer observers and persistent lobbies — implementation handoff

Status: persistent rooms, observer roles, spectator chat and bounded late-join catch-up implemented. Updated 2026-09-08.

## Current implementation checkpoint

The first implementation slice adds protocol v3 match generations, per-match
return/disposal without closing the socket, combatant-only loading/order/sync
barriers, and reusable waiting-room state. The multiplayer room owner survives
game and score views. Return to Lobby retains hosting; Leave Server closes it.
A commander returning while others play is removed by the existing deterministic
departure policy. Each remaining commander must independently leave its round
before another can start; an individual completion claim cannot reset a match
that still has other commanders. Desync is reported separately from completion.

Observer roles now work in waiting and running rooms, including rooms with no
free commander seat. Default running-room joins wait for an explicit Observe Game
choice; joining explicitly as Observer starts observation after content validation.
Observers use the original roster and seed plus a detached local observer, replaying
committed frame history without sending orders or syncs or entering player barriers.
Chat audiences are enforced by the server, with immutable identity/team metadata.
Handshake protocol is now **4**; binary orders remain **3**.

History is capped at 64 MiB of accounted payload or 100,000 frames per match,
including pending frames. Exhaustion disables observation without stopping players.
History pulls return at most 32 frames / 64 KiB; the observer uses bounded buffering
and an 8 ms catch-up simulation budget with reduced rendering and historical
sound/EVA suppression. Observation attempt IDs protect cancellation and same-round
retry. See [MULTIPLAYER_PROGRESS.md](MULTIPLAYER_PROGRESS.md) for validation.

## Scope and remaining acceptance

Shared web/engine/network code serves native macOS and Linux builds and retains
classic RA2 support. Physical Mac/Linux interoperability and iPad performance still
need device acceptance. The implementation below is local; do not publish, push,
or send messages to other people without authorization. Remaining sections preserve
the requirements and design rationale; the checkpoint above describes implemented
behavior rather than treating every original milestone as future work.

## User requirements

1. Players can select an observer role in a waiting multiplayer lobby.
2. When connecting to a server, discover whether its match is running:
   - Waiting room: join the lobby.
   - Running match: offer **Observe Game** or **Wait in Lobby**.
3. Observers can join an already-running match, catch up, and watch live.
4. Observers never participate in the active players' lockstep barriers. A slow,
   disconnected, or still-loading observer must not pause or desync the match.
5. After a match ends, players and observers return to the **same hosted lobby**.
   Preserve the connection, server process, map/settings and useful slot choices;
   clear readiness and match-specific state so another game can start.
6. Spectator chat is spectator-only. Active players cannot see spectator messages.
   Spectators can see public chat and **all teams' team chat**, with clear team
   labels/color coding. This is explicitly requested, not a privacy bug.

This plan uses “observer” for UI labels and “spectator” as the same role.
Ready remains a separate action from Start Game; solo starts must keep working.

## Chat behavior and presentation

| Sender / channel | Active players receive | Observers receive |
| --- | --- | --- |
| Player / All | All active players | All observers |
| Player / Team N | Members of Team N only | All observers, labeled Team N |
| Observer / Observers | Nobody | All observers, including sender echo |
| Player / private whisper | Existing intended participants only | No additional access |

- Enforce recipients on the **server**, not by hiding already-delivered messages
  in the UI. Ignore/reject attempts by an observer to send All/Team chat, private
  messages to active players, or game orders.
- Observers' composer targets Observers only; retain Enter, Escape, history and
  top-left notification behavior. Active-player Tab audience cycling remains.
- Suggested presentation: `[All]`, `[Team 1]`, `[Team 2]`, `[Observers]` badges.
  Keep sender names in player colors. Give team badges a stable palette by team
  ID and observer badges a distinct neutral/purple color. Always show text labels
  so color is not the only distinction; show “No team” where applicable.
- Preserve sender/recipient identity and team metadata even after players leave
  or change lobby teams. Do not look up a past message's team from current state.
- Keep active-player replay exports public-chat-only unless deliberately extending
  their format. Do not leak hidden spectator or other-team chat into player
  replays, local notifications, history, or debug UI.
- Recommended defaults: explicit observers stay observer-only in the waiting
  room too. Members merely waiting for the next game are not silently classified
  as observers or granted full observer chat. Keep private whispers private.
  These edge-case defaults were not separately specified by the user; document
  any implementation choice clearly rather than expanding access accidentally.

## Completed baseline (do not redo)

- `f2dbee0`: ten-message chat history, superweapons-off battle-lab availability,
  minimap sRGB correction, destruction-lightning fixes, building/ground-unit
  picking fixes and engineer cursor/entry validation alignment.
- `7b4153c`: **Allow solo multiplayer starts and host matches against bots**.
  UI accepts one occupied human seat. Server defaults to one human, with explicit
  `allowSinglePlayer: false` opt-out. Other humans still need map/content and
  readiness. A real solo engine match advanced 150 ticks without premature victory.
- 137 unit tests pass. Entry typecheck has 42 pre-existing errors; fix newly
  introduced errors but do not turn this task into unrelated type cleanup.
- macOS YR and RA2 apps were rebuilt and signatures verified before the solo patch
  was committed. They therefore contain an earlier git revision in their build
  ID. Rebuild after the final implementation/commit when testing matching builds.

## Current architecture and obstacles

Read these files first:

- `redalert2/src/network/server/GameServer.ts`
- `redalert2/src/network/server/Protocol.ts`
- `redalert2/src/network/server/Session.ts`
- `redalert2/src/network/client/LobbyClient.ts`
- `redalert2/src/network/client/NetworkMatchSession.ts`
- `redalert2/src/network/client/NetworkTurnManager.ts`
- `redalert2/src/gui/screen/mainMenu/multiplayer/MultiplayerScreen.ts`
- `redalert2/src/gui/screen/mainMenu/multiplayer/component/` (locate current form)
- `redalert2/src/gui/screen/game/GameScreen.ts`
- `redalert2/src/gui/screen/game/NetworkChatHandler.ts`
- `redalert2/src/gui/screen/game/component/hud/HudChat.tsx`
- `redalert2/src/gui/screen/game/component/hud/viewmodel/MessageList.ts`
- `redalert2/src/network/lan/LanRoomSession.ts` (launch descriptor shape)
- Existing replay/loading/observer UI code, discovered with `rg` before reuse.

Known constraints:

- `GameServer.hello()` rejects any non-waiting room with `gameStarted`.
  `allow_spectators` currently refuses enabling spectators. Nullable `slotIndex`
  and `allowSpectators` exist, but that is **not working spectator support**.
- `startGame()` adds all connected clients to `active`. Loading, order-sequence,
  and sync checks consider connected peers. These must use combatant membership,
  not all room members, before any observer/waiter can safely connect.
- Server relays orders and sync reports, then discards completed sync state. It
  does not maintain an adequate match archive/checkpoint for late joining.
- `NetworkMatchSession` buffers only 512 future order frames and 256 future sync
  frames, and requires sequential sync reports. Dumping an entire match into it
  will fail. Never simply remove these limits without flow control/bounds.
- `NetworkMatchSession.leaveRoom()` closes its socket. `GameScreen.onGameEnd()`
  calls it synchronously during the simulation's final update. Prior fixes guard
  trailing sync sends and preserve the original disconnect error. Preserve those
  protections while separating end-of-match from leave-server behavior.
- `LobbyClient.close()` disposes the match AND connection. Multiplayer screen
  owns hosting/connection state; its disconnect path calls native `stopHosting`.
  The room must have a lifetime independent of temporary game/menu screens.
- Embedded hosting stops when the host connection drops. A host returning to the
  lobby must not accidentally shut down the server for everyone else.
- Server `ended` state currently includes out-of-sync failure, not a complete
  reusable normal-match-finished protocol. Treat normal results, forfeits,
  desyncs and transport failure as different transitions.
- Existing `Game.checkGameEndConditions()` already avoids immediate victory when
  there is only one total player; retain this solo-practice behavior.

## Implementation sequence

### 1. Persistent room and match lifecycle

- Separate room ownership, connection lifetime and per-match resources. Keep the
  existing transport/helper alive across game, score and lobby screens.
- Add explicit match identity/generation to match control and stale-frame handling.
  Ensure old queued orders, syncs, loading messages and callbacks cannot enter the
  next match. Version protocol changes so older builds fail clearly.
- Define normal match completion through validated player reports/authoritative
  agreement; do not let an observer or a single arbitrary client end the match.
- Dispose per-match buffers/listeners, reset readiness/loading, restore lobby
  slots and settings, and rebuild launch descriptors for the next round.
- Returning a defeated/forfeiting player to the room while others still play is
  not global match completion. Such a member must not remain in order barriers.
  Keep an embedded host's server running even if its commander loses or forfeits.
- Deliberately leaving the server / quitting the host app still tears down hosting.
- First acceptance milestone: same host and guest play two consecutive rounds
  without reconnecting or recreating the room. Include host loss/forfeit cases.

### 2. Observer roles before match start

- Model room membership separately from a match's immutable combatant roster.
  Add observer role selection with server validation and no combatant slot use.
- Observers load the same map/mod/rules and original match metadata/seed, with
  observer UI/full-map visibility (recommended default), no owned army or orders.
- Exclude observers and waiting members from order latency minima, ready/start
  gates, loading barriers, sync consensus and deterministic player-drop events.
- Observer disconnects are room events, never commander drops.
- Implement the chat routing matrix above with adversarial server tests first.

### 3. Late observation and waiting-room entry

- Authenticate and validate compatibility before exposing room content. Permit
  connected waiting members while the active match continues.
- Offer Observe Game / Wait in Lobby from authoritative room state. Handle races:
  game starts during connection, ends during content download, or a second game
  starts before catch-up finishes.
- Recommended first approach: retain a bounded authoritative archive of original
  start metadata plus stamped orders and deterministic drop events. Replay it
  locally with rendering/sound suppressed or throttled until near live, then
  switch seamlessly to the continuing stream. Reuse existing replay machinery
  only if it preserves the original roster, seed, timing, AI and drop semantics.
- Confirm catch-up performance on real long matches before finalizing this
  approach. Checkpoints may be needed later, but do not assume an existing save
  snapshot captures every deterministic subsystem or permits safe live hydration.
- Stream history in acknowledged bounded chunks. Keep an atomic catch-up cutoff
  and follow-on stream so frames are neither missed nor duplicated. Apply memory,
  transfer and archive limits with an understandable unavailable/retry state.
  An archive limit must never affect the running players.
- Compare catch-up state with retained authoritative sync hashes where possible;
  an observer mismatch disconnects/retries that observer, never ends the match.
- Show catching-up progress and a cancel/return-to-room action. Avoid replaying
  thousands of historical sounds or showing hidden chat to active players.

### 4. Repeated-round and failure-path polish

- Waiters, observers and commanders converge on the same room after completion.
- Preserve settings, reset all Ready flags, and restore valid role/slot choices.
- Cover map/mod changes between rounds, content cancellation, host shutdown,
  guest drops, observer failures, duplicate names, full rooms and version mismatch.
- Keep a clear distinction between Return to Lobby and Leave Server.

## Validation and acceptance

Server/client tests:

- Observer joins waiting/running/full rooms without occupying a commander seat.
- Observer cannot inject commands, alter sync consensus, force completion or block
  load/start/order progress. A lagging/disconnected waiter has the same isolation.
- Chat recipient matrix verified at wire level, including forged audience values;
  team IDs/colors remain meaningful after a sender leaves or lobby settings change.
- Chunked history covers ordering, gaps, duplicates, bounds, cancellation,
  disconnects, mismatch and the catch-up/live boundary.
- Per-match reset rejects stale packets and clears listeners/state across rounds.
- Existing solo, bot, readiness, content and disconnect tests still pass.

Browser/native acceptance:

- Two active players + observer present at start; all active-player hashes match.
- A late observer catches up to the same hash and watches without stalling players.
- Another connection waits in the lobby while the game runs.
- Observer sees both teams' labeled chat; players receive no observer chat or
  opponent-team chat. Enter/history/audience behavior remains correct.
- Normal finish, host defeat/forfeit and guest disconnect do not accidentally
  destroy the persistent room. Start a second match in the same room.
- Check real macOS/Linux interoperability when both machines are available; local
  browser/native tests are not a substitute for claiming that physical test ran.

## Local tools, assets and commands

Workspace: `/Users/johnoverton/RedAlert2-Mac-iOS-iPad` (macOS, zsh).
Bun: `~/.bun/bin/bun`. Chrome:
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.

Assets: `gameres-export/`, `campaign-export/`.
Original retail files: `/Users/johnoverton/Downloads/ra2game`; macOS privacy controls
may block that folder. Existing imports are sufficient for routine rebuilds.

```sh
# Unit checks
~/.bun/bin/bun test --cwd redalert2
# Run from redalert2/
~/.bun/bin/bun run typecheck:entry
RA2_HTTP=1 node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4001 --strictPort
# Run from repository root with the development server above running
RA2_DEV_URL=http://127.0.0.1:4001 PLAYWRIGHT_CHROMIUM_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' ~/.bun/bin/bun scripts/lockstep-engine-smoke.mjs
RA2_DEV_URL=http://127.0.0.1:4001 RA2_SOLO_SMOKE=1 PLAYWRIGHT_CHROMIUM_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' ~/.bun/bin/bun scripts/lockstep-engine-smoke.mjs
~/.bun/bin/bun scripts/observer-engine-smoke.mjs
RA2_OBSERVER_LONG_SMOKE=1 ~/.bun/bin/bun scripts/observer-engine-smoke.mjs
~/.bun/bin/bun scripts/observer-lobby-ui-smoke.mjs
# Add RA2_GAME_UI_SMOKE=1 to the two-client run for existing HUD chat checks.
# Do not combine that flag with the solo mode (HUD test expects two clients).
bash scripts/build-macos.sh
bash scripts/build-macos.sh --ra2 --no-web
codesign --verify --deep --strict 'build/macos/yr/Red Alert 2.app'
codesign --verify --deep --strict 'build/macos/ra2/Red Alert 2.app'
```

Use a fresh Vite process after source changes before engine instrumentation tests.
HMR can produce duplicate module instances and invalidate `instanceof`/prototype
instrumentation. Set `RA2_HTTP=1` for the HTTP URLs above. Do not stop an unrelated
user development server. Stop only test servers/processes created for this work.
Existing useful scripts: `scripts/macos-host-smoke.ts`,
`scripts/macos-host-bridge-smoke.sh --ui`, `scripts/lockstep-smoke.mjs`,
`scripts/superweapons-off-smoke.mjs`, `scripts/outpost-aa-smoke.mjs`.

Current app outputs:
- `build/macos/yr/Red Alert 2.app`
- `build/macos/ra2/Red Alert 2.app`

Build artifacts/logs belong under ignored `build/`, not in commits. Recent solo
logs are `build/macos/solo-{tests,engine-smoke,typecheck,build-yr,build-ra2}.log`.

**Build identity gotcha:** `redalert2/vite.config.ts` embeds the git revision plus
source hash; the engine includes that version in the mod hash. Building before
committing, then comparing with a friend's post-commit build, can trigger the
misleading rules/mod mismatch even with identical source hashes. After final
commits, both machines should pull/build the same revision and fully quit/relaunch
the right app. Applications/Dock copies may still point at older binaries.

## Additional completed side quest after this plan was committed

The baseline includes the connection-stall/AI-takeover patch. Preserve it; inspect `git status` and
`docs/MULTIPLAYER_PROGRESS.md` before starting observer work. It adds:

- `NetworkStallOverlay.tsx` and `networkStall.css`: centered, wall-clock stall UI;
  host-only lagging-player details and kick-to-AI, generic messaging for guests.
- `GameOpts.disconnectAi`: pre-game option for AI takeover versus asset destruction
  on guest departure. Explicit host kick overrides the option. Direct Quit no
  longer enqueues the legacy resign action before disconnecting.
- Server `matchHealth` / `kick_ai` and optional `disconnect.takeover = 'ai'`.
  Replacement executes at the authoritative disconnect frame, not upon receipt.
- `ActionType.AiTakeover = 14`, `DestroyDisconnectedPlayer = 15`, action factories
  and replay recording. `BotManager.takeOverPlayer()` adds a Normal AI without
  rebuilding existing bots or reallocating the original commander's assets.
- Server-only action validation; player input cannot trigger these control actions.
- 142 passing unit tests; real three-client tests for natural recovery, host kick,
  Quit-to-AI and Quit-to-destruction with 450 matching ticks on survivors. Typecheck
  still has 42 baseline errors. Native helper hosting smoke and Mac builds passed.

Observer catch-up MUST include these deterministic takeover/destruction actions,
not only ordinary player commands. A waiting/observing connection must never
appear as a lagging commander, be turned into AI, or trigger army destruction.
Return to Lobby now retains the host connection/process; explicit Leave Server
still stops embedded hosting.
This patch does not provide reconnect/resume or replace the observer roadmap.
