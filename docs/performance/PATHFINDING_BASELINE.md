# Pathfinding component diagnostic — 2026-09-08

The ineffective fallback limit is reproduced. A fixture exercising real
`Terrain.computePath` and `PathFinder` with a forced start, 600 connected tiles and
an isolated missing destination expands 601 nodes. Passing an explicit limit of
500 changes the best-effort endpoint from tile 600 to tile 500. Consequently this
patch preserves the existing route behavior and records `terrain.fallbackCapCandidates`
instead of enforcing the discarded `Math.min`. The graph construction and tile
occupation methods in this fixture are stubbed; it does not establish how often
this branch occurs in a real match.

The direct search runner creates a 64×64 four-neighbor graph with one wall opening
and a separate isolated endpoint. Each query creates a fresh finder, matching
Terrain's current finder lifetime. It runs counts 1, 10, 30, 60 and 128 with ten
warm-ups and seven measured repetitions per case. First-case samples are retained
separately; they are not guaranteed cold JIT or cold machine state. The raw samples
are in [pathfinding-2026-09-08.json](pathfinding-2026-09-08.json).

Measurements used Apple M3, macOS arm64, Bun 1.4.2 and baseline commit
`e43a63009f8e9e361598560e93ebf9623ef6eb2c`. These are source-level component diagnostics,
not production browser/native game captures. Other development work was running
concurrently. They have no simulation tick, rendering, networking or movement
updates and do not reproduce the reported multiplayer symptom.

| Destination | Queries | Baseline median ms | Instrumentation off median ms | Instrumentation on median ms |
| --- | ---: | ---: | ---: | ---: |
| Across wall | 1 | 0.384 | 0.419 | 0.415 |
| Across wall | 10 | 3.940 | 4.272 | 4.248 |
| Across wall | 30 | 12.222 | 13.012 | 15.129 |
| Across wall | 60 | 25.348 | 30.021 | 28.339 |
| Across wall | 128 | 53.771 | 55.805 | 56.057 |
| Isolated | 1 | 0.603 | 0.590 | 0.598 |
| Isolated | 10 | 7.269 | 7.163 | 7.709 |
| Isolated | 30 | 21.632 | 20.302 | 20.601 |
| Isolated | 60 | 43.900 | 41.889 | 41.739 |
| Isolated | 128 | 96.099 | 92.500 | 101.540 |

All recorded route checksums match across variants. Each isolated query discovers,
expands and allocates exactly 4,096 states. This confirms that the per-finder state
pool does not reuse objects across Terrain queries. It does not identify allocation
or GC as the dominant real-match cost, so cross-query pooling remains deferred.

Instrumentation overhead is nonzero and these sequential runs are noisy. For
example, reachable 30-query median is 6.5% higher with instrumentation disabled
and 23.8% higher enabled; isolated 30-query timings decrease. Seven samples make
p95 the sample maximum; baseline isolated-30 p95 is 86.91 ms despite a 21.63 ms
median. No acceptance target or statistically supported performance improvement is
claimed. Production/runtime captures and more controlled interleaved runs remain
necessary before choosing an optimization.

## Reproduce

From the repository root:

```sh
bun scripts/performance/pathfinding-benchmark.ts > /tmp/pathfinding-disabled.json
PATHFINDER_TELEMETRY=1 bun scripts/performance/pathfinding-benchmark.ts > /tmp/pathfinding-enabled.json
bun test redalert2/src/game/map/pathFinder/PathFinder.test.ts redalert2/src/game/map/Terrain.pathfinding.test.ts
```

To run the uninstrumented reference, extract `PathFinder.ts`, `NodeHeap.ts` and
`SearchStatePool.ts` from the baseline commit into the same temporary directory,
then set `PATHFINDER_MODULE` to the absolute extracted `PathFinder.ts` path. The
runner always imports its Graph implementation from the current tree; that file
is unchanged in this patch. `PATHFINDER_MODULE` is an explicitly supplied local
diagnostic module, not application configuration.

## Instrumentation and correctness

The existing opt-in performance runtime now observes `path.search`, search/node/
heap/state allocation counters, `terrain.computePath`, graph preparation, island
rebuild timing, graph updates and fallback candidates. Per-node work only updates
local numeric fields; telemetry receives totals at search completion, including
when a callback throws. Timings are inclusive: graph preparation includes island
rebuilds, and Terrain time includes path search. Do not sum these nested phases.

Seven tests verify tie-route/callback order, profiling on/off equivalence, explicit
expansion-limit behavior, pooled state allocation counting, error reporting,
endpoint/ignored-blocker cleanup and nested Terrain query ownership. No storage
reuse, callback hoisting, neighbor-order or expansion-limit change was introduced.
