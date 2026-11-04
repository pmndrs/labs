import { describe, expect, it } from 'vitest';
import { B, measure } from '../src/bench/index.ts';
import type { BlockPlan, MeasureOptions } from '../src/bench/types.ts';

describe('adaptive warmup', () => {
  it.each(['sync', 'async', 'iterator'])(
    'batches %s work that becomes fast after cold first calls',
    async (kind) => {
      let clock = 0;
      let calls = 0;
      const work = () => {
        clock += [2_000_000, 200_000, 100_000][calls++] ?? 1_000;
        return calls;
      };
      const fn =
        kind === 'async'
          ? async () => work()
          : kind === 'iterator'
            ? (state: Iterable<unknown>) => {
                for (const _ of state) work();
              }
            : work;

      const stats = await measure(fn as any, {
        now: () => clock,
        gc: false,
        min_samples: 1,
        max_samples: 1,
        min_cpu_time: 0,
      });

      expect(stats.plan?.batch).toBe(true);
      expect(stats.p50).toBe(1_000);
    }
  );

  it('reports when the workload settled and nothing when it never did', async () => {
    let clock = 0;
    let calls = 0;
    const settled = await measure(
      () => {
        clock += clock < 3_000_000 ? 100_000 : 10_000;
        return ++calls;
      },
      { now: () => clock, gc: false, min_samples: 1, max_samples: 1, min_cpu_time: 0 }
    );
    expect(settled.warmup?.phase).toBe('sampling');
    expect(settled.warmup?.time).toBeGreaterThanOrEqual(10_000_000);
    expect(settled.warmup?.time).toBeLessThan(15_000_000);
    expect(settled.plan?.batch).toBe(true);
    expect(settled.p50).toBe(10_000);

    clock = 0;
    let warmupTime = 0;
    const unsettled = await measure(
      () => {
        clock += ++calls % 2 ? 100_000 : 200_000;
      },
      {
        now: () => clock,
        gc: () => {
          warmupTime = clock;
        },
        warmup_time: 2_000_000,
        min_samples: 1,
        max_samples: 1,
        min_cpu_time: 0,
      }
    );
    expect(unsettled.unsettled).toBe(true);
    expect(unsettled.warmup).toBeUndefined();
    expect(warmupTime).toBeGreaterThanOrEqual(2_000_000);
    expect(warmupTime).toBeLessThanOrEqual(2_200_000);
  });

  it.each([8_000, 100_000])('stops warming stable %i ns work soon after it settles', async (cost) => {
    let clock = 0;
    let calls = 0;
    let warmupCalls = 0;
    const stats = await measure(
      () => {
        clock += cost;
        return ++calls;
      },
      {
        now: () => clock,
        gc: () => {
          warmupCalls = calls;
        },
        min_samples: 1,
        max_samples: 1,
        min_cpu_time: 0,
      }
    );

    // Batched work also warms the generated sampling loop, with its own settle floor
    const floors = cost < 65_536 ? 2 : 1;
    expect(warmupCalls * cost).toBeGreaterThanOrEqual(floors * 5_000_000);
    expect(warmupCalls * cost).toBeLessThan(floors * 7_000_000);
    // Every warm call precedes the initial collection, so only the recorded sample follows it
    expect(calls - warmupCalls).toBe(stats.plan!.batch ? stats.plan!.batch_samples : 1);
    expect(stats.p50).toBe(cost);
    expect(stats.plan?.batch).toBe(cost < 65_536);
  });

  it('stops warmup when the first call exhausts its budget', async () => {
    let clock = 0;
    let calls = 0;
    let warmupCalls = 0;
    const stats = await measure(
      () => {
        clock += 150_000_000;
        calls++;
      },
      {
        now: () => clock,
        gc: () => {
          warmupCalls = calls;
        },
        min_samples: 1,
        max_samples: 1,
        min_cpu_time: 0,
      }
    );

    expect(warmupCalls).toBe(1);
    expect(stats.plan?.batch).toBe(false);
  });

  it('includes slow parameter and cleanup hooks in the warmup budget', async () => {
    let clock = 0;
    let warmupTime = 0;
    let pending = false;
    await measure(
      function* () {
        yield {
          0: () => {
            clock += 400_000;
            return 1;
          },
          bench: (value: number) => {
            expect(pending).toBe(false);
            pending = true;
            clock += 1_000;
            return value;
          },
          after: async () => {
            clock += 400_000;
            pending = false;
          },
        };
      },
      {
        now: () => clock,
        gc: () => {
          warmupTime = clock;
        },
        batch: false,
        warmup_time: 2_000_000,
        min_samples: 1,
        max_samples: 1,
        min_cpu_time: 0,
      }
    );

    expect(warmupTime).toBeGreaterThanOrEqual(2_000_000);
    expect(warmupTime).toBeLessThan(3_000_000);
    expect(pending).toBe(false);
  });

  it('warms a fresh block before replaying an unbatched pilot plan', async () => {
    let clock = 0;
    let calls = 0;
    let warmupCalls = 0;
    const plan: BlockPlan = { batch: false, batch_samples: 0, batch_unroll: 4, samples: 7 };
    const tune: MeasureOptions = {
      now: () => clock,
      gc: () => {
        warmupCalls ||= calls;
      },
    };
    const trial = await new B('cold block', () => {
      clock += [2_000_000, 200_000, 100_000][calls++] ?? 1_000;
    }).run(true, tune, [plan]);

    expect(warmupCalls).toBeGreaterThan(3);
    expect(trial.runs[0].stats?.plan).toEqual(plan);
    expect(trial.runs[0].stats?.p50).toBe(1_000);
    expect(trial.runs[0].stats?.optimization?.natural).toBeUndefined();
  });
});
