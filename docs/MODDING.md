# Modding units and rules

This guide covers this repository's TypeScript engine and local development
builds. It does not patch or run the Windows executable. Retail INI syntax is a
starting point: a setting works only if this engine parses and implements it.

The native app does **not** yet have a working end-user mod installation workflow,
unit editor, or world editor. Mod manager/importer code exists, but the native
menu does not expose a completed mod browser. See [future additions](FUTURE_ADDITIONS.md)
for the planned editors. Do not assume dropping a loose `rules.ini` beside the Mac
app changes its loaded rules.

## Where definitions come from

| Data | Purpose |
| --- | --- |
| Retail `rules.ini` / YR `rulesmd.ini` | Unit/building definitions, weapons, warheads, production and balance |
| Retail `art.ini` / YR `artmd.ini` | Images, sequences, animations, cameos and rendering definitions |
| `rulescd.ini`, `artcd.ini` | Project overrides loaded from the virtual filesystem; the bundled `redalert2/public/res/ra2cd.mix` supplies project resources |
| Game-mode and option mixins | Additional rule overrides selected when starting a game |
| Map INI sections | Scenario-local overrides and placed objects, houses, teams and triggers |

`Engine.loadRules()` merges the project overrides into the selected retail rules
and art. `GameFactory.create()` then merges game-mode rules, option mixins and map
sections, in that order. Campaign setup also resolves the scenario's countries
and house inheritance. A later map override can therefore replace a global stat.

Use small map-local overrides for early experiments. A global mod needs a
separately verified resource-loading/packaging path; editing the binary MIX bundle
by hand is not a supported shortcut. Keep original retail files intact and keep
retail data, exported maps and generated app bundles out of Git. Commit original
patches, tooling and documentation instead.

## Adjusting existing units

Use the internal object ID, not its displayed name. For example, the Allied GI
is `E1`. Merge this illustrative balance change into the map's existing `[E1]`
section, or add that section if absent:

```ini
[E1]
Strength=150
Cost=250
Speed=5
Sight=6
```

These are example values, not a recommended balance patch. Start a new game to
load the changes. Avoid duplicate sections/keys; inspect the effective merged
rules if a value appears to have no effect.

| Setting | What to check |
| --- | --- |
| `Strength` | Maximum hit points; existing map health percentages still apply |
| `Cost` | Purchase price; production timing also depends on engine production rules |
| `Speed` | Movement rate in engine-converted INI units, not screen pixels |
| `Sight` | Reveal range; the parser applies limits and special-case behavior |
| `Armor` | Warhead damage multipliers against this unit |
| `Primary`, `Secondary` | Weapon section IDs; deployed and alternate modes may use a different weapon |
| `ElitePrimary`, `EliteSecondary` | Weapons after promotion |
| `TechLevel` | Availability relative to the scenario/player's maximum tech level |
| `Prerequisite` | Required production structures/requirements |
| `Owner`, `RequiredHouses`, `ForbiddenHouses` | Production eligibility, not the current owner of a placed unit |
| `Image`, `UIName` | Art identity and localized display-name key |

Weapon values such as `Damage`, `ROF` and `Range` belong in the referenced weapon
section. Lower `ROF` means a shorter firing interval; it is not shots per second.
Changing a shared weapon affects every unit using it. For a unit-specific change,
copy the complete effective weapon definition to a new ID, adjust it, and point
that unit's weapon field at the new ID. Check its projectile and warhead too:
anti-air/ground targeting, armor multipliers and special effects are separate.

## Adding a unit

1. Choose the category: `[InfantryTypes]`, `[VehicleTypes]`, `[AircraftTypes]` or
   `[BuildingTypes]`. Assign a unique object ID such as `MODGI`.
2. Append that ID under an unused numeric key in the appropriate type list.
   Preserve existing entries and their order. The engine constructs sequential
   type indices from the merged list; a numeric INI key is not a guaranteed
   runtime index. Reordering/removing entries can break numeric scenario references.
3. Copy the **complete effective definition** of a similar working unit into the
   new section. A new `[MODGI]` does not inherit `[E1]` automatically. Retain required
   movement, category, weapon and behavior fields before changing individual stats.
