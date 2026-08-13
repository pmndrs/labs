import { describe, expect, it } from 'vitest';
import { measure, B, bench, group, run } from '../src/bench/index.ts';

const fast = { min_cpu_time: 1, min_samples: 12, adaptive: false } as const;

function expectUsefulStats(stats: any) {
  expect(stats.samples.length).toBeGreaterThan(0);
  expect(stats.min).toBeLessThanOrEqual(stats.avg);
  expect(stats.avg).toBeLessThanOrEqual(stats.max);
  expect(stats.p75).toBeLessThanOrEqual(stats.p99);
  expect(stats.ticks).toBeGreaterThan(0);
}

describe('measuring work', () => {
  it.each([
    ['a synchronous function', () => () => 1 + 1, 'fn'],
    ['an asynchronous function', () => async () => 1 + 1, 'fn'],
    [
      'an iterator benchmark',
      () => (state: any) => {
        for (const _ of state);
      },
      'iter',
    ],
    [
      'a generator benchmark',
      () =>
        function* () {
          yield () => 1 + 1;
        },
      'yield',
    ],
  ])('produces useful statistics for %s', async (_, createBenchmark, expectedKind) => {
    const stats = await measure(createBenchmark() as any, fast);

    expect(stats.kind).toBe(expectedKind);
    expectUsefulStats(stats);
  });

  it('runs generator setup and teardown once around the measured work', async () => {
    let setups = 0;
    let iterations = 0;
    let teardowns = 0;

    const stats = await measure(function* () {
      setups++;
      yield () => iterations++;
      teardowns++;
    }, fast);

    expect(setups).toBe(1);
    expect(iterations).toBeGreaterThan(0);
    expect(teardowns).toBe(1);
    expectUsefulStats(stats);
  });

  it('marks a run noisy when it cannot converge within its time budget', async () => {
    const stats = await measure(() => {}, {
      min_cpu_time: 1,
      min_samples: 12,
      max_cpu_time: 1,
      adaptive: 0.0001,
    });

    expect(stats.noisy).toBe(true);
  });

  it('protects returned benchmark results from dead-code elimination', async () => {
    let result = 0;
    const consumed: number[] = [];
    const tune = {
      ...fast,
      batch_threshold: 0,
      $consume: (value: number) => consumed.push(value),
    } as any;

    await measure(function* () {
      yield () => ++result;
    }, tune);

    expect(consumed.at(-1)).toBe(result);

    const consumedResults = consumed.length;
    await measure(function* () {
      yield () => {
        result++;
      };
    }, tune);

    expect(consumed).toHaveLength(consumedResults);
  });

  it('supports async manual-timing benchmarks', async () => {
    const stats = await measure(
      function* () {
        yield { budget: 'manual', manual: async () => 1 };
      },
      { ...fast, min_samples: 2, max_samples: 3 }
    );

    expect(stats.samples).toEqual([1, 1]);
  });
});

describe('composing a benchmark suite', () => {
  it('runs grouped and parameterized benchmarks with readable names', async () => {
    void group('arrays', () => {
      bench('create', () => []);
      bench('fill $size', () => []).args('size', [10, 100]);
    });

    const result = await run({ format: 'quiet', tune: fast, calibrate: fast });

    expect(result.layout).toContainEqual(expect.objectContaining({ name: 'arrays' }));
    expect(result.benchmarks.map((trial) => trial.alias)).toEqual(['create', 'fill $size']);
    expect(result.benchmarks[1].runs.map((item) => item.name)).toEqual(['fill 10', 'fill 100']);
    for (const trial of result.benchmarks) {
      for (const benchmarkRun of trial.runs) expectUsefulStats(benchmarkRun.stats);
    }
  });

  it('runs only benchmarks selected by a filter', async () => {
    bench('array push', () => {});
    bench('array pop', () => {});

    const result = await run({
      format: 'quiet',
      filter: /push/,
      tune: fast,
      calibrate: fast,
    });

    expect(result.benchmarks.map((trial) => trial.alias)).toEqual(['array push']);
  });

  it('emits a JSON report that can omit bulky diagnostic data', async () => {
    bench('serialize', () => {});
    let output = '';

    await run({
      format: { json: { debug: false, samples: false } },
      tune: fast,
      calibrate: fast,
      print: (text: string) => {
        output += text;
      },
    });

    const report = JSON.parse(output);
    expect(report.benchmarks[0].alias).toBe('serialize');
    expect(report.benchmarks[0].runs[0].stats.samples).toBeNull();
    expect(report.benchmarks[0].runs[0].stats.debug).toBe('');
    expect(report.context).toEqual(expect.objectContaining({ runtime: expect.any(String) }));
  });
});

describe('run policy', () => {
  it('collects before every run and between samples unless disabled', async () => {
    let collections = 0;
    const tune = {
      gc: () => collections++,
      min_cpu_time: 0,
      min_samples: 1,
      max_samples: 1,
      adaptive: false,
    } as const;

    await new B('sample collection', () => {}).run(true, tune);
    expect(collections).toBeGreaterThan(1);

    collections = 0;
    await new B('initial collection', () => {}).gc(false).run(true, tune);
    expect(collections).toBe(1);
  });

  it('captures benchmark failures by default and can surface them to callers', async () => {
    const failingBenchmark = () => {
      throw new Error('boom');
    };

    const trial = await new B('failure', failingBenchmark).run(false, fast);
    expect(trial.runs[0].error).toEqual(expect.objectContaining({ message: 'boom' }));
    expect(trial.runs[0].stats).toBeUndefined();

    await expect(new B('failure', failingBenchmark).run(true, fast)).rejects.toThrow('boom');
  });
});
