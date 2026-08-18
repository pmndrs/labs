import { describe, expect, it } from 'vitest';
import { classify, mannWhitneyU, minMannWhitneyP } from '../src/stats.ts';

const samples = (value: number) => Array.from({ length: 30 }, () => value);

describe('comparing benchmark results', () => {
  it('treats equivalent results as neutral', () => {
    expect(classify(samples(100), samples(100)).verdict).toBe('neutral');
  });

  it('reports meaningful improvements and regressions', () => {
    const baseline = samples(100);

    expect(classify(baseline, samples(80)).verdict).toBe('faster');
    expect(classify(baseline, samples(120)).verdict).toBe('slower');
  });

  it('ignores differences below the meaningful-change threshold', () => {
    expect(classify(samples(100), samples(104)).verdict).toBe('neutral');
  });
});

describe('mann-whitney on small samples', () => {
  it('computes exact p-values for tie-free small samples', () => {
    // Fully separated 5v5 has the smallest possible two-sided p of 2/252
    expect(mannWhitneyU([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]).p).toBeCloseTo(2 / 252, 6);
  });

  it('stays insignificant for interleaved small samples', () => {
    expect(mannWhitneyU([1, 3, 5, 7, 9], [2, 4, 6, 8, 10]).p).toBeGreaterThan(0.5);
  });

  it('computes exact permutation p-values when small samples contain ties', () => {
    const baseline = [100, 100, 110, 110, 110];
    const candidate = [110, 110, 120, 120, 120];

    expect(mannWhitneyU(baseline, candidate).p).toBeCloseTo(20 / 252, 6);
    expect(classify(baseline, candidate).verdict).toBe('neutral');
  });

  it('derives the smallest attainable p-value from both sample sizes', () => {
    expect(minMannWhitneyP(4, 4)).toBeCloseTo(2 / 70, 10);
    expect(minMannWhitneyP(5, 5)).toBeCloseTo(2 / 252, 10);
  });
});
