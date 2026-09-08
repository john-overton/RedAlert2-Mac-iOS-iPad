# Mass-unit investigation — 2026-09-08

The reported case is Bay of Pigs with about 30–40 rocketeers (`JUMPJET`).
Rocketeers use direct air paths; the ground pathfinder does not plan their flight.
The controlled 40-unit simulation fixture has not reproduced the reported hitch
on this Apple M3. The 1,000-unit stress fixture does produce periodic expensive
simulation ticks. No performance optimization has been accepted from this pass.
A separate cross-engine synchronization defect was found and fixed: the PRNG's
initial last-value field now has a finite value without consuming a random draw.

The implemented changes provide opt-in bounded telemetry, deterministic production
browser scenarios, CPU profiling, compact reports, and regression coverage. See
[reproduction instructions](MASS_UNIT_BENCHMARK.md) and the
[remaining acceptance criteria](MASS_UNIT_OPTIMIZATION_PLAN.md).

## Scaling and attribution

Production Chrome 152 on Apple M3, macOS arm64, 24 GiB memory, 1280×900 viewport;
Bay of Pigs, fixed seed, AI disabled. Each case has five measured repetitions,
separate first/warmup samples, and 450 simulation ticks (10 simulated seconds at
45 ticks/second, a 22.22 ms tick budget). Order durations include all required
selection/order batches. Simulation timing includes order application and
`Game.update()`, but excludes state hashing, rendering, and network scheduling.
These numbers are not frame rates.

The [30/40/100-unit baseline](reports/mass-unit-bay-of-pigs-small-baseline.json)
and [1,000-unit baseline](reports/mass-unit-bay-of-pigs-1000-baseline.json)
record the following with profiling disabled. Quantiles are medians of the five
per-run quantiles; the last column is the worst tick across measured repetitions.

| Rocketeers | Command p95, ms | Tick median, ms | Tick p95, ms | Tick p99, ms | Worst tick, ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 30 | 0.110 | 0.105 | 0.180 | 0.295 | 2.640 |
| 40 | 0.125 | 0.120 | 0.230 | 0.595 | 2.825 |
| 100 | 0.205 | 0.210 | 0.365 | 1.045 | 2.990 |
| 1,000 | 1.810 | 1.820 | 3.530 | 44.125 | 54.625 |

There are only four commands per repetition, so each per-run command p95 equals
its maximum; tick quantiles have 450 samples per repetition.

All 1,000 units receive orders in eight consecutive groups of at most 128; the
profiling runs confirm 4,000 accepted unit orders over four command ticks. All
1,000 units move, and the directly attacked tank is destroyed. This is a short
attack followed by attack-move, not a sustained battle between two large armies.
The fixture spawns all units together, which synchronizes passive target scans;
a naturally staggered army may have different worst-tick behavior. The ordinary
selection cap remains 128, and does not cap total simulation population. This
fixture varies the army population, not just selection size. A live match with
40 selected units plus many other armies is not equivalent to this isolated
40-unit case; total population, density, opposing units and peer speed matter.

The [CPU profile summary](performance/mass-unit-cpu-2026-09-08.json) attributes
about 458 ms of 1,398 ms sampled simulation CPU to `scanForTarget`, including its
nested work (roughly 33%). The normal target-scan delay is 27, yielding recurring
28-tick scans. Hashing accounts for another 691 ms in that diagnostic loop,
outside the timed simulation ticks. Nested profile categories overlap and must
not be summed. The original 40-unit symptom is not established by this artificial
1,000-unit scan burst.

Profiling has overhead: the 1,000-unit median per-run p95 tick rises from 3.530 ms
with telemetry disabled to 4.515 ms enabled. Use unprofiled captures for timing
conclusions. Telemetry is disabled by default; its bounded traces and phase
measurements support attribution, not a claim of zero overhead.

## Rendering coverage

