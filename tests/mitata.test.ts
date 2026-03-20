import { describe, expect, it } from 'vitest';
import { bench } from '../src/index.ts';
import { run } from '../src/mitata.ts';

describe('bundled mitata', () => {
  it('respects tune min_samples instead of upstream defaults', async () => {
    bench('tune propagation', () => {});

    const result = await run({
      format: 'quiet',
      tune: {
        min_samples: 20,
        min_cpu_time: 1,
        adaptive: false,
      },
    });

    const debug = result.benchmarks[0]?.runs[0]?.stats?.debug ?? '';
    const samples = result.benchmarks[0]?.runs[0]?.stats?.samples ?? [];

    expect(debug).toContain('_ >= 20');
    expect(debug).not.toContain('_ >= 12');
    expect(samples.length).toBeGreaterThanOrEqual(16);
  }, 20_000);
});
