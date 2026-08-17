import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBenchRegistry } from '../index.ts';
import { measure, run } from './index.ts';
import { runTrialAt } from './main.ts';
import type { Trial } from './types.ts';

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

async function calibrateFreq(): Promise<number> {
  const r = await measure(() => {}, { batch_unroll: 1 });
  return 1 / (r as any).avg;
}

/** Serializes Error instances the same way the `json` format does. */
function errorReplacer(_: string, v: any): any {
  if (!(v instanceof Error)) return v;
  return { message: String(v.message), stack: v.stack };
}

/** Measure one trial without calibration or rendering. */
async function childMain(index: number): Promise<void> {
  await import(file!);
  const trial = await runTrialAt(index, parseTuneEnv());
  writeFileSync(process.env.LABS_RESULT_FILE!, JSON.stringify({ trial }, errorReplacer));
}

/** Run a trial in a fresh process to isolate its JIT and heap state. */
function runTrialIsolated(trial: any, index: number): Trial {
  const resultFile = join(tmpdir(), `labs-trial-${process.pid}-${index}.json`);
  try {
    execFileSync(process.execPath, [...process.execArgv, process.argv[1]], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, LABS_ONLY_INDEX: String(index), LABS_RESULT_FILE: resultFile },
    });
    return JSON.parse(readFileSync(resultFile, 'utf-8')).trial;
  } catch (err) {
    throw new Error(`isolated bench "${trial?._name ?? index}" failed: ${String(err)}`, {
      cause: err,
    });
  } finally {
    rmSync(resultFile, { force: true });
  }
}

async function main(): Promise<void> {
  const isolate = process.env.LABS_ISOLATE !== 'false';
  await import(file!);
  const result = await run({
    tune: parseTuneEnv(),
    ...(isolate ? { run_trial: runTrialIsolated } : {}),
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
