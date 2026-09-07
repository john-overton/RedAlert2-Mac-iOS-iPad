# Campaign mission implementation guide for agents

Use this guide when adding or debugging campaign missions. Read the current
[mission-one coverage and limitations](CAMPAIGN_MISSION_ONE.md) and
[Mac build instructions](MACOS.md) before changing code. This is a reconstructed
TypeScript engine in an ARM64 AppKit/WKWebView shell, not execution or emulation
of the retail Windows binaries. Implement the original scenario's behavior in
the engine; importing a map alone does not make a mission playable.

## Handoff baseline

As of September 6, 2026, development is on `feat/allied-mission-one`, based on
`feat/apple-silicon-macos`. The current implementation includes both Allied missions and their transition.
Check the actual branch,
working tree, and remotes before continuing; these names describe the handoff,
not a requirement to overwrite or switch an existing checkout.

Mission one (`all01t.map`, Lone Guardian) and mission two (`all02s.map`, Eagle
Dawn) launch with saves and replay playback. Mission-one victory offers **Next
Mission**, plays mission two's briefing, and starts fresh mission-two state.
Read [mission-two coverage and limitations](CAMPAIGN_MISSION_TWO.md). Mission
three and later progression are not implemented. Both missions have controlled
objective/victory regressions; neither final assault has been verified as a
complete normal combat play-through. The user has tested mission one interactively.

Local retail data is at `/Users/johnoverton/Downloads/ra2game` in this workspace;
use an explicit path or `RA2_RETAIL_DIR` elsewhere. Retail archives, maps,
movies, icons, and generated bundles stay untracked. Import into ignored
`campaign-export/`, use ignored `build/` for reports, and do not publish bundles
containing retail assets. Tests committed to the repo should use small synthetic
fixtures or read local retail data at runtime, not embed complete retail maps.

## Where the implementation lives

Paths below are relative to the repository root.

| Area | Entry points | Purpose |
| --- | --- | --- |
| Import and packaging | `scripts/prepare-campaign.ts`, `scripts/build-macos.sh`, `redalert2/vite.config.ts` | Extract/audit maps, hash assets, convert movies, serve and bundle campaign files |
| Progress and selection | `redalert2/src/data/campaign/CampaignProgress.ts`, `redalert2/src/gui/screen/mainMenu/campaign/CampaignScreen.ts`, `CampaignPicker.tsx` in the same directory | Local victory tracking, first-launch behavior, installed missions and future placeholders |
| Scenario data | `redalert2/src/data/campaign/CampaignScenario.ts`, `CampaignMovies.ts` in the same directory | Preserve original INI parameters and references; resolve retail movie indices |
| Simulation setup | `redalert2/src/game/GameFactory.ts`, `redalert2/src/game/campaign/CampaignSetup.ts` | Scenario houses, inherited rules, alliances, ownership, outcomes, presentation requests |
| Scripted teams | `redalert2/src/game/campaign/CampaignTeams.ts`, `CampaignCapabilities.ts` | Team recruitment/reinforcement and supported script opcodes |
| Trigger dispatch | `redalert2/src/game/trigger/TriggerExecutorFactory.ts`, `TriggerConditionFactory.ts` | Action/event construction and execution; follow through to individual implementations |
| Launch and loading | `redalert2/src/gui/screen/mainMenu/main/HomeScreen.ts`, `redalert2/src/gui/screen/game/MapFileLoader.ts`, `GameLoader.ts` | Menu, map resolution, campaign player, assets and geometry preparation |
| Presentation | `redalert2/src/gui/screen/game/CampaignPresentation.ts`, `playCampaignIntro.ts`, `GameScreen.ts` | Movies, objectives, input lock, ending screens and campaign UI lifecycle |
| Speed | `redalert2/src/game/campaign/CampaignSpeed.ts`, `redalert2/src/gui/screen/options/` | Saved campaign speed and options UI |
| Orders and cursors | `redalert2/src/gui/screen/game/worldInteraction/DefaultActionHandler.ts`, `redalert2/src/gui/Pointer.ts`, `PointerSprite.ts` | Selection/order filtering and visible contextual cursor |
| Garrison ownership | `redalert2/src/game/gameobject/task/GarrisonBuildingTask.ts`, `redalert2/src/game/gameobject/trait/GarrisonTrait.ts` | Claim civilian structures while occupied and restore original ownership on unload |
| Recording/playback | `redalert2/src/network/gamestate/ReplayRecorder.ts`, `ReplayTurnManager.ts`, plus `GameLoader.ts` and `GameScreen.ts` above | Command recording, deterministic reconstruction and saved presentation state |

## Adding a mission

1. **Inspect the original scenario first.** Identify the map in the user's retail
   archives rather than assuming its filename, disc, player house, or briefing.
   Audit `[Basic]`, houses/countries, alliances, preplaced objects, triggers,
   events/actions, tags/cell tags, waypoints, local variables, teams, task forces,
   scripts, AI triggers, and media references. Draw up the intended objective
   sequence, ownership changes, input locks, win conditions, and loss conditions.
