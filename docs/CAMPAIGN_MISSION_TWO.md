# Allied mission two — Eagle Dawn

Branch: `feat/allied-mission-one`. Original retail map: `all02s.map` from
`MAPS01.MIX`. Read [the campaign agent guide](CAMPAIGN_AGENT_GUIDE.md) before
extending this implementation.

## Launch and transition

Build both missions with:

```sh
scripts/build-macos.sh --ra2 --campaign --retail-dir "/path/to/ra2/install"
open "build/macos/ra2/Red Alert 2.app"
```

After mission-one victory, choose **Next Mission** on the score screen. Read
the briefing, then watch or skip the mission-two briefing movie. **Main Menu**
remains available on the score screen. Returning players can also choose **Campaign → Mission Two: Eagle Dawn**
from the main menu. A brand-new campaign begins at mission one. Failure or quitting does not advance the
campaign. Mission three is not implemented.

The transition plays retail `A02_f00e.bik`, converted to `allied-02/brief.mp4`.
The map puts this movie in `[Basic] Brief`, whereas mission one uses `Intro`.
Mission-two in-game clips are `A02_p01e` (index 70) and `A02_p02e` (index 82).
They use the same placement left of the sidebar and hidden browser controls as
mission one. Briefings have a separate **Skip Intro** button.

Both retail scenarios specify `CarryOverMoney=0`, `CarryOverCap=0`, and
`TimerInherit=no`. Mission two starts a fresh scenario with its own units,
veterancy, local variables, timer, and **10,000 credits** for the American player;
mission-one survivor units and money are not imported. Scores and recordings
remain separate games in the existing replay/save system. Campaign speed and
input preferences persist. No cumulative score system has been added.

`CampaignMissions.ts` defines the supported map order. The maps' `NextScenario`
values are legacy `GDI2A.map` placeholders, so they are not used for progression.
Mission identity in game options resolves the correct map and movies during
launch, save/load, and replay. Map digest validation remains enabled.

## Mission behavior

The original map supplies 14 scenario houses, 84 triggers, 44 team definitions,
36 scripts, and 28 task forces. Medium difficulty is exposed.

- Tanya belongs to **Germans**, and the opening rocketeers use **Alliance**.
  Both houses have `PlayerControl=yes`; the American player can command them
  without changing ownership. This preserves the original Tanya-death trigger.
  Mixed selection, recorded orders, target lines, cycling units, and restored
  selections recognize these controlled houses.
- Opening patrols, rocketeer reinforcements, discovery bonuses, text, radar
  markers, movies, crates, and music follow the scenario triggers.
- Destroying the first base's two Nod-owned flak cannons triggers the engineer
  paradrop and recovery sequence. Scripted engineers capture the construction
  yard and Air Force Academy chapel. Chapel recovery completes objective one,
  transfers the temporary French assets, and enables the final victory test.
  Remaining occupied base structures can be captured with player engineer orders.
- Capturing the chapel unlocks rocketeer production through the map's original
  prerequisite. Player production activates Soviet AI attacks. The Soviet house
  builds its prescribed refinery/factory nodes using production time and credits.
- Destroying the significant Confederate and Russian forces completes the final
  objective and delayed victory. Tanya's death fails the mission. Destroying the
  chapel before recovery also fails it; the retail recovery trigger disables that
  earlier loss condition after capture.

New shared runtime support includes actions 6 (hunt), 20 (music), and 38 (make
enemy); scripts 14 (transport loading), 16 (patrol), 43 (wait for loading), 45
(truck cargo model), and 47 (move to enemy building); engineer capture tasks in
attack scripts; counted unit/building destruction events; and AI conditions for
player-owned objects, producing-house objects, and unconditional triggers.

Team creation waits for recruitment when necessary. Recruitment prefers free
units, then completed teams, then recruitable active teams, with the team's
waypoint breaking proximity ties. This avoids recruiting the same engineer for
both recovery tasks before ownership-change scripts run. Generic attack/hunt
scripts continue selecting enemies after a kill.

Prescribed Soviet base nodes bypass the player's building-adjacency restriction;
they still require normal production eligibility, credits, construction time,
and a buildable, unoccupied foundation. Player building placement is unchanged.

## Campaign progress and mission-two interaction fixes

