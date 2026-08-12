import { expect, it } from 'vitest';
import { do_not_optimize, measure } from '../src/bench/index.ts';
import { classify } from '../src/stats.ts';

const opts = { min_cpu_time: 100, min_samples: 30, adaptive: true } as const;

it('should always classify the same benchmark as neutral when compared to itself', async () => {
  const work = () => {
    let x = 0;
    for (let i = 0; i < 1000; i++) x += Math.sqrt(i);
    do_not_optimize(x);
  };

  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(await measure(work, opts));

  const baseline = runs[0].samples;
  for (const run of runs) {
    expect(classify(baseline, run.samples).verdict).toBe('neutral');
  }
}, 30_000);
