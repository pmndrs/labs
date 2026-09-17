import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { assert, AssertionError } from '../src/assert.ts';
import { B, measure } from '../src/bench/index.ts';
import { serialize, snapshotsDiffer, toSnapshot } from '../src/bench/lib/snapshot.ts';
import { type Snapshot, type Stats, isAssertionError } from '../src/bench/types.ts';
import { compare, printCompareReport } from '../src/compare.ts';
import { defineConfig } from '../src/config.ts';
import type { SavedResult } from '../src/store.ts';

const fast = { min_cpu_time: 1, min_samples: 12 } as const;
const CONFIG = defineConfig({ benchDir: '.' });

describe('stable serialization', () => {
  it('ignores object key and collection insertion order', () => {
    expect(serialize({ a: 1, b: [2, { c: 3 }] })).toBe(serialize({ b: [2, { c: 3 }], a: 1 }));
    expect(
      serialize(
        new Map([
          [1, 'a'],
          [2, 'b'],
        ])
      )
    ).toBe(
      serialize(
        new Map([
          [2, 'b'],
          [1, 'a'],
        ])
      )
    );
    expect(serialize(new Set([1, 2]))).toBe(serialize(new Set([2, 1])));
  });

  it('keeps distinct values distinct', () => {
    class Point {
      x = 1;
    }

    expect(serialize([1, 2])).not.toBe(serialize([2, 1]));
    expect(serialize({ x: 1 })).not.toBe(serialize(new Point()));
    expect(serialize(new Float32Array([1]))).not.toBe(serialize(new Uint8Array([1])));
    expect(serialize('1')).not.toBe(serialize(1));
    expect(serialize(1n)).not.toBe(serialize(1));
    expect(serialize([])).not.toBe(serialize(Array(1)));
  });

  it('rejects circular structures instead of looping', () => {
    const loop: any = {};
    loop.self = loop;
    expect(() => serialize(loop)).toThrow('circular');
  });

  it('keeps numeric outputs as values and digests everything else', () => {
    expect(toSnapshot({ a: [1, 2, 3] })).toBe(toSnapshot({ a: [1, 2, 3] }));
    expect(toSnapshot({ a: [1, 2, 3] })).not.toBe(toSnapshot({ a: [1, 2, 4] }));
    expect(toSnapshot(499500)).toBe(499500);
    expect(toSnapshot([[1, 2], new Float32Array([0.5])])).toEqual([[1, 2], [0.5]]);
    expect(toSnapshot({ x: 1 })).toMatch(/^[0-9a-f]{16}$/);
    expect(toSnapshot([1, 'a'])).toMatch(/^[0-9a-f]{16}$/);
    expect(toSnapshot(Array.from({ length: 20_000 }, () => 0))).toMatch(/^[0-9a-f]{16}$/);
  });

  it('spells out non-finite numbers so they survive JSON', () => {
    const saved = JSON.parse(JSON.stringify(toSnapshot([1, NaN, Infinity, -Infinity])));
    expect(saved).toEqual([1, 'NaN', 'Infinity', '-Infinity']);
    expect(snapshotsDiffer(saved, toSnapshot([1, NaN, Infinity, -Infinity]), 1e-9)).toBe(false);
    expect(snapshotsDiffer(saved, toSnapshot([1, NaN, -Infinity, -Infinity]), 1e-9)).toBe(true);
    expect(snapshotsDiffer(toSnapshot(Infinity), toSnapshot(1e308), 1e-9)).toBe(true);
  });

  it('compares numeric snapshots with a tolerance and digests exactly', () => {
    expect(snapshotsDiffer([1, [2, 3.0000000001]], [1, [2, 3]], 1e-9)).toBe(false);
    expect(snapshotsDiffer([1, [2, 3.001]], [1, [2, 3]], 1e-9)).toBe(true);
    expect(snapshotsDiffer(1e12, 1e12 + 1, 1e-9)).toBe(false);
    expect(snapshotsDiffer('NaN', 'NaN', 0)).toBe(false);
    expect(snapshotsDiffer([1, 2], [1, 2, 3], 1e-9)).toBe(true);
    expect(snapshotsDiffer([1], 1, 1e-9)).toBe(true);
    expect(snapshotsDiffer('abcd', 'abce', 1e-9)).toBe(true);
    expect(snapshotsDiffer('abcd', [1], 1e-9)).toBe(true);
  });
});

