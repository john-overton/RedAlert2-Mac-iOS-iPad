# Mass-unit order and movement optimization

Status: proposed; code inspected 2026-09-08. No performance capture or optimization
has been performed for this report yet.

## Problem and working hypothesis

Reported symptom: issuing an order to roughly 30 or more units sometimes causes
slowdown. Determine whether this is a single command hitch, sustained movement
cost, rendering pressure, allocation/GC, or waiting for a slower multiplayer peer.
Measure the order type and terrain conditions rather than treating 30 as a fixed
engine threshold.

TypeScript compiles to JavaScript; its type system is not a per-unit runtime tax.
The runtime can still spend substantial time executing synchronous algorithms,
allocating objects and collecting garbage. There is no measured evidence here for
a language limit or a need to rewrite the engine in another language.

The leading code-based hypothesis is a burst of formation placement and individual
path searches, potentially followed by repeated searches as units block each other.
This is a hypothesis, not an established cause. A separate server process will not
offload these calculations: clients simulate the game in the current lockstep model.
See [server split and recovery](MULTIPLAYER_SERVER_SPLIT_PLAN.md).

## Relevant code and concrete findings

Paths below are relative to `redalert2/src/` unless otherwise stated.

| Area | Observation | Measurement needed |
| --- | --- | --- |
| `game/action/OrderUnitsAction.ts` | Validates selected units, groups move orders by bridge, assigns formation destinations, then dispatches individual orders. The 128-unit cap is applied after validation. | Time in validation, fallback order creation, formation placement and task dispatch; selected versus accepted counts. |
| `game/gameobject/unit/MovePositionHelper.ts` | Clusters adjacent units, assigns offsets, then searches nearby tiles for leftovers. Uses array shifts, spreads and temporary maps/sets; unplaced units ultimately share the clicked tile. | Clustering/placement cost, allocation volume, destination contention, terrain sensitivity. |
| `game/gameobject/task/move/MoveTask.ts` | Computes a path on task startup and again when a path update is needed; performs blocker and reservation logic. | Searches per tick/unit, initial versus repeat searches, reasons for replan and blocked duration. |
| `game/map/Terrain.ts` | Builds/obtains passability graphs, handles islands and temporary graph changes, creates a new `PathFinder` for each query. Some searches have no expansion limit. | Graph/island work versus search time, nodes expanded, reachable versus unreachable destinations. |
| `game/map/pathFinder/PathFinder.ts` | Synchronous heap-based search, per-search state map, and a search-state pool owned by each finder. Default expansion limit is infinity. | Search latency distribution, heap operations, pool reuse effectiveness, allocations. |
| `network/client/NetworkTurnManager.ts` | Processes resolved actions, waits for missing turns and computes sync hashes. | Action execution versus hashing versus time waiting for peers; correlate across clients. |
| `performance/PerformanceRuntime.ts`, `tools/PerformanceTester.ts`, `tools/UnitMovementTester.ts` | Existing performance/testing entry points to inspect and extend. | Reuse available instrumentation instead of adding a second overlapping reporting system. |

One specific code defect candidate deserves early investigation: `Terrain.computePath()`
evaluates `Math.min(maxExpandedNodes, 500)` in an unreachable-endpoint fallback but
does not assign or use its result. That statement does not bound the subsequent
search. Reproduce this branch and measure it first; simply enforcing the apparent
intended cap could change best-effort routes and therefore gameplay. It is not yet
proven to explain the reported slowdown.

## Phase 1: reproducible baseline and attribution

Build a deterministic scenario runner around the real game engine, fixed map/seed,
unit roster, destination and command ticks. Capture commit, build mode, variant,
browser/native runtime, machine, game speed, rendering settings and viewport.
Use a production build for performance conclusions; retain development builds for
instrumentation diagnosis. Warm up, then run at least five repetitions per case;
keep cold-run results separately.

### Scenario matrix

- Counts: 1, 10, 30, 60 and 128 selected units. Add a larger-selection boundary
  case to expose pre-cap validation cost and document existing selection semantics.
- Units: infantry, ground vehicles, mixed speeds/sizes, aircraft and naval units.
- Commands: move, attack-move, attack target, stop, queued waypoints and repeated
  destination changes. Include idle selected units as a rendering/control baseline.
- Terrain: open ground, narrow chokepoint, crowded base, bridge approaches,
  unreachable/enclosed destination and long-distance movement across the map.
- Match context: early game and crowded late game; AI disabled/enabled; units
  on-screen/off-screen; single-player and two commanders plus an observer.
- Device coverage: native macOS/WebKit and Windows/Electron first, then Linux and
  iPad/iOS when available. A headless Chromium result does not establish WebKit performance.

Measure the tick receiving the order and the following 10–30 seconds. Separate
input-to-authoritative-application latency from application-to-visible-movement
latency; network turn scheduling is not the same as expensive order execution.

### Metrics and traces

- Frame and simulation tick duration: median, p95, p99, maximum and counts above
  16.7/33.3/50 ms. Record game-speed tick budget and actual simulation progress.
