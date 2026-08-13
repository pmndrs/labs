import { describe, expect, it } from 'vitest';
import { classify } from '../src/stats.ts';

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