describe('assert', () => {
  it('passes silently and fails with a recognizable error', () => {
    expect(() => assert(true)).not.toThrow();
    expect(() => assert.equal({ a: [1] }, { a: [1] })).not.toThrow();

    expect(() => assert(false, 'nope')).toThrow(AssertionError);
    expect(() => assert.equal([1, 2], [1, 3])).toThrow('expected [1,3] but got [1,2]');

    try {
      assert(0);
    } catch (error) {
      expect(isAssertionError(error)).toBe(true);
      expect((error as Error).name).toBe('AssertionError');
    }
  });

  it('recognizes assertion errors from other libraries by name', () => {
    expect(isAssertionError({ name: 'AssertionError', message: 'x' })).toBe(true);
    expect(isAssertionError(new Error('x'))).toBe(false);
  });
});

describe('checking results', () => {
  it('hands the first untimed result back to the generator', async () => {
    let calls = 0;
    let seen: unknown;

    const stats = await measure(function* () {
      seen = yield () => ++calls;
    }, fast);

    expect(seen).toBe(1);
    expect(calls).toBeGreaterThan(1);
    expect(stats.snapshot).toBeUndefined();
  });

  it('snapshots the generator return value', async () => {
    const stats = await measure(function* () {
      const out = yield () => [3, 1, 2].toSorted((a, b) => a - b);
      return out;
    }, fast);

    expect(stats.snapshot).toEqual([1, 2, 3]);
  });

  it('snapshots mutated state after exactly one call', async () => {
    const stats = await measure(
      function* () {
        const state = { count: 0 };
        yield {
          bench: () => {
            state.count++;
          },
          snapshot: () => state.count,
        };
      },
      { ...fast }
    );

    expect(stats.snapshot).toBe(1);
  });

  it('rejects a snapshot hook that returns nothing', async () => {
    const empty = await new B('void', function* () {
      yield { bench: () => {}, snapshot: () => {} };
    }).run(false, fast);

    expect(empty.runs[0].stats).toBeUndefined();
    expect((empty.runs[0].error as Error).message).toContain('expected a value to snapshot');
  });

  it('digests non-numeric returns', async () => {
    const stats = await measure(function* () {
      yield () => 1;
      return { ok: true };
    }, fast);

    expect(stats.snapshot).toBe(toSnapshot({ ok: true }));
    expect(stats.snapshot).toMatch(/^[0-9a-f]{16}$/);
  });

  it('refuses two snapshot sources on one bench', async () => {
    await expect(
      measure(function* () {
        yield { bench: () => 1, snapshot: () => 1 };
        return 1;
      }, fast)
    ).rejects.toThrow('one snapshot source');
  });

  it('gives manual-timing benches nothing to snapshot', async () => {
    let seen: unknown = 'unset';

    const stats = await measure(
      function* () {
        seen = yield { budget: 'manual', manual: () => 1 };
      },
      { ...fast, min_samples: 2, max_samples: 3 }
    );

    expect(seen).toBeUndefined();
    expect(stats.snapshot).toBeUndefined();
  });

  it('records a failed check as an assertion error with no stats', async () => {
    const trial = await new B('wrong', function* () {
      const out = yield () => 1 + 1;
      assert.equal(out, 3);
    }).run(false, fast);

    expect(trial.runs[0].stats).toBeUndefined();
    expect(isAssertionError(trial.runs[0].error)).toBe(true);
  });
});

