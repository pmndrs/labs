import type { MeasureOptions, Stats } from '../types.ts';
import { AsyncFunction, GeneratorFunction, kind, now } from './runtime.ts';
import { defaults } from './constants.ts';

/**
 * Measure the performance of `f` by dispatching to the appropriate benchmark
 * engine ({@link benchFn}, {@link benchIter}, or {@link benchGenerator})
 * based on its {@link kind}.
 */
export async function measure(f: (...args: any[]) => any, opts: MeasureOptions = {}): Promise<Stats> {
  const dispatch: Record<string, (f: any, opts?: any) => Promise<Stats>> = {
    fn: benchFn,
    iter: benchIter,
    yield: benchGenerator,
    [void 0 as any]() {
      throw new TypeError('expected iterator, generator or one-shot function');
    },
  };
  return await dispatch[kind(f) as any](f, opts);
}

/**
 * Benchmark adapter for generator functions.
 *
 * The generator yields a benchmarkable function (or an options object with a
 * `bench` / `manual` key) and is resumed after measurement completes.
 * Delegates the actual timing to {@link benchFn}.
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
  if (!(await g.next()).done) throw new TypeError('expected generator to yield once');

  return {
    ...stats,
    kind: 'yield' as const,
  };
}

/**
 * Core benchmark engine for zero-arg and parameterised functions.
 *
 * Generates an {@link AsyncFunction} loop at runtime that handles warm-up,
 * batching, parameter injection, heap tracking, inner GC, hardware counters,
 * and adaptive stopping via Welford's online variance (when `target_rel_ci`
 * is set).  The generated source is attached as `debug` on the returned stats.
 */
