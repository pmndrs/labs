import { describe, expect, it } from 'vitest';
import { measure } from '../src/bench/index.ts';
import { renderMitata } from '../src/bench/render.ts';
import { trimStats } from '../src/store.ts';

describe('benchmark metrics', () => {
  it('awaits metrics once after timing and before teardown, separate from the snapshot', async () => {
    let iterations = 0;
    let measurements = 0;
    let finished = false;
    const stats = await measure(
      function* () {
        yield {
          bench: () => ++iterations,
          snapshot: () => iterations,
          metrics: async () => {
            await Promise.resolve();
            measurements++;
            expect(finished).toBe(false);
            return { iterations, zero: 0 };
          },
        };
        finished = true;
      },
      { min_cpu_time: 0, min_samples: 3, max_samples: 3, batch: false }
    );

    expect(measurements).toBe(1);
    expect(finished).toBe(true);
    expect(iterations).toBeGreaterThan(1);
    expect(stats.snapshot).toBe(1);
    expect(stats.metrics).toEqual({
      iterations: { min: iterations, max: iterations, p50: iterations },
      zero: { min: 0, max: 0, p50: 0 },
    });
    expect(JSON.parse(JSON.stringify(trimStats(stats))).metrics).toEqual(stats.metrics);
  });

  it('can record memory after a forced collection while benchmark state is still alive', async () => {
    const stats = await measure(
      function* () {
        const store = new Uint8Array(1024 * 1024);
        yield {
          bench: () => store.byteLength,
          metrics: () => {
            global.gc!();
            const { heapUsed, external } = process.memoryUsage();
            return { retainedBytes: heapUsed + external, storeBytes: store.byteLength };
          },
        };
      },
      { min_cpu_time: 0, min_samples: 1, max_samples: 1, batch: false }
    );

    expect(stats.metrics!.retainedBytes.p50).toBeGreaterThanOrEqual(1024 * 1024);
    expect(stats.metrics!.storeBytes.p50).toBe(1024 * 1024);
    expect(stats.snapshot).toBeUndefined();
  });

  it.each([undefined, [1], { retainedBytes: NaN }, { retainedBytes: Infinity }, { count: '1' }])(
    'rejects metric values that cannot be saved as finite numbers: %j',
    async (values) => {
      await expect(
        measure(
          function* () {
            yield { bench: () => 1, metrics: () => values };
          },
          { min_cpu_time: 0, min_samples: 1, max_samples: 1 }
        )
      ).rejects.toThrow(/finite number/);
    }
  );

  it.each([false, true])('renders metrics with compact mode %s', (compact) => {
    const lines: string[] = [];
    renderMitata(
      {
        cpu: { freq: 4, name: 'test-cpu' },
        runtime: 'node',
        version: 'test',
        arch: 'test',
        now: 0,
        noop: { fn: { avg: 0 }, iter: { avg: 0 }, fn_gc: { avg: 0 } },
      } as any,
      { print: (line) => lines.push(line), colors: false },
      [
        {
          name: null,
          types: [],
          trials: [
            {
              highlight: false,
              compact,
              gcMode: false,
              bench: {
                alias: 'footprint',
                runs: [
                  {
                    name: 'footprint',
                    args: {},
                    stats: {
                      kind: 'yield',
                      samples: [100, 101, 102],
                      min: 100,
                      max: 102,
                      avg: 101,
                      p25: 100,
                      p50: 101,
                      p75: 101,
                      p99: 102,
                      p999: 102,
                      metrics: { retainedBytes: { min: 1000, max: 3000, p50: 2000 } },
                    },
                  },
                ],
              } as any,
            },
          ],
        },
      ]
    );
    expect(lines.some((line) => line.includes('retainedBytes(1.00k … 3.00k) 2.00k'))).toBe(true);
  });
});
