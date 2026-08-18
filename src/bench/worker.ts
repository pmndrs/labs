import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBenchRegistry } from '../index.ts';
import { blockSpread, minDetectableEffect } from '../stats.ts';
import { measure, run } from './index.ts';
import { runTrialAt } from './main.ts';
import type { BlockPlan, Stats, Trial } from './types.ts';

type TuneOptions = {
  min_cpu_time?: number;
  min_samples?: number;
  max_samples?: number;
  adaptive?: boolean | number;
  max_cpu_time?: number;
};

function parseTuneEnv(): TuneOptions {
  const minCpuTime = Number(process.env.LABS_MIN_CPU_TIME);
  const minSamples = Number(process.env.LABS_MIN_SAMPLES);
  const maxSamples = Number(process.env.LABS_MAX_SAMPLES);
  const maxCpuTime = Number(process.env.LABS_MAX_CPU_TIME);

  // LABS_ADAPTIVE: "false" → false, a numeric string → that number, anything else → true
  let adaptive: boolean | number | undefined;
  const adaptiveEnv = process.env.LABS_ADAPTIVE;
  if (adaptiveEnv !== undefined) {
    if (adaptiveEnv === 'false') adaptive = false;
    else {
      const n = Number(adaptiveEnv);
      adaptive = Number.isFinite(n) && n > 0 ? n : true;
    }
  }

  return {
    ...(Number.isFinite(minCpuTime) && minCpuTime > 0 ? { min_cpu_time: minCpuTime } : {}),
    ...(Number.isFinite(minSamples) && minSamples > 0 ? { min_samples: minSamples } : {}),
    ...(Number.isFinite(maxSamples) && maxSamples > 0 ? { max_samples: maxSamples } : {}),
    ...(Number.isFinite(maxCpuTime) && maxCpuTime > 0 ? { max_cpu_time: maxCpuTime } : {}),
    ...(adaptive !== undefined ? { adaptive } : {}),
  };
}

const file = process.env.LABS_BENCH_FILE;
if (!file) {
  console.error('LABS_BENCH_FILE env var not set');
  process.exit(1);
}

function blockCount(): number {
  const n = Number(process.env.LABS_BLOCKS);
  return Number.isFinite(n) && n > 1 ? Math.floor(n) : 1;
}

/** Verdict threshold used for the blocked-mode noisy flag, from config via the runner. */
function minDelta(): number {
  const n = Number(process.env.LABS_MIN_DELTA);
  return Number.isFinite(n) && n > 0 ? n : 0.05;
}

async function calibrateFreq(): Promise<number> {
  const r = await measure(() => {}, { batch_unroll: 1 });
  return 1 / (r as any).avg;
}

/** Cheap clock probe (about 50ms) recording the machine state entering a block. */
async function probeFreq(): Promise<number> {
  const r = await measure(() => {}, { batch_unroll: 1, min_cpu_time: 5e7, adaptive: false });
  return 1 / (r as any).avg;
}

/** Serializes Error instances the same way the `json` format does. */
function errorReplacer(_: string, v: any): any {
  if (!(v instanceof Error)) return v;
  return { message: String(v.message), stack: v.stack };
}

/**
 * Child mode: measure a single trial in this fresh process and write it out.
 * Skips calibration and rendering — the parent worker owns both. When part
 * of a blocked run, probes the clock and replays the pilot's plan if given.
 */
async function childMain(index: number): Promise<void> {
  await import(file!);
  const freq = blockCount() > 1 ? await probeFreq() : undefined;
  const plans = process.env.LABS_BLOCK_PLANS
    ? (JSON.parse(process.env.LABS_BLOCK_PLANS) as BlockPlan[])
    : undefined;
  const trial = await runTrialAt(index, parseTuneEnv(), plans);
  writeFileSync(
    process.env.LABS_RESULT_FILE!,
    JSON.stringify({ trial, ...(freq !== undefined ? { freq } : {}) }, errorReplacer)
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
): { trial: Trial; freq?: number } {
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

function runTrialIsolated(trial: any, index: number): Trial {
  return runTrialChild(trial, index).trial;
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
 * block's median and clock probe so between-block variance stays observable.
 * Counters and debug come from the pilot. The pilot's convergence flag is
 * discarded: in blocked mode quality is judged by between-block spread, and
 * `noisy` means the estimated resolvable delta exceeds the configured
 * verdict threshold (minDelta).
 */
function mergeStats(list: Stats[], freqs: number[]): Stats {
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
    noisy: minDetectableEffect(blockSpread(medians), list.length) > minDelta(),
    ...(heaps.length === list.length ? { heap: mergeRange(heaps, weights) } : {}),
    ...(gcs.length === list.length ? { gc: mergeRange(gcs, weights) } : {}),
    blocks: { medians, freqs },
  };
}

function mergeBlocks(parts: Array<{ trial: Trial; freq?: number }>): Trial {
  if (parts.length === 1) return parts[0].trial;
  const pilot = parts[0].trial;
  const freqs = parts.map((p) => p.freq ?? 0);
  return {
    ...pilot,
    runs: pilot.runs.map((run, j) => {
      const statsList = parts.map((p) => p.trial.runs[j]?.stats);
      if (run.error !== undefined || !run.stats || statsList.some((s) => !s)) return run;
      return { ...run, stats: mergeStats(statsList as Stats[], freqs) };
    }),
  };
}

/**
 * Runs every bench as `blocks` fresh child processes. Block 0 is the pilot:
 * it samples adaptively within a per-block budget and its measurement plan
 * freezes the remaining blocks. Blocks are scheduled round robin across
 * benches so each bench's blocks span the whole sitting and between-block
 * spread samples real environment drift, not just adjacent seconds.
 */
function makeBlockExecutor(blocks: number) {
  return async (jobs: Array<{ trial: any; index: number }>): Promise<Map<number, Trial>> => {
    const tune = parseTuneEnv();
    const budget = (tune.max_cpu_time ?? 5e9) / blocks;
    const pilotEnv = {
      LABS_MIN_CPU_TIME: String(Math.min(tune.min_cpu_time ?? 642e6, budget / 2)),
      LABS_MAX_CPU_TIME: String(budget),
    };

    const collected = new Map<number, Array<{ trial: Trial; freq?: number }>>();
    const plans = new Map<number, BlockPlan[]>();

    for (let block = 0; block < blocks; block++) {
      for (const { trial, index } of jobs) {
        // A pilot without a full set of plans (errored runs) is not replayable
        if (block > 0 && !plans.has(index)) continue;
        const out = runTrialChild(
          trial,
          index,
          block === 0 ? pilotEnv : { LABS_BLOCK_PLANS: JSON.stringify(plans.get(index)) }
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
  const isolate = process.env.LABS_ISOLATE !== 'false';
  const blocks = isolate ? blockCount() : 1;
  await import(file!);
  const result = await run({
    tune: parseTuneEnv(),
    ...(isolate
      ? blocks > 1
        ? { execute: makeBlockExecutor(blocks) }
        : { run_trial: runTrialIsolated }
      : {}),
  });
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