4. Initially reuse known working art. A GI clone can retain `Image=GI` from the
   retail GI definition. New artwork needs matching art definitions and locally
   loaded assets: infantry sequences/SHPs, vehicle voxel/HVA or supported sprite
   rendering, cameos, palettes, and any referenced animations or sounds.
5. Set cost, tech level, house eligibility and prerequisites. Reuse an existing
   `UIName` temporarily or supply a corresponding localized string for a new name.
6. Test actual production and spawning. A registered definition does not place a
   unit on a map, add it to an AI team, or make it part of campaign reinforcements.
   Update those references separately if desired.

Adding a new weapon or special ability may require TypeScript implementation in
addition to INI changes. Unknown keys are not proof of supported behavior.

## Removing or disabling a unit

To hide an existing type from normal production while keeping scenario references
valid, override its tech level:

```ini
[E1]
TechLevel=-1
```

This does not delete placed GIs, remove passengers, or prevent scripts from
creating them. Production checks explicitly reject tech level `-1`; scripted
spawning is a different path.

For a complete removal, audit map object sections, passengers, task forces,
reinforcements, AI production, prerequisites, weapon/animation references and
triggers before removing the definition or type-list entry. Campaign objectives
can require a specific house, type or object. Prefer disabling production and
retaining definitions when maintaining compatibility with existing missions.

## Trying a local campaign-map change

After importing your retail campaign assets as described in the
[Mac build guide](MACOS.md), work on a backed-up copy of the map under
`campaign-export/ra2/allied-01/` or `allied-02/`. These exports are ignored by Git.
Edit its INI overrides, then refresh that mission's manifest entry. For mission two,
run from the repository root:

```sh
python3 - <<'PY'
from pathlib import Path
import hashlib, json
folder = Path('campaign-export/ra2/allied-02')
manifest_path = folder / 'manifest.json'
manifest = json.loads(manifest_path.read_text())
entry = next(f for f in manifest['files'] if f['path'] == 'all02s.map')
data = (folder / entry['path']).read_bytes()
entry['size'] = len(data)
entry['sha256'] = hashlib.sha256(data).hexdigest()
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
PY

env -u RA2_RETAIL_DIR scripts/build-macos.sh --ra2 --campaign
```

This assumes retail resources and both campaign exports are already prepared.
Omit `--retail-dir` and unset `RA2_RETAIL_DIR` for this build: the campaign importer
re-extracts the original maps and would overwrite the experiment. The previous
`audit.json` describes the original import; rerun scenario validation for changes
to teams, triggers or object references. The example above updates integrity
metadata only, not the scenario audit.

Quit and reopen the rebuilt app, then start a fresh mission. Keep the patch
separately so you can reapply it after future retail imports. Campaign saves verify
map digests, and replays depend on matching rules/resources; old recordings are
not a reliable test of a changed mod. Multiplayer peers need matching resources.

## Validation and implementation references

Check that the unit renders correctly, appears in the intended production menu,
costs the expected amount, moves, attacks ground/air targets as intended, promotes,
and dies correctly. For removals, check both production and scripted spawns.
For campaign edits, exercise objectives and defeat conditions as well as combat.
Create a new save/replay under the modified rules and verify reconstruction.

| Area | Source |
| --- | --- |
| Rule layering and resource identity | `redalert2/src/engine/Engine.ts`, `redalert2/src/game/GameFactory.ts` |
| INI merging | `redalert2/src/data/IniFile.ts`, `IniSection.ts` in the same directory |
| Type registration and fields | `redalert2/src/game/rules/Rules.ts`, `TechnoRules.ts`, `ObjectRules.ts`, `WeaponRules.ts`, `WarheadRules.ts` in the same directory |
| Production eligibility | `redalert2/src/game/player/production/Production.ts` |
| Art loading | `redalert2/src/game/art/` |
| Campaign references and validation | [Campaign agent guide](CAMPAIGN_AGENT_GUIDE.md) |

Consult the parser and the behavior consuming a field before relying on a retail
modding recipe. This guide documents the current code paths; the illustrative
unit changes above are not a separately certified mod package.