function syntheticResult(
  name: string,
  opts: {
    snapshot?: Snapshot;
    error?: unknown;
    gc?: number;
    heap?: number;
    metrics?: Stats['metrics'];
  } = {}
): SavedResult {
  const medians = [100, 100.4, 99.7, 100.2, 99.9, 100.1, 99.8, 100.3];
  const samples = medians.flatMap((m) => [m - 0.01, m, m + 0.01]).sort((a, b) => a - b);
  const stats = {
    kind: 'fn' as const,
    samples,
    min: samples[0],
    max: samples[samples.length - 1],
    avg: 100,
    p25: 99.9,
    p75: 100.2,
    p99: 100.4,
    ...(opts.snapshot !== undefined ? { snapshot: opts.snapshot } : {}),
    ...(opts.gc !== undefined ? { gc: { min: opts.gc, max: opts.gc, p50: opts.gc } } : {}),
    ...(opts.heap !== undefined ? { heap: { min: opts.heap, max: opts.heap, p50: opts.heap } } : {}),
    ...(opts.metrics ? { metrics: opts.metrics } : {}),
    blocks: { medians, freqs: medians.map(() => 4) },
  };
  return {
    name,
    timestamp: '2026-01-01T00:00:00.000Z',
    hardware: { cpu: 'test-cpu', arch: 'test', runtime: 'node', freq: 4 },
    blocks: medians.length,
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
            runs: [
              opts.error !== undefined
                ? { name: 'unit', args: {}, error: opts.error }
                : { name: 'unit', args: {}, stats },
            ],
          },
        ],
      },
    ],
    environment: { freqs: [] },
  } as SavedResult;
}

function captureReport(result: ReturnType<typeof compare>): string[] {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    printCompareReport(result, CONFIG);
    return log.mock.calls.map(([line]) => stripVTControlCharacters(String(line)));
  } finally {
    log.mockRestore();
  }
}

describe('comparing outputs', () => {
  it('overrides the speed verdict when snapshots differ', () => {
    const result = compare(
      syntheticResult('a', { snapshot: 'aaaaaaaaaaaaaaaa' }),
      syntheticResult('b', { snapshot: 'bbbbbbbbbbbbbbbb' }),
      CONFIG
    );

    expect(result.benches[0].kind).toBe('changed');
    const lines = captureReport(result);
    expect(lines.some((line) => /^ {2}✗ unit .*output changed$/.test(line))).toBe(true);
    expect(lines.some((line) => line.trim().startsWith('summary  1 changed'))).toBe(true);
  });

  it('judges timing normally when snapshots agree or one side has none', () => {
    const same = compare(
      syntheticResult('a', { snapshot: 'aaaaaaaaaaaaaaaa' }),
      syntheticResult('b', { snapshot: 'aaaaaaaaaaaaaaaa' }),
      CONFIG
    );
    expect(same.benches[0].kind).toBe('eligible');

    const close = compare(
      syntheticResult('a', { snapshot: [0.1 + 0.2, 1e6] }),
      syntheticResult('b', { snapshot: [0.3, 1e6 + 1e-4] }),
      CONFIG
    );
    expect(close.benches[0].kind).toBe('eligible');

    const far = compare(
      syntheticResult('a', { snapshot: [0.3, 1e6] }),
      syntheticResult('b', { snapshot: [0.3, 1e6 + 1] }),
      CONFIG
    );
    expect(far.benches[0].kind).toBe('changed');

    const unchecked = compare(
      syntheticResult('a'),
      syntheticResult('b', { snapshot: 'bbbbbbbbbbbbbbbb' }),
      CONFIG
    );
    expect(unchecked.benches[0].kind).toBe('eligible');
  });

  it('lists candidate failures apart from crashes and skips errored baselines', () => {
    const failed = compare(
      syntheticResult('a'),
      syntheticResult('b', { error: { name: 'AssertionError', message: 'expected 3 but got 2' } }),
      CONFIG
    );
    expect(failed.benches[0]).toMatchObject({ kind: 'failed', check: true });
    const lines = captureReport(failed);
    expect(lines.map((line) => line.trim())).toContain('failed (1)');
    expect(lines.some((line) => line.includes('check failed: expected 3 but got 2'))).toBe(true);

    const crashed = compare(
      syntheticResult('a'),
      syntheticResult('b', { error: { name: 'Error', message: 'boom' } }),
      CONFIG
    );
    expect(crashed.benches[0]).toMatchObject({ kind: 'failed', check: false });

    const baseline = compare(
      syntheticResult('a', { error: { name: 'AssertionError', message: 'nope' } }),
      syntheticResult('b'),
      CONFIG
    );
    expect(baseline.benches[0]).toMatchObject({ kind: 'skipped' });
    if (baseline.benches[0].kind === 'skipped') {
      expect(baseline.benches[0].reason).toContain('baseline run failed its check');
    }
  });
});

