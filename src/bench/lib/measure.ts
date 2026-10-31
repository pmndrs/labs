import type { GeneratorBench, MeasureOptions, Snapshot, Stats } from '../types.ts';
import {
  AsyncFunction,
  do_not_optimize,
  GeneratorFunction,
  kind,
  now as runtimeNow,
} from './runtime.ts';
import { toSnapshot } from './snapshot.ts';
import { batchSize, defaults } from './constants.ts';
import { createWarmup, isWarmupDone, isWarmupUnsettled, recordWarmup } from './warmup.ts';
import { memoryPass } from './memory.ts';
import { GcObservation } from './gc.ts';

/** Range and median of the per-sample values, sorted in place. */
function summarize(values: Float64Array): { min: number; max: number; p50: number } {
  values.sort();
  return {
    min: values[0],
    max: values[values.length - 1],
    p50: values[(0.5 * (values.length - 1)) | 0],
  };
}

/**
 * Sample storage for one block. A typed array keeps timings off the JS heap,
 * so it neither allocates while sampling nor adds to the GC work being
 * observed. Sampling stops at capacity instead of growing.
 */
function createSamples(maxSamples: number): Float64Array {
  return new Float64Array(Math.max(0, Math.ceil(maxSamples)));
}

/**
 * Sorts the first `count` samples in place and derives the headline stats.
 * The saved samples are copied out as a plain array once, at the boundary.
 */
function summarizeSamples(samples: Float64Array, count: number) {
  const sorted = samples.subarray(0, count).sort();
  let sum = 0;
  for (let i = 0; i < count; i++) sum += sorted[i];
  return {
    samples: Array.from(sorted),
    min: sorted[0],
    max: sorted[count - 1],
    p25: sorted[(0.25 * (count - 1)) | 0],
    p50: sorted[(0.5 * (count - 1)) | 0],
    p75: sorted[(0.75 * (count - 1)) | 0],
    p99: sorted[(0.99 * (count - 1)) | 0],
    p999: sorted[(0.999 * (count - 1)) | 0],
    avg: sum / count,
  };
}

/**
 * Measure the performance of `f` by dispatching to the appropriate benchmark
 * engine ({@link benchFn}, {@link benchIter}, or {@link benchGenerator})
 * based on its {@link kind}.
 */
export function measure(gen: GeneratorBench, opts?: MeasureOptions): Promise<Stats>;
export function measure(f: (...args: any[]) => any, opts?: MeasureOptions): Promise<Stats>;
export async function measure(f: (...args: any[]) => any, opts: MeasureOptions = {}): Promise<Stats> {
  switch (kind(f)) {
    case 'fn':
      return await benchFn(f, opts);
    case 'iter':
      return await benchIter(f, opts);
    case 'yield':
      return await benchGenerator(f, opts);
    default:
      throw new TypeError('expected iterator, generator or one-shot function');
  }
}

/**
 * Benchmark adapter for generator functions.
 *
 * The generator yields a benchmarkable function or options object. After
 * measurement it receives the first untimed result. The snapshot comes from
 * the yielded object's `snapshot` hook or the generator's return value.
 */
export async function benchGenerator(gen: (...args: any[]) => any, opts: any = {}): Promise<Stats> {
  const ctx = {
    get(name: string) {
      return opts.args?.[name];
    },
  };

  const g = gen(ctx);
  const n = await g.next();

  let $fn = n.value;
  if (!n.value?.heap && null != n.value?.heap) opts.heap = false;
  opts.concurrency ??= n.value?.concurrency ?? opts.args?.concurrency;
  if (!n.value?.counters && null != n.value?.counters) opts.$counters = false;
  if (n.value?.after) opts.after = n.value.after;

  const hook = n.value?.snapshot;
  if (hook !== undefined && 'function' !== typeof hook)
    throw new TypeError('expected snapshot to be a function');

  let first: unknown;
  let snapshot: Snapshot | undefined;
  opts.$first = async (value: unknown) => {
    first = value;
    if (!hook) return;
    const output = await hook();
    if (output === undefined) throw new TypeError('expected a value to snapshot, got undefined');
    snapshot = toSnapshot(output);
  };

  if (n.done || 'fn' !== kind($fn)) {
    $fn = n.value?.bench || n.value?.manual;
    if ('fn' !== kind($fn, true)) throw new TypeError('expected benchmarkable yield from generator');

    opts.params ??= {};
    const params: number = $fn.length;
    opts.manual = !n.value.manual ? false : 'manual' !== n.value.budget ? 'real' : 'manual';

    for (let o = 0; o < params; o++) {
      opts.params[o] = n.value[o];
      if ('fn' !== kind(n.value[o])) throw new TypeError('expected function for benchmark parameter');
    }
  }

  const stats = await benchFn($fn, opts);
  const end = await g.next(first);
  if (!end.done) throw new TypeError('expected generator to yield once');

  if (end.value !== undefined) {
    if (snapshot !== undefined)
      throw new TypeError('expected one snapshot source, not both a hook and a generator return');
    snapshot = toSnapshot(end.value);
  }

  return {
    ...stats,
    kind: 'yield' as const,
    ...(snapshot !== undefined ? { snapshot } : {}),
  };
}

