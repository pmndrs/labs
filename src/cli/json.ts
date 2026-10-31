import type { GcStats } from '../bench/types.ts';
import { type CompareResult, compareFailed } from '../compare.ts';
import type { LabsConfig } from '../config.ts';
import { type SavedResult, isEnvironmentStable } from '../store.ts';
import { runStatus } from './run-view.ts';

/** How much the CPU speed probes varied across the run, as a fraction of their mean. */
function cpuSpeedVaried(result: SavedResult): number {
  const readings = (result.environment?.freqs ?? []).flatMap((f) => [f.runFreq, f.postFreq]);
  if (readings.length < 2) return 0;
  const min = Math.min(...readings);
  const max = Math.max(...readings);
  return (max - min) / ((max + min) / 2);
}

function gcJson(gc: GcStats) {
  return {
    ...(gc.source ? { source: gc.source } : {}),
    perIterationNs: gc.iterations > 0 ? gc.total / gc.iterations : null,
    share: gc.elapsed > 0 ? gc.total / gc.elapsed : null,
    events: gc.count,
    major: gc.major,
    maxNs: gc.max,
    maxKind: gc.maxKind ?? null,
  };
}

/** The judged view of a run, with the same conclusions the report screen shows. */
export function runJson(result: SavedResult, config: LabsConfig, saved: boolean) {
  return {
    name: result.name,
    saved,
    environment: { stable: isEnvironmentStable(result), cpuSpeedVaried: cpuSpeedVaried(result) },
    benches: result.files.flatMap((file) =>
      file.benchmarks.flatMap((trial) =>
        trial.runs.map((run) => {
          const status = runStatus(
            trial,
            run,
            (file.context ?? result.context)?.noop,
            config.minDelta
          );
          const stats = run.stats;
          return {
            file: file.file,
            group: trial.groupName ?? '',
            name: run.name || trial.alias || 'anonymous',
            status: status.symbol === '✓' ? 'passed' : status.symbol === '✗' ? 'failed' : 'warning',
            problem: status.problem ?? null,
            message: status.message,
            advice: status.advice,
            minDetectableChange: status.minDetectableChange ?? null,
            timeNs: stats
              ? { avg: stats.avg, p75: stats.p75, p99: stats.p99, min: stats.min, max: stats.max }
              : null,
            heapBytes: stats?.heap ?? null,
            gc: stats?.gc && 'total' in stats.gc ? gcJson(stats.gc) : null,
          };
        })
      )
    ),
  };
}

/**
 * The judged view of a comparison. A neutral bench whose resolution is coarser than
 * minDelta is inconclusive, since a real change of that size could have been missed.
 */
export function compareJson(result: CompareResult, config: LabsConfig) {
  return {
    baseline: result.baselineName,
    candidate: result.candidateName,
    failures: result.environmentFailures,
    warnings: result.environmentWarnings,
    benches: result.benches.map((bench) => {
      const key = { file: bench.key.file, group: bench.key.group, name: bench.key.name };
      if (bench.kind === 'eligible') {
        const inconclusive =
          bench.verdict === 'neutral' && bench.comparisonResolution > config.minDelta;
        return {
          ...key,
          verdict: inconclusive ? 'inconclusive' : bench.verdict,
          change: bench.hl,
          ci: [bench.ciLow, bench.ciHigh],
          p: bench.p,
          minDetectableChange: bench.comparisonResolution,
          baselineP50Ns: bench.baselineP50,
          candidateP50Ns: bench.candidateP50,
        };
      }
      if (bench.kind === 'changed') return { ...key, verdict: 'changed', reason: 'output changed' };
      if (bench.kind === 'failed') return { ...key, verdict: 'failed', reason: bench.message };
      if (bench.kind === 'skipped') return { ...key, verdict: 'skipped', reason: bench.reason };
      return { ...key, verdict: 'missing', reason: `only in ${bench.presentIn}` };
    }),
  };
}

/**
 * Exit code for a comparison. Failed checks and changed output always fail. With
 * `failOnSlower`, a slower bench fails too, and a comparison that could have missed a
 * change exits 2: a bench was inconclusive or skipped, or the candidate ran on an
 * unstable machine.
 */
export function comparisonExitCode(
  result: CompareResult,
  config: LabsConfig,
  candidate: SavedResult,
  failOnSlower: boolean
): 0 | 1 | 2 {
  if (compareFailed(result)) return 1;
  if (!failOnSlower) return 0;
  const benches = compareJson(result, config).benches;
  if (benches.some((bench) => bench.verdict === 'slower')) return 1;
  const undecided = benches.some((b) => b.verdict === 'inconclusive' || b.verdict === 'skipped');
  if (undecided || !isEnvironmentStable(candidate)) return 2;
  return 0;
}
