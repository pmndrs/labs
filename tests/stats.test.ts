import { describe, expect, it } from 'vitest';
import {
  calibrationExplainedFraction,
  classify,
  mannWhitneyU,
  minMannWhitneyP,
} from '../src/stats.ts';

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

describe('effect estimation', () => {
  it('reports the hodges-lehmann delta with a degenerate CI for constant shifts', () => {
    const result = classify(Array(5).fill(100), Array(5).fill(110));

    expect(result.verdict).toBe('slower');
    expect(result.hl).toBeCloseTo(0.1, 10);
    expect(result.ciLow).toBeCloseTo(0.1, 10);
    expect(result.ciHigh).toBeCloseTo(0.1, 10);
  });

  it('brackets the estimate with a widening interval under fresh-run variation', () => {
    const baseline = [98, 100, 102, 99, 101, 100, 97, 103];
    const candidate = baseline.map((v) => v * 1.2);

    const result = classify(baseline, candidate);

    expect(result.verdict).toBe('slower');
    expect(result.ciLow).toBeLessThan(result.hl);
    expect(result.ciHigh).toBeGreaterThan(result.hl);
    expect(result.ciLow).toBeGreaterThan(0.05);
  });
});

describe('clock attribution', () => {
  const freqs = [4, 3.5, 4.2, 3.8, 4.1, 3.6];

  it('attributes spread to the clock when medians track 1/frequency', () => {
    const medians = freqs.map((f) => 400 / f);

    expect(calibrationExplainedFraction(medians, freqs)).toBeCloseTo(1, 6);
  });

  it('attributes nothing to the clock when medians ignore it', () => {
    const medians = [100, 101, 99, 100, 102, 98];

    expect(calibrationExplainedFraction(medians, freqs)).toBe(0);
  });
});
