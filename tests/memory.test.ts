import { describe, expect, it } from 'vitest';
import { measure } from '../src/bench/index.ts';

describe('memory diagnostics', () => {
  const benchmarks = [
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
  ] as const;

  describe.each([false, true])('batching %s', (batch) => {
    it.each(benchmarks)('keeps diagnostics out of %s timings and budgets', async (kind, create) => {
      const run = async (diagnostics: boolean) => {
        let clock = 0;
        let calls = 0;
        let bytes = 0;
        let cold = false;
        const collections: number[] = [];
        const heapReads: number[] = [];
        const work = () => {
          clock += cold ? 101 : 1;
          cold = false;
          calls++;
          bytes += 32;
        };
        const stats = await measure(create(work), {
          now: () => clock,
          gc: () => {
            collections.push(calls);
            clock += 5_000;
            cold = true;
            bytes = 0;
          },
          heap: !diagnostics
            ? false
            : () => {
                heapReads.push(calls);
                clock += 10_000;
                bytes += 8;
                return bytes;
              },
          sample_gc: diagnostics,
          warmup_samples: 0,
          batch,
          batch_samples: batch ? 4 : 0,
          min_samples: 12,
          max_samples: 2_000,
          min_cpu_time: 1_000,
        });
        return { stats, calls, collections, heapReads };
      };

      const plain = await run(false);
      const diagnostic = await run(true);
      const iterations = batch ? 4 : 1;
      const timingCalls = diagnostic.stats.plan!.samples * iterations;

      expect(diagnostic.stats.samples).toEqual(plain.stats.samples);
      expect(diagnostic.stats.plan).toEqual(plain.stats.plan);
      expect(diagnostic.stats.p50).toBe(1);
      expect(timingCalls).toBe(900);
      expect(diagnostic.stats.gc).toMatchObject({ timed: 1_000, iterations: timingCalls });
      expect(plain.stats.gc).toBeUndefined();
      expect(plain.collections).toHaveLength(1);
      if (!kind.includes('iterator')) {
        expect(diagnostic.collections[1] - diagnostic.collections[0]).toBe(timingCalls);
        expect(diagnostic.calls - diagnostic.collections[1]).toBe(20 * iterations);
        expect(Math.min(...diagnostic.heapReads)).toBeGreaterThanOrEqual(diagnostic.collections[1]);
        expect(diagnostic.stats.heap).toEqual({ min: 32, max: 32, p50: 32 });
      } else {
        expect(diagnostic.collections).toHaveLength(1);
      }
    });
  });

  it.each([false, true])(
    'preserves generator lifecycle and fresh parameters with batching %s',
    async (batch) => {
      let clock = 0;
      let setups = 0;
      let teardowns = 0;
      let parameters = 0;
      let calls = 0;
      let pending = 0;
      let maxPending = 0;
      let cleanups = 0;
      const seen = new Set<number>();

      const stats = await measure(
        function* () {
          setups++;
          const first: number = yield {
            0: async () => ++parameters,
            bench: async (parameter: number) => {
              expect(seen.has(parameter)).toBe(false);
              seen.add(parameter);
              calls++;
              maxPending = Math.max(maxPending, ++pending);
              clock++;
              return parameter;
            },
            after: () => {
              pending = 0;
              cleanups++;
            },
          };
          teardowns++;
          return first;
        },
        {
          now: () => clock,
          gc: () => {
            clock += 100;
          },
          heap: () => calls * 16,
          sample_gc: true,
          concurrency: 2,
          warmup_samples: 0,
          batch,
          batch_samples: batch ? 4 : 0,
          min_samples: 3,
          max_samples: 3,
          min_cpu_time: 0,
        }
      );

      const callsPerSample = (batch ? 4 : 1) * 2;
      expect(stats.plan!.samples).toBe(3);
      expect(calls).toBe(1 + 6 * callsPerSample);
      expect(parameters).toBe(calls);
      expect(maxPending).toBe(callsPerSample);
      expect(cleanups).toBe(7);
      expect(pending).toBe(0);
      expect(setups).toBe(1);
      expect(teardowns).toBe(1);
      expect(stats.snapshot).toBe(1);
    }
  );

  it('keeps heap diagnostics and their work outside manual timing', async () => {
    let clock = 0;
    let bytes = 0;
    const stats = await measure(
      function* () {
        yield {
          budget: 'manual',
          manual: async () => {
            bytes += 16;
            return 2;
          },
        };
      },
      {
        now: () => clock,
        gc: false,
        heap: () => {
          clock += 1_000;
          return bytes;
        },
        warmup_samples: 0,
        min_samples: 2,
        min_cpu_time: 10,
      }
    );

    expect(stats.samples).toEqual([2, 2, 2, 2, 2]);
    expect(stats.plan!.samples).toBe(5);
    expect(stats.heap).toEqual({ min: 16, max: 16, p50: 16 });
  });

  it('finishes hardware counter collection before running memory diagnostics', async () => {
    let calls = 0;
    let started = 0;
    let measured = 0;
    let finished = false;
    const stats = await measure(
      () => {
        calls++;
      },
      {
        now: () => calls,
        gc: false,
        heap: () => {
          expect(finished).toBe(true);
          return calls * 16;
        },
        $counters: {
          init() {},
          before() {
            started = calls;
          },
          after() {
            measured += calls - started;
          },
          translate(iterations: number, samples: number) {
            return { perIteration: measured / (iterations * samples) };
          },
          deinit() {
            finished = true;
          },
        },
        warmup_samples: 0,
        batch: true,
        batch_samples: 4,
        min_samples: 12,
        min_cpu_time: 0,
      }
    );

    expect(stats.counters).toEqual({ perIteration: 1 });
    expect(calls).toBe(1 + 2 * 12 * 4);
    expect(finished).toBe(true);
  });

  it('uses fallback collection only before timing', async () => {
    let collections = 0;
    let clock = 0;
    const stats = await measure(
      () => {
        clock++;
      },
      {
        now: () => clock,
        gc: Object.assign(
          () => {
            collections++;
          },
          { fallback: true }
        ),
        sample_gc: true,
        warmup_samples: 0,
        batch: false,
        min_samples: 12,
        min_cpu_time: 100,
      }
    );

    expect(collections).toBe(1);
    expect(stats.gc).toMatchObject({ iterations: 100 });
    expect(stats.plan!.samples).toBe(100);
  });
});