2. **Compare required instructions with real runtime support.** Preserve all
   original parameters, including unknown instructions. Read the corresponding
   constructors and executors; an enum entry is not proof of support. The audit's
   `playable: false` deliberately does not certify playability. Do not silence
   unsupported instructions or add an opcode to the capability set without
   implementing its behavior and checking it.
3. **Implement reusable missing behavior.** Keep scenario logic in simulation
   code and presentation in the UI. Prefer a general trigger/task implementation
   over coordinate-, name-, or mission-specific shortcuts. Document necessary
   compatibility approximations and scope them to campaigns when appropriate.
   Preserve skirmish and multiplayer behavior.
4. **Wire mission identity through every entry point.** Use `CampaignMissions.ts` and `launchCampaign.ts` for the supported map order,
   menu launch, and mission-specific asset paths. Extend the catalog, importer,
   packaging checks, and progression together so one mission cannot load another's
   map or movies. The retail maps' `NextScenario` fields contain legacy placeholders. Carry enough identity through
   save/load and replay to resolve the correct assets. Retain map digest checking.
   The Vite `/campaign` middleware already serves the export root.
5. **Make the mission reachable.** Add the appropriate selection/briefing and
   ending behavior. Treat next-mission progression as explicit work; do not
   assume the current score screen already handles it. Keep optional campaign
   packaging (`--ra2 --campaign`) and builds without campaign data working.
6. **Validate the objective sequence and real input.** Add mission-specific
   regressions, run mission one's checks after shared changes, then test the
   packaged Mac app. Separate script/trigger checks, simulated orders, actual
   mouse interaction, and complete manual combat play-through in the report.

## Pitfalls learned from mission one

- **House identity matters.** Preserve original country IDs, inherited country
  rules, and directed alliances. Allied units need not belong to the human:
  mission one's opening GIs are not initially controllable. Check owner and input
  lock before changing order logic. Custom civilian houses can inherit `Neutral`
  or `Special` without `owner.isNeutral` being true; use campaign ancestry and
  restore the original civilian owner after unloading. Houses with `PlayerControl`
  remain separate owners but accept the human's orders through `CampaignControl`.
  Check simulation validation, mixed selection, target lines, and save restoration
  when adding control paths; changing Tanya's owner breaks mission two's loss test.
  Scenario house sections can share a base country name; merge base country rules
  before applying those sections. Keep the engine's extra neutral player passive.
- **Instruction parameters are not interchangeable.** Preserve hexadecimal cell
  tags, local-variable identity, numeric durations, and house-specific tests.
  Verify action/event parameter positions against the actual scenario and engine.
- **Movie indices are zero-based positions in the retail movie list**, not the
  numbered INI keys. Mission-one indices 67–69 map to `A01_p01e`, `A01_p02e`,
  and `A01_p03e`. Briefing videos may be in `Brief`, not `Intro`. Inspect both,
  along with transition/ending fields and carryover settings. Convert referenced clips and briefing to browser-compatible
  H.264/AAC, with hashes and reusable conversion caching.
- **Presentation must leave the game usable.** Keep in-game movies left of the
  sidebar, responsive to resize, and paused/hidden under the game menu. Native
  web video controls are hidden; the intro has a separate Skip Intro button.
  Preserve six campaign speeds and the default 23 simulation ticks/second.
- **Mac pointer lock is optional.** Context cursor sprites must display on the
  canvas without pointer lock and yield to the OS cursor over HTML controls.
  With right-click orders enabled, left-click selects; hover uses the same
  non-selection filter as right-click execution. Check C4, engineer repair,
  bridge repair, garrisoning, and unloading using actual clicks and cursor output.
- **Prewarm campaign geometry during loading, including without workers.**
  Include scripted reinforcement models. A browser CPU profile is useful evidence,
  but does not establish native Mac frame rate. Sinking animation must advance
  after destruction even when normal model dirty flags stop changing.
- **Saves and replays reconstruct commands, not a full serialized snapshot.**
  Keep trigger-relevant selection in recorded simulation state, including empty
  selections. Viewer UI must not change outcomes. Respect action/hash ordering
  and the ending tick; `game.currentTick` increments at the end of an update.
  Check the exact outcome tick, saved camera/selection, and suppression of old
  movies/EVA during load catch-up. Require compatible code/assets and the correct
  map digest; test a save before and after any new mission-specific transition.
- **Full engine tests may need the browser.** Importing the entire engine directly
  in Bun can expose circular-import initialization errors (for example `MoveTask`).
  Use the existing Playwright runtime harness rather than casually reordering
  engine imports. Use focused Bun tests for parser and isolated behavior.

