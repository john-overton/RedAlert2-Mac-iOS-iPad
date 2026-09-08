# Real-engine mass-unit benchmark

Build and run from the repository root:

```sh
(cd redalert2 && bun run build)
node scripts/mass-unit-benchmark.mjs
# Narrow a matrix by copying/editing the JSON (at least five repetitions).
node scripts/mass-unit-benchmark.mjs /tmp/my-cases.json build/my-results.json
node scripts/mass-unit-benchmark.mjs --compare build/before.json build/after.json
node scripts/summarize-mass-unit.mjs build/my-results.json docs/reports/my-summary.json
```

The runner serves the production `redalert2/dist` build and local `gameres-export`
assets on a temporary loopback port. It requires Playwright Core and Chrome
(`/Applications/Google Chrome.app/...` on macOS, `/usr/bin/chromium` on Linux);
set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to override. `RA2_BENCH_ENGINE=webkit` uses
installed Playwright WebKit. It does not establish native WKWebView performance.
WebKit uses the persistent profile at `build/mass-unit-webkit-profile` (override
with `RA2_WEBKIT_PROFILE`); its ephemeral context failed to open the game's storage
in this environment. No application storage polyfill is injected.
`RA2_BENCH_URL` can point to a running server, labeled external/unverified in
results. No development-module imports are injected into the production game.
`RA2_BENCH_DIST` selects a separate production build directory, allowing baseline
and candidate bundles to remain immutable during captures. `--compare-subset`
compares a smaller completed candidate matrix against a completed baseline while
requiring identical scenario behavior/settings and every simulation hash.

`scripts/mass-unit-benchmark.json` fixes map, timestamp/seed, roster, commands,
counts, and game speed. The default includes repeated vehicle orders, idle units,
an occupied destination and a separately labeled oversized received selection.
Extend `roster` with object type/name pairs (infantry 3, vehicle/naval 7, aircraft 1),
and `commands` with tick/orderType/destination/queue. Order types include move 0,
attack-target 2, attack-move 4, stop 11. Attack commands use `targetIndex` instead
of a destination. Optional `targets` contain type/name and an offset pair relative
to the first spawned unit; the runner places these neutral units on nearby legal
tiles and reveals them to the commander. Final target health/destruction records
whether combat actually occurred. Duplicate command ticks are rejected.
Coordinates are actual map coordinates. An occupied endpoint exercises a real
building blocker; it is not a guarantee of the unreachable fallback branch.

The browser process stays alive. Each case/count starts a fresh page realm, then
retains that realm across its 14 games to preserve JIT warmup while bounding
cross-case resource accumulation. Each run reconstructs the same seeded game and roster through real object,
selection, order and update APIs. The first execution is labeled `cold`; subsequent
case/profile first runs and warmups remain separate from five measured repetitions.
Cold means the first fixture execution, after engine loading and game initialization
already ran; it does not mean a fully cold engine or flushed operating-system cache. Profiling
runs execute after unprofiled runs; compare repeated runs cautiously for thermal or
other time-order drift. The runner checks every tick hash across all repetitions
and profiling states within each case/count, and fails on any mismatch or browser
exception. It fails rather than measuring a game that advanced before setup.

JSON includes raw tick durations and hashes, aggregate median/p95/p99/max/threshold
counts, order durations, telemetry, final unit coordinates, selected/moved counts,
heap estimates where available, runtime, commit, dirty state and production index
fingerprint. New captures also fingerprint every served build file, runner source,
and normalized configuration. The source commit describes the checkout and does
not establish which source produced an existing build. External servers have no
local build fingerprint attributed to them. CSV contains one summary row per sample. Files are saved after every
sample, so interrupted results are explicitly incomplete (`hashesMatch` is only
set after the matrix finishes). Preserve the actual build with captures: the source
commit and dirty flag alone cannot reconstruct a dirty build.

