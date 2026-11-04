import { describe, expect, it, vi } from 'vitest';
import { measure } from '../src/bench/lib/measure.ts';

// The workload has a TurboFan entry while the sampling frame starts in Maglev.
vi.mock('../src/bench/lib/optimization.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/bench/lib/optimization.ts')>()),
  optimization: {
    tier: () => 'TurboFan',
    frame: "$now() >= 30_000 ? 'TurboFan' : 'Maglev'",
  },
}));

describe('batched tier verification', () => {
  it.each([
    { budget: 100_000, expected: 'TurboFan' },
    { budget: 10_000, expected: null },
  ])(
    'resolves a stable batch within its warmup budget of $budget ns',
    async ({ budget, expected }) => {
      let clock = 0;
      let recordingStart = 0;
      const stats = await measure(() => (clock += 1_000), {
        now: () => clock,
        gc: () => {
          recordingStart = clock;
        },
        batch: true,
        batch_samples: 1,
        warmup_samples: 2,
        warmup_window: 1,
        warmup_time: budget,
        warmup_settle: 1_000,
        min_samples: 2,
        max_samples: 2,
        min_cpu_time: 0,
        heap: false,
      });
      expect(stats.samples).toEqual([1_000, 1_000]);
      expect(stats.optimization?.benchmark?.[0]?.tier ?? null).toBe(expected);
      expect(stats.optimization?.benchmarkEnd).toEqual([expected]);
      if (expected) {
        expect(recordingStart).toBeGreaterThanOrEqual(30_000);
        expect(recordingStart).toBeLessThan(budget);
      } else {
        expect(recordingStart).toBeGreaterThanOrEqual(budget);
        expect(recordingStart).toBeLessThan(30_000);
      }
    }
  );
});
