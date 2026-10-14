import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance, PerformanceObserver, type PerformanceEntry } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { measure } from '../src/bench/index.ts';
import type { GcStats } from '../src/bench/types.ts';
import { trimStats } from '../src/store.ts';

describe('observed GC', () => {
  it.each([
    ['function', (work: () => void) => work],
    ['async function', (work: () => void) => async () => work()],
    [
      'iterator',
      (work: () => void) => (state: any) => {
        for (const _ of state) work();
      },
    ],
    [
      'async iterator',
      (work: () => void) => async (state: any) => {
        for await (const _ of state) work();
      },
    ],
  ] as const)('counts only sampling collections for a %s', async (_name, create) => {
    const stats = await measure(
      create(() => globalThis.gc!()),
      {
        sample_gc: true,
        warmup_samples: 0,
        batch: false,
        min_samples: 3,
        max_samples: 3,
        min_cpu_time: 0,
        heap: false,
      }
    );
    const gc = stats.gc as GcStats;
    expect(gc.count).toBe(3);
    expect(gc.major).toBe(3);
    expect(gc.maxKind).toBe('major');
    expect(gc.total).toBeGreaterThan(0);
    expect(gc.max).toBeGreaterThan(0);
    expect(gc.elapsed).toBeGreaterThanOrEqual(gc.total);
    expect(gc.iterations).toBe(3);
    expect(gc.timed).toBeCloseTo(stats.avg * stats.ticks, 3);
    expect(gc.overlap!.min).toBeGreaterThan(0);
    expect(gc.overlap!.max).toBeLessThanOrEqual(gc.timed);
    expect(gc.overlap!.min).toBeLessThanOrEqual(gc.overlap!.max);
  });

  it('excludes setup, warmup, heap diagnostics, and teardown from batched GC totals', async () => {
    const stats = await measure(
      function* () {
        globalThis.gc!();
        yield () => globalThis.gc!();
        globalThis.gc!();
      },
      {
        sample_gc: true,
        heap: () => process.memoryUsage().heapUsed,
        warmup_samples: 0,
        batch: true,
        batch_samples: 4,
        min_samples: 3,
        max_samples: 3,
        min_cpu_time: 0,
      }
    );
    expect(stats.gc).toMatchObject({ count: 12, major: 12, iterations: 12 });
    expect(stats.heap).toBeDefined();
    expect(JSON.parse(JSON.stringify(trimStats(stats))).gc).toEqual(stats.gc);
  });

  it('observes natural collections from temporary allocations', async () => {
    const stats = await measure(
      () => Array.from({ length: 1000 }, (_, index) => [index, index, index]),
      {
        sample_gc: true,
        heap: false,
        batch: true,
        batch_samples: 8,
        min_cpu_time: 100e6,
      }
    );
    const gc = stats.gc as GcStats;
    expect(gc.count).toBeGreaterThan(0);
    expect(gc.minor).toBeGreaterThan(0);
    expect(gc.total).toBeGreaterThan(0);
    expect(gc.timed).toBeCloseTo(stats.avg * stats.ticks, 3);
  });

  it('bounds timed GC when after hooks also collect outside the timed calls', async () => {
    const entries: PerformanceEntry[] = [];
    const windows: Array<[number, number]> = [];
    const observer = new PerformanceObserver((list) => entries.push(...list.getEntries()));
    observer.observe({ entryTypes: ['gc'] });
    try {
      const stats = await measure(
        function* () {
          yield {
            bench: () => {
              const start = performance.now();
              globalThis.gc!();
              windows.push([start, performance.now()]);
            },
            after: () => globalThis.gc!(),
          };
        },
        {
          sample_gc: true,
          heap: false,
          warmup_samples: 0,
          batch: false,
          min_samples: 3,
          max_samples: 3,
          min_cpu_time: 0,
        }
      );
      const gc = stats.gc as GcStats;
      const timedGc = windows
        .slice(1)
        .reduce(
          (sum, [start, end]) =>
            sum +
            entries.reduce(
              (duration, entry) =>
                duration +
                Math.max(
                  0,
                  Math.min(end, entry.startTime + entry.duration) - Math.max(start, entry.startTime)
                ) *
                  1e6,
              0
            ),
          0
        );
      expect(gc.count).toBe(6);
      expect(timedGc).toBeGreaterThan(0);
      expect(gc.total).toBeGreaterThan(timedGc);
      expect(gc.overlap!.min).toBeLessThanOrEqual(timedGc);
      expect(gc.overlap!.max).toBeGreaterThanOrEqual(timedGc);
    } finally {
      observer.disconnect();
    }
  });

  it('keeps slow samples in the average and recorded timed duration', async () => {
    let clock = 0;
    let calls = 0;
    const stats = await measure(
      () => {
        clock += ++calls === 21 ? 100 : 1;
      },
      {
        now: () => clock,
        gc: false,
        sample_gc: true,
        warmup_samples: 0,
        batch: false,
        min_samples: 20,
        max_samples: 20,
        min_cpu_time: 0,
      }
    );
    expect(stats.samples).toHaveLength(20);
    expect(stats.max).toBe(100);
    expect(stats.avg).toBe(119 / 20);
    expect(stats.gc).toMatchObject({ timed: 119, iterations: 20 });
    expect((stats.gc as GcStats).overlap).toBeUndefined();
  });

  it('allows zero timed GC when collections occur only in cleanup', async () => {
    const stats = await measure(
      function* () {
        yield {
          bench: () => {
            const end = performance.now() + 0.1;
            while (performance.now() < end) {}
          },
          after: () => globalThis.gc!(),
        };
      },
      {
        sample_gc: true,
        heap: false,
        warmup_time: 0,
        batch: false,
        min_samples: 3,
        max_samples: 3,
        min_cpu_time: 0,
      }
    );
    const gc = stats.gc as GcStats;
    expect(gc.count).toBe(3);
    expect(gc.overlap!.min).toBe(0);
    expect(gc.overlap!.max).toBeLessThanOrEqual(gc.timed);
  });

  it('pools observed totals across fresh process blocks', () => {
    const resultFile = join(tmpdir(), `labs-gc-test-${process.pid}.json`);
    try {
      execFileSync(
        process.execPath,
        [
          '--expose-gc',
          '--allow-natives-syntax',
          '--import',
          createRequire(import.meta.url).resolve('tsx'),
          fileURLToPath(new URL('../src/worker.ts', import.meta.url)),
        ],
        {
          stdio: 'pipe',
          env: {
            ...process.env,
            LABS_BENCH_FILE: new URL('./fixtures/gc.bench.ts', import.meta.url).href,
            LABS_RESULT_FILE: resultFile,
            LABS_BLOCKS: '2',
            LABS_MIN_SAMPLES: '4',
            LABS_BLOCK_TIME: '1',
          },
        }
      );
      const result = JSON.parse(readFileSync(resultFile, 'utf8'));
      const stats = result.benchmarks[0].runs[0].stats;
      expect(stats.blocks.medians).toHaveLength(2);
      expect(stats.gc).toMatchObject({ count: 8, major: 8, iterations: 8, maxKind: 'major' });
      expect(stats.gc.timed).toBeCloseTo(stats.avg * stats.ticks, 3);
      expect(stats.gc.overlap.min).toBeGreaterThan(0);
      expect(stats.gc.overlap.max).toBeLessThanOrEqual(stats.gc.timed);
    } finally {
      rmSync(resultFile, { force: true });
    }
  });
});