Simulation ticks include order application plus `Game.update()`; hash capture is
outside the timed tick. The animation loop is stopped. These timings exclude
rendering, input latency, network scheduling, observer catch-up and native shell
costs. They cannot be presented as frame rates or multiplayer acceptance results.
Movement counts report displacement, not proof of destination arrival or complete
movement correctness. Ordinary >128 selection is truncated before validation;
the oversized-wire fixture records the existing deserializer's different behavior.
The full default matrix launches many games; start with a narrower reproduction
for an interactive investigation. Large raw reports belong in ignored `build/`.

`--compare` requires complete captures with identical configurations and every tick
hash, then prints median per-run p95 order/tick times for each case/count/profile.
Runtime or machine differences still require human interpretation.

The compact summarizer validates completion, repetition counts and every tick hash
again. It retains aggregate timing/counter/metric statistics and excluded sample
summaries, with the raw artifact byte length and SHA-256; it omits raw traces and
hashes. It refuses incomplete captures or overwriting its input.

`scripts/mass-unit-bay-of-pigs.json` narrows the matrix to Bay of Pigs with 30/40
rocketeers, repeated moves, direct attacks and attack-moves. The targets are neutral
heavy tanks without an AI controller. This is a controlled combat fixture and does
not recreate the user's complete multiplayer battle.

The scaling configuration `scripts/mass-unit-bay-of-pigs-scaling.json` measures
1000, 100, 40 and 30 rocketeers. Its `selection: "batches"` command path issues
consecutive real selection/order actions in groups of at most 128 in the same tick;
all 1000 receive an order without changing the engine cap. Command duration includes
selection processing and action construction/dispatch. `selected` records the
logical roster count and each command records its batch count. This is a synthetic
same-tick workload: simultaneous spawning can synchronize periodic target scans
more strongly than an army produced gradually during a match.

`scripts/mass-unit-bay-of-pigs-render.json` enables a separate 40-rocketeer render
probe. It selects units visually, follows the first unit and invokes the real
renderer once per animation-frame callback after each simulation tick. Update CPU
time includes camera panning; submit CPU time does not wait for GPU completion.
Draw calls cover all scenes. RAF intervals include the deliberate wait and hash
capture overhead. One tick per RAF does not reproduce production speed scheduling.
`deviceScaleFactor` defaults to 1 and accepts values from 1 to 3. The Retina
configuration `scripts/mass-unit-bay-of-pigs-retina.json` selects 2 and records the
actual canvas backing dimensions and GPU renderer. Run it with
`RA2_BENCH_ENGINE=webkit` for the WebKit probe. Engine and pixel-density differences
must both be considered when comparing those captures. New render captures include
per-frame CPU/RAF samples in the raw JSON; compact summaries omit that series.

For a single Chromium CPU diagnostic, after other benchmarks finish:

```sh
RA2_BENCH_CPU_PROFILE=build/mass-unit.cpuprofile node scripts/mass-unit-benchmark.mjs scripts/mass-unit-bay-of-pigs-scaling.json build/mass-unit-profile.json
```

The profiler captures the first scenario/count's simulation loop (orders, updates
and hash capture), excluding fixture setup. It deliberately stops after one sample
and sets `completeMatrix: false`; it cannot be summarized as a completed baseline.
Timing in that run includes profiler overhead. Import the `.cpuprofile` in Chrome
DevTools to inspect function-level attribution. Avoid concurrent performance runs.

`RA2_BENCH_STATE_DIAGNOSTIC=1` captures setup tick 0 and post-update tick 1, including
the game's debug state, every object's hash and raw position bytes, trait/player
hashes and PRNG state. It runs only the first sample and marks the matrix incomplete.
This supports diagnosing cross-runtime hash mismatches separately from timing.

The real lockstep/late-observer check uses the existing development-server runner:

```sh
RA2_MIXED_ENGINE_SMOKE=1 RA2_DEV_URL=http://127.0.0.1:4001 bun scripts/observer-engine-smoke.mjs
```

The mixed flag enables a Chromium commander, WebKit commander and late WebKit
observer with 40 rocketeers on Bay of Pigs and 67 repeated orders over 10,000 ticks.
Commander profiling is on/off respectively; the observer profiles while catching
up. `RA2_MASS_UNIT_SMOKE=1` runs the same workload with Chromium clients only.
These are correctness runs using a fresh asset-seeded development server, separate
from production performance captures. The compact validation report is
`docs/reports/mass-unit-observer-mixed-validation.json`.

