import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBenchRegistry } from '../index.ts';
import { relativeSpread } from '../stats.ts';
import { measure, run } from './index.ts';
import { runTrialAt } from './main.ts';
import type { BlockPlan, Stats, Trial } from './types.ts';

type TuneOptions = {
  min_cpu_time?: number;
  min_samples?: number;
};

/** Per-block budget (LABS_BLOCK_TIME, ns) and sample floor (LABS_MIN_SAMPLES). */
function parseTuneEnv(): TuneOptions {
  const blockTime = Number(process.env.LABS_BLOCK_TIME);
  const minSamples = Number(process.env.LABS_MIN_SAMPLES);

  return {
    ...(Number.isFinite(blockTime) && blockTime > 0 ? { min_cpu_time: blockTime } : {}),
    ...(Number.isFinite(minSamples) && minSamples > 0 ? { min_samples: minSamples } : {}),
  };
}

const file = process.env.LABS_BENCH_FILE;
if (!file) {
  console.error('LABS_BENCH_FILE env var not set');
  process.exit(1);
}

/** Fresh processes per bench. Verdicts need replication, so never fewer than two. */
function blockCount(): number {
  const n = Number(process.env.LABS_BLOCKS);
  return Number.isFinite(n) && n >= 2 ? Math.floor(n) : 2;
}

async function calibrateFreq(): Promise<number> {
  const r = await measure(() => {}, { batch_unroll: 1 });
  return 1 / (r as any).avg;
}

/** Short software calibration probe recording the machine state entering a block. */
async function probeCalibrationRate(): Promise<number> {
  const r = await measure(() => {}, { batch_unroll: 1, min_cpu_time: 5e7 });
  return 1 / (r as any).avg;
}

/** Serializes Error instances the same way the `json` format does. */
function errorReplacer(_: string, v: any): any {
  if (!(v instanceof Error)) return v;
  return { name: v.name, message: String(v.message), stack: v.stack };
}

/**
 * Child mode: measure a single trial in this fresh process and write it out.
 * Skips calibration and rendering, the parent worker owns both. Records a
 * calibration rate for the clock gate and replays the pilot's plan when given.
 */
async function childMain(index: number): Promise<void> {
  await import(file!);
  const calibrationRate = await probeCalibrationRate();
  const plans = process.env.LABS_BLOCK_PLANS
    ? (JSON.parse(process.env.LABS_BLOCK_PLANS) as BlockPlan[])
    : undefined;
  const trial = await runTrialAt(index, parseTuneEnv(), plans);
  writeFileSync(
    process.env.LABS_RESULT_FILE!,
    JSON.stringify({ trial, calibrationRate }, errorReplacer)
  );
}

let childSeq = 0;

/**
 * Runs one trial in a fresh child process (same script, same node flags,
 * `LABS_ONLY_INDEX` selecting the trial) so each bench measures against a
 * pristine V8 — no IC/heap contamination from earlier benches in the file.
 */
function runTrialChild(
  trial: any,
  index: number,
  extraEnv: Record<string, string> = {}
): { trial: Trial; calibrationRate: number } {
  const resultFile = join(tmpdir(), `labs-trial-${process.pid}-${index}-${childSeq++}.json`);
  try {
    execFileSync(process.execPath, [...process.execArgv, process.argv[1]], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        ...extraEnv,
        LABS_ONLY_INDEX: String(index),
        LABS_RESULT_FILE: resultFile,
      },
    });
    return JSON.parse(readFileSync(resultFile, 'utf-8'));
  } catch (err) {
    throw new Error(`isolated bench "${trial?._name ?? index}" failed: ${String(err)}`, {
      cause: err,
    });
  } finally {
    rmSync(resultFile, { force: true });
  }
}

/** Per run plans from a pilot trial, or null when any run failed to produce one. */
function extractPlans(trial: Trial): BlockPlan[] | null {
  const plans: BlockPlan[] = [];
  for (const run of trial.runs) {
    if (!run.stats?.plan) return null;
    plans.push(run.stats.plan);
  }
  return plans;
}

const percentile = (sorted: number[], p: number) => sorted[(p * (sorted.length - 1)) | 0];

function mergeRange(
  list: Array<{ avg: number; min: number; max: number; total: number }>,
  weights: number[]
): { avg: number; min: number; max: number; total: number } {
  const totalWeight = weights.reduce((a, v) => a + v, 0) || 1;
  return {
    avg: list.reduce((a, v, i) => a + v.avg * weights[i], 0) / totalWeight,
    min: Math.min(...list.map((v) => v.min)),
    max: Math.max(...list.map((v) => v.max)),
    total: list.reduce((a, v) => a + v.total, 0),
  };
}

/**
 * Pools samples across blocks and recomputes headline stats, keeping each
 * block's median, calibration rate, and within-block spread so between-run
 * variance and per-process noise both stay observable. Counters and debug
 * come from the pilot.
 */
