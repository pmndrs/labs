import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { runBrowser } from '../browser-runner.ts';
import type { BlockJob, BlockResult } from '../browser.ts';
import { getBenchRegistry } from '../index.ts';
import { median, relativeSpread } from '../stats.ts';
import { measure, run } from './index.ts';
import { _print } from './lib/runtime.ts';
import { runTrialAt } from './main.ts';
import type { ProgressEvent } from '../cli/progress.ts';
import type { BlockPlan, GcStats, Stats, Trial } from './types.ts';
import { observeNodeDeopts } from './node-deopts.ts';
import { mergeGc } from './lib/gc.ts';
import { colors } from './env.ts';
import { renderReport } from './render.ts';
import { RuntimeLaunchError } from '../runtime-error.ts';

type TuneOptions = {
  min_cpu_time?: number;
  min_samples?: number;
  sample_gc?: false;
  heap?: false;
};

/** Per-block timing budgets and heap diagnostics forwarded by the CLI. */
function parseTuneEnv(): TuneOptions {
  const blockTime = Number(process.env.LABS_BLOCK_TIME);
  const minSamples = Number(process.env.LABS_MIN_SAMPLES);

  return {
    ...(Number.isFinite(blockTime) && blockTime > 0 ? { min_cpu_time: blockTime } : {}),
    ...(Number.isFinite(minSamples) && minSamples > 0 ? { min_samples: minSamples } : {}),
    ...(process.env.LABS_GC === '0' ? { sample_gc: false } : {}),
    ...(process.env.LABS_HEAP === '0' ? { heap: false } : {}),
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
  const r = await measure(() => {}, { batch_unroll: 1, min_cpu_time: 1e8 });
  return 1 / (r as any).avg;
}

/** Short software calibration probe recording the machine state entering a block. */
async function probeCalibrationRate(): Promise<number> {
  const r = await measure(() => {}, { batch_unroll: 1, min_cpu_time: 5e7 });
  return 1 / (r as any).avg;
}

/** The CLI's live view reads progress events as JSON lines on fd 3 instead of a printed report. */
const progress = process.env.LABS_PROGRESS === '1';

function emit(event: ProgressEvent): void {
  if (progress) writeSync(3, JSON.stringify(event) + '\n');
}

/**
 * Turn protocol. A worker spawned with an IPC channel asks its parent for the
 * CPU before each measurement and holds it until the next request or exit, so
 * the parent can alternate workers block for block. Without a channel the
 * worker runs unpaced.
 */
function takeTurn(phase = 'turn'): Promise<void> {
  if (!process.send) return Promise.resolve();
  return new Promise((resolve) => {
    const onMessage = (message: unknown) => {
      if (message !== 'go') return;
      process.off('message', onMessage);
      resolve();
    };
    process.on('message', onMessage);
    process.send!(phase);
  });
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
  const dispose =
    process.env.LABS_BUN_GC === '1'
      ? await (await import('./lib/bun-gc.ts')).prepareBunGc()
      : undefined;
  try {
    await import(file!);
    const calibrationRate = await probeCalibrationRate();
    const plans = process.env.LABS_BLOCK_PLANS
      ? (JSON.parse(process.env.LABS_BLOCK_PLANS) as BlockPlan[])
      : undefined;
    const tune = parseTuneEnv();
    const trace = process.env.LABS_DEOPT_DIR;
    const trial = await runTrialAt(
      index,
      trace ? { ...tune, $deopts: observeNodeDeopts(trace) } : tune,
      plans
    );
    writeFileSync(
      process.env.LABS_RESULT_FILE!,
      JSON.stringify({ trial, calibrationRate }, errorReplacer)
    );
  } finally {
    await dispose?.();
  }
}

let childSeq = 0;

/**
 * Runs one trial in a fresh child process (same script, same runtime flags,
 * `LABS_ONLY_INDEX` selecting the trial) so each bench measures against a
 * pristine engine with no JIT or heap contamination from earlier benches in the file.
 */
async function runTrialChild(
  trial: any,
  index: number,
  extraEnv: Record<string, string> = {},
  observeGc = true
): Promise<{ trial: Trial; calibrationRate: number }> {
  const resultFile = join(tmpdir(), `labs-trial-${process.pid}-${index}-${childSeq++}.json`);
  // Preserve the destinations of explicitly requested V8 logs and traces.
  const trace =
    !(globalThis as any).Bun &&
    process.execArgv.includes('--allow-natives-syntax') &&
    !process.execArgv.some((flag) =>
      /^--(?:no-)?(?:log(?:file)?(?:-|=|$)|redirect-code-traces|trace-(?:deopt|opt)|print-opt-code)/.test(
        flag
      )
    )
      ? mkdtempSync(join(tmpdir(), 'labs-deopt-'))
      : undefined;
  try {
    const env = {
      ...process.env,
      ...extraEnv,
      ...(trace ? { LABS_DEOPT_DIR: trace } : {}),
      LABS_ONLY_INDEX: String(index),
      LABS_RESULT_FILE: resultFile,
    };
    if ((globalThis as any).Bun && observeGc && process.env.LABS_GC !== '0') {
      const { observeBunGc } = await import('../bun-inspector.ts');
      const child = spawn(
        process.execPath,
        ['--inspect=127.0.0.1:0', ...process.execArgv, process.argv[1]],
        {
          stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
          env: { ...env, LABS_BUN_GC: '1' },
        }
      );
      await observeBunGc(child);
    } else {
      const flags = trace
        ? [
            '--log-code',
            '--no-log-source-code',
            '--log-deopt',
            '--logfile-per-isolate',
            '--logfile=' + join(trace, 'code.log'),
            '--redirect-code-traces',
            '--redirect-code-traces-to=' + join(trace, 'bailouts.txt'),
          ]
        : [];
      execFileSync(process.execPath, [...process.execArgv, ...flags, process.argv[1]], {
        stdio: ['ignore', 'inherit', 'inherit'],
        env,
      });
    }
    return JSON.parse(readFileSync(resultFile, 'utf-8'));
  } catch (err) {
    throw new Error(`isolated bench "${trial?._name ?? index}" failed: ${String(err)}`, {
      cause: err,
    });
  } finally {
    if (trace) rmSync(trace, { recursive: true, force: true });
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

/** Range across blocks and the median of the block medians. */
function mergeRange(list: Array<{ min: number; max: number; p50: number }>): {
  min: number;
  max: number;
  p50: number;
} {
  return {
    min: Math.min(...list.map((v) => v.min)),
    max: Math.max(...list.map((v) => v.max)),
    p50: median(list.map((v) => v.p50)),
  };
}

/**
 * Pools samples across blocks and recomputes headline stats, keeping each
 * block's median, calibration rate, and within-block spread so between-run
 * variance and per-process noise both stay observable. Counters and debug
 * come from the pilot.
 */
function mergeStats(list: Stats[], calibrationRates: number[]): Stats {
  let total = 0;
  for (const s of list) total += s.samples.length;
  const pooled = new Float64Array(total);
  for (let i = 0, offset = 0; i < list.length; offset += list[i++].samples.length) {
    pooled.set(list[i].samples, offset);
  }
  const samples = Array.from(pooled.sort());
  const heaps = list.map((s) => s.heap).filter(Boolean) as NonNullable<Stats['heap']>[];
  const gcs = list.map((s) => s.gc).filter((gc) => gc && 'total' in gc) as GcStats[];
  const medians = list.map((s) => s.p50);
  const vrams = list.flatMap((s) => (s.vram === undefined ? [] : [s.vram]));

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
    ...(heaps.length === list.length ? { heap: mergeRange(heaps) } : {}),
    ...(gcs.length === list.length ? { gc: mergeGc(gcs) } : {}),
    ...(vrams.length === list.length
      ? {
          vram: {
            resident: median(vrams.map((v) => v.resident)),
            perPass: median(vrams.map((v) => v.perPass)),
          },
        }
      : {}),
    ...(list.some((stats) => stats.optimization)
      ? {
          optimization: {
            ...(list.every((stats) => stats.optimization?.mode === list[0].optimization?.mode)
              ? { mode: list[0].optimization?.mode }
              : {}),
            ...(list[0].optimization?.natural ? { natural: list[0].optimization.natural } : {}),
            ...(list.some((stats) => stats.optimization?.benchmark)
              ? { benchmark: list.flatMap((stats) => stats.optimization?.benchmark ?? [null]) }
              : {}),
            ...(list.some((stats) => stats.optimization?.benchmarkEnd)
              ? { benchmarkEnd: list.flatMap((stats) => stats.optimization?.benchmarkEnd ?? [null]) }
              : {}),
            ...(list.every((s) => s.optimization?.target === 'TurboFan')
              ? { target: 'TurboFan' as const }
              : {}),
            ...(list.some((s) => s.optimization?.deoptimized)
              ? { deoptimized: list.flatMap((s) => s.optimization?.deoptimized ?? [null]) }
              : {}),
            workload: list.flatMap((stats) => stats.optimization?.workload ?? [null]),
            ...(list.some((stats) => stats.optimization?.harness)
              ? {
                  harness: list.flatMap((stats) => stats.optimization?.harness ?? [null]),
                }
              : {}),
          },
        }
      : {}),
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
      const stats = survivors.map((p) => p.trial.runs[j]!.stats!) as Stats[];
      return {
        ...run,
        stats: {
          ...mergeStats(
            stats,
            survivors.map((p) => p.calibrationRate)
          ),
          // A majority keeps one disturbed block from marking the bench
          unsettled: stats.filter((s) => s.unsettled).length > stats.length / 2,
          varyingOutput: snapshots.size > 1,
          ...mergeWarmup(stats),
        },
      };
    }),
  };
}