The [40-unit Chrome render probe](reports/mass-unit-bay-of-pigs-render-chromium.json)
uses the real renderer, selects the units, and follows the first unit. It runs one
simulation tick per animation frame, not the production game-speed scheduler.
On ANGLE Metal / Apple M3 with a 1280×900 backing canvas at device scale 1,
median per-run p95 CPU update was 4.010 ms and draw submission was 2.570 ms.
The median draw count was 177, with a maximum of 227. CPU submission does not
measure GPU completion, and separate phase quantiles cannot simply be summed.

Warm captures still had occasional 33–50 ms frame intervals, while their p95
interval was approximately 16.67 ms. The cold capture recorded a renderer-update
maximum around 46 ms and an 83 ms frame interval; first-frame asset/shader work is
not equivalent to steady movement. Those gaps have not been attributed to a
specific rendering function or established as the user's original symptom.
Simulation hashes matched the simulation-only 40-unit case despite rendering.

The [40-unit WebKit Retina probe](reports/mass-unit-bay-of-pigs-render-webkit-retina.json)
uses a 2560×1800 backing canvas at device scale 2. Median per-run p95 CPU update
was 3.56 ms and submission was 2.44 ms. Warm frame intervals had a median of
17 ms, p95 of 20 ms and p99 of 25 ms, but three repetitions recorded isolated
525–814 ms gaps. Measured simulation and rendering CPU phases did not explain
those gaps. Browser and resolution differ from the Chrome probe, so this is not
an engine performance ranking.

A [follow-up diagnostic](reports/mass-unit-fixed-webkit-render-diagnostic.json)
measured hashing and animation-frame waiting separately. Hashing took at most
2.84 ms; its largest frame gap was 77 ms, including 71.06 ms awaiting the next
animation frame. The earlier 500–814 ms stalls did not recur in this single run.
Their cause remains unresolved; the PRNG fix is not claimed to fix rendering.

The application sets render pixel ratio from viewport scale × device pixel ratio,
clamped to 1–3 (`Gui.ts`, `Renderer.ts`). A 1× probe therefore cannot establish
Retina/native performance. Native WKWebView, iPad hardware, background peers and
sustained dense combat still require their own captures.

## Rejected optimization

An indexed traversal of weapon targeting predicates eliminated a forwarding
closure in a promising Bun component benchmark. Production Chrome A/B testing
matched every hash across 14 runs, but p95 tick time improved only 4.4%
(3.530→3.375 ms) while p95 command time increased 16.6% (1.810→2.110 ms).
Each repetition has only four commands, and sequential comparisons are subject
to runtime drift; this does not establish a reliable net improvement. The source
change was reverted. [Candidate evidence](reports/mass-unit-bay-of-pigs-1000-candidate-rejected.json)
and the [reproducible experiment](performance/WEAPON_TARGETING_PROTOTYPE.md) remain
available. No targeting behavior, retry schedule, or order cap was changed.

The ineffective unreachable-path expansion cap was also reproduced in a focused
Terrain fixture. Applying the apparent limit changes the best-effort endpoint,
so the existing route behavior is retained. See the
[pathfinding report](performance/PATHFINDING_BASELINE.md).

## Cross-engine synchronization fix

The first Chrome/WebKit comparison differed at tick zero, before movement. Every
object hash, raw position byte, player hash and serialized debug state matched.
`Prng.lastRandom` was uninitialized, so `Game.getHash()` converted `undefined` to
Float64 NaN bytes. A direct browser reproduction produced different NaN payloads:
Chrome `[255,255,246,255,255,255,246,255]`, WebKit
`[0,0,0,0,0,0,248,127]`. NaN payloads are not a portable hash representation.

`Prng.lastRandom` now starts at zero, producing eight zero bytes on both engines.
The fix does not call the generator, change its seed, or advance its sequence.
Focused tests compare alternating floating-point/integer draws against Mersenne
Twister across four seeds. Only hashes before the first random draw intentionally
change; this is not a unit movement or targeting change.

