# Allied mission one — experimental Mac build

Branch: `feat/allied-mission-one`, based on `feat/apple-silicon-macos`.
Target: original RA2 Allied mission `all01t.map` (Lone Guardian).

Agents adding missions should start with the [campaign implementation guide](CAMPAIGN_AGENT_GUIDE.md).

Mission one now launches from both the Yuri’s Revenge and classic RA2 main menus. The build includes
scenario houses and alliances, scripted teams, reinforcements, objectives,
base ownership changes, production, bridge repair, tutorial effects, movies,
and explicit victory/defeat handling. This is an experimental implementation
in the reconstructed engine, not execution of the original Windows game.

## Build and launch

```sh
scripts/build-macos.sh --ra2 --campaign --retail-dir "/path/to/ra2/install"
open "build/macos/ra2/Red Alert 2.app"
```

Choose **Campaign → Red Alert 2 — Allied**, read the briefing, and begin. Returning players can choose
**Mission One: Lone Guardian** in the mission selector. On victory,
choose **Next Mission** to play the bridging briefing and start Eagle Dawn. The briefing
movie has a **Skip Intro** button. The opening in-game sequence temporarily
locks unit input; control returns after the mission's scripted introduction.
The Options button remains available.

The GIs shown first belong to an allied house and cannot be commanded yet.
Wait for the camera to pan toward Tanya and for “Battlefield Control Online,”
then select Tanya and order her to destroy the four Dreadnoughts. With right-click
orders enabled, left-click selects her and a two-finger click moves or attacks.

Context cursors also work when macOS cannot lock the pointer: C4 for Tanya,
repair for engineers targeting damaged buildings or bridge huts, and garrison
or unload for eligible buildings. To unload a garrison with right-click orders
enabled, left-click the occupied building, then right-click it again. Campaign
civilian buildings become controllable while occupied and return to their
original civilian house when emptied.

**Options → Campaign game speed** offers six settings: Slowest, Slow, Normal,
Fast, Faster, and Fastest. Normal runs at 23 simulation ticks per second,
15% faster than the previous default of 20. The setting is saved for future
missions; changes during a mission apply when you choose Resume Mission.
Skirmish speed remains controlled by its lobby settings.

In-game movies sit immediately left of the build sidebar and follow window
resizing. Opening the game menu hides and pauses the movie until you resume.

Choose **Save Game** from the in-game menu, then **Load Game** from the main
menu to continue. Saves rebuild the mission from recorded commands, including
scripted teams, objectives, production, and tutorial selections. The saved
camera and selection return without replaying old movies or queued EVA lines.
Longer missions take more time to reconstruct. Keep the same game version and
campaign assets; loading rejects a changed campaign map.

**Replays** is available in the Mac main menu. Matches are recorded automatically;
saved games can also be watched as replays. Playback reconstructs the campaign
and its movies without accepting orders from the viewer.

`--campaign` requires imported campaign data in either variant. Normal Mac
builds include existing imports automatically; `--no-campaign` omits them. The importer also runs separately:

```sh
bun scripts/prepare-campaign.ts "/path/to/ra2/install"
```

The importer accepts `RA2_RETAIL_DIR` and prepares both supported Allied missions.
It extracts the original mission-one map from
`MAPS01.MIX` into ignored `campaign-export/ra2/allied-01/`, with a SHA-256
manifest and instruction audit. It reads the movie index from retail `art.ini`
and converts the intro and three referenced clips from `MOVIES01.MIX` and
`MOVIES02.MIX` to H.264/AAC using `ffmpeg`. Unavailable movie archives are
reported; the map can still run without those optional videos. Cached
conversions are reused when source hashes match.

Movie trigger indices are zero-based positions in the retail movie list,
not its numbered INI keys. Mission-one indices 67–69 resolve to `A01_p01e`,
`A01_p02e`, and `A01_p03e`; this corrects the misplaced Soviet briefing.

No retail maps, movies, icons, executables, or game archives are committed.
Generated app bundles contain local retail data and must not be distributed.

## Verified behavior

The local retail regression checks:

- All 249 preplaced objects, eight scenario houses, inherited country rules,
  original country IDs, directed alliances, credits, tech levels, and free radar.
- Opening team recruitment, input lock/unlock, and preserved Dreadnought targets.
- Tanya destroys the four Dreadnoughts using attack orders; objective one fires.
- Movement to Fort Bradley activates cell triggers and transfers the base.
- Normal production builds a barracks and engineer; the engineer repairs the
  bridge and enables Soviet AI production. The checked run produced 36 new
  Soviet infantry after activation.