/** Median warmup settle time across the blocks that settled. */
function mergeWarmup(stats: Stats[]): Pick<Stats, 'warmup'> {
  const warmups = stats.flatMap((s) => (s.warmup ? [s.warmup] : [])).sort((a, b) => a.time - b.time);
  return warmups.length
    ? {
        warmup: {
          ...warmups[warmups.length >> 1],
          ...(warmups.length < stats.length
            ? { blocks: { settled: warmups.length, total: stats.length } }
            : {}),
        },
      }
    : {};
}

/**
 * Runs every bench as `blocks` fresh child processes. Block 0 is the pilot:
 * it samples until the block budget and sample floor are both met, and its
 * measurement plan freezes the remaining blocks. Blocks are scheduled round
 * robin across benches so each bench's blocks span the whole sitting and
 * between-block spread samples real environment drift, not just adjacent
 * seconds.
 */
function makeBlockExecutor(
  blocks: number,
  runTrial: (index: number, plans?: BlockPlan[], observeGc?: boolean) => Promise<BlockResult>
) {
  return async (jobs: BlockJob[]): Promise<Map<number, Trial>> => {
    const collected = new Map<number, Array<{ trial: Trial; calibrationRate: number }>>();
    const plans = new Map<number, BlockPlan[]>();
    emit({
      type: 'start',
      blocks,
      benches: jobs,
    });

    for (let block = 0; block < blocks; block++) {
      for (const { index, gc } of jobs) {
        // A pilot without a full set of plans (errored runs) is not replayable
        if (block > 0 && !plans.has(index)) continue;
        await takeTurn();
        emit({ type: 'bench', index, block });
        const started = performance.now();
        const out = await runTrial(index, block === 0 ? undefined : plans.get(index), gc);
        const runs = out.trial.runs;
        const failed = runs.find((run) => run.error !== undefined);
        emit({
          type: 'block',
          index,
          block,
          duration: performance.now() - started,
          ...(runs.length === 1 && runs[0].stats ? { median: runs[0].stats.p50 } : {}),
          ...(failed
            ? { error: String((failed.error as { message?: unknown })?.message ?? failed.error) }
            : {}),
        });
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
  await takeTurn();
  // Interleaved workers share one terminal, so each names its tree before its
  // first line of output.
  let label = process.env.LABS_LABEL;
  const print = (s: unknown) => {
    if (label) _print(label);
    label = undefined;
    _print(s);
  };
  let result: Awaited<ReturnType<typeof runBrowser>>;
  const runtime = process.env.LABS_RUNTIME;
  if (runtime === 'chrome' || runtime === 'firefox' || runtime === 'webkit') {
    const { runBrowser } = await import('../browser-runner.ts');
    result = await runBrowser({
      file: file!,
      runtime,
      tune: parseTuneEnv(),
      grepTags: process.env.LABS_GREP_TAGS,
      launch: process.env.LABS_BROWSER ? JSON.parse(process.env.LABS_BROWSER) : undefined,
      snapshotTolerance:
        process.env.LABS_SNAPSHOT_TOLERANCE === undefined
          ? undefined
          : Number(process.env.LABS_SNAPSHOT_TOLERANCE),
      execute: (jobs, runTrial) => makeBlockExecutor(blockCount(), runTrial)(jobs),
      beforeDiagnostics: () => takeTurn('diagnostics'),
    });
    if (!progress) {
      renderReport(
        result.context,
        { print, colors: colors() },
        result.layout.map((collection, index) => ({
          ...collection,
          trials: result.benchmarks
            .filter((trial) => trial.group === index)
            .map((bench) => ({
              bench,
              gcMode: bench.gcMode,
              compact: bench.style.compact,
              highlight: bench.style.highlight,
            })),
        }))
      );
    }
  } else {
    await import(file!);
    const registry = getBenchRegistry();
    const execute = makeBlockExecutor(blockCount(), async (index, plans, observeGc) =>
      runTrialChild(
        { _name: registry[index]?.alias },
        index,
        plans ? { LABS_BLOCK_PLANS: JSON.stringify(plans) } : {},
        observeGc
      )
    );
    const measured = await run({
      tune: parseTuneEnv(),
      execute: (jobs: Array<{ trial: any; index: number }>) =>
        execute(
          jobs.map(({ trial, index }) => ({
            index,
            name: trial._name || 'anonymous',
            group: registry[index]?.groupName ?? '',
            cases: [...trial._names()].length,
            gc: trial._gc !== false,
            gpu: trial._gpu,
          }))
        ),
      print: progress ? () => {} : print,
    });
    const postFreq = await calibrateFreq();
    for (let i = 0; i < measured.benchmarks.length; i++) {
      Object.assign(measured.benchmarks[i], { groupName: registry[i]?.groupName ?? '' });
    }
    result = { ...measured, environment: { postFreq } };
  }

  if (process.env.LABS_RESULT_FILE) {
    writeFileSync(process.env.LABS_RESULT_FILE, JSON.stringify(result, errorReplacer));
  }
}

const onlyIndex = process.env.LABS_ONLY_INDEX;
void (onlyIndex !== undefined ? childMain(Number(onlyIndex)) : main()).catch((error: unknown) => {
  if (!process.send || !(error instanceof RuntimeLaunchError)) {
    console.error(error instanceof RuntimeLaunchError ? error.message : error);
  }
  if (process.send) {
    process.send(
      { type: 'labs:error', message: error instanceof Error ? error.message : String(error) },
      () => process.exit(1)
    );
  } else process.exit(1);
});