/**
 * Core benchmark engine for zero-arg and parameterised functions.
 *
 * Warms the workload, then generates an {@link AsyncFunction} loop that handles
 * batching, parameter injection, and hardware counters. Sampling stops once
 * both `min_samples` and `min_cpu_time` are met. Memory diagnostics follow
 * in a separate pass. The generated source is attached as `debug` on the
 * returned stats.
 */
export async function benchFn(fn: (...args: any[]) => any, opts: any = {}): Promise<Stats> {
  defaults(opts);
  const now: () => number = opts.now;
  const consume = opts.$consume ?? do_not_optimize;
  const warmup = createWarmup(
    now() + opts.warmup_time,
    opts.warmup_samples,
    now() + opts.warmup_settle
  );
  let async = false;
  let batch = false;
  let single = 0;
  const params: string[] = Object.keys(opts.params);

  {
    const $p = Array.from({ length: params.length }, () => 0);

    for (let o = 0; o < params.length; o++) {
      $p[o] = await opts.params[o]();
    }

    const t0 = now();
    const r = fn(...$p);
    let t1: number;
    let first: unknown;

    if ((async = r instanceof Promise)) {
      first = await r;
      if (!opts.manual && first !== void 0) consume(first);
      t1 = now();
    } else {
      first = r;
      if (!opts.manual && r !== void 0) consume(r);
      t1 = now();
    }

    // Manual benchmarks return durations instead of results.
    if (!opts.manual && opts.$first) await opts.$first(first);

    if (opts.after) await opts.after();

    recordWarmup(warmup, t1 - t0, 1, opts);
    while (!isWarmupDone(warmup, opts, now())) {
      let duration = 0;
      let iterations = 0;
      while (iterations < warmup.iterations && now() < warmup.deadline) {
        for (let oo = 0; oo < params.length; oo++) {
          $p[oo] = await opts.params[oo]();
        }

        const t0 = now();
        const value = async ? await fn(...$p) : fn(...$p);
        if (!opts.manual && value !== void 0) consume(value);
        duration += now() - t0;
        if (opts.after) await opts.after();
        iterations++;
      }
      if (iterations) recordWarmup(warmup, duration, iterations, opts);
    }
    single = warmup.single;
    batch = single <= opts.batch_threshold;
  }

  if (opts.batch !== undefined) batch = !!opts.batch;

  if (opts.manual) {
    batch = false;
    opts.concurrency = 1;
  }

  let batchSamples: number = opts.batch_samples ?? (batch ? batchSize(opts, single) : 0);
  if (batch && batchSamples < 1)
    throw new TypeError('expected at least one iteration per batched sample');

  // Size the final batch from a continuous loop without per-call clock reads.
  // Parameter generation requires separate timing.
  if (opts.batch_samples === undefined && batch && !params.length && !opts.manual) {
    const t0 = now();
    for (let o = 0; o < batchSamples; o++) {
      const value = async ? await fn() : fn();
      if (value !== void 0) consume(value);
    }
    batchSamples = batchSize(opts, (now() - t0) / batchSamples);
    if (opts.after) await opts.after();
  }

  const call = (concurrency: number, unroll?: number): string => {
    if (!params.length) return '$fn()';

    const args = params.map((_, parameter) => {
      if (unroll === void 0) return `param_${parameter}_${concurrency}`;
      return `param_${parameter}_${concurrency}[${unroll === 0 ? '' : `${unroll} + `}param_offset]`;
    });
    return `$fn(${args.join(', ')})`;
  };

  const calls = (unroll?: number): string => {
    if (opts.manual) return `t2 += ${async ? 'await ' : ''}${call(0, unroll)};`;

    if (async && opts.concurrency > 1) {
      return `
        {
          const _result = await Promise.all([
            ${Array.from({ length: opts.concurrency }, (_, concurrency) => `${call(concurrency, unroll)},`).join('\n')}
          ]);
          $consume(_result);
        }
      `;
    }

    return Array.from(
      { length: opts.concurrency },
      (_, concurrency) => `
        {
          const _result = ${async ? 'await ' : ''}${call(concurrency, unroll)};
          if (void 0 !== _result) $consume(_result);
        }
      `
    ).join('\n');
  };

  const prepare = !params.length
    ? ''
    : !batch
      ? Array.from({ length: params.length }, (_, p) =>
          Array.from(
            { length: opts.concurrency },
            (_, c) => `
            if ((param_${p}_${c} = $params[${p}]()) instanceof Promise) param_${p}_${c} = await param_${p}_${c};
          `
          ).join('\n')
        ).join('\n')
      : `
        for (let o = 0; o < ${batchSamples}; o++) {
          ${Array.from({ length: params.length }, (_, p) =>
            Array.from(
              { length: opts.concurrency },
              (_, c) => `
              if ((param_${p}_${c}[o] = $params[${p}]()) instanceof Promise) param_${p}_${c}[o] = await param_${p}_${c}[o];
            `
            ).join('\n')
          ).join('\n')}
        }
      `;
  const body = `
    ${!opts.manual ? '' : 'let t2 = 0;'}
    ${
      !batch
        ? calls()
        : `
      for (let o = 0; o < ${(batchSamples / opts.batch_unroll) | 0}; o++) {
        ${!params.length ? '' : `const param_offset = o * ${opts.batch_unroll};`}
        ${Array.from({ length: opts.batch_unroll }, (_, unroll) => calls(unroll)).join('\n')}
      }
      for (let param_offset = ${Math.floor(batchSamples / opts.batch_unroll) * opts.batch_unroll}; param_offset < ${batchSamples}; param_offset++) {
        ${calls(0)}
      }
    `
    }
  `;
  const collect = !!(opts.gc && !opts.gc.fallback);
  const samples = createSamples(opts.max_samples);
  const observation = opts.sample_gc ? new GcObservation() : undefined;
  const after = !opts.after ? '' : 'await $after();';

  const loop: (...args: any[]) => Promise<any> = new AsyncFunction(
    '$fn',
    '$gc',
    '$now',
    '$heap',
    '$params',
    '$counters',
    '$consume',
    '$after',
    '$summary',
    '$observation',
    '$samples',
    '$summarize',
    `
    ${!opts.$counters ? '' : 'let _hc = false;'}
    ${!opts.$counters ? '' : 'try { $counters.init(); _hc = true; } catch {}'}

    let _ = 0; let t = 0;

    ${Array.from({ length: params.length }, (_, p) =>
      Array.from(
        { length: opts.concurrency },
        (_, c) => `
        let param_${p}_${c} = ${!batch ? 'null' : `new Array(${batchSamples}).fill(undefined)`};
      `
      ).join('\n')
    ).join('\n')}

    ${!opts.gc ? '' : '$gc();'}
    ${!observation ? '' : '$observation.start();'}

    for (; _ < ${samples.length}; _++) {
      if (_ >= ${opts.min_samples} && t >= ${opts.min_cpu_time}) break;
      ${prepare}
      ${!opts.$counters ? '' : 'if (_hc) try { $counters.before(); } catch {};'}
      const t0 = $now();
      ${body}
      const t1 = $now();
      ${!opts.$counters ? '' : 'if (_hc) try { $counters.after(); } catch {};'}

      const diff = ${opts.manual ? 't2' : 't1 - t0'};
      t += ${'manual' === opts.manual ? 't2' : 't1 - t0'};
      $samples[_] = diff ${!batch ? '' : `/ ${batchSamples}`};
      ${after}
    }

    ${!observation ? '' : `const gc = await $observation.finish(t, _ * ${batch ? batchSamples : 1}, ${now === runtimeNow && !opts.manual});`}
    ${
      !opts.$counters
        ? ''
        : `
      let counters;
      try {
        if (_hc) counters = $counters.translate(${!batch ? 1 : batchSamples}, _);
      } finally {
        if (_hc) try { $counters.deinit(); } catch {}
      }
    `
    }

    ${memoryPass({ heap: !!opts.heap, gc: collect, prepare, body, after, iterations: batch ? batchSamples : 1 })}

    return {
      ...$summarize($samples, _),
      ticks: _ ${!batch ? '' : `* ${batchSamples}`},
      plan: { batch: ${batch}, batch_samples: ${batchSamples}, batch_unroll: ${opts.batch_unroll}, samples: _ },
      ${!opts.heap ? '' : 'heap: $summary(heap),'}
      ${!observation ? '' : 'gc,'}
      ${!opts.$counters ? '' : '...(!_hc ? {} : { counters }),'}
    };
  `
  );

  try {
    return {
      kind: 'fn' as const,
      debug: loop.toString(),
      ...(isWarmupUnsettled(warmup, opts) ? { unsettled: true } : {}),
      ...(await loop(
        fn,
        opts.gc,
        opts.now,
        opts.heap,
        opts.params,
        opts.$counters,
        consume,
        opts.after,
        summarize,
        observation,
        samples,
        summarizeSamples
      )),
    };
  } finally {
    observation?.cancel();
  }
}