describe('worker checks', () => {
  const WORKER = fileURLToPath(new URL('../src/worker.ts', import.meta.url));
  const FIXTURE = fileURLToPath(new URL('./fixtures/checks.bench.ts', import.meta.url));
  const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

  it('keeps failed checks and snapshots through the process boundary', { timeout: 60_000 }, () => {
    const resultFile = join(tmpdir(), `labs-checks-test-${process.pid}.json`);
    let result: any;
    try {
      execFileSync(process.execPath, ['--import', TSX, WORKER], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          LABS_BENCH_FILE: pathToFileURL(FIXTURE).href,
          LABS_RESULT_FILE: resultFile,
          LABS_BLOCK_TIME: '1',
          LABS_MIN_SAMPLES: '12',
        },
      });
      result = JSON.parse(readFileSync(resultFile, 'utf-8'));
    } finally {
      rmSync(resultFile, { force: true });
    }

    const [passes, fails, mutates] = result.benchmarks;
    expect(passes.runs[0].error).toBeUndefined();
    expect(passes.runs[0].stats.snapshot).toEqual([1, 2, 3]);
    expect(fails.runs[0].stats).toBeUndefined();
    expect(fails.runs[0].error.name).toBe('AssertionError');
    expect(fails.runs[0].error.message).toBe('expected 3 but got 2');
    expect(mutates.runs[0].stats.snapshot).toBe(1);
  });
});