- Controlled destruction of the remaining significant Soviet buildings fires
  the final objective and its delayed victory trigger. A separate fresh game
  verifies Tanya's death leads to defeat even while allies survive.
- The actual menu launches the rendered mission, plays the intro and in-game
  video, returns mouse input, displays victory, and reaches the score screen
  and offers Next Mission, plays the Eagle Dawn briefing, starts mission two,
  and returns to the main menu without browser JavaScript errors.
- Real mouse clicks select Tanya and move her with either left-click or
  right-click orders. The GIs in the initial view remain allied-controlled.
- Dreadnought models finish sinking after destruction. Save/load and replay
  regressions record Tanya's attacks, the Fort Bradley transfer, and a barracks
  under construction. Reconstructed state matches units, credits, production
  progress, selections, team scripts, local variables, and fired triggers.
  The Save Game, Load Game, and Replays menu paths are also exercised.
- Campaign voxel models are prepared during loading even without background
  workers. The UI regression checks that Dreadnought missile geometry is cached
  before the opening battle. A local 20-second browser profile reduced the worst
  measured renderer update from about 90 ms to 8 ms; this is a CPU measurement,
  not a native Mac frame-rate guarantee.

**The final assault is not verified as a complete combat play-through.** The
victory regression deliberately supplies final destruction events through the
engine; it does not force the victory trigger or call `game.end()`. An attempted
automated infantry assault did not clear the Soviet base. Manual testing of
movement through the repaired bridge, combat balance, and the final assault
remains necessary before calling this a finished retail-equivalent campaign.

Run the simulation and UI checks with a local Vite server:

```sh
cd redalert2
RA2_HTTP=1 bun run dev --host 127.0.0.1
```

In another terminal at the repository root:

```sh
bun test redalert2/src/test/CampaignScenario.test.ts \
  redalert2/src/test/CampaignSetup.test.ts redalert2/src/test/CampaignTriggers.test.ts
node scripts/campaign-init-smoke.mjs --runtime
node scripts/campaign-ui-smoke.mjs
node scripts/campaign-save-replay-smoke.mjs
node scripts/campaign-interaction-smoke.mjs
```

The smoke scripts use Playwright Chromium. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE`
if the installed browser is outside Playwright's default cache path. Reports
and screenshots are written under ignored `build/` and `campaign-export/`.

## Implementation and limits

`CampaignScenario` preserves every original action/event parameter and validates
references before game creation. `CampaignSetup` creates the scenario houses,
tracks outcomes and presentation requests, and rejects unsupported instruction
sets. `CampaignTeams` executes mission scripts independently of skirmish bots.

The runtime covers mission-one actions 1, 2, 3, 4, 5, 7, 46, 47, 48, 74, 80,
100, 104, 114 and 115; events 4 and 33; and script opcodes 0, 1, 3, 5, 6, 8,
11, 19, 20, 37, 39, 46, 49 and 50, alongside existing engine triggers.
Additional fixes preserve hexadecimal cell tags, numeric flash durations,
correct action/event constructor parameters, local variable identity, and
house-specific production/destruction tests.

Compatibility choices are explicit:

- Scripted campaign damage at a bridge waypoint cuts that bridge. Ordinary
  skirmish bridge hit points cannot reproduce the opening's retail bridge cuts.
- Reinforcement infantry marked for a paradrop enter using the parachute task;
  the full retail transport-flight choreography is not reproduced.
- Scripted camera moves currently jump to their waypoint rather than reproducing
  retail pan speeds. Local AI triggers use the normal production queues with a
  simplified scheduling policy; retail weighting and all team flags are not
  reproduced exactly.
- Only medium difficulty is exposed. Victory now offers progression into
  [mission two](CAMPAIGN_MISSION_TWO.md); later missions are not implemented.
- The audit's `playable: false` field means that static enum coverage does not
  certify playability; use the runtime results and limitations above.

## Manual test checklist

Start a fresh mission in the packaged Apple Silicon app. Confirm intro skipping,
movie audio, opening camera placement, input unlock, trackpad secondary-click
orders, and left-click selection. Complete the Dreadnought objective and reach
Fort Bradley. Build the barracks and engineer, repair the bridge, move a mixed
force across it, then destroy the Soviet supply base. Verify the mission-complete
screen and return to the menu. Restart and lose Tanya; verify mission failure.
