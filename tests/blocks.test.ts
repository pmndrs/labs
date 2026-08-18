import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { measure } from '../src/bench/index.ts';
import { compare } from '../src/compare.ts';
import { defineConfig } from '../src/config.ts';
import { blockSpread, mannWhitneyU, minDetectableEffect } from '../src/stats.ts';
import type { SavedResult } from '../src/store.ts';

const fast = { min_cpu_time: 1, min_samples: 12, adaptive: false } as const;
const CONFIG = defineConfig({ benchDir: '.' });

function syntheticStats(blockMedians: number[], perBlock = 40) {
  const samples: number[] = [];
  for (const m of blockMedians) {
    for (let i = 0; i < perBlock; i++) samples.push(m + ((i % 5) - 2) * 0.01);
  }
  samples.sort((a, b) => a - b);
  const q = (p: number) => samples[(p * (samples.length - 1)) | 0];
  return {
    kind: 'fn' as const,
    samples,
    min: samples[0],
    max: samples[samples.length - 1],
    avg: samples.reduce((a, v) => a + v, 0) / samples.length,
    p25: q(0.25),
    p75: q(0.75),
    p99: q(0.99),
    noisy: false,
    blocks: { medians: blockMedians, freqs: blockMedians.map(() => 4) },
  };
}

function syntheticResult(
  name: string,
  blockMedians: number[],
  opts: { legacy?: boolean } = {}
): SavedResult {
  const stats = syntheticStats(blockMedians);
  if (opts.legacy) delete (stats as any).blocks;
  return {
    name,
    timestamp: '2026-01-01T00:00:00.000Z',
    hardware: { cpu: 'test-cpu', arch: 'test', runtime: 'node', freq: 4 },
    isolation: 'bench',
    ...(opts.legacy ? {} : { blocks: blockMedians.length }),
    files: [
      {
        file: 'synthetic.bench.ts',
        benchmarks: [
          {
            alias: 'unit',
            group: 0,
            baseline: false,
            gcMode: true,
            kind: 'static',
            style: { compact: false, highlight: false },
            runs: [{ name: 'unit', args: {}, stats }],
          },
        ],
      },
    ],
    environment: { freqs: [] },
  } as SavedResult;
}

describe('measurement plans', () => {
  it('reports the plan a measurement decided on', async () => {
    const stats = await measure(() => 1 + 1, fast);

    expect(stats.plan?.batch).toBe(true);
    expect(stats.plan?.batch_samples).toBeGreaterThan(0);
    expect(stats.plan?.samples).toBeGreaterThanOrEqual(12);
  });

  it('replays a frozen plan exactly', async () => {
    const stats = await measure(() => 1 + 1, {
      batch: false,
      batch_samples: 4096,
      batch_unroll: 4,
      min_samples: 20,
      max_samples: 20,
      min_cpu_time: 0,
      adaptive: false,
    });

    expect(stats.plan).toMatchObject({ batch: false, samples: 20 });
    // 20 raw samples exceed the trim threshold so 2 are dropped from each tail
    expect(stats.samples.length).toBe(16);
  });

  it('forces batching on when the plan says so', async () => {
    const stats = await measure(() => 1 + 1, { ...fast, batch: true });

    expect(stats.plan?.batch).toBe(true);
    expect(stats.ticks).toBeGreaterThan(stats.samples.length);
  });
});

describe('between-block statistics', () => {
  it('reports zero spread for identical or single-block medians', () => {
    expect(blockSpread([100, 100, 100])).toBe(0);
    expect(blockSpread([100])).toBe(0);
  });

  it('scales spread with block median dispersion', () => {
    const tight = blockSpread([99, 100, 101, 100]);
    const wide = blockSpread([80, 100, 120, 100]);

    expect(tight).toBeGreaterThan(0);
    expect(wide).toBeGreaterThan(tight);
  });

  it('derives a detectable-effect floor from spread and block count', () => {
    expect(minDetectableEffect(0.02, 8)).toBeCloseTo(0.028, 5);
    expect(minDetectableEffect(0.02, 16)).toBeLessThan(minDetectableEffect(0.02, 8));
    expect(minDetectableEffect(0.02, 1)).toBe(0);
    expect(minDetectableEffect(0, 8)).toBe(0);
  });
});