Known approximations remain: scripted bridge damage cuts the bridge; paradrops
do not reproduce the full transport flight; camera moves jump rather than retail
pan speeds; AI scheduling and team flags are incomplete; only medium difficulty
is exposed. Do not describe these as exact retail behavior or silently rely on
them for a new mission without checking its needs. Campaign save/replay checks
do not establish full multiplayer replay compatibility.

## Validation workflow

From the repository root, import local assets and run focused tests:

```sh
bun scripts/prepare-campaign.ts "/path/to/ra2/install"
bun test redalert2/src/test/Campaign*.test.ts \
  redalert2/src/test/PointerVisibility.test.ts \
  redalert2/src/test/WorldInteraction.test.ts redalert2/src/test/performance
```

Start the dev server in a separate terminal:

```sh
cd redalert2
RA2_HTTP=1 bun run dev --host 127.0.0.1
```

Run browser regressions from the repository root. Set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an installed Chromium executable if needed.
The scripts import Playwright from `redalert2/node_modules`; install project
dependencies before running. They default to the local server on port 4000 and
select RA2 resources. Initial asset loading can take time.

```sh
node scripts/campaign-init-smoke.mjs --runtime
node scripts/campaign-ui-smoke.mjs
node scripts/campaign-save-replay-smoke.mjs
node scripts/campaign-interaction-smoke.mjs
node scripts/campaign-mission-two-smoke.mjs
node scripts/campaign-mission-two-save-replay-smoke.mjs
```

The init test checks scenario state and objective progression. The UI test
checks menus, movies, speed, mouse orders, endings, and return to menu. The save
test compares reconstructed state and exercises Save/Load/Replays. The interaction
test checks contextual order types and actual mouse garrison unloading. The UI
script includes the mission-one-to-two handoff. Mission two also has
`campaign-mission-two-smoke.mjs` and `campaign-mission-two-save-replay-smoke.mjs`;
run them for shared campaign changes. Add equivalent coverage for later missions.

Use `window.__ra2debug` in browser tests to inspect the game, game screen, world
interaction, and action machinery. Prefer normal queued orders for gameplay
checks. If a fixture spawns units or supplies destruction events, label that
explicitly. Capture JS errors, objective/ownership state, outcome ticks, and
screenshots in ignored output directories.

```sh
cd redalert2
bun run typecheck:entry
```

The current entry typecheck has existing failures. Compare diagnostics against
the baseline and fix new errors; do not report the typecheck as passing when it
fails. Build and verify from the repository root:

```sh
scripts/build-macos.sh --ra2 --campaign --retail-dir "/path/to/ra2/install"
codesign --verify --deep --strict "build/macos/ra2/Red Alert 2.app"
open "build/macos/ra2/Red Alert 2.app"
```

For manual acceptance, follow the original mission through every objective using
normal controls. Check both order modes, trackpad secondary click, special-action
cursors, unit ownership, build queues, transports/garrisons as applicable, media,
speed changes, save/load during a meaningful transition, replay ending, victory,
defeat, and returning to the menu. Only claim the paths actually exercised.

## Leave the next agent a concrete handoff

Update a mission-specific document alongside this guide when shared behavior
changes. Record the map/mission identity, branch and commit, required retail
archives, import/build commands, newly implemented instructions, objective
sequence, tests and their artifacts, manual coverage, approximations, failures,
and the next unverified step. Keep generated assets out of the commit and check
`git diff --check`. Distinguish committed, pushed, built, and manually verified
status so the next agent does not repeat work or mistake a smoke test for a
complete play-through.

## Mission-two regressions to preserve

- Directed alliances must be checked from the actor toward its target. In Eagle
  Dawn, reverse checks cause friendly engineer deaths and block rocketeer attacks
  on Confederate sentries. Keep house ownership unchanged for scripted objectives.
- Test the chapel with both scripted French capture and an American player's
  engineer order. Campaign entry events must disable the ownership-loss trigger
  before that tick's polled building-not-exists test. Test actual destruction too.
- Completion is frontend profile state, never deterministic simulation state.
  Record victories only from live GameScreen outcomes, not reconstruction or
  ReplayScreen. Keep restart non-destructive and future missions disabled until
  they have runtime support and installed assets. Extend the catalog and selector
  together when implementing the next mission.

The campaign UI uses the same HtmlView, options fieldsets, scroll container and
right sidebar as Settings. Home opens a campaign list; selecting RA2 Allied starts
mission one for a new profile or opens the mission picker for a returning profile.
RA2 Soviet and both Yuri’s Revenge campaigns are disabled placeholders. Back from
missions returns to campaigns; Back from campaigns returns Home. Keep restart in
the sidebar so it remains accessible while scrolling. Run
`scripts/campaign-picker-smoke.mjs` to check matching settings bounds, placeholder
states, scrolling and both Back transitions.

A further visual polish pass is deferred until the remaining campaign work is
finished. See [campaign selector UI technical debt](TECH_DEBT.md#campaign-selector-ui-polish)
for scope, preserved behavior, and acceptance checks.