For an interactive reproduction on an instrumented build, the existing debug API
can enable/reset the same bounded telemetry used by the runner:

```js
window.__ra2debug.performance.setEnabled('telemetry', true);
window.__ra2debug.performance.reset();
// Reproduce the issue, then save this JSON along with map/device/order details:
JSON.stringify(window.__ra2debug.performance.snapshot());
window.__ra2debug.performance.setEnabled('telemetry', false);
```

To repeat the Bay of Pigs commander/late-observer hash check against a fresh,
asset-seeded development server (avoid an old server with HMR module versions):

```sh
RA2_DEV_URL=http://127.0.0.1:4000 RA2_MASS_UNIT_SMOKE=1 \
  PLAYWRIGHT_CHROMIUM_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  bun scripts/observer-engine-smoke.mjs
```

This spawns 40 `JUMPJET` units and injects 67 deterministic move orders on both
commanders and in late-observer replay through 10,000 ticks. It checks hashes with
profiling on/off; it does not measure network input latency for these injected
orders. The default observer smoke behavior is unchanged without the flag.


## In-game slowdown diagnostics

Under **Options → General → Performance**, enable **Slowdown diagnostics** to
record local timing samples. It is off by default and uses the existing saved
telemetry preference. Multiplayer does not turn it on automatically or enable it
for other players. Turning it off immediately stops collecting samples; retained
samples remain available through the debug snapshot API until reset or app exit.
The top-right game timer runs independently of diagnostics. Note its time when a
slowdown occurs; it shows simulation elapsed time and stops while simulation is
paused or waiting. It follows game speed rather than wall-clock time; trace tick
labels correspond to roughly 15 ticks per displayed game second. Enabling diagnostics again does not count the disabled interval
as a slow frame.

### Live session reports

Enable **Slowdown diagnostics**, optionally **Clear recorded samples** before the
match, and choose **Save slowdown report** after a hitch. The JSON is local to your
device. Save each affected player's report if comparing a multiplayer stall.

- `simulation.*`, orders, formation and pathfinding metrics measure instrumented
  CPU work. `render.sceneUpdate`, `render.frameCallbacks` and `render.submit`
  separate scene updates, frame callbacks and CPU draw submission.
- `frame.scheduler` measures animation callback intervals before the frame cap;
  `frame.game` measures rendered frame intervals. Frame limits, visibility and
  catch-up state provide context. Neither interval alone proves GPU saturation.
- `network.*` measures order processing, state hashing and lockstep waiting.
  Waiting can result from a peer's CPU, scheduling, connection or packet delivery;
  it is not a direct measurement of network-only latency.
- `gpu.render` uses asynchronous WebGL timer queries where available. The GPU
  status explicitly reports unsupported, disjoint or lost-context measurements.
  No synchronous GPU completion wait is added. GPU query times describe submitted
  rendering work, not presentation/compositor time.
- `browser.longTask` records browser-reported main-thread tasks of at least 50 ms
  where supported. These arrive asynchronously, so their monotonic timestamp is
  used without inventing a simulation tick. They do not identify JavaScript stacks,
  GC, or another OS process.

`slowEvents` preserves the latest 256 durations of at least 50 ms separately from
8192 recent detailed events. Events have monotonic timestamps (`atMs`, with epoch
`timeOrigin`), game ticks where known, approximate simulation seconds, and context
captured when the event is recorded. GPU results and browser long tasks arrive
later, so their context may be newer than their timestamp. Nested measurements
can describe the same hitch and must not be added together. Samples are bounded,
held in memory and are not automatically uploaded or saved: export promptly.
This is attribution to measured engine phases, not a universal CPU stack profiler
or a guarantee of identifying every slowdown. Unexplained gaps require a browser
or native profiler to separate GPU scheduling, compositor, GC and operating-system
work. Diagnostics themselves add overhead; compare normal play with them off.
