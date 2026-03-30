import { describe, expect, it } from 'vitest';
import { measure, kind } from '../src/core/lib.mjs';
import { B, bench, group, run } from '../src/core/main.mjs';

const fast = { min_cpu_time: 1, min_samples: 12, adaptive: false } as const;

function assertStats(s: any) {
  expect(s.samples).toBeInstanceOf(Array);
  expect(s.samples.length).toBeGreaterThanOrEqual(8);
  expect(s.min).toBeLessThanOrEqual(s.avg);
  expect(s.avg).toBeLessThanOrEqual(s.max);
  expect(s.p75).toBeLessThanOrEqual(s.p99);
  expect(s.ticks).toBeGreaterThan(0);
}

// ── measure() codegen paths ────────────────────────────────────────

describe('measure', () => {
  it('fn path: zero-arg function', async () => {
    const s = await measure(() => 1 + 1, fast);
    expect(s.kind).toBe('fn');
    assertStats(s);
  }, 20_000);

  it('iter path: state consumer', async () => {
    const s = await measure((state: any) => {
      for (const _ of state);
    }, fast);
    expect(s.kind).toBe('iter');
    assertStats(s);
  }, 20_000);

  it('generator/yield path', async () => {
    const s = await measure(function* () {
      yield () => 1 + 1;
    }, fast);
    expect(s.kind).toBe('yield');
    assertStats(s);
  }, 20_000);
});

// ── kind() dispatch ────────────────────────────────────────────────

describe('kind', () => {
  it('classifies zero-arg function as fn', () => {
    expect(kind(() => {})).toBe('fn');
  });

  it('classifies async zero-arg as fn', () => {
    expect(kind(async () => {})).toBe('fn');
  });

  it('classifies generator as yield', () => {
    expect(
      kind(function* () {
        yield;
      })
    ).toBe('yield');
  });

  it('classifies function with args as iter', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    expect(kind(function (state: any) {})).toBe('iter');
  });

  it('returns undefined for non-functions', () => {
    expect(kind(42 as any)).toBeUndefined();
  });
});

// ── adaptive sampling (patch) ──────────────────────────────────────

describe('adaptive sampling', () => {
  it('adaptive=true uses Welford convergence, no fixed-sample break', async () => {
    const s = await measure(() => {}, { min_cpu_time: 1, min_samples: 12, adaptive: true });
    expect(s.debug).toContain('_lm');
    expect(s.debug).not.toContain('_ >= 12');
  }, 20_000);

  it('adaptive=false uses classic fixed break, no noisy property', async () => {
    const s = await measure(() => {}, fast);
    expect(s.debug).toContain('_ >= 12');
    expect(s).not.toHaveProperty('noisy');
  }, 20_000);

  it('sets noisy=true when max_cpu_time exceeded before convergence', async () => {
    const s = await measure(() => {}, {
      min_cpu_time: 1,
      min_samples: 12,
      max_cpu_time: 1,
      adaptive: 0.0001,
    });
    expect(s).toHaveProperty('noisy', true);
  }, 20_000);
});

// ── B class builder ────────────────────────────────────────────────

describe('B class', () => {
  it('rejects non-function in constructor', () => {
    expect(() => new B('x', 42 as any)).toThrow('expected iterator, generator or one-shot function');
  });

  it('args() + _names() interpolates parameterized names', () => {
    const b = new B('test $n', () => {});
    b.args('n', [1, 2, 3]);
    expect([...b._names()]).toEqual(['test 1', 'test 2', 'test 3']);
  });

  it('range() generates geometric sequence', () => {
    const b = new B('r $n', () => {});
    b.range('n', 1, 64, 8);
    expect([...b._names()]).toEqual(['r 1', 'r 8', 'r 64']);
  });

  it('dense_range() generates arithmetic sequence', () => {
    const b = new B('d $n', () => {});
    b.dense_range('n', 1, 5, 2);
    expect([...b._names()]).toEqual(['d 1', 'd 3', 'd 5']);
  });

  it('gc() rejects invalid values', () => {
    expect(() => new B('x', () => {}).gc('bad' as any)).toThrow('invalid gc type');
  });

  it('highlight() rejects invalid colors', () => {
    expect(() => new B('x', () => {}).highlight('nope' as any)).toThrow('invalid highlight color');
  });

  it('methods return this for chaining', () => {
    const b = new B('x', () => {});
    expect(b.compact()).toBe(b);
    expect(b.baseline()).toBe(b);
    expect(b.gc('once')).toBe(b);
    expect(b.args('n', [1])).toBe(b);
  });
});

// ── bench() + run() integration ────────────────────────────────────

describe('bench + run', () => {
  it('runs a static benchmark and returns structured result', async () => {
    bench('static noop', () => {});
    const r = await run({ format: 'quiet', tune: fast, calibrate: fast });

    expect(r.benchmarks.length).toBeGreaterThanOrEqual(1);
    const trial = r.benchmarks.at(-1)!;
    expect(trial.alias).toBe('static noop');
    expect(trial.kind).toBe('static');
    assertStats(trial.runs[0].stats);
  }, 20_000);

  it('tune passthrough reaches measure codegen', async () => {
    bench('tune check', () => {});
    const r = await run({
      format: 'quiet',
      calibrate: fast,
      tune: { min_samples: 25, min_cpu_time: 1, adaptive: false },
    });

    const debug = r.benchmarks.at(-1)?.runs[0]?.stats?.debug ?? '';
    expect(debug).toContain('_ >= 25');
  }, 20_000);

  it('parameterized bench produces multiple runs', async () => {
    bench('p $n', () => {}).args('n', [1, 2]);
    const r = await run({ format: 'quiet', tune: fast, calibrate: fast });

    const trial = r.benchmarks.at(-1)!;
    expect(trial.kind).toBe('args');
    expect(trial.runs).toHaveLength(2);
    expect(trial.runs.map((x: any) => x.name)).toEqual(['p 1', 'p 2']);
  }, 20_000);

  it('group() scoping assigns shared group id', async () => {
    group('math', () => {
      bench('add', () => 1 + 1);
      bench('mul', () => 2 * 2);
    });
    const r = await run({ format: 'quiet', tune: fast, calibrate: fast });

    const trials = r.benchmarks.slice(-2);
    expect(trials[0].group).toBe(trials[1].group);
    expect(trials[0].group).toBeGreaterThan(0);
  }, 20_000);
});
