# Allied mission one — experimental Mac build

Branch: `feat/allied-mission-one`, based on `feat/apple-silicon-macos`.
Target: original RA2 Allied mission `all01t.map` (Lone Guardian).

Mission one now launches from the classic RA2 main menu. The build includes
scenario houses and alliances, scripted teams, reinforcements, objectives,
base ownership changes, production, bridge repair, tutorial effects, movies,
and explicit victory/defeat handling. This is an experimental implementation
in the reconstructed engine, not execution of the original Windows game.

## Build and launch

```sh
scripts/build-macos.sh --ra2 --campaign --retail-dir "/path/to/ra2/install"
open "build/macos/ra2/Red Alert 2.app"
```

Choose **Campaign: Mission One**, read the briefing, and begin. The briefing
movie has a **Skip Intro** button. The opening in-game sequence temporarily
locks unit input; control returns after the mission's scripted introduction.
The Options button remains available.

`--campaign` is opt-in and currently requires `--ra2`. A build without the
switch does not bundle campaign files. The importer also runs separately:

```sh
bun scripts/prepare-campaign.ts "/path/to/ra2/install"
```

The importer accepts `RA2_RETAIL_DIR`. It extracts the original map from
`MAPS01.MIX` into ignored `campaign-export/ra2/allied-01/`, with a SHA-256
manifest and instruction audit. It reads the movie index from retail `art.ini`
and converts the intro and three referenced clips from `MOVIES01.MIX` and
`MOVIES02.MIX` to H.264/AAC using `ffmpeg`. Unavailable movie archives are
reported; the map can still run without those optional videos. Cached
conversions are reused when source hashes match.

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
  and returns to the main menu without browser JavaScript errors.

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
- Only medium difficulty is exposed. No mission-two progression, campaign saves,
  or campaign replays are supported. Campaign saving is disabled in the menu.
- The audit's `playable: false` field means that static enum coverage does not
  certify playability; use the runtime results and limitations above.

## Manual test checklist

Start a fresh mission in the packaged Apple Silicon app. Confirm intro skipping,
movie audio, opening camera placement, input unlock, trackpad secondary-click
orders, and left-click selection. Complete the Dreadnought objective and reach
Fort Bradley. Build the barracks and engineer, repair the bridge, move a mixed
force across it, then destroy the Soviet supply base. Verify the mission-complete
screen and return to the menu. Restart and lose Tanya; verify mission failure.