export async function benchFn(fn: (...args: any[]) => any, opts: any = {}): Promise<Stats> {
  defaults(opts);
  let async = false;
  let batch = false;
  const params: string[] = Object.keys(opts.params);

  warmup: {
    const $p = Array.from({ length: params.length }, () => 0);

    for (let o = 0; o < params.length; o++) {
      $p[o] = await opts.params[o]();
    }

    const t0 = now();
    const r = fn(...$p);
    let t1 = now();

    if ((async = r instanceof Promise)) {
      await r;
      t1 = now();
    }

    if (opts.after) await opts.after();

    if (t1 - t0 <= opts.warmup_threshold) {
      for (let o = 0; o < opts.warmup_samples; o++) {
        for (let oo = 0; oo < params.length; oo++) {
          $p[oo] = await opts.params[oo]();
        }

        const t0 = now();
        await fn(...$p);
        const t1 = now();
        if (opts.after) await opts.after();
        if ((batch = t1 - t0 <= opts.batch_threshold)) break;
      }
    }
  }

  if (opts.manual) {
    batch = false;
    opts.concurrency = 1;
  }

  const loop: (...args: any[]) => Promise<any> = new AsyncFunction(
    '$fn',
    '$gc',
    '$now',
    '$heap',
    '$params',
    '$counters',
    '$after',
    `
    ${!opts.$counters ? '' : 'let _hc = false;'}
    ${!opts.$counters ? '' : 'try { $counters.init(); _hc = true; } catch {}'}

    let _ = 0; let t = 0;
    let samples = new Array(2 ** 20);
    ${!opts.target_rel_ci ? '' : 'let _lm = 0; let _lm2 = 0; let _noisy = false;'}
    ${!opts.heap ? '' : 'const heap = { _: 0, total: 0, min: Infinity, max: -Infinity };'}
    ${!(opts.gc && opts.inner_gc && !opts.gc.fallback) ? '' : 'const gc = { total: 0, min: Infinity, max: -Infinity };'}

    ${
      !params.length
        ? ''
        : Array.from({ length: params.length }, (_, o) =>
            `
      ${Array.from({ length: opts.concurrency }, (_, c) =>
        `
        let param_${o}_${c} = ${!batch ? 'null' : `new Array(${opts.batch_samples})`};
      `.trim()
      ).join(' ')}
    `.trim()
          ).join('\n')
    }

    ${!opts.gc ? '' : `$gc();`}

    for (; _ < ${opts.max_samples}; _++) {
      ${!opts.target_rel_ci ? `if (_ >= ${opts.min_samples} && t >= ${opts.min_cpu_time}) break;` : ''}

      ${
        !params.length
          ? ''
          : `
        ${
          !batch
            ? `
          ${Array.from({ length: params.length }, (_, o) =>
            `
            ${Array.from({ length: opts.concurrency }, (_, c) =>
              `
              if ((param_${o}_${c} = $params[${o}]()) instanceof Promise) param_${o}_${c} = await param_${o}_${c};
            `.trim()
            ).join(' ')}
          `.trim()
          ).join('\n')}
        `
            : `
          for (let o = 0; o < ${opts.batch_samples}; o++) {
            ${Array.from({ length: params.length }, (_, o) =>
              `
              ${Array.from({ length: opts.concurrency }, (_, c) =>
                `
                if ((param_${o}_${c}[o] = $params[${o}]()) instanceof Promise) param_${o}_${c}[o] = await param_${o}_${c}[o];
              `.trim()
              ).join(' ')}
            `.trim()
            ).join('\n')}
          }
        `
        }
      `
      }

      ${
        !(opts.gc && opts.inner_gc)
          ? ''
          : `
        igc: {
          const t0 = $now();
          $gc(); t += $now() - t0;
        }
      `
      }

      ${!opts.manual ? '' : 'let t2 = 0;'}
      ${!opts.heap ? '' : 'const h0 = $heap();'}
      ${!opts.$counters ? '' : 'if (_hc) try { $counters.before(); } catch {};'} const t0 = $now();

      ${
        !batch
          ? `
        ${!async ? '' : 1 >= opts.concurrency ? '' : 'await Promise.all(['}
          ${Array.from({ length: opts.concurrency }, (_, c) =>
            `
            ${!opts.manual ? '' : 't2 +='} ${!async ? '' : 1 < opts.concurrency ? '' : 'await'} ${(!params.length
              ? `
              $fn()
            `
              : `
              $fn(${Array.from({ length: params.length }, (_, o) => `param_${o}_${c}`).join(', ')})
            `
            ).trim()}${!async ? ';' : 1 < opts.concurrency ? ',' : ';'}
          `.trim()
          ).join('\n')}
        ${!async ? '' : 1 >= opts.concurrency ? '' : `]);`}
      `
          : `
        for (let o = 0; o < ${(opts.batch_samples / opts.batch_unroll) | 0}; o++) {
          ${!params.length ? '' : `const param_offset = o * ${opts.batch_unroll};`}

          ${Array.from({ length: opts.batch_unroll }, (_, u) =>
            `
            ${!async ? '' : 1 >= opts.concurrency ? '' : 'await Promise.all(['}
              ${Array.from({ length: opts.concurrency }, (_, c) =>
                `
                ${!async ? '' : 1 < opts.concurrency ? '' : 'await'} ${(!params.length
                  ? `
                  $fn()
                `
                  : `
                  $fn(${Array.from({ length: params.length }, (_, o) => `param_${o}_${c}[${u === 0 ? '' : `${u} + `}param_offset]`).join(', ')})
                `
                ).trim()}${!async ? ';' : 1 < opts.concurrency ? ',' : ';'}
              `.trim()
              ).join(' ')}
            ${!async ? '' : 1 >= opts.concurrency ? '' : ']);'}
          `.trim()
          ).join('\n')}
        }
      `
      }

      const t1 = $now();
      ${!opts.$counters ? '' : 'if (_hc) try { $counters.after(); } catch {};'}

      ${
        !opts.heap
          ? ''
          : `
        heap: {
          const t0 = $now();
          const h1 = ($heap() - h0) ${!batch ? '' : `/ ${opts.batch_samples}`}; t += $now() - t0;

          if (0 <= h1) {
            heap._++;
            heap.total += h1;
            heap.min = Math.min(h1, heap.min);
            heap.max = Math.max(h1, heap.max);
          }
        }
      `
      }

      ${
        !(opts.gc && opts.inner_gc && !opts.gc.fallback)
          ? ''
          : `
        igc: {
          const t0 = $now();
          $gc(); const t1 = $now() - t0;

          t += t1;
          gc.total += t1;
          gc.min = Math.min(t1, gc.min);
          gc.max = Math.max(t1, gc.max);
        }
      `
      };

      const diff = ${opts.manual ? 't2' : 't1 - t0'};
      t += ${'manual' === opts.manual ? 't2' : 't1 - t0'};
      samples[_] = diff ${!batch ? '' : `/ ${opts.batch_samples}`};
      ${!opts.after ? '' : 'await $after();'}
      ${
        !opts.target_rel_ci
          ? ''
          : `
      if (samples[_] > 0) {
        const _lx = Math.log(samples[_]);
        const _ld = _lx - _lm;
        _lm += _ld / (_ + 1);
        _lm2 += _ld * (_lx - _lm);
        if (_ + 1 >= ${opts.min_samples} && t >= ${opts.min_cpu_time} && _lm2 / (_ * (_ + 1)) <= ${Math.log(1 + opts.target_rel_ci) ** 2}) { _++; break; }
      }
      if (t >= ${opts.max_cpu_time}) { _noisy = true; _++; break; }
      `
      }
    }

    samples.length = _;
    samples.sort((a, b) => a - b);
    if (samples.length > ${opts.samples_threshold}) samples = samples.slice(2, -2);

    return {
      samples,
      min: samples[0],
      max: samples[samples.length - 1],
      p25: samples[(.25 * (samples.length - 1)) | 0],
      p50: samples[(.50 * (samples.length - 1)) | 0],
      p75: samples[(.75 * (samples.length - 1)) | 0],
      p99: samples[(.99 * (samples.length - 1)) | 0],
      p999: samples[(.999 * (samples.length - 1)) | 0],
      avg: samples.reduce((a, v) => a + v, 0) / samples.length,
      ticks: samples.length ${!batch ? '' : `* ${opts.batch_samples}`},
      ${!opts.heap ? '' : 'heap: { ...heap, avg: heap.total / heap._ },'}
      ${!(opts.gc && opts.inner_gc && !opts.gc.fallback) ? '' : 'gc: { ...gc, avg: gc.total / _ },'}
      ${!opts.$counters ? '' : `...(!_hc ? {} : { counters: $counters.translate(${!batch ? 1 : opts.batch_samples}, _) }),`}
      ${!opts.target_rel_ci ? '' : 'noisy: _noisy,'}
    };

    ${!opts.$counters ? '' : 'if (_hc) try { $counters.deinit(); } catch {};'}
  `
  );

  return {
    kind: 'fn' as const,
    debug: loop.toString(),
    ...(await loop(fn, opts.gc, opts.now, opts.heap, opts.params, opts.$counters, opts.after)),
  };
}

