# Allied mission one: implementation checkpoint

Branch: `feat/allied-mission-one`, based on `feat/apple-silicon-macos`.
Target: the original RA2 Allied mission `all01t.map` from `MAPS01.MIX`.
This work targets the classic RA2 engine mode, not Yuri's Revenge mission one.

## Current functionality

The first checkpoint adds a retail mission importer and a campaign scenario
data model. The second adds explicit campaign initialization in `GameFactory`,
with custom house creation, country inheritance, directed alliances, preplaced
owned objects, house credits/tech levels, HomeCell camera placement, and free radar.
It does **not** add a playable campaign or a campaign menu button. Skirmish
creation continues through its existing path unless a campaign scenario is passed.

```sh
bun scripts/prepare-campaign.ts "/path/to/your/ra2/install"
cd redalert2
bun test src/test
```

The importer also accepts `RA2_RETAIL_DIR` when no path argument is provided.
It writes to ignored `campaign-export/ra2/allied-01/`:

- `all01t.map`: original extracted mission bytes.
- `manifest.json`: mission/engine identity, size, and SHA-256 integrity metadata.
- `audit.json`: unsupported instruction usage by trigger, scenario metadata,
  definition counts, script opcode inventory, and reference errors.

`CampaignScenario` reads the INI before the skirmish-oriented map loader can
discard unsupported instructions. It retains action parameters, extended event
parameters, custom houses/countries, team/task-force/script definitions, trigger
links, disabled state, and difficulty flags. Malformed instruction records fail
explicitly. The source INI is retained for subsequent terrain and object loading.

Synthetic tests cover unknown instruction preservation, references, player/home
validation, difficulty flags, malformed records, and definition ordering. No
retail mission data is included in test fixtures or committed to the repository.

The initialization path appends mission countries after the original country
list (the retail player remains country ID 13), expands inherited production
eligibility, and resolves initial object owners by house name. Campaign allies
remain directional; ordinary skirmish alliances remain symmetric. The campaign
path suppresses skirmish starting forces, lobby credit overrides, skirmish bots,
and automatic elimination. Starting the simulation currently raises an explicit
development error before triggers can run with missing instructions.

### Reproduce the real-mission initialization check

After normal asset setup and the mission import above, start the development
server in one terminal:

```sh
cd redalert2
RA2_HTTP=1 bun run dev --host 127.0.0.1
```

In another terminal, from the repository root:

```sh
node scripts/campaign-init-smoke.mjs
```

The check uses the installed Playwright Chromium browser. If it is missing,
install the browser matching the project's Playwright version, or point
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an existing compatible Chromium executable.
`RA2_DEV_URL` overrides the default `http://127.0.0.1:4000`. The check selects
classic RA2 through a browser-local configuration override, so it does not edit
the development server's configuration.

It loads the real engine and mission, calls `Game.init`, and checks all initial
owned object counts, house credits, directed alliances, Tanya's presence, free
radar, and the incomplete-runtime start gate. The local retail run loaded all
249 preplaced technos across eight houses. Its JSON result is saved in ignored
`campaign-export/ra2/allied-01/init-result.json`. This validates simulation
initialization, not rendering, mission execution, or an end-to-end playthrough.

## Retail mission audit

The local retail copy contains:

| Definition | Count |
|---|---:|
| Houses / custom countries | 8 / 8 |
| Triggers | 130 |
| Team types | 49 |
| Script types | 38 |
| Task forces | 29 |

The declared player is `Player House`, whose country is `Player`; its parent
country is `Americans`. The initial camera waypoint is 98. House identity must
remain distinct from country identity and from skirmish lobby slots. Reference
checks for house allies, country sections, team dependencies/owners, and linked
triggers found no missing references in this copy.

The following action types occur in the mission but are absent from the current
engine enum/factory. Descriptions were checked against the locally supplied
FinalAlert2 `FAData.ini` action definitions.

| Action IDs | Required behavior |
|---|---|
| 1, 2 | Explicit mission victory / defeat |
| 3, 74 | House production / AI-trigger activation |
| 4, 5 | Recruit a scripted team / dissolve a team without deleting its units |
| 7, 80 | Spawn reinforcement teams, including at an explicit waypoint |
| 46, 47, 48 | Lock/unlock player input and move the camera to a waypoint |
| 100 | Play an in-game movie |
| 104, 114, 115 | Flash team members, select a sidebar tab, flash a production cameo |

Missing event types are 4 (discovered by player) and 33 (selected by player).
Team scripts use opcodes 0, 1, 3, 5, 6, 8, 11, 19, 20, 37, 39, 46, 49, and 50.
An enum entry alone is not evidence of correct runtime behavior; the audit
deliberately does not infer playability from instruction coverage.

## Next implementation steps

1. **Scenario initialization (implemented and browser-checked):** create mission houses and alliances, resolve
   original numeric country references, apply country inheritance and house
   economics, spawn preplaced owned units/buildings, and use HomeCell for the
   camera. Suppress skirmish starting forces and automatic elimination rules.
2. **Scripted teams:** implement recruitment versus reinforcement, ownership,
   task-force composition, movement/attack/unload commands, script advancement,
   and the mission's transport and aircraft behavior.
3. **Triggers and outcomes:** implement the missing events/actions, honor
   difficulty and disabled flags, and validate objective dependencies and both
   victory and defeat. Audit existing supported executors too, especially
   house-reference handling; enum coverage is insufficient.
4. **Presentation and launch:** add campaign selection, difficulty, briefing,
   intro/in-game movie handling, scripted input/camera behavior, and a mission
   result screen with retry/return-to-menu. Add a build option only when the
   launch/runtime path can support the packaged mission.
5. **Persistence and validation:** carry campaign identity in saves/replays;
   verify restart/load and objective progression in the native Mac shell.

The initialization paths in `GameFactory.create` and
`Game.createInitialMapTechnos` now accept mission houses and their owned map
objects. Scripted teams, initial unit orders, and campaign trigger execution
remain the next runtime work.

## End-to-end acceptance

- Start Allied mission one from a classic RA2 Mac build using locally imported
  assets; display its briefing and spawn the intended forces/alliances.
- Execute the opening script and all objective transitions without discarded
  conditions/actions or replacement skirmish AI behavior.
- Complete the mission through normal player orders and reach its victory
  result; separately exercise its scripted defeat path.
- Retry, return to the menu, and save/reload without losing campaign identity
  or corrupting trigger/team progress.
- Verify required cinematics, scripted camera/input transitions, and desktop
  controls, and rerun existing skirmish tests.

Import/audit, data-model tests, house initialization, and the real-mission
initialization check are complete at this checkpoint. Scripted runtime, launch,
and end-to-end playability work above remains outstanding.