function mergeStats(list: Stats[], calibrationRates: number[]): Stats {
  const samples = list.flatMap((s) => s.samples).sort((a, b) => a - b);
  const weights = list.map((s) => s.samples.length);
  const heaps = list.map((s) => s.heap).filter(Boolean) as NonNullable<Stats['heap']>[];
  const gcs = list.map((s) => s.gc).filter(Boolean) as NonNullable<Stats['gc']>[];
  const medians = list.map((s) => s.p50);

  return {
    ...list[0],
    samples,
    min: samples[0],
    max: samples[samples.length - 1],
    p25: percentile(samples, 0.25),
    p50: percentile(samples, 0.5),
    p75: percentile(samples, 0.75),
    p99: percentile(samples, 0.99),
    p999: percentile(samples, 0.999),
    avg: samples.reduce((a, v) => a + v, 0) / samples.length,
    ticks: list.reduce((a, s) => a + s.ticks, 0),
    ...(heaps.length === list.length ? { heap: mergeRange(heaps, weights) } : {}),
    ...(gcs.length === list.length ? { gc: mergeRange(gcs, weights) } : {}),
    // `freqs` is retained in the saved schema for compatibility. The values
    // are software calibration rates, not literal hardware frequencies.
    blocks: { medians, freqs: calibrationRates, spreads: list.map((s) => relativeSpread(s.samples)) },
  };
}

function mergeBlocks(parts: Array<{ trial: Trial; calibrationRate: number }>): Trial {
  const pilot = parts[0].trial;
  return {
    ...pilot,
    runs: pilot.runs.map((run, j) => {
      if (run.error !== undefined || !run.stats) return run;
      // A block whose run produced no stats is dropped rather than voiding
      // the whole bench; the surviving blocks still replicate independently.
      const survivors = parts.filter((p) => p.trial.runs[j]?.stats);
      if (survivors.length < parts.length) {
        console.error(
          `labs: bench "${run.name || pilot.alias}" lost ` +
            `${parts.length - survivors.length} of ${parts.length} blocks ` +
            `(no stats produced); merging the ${survivors.length} that completed`
        );
      }
      if (survivors.length < 2) return run;
      // Different block snapshots indicate nondeterministic output.
      const snapshots = new Set(
        survivors.map((p) => JSON.stringify(p.trial.runs[j]!.stats!.snapshot))
      );
      if (snapshots.size > 1) {
        console.error(
          `labs: bench "${run.name || pilot.alias}" produced different snapshots across ` +
            `blocks; make its output deterministic or compare will report it as changed`
        );
      }
      return {
        ...run,
        stats: mergeStats(
          survivors.map((p) => p.trial.runs[j]!.stats!) as Stats[],
          survivors.map((p) => p.calibrationRate)
        ),
      };
    }),
  };
}

/**
 * Runs every bench as `blocks` fresh child processes. Block 0 is the pilot:
 * it samples until the block budget and sample floor are both met, and its
 * measurement plan freezes the remaining blocks. Blocks are scheduled round
 * robin across benches so each bench's blocks span the whole sitting and
 * between-block spread samples real environment drift, not just adjacent
 * seconds.
 */
function makeBlockExecutor(blocks: number) {
  return async (jobs: Array<{ trial: any; index: number }>): Promise<Map<number, Trial>> => {
    const collected = new Map<number, Array<{ trial: Trial; calibrationRate: number }>>();
    const plans = new Map<number, BlockPlan[]>();

    for (let block = 0; block < blocks; block++) {
      for (const { trial, index } of jobs) {
        // A pilot without a full set of plans (errored runs) is not replayable
        if (block > 0 && !plans.has(index)) continue;
        const out = runTrialChild(
          trial,
          index,
          block === 0 ? {} : { LABS_BLOCK_PLANS: JSON.stringify(plans.get(index)) }
        );
        let list = collected.get(index);
        if (!list) collected.set(index, (list = []));
        list.push(out);
        if (block === 0) {
          const p = extractPlans(out.trial);
          if (p) plans.set(index, p);
        }
      }
    }

    const results = new Map<number, Trial>();
    for (const { index } of jobs) results.set(index, mergeBlocks(collected.get(index)!));
    return results;
  };
}

async function main(): Promise<void> {
  await import(file!);
  const result = await run({ tune: parseTuneEnv(), execute: makeBlockExecutor(blockCount()) });
  const postFreq = await calibrateFreq();

  const registry = getBenchRegistry();
  for (let i = 0; i < result.benchmarks.length; i++) {
    (result.benchmarks[i] as any).groupName = registry[i]?.groupName ?? '';
  }

  if (process.env.LABS_RESULT_FILE) {
    writeFileSync(
      process.env.LABS_RESULT_FILE,
      JSON.stringify({ ...result, environment: { postFreq } }, errorReplacer)
    );
  }
}

const onlyIndex = process.env.LABS_ONLY_INDEX;
void (onlyIndex !== undefined ? childMain(Number(onlyIndex)) : main());