/**
 * Benchmark engine for iterator-style benchmarks.
 *
 * The caller receives an iterable context; each `for..of` / `for await..of`
 * iteration is one timed sample.  Internally a {@link GeneratorFunction} loop
 * is code-generated with the same adaptive-stopping and batching logic as
 * {@link benchFn}.
 */
export async function benchIter(iter: (...args: any[]) => any, opts: any = {}): Promise<Stats> {
  const _: any = {};
  defaults(opts);
  let samples = Array.from({ length: 2 ** 20 }, () => 0);
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

    warmup: {
      const t0 = now();
      yield void 0;
      const t1 = now();

      if (t1 - t0 <= opts.warmup_threshold) {
        for (let o = 0; o < opts.warmup_samples; o++) {
          const t0 = now();
          yield void 0;
          const t1 = now();
          if ((batch = t1 - t0 <= opts.batch_threshold)) break;
        }
      }
    }

    const loop: Generator = new GeneratorFunction(
      '$gc',
      '$now',
      '$samples',
      '$state',
      (_.debug = `
      let _ = 0; let t = 0;
      ${!opts.target_rel_ci ? '' : 'let _lm = 0; let _lm2 = 0;'}

      ${!opts.gc ? '' : `$gc();`}

      for (; _ < ${opts.max_samples}; _++) {
        ${!opts.target_rel_ci ? `if (_ >= ${opts.min_samples} && t >= ${opts.min_cpu_time}) break;` : ''}

        ${
          !(opts.gc && opts.inner_gc)
            ? ''
            : `
          let inner_gc_cost = 0;

          igc: {
            const t0 = $now(); $gc();
            inner_gc_cost = $now() - t0;
          }
        `
        }

        const t0 = $now();
        
        ${
          !batch
            ? 'yield void 0;'
            : `
          for (let o = 0; o < ${(opts.batch_samples / opts.batch_unroll) | 0}; o++) {
            ${Array.from({ length: opts.batch_unroll }, () => 'yield void 0;').join(' ')}
          }
        `
        }

        const t1 = $now();
        const diff = t1 - t0;

        $samples[_] = diff ${!batch ? '' : `/ ${opts.batch_samples}`};
        t += diff ${!(opts.gc && opts.inner_gc) ? '' : '+ inner_gc_cost'};
        ${
          !opts.target_rel_ci
            ? ''
            : `
        if ($samples[_] > 0) {
          const _lx = Math.log($samples[_]);
          const _ld = _lx - _lm;
          _lm += _ld / (_ + 1);
          _lm2 += _ld * (_lx - _lm);
          if (_ + 1 >= ${opts.min_samples} && t >= ${opts.min_cpu_time} && _lm2 / (_ * (_ + 1)) <= ${Math.log(1 + opts.target_rel_ci) ** 2}) { _++; break; }
        }
        if (t >= ${opts.max_cpu_time}) { $state.noisy = true; _++; break; }
        `
        }
      }

      $samples.length = _;
    `)
    )(opts.gc, opts.now, samples, _);

    _.batch = batch;
    _.next = loop.next.bind(loop);
    yield void 0;
  })();

  await iter(((_.next = gen.next.bind(gen)), ctx));
  if (samples.length < opts.min_samples)
    throw new TypeError(`expected at least ${opts.min_samples} samples from iterator`);

  samples.sort((a, b) => a - b);
  if (samples.length > opts.samples_threshold) samples = samples.slice(2, -2);

  return {
    samples,
    kind: 'iter' as const,
    debug: _.debug,
    min: samples[0],
    max: samples[samples.length - 1],
    p25: samples[(0.25 * (samples.length - 1)) | 0],
    p50: samples[(0.5 * (samples.length - 1)) | 0],
    p75: samples[(0.75 * (samples.length - 1)) | 0],
    p99: samples[(0.99 * (samples.length - 1)) | 0],
    p999: samples[(0.999 * (samples.length - 1)) | 0],
    avg: samples.reduce((a, v) => a + v, 0) / samples.length,
    ticks: samples.length * (!_.batch ? 1 : opts.batch_samples),
    ...(opts.target_rel_ci ? { noisy: _.noisy ?? false } : {}),
  };
}
