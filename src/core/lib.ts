import type { FnKind, MeasureOptions, Stats } from './types.ts';

const AsyncFunction = (async () => {}).constructor as any;
const GeneratorFunction = function* () {}.constructor as any;
const AsyncGeneratorFunction = async function* () {}.constructor as any;

const _sink: { _: any; __(): void } = {
  _: null,
  __() {
    _print(_sink._);
  },
};

export function do_not_optimize(v: any): void {
  _sink._ = v;
}

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

export const _print: (s: any) => void = (() => {
  if (globalThis.console?.log) return globalThis.console.log;
  if ((globalThis as any).print && !globalThis.document) return (globalThis as any).print;

  return () => {
    throw new Error('no print function available');
  };
})();

export const gc: (() => void) & { fallback?: boolean } = (() => {
  const g = globalThis as any;
  try {
    return (g.Bun.gc(true), () => g.Bun.gc(true));
  } catch {}
  try {
    return (g.gc(), () => g.gc());
  } catch {}
  try {
    return (g.__gc(), () => g.__gc());
  } catch {}
  try {
    return (g.std.gc(), () => g.std.gc());
  } catch {}
  try {
    return (g.$262.gc(), () => g.$262.gc());
  } catch {}
  try {
    return (g.tjs.engine.gc.run(), () => g.tjs.engine.gc.run());
  } catch {}
  return Object.assign(g.Graal ? () => new Uint8Array(2 ** 29) : () => new Uint8Array(2 ** 30), {
    fallback: true,
  });
})();

export const now: () => number = (() => {
  const g = globalThis as any;
  try {
    g.Bun.nanoseconds();
    return g.Bun.nanoseconds;
  } catch {}
  try {
    (_sink as any).agent.monotonicNow();
    return () => 1e6 * (_sink as any).agent.monotonicNow();
  } catch {}
  try {
    g.$262.agent.monotonicNow();
    return () => 1e6 * g.$262.agent.monotonicNow();
  } catch {}
  try {
    const _now = performance.now.bind(performance);
    _now();
    return () => 1e6 * _now();
  } catch {
    return () => 1e6 * Date.now();
  }
})();

export function kind(fn: any, _: boolean = false): FnKind | undefined {
  if (
    !(
      fn instanceof Function ||
      fn instanceof AsyncFunction ||
      fn instanceof GeneratorFunction ||
      fn instanceof AsyncGeneratorFunction
    )
  )
    return;

  if (fn instanceof GeneratorFunction || fn instanceof AsyncGeneratorFunction) return 'yield';

  if ((_ ? true : 0 === fn.length) && (fn instanceof Function || fn instanceof AsyncFunction))
    return 'fn';

  if (0 !== fn.length && (fn instanceof Function || fn instanceof AsyncFunction)) return 'iter';
}

// ── constants ──────────────────────────────────────────────────────

const k_cpu_time_rescale_heap = 1.1;
const k_cpu_time_rescale_inner_gc = 2;

export const k_concurrency = 1;
export const k_min_samples = 12;
export const k_batch_unroll = 4;
export const k_max_samples = 1e9;
export const k_warmup_samples = 2;
export const k_batch_samples = 4096;
export const k_samples_threshold = 12;
export const k_batch_threshold = 65536;
export const k_min_cpu_time = 642 * 1e6;
export const k_warmup_threshold = 500_000;

// ── defaults ───────────────────────────────────────────────────────

function defaults(opts: any): void {
  opts.gc ??= gc;
  opts.now ??= now;
  opts.heap ??= null;
  opts.params ??= {};
  opts.manual ??= false;
  opts.inner_gc ??= false;
  opts.$counters ??= false;
  opts.concurrency ??= k_concurrency;
  opts.min_samples ??= k_min_samples;
  opts.max_samples ??= k_max_samples;
  opts.min_cpu_time ??= k_min_cpu_time;
  opts.batch_unroll ??= k_batch_unroll;
  opts.batch_samples ??= k_batch_samples;
  opts.warmup_samples ??= k_warmup_samples;
  opts.batch_threshold ??= k_batch_threshold;
  opts.warmup_threshold ??= k_warmup_threshold;
  opts.samples_threshold ??= k_samples_threshold;
  opts.adaptive ??= true;
  opts.max_cpu_time ??= 5e9;
  if (opts.target_rel_ci === undefined) {
    opts.target_rel_ci =
      opts.adaptive === false ? 0 : opts.adaptive === true ? 0.025 : +opts.adaptive;
  }

  if (opts.heap) opts.min_cpu_time *= k_cpu_time_rescale_heap;
  if (opts.gc && opts.inner_gc) opts.min_cpu_time *= k_cpu_time_rescale_inner_gc;
}

// ── fn benchmark (codegen) ─────────────────────────────────────────

export async function benchFn(fn: (...args: any[]) => any, opts: any = {}): Promise<Stats> {
  defaults(opts);
  let async = false;
  let batch = false;
  const params: string[] = Object.keys(opts.params);

  warmup: {
    const $p = new Array(params.length);

    for (let o = 0; o < params.length; o++) {
      $p[o] = await opts.params[o]();
    }

    const t0 = now();
    const r = fn(...$p);
    let t1 = now();
    if ((async = r instanceof Promise)) (await r, (t1 = now()));

    if (t1 - t0 <= opts.warmup_threshold) {
      for (let o = 0; o < opts.warmup_samples; o++) {
        for (let oo = 0; oo < params.length; oo++) {
          $p[oo] = await opts.params[oo]();
        }

        const t0 = now();
        await fn(...$p);
        const t1 = now();
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
    ...(await loop(fn, opts.gc, opts.now, opts.heap, opts.params, opts.$counters)),
  };
}

// ── iter benchmark (codegen) ───────────────────────────────────────

export async function benchIter(iter: (...args: any[]) => any, opts: any = {}): Promise<Stats> {
  const _: any = {};
  defaults(opts);
  let samples = new Array(2 ** 20);
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
            ${new Array(opts.batch_unroll).fill('yield void 0;').join(' ')}
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
