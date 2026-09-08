# Rejected weapon targeting candidate — 2026-09-08

A production stress capture with 1,000 same-tick-spawned JUMPJET units on Bay of
Pigs showed recurring 28-tick spikes. The diagnostic CPU profile attributed about
458 ms of 1,398 ms simulation CPU to `AttackTrait.scanForTarget` inclusively;
weapon selection accounted for about 165 ms and spatial queries about 63 ms.
These observations describe the stress fixture, not a confirmed reproduction of
the originally reported 30–40-unit symptom. Same-tick spawning synchronizes target
scan cooldowns and can exaggerate periodic bursts.

The experimental candidate removed a forwarding closure from `WeaponTargeting.canTarget` for
each candidate weapon check. It preserves predicate order, arguments, receiver,
short circuit, initial array length, inherited/sparse slots, mutations and thrown
exceptions. It changes no targeting predicates, scan cadence or target selection.

An isolated prototype benchmark on Apple M3 / Bun 1.4.2 ran real targeting
predicates against synthetic airborne targets. It alternated baseline/candidate
order for eleven measured repetitions after eight warmups. With 1,000 distinct
weapon targeting instances, median time per million calls was:

| Candidate distribution | Baseline ms | Indexed loop ms |
| --- | ---: | ---: |
| 99% friendly | 17.14 | 8.04 |
| Mixed friendly/enemy/cloaked/invulnerable | 27.62 | 11.95 |
| Enemy | 36.36 | 15.11 |

All sample acceptance counts matched. Raw observations are retained in
[weapon-targeting-prototype-2026-09-08.json](weapon-targeting-prototype-2026-09-08.json).
These results compare a temporary prototype with the original method before the
source candidate was installed. They are not an end-to-end production improvement
claim. Production Chromium A/B rejected the candidate. All deterministic hashes matched,
but the full 1,000-unit scenario produced only small tick improvements while order
processing regressed:

| Production measure | Baseline ms | Candidate ms | Change |
| --- | ---: | ---: | ---: |
| Tick p95 | 3.530 | 3.375 | −4.4% |
| Tick p99 | 44.125 | 42.060 | −4.7% |
| Worst tick | 54.625 | 48.850 | −10.6% |
| Median of per-run command p95 | 1.810 | 2.110 | +16.6% |
| Profiling-enabled command p95 | 2.195 | 3.175 | +44.6% |

Only four commands were measured per run, so command p95 estimates are noisy.
These results do not establish a reliable net improvement meeting the plan's
acceptance targets. The source method has been restored to its original `.every`
implementation. No targeting optimization from this experiment is shipped.
Native-runtime performance remains unverified.

The tracked runner uses a small explicit reference of the original `.every`
forwarding method plus the rejected indexed prototype, importing all predicates
from the real `WeaponTargeting` class. From the repository root:

```sh
bun scripts/performance/weapon-targeting-benchmark.ts > /tmp/weapon-targeting.json
```

Characterization tests in `redalert2/src/game/WeaponTargeting.test.ts` cover forwarding
semantics and real airborne targets. Existing `CampaignTargeting.test.ts` retains
one-way alliance and forced-fire checks. The served baseline build was not changed
when preparing this candidate.
