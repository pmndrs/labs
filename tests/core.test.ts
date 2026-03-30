import { describe, expect, it } from 'vitest';
import { measure, kind, do_not_optimize } from '../src/core/lib.mjs';
import { B, bench, group, run, compact } from '../src/core/main.mjs';

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

  it('fn path: async function', async () => {
    const s = await measure(async () => 1 + 1, fast);
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

  it('rejects non-benchmarkable values', async () => {
    await expect(measure(42 as any, fast)).rejects.toThrow();
  });

  it('samples are sorted ascending', async () => {
    const s = await measure(() => {}, fast);
    for (let i = 1; i < s.samples.length; i++) {
      expect(s.samples[i]).toBeGreaterThanOrEqual(s.samples[i - 1]);
    }
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

  it('classifies async generator as yield', () => {
    expect(kind(async function* () { yield; })).toBe('yield');
  });

  it('returns undefined for non-functions', () => {
    expect(kind(42 as any)).toBeUndefined();
    expect(kind(null as any)).toBeUndefined();
    expect(kind('str' as any)).toBeUndefined();
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

  it('args() object map sets multiple arg dimensions', () => {
    const b = new B('$a-$b', () => {});
    b.args({ a: [1, 2], b: ['x', 'y'] });
    const names = [...b._names()];
    expect(names).toHaveLength(4);
    expect(names).toContain('1-x');
    expect(names).toContain('2-y');
  });

  it('args(null) clears args', () => {
    const b = new B('test', () => {});
    b.args([1, 2, 3]);
    b.args(null as any);
    expect([...b._names()]).toEqual(['test']);
  });

  it('args(name, null) deletes a named arg', () => {
    const b = new B('test $n', () => {});
    b.args('n', [1, 2]);
    b.args('n', null as any);
    expect([...b._names()]).toEqual(['test $n']);
  });

  it('B.run() returns trial shape for static bench', async () => {
    const b = new B('shape test', () => {});
    const trial = await b.run(false, fast);
    expect(trial).toHaveProperty('kind', 'static');
    expect(trial).toHaveProperty('alias', 'shape test');
    expect(trial).toHaveProperty('baseline');
    expect(trial).toHaveProperty('style');
    expect(trial.style).toHaveProperty('compact');
    expect(trial.style).toHaveProperty('highlight');
    expect(trial.runs).toHaveLength(1);
    assertStats(trial.runs[0].stats);
  }, 20_000);

  it('B.run() returns trial shape for parameterized bench', async () => {
    const b = new B('param $n', () => {});
    b.args('n', [10, 20]);
    const trial = await b.run(false, fast);
    expect(trial.kind).toBe('args');
    expect(trial.runs).toHaveLength(2);
    expect(trial.runs[0].name).toBe('param 10');
    expect(trial.runs[1].name).toBe('param 20');
  }, 20_000);

  it('B.run(thrw=false) captures errors instead of throwing', async () => {
    const b = new B('throws', () => { throw new Error('boom'); });
    const trial = await b.run(false, fast);
    expect(trial.runs[0].error).toBeDefined();
    expect(trial.runs[0].stats).toBeUndefined();
  }, 20_000);

  it('B.run(thrw=true) throws on benchmark error', async () => {
    const b = new B('throws', () => { throw new Error('boom'); });
    await expect(b.run(true, fast)).rejects.toThrow('boom');
  }, 20_000);
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

  it('bench(fn) infers name from function.name', async () => {
    bench(function myBench() {});
    const r = await run({ format: 'quiet', tune: fast, calibrate: fast });
    expect(r.benchmarks.at(-1)!.alias).toBe('myBench');
  }, 20_000);

  it('compact() sets compact flag on enclosed benches', async () => {
    compact(() => {
      bench('compacted', () => {});
    });
    const r = await run({ format: 'quiet', tune: fast, calibrate: fast });
    expect(r.benchmarks.at(-1)!.style.compact).toBe(true);
  }, 20_000);

  it('run() returns context with runtime info', async () => {
    bench('ctx check', () => {});
    const r = await run({ format: 'quiet', tune: fast, calibrate: fast });
    expect(r.context).toHaveProperty('runtime');
    expect(r.context).toHaveProperty('cpu');
    expect(r.context).toHaveProperty('arch');
    expect(r.context).toHaveProperty('noop');
    expect(r.context.noop.fn).toHaveProperty('avg');
    expect(r.context.noop.iter).toHaveProperty('avg');
  }, 20_000);

  it('json format returns valid JSON string', async () => {
    bench('json out', () => {});
    let output = '';
    await run({
      format: { json: { debug: false, samples: false } } as any,
      tune: fast,
      calibrate: fast,
      print: (s: string) => { output += s; },
    });
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('benchmarks');
    expect(parsed).toHaveProperty('context');
    expect(parsed).toHaveProperty('layout');
  }, 20_000);

  it('observe() hook can transform trials', async () => {
    bench('observed', () => {});
    const r = await run({
      format: 'quiet',
      tune: fast,
      calibrate: fast,
      observe: (t: any) => ({ ...t, _observed: true }),
    });
    expect(r.benchmarks.at(-1)).toHaveProperty('_observed', true);
  }, 20_000);

  it('filter only runs matching benchmarks', async () => {
    bench('alpha', () => {});
    bench('beta', () => {});
    const r = await run({ format: 'quiet', tune: fast, calibrate: fast, filter: /alpha/ });
    const names = r.benchmarks.map((b: any) => b.alias);
    expect(names).toContain('alpha');
    expect(names).not.toContain('beta');
  }, 20_000);
});

// ── do_not_optimize ────────────────────────────────────────────────

describe('do_not_optimize', () => {
  it('accepts any value without throwing', () => {
    expect(() => do_not_optimize(42)).not.toThrow();
    expect(() => do_not_optimize('str')).not.toThrow();
    expect(() => do_not_optimize(null)).not.toThrow();
    expect(() => do_not_optimize({ a: 1 })).not.toThrow();
  });
});
