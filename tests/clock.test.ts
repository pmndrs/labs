import { describe, expect, it } from 'vitest';
import { measure } from '../src/bench/index.ts';
import { calibrateClock } from '../src/bench/lib/clock.ts';
import { classify } from '../src/stats.ts';

describe('clock-aware browser sampling', () => {
  it.each(['function', 'iterator'])(
    'preserves effect size across a 5 microsecond timer for a %s benchmark',
    async (kind) => {
      let probe = 0;
      const clock = calibrateClock(() => Math.floor(++probe / 10) * 5000);
      const medians: number[] = [];
      for (const duration of [70000, 73000]) {
        let elapsed = 0;
        const work = () => {
          elapsed += duration;
          return elapsed;
        };
        const stats = await measure(
          kind === 'function'
            ? work
            : (state: any) => {
                for (const _ of state) work();
              },
          {
            ...clock,
            now: () => Math.floor(elapsed / 5000) * 5000,
            gc: false,
            warmup_samples: 0,
            min_samples: 1000,
            max_samples: 1000,
            min_cpu_time: 0,
          }
        );
        expect(stats.plan?.batch).toBe(true);
        expect(stats.plan!.batch_samples * duration).toBeGreaterThanOrEqual(1e6);
        expect(stats.p50).toBeCloseTo(duration, -3);
        medians.push(stats.p50);
      }
      expect(
        classify(Array(8).fill(medians[0]), Array(8).fill(medians[1]), {
          alpha: 0.05,
          minDelta: 0.05,
        }).verdict
      ).toBe('neutral');
    }
  );

  it('raises sample duration for coarse clocks and rejects a frozen clock', () => {
    let probe = 0;
    expect(calibrateClock(() => Math.floor(++probe / 10) * 100000)).toMatchObject({
      batch_threshold: 20e6,
      batch_duration: 20e6,
      warmup_window: 20e6,
    });
    expect(() => calibrateClock(() => 0)).toThrow('clock did not advance');
  });
});