The existing source-derived build fingerprint separates old/new clients and
replay versions. Historical pre-first-draw checkpoints are not claimed compatible;
no replay-format change was introduced. Performance captures above predate this
hash representation fix and remain timing evidence, not cross-build hash evidence.

## Correctness and limits

Two real lockstep commanders and a late observer matched every hash through
10,000 ticks on Bay of Pigs with 40 rocketeers and 67 repeated move orders. One
commander had profiling enabled and the other disabled. The fixture injects the
same deterministic actions on each engine, including observer replay; it does
not measure transmission latency for those mass-unit commands.
[Validation record](performance/mass-unit-observer-2026-09-08.json).

After the PRNG fix, Chrome and WebKit matched all 450 hashes in the production
scenario, including the initial state and final target outcomes.
[Cross-engine production validation](reports/mass-unit-fixed-cross-engine-validation.json).
A second real lockstep test with a Chrome commander, WebKit commander and late
WebKit observer also matched every hash through 10,000 ticks with 67 orders.
[Mixed-engine lockstep validation](reports/mass-unit-observer-mixed-validation.json).

The test suite passes 242 tests, including formation/bridge behavior, search
callback and cleanup behavior, oversized selection validation, telemetry bounds,
and targeting predicate characterization. The production build succeeds.
Typechecking reports the same 42 errors as baseline commit
`e43a63009f8e9e361598560e93ebf9623ef6eb2c`, verified using an isolated reference
checkout and normalized paths.

One long benchmark session recorded an 833 ms outlier during the subsequent
100-unit case, then stalled while returning to the menu. That incomplete capture
is preserved in `build/mass-unit-bay-of-pigs-scaling-lifecycle-partial.json`.
Completed 1,000-unit repetitions were independently hash-validated and extracted
with provenance. The runner now uses a fresh page per case/count and bounds menu
return time. This isolates cases but does not resolve or establish an application
memory leak; repeated-match memory/GC and lifecycle behavior remain open.

The full terrain/roster/platform matrix, native shell/device captures, sustained
combat with larger opposing armies, and the original reported multiplayer hitch
remain outside completed acceptance. Large raw traces, CSVs and profiles remain
in ignored `build/`; compact reports retain their hashes and reproduction inputs.


## Diagnostics controls and game clock follow-up

The existing saved telemetry switch is now labeled **Slowdown diagnostics** under
Options → General → Performance. It remains off by default in multiplayer and
single player, is local to each client, and can be changed during play. Disabling
it stops sample collection immediately; re-enabling it resets frame timing so the
disabled interval does not appear as a hitch. Previously collected samples remain
available until reset or app exit.

An independent elapsed simulation clock is displayed at the top-right edge of the
battlefield, clear of the sidebar credits and radar. It follows game speed and
stops when simulation stops. The text changes only when the displayed second
changes. Use its time when reporting a slowdown.


The live diagnostics follow-up adds timestamped slow-event retention, a JSON report
export, CPU render phases, animation callback intervals, browser long tasks where
supported, and asynchronous GPU queries where supported. Network context includes
missing relayed peer batches, pending frames, reconnect/send-queue state and
available host-only server health. GPU queries retain their original frame tick
and timestamp, are bounded to eight pending queries, and discard invalid/disjoint
results and results from a previous capture. These additions improve live
attribution; they do not change the historical benchmark findings above.


[Live capture browser validation](reports/live-slowdown-diagnostics-validation.json)
passed in Chrome and WebKit: default-off behavior, actual JSON download, disabled
collection and an intentional 150 ms CPU hitch. Chrome captured long tasks and
GPU times; WebKit explicitly reported both APIs unsupported while retaining the
frame gap and CPU phases. Both had no JavaScript errors. This functional fixture
was single player; network instrumentation has separate protocol-equivalence tests.
Native WKWebView/device report export has not been exercised in this pass.