- Phase timings: order validation, formation placement, task updates, terrain/graph
  preparation, path search, targeting/AI, hashing and rendering.
- Work counters: searches and expanded nodes per tick, replans per unit and reason,
  blocker tests, graph/island rebuilds, formation candidates and queued tasks.
- Allocation/GC and memory plateau during repeated orders; CPU profiles on the
  slow cases; render/GPU evidence if simulation timings do not explain frame loss.
- Network: pending/late turns, packet sizes, RTT, send queues and server tick timing.
  Align client traces by simulation tick to identify the slow peer.

Keep diagnostic buffers bounded and instrumentation opt-in. Avoid per-node console
logging. Timing reads must never control simulation results; profiling on/off must
produce identical hashes. Compare instrumentation overhead against an uninstrumented run.

Deliverable: reproducible runner, baseline JSON/CSV and a short report identifying
which phases account for each spike. Choose fixes from that evidence.

## Phase 2: targeted changes, ordered by measured value

1. **Remove redundant work without changing results.** Candidates include queue
   head indices instead of shifts, avoiding repeated temporary arrays, and reusing
   search storage across queries. Preserve traversal order, path tie-breaking and
   callback behavior; do not stop validation early without checking its side effects.
   Reuse must be safe against nested searches and temporary graph mutation.
2. **Investigate pathological searches.** Reproduce the ineffective fallback cap,
   graph rebuild frequency and unreachable-target behavior. Prefer valid early
   reachability rejection or redundant-work removal. Treat any expansion cap or
   fallback-route change as a simulation behavior change requiring explicit tests.
3. **Reduce repeated replanning if it dominates.** Consider deterministic retry
   intervals, blocker-aware invalidation and bounded caches. Cache keys must include
   movement class, ground/bridge layer, relevant topology/occupancy version and
   query-specific exclusions; never reuse a path through a newly placed building.
4. **Explore shared group routes only if independent searches dominate.** Prototype
   a shared coarse corridor or destination search for compatible movement groups,
   retaining per-unit placement and local collision handling. Bridge layers, mixed
   movement rules and differing destinations make one universal shared path unsafe.
5. **Address other measured costs directly.** Selection markers, target/path lines,
   audio feedback, AI targeting and state hashing may dominate some cases. Do not
   commit to a pathfinding redesign if profiles point elsewhere.

No blanket 30-unit cap, reduced simulation accuracy or slower game speed as a fix.
Do not start with workers, WASM, flow fields or a language rewrite. These remain
possible later experiments with separate evidence and implementation scope.

## Determinism and scheduling constraints

Every commander and catching-up observer must apply the same simulation decisions.
Optimizations that merely change storage should retain baseline hashes. Changes to
route selection, retry timing or task scheduling need intentionally updated behavior
expectations and client/build compatibility gating; all new clients must agree.

If synchronous work cannot meet the budget, investigate incremental search with a
fixed deterministic node/work budget per simulation tick and stable request ordering.
Do not stop simulation work based on `performance.now()`, device speed, frame rate
or worker completion order. Delayed path results change movement timing and can
shift the bottleneck to lockstep waiting; benchmark responsiveness as well as CPU.

Terrain queries temporarily mutate shared graphs and rely on cleanup in `finally`.
Do not yield mid-query or concurrently search those structures without redesigning
that ownership. A worker prototype needs a defined immutable/versioned world view,
result consumption boundary and stale-result policy before multiplayer use.

## Validation and acceptance

- Before choosing a fix, establish whether the original 30+ unit symptom reproduces
  and publish the measured dominant cost. If it does not reproduce, preserve traces
  and request the map, unit mix/order and hardware needed to narrow the scenario.
- Initial performance target, subject to baseline feasibility: at least 30% reduction
  in p95 order-processing time for the confirmed slow scenario, with no more than
  5% p95 regression in unaffected cases beyond measured noise. Separately report
  worst-tick and sustained frame performance so shifting work cannot count as a win.
- Aim for affected simulation ticks to fit the configured tick budget and interactive
  frames to fit the device's selected frame target; report exceptions explicitly.
- Verify units reach valid destinations, retain formation/queue behavior, use the
  correct bridge layer and recover from congestion; no movement through structures,
  stuck harvesters, broken factory exits or starvation of later path requests.
- Add focused regression tests for each actual defect, then real-engine scenarios
  with repeated group orders, building placement/destruction and bridge changes.
- Compare same-build commander and late-observer hashes through at least 10,000
  ticks. Run profiling on/off and repeat on available native runtimes. For purely
  structural optimizations also compare against baseline deterministic traces.
- Check memory after repeated commands and multiple matches. Existing pathfinding,
  movement, multiplayer and recovery tests must continue to pass.

## Implementation sequence and artifacts

First change: profiling counters plus deterministic scenario runner and baseline
report. Next changes: one measured bottleneck per reviewable patch, each including
before/after results, movement correctness and determinism evidence. Store small
reproduction configurations and reports in the repo; keep large profiles in ignored
build artifacts. Update this plan with confirmed causes and completed milestones.