describe('comparing memory', () => {
  const eligible = (result: ReturnType<typeof compare>) => {
    const bench = result.benches[0];
    if (bench.kind !== 'eligible') throw new Error(`expected eligible, got ${bench.kind}`);
    return bench;
  };

  it('reports custom metrics without changing the correctness or timing verdict', () => {
    const result = compare(
      syntheticResult('a', {
        snapshot: 1,
        metrics: {
          retainedBytes: { min: 100, max: 100, p50: 100 },
          zero: { min: 0, max: 0, p50: 0 },
          baselineOnly: { min: 1, max: 1, p50: 1 },
        },
      }),
      syntheticResult('b', {
        snapshot: 1,
        metrics: {
          retainedBytes: { min: 200, max: 200, p50: 200 },
          zero: { min: 1, max: 1, p50: 1 },
          candidateOnly: { min: 1, max: 1, p50: 1 },
        },
      }),
      CONFIG
    );
    const bench = eligible(result);
    expect(bench.verdict).toBe('neutral');
    expect(bench.metrics).toEqual({
      retainedBytes: { baseline: 100, candidate: 200, delta: 1 },
      zero: { baseline: 0, candidate: 1, delta: null },
    });
    const lines = captureReport(result);
    expect(lines.some((line) => line.includes('retainedBytes(200.00 +100.0%)'))).toBe(true);
    const metricLines = lines.filter((line) => /retainedBytes\(|zero\(/.test(line));
    expect(metricLines.some((line) => line.includes('zero(1.00 —)'))).toBe(true);
    expect(metricLines.every((line) => line.length <= 96)).toBe(true);
  });

  it('reports candidate gc and heap medians with their change from the baseline', () => {
    const result = compare(
      syntheticResult('a', { gc: 0, heap: 100 }),
      syntheticResult('b', { gc: 0, heap: 250 }),
      CONFIG
    );
    const bench = eligible(result);

    expect(bench.gc).toEqual({ baseline: 0, candidate: 0, delta: null });
    expect(bench.heap).toEqual({ baseline: 100, candidate: 250, delta: 1.5 });
    const lines = captureReport(result);
    expect(lines.some((line) => /gc\(0\.00ns —\) +heap\(250\.00 b \+150\.0%\)/.test(line))).toBe(
      true
    );
  });

  it('omits a metric either run did not record', () => {
    const result = compare(
      syntheticResult('a', { heap: 100 }),
      syntheticResult('b', { heap: 100, gc: 5 }),
      CONFIG
    );
    const bench = eligible(result);

    expect(bench.gc).toBeUndefined();
    expect(bench.heap).toEqual({ baseline: 100, candidate: 100, delta: 0 });
    const lines = captureReport(result);
    expect(lines.some((line) => line.includes('heap(100.00 b 0.0%)') && !line.includes('gc('))).toBe(
      true
    );
  });

  it('aligns graphs, gc, and heap across a 96-column table', () => {
    const result = compare(
      syntheticResult('a', { gc: 1_580_000, heap: 47_620_000 }),
      syntheticResult('b', { gc: 1_410_000, heap: 42_100_000 }),
      CONFIG
    );
    const bench = eligible(result);
    bench.key.name = 'rebuild entity relationships';
    bench.comparisonResolution = 0.1;
    const heapOnly = { ...bench, key: { ...bench.key, name: 'reuse existing entities' } };
    delete heapOnly.gc;
    result.benches.push(
      {
        ...bench,
        key: { ...bench.key, name: 'empty world' },
        gc: { baseline: 0, candidate: 0, delta: null },
      },
      heapOnly
    );

    const lines = captureReport(result);
    const header = lines.find((line) => line.includes('Δ 95% CI'))!;
    const rows = lines.filter((line) => /^  [▲▼■] /.test(line));
    const details = rows.map((row) => lines[lines.indexOf(row) + 1]);
    expect(header).toHaveLength(96);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('rebuild entity relationships');
    expect(rows.every((line) => line.length === 96)).toBe(true);
    expect(details.every((line) => line.length <= 96)).toBe(true);
    for (const line of details) {
      const graphs = [...line.matchAll(/[▁▂▃▄▅▆▇█]{10}/g)];
      expect(graphs).toHaveLength(2);
      expect(graphs[0].index + 10).toBe(header.indexOf('baseline') + 'baseline'.length);
      expect(graphs[1].index + 10).toBe(header.indexOf('candidate') + 'candidate'.length);
      expect(line.indexOf('heap(')).toBe(details[0].indexOf('heap('));
    }
    expect(details[1].indexOf('gc(')).toBe(details[0].indexOf('gc('));
    expect(details[2]).not.toContain('gc(');
    const warnings = lines.filter((line) => line.includes('⚠ ~±'));
    expect(warnings).toHaveLength(3);
    expect(warnings.every((line) => line.length === 96)).toBe(true);
  });

  it('expands the table for longer benchmark titles', () => {
    const result = compare(syntheticResult('a'), syntheticResult('b'), CONFIG);
    const bench = eligible(result);
    bench.key.name = 'rebuild entity relationships after removal';
    const lines = captureReport(result);

    expect(lines.find((line) => line.includes('Δ 95% CI'))).toHaveLength(
      96 + bench.key.name.length - 28
    );
    expect(lines.some((line) => line.includes(bench.key.name))).toBe(true);
  });
});
