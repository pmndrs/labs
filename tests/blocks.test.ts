import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { measure } from '../src/bench/index.ts';
import { compare, printCompareReport } from '../src/compare.ts';
import { defineConfig } from '../src/config.ts';
import { mannWhitneyU, minDetectableEffect, relativeSpread } from '../src/stats.ts';
import type { SavedResult } from '../src/store.ts';

const fast = { min_cpu_time: 1, min_samples: 12 } as const;
const CONFIG = defineConfig({ benchDir: '.' });

function syntheticStats(blockMedians: number[], freq = 4, perBlock = 40) {
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
    blocks: {
      medians: blockMedians,
      freqs: blockMedians.map(() => freq),
      spreads: blockMedians.map(() => 0.01),
    },
  };
}

function syntheticResult(
  name: string,
  blockMedians: number[],
  opts: { legacy?: boolean; freq?: number } = {}
): SavedResult {
  const stats = syntheticStats(blockMedians, opts.freq ?? 4);
  if (opts.legacy) delete (stats as any).blocks;
  return {
    name,
    timestamp: '2026-01-01T00:00:00.000Z',
    hardware: { cpu: 'test-cpu', arch: 'test', runtime: 'node', freq: 4 },
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

describe('fresh-run statistics', () => {
  it('reports zero spread for identical or single-run medians', () => {
    expect(relativeSpread([100, 100, 100])).toBe(0);
    expect(relativeSpread([100])).toBe(0);
  });

  it('scales spread with fresh-run median dispersion', () => {
    const tight = relativeSpread([99, 100, 101, 100]);
    const wide = relativeSpread([80, 100, 120, 100]);

    expect(tight).toBeGreaterThan(0);
    expect(wide).toBeGreaterThan(tight);
  });

  it('derives a detectable-effect floor from spread and fresh-run count', () => {
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

  it('reports p50 and delta from the block medians used for the verdict', () => {
    const aMedians = [90, 91, 92, 93, 94, 95, 96, 97];
    const bMedians = [96.1, 97.1, 98.1, 99.1, 100.1, 101.1, 102.1, 103.1];
    const a = syntheticResult('a', aMedians);
    const b = syntheticResult('b', bMedians);
    const aStats = a.files[0].benchmarks[0].runs[0].stats!;
    const bStats = b.files[0].benchmarks[0].runs[0].stats!;

    // These skewed inner samples make the pooled p50 move slightly faster,
    // opposite to the independently replicated block-median effect.
    aStats.samples = aMedians
      .flatMap((m) => [...Array(11).fill(m), ...Array(9).fill(1_000)])
      .sort((x, y) => x - y);
    bStats.samples = bMedians
      .flatMap((m) => [...Array(9).fill(50), ...Array(11).fill(m)])
      .sort((x, y) => x - y);

    const bench = compare(a, b, CONFIG).benches[0];
    expect(bench.kind).toBe('eligible');
    if (bench.kind === 'eligible') {
      expect(bench.verdict).toBe('slower');
      expect(bench.baselineP50).toBe(93.5);
      expect(bench.candidateP50).toBeCloseTo(99.6, 10);
      expect(bench.deltaP50).toBeGreaterThan(0.05);
    }
  });

  it('skips clock-confounded verdicts when calibration normalization changes the verdict', () => {
    // The candidate is slower in wall time purely because its blocks ran at a
    // lower calibration rate: normalized timings are identical
    const aMedians = [100, 100.4, 99.7, 100.2, 99.9, 100.1, 99.8, 100.3];
    const bMedians = aMedians.map((m) => m * (4.0 / 3.5));
    const a = syntheticResult('a', aMedians);
    const b = syntheticResult('b', bMedians, { freq: 3.5 });

    const bench = compare(a, b, CONFIG).benches[0];
    expect(bench.kind).toBe('skipped');
    if (bench.kind === 'skipped') expect(bench.reason).toContain('clock-confounded');
  });

  it('renders clock-confounded skips as a compact table', () => {
    const aMedians = [100, 100.4, 99.7, 100.2, 99.9, 100.1, 99.8, 100.3];
    const bMedians = aMedians.map((m) => m * (4.0 / 3.5));
    const result = compare(
      syntheticResult('a', aMedians),
      syntheticResult('b', bMedians, { freq: 3.5 }),
      CONFIG
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let lines: string[] = [];

    try {
      printCompareReport(result, CONFIG);
      lines = log.mock.calls.map(([line]) => stripVTControlCharacters(String(line)));
    } finally {
      log.mockRestore();
    }

    expect(lines).toContain('  clock-confounded');
    expect(lines).toContain('  · unit              slower→neutral · 4.00→3.50');
  });

  it('keeps verdicts when clocks are effectively equal despite probe jitter', () => {
    // A real 6% regression with a candidate clock only ~1% lower: judged in
    // normalization shrinks the shift below minDelta, but a 1% rate difference is
    // within probe jitter, so the cross-check must stay inert instead of
    // eating the verdict
    const aMedians = [100, 100.4, 99.7, 100.2, 99.9, 100.1, 99.8, 100.3];
    const bMedians = aMedians.map((m) => m * 1.06);
    const a = syntheticResult('a', aMedians);
    const b = syntheticResult('b', bMedians, { freq: 3.96 });

    const bench = compare(a, b, CONFIG).benches[0];
    expect(bench.kind).toBe('eligible');
    if (bench.kind === 'eligible') expect(bench.verdict).toBe('slower');
  });

  it('allows four blocks at alpha 0.05 but respects stricter alpha', () => {
    const aMedians = [99.8, 100, 100.2, 100.4];
    const bMedians = aMedians.map((m) => m * 1.2);
    const a = syntheticResult('a', aMedians);
    const b = syntheticResult('b', bMedians);

    const defaultBench = compare(a, b, CONFIG).benches[0];
    expect(defaultBench.kind).toBe('eligible');
    if (defaultBench.kind === 'eligible') expect(defaultBench.verdict).toBe('slower');

    const strictBench = compare(a, b, defineConfig({ benchDir: '.', alpha: 0.01 })).benches[0];
    expect(strictBench.kind).toBe('skipped');
    if (strictBench.kind === 'skipped') {
      expect(strictBench.reason).toContain('cannot reach α=0.01');
    }
  });

  it('judges large effects despite limited resolution and reports that resolution', () => {
    // ~6% fresh-run spread cannot resolve minDelta=5%, but a 50% shift
    // with fully separated blocks is unambiguous: the bench keeps its verdict
    // and carries its resolution for the report's limited-resolution annotation
    const aMedians = [100, 92, 108, 95, 105, 90, 110, 99];
    const bMedians = aMedians.map((m) => m * 1.5);

    const bench = compare(syntheticResult('a', aMedians), syntheticResult('b', bMedians), CONFIG)
      .benches[0];
    expect(bench.kind).toBe('eligible');
    if (bench.kind === 'eligible') {
      expect(bench.verdict).toBe('slower');
      expect(bench.comparisonResolution).toBeGreaterThan(CONFIG.minDelta);
    }
  });

  it('right-aligns limited resolution beneath the confidence interval', () => {
    const aMedians = [100, 92, 108, 95, 105, 90, 110, 99];
    const bMedians = aMedians.map((m) => m * 1.5);
    const result = compare(syntheticResult('a', aMedians), syntheticResult('b', bMedians), CONFIG);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let lines: string[] = [];

    try {
      printCompareReport(result, CONFIG);
      lines = log.mock.calls.map(([line]) => stripVTControlCharacters(String(line)));
    } finally {
      log.mockRestore();
    }

    const header = lines.find((line) => line.includes('Δ 95% CI'));
    const warningIndex = lines.findIndex((line) => line.includes('⚠ ~±'));
    const warning = lines[warningIndex];

    expect(header).toBeDefined();
    expect(warning).toBeDefined();
    expect(lines[warningIndex - 1]).toContain('unit');
    expect(warning).toHaveLength(header!.length);
    expect(warning).toMatch(/⚠ ~±\d+%$/);
    expect(lines).toContain(
      '⚠ Limited resolution: Neutral results are inconclusive at the shown resolution.'
    );
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
          LABS_BLOCK_TIME: '1',
          LABS_MIN_SAMPLES: '12',
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
      expect(stats.blocks.spreads).toHaveLength(3);
      // The pilot plan honours the 12 sample floor per block, pooled across 3 blocks
      expect(stats.plan.samples).toBe(12);
      expect(stats.samples).toHaveLength(36);
    }
    expect(result.benchmarks[0].runs[0].stats.snapshot).toBe(499500);
  });

  it('never runs fewer than two blocks', { timeout: 60_000 }, () => {
    const result = runWorker({});

    for (const trial of result.benchmarks) {
      expect(trial.runs[0].stats.blocks.medians).toHaveLength(2);
    }
  });

  function toSavedResult(name: string, workerResult: any): SavedResult {
    return {
      name,
      timestamp: '2026-01-01T00:00:00.000Z',
      hardware: { cpu: 'test-cpu', arch: 'test', runtime: 'node', freq: 4 },
      blocks: 5,
      files: [{ file: 'blocks.bench.ts', benchmarks: workerResult.benchmarks }],
      environment: { freqs: [] },
    } as SavedResult;
  }

  it('judges two blocked runs of the same code as neutral', { timeout: 120_000, retry: 2 }, () => {
    const env = { LABS_BLOCKS: '5' };
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
