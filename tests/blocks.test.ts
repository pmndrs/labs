import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { measure } from '../src/bench/index.ts';
import { blockSpread, classify, minDetectableEffect } from '../src/stats.ts';

const fast = { min_cpu_time: 1, min_samples: 12, adaptive: false } as const;

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

  it('judges two blocked runs of the same code as neutral', { timeout: 120_000, retry: 2 }, () => {
    const a = runWorker({ LABS_BLOCKS: '3' });
    const b = runWorker({ LABS_BLOCKS: '3' });

    const { verdict } = classify(
      a.benchmarks[0].runs[0].stats.samples,
      b.benchmarks[0].runs[0].stats.samples
    );

    expect(verdict).toBe('neutral');
  });
});