The scrollable campaign selector shows both installed missions and ten disabled
future-mission placeholders. Completion measures the full 12-mission Allied
campaign: one victory is 8%, both available victories are 17%. Live campaign
victories are counted once; defeat, quitting, starting a mission, loading a save,
and watching a replay do not award completion. **Start campaign from beginning**
replays mission one while retaining victories and saved games. Progress is local
to this app/browser profile (`ra2.alliedCampaign.progress.v1`); it is not synced.

Older campaign saves/replays allow the selector to recognize an existing campaign.
They did not record victory outcomes, so historical completion cannot be recovered
reliably. Loading an older save still follows the existing replay compatibility
checks. Newly recorded victories update completion immediately.

Weapon targeting now evaluates friendship from the attacking house toward the
target house. The original map's alliances are directed: Alliance rocketeers must
protect French engineers despite France's missing reciprocal alliance, and must
be able to attack Confederate sentries despite the Confederation's alliance to
them. C4, airstrike, and disguise targeting use the same source-first convention.
Ownership and original house identities remain intact.

Campaign entry-event triggers run before polled ownership conditions. This lets
the American chapel capture trigger remove the chapel-loss trigger in the same
tick, even though the loss trigger appears earlier in the map. Building-not-exists
still checks the trigger house's buildings; actual chapel destruction still fails
the mission. Skirmish trigger ordering is unchanged.

## Verified checks and limits

With a Vite server running, use:

```sh
node scripts/campaign-ui-smoke.mjs
node scripts/campaign-mission-two-smoke.mjs
node scripts/campaign-mission-two-save-replay-smoke.mjs
```

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` if your Chromium installation is outside
Playwright's default location. The scripts require locally imported retail data.
Reports and screenshots stay in ignored `build/`.

The mission-one UI regression now covers its victory score screen, **Next
Mission**, the actual mission-two briefing video, fresh mission-two state, and
real mouse selection/movement of Tanya in both left- and right-click order modes.
The transition starts Americans with 10,000 credits and retains Tanya in Germans.
The UI check also verifies first entry, completion after victory, disabled future
missions, persistent progress after reload, and restarting without erasing victory.

The mission-two runtime check validates initial living objects and alliances,
opening triggers, cross-house orders, engineer base captures, objective changes,
Soviet construction and AI activation, victory, and separate Tanya/chapel loss
cases. It also checks opening engineer survival, all six sentries as rocketeer
targets, a rocketeer damaging a Confederate sentry, and an American engineer
entering/capturing the chapel before the French scripted team. An isolated transport fixture loads all five passengers and unloads them
using the script interpreter and normal transport tasks.

**This is not a complete combat play-through.** The objective regression removes
the first base defenses and final enemy forces through controlled destruction
events, including surviving crew. It does not force the objective triggers or
call `game.end()`. A direct automated Tanya attack route encountered a patrol and
lost her; the intended swimming/escort approach, combat balance, and full final
assault need manual testing in the packaged Mac app.

Save/resume and replay reconstruction match at tick 1800, including cross-house
Tanya orders, selection, all houses' objects/credits/queues, active teams, pending
recruitment, local variables, and fired triggers. Actual Save Game, Load Game,
and Replays menus are exercised, including restoration of Tanya's selection.
This does not establish a long late-mission save, victory replay, or multiplayer
replay certification.

Inherited approximations remain: paradrops omit the transport flight, camera pans
jump, and AI team scheduling/weights are simplified. Building target preferences
use distance, with the farthest flag respected; exact retail threat weighting,
all AI/team flags, and every script mission mode are not reproduced. Script 45
changes the TRUCKA cargo model to TRUCKB; that unused mission-two script is not
part of the objective regression. No retail assets or generated app bundles
belong in Git or the PR.

## Build verification (September 6, 2026)

The ARM64 Mac app was rebuilt at `build/macos/ra2/Red Alert 2.app` and passed
`codesign --verify --deep --strict`. Both packaged map/movie manifests matched
their file sizes and SHA-256 hashes. The 54 focused unit/input/performance tests
passed, as did mission one's runtime, interaction, and save/replay regressions.
The entry typecheck retains its 42 pre-existing diagnostics; it is not a clean
TypeScript baseline. Packaged-app manual combat acceptance remains pending.