describe('comparing blocked results', () => {
  it('tests block medians, not pooled samples', () => {
    // Overlapping block medians with a 6% shift: no independent replication
    // supports a verdict, but the pooled inner samples look wildly separated
    const aMedians = [100, 92, 108, 95, 105, 90, 110, 99];
    const bMedians = aMedians.map((m) => m * 1.06);
    const a = syntheticResult('a', aMedians);
    const b = syntheticResult('b', bMedians);

    const pooledP = mannWhitneyU(
      a.files[0].benchmarks[0].runs[0].stats!.samples,
      b.files[0].benchmarks[0].runs[0].stats!.samples
    ).p;
    expect(pooledP).toBeLessThan(1e-6);

    const bench = compare(a, b, CONFIG).benches[0];
    expect(bench.kind).toBe('eligible');
    if (bench.kind === 'eligible') {
      expect(bench.p).toBeGreaterThan(0.05);
      expect(bench.verdict).toBe('neutral');
    }
  });

  it('flags real shifts that block replication does support', () => {
    const aMedians = [100, 100.4, 99.7, 100.2, 99.9, 100.1, 99.8, 100.3];
    const bMedians = aMedians.map((m) => m * 1.2);

    const bench = compare(syntheticResult('a', aMedians), syntheticResult('b', bMedians), CONFIG)
      .benches[0];
    expect(bench.kind).toBe('eligible');
    if (bench.kind === 'eligible') expect(bench.verdict).toBe('slower');
  });

  it('skips benches without block replication instead of judging them', () => {
    const medians = [100, 101, 99, 100, 100, 101, 99, 100];
    const legacy = syntheticResult('old', medians, { legacy: true });
    const fresh = syntheticResult('new', medians);

    const result = compare(legacy, fresh, CONFIG);
    expect(result.benches[0].kind).toBe('skipped');
    if (result.benches[0].kind === 'skipped') {
      expect(result.benches[0].reason).toContain('block replication');
    }
    expect(result.environmentWarnings.some((w) => w.includes('block counts'))).toBe(true);
  });
});

describe('worker blocked sampling', () => {
  const WORKER = fileURLToPath(new URL('../src/worker.ts', import.meta.url));
  const FIXTURE = fileURLToPath(new URL('./fixtures/blocks.bench.ts', import.meta.url));
  const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  let spawnCount = 0;

  function runWorker(env: Record<string, string>) {
    const resultFile = join(tmpdir(), `labs-blocks-test-${process.pid}-${spawnCount++}.json`);
    try {
      execFileSync(process.execPath, ['--import', TSX, WORKER], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          LABS_BENCH_FILE: pathToFileURL(FIXTURE).href,
          LABS_RESULT_FILE: resultFile,
          LABS_MIN_CPU_TIME: '1',
          LABS_MIN_SAMPLES: '12',
          LABS_ADAPTIVE: 'false',
          ...env,
        },
      });
      return JSON.parse(readFileSync(resultFile, 'utf-8'));
    } finally {
      rmSync(resultFile, { force: true });
    }
  }

  it('runs each bench as N fresh blocks and pools the samples', { timeout: 60_000 }, () => {
    const result = runWorker({ LABS_BLOCKS: '3' });

    expect(result.benchmarks).toHaveLength(2);
    for (const trial of result.benchmarks) {
      const stats = trial.runs[0].stats;
      expect(trial.runs[0].error).toBeUndefined();
      expect(stats.blocks.medians).toHaveLength(3);
      expect(stats.blocks.freqs).toHaveLength(3);
      expect(stats.blocks.freqs.every((f: number) => f > 0)).toBe(true);
      // The pilot plan fixes 12 samples per block, pooled across 3 blocks
      expect(stats.plan.samples).toBe(12);
      expect(stats.samples).toHaveLength(36);
    }
  });

  it('keeps single-block runs identical to unblocked sampling', { timeout: 60_000 }, () => {
    const result = runWorker({});

    for (const trial of result.benchmarks) {
      expect(trial.runs[0].stats.blocks).toBeUndefined();
      expect(trial.runs[0].stats.samples.length).toBeGreaterThan(0);
    }
  });

  function toSavedResult(name: string, workerResult: any): SavedResult {
    return {
      name,
      timestamp: '2026-01-01T00:00:00.000Z',
      hardware: { cpu: 'test-cpu', arch: 'test', runtime: 'node', freq: 4 },
      isolation: 'bench',
      blocks: 5,
      files: [{ file: 'blocks.bench.ts', benchmarks: workerResult.benchmarks }],
      environment: { freqs: [] },
    } as SavedResult;
  }

  it('judges two blocked runs of the same code as neutral', { timeout: 120_000, retry: 2 }, () => {
    // A wide noisy threshold keeps the machine-floor flag out of the way so
    // the A/A assertion exercises the verdict path itself
    const env = { LABS_BLOCKS: '5', LABS_MIN_DELTA: '0.5' };
    const a = runWorker(env);
    const b = runWorker(env);

    const result = compare(toSavedResult('a', a), toSavedResult('b', b), CONFIG);
    const eligible = result.benches.filter((bench) => bench.kind === 'eligible');

    expect(eligible).toHaveLength(2);
    for (const bench of eligible) {
      if (bench.kind === 'eligible') expect(bench.verdict).toBe('neutral');
    }
  });
});
