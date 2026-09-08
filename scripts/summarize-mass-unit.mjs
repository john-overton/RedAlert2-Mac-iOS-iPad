// node scripts/summarize-mass-unit.mjs build/raw.json docs/reports/summary.json
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const rounded = value => Math.round(value * 1e6) / 1e6;
const distribution = values => ({ median: rounded(median(values)), min: rounded(Math.min(...values)), max: rounded(Math.max(...values)) });
function numericMedians(objects) {
  const keys = [...new Set(objects.flatMap(Object.keys))].sort();
  return Object.fromEntries(keys.filter(key => objects.every(o => Number.isFinite(o[key]))).map(key => [key, rounded(median(objects.map(o => o[key])))]));
}
export function summarizeMassUnitCapture(raw, rawBytes, rawFile) {
  if (!raw.hashesMatch || !Array.isArray(raw.runs)) throw new Error('Capture is incomplete; do not publish partial data as a completed baseline.');
  const expectedCases = raw.config.scenarios.flatMap(s => (s.counts || raw.config.counts).map(count => ({ name: s.name, count })));
  if (raw.runs.length !== expectedCases.length * 2 * (raw.config.repeats + 2)) throw new Error('Unexpected run count.');
  const groups = [];
  for (const scenario of expectedCases) {
    let reference;
    for (const profiling of [false, true]) {
      const samples = raw.runs.filter(r => r.case === scenario.name && r.count === scenario.count && r.profiling === profiling);
      const measured = samples.filter(r => typeof r.sample === 'number');
      if (samples.length !== raw.config.repeats + 2 || measured.length !== raw.config.repeats || measured.some((r, i) => r.sample !== i + 1)) throw new Error('Missing or duplicate repetitions.');
      for (const sample of samples) {
        if (!Array.isArray(sample.hashes) || sample.hashes.length !== raw.config.ticks || sample.hashes.some((h, i) => h.tick !== i + 1)) throw new Error('Incomplete tick trace.');
        const hashes = JSON.stringify(sample.hashes);
        if (reference && hashes !== reference) throw new Error('Hash mismatch in ' + scenario.name);
        reference = hashes;
      }
      const metricNames = [...new Set(measured.flatMap(r => Object.keys(r.telemetry.metrics)))].sort();
      const metrics = Object.fromEntries(metricNames.map(name => {
        const records = measured.map(r => r.telemetry.metrics[name]);
        if (records.some(r => !r)) throw new Error('Metric missing in one repetition: ' + name);
        return [name, { mediansAcrossRuns: numericMedians(records), worstRunMaxMs: rounded(Math.max(...records.map(r => r.maxMs ?? 0))) }];
      }));
      const counterNames = [...new Set(measured.flatMap(r => Object.keys(r.telemetry.counters || {})))].sort();
      const render = measured.every(r => r.render) ? Object.fromEntries(['update', 'submit', 'frameInterval', 'drawCalls'].map(name => [name, { mediansAcrossRuns: numericMedians(measured.map(r => r.render[name])), worstRunMax: rounded(Math.max(...measured.map(r => r.render[name].max))) }])) : null;
      if (render) {
        render.graphics = measured[0].render.graphics; render.camera = measured[0].render.camera; render.pacing = measured[0].render.pacing;
        if (measured.every(r => r.render.rafWait)) render.rafWait = { mediansAcrossRuns: numericMedians(measured.map(r => r.render.rafWait)), worstRunMax: rounded(Math.max(...measured.map(r => r.render.rafWait.max))) };
      }
      const budgetMs = measured[0].tickBudgetMs;
      const commandTicks = (measured[0].orders || []).map(order => ({ tick: order.tick,
        orderMs: distribution(measured.map(r => r.orders.find(o => o.tick === order.tick).elapsedMs)),
        receivingTickMs: distribution(measured.map(r => r.tickTimes[order.tick])),
      }));
      groups.push({ case: scenario.name, count: scenario.count, profiling, measuredRepetitions: measured.length,
        normalTargetingDelay: measured[0].normalTargetingDelay ?? null,
        render,
        hash: measured.every(r => r.hash) ? { mediansAcrossRuns: numericMedians(measured.map(r => r.hash)), worstRunMaxMs: rounded(Math.max(...measured.map(r => r.hash.max))) } : null,
        commandTicks,
        tickBudget: Number.isFinite(budgetMs) ? { ms: rounded(budgetMs), aboveBudgetPerRun: distribution(measured.map(r => r.tickTimes.filter(ms => ms > budgetMs).length)), firstMeasuredRunAboveBudgetTickIndices: measured[0].tickTimes.flatMap((ms, tick) => ms > budgetMs ? [tick] : []).slice(0, 32) } : null,
        selected: distribution(measured.map(r => r.selected)), moved: distribution(measured.map(r => r.moved)),
        combat: { targetCounts: distribution(measured.map(r => r.targets?.length || 0)), damagedTargetCounts: distribution(measured.map(r => (r.targets || []).filter(t => t.destroyed || t.health < 100).length)), destroyedTargetCounts: distribution(measured.map(r => (r.targets || []).filter(t => t.destroyed).length)) },
        order: { mediansAcrossRuns: numericMedians(measured.map(r => r.order)), p95AcrossRuns: distribution(measured.map(r => r.order.p95)), worstRunMaxMs: rounded(Math.max(...measured.map(r => r.order.max))) },
        tick: { mediansAcrossRuns: numericMedians(measured.map(r => r.tick)), p95AcrossRuns: distribution(measured.map(r => r.tick.p95)), worstRunMaxMs: rounded(Math.max(...measured.map(r => r.tick.max))) },
        metrics, counters: Object.fromEntries(counterNames.map(name => [name, distribution(measured.map(r => r.telemetry.counters[name] ?? 0))])),
        excludedSamples: samples.filter(r => typeof r.sample !== 'number').map(r => ({ label: r.sample, orderP95Ms: rounded(r.order.p95), tickP95Ms: rounded(r.tick.p95), tickMaxMs: rounded(r.tick.max) })),
      });
    }
  }
  return { schemaVersion: 1, captureGeneratedAt: raw.generatedAt,
    rawArtifact: { path: rawFile, bytes: rawBytes.byteLength, sha256: createHash('sha256').update(rawBytes).digest('hex') },
    provenance: raw.provenance || { sourceCheckoutCommit: raw.commit, sourceCheckoutDirty: raw.dirty, buildIndexSha256: raw.buildIndexSha256, sourceMatchesBuild: 'unverified; original capture records checkout and build index only' },
    buildMode: raw.buildMode, runtime: raw.runtime, config: raw.config,
    hashValidation: { passed: true, comparedRuns: raw.runs.length, ticksPerRun: raw.config.ticks, scope: 'Every tick compared across all repetitions and both profiling states per scenario/count; no cross-build or network assertion.' },
    aggregation: 'Median of per-run statistics from numeric measured repetitions only; min/max describe between-run variation. Quantiles are not pooled across runs. Telemetry percentiles describe bounded retained samples; totals/counters cover the run. Timings rounded to six decimals in ms.',
    limitations: raw.limitations, groups };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node scripts/summarize-mass-unit.mjs input.json output.json');
  if (resolve(input) === resolve(output)) throw new Error('Summary must not overwrite the raw capture.');
  const bytes = readFileSync(input), summary = summarizeMassUnitCapture(JSON.parse(bytes), bytes, input);
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, JSON.stringify(summary, null, 2) + '\n');
  console.log(`Wrote ${summary.groups.length} case/count/profile summaries; ${summary.hashValidation.comparedRuns} runs validated.`);
}
