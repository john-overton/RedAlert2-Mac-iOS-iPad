# Future additions

These are planned product directions, not implemented features or committed
release dates. Continue the remaining campaign work first. Keep maintenance and
polish follow-ups in [technical debt](TECH_DEBT.md); the campaign selector UI pass
is tracked there. The multiplayer lobby system (server browser, master
server, direct IP, password rooms) has its own design document:
[multiplayer plan](MULTIPLAYER_PLAN.md).

## In-game world editor

**Status:** Proposed. Add an editor inside the game for creating and modifying
maps/scenarios, with a direct path to playtesting them.

Initial scope:

- Create a map or open a local editable copy; choose dimensions and theater.
- Paint terrain, elevation, water, roads and resources, with placement previews
  and checks for supported geometry.
- Place, move and remove units, buildings and scenery; edit ownership, facing,
  health and starting locations.
- Provide selection, undo/redo, zoom/pan, unsaved-change prompts and draft saving.
- Export an engine-compatible map, reopen it, and launch a test game without
  overwriting the source draft or original retail map.

Later scenario-authoring scope:

- Houses, alliances, waypoints, cell/object tags, teams, reinforcements, triggers
  and objectives, with reference validation and clear unsupported-feature errors.
- A campaign integration workflow for mission metadata, briefings and progression.

Before implementation, inspect existing map parsing/serialization and test tools;
verify what can round-trip without losing data. Preserve unknown sections where
possible and disclose lossy operations. Start with a small skirmish-map workflow
before exposing the complete campaign scripting model.

Acceptance: create → edit → export → reopen → playtest preserves the map's supported
terrain, objects and ownership. Invalid references are caught before launch, undo
restores edits, and testing never changes the original map. Check mouse/trackpad
and touch controls in the native shells.

## In-game unit editor

**Status:** Proposed. Add a structured editor for unit definitions and balance,
using the workflows described in [Modding](MODDING.md).

Initial scope:

- Browse infantry, vehicles, aircraft and buildings; show the effective definition
  and where overridden values come from.
- Clone an existing type with a unique ID and valid type-list registration.
- Adjust health, cost, movement, sight, armor, prerequisites and house availability.
- Edit weapon references and relevant stats; identify shared weapons and offer
  cloning so a single-unit change does not silently rebalance other units.
- Reuse available art/cameos, preview the result, and validate missing assets.
- Disable production separately from deleting a type; show affected scenario and
  AI references before a removal.
- Support undo/redo, reset-to-base, draft saving and export of a named local mod
  or map override, followed by a test match.

Later scope: custom art import, richer animation/weapon previews, and explicit
campaign-specific variants. Do not expose unsupported INI keys as working toggles.

Acceptance: exported overrides reload with the same values; a cloned unit can be
built, commanded and rendered; disabling production preserves placed units; invalid
IDs/assets/references are reported. New saves and replays reconstruct correctly
with the same mod enabled.

## Shared editor foundations and decisions

- Decide mod storage, activation, versioning and import/export before promising a
  complete Mods menu. Existing importer code is not a finished native workflow.
- Share schema/validation with runtime parsers so editor options reflect actual
  engine support; preserve stable IDs and existing type ordering.
- Edit drafts outside the running simulation. Apply changes through an explicit
  reload/playtest boundary; do not mutate rules during multiplayer or replay.
- Track map/resource identity for saves, replays and multiplayer compatibility.
- Keep original retail assets intact. Export user-authored definitions and map
  data separately from dependencies on locally installed retail artwork/audio.
- Use the existing Settings-style UI where appropriate, with accessible focus,
  scrolling and controls that work on Mac and touch devices.

The world and unit editors should eventually share asset browsing, validation,
drafts and playtesting, but each should have a usable, independently testable
first version. Revisit scope and implementation order after campaign completion.