/**
 * Benchmark engine for iterator-style benchmarks.
 *
 * The caller receives an iterable context. Each `for..of` / `for await..of`
 * iteration is one timed sample.  Internally a {@link GeneratorFunction} loop
 * is code-generated with the same stopping and batching logic as
 * {@link benchFn}.
 */
export async function benchIter(iter: (...args: any[]) => any, opts: any = {}): Promise<Stats> {
  defaults(opts);
  // Shared with the generated loop. Every key exists from the start so the shape never changes.
  const _: any = {
    next: null,
    batch: false,
    unsettled: false,
    debug: '',
    count: 0,
    timed: 0,
    iterations: undefined,
    gc: undefined,
  };
  const now: () => number = opts.now;
  let batchSamples = 0;
  const samples = createSamples(opts.max_samples);
  const observation = opts.sample_gc ? new GcObservation() : undefined;
  const _i = {
    next() {
      return _.next();
    },
  };

  const ctx = {
    [Symbol.iterator]() {
      return _i;
    },
    [Symbol.asyncIterator]() {
      return _i;
    },
    get(name: string) {
      return opts.args?.[name];
    },
  };

  const gen: Generator = (function* () {
    let batch = false;
    const warmup = createWarmup(
      now() + opts.warmup_time,
      opts.warmup_samples,
      now() + opts.warmup_settle
    );
    do {
      let iterations = 0;
      const t0 = now();
      do {
        yield void 0;
        iterations++;
      } while (iterations < warmup.iterations && now() < warmup.deadline);
      recordWarmup(warmup, now() - t0, iterations, opts);
    } while (!isWarmupDone(warmup, opts, now()));

    const single = warmup.single;
    _.unsettled = isWarmupUnsettled(warmup, opts);
    batch = single <= opts.batch_threshold;

    if (opts.batch !== undefined) batch = !!opts.batch;
    batchSamples = opts.batch_samples ?? (batch ? batchSize(opts, single) : 0);
    if (batch && batchSamples < 1)
      throw new TypeError('expected at least one iteration per batched sample');

    const body = !batch
      ? 'yield void 0;'
      : `
        for (let o = 0; o < ${(batchSamples / opts.batch_unroll) | 0}; o++) {
          ${Array.from({ length: opts.batch_unroll }, () => 'yield void 0;').join(' ')}
        }
        ${Array.from({ length: batchSamples % opts.batch_unroll }, () => 'yield void 0;').join(' ')}
      `;
    const loop: Generator = new GeneratorFunction(
      '$gc',
      '$now',
      '$samples',
      '$state',
      '$observation',
      (_.debug = `
      let _ = 0; let t = 0;
      ${!opts.gc ? '' : '$gc();'}
      ${!observation ? '' : '$observation.start();'}

      for (; _ < ${samples.length}; _++) {
        if (_ >= ${opts.min_samples} && t >= ${opts.min_cpu_time}) break;
        const t0 = $now();
        ${body}
        const diff = $now() - t0;
        $samples[_] = diff ${!batch ? '' : `/ ${batchSamples}`};
        t += diff;
      }

      $state.count = _;
      $state.timed = t;
      $state.iterations = _ * ${batch ? batchSamples : 1};
      ${!observation ? '' : `$state.gc = $observation.finish(t, $state.iterations, ${now === runtimeNow});`}
    `)
    )(opts.gc, opts.now, samples, _, observation);

    _.batch = batch;
    _.next = loop.next.bind(loop);
    yield void 0;
  })();

  try {
    await iter(((_.next = gen.next.bind(gen)), ctx));
    if (_.gc) _.gc = await _.gc;
  } finally {
    observation?.cancel();
  }
  if (_.iterations === undefined)
    throw new TypeError('expected iterator to consume all measurement iterations');
  if (_.count < opts.min_samples)
    throw new TypeError(`expected at least ${opts.min_samples} samples from iterator`);

  return {
    ...summarizeSamples(samples, _.count),
    kind: 'iter' as const,
    plan: {
      batch: !!_.batch,
      batch_samples: batchSamples,
      batch_unroll: opts.batch_unroll,
      samples: _.count,
    },
    debug: _.debug,
    ...(_.unsettled ? { unsettled: true } : {}),
    ticks: _.count * (!_.batch ? 1 : batchSamples),
    ...(_.gc ? { gc: _.gc } : {}),
  };
}
