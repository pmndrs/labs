export { measure } from './lib/measure.ts';
export { do_not_optimize } from './lib/runtime.ts';
import { kind, _print } from './lib/runtime.ts';
import { measure } from './lib/measure.ts';
import { ansi, COLOR_NAMES } from '../utils/ansi.ts';
import { min as arrMin, max as arrMax } from '../utils/math.ts';
import { truncate, formatNs, formatBytes, formatAmount } from '../utils/units.ts';
import * as histogramFmt from './format/histogram.ts';
import * as boxplotFmt from './format/boxplot.ts';
import * as barplotFmt from './format/barplot.ts';
import * as lineplotFmt from './format/lineplot.ts';
import type { Collection, Trial, Context, Stats } from './types.ts';
import { colors, cpu, version, runtime, arch } from './env.ts';

let FLAGS = 0;
let $counters: any = null;
let COLLECTIONS: Collection[] = [{ id: 0, name: null, types: [], trials: [] }];

export const flags = {
  compact: 1 << 0,
  baseline: 1 << 1,
};

export class B {
  f: ((...args: any[]) => any) | null = null;
  _args: Record<string, any[]> = {};
  _name: string = '';
  _group: number = 0;
  _gc: string | boolean = 'once';
  flags: number = FLAGS;
  _highlight: string | false = false;

  constructor(name: string, f: any) {
    this.f = f;
    this.name(name);
    if (!kind(f)) throw new TypeError('expected iterator, generator or one-shot function');
  }

  name(name: string, color: string | false = false): this {
    return ((this._name = name), this.highlight(color), this);
  }

  gc(gc: string | boolean = 'once'): this {
    if (![true, false, 'once', 'inner'].includes(gc as any)) throw new TypeError('invalid gc type');
    return ((this._gc = gc), this);
  }

  highlight(color: string | false = false): this {
    if (!color) return ((this._highlight = false), this);
    if (!COLOR_NAMES.includes(color)) throw new TypeError('invalid highlight color');
    return ((this._highlight = color), this);
  }

  compact(bool = true): this {
    if (bool) return ((this.flags |= flags.compact), this);
    if (!bool) return ((this.flags &= ~flags.compact), this);
    return this;
  }

  baseline(bool = true): this {
    if (bool) return ((this.flags |= flags.baseline), this);
    if (!bool) return ((this.flags &= ~flags.baseline), this);
    return this;
  }

  range(name: string, s: number, e: number, m = 8): this {
    const arr: number[] = [];
    for (let o = s; o <= e; o *= m) arr.push(Math.min(o, e));
    if (!arr.includes(e)) arr.push(e);
    return this.args(name, arr);
  }

  dense_range(name: string, s: number, e: number, a = 1): this {
    const arr: number[] = [];
    for (let o = s; o <= e; o += a) arr.push(o);
    if (!arr.includes(e)) arr.push(e);
    return this.args(name, arr);
  }

  args(name: any, args?: any): this {
    if (name === null) return (delete this._args.x, this);
    if (Array.isArray(name)) return ((this._args.x = name), this);
    if (null === args && 'string' === typeof name) return (delete this._args[name], this);
    if (Array.isArray(args) && 'string' === typeof name) return ((this._args[name] = args), this);

    if (null !== name && 'object' === typeof name) {
      for (const key in name) {
        const v = name[key];
        if (v == null) delete this._args[key];
        else if (Array.isArray(v)) this._args[key] = v;
        else throw new TypeError('invalid arguments map value');
      }

      return this;
    }

    throw new TypeError('invalid arguments');
  }

  *_names(): Generator<string> {
    const args = Object.keys(this._args);
    const kind = 0 === args.length ? 'static' : 1 === args.length ? 'args' : 'multi-args';

    if (kind === 'static') {
      yield this._name;
    } else {
      const offsets = Array.from<number>({ length: args.length }).fill(0);
      const runs = args.reduce((len: number, name: string) => len * this._args[name].length, 1);

      for (let o = 0; o < runs; o++) {
        {
          const _args: Record<string, any> = {};
          let _name = this._name;
          for (let oo = 0; oo < args.length; oo++)
            _args[args[oo]] = this._args[args[oo]][offsets[oo]];
          for (let oo = 0; oo < args.length; oo++)
            _name = _name.replaceAll(`\$${args[oo]}`, _args[args[oo]]);

          yield _name;
        }

        let offset = 0;
        do {
          offsets[offset] = (1 + offsets[offset]) % this._args[args[offset]].length;
        } while (0 === offsets[offset++] && offset < args.length);
      }
    }
  }

  async run(thrw = false, _tune: any = {}): Promise<Trial> {
    const args = Object.keys(this._args);
    const kind = 0 === args.length ? 'static' : 1 === args.length ? 'args' : 'multi-args';

    const tune = {
      $counters,
      inner_gc: 'inner' === this._gc,
      gc: !this._gc ? false : undefined,
      ..._tune,

      heap: await (async () => {
        if ((globalThis as any).Bun) {
          const _m = 'bun:jsc';
          const { memoryUsage } = await import(_m);
          return () => {
            const m = memoryUsage();
            return m.current;
          };
        }

        try {
          const _v8 = 'node:v8';
          const { getHeapStatistics } = await import(_v8);
          getHeapStatistics();
          return () => {
            const m = getHeapStatistics();
            return m.used_heap_size + m.malloced_memory;
          };
        } catch {}
      })(),
    };

    if (kind === 'static') {
      let stats: Stats | undefined, error: unknown;
      try {
        stats = await measure(this.f!, tune);
      } catch (err) {
        error = err;
        if (thrw) throw err;
      }

      return {
        kind,
        args: this._args,
        alias: this._name,
        group: this._group,
        baseline: !!(this.flags & flags.baseline),

        runs: [
          {
            stats,
            error,
            args: {},
            name: this._name,
          },
        ],

        style: {
          highlight: this._highlight,
          compact: !!(this.flags & flags.compact),
        },
      } as Trial;
    } else {
      const offsets = Array.from({ length: args.length }, () => 0);
      const runCount = args.reduce((len: number, name: string) => len * this._args[name].length, 1);
      const runs: any[] = Array.from({ length: runCount });

      for (let o = 0; o < runs.length; o++) {
        {
          let stats: Stats | undefined, error: unknown;
          const _args: Record<string, any> = {};
          let _name = this._name;
          for (let oo = 0; oo < args.length; oo++)
            _args[args[oo]] = this._args[args[oo]][offsets[oo]];
          for (let oo = 0; oo < args.length; oo++)
            _name = _name.replaceAll(`\$${args[oo]}`, _args[args[oo]]);
          try {
            stats = await measure(this.f!, { ...tune, args: _args });
          } catch (err) {
            error = err;
            if (thrw) throw err;
          }

          runs[o] = {
            stats,
            error,
            args: _args,
            name: _name,
          };
        }

        let offset = 0;
        do {
          offsets[offset] = (1 + offsets[offset]) % this._args[args[offset]].length;
        } while (0 === offsets[offset++] && offset < args.length);
      }

      return {
        runs,
        kind,
        args: this._args,
        alias: this._name,
        group: this._group,
        baseline: !!(this.flags & flags.baseline),

        style: {
          highlight: this._highlight,
          compact: !!(this.flags & flags.compact),
        },
      } as Trial;
    }
  }
}

// ------ collections ------

export function boxplot(f: () => any): void | Promise<void> {
  return _c(f, 'x');
}
export function barplot(f: () => any): void | Promise<void> {
  return _c(f, 'b');
}
export function summary(f: () => any): void | Promise<void> {
  return _c(f, 's');
}
export function lineplot(f: () => any): void | Promise<void> {
  return _c(f, 'l');
}
export function group(name: any, f?: () => any): void | Promise<void> {
  if (typeof name === 'function') {
    f = name;
    name = null;
  }
  return _c(f!, 'g', name);
}

export function bench(n: any, fn?: any): B {
  if (typeof n === 'function') {
    fn = n;
    n = fn.name || 'anonymous';
  }

  const collection = COLLECTIONS[COLLECTIONS.length - 1];
  const b = new B(n, fn);
  b._group = collection.id;
  return (collection.trials.push(b), b);
}

export function compact(f: () => any): void | Promise<void> {
  const old = FLAGS;
  FLAGS |= flags.compact;

  const r = f();
  if (!(r instanceof Promise)) FLAGS = old;
  else return r.then(() => ((FLAGS = old), void 0));
}

const _c = (f: () => any, t: string, name: string | null = null): void | Promise<void> => {
  const last = COLLECTIONS[COLLECTIONS.length - 1];
  COLLECTIONS.push({
    trials: [],
    name: name ?? last.name,
    id: COLLECTIONS.length,
    types: [t, ...last.types],
  });

  const r = f();
  const n: Collection = { trials: [], name: last.name, types: last.types, id: COLLECTIONS.length };
  if (!(r instanceof Promise)) COLLECTIONS.push(n);
  else return r.then(() => (COLLECTIONS.push(n), void 0));
};

// ------ run ------

function defaults(opts: any): void {
  opts.print ??= _print;
  opts.throw ??= false;
  opts.filter ??= /.*/;
  opts.format ??= 'mitata';
  opts.colors ??= colors();
  opts.tune ??= {};
  opts.observe ??= (trial: any) => trial;
}

export async function run(
  opts: any = {}
): Promise<{ layout: any[]; context: Context; benchmarks: Trial[] }> {
  defaults(opts);
  const t = Date.now();
  const benchmarks: Trial[] = [];
  const cal = opts.calibrate ?? {};
  const noop = await measure(() => {}, cal);
  const _cpu = await measure(() => {}, { ...cal, batch_unroll: 1 });
  const noop_inner_gc = await measure(() => {}, { ...cal, inner_gc: true });
  const noop_iter = await measure((state: any) => {
    for (const _ of state);
  }, cal);

  const context: Context = {
    now: t,
    arch: await arch(),
    version: version(),
    runtime: runtime(),

    cpu: {
      name: await cpu(),
      freq: 1 / _cpu.avg,
    },

    noop: {
      fn: noop,
      iter: noop_iter,
      fn_gc: noop_inner_gc,
    },
  };

  if (
    !$counters &&
    context.arch?.includes?.('darwin') &&
    ['bun', 'node', 'deno'].includes(context.runtime as string)
  ) {
    try {
      const _c = '@mitata/counters';
      $counters = await import(_c);
      if (0 !== (globalThis as any).process.getuid()) throw (($counters = false), 1);
    } catch {}
  }

  if (
    !$counters &&
    context.arch?.includes?.('linux') &&
    ['bun', 'node', 'deno'].includes(context.runtime as string)
  ) {
    try {
      const _c = '@mitata/counters';
      $counters = await import(_c);
    } catch (err: any) {
      if (err?.message?.includes?.('PermissionDenied')) $counters = false;
    }
  }

  const layout = COLLECTIONS.map((c) => ({ name: c.name, types: c.types }));
  const format = 'string' === typeof opts.format ? opts.format : Object.keys(opts.format)[0];
  await (formats as any)[format](
    context,
    { ...opts, format: opts.format[format] },
    benchmarks,
    layout
  );
  return (
    (COLLECTIONS = [{ name: 0, types: [], trials: [] }] as any),
    { layout, context, benchmarks }
  );
}

const formats = {
  async quiet(_: any, opts: any, benchmarks: Trial[]) {
    for (const collection of COLLECTIONS) {
      for (const trial of collection.trials) {
        if (opts.filter.test(trial._name))
          benchmarks.push(opts.observe(await trial.run(opts.throw, opts.tune)));
      }
    }
  },

  async json(ctx: any, opts: any, benchmarks: Trial[], layout: any[]) {
    const print = opts.print;
    const debug = opts.format?.debug ?? true;
    const samples = opts.format?.samples ?? true;

    for (const collection of COLLECTIONS) {
      for (const trial of collection.trials) {
        if (opts.filter.test(trial._name))
          benchmarks.push(opts.observe(await trial.run(opts.throw, opts.tune)));
      }
    }

    print(
      JSON.stringify(
        {
          layout,
          benchmarks,
          context: ctx,
        },
        (k: string, v: any) => {
          if (!debug && k === 'debug') return '';
          if (!samples && k === 'samples') return null;

          if (!(v instanceof Error)) return v;
          return { message: String(v.message), stack: v.stack };
        },
        0
      )
    );
  },

  async markdown(ctx: any, opts: any, benchmarks: Trial[]) {
    let first = true;
    const print = opts.print;

    print(`clk: ~${ctx.cpu.freq.toFixed(2)} GHz`);
    print(`cpu: ${ctx.cpu.name}`);
    print(`runtime: ${ctx.runtime}${!ctx.version ? '' : ` ${ctx.version}`} (${ctx.arch})`);

    print('');

    for (const collection of COLLECTIONS) {
      const trials: Trial[] = [];
      if (!collection.trials.length) continue;

      for (const trial of collection.trials) {
        if (opts.filter.test(trial._name)) {
          let bench = await trial.run(opts.throw, opts.tune);

          bench = opts.observe(bench);
          trials.push(bench);
          benchmarks.push(bench);
        }
      }

      if (!trials.length) continue;
      if (!first) print('');
      const name_len = trials.reduce(
        (a: number, b: Trial) =>
          Math.max(
            a,
            b.runs.reduce((a: number, b: any) => Math.max(a, b.name.length), 0)
          ),
        0
      );
      print(
        `| ${(collection.name ? `• ${collection.name}` : !first ? '' : 'benchmark').padEnd(name_len)} | ${'avg'.padStart(2 + 14)} | ${'min'.padStart(2 + 9)} | ${'p75'.padStart(2 + 9)} | ${'p99'.padStart(2 + 9)} | ${'max'.padStart(2 + 9)} |`
      );
      print(
        `| ${'-'.repeat(name_len)} | ${'-'.repeat(2 + 14)} | ${'-'.repeat(2 + 9)} | ${'-'.repeat(2 + 9)} | ${'-'.repeat(2 + 9)} | ${'-'.repeat(2 + 9)} |`
      );

      first = false;

      for (const trial of trials) {
        for (const run of trial.runs) {
          if (run.error)
            print(
              `| ${run.name.padEnd(name_len)} | error: ${(run.error as any).message ?? run.error} |`
            );
          else
            print(
              `| ${run.name.padEnd(name_len)} | \`${`${formatNs(run.stats!.avg)}/iter`.padStart(14)}\` | \`${formatNs(run.stats!.min).padStart(9)}\` | \`${formatNs(run.stats!.p75).padStart(9)}\` | \`${formatNs(run.stats!.p99).padStart(9)}\` | \`${formatNs(run.stats!.max).padStart(9)}\` |`
            );
        }
      }
    }
  },

  async mitata(ctx: any, opts: any, benchmarks: Trial[]) {
    const print = opts.print;
    let k_legend: number | string = opts.format?.name ?? 'longest';

    if ('fixed' === k_legend) k_legend = 28;
    else if (k_legend === 'longest') {
      k_legend = 28;

      for (const collection of COLLECTIONS) {
        for (const trial of collection.trials) {
          if (opts.filter.test(trial._name)) {
            for (const name of trial._names()) {
              k_legend = Math.max(k_legend, name.length);
            }
          }
        }
      }
    }

    k_legend = Math.max(20, Number(k_legend));
    if (!opts.colors) print(`clk: ~${ctx.cpu.freq.toFixed(2)} GHz`);
    else print(ansi.gray + `clk: ~${ctx.cpu.freq.toFixed(2)} GHz` + ansi.reset);

    if (!opts.colors) print(`cpu: ${ctx.cpu.name}`);
    else print(ansi.gray + `cpu: ${ctx.cpu.name}` + ansi.reset);
    if (!opts.colors)
      print(`runtime: ${ctx.runtime}${!ctx.version ? '' : ` ${ctx.version}`} (${ctx.arch})`);
    else
      print(
        ansi.gray +
          `runtime: ${ctx.runtime}${!ctx.version ? '' : ` ${ctx.version}`} (${ctx.arch})` +
          ansi.reset
      );

    print('');
    print(`${'benchmark'.padEnd(k_legend - 1)} avg (min … max) p75 / p99    (min … top 1%)`);
    print('-'.repeat(15 + k_legend) + ' ' + '-'.repeat(31));

    let first = true;
    let optimized_out_warning = false;
    let noisy_warning = false;

    for (const collection of COLLECTIONS) {
      const trials: [any, Trial][] = [];
      let prev_run_gap = false;
      if (!collection.trials.length) continue;
      const has_matches = collection.trials.some((trial: any) => opts.filter.test(trial._name));

      if (!has_matches) continue;
      else if (first) {
        first = false;

        if (collection.name) {
          print(`• ${collection.name}`);
          if (!opts.colors) print('-'.repeat(15 + k_legend) + ' ' + '-'.repeat(31));
          else print(ansi.gray + '-'.repeat(15 + k_legend) + ' ' + '-'.repeat(31) + ansi.reset);
        }
      } else {
        print('');
        if (collection.name) print(`• ${collection.name}`);
        if (!opts.colors) print('-'.repeat(15 + k_legend) + ' ' + '-'.repeat(31));
        else print(ansi.gray + '-'.repeat(15 + k_legend) + ' ' + '-'.repeat(31) + ansi.reset);
      }

      for (const trial of collection.trials) {
        if (opts.filter.test(trial._name)) {
          let bench = await trial.run(opts.throw, opts.tune);

          bench = opts.observe(bench);
          trials.push([trial, bench]);
          benchmarks.push(bench);
          if (-1 === COLOR_NAMES.indexOf(trial._highlight)) trial._highlight = null;
          const _h =
            !opts.colors || !trial._highlight
              ? (x: string) => x
              : (x: string) => ansi[trial._highlight] + x + ansi.reset;

          for (const r of bench.runs) {
            if (prev_run_gap) print('');

            if (r.error) {
              if (!opts.colors)
                print(
                  `${_h(truncate(r.name, k_legend).padEnd(k_legend))} error: ${(r.error as any).message ?? r.error}`
                );
              else
                print(
                  `${_h(truncate(r.name, k_legend).padEnd(k_legend))} ${ansi.red + 'error:' + ansi.reset} ${(r.error as any).message ?? r.error}`
                );
            } else {
              const compact = trial.flags & flags.compact;
              const noop =
                'iter' === r.stats.kind
                  ? ctx.noop.iter
                  : trial._gc !== 'inner'
                    ? ctx.noop.fn
                    : ctx.noop.fn_gc;

              const optimized_out = r.stats.avg < 1.42 * noop.avg;
              optimized_out_warning = optimized_out_warning || optimized_out;

              const noisy = !!r.stats.noisy;
              noisy_warning = noisy_warning || noisy;

              if (compact) {
                let l = '';
                prev_run_gap = false;
                const avg = formatNs(r.stats.avg).padStart(9);
                const name = truncate(r.name, k_legend).padEnd(k_legend);

                if (noisy)
                  if (!opts.colors) l += '~ ';
                  else l += ansi.yellow + '~' + ansi.reset + ' ';
                l += _h(name) + ' ';
                if (!opts.colors) l += avg + '/iter';
                else
                  l += ansi.bold + ansi.yellow + avg + ansi.reset + ansi.bold + '/iter' + ansi.reset;

                const p75 = formatNs(r.stats.p75).padStart(9);
                const p99 = formatNs(r.stats.p99).padStart(9);
                const bins = histogramFmt.bins(r.stats, 11, 0.99);
                const histogram = histogramFmt.ascii(bins, 1, { colors: opts.colors });

                l += ' ';
                if (!opts.colors) l += p75 + ' ' + p99 + ' ' + histogram[0];
                else l += ansi.gray + p75 + ' ' + p99 + ansi.reset + ' ' + histogram[0];

                if (optimized_out)
                  if (!opts.colors) l += ' !';
                  else l += ansi.red + ' !' + ansi.reset;

                print(l);
              } else {
                let l = '';
                const avg = formatNs(r.stats.avg).padStart(9);
                const name = truncate(r.name, k_legend).padEnd(k_legend);

                if (noisy)
                  if (!opts.colors) l += '~ ';
                  else l += ansi.yellow + '~' + ansi.reset + ' ';
                l += _h(name) + ' ';
                const p75 = formatNs(r.stats.p75).padStart(9);
                const bins = histogramFmt.bins(r.stats, 21, 0.99);
                const histogram = histogramFmt.ascii(
                  bins,
                  r.stats.gc && r.stats.heap ? 2 : !(r.stats.gc || r.stats.heap) ? 2 : 3,
                  { colors: opts.colors }
                );

                if (!opts.colors) l += avg + '/iter' + ' ' + p75 + ' ' + histogram[0];
                else
                  l +=
                    ansi.bold +
                    ansi.yellow +
                    avg +
                    ansi.reset +
                    ansi.bold +
                    '/iter' +
                    ansi.reset +
                    ' ' +
                    ansi.gray +
                    p75 +
                    ansi.reset +
                    ' ' +
                    histogram[0];

                if (optimized_out)
                  if (!opts.colors) l += ' !';
                  else l += ansi.red + ' !' + ansi.reset;

                print(l);

                l = '';
                const min = formatNs(r.stats.min);
                const max = formatNs(r.stats.max);
                const p99 = formatNs(r.stats.p99).padStart(9);
                const diff = 2 * 9 - (min.length + max.length);

                l += ' '.repeat(diff + k_legend - 8);
                if (!opts.colors) l += '(' + min + ' … ' + max + ')';
                else
                  l +=
                    ansi.gray +
                    '(' +
                    ansi.reset +
                    ansi.cyan +
                    min +
                    ansi.reset +
                    ansi.gray +
                    ' … ' +
                    ansi.reset +
                    ansi.magenta +
                    max +
                    ansi.reset +
                    ansi.gray +
                    ')' +
                    ansi.reset;

                l += ' ';
                if (!opts.colors) l += p99 + ' ' + histogram[1];
                else l += ansi.gray + p99 + ansi.reset + ' ' + histogram[1];

                print(l);

                if (r.stats.gc) {
                  l = '';
                  prev_run_gap = true;
                  l += ' '.repeat(k_legend - 10);
                  const gcm = formatNs(r.stats.gc.min).padStart(9);
                  const gcx = formatNs(r.stats.gc.max).padStart(9);

                  if (!opts.colors) l += 'gc(' + gcm + ' … ' + gcx + ')';
                  else
                    l +=
                      ansi.gray +
                      'gc(' +
                      ansi.reset +
                      ansi.blue +
                      gcm +
                      ansi.reset +
                      ansi.gray +
                      ' … ' +
                      ansi.reset +
                      ansi.blue +
                      gcx +
                      ansi.reset +
                      ansi.gray +
                      ')' +
                      ansi.reset;

                  if (r.stats.heap) {
                    l += ' ';
                    const ha = formatBytes(r.stats.heap.avg).padStart(9);
                    const hm = formatBytes(r.stats.heap.min).padStart(9);
                    const hx = formatBytes(r.stats.heap.max).padStart(9);

                    if (!opts.colors) l += ha + ' (' + hm + '…' + hx + ')';
                    else
                      l +=
                        ansi.yellow +
                        ha +
                        ansi.reset +
                        ansi.gray +
                        ' (' +
                        ansi.reset +
                        ansi.yellow +
                        hm +
                        ansi.reset +
                        ansi.gray +
                        '…' +
                        ansi.reset +
                        ansi.yellow +
                        hx +
                        ansi.reset +
                        ansi.gray +
                        ')' +
                        ansi.reset;
                  } else {
                    l += ' ';
                    const gca = formatNs(r.stats.gc.avg).padStart(9);

                    if (!opts.colors) l += gca + ' ' + histogram[2];
                    else l += ansi.blue + gca + ansi.reset + ' ' + histogram[2];
                  }

                  print(l);
                } else if (r.stats.heap) {
                  prev_run_gap = true;
                  l = ' '.repeat(k_legend - 8);
                  const ha = formatBytes(r.stats.heap.avg).padStart(9);
                  const hm = formatBytes(r.stats.heap.min).padStart(9);
                  const hx = formatBytes(r.stats.heap.max).padStart(9);

                  if (!opts.colors) l += '(' + hm + ' … ' + hx + ') ' + ha + ' ' + histogram[2];
                  else
                    l +=
                      ansi.gray +
                      '(' +
                      ansi.reset +
                      ansi.yellow +
                      hm +
                      ansi.reset +
                      ansi.gray +
                      ' … ' +
                      ansi.reset +
                      ansi.yellow +
                      hx +
                      ansi.reset +
                      ansi.gray +
                      ') ' +
                      ansi.reset +
                      ansi.yellow +
                      ha +
                      ansi.reset +
                      ' ' +
                      histogram[2];

                  print(l);
                }

                if (r.stats.counters) {
                  l = '';
                  prev_run_gap = true;

                  if (ctx.arch.includes('linux')) {
                    const _bmispred = r.stats.counters._bmispred.avg;
                    const ipc = r.stats.counters.instructions.avg / r.stats.counters.cycles.avg;
                    const cache =
                      100 -
                      Math.min(
                        100,
                        (100 * r.stats.counters.cache.misses.avg) / r.stats.counters.cache.avg
                      );

                    l += ' '.repeat(k_legend - 12);
                    if (!opts.colors) l += formatAmount(ipc).padStart(7) + ' ipc';
                    else
                      l +=
                        ansi.bold +
                        ansi.green +
                        formatAmount(ipc).padStart(7) +
                        ansi.reset +
                        ansi.bold +
                        ' ipc' +
                        ansi.reset;

                    if (!opts.colors) l += ' (' + cache.toFixed(2).padStart(6) + '% cache)';
                    else
                      l +=
                        ansi.gray +
                        ' (' +
                        ansi.reset +
                        (50 > cache ? ansi.red : 84 < cache ? ansi.green : ansi.yellow) +
                        cache.toFixed(2).padStart(6) +
                        '%' +
                        ansi.reset +
                        ' cache' +
                        ansi.gray +
                        ')' +
                        ansi.reset;

                    if (!opts.colors)
                      l += ' ' + formatAmount(_bmispred).padStart(7) + ' branch misses';
                    else
                      l +=
                        ' ' +
                        ansi.green +
                        formatAmount(_bmispred).padStart(7) +
                        ansi.reset +
                        ' branch misses';

                    print(l);

                    l = '';
                    l += ' '.repeat(k_legend - 20);

                    if (opts.colors) l += ansi.gray;
                    l += formatAmount(r.stats.counters.cycles.avg).padStart(7) + ' cycles';
                    l +=
                      ' ' +
                      formatAmount(r.stats.counters.instructions.avg).padStart(7) +
                      ' instructions';

                    l += ' ' + formatAmount(r.stats.counters.cache.avg).padStart(7) + ' c-refs';
                    l +=
                      ' ' + formatAmount(r.stats.counters.cache.misses.avg).padStart(7) + ' c-misses';

                    if (opts.colors) l += ansi.reset;

                    print(l);
                  }

                  if (ctx.arch.includes('darwin')) {
                    const ipc = r.stats.counters.instructions.avg / r.stats.counters.cycles.avg;
                    const stalls =
                      (100 * r.stats.counters.cycles.stalls.avg) / r.stats.counters.cycles.avg;
                    const ldst =
                      (100 * r.stats.counters.instructions.loads_and_stores.avg) /
                      r.stats.counters.instructions.avg;
                    const cache =
                      100 -
                      Math.min(
                        100,
                        (100 *
                          (r.stats.counters.l1.miss_loads.avg +
                            r.stats.counters.l1.miss_stores.avg)) /
                          r.stats.counters.instructions.loads_and_stores.avg
                      );

                    l += ' '.repeat(k_legend - 13);
                    if (!opts.colors) l += formatAmount(ipc).padStart(7) + ' ipc';
                    else
                      l +=
                        ansi.bold +
                        ansi.green +
                        formatAmount(ipc).padStart(7) +
                        ansi.reset +
                        ansi.bold +
                        ' ipc' +
                        ansi.reset;

                    if (!opts.colors) l += ' (' + stalls.toFixed(2).padStart(6) + '% stalls)';
                    else
                      l +=
                        ansi.gray +
                        ' (' +
                        ansi.reset +
                        (12 > stalls ? ansi.green : 50 < stalls ? ansi.red : ansi.yellow) +
                        stalls.toFixed(2).padStart(6) +
                        '%' +
                        ansi.reset +
                        ' stalls' +
                        ansi.gray +
                        ')' +
                        ansi.reset;

                    if (!opts.colors) l += ' ' + cache.toFixed(2).padStart(6) + '% L1 data cache';
                    else
                      l +=
                        ' ' +
                        (50 > cache ? ansi.red : 84 < cache ? ansi.green : ansi.yellow) +
                        cache.toFixed(2).padStart(6) +
                        '%' +
                        ansi.reset +
                        ' L1 data cache';

                    print(l);

                    l = '';
                    l += ' '.repeat(k_legend - 20);

                    if (opts.colors) l += ansi.gray;
                    l += formatAmount(r.stats.counters.cycles.avg).padStart(7) + ' cycles';
                    l +=
                      ' ' +
                      formatAmount(r.stats.counters.instructions.avg).padStart(7) +
                      ' instructions';
                    l +=
                      ' ' +
                      ldst.toFixed(2).padStart(6) +
                      '%' +
                      ' retired LD/ST (' +
                      formatAmount(r.stats.counters.instructions.loads_and_stores.avg).padStart(7) +
                      ')';

                    if (opts.colors) l += ansi.reset;

                    print(l);
                  }
                }
              }
            }
          }
        }
      }

      if (collection.types.includes('b')) {
        const map: Record<string, number> = {};
        const colors: Record<string, any> = {};

        for (const [trial, bench] of trials) {
          for (const r of bench.runs) {
            if (r.error) continue;
            map[r.name] = r.stats!.avg;
            colors[r.name] = ansi[trial._highlight];
          }
        }

        if (Object.keys(map).length) {
          print('');

          barplotFmt
            .ascii(map, k_legend, 44, {
              steps: -10,
              colors: !opts.colors ? null : colors,
            })
            .forEach((l: string) => print(l));
        }
      }

      if (collection.types.includes('x')) {
        const map: Record<string, any> = {};
        const colors: Record<string, any> = {};

        if (1 === trials.length) {
          for (const [trial, bench] of trials) {
            for (const r of bench.runs) {
              map[r.name] = r.stats;
              colors[r.name] = ansi[trial._highlight];
            }
          }
        } else {
          for (const [trial, bench] of trials) {
            const runs = bench.runs.filter((r: any) => r.stats);

            if (!runs.length) continue;

            if (1 === runs.length) {
              map[runs[0].name] = runs[0].stats;
              colors[runs[0].name] = ansi[trial._highlight];
            } else {
              const stats: any = {
                avg: 0,
                min: Infinity,
                p25: Infinity,
                p75: -Infinity,
                p99: -Infinity,
              };

              for (const r of runs) {
                if (!r.stats) continue;
                stats.avg += r.stats.avg;
                stats.min = Math.min(stats.min, r.stats.min);
                stats.p25 = Math.min(stats.p25, r.stats.p25);
                stats.p75 = Math.max(stats.p75, r.stats.p75);
                stats.p99 = Math.max(stats.p99, r.stats.p99);
              }

              map[bench.alias] = stats;
              stats.avg /= runs.length;
              colors[bench.alias] = ansi[trial._highlight];
            }
          }
        }

        if (Object.keys(map).length) {
          print('');
          boxplotFmt
            .ascii(map, k_legend, 44, {
              colors: !opts.colors ? null : colors,
            })
            .forEach((l: string) => print(l));
        }
      }

      if (collection.types.includes('l')) {
        const map: Record<string, any> = {};
        const extra: any = {};
        const colors: Record<string, any> = {};
        const labels: any = {};

        if (1 === trials.length) {
          for (const [trial, bench] of trials) {
            const runs = bench.runs.filter((r: any) => r.stats);

            if (!runs.length) continue;

            if (1 === runs.length) {
              const { min, max, avg, peak, bins } = histogramFmt.bins(runs[0].stats!, 44, 0.99);

              extra.ymax = peak;
              colors.xmin = ansi.cyan;
              colors.xmax = ansi.magenta;
              extra.ymin = arrMin(bins);
              labels.xmin = formatNs(min);
              labels.xmax = formatNs(max);
              extra.xmax = bins.length - 1;
              colors[runs[0].name] = ansi[trial._highlight] || ansi.bold;

              map[runs[0].name] = {
                y: bins,
                x: bins.map((_: any, o: number) => o),

                format(x: number, y: number, s: string) {
                  x = Math.round(x * 44);
                  if (!opts.colors) return s;
                  if (x === avg) return ansi.yellow + s + ansi.reset;
                  return (x < avg ? ansi.cyan : ansi.magenta) + s + ansi.reset;
                },
              };
            } else {
              const avgs = runs.map((r: any) => r.stats.avg);

              colors.ymin = ansi.cyan;
              colors.ymax = ansi.magenta;
              extra.ymin = arrMin(avgs);
              extra.ymax = arrMax(avgs);
              extra.xmax = runs.length - 1;
              labels.ymin = formatNs(extra.ymin);
              labels.ymax = formatNs(extra.ymax);
              colors[bench.alias] = ansi[trial._highlight];

              map[bench.alias] = {
                y: avgs,
                x: avgs.map((_: any, o: number) => o),
              };
            }
          }
        } else {
          if (trials.every(([_, bench]: [any, Trial]) => 'static' === bench.kind)) {
            colors.xmin = ansi.cyan;
            colors.xmax = ansi.magenta;

            for (const [trial, bench] of trials) {
              for (const r of bench.runs) {
                if (r.error) continue;
                const { bins, peak, steps } = histogramFmt.bins(r.stats!, 44, 0.99);

                const y = bins.map((b: number) => b / peak);

                map[r.name] = { y, x: steps };
                colors[r.name] = ansi[trial._highlight];
                extra.ymin = Math.min(arrMin(y), extra.ymin ?? Infinity);
                extra.ymax = Math.max(arrMax(y), extra.ymax ?? -Infinity);
                extra.xmin = Math.min(arrMin(steps), extra.xmin ?? Infinity);
                extra.xmax = Math.max(arrMax(steps), extra.xmax ?? -Infinity);
                labels.xmin = formatNs(extra.xmin);
                labels.xmax = formatNs(extra.xmax);
              }
            }
          } else {
            let min = Infinity;
            let max = -Infinity;

            for (const [_trial, bench] of trials) {
              for (const r of bench.runs) {
                if (r.error) continue;
                min = Math.min(min, r.stats!.avg);
                max = Math.max(max, r.stats!.avg);
              }
            }

            colors.ymin = ansi.cyan;
            colors.ymax = ansi.magenta;
            labels.ymin = formatNs(min);
            labels.ymax = formatNs(max);

            for (const [trial, bench] of trials) {
              const runs = bench.runs.filter((r: any) => r.stats);

              if (!runs.length) continue;

              if (1 === runs.length) {
                const y = runs[0].stats!.avg / max;
                colors[runs[0].name] = ansi[trial._highlight];
                map[runs[0].name] = { x: [0, 1], y: [y, y] };
                extra.ymin = Math.min(y, extra.ymin ?? Infinity);
                extra.ymax = Math.max(y, extra.ymax ?? -Infinity);
              } else {
                colors[bench.alias] = ansi[trial._highlight];
                const y = runs.map((r: any) => r.stats.avg / max);
                extra.ymin = Math.min(arrMin(y), extra.ymin ?? Infinity);
                extra.ymax = Math.max(arrMax(y), extra.ymax ?? -Infinity);
                map[bench.alias] = {
                  y,
                  x: runs.map((_: any, o: number) => o / (runs.length - 1)),
                };
              }
            }
          }
        }

        if (Object.keys(map).length) {
          print('');

          lineplotFmt
            .ascii(map, {
              labels,
              ...extra,
              width: 44,
              height: 16,
              key: k_legend,
              colors: !opts.colors ? null : colors,
            })
            .forEach((l: string) => print(l));
        }
      }

      if (collection.types.includes('s')) {
        trials.sort((a: [any, Trial], b: [any, Trial]) => {
          const aa = a[1].runs.filter((r: any) => r.stats);
          const bb = b[1].runs.filter((r: any) => r.stats);

          if (0 === aa.length) return 1;
          if (0 === bb.length) return -1;

          const a_avg = aa.reduce((a: number, r: any) => a + r.stats.avg, 0) / aa.length;
          const b_avg = bb.reduce((a: number, r: any) => a + r.stats.avg, 0) / bb.length;

          return a_avg - b_avg;
        });

        if (1 === trials.length) {
          const runs = trials[0][1].runs
            .filter((r: any) => r.stats)
            .sort((a: any, b: any) => a.stats.avg - b.stats.avg);

          if (1 < runs.length) {
            print('');
            if (!opts.colors) print('summary');
            else print(ansi.bold + 'summary' + ansi.reset);
            if (!opts.colors) print('  ' + runs[0].name);
            else print(' '.repeat(2) + ansi.bold + ansi.cyan + runs[0].name + ansi.reset);

            for (let o = 1; o < runs.length; o++) {
              const r = runs[o];
              const baseline = runs[0];
              if (!r.stats || !baseline.stats) continue;
              const faster = r.stats.avg >= baseline.stats.avg;

              const diff = !faster
                ? Number(((1 / r.stats.avg) * baseline.stats.avg).toFixed(2))
                : Number(((1 / baseline.stats.avg) * r.stats.avg).toFixed(2));

              if (!opts.colors)
                print(' '.repeat(3) + diff + `x ${faster ? 'faster' : 'slower'} than ${r.name}`);
              else
                print(
                  ' '.repeat(3) +
                    (!faster ? ansi.red : ansi.green) +
                    diff +
                    ansi.reset +
                    `x ${faster ? 'faster' : 'slower'} than ${ansi.bold + ansi.cyan + r.name + ansi.reset}`
                );
            }
          }
        } else {
          let header = false;
          const baseline =
            trials.find(
              ([_trial, bench]: [any, Trial]) =>
                bench.baseline && bench.runs.some((r: any) => r.stats)
            )?.[1] || trials[0][1];

          if (baseline) {
            const bruns = baseline.runs
              .filter((r: any) => !r.error)
              .sort((a: any, b: any) => a.stats.avg - b.stats.avg);

            for (const [_trial, bench] of trials) {
              if (bench === baseline) continue;

              const runs = bench.runs
                .filter((r: any) => !r.error)
                .sort((a: any, b: any) => a.stats.avg - b.stats.avg);

              if (!runs.length) continue;

              if (!header) {
                print('');
                header = true;
                if (!opts.colors) print('summary');
                else print(ansi.bold + 'summary' + ansi.reset);

                if (1 !== bruns.length) {
                  if (!opts.colors) print('  ' + baseline.alias);
                  else print(' '.repeat(2) + ansi.bold + ansi.cyan + baseline.alias + ansi.reset);
                } else {
                  if (!opts.colors) print('  ' + bruns[0].name);
                  else print(' '.repeat(2) + ansi.bold + ansi.cyan + bruns[0].name + ansi.reset);
                }
              }

              if (1 === runs.length && 1 === bruns.length) {
                const r = runs[0];
                const br = bruns[0];
                if (!r.stats || !br.stats) continue;
                const faster = r.stats.avg >= br.stats.avg;

                const diff = !faster
                  ? Number(((1 / r.stats.avg) * br.stats.avg).toFixed(2))
                  : Number(((1 / br.stats.avg) * r.stats.avg).toFixed(2));

                if (!opts.colors)
                  print(' '.repeat(3) + diff + `x ${faster ? 'faster' : 'slower'} than ${r.name}`);
                else
                  print(
                    ' '.repeat(3) +
                      (!faster ? ansi.red : ansi.green) +
                      diff +
                      ansi.reset +
                      `x ${faster ? 'faster' : 'slower'} than ${ansi.bold + ansi.cyan + r.name + ansi.reset}`
                  );
              } else {
                const rf = runs[0];
                const bf = bruns[0];
                const rs = runs[runs.length - 1];
                const bs = bruns[bruns.length - 1];

                const ravg = runs.reduce((a: number, r: any) => a + r.stats.avg, 0) / runs.length;
                const bavg = bruns.reduce((a: number, r: any) => a + r.stats.avg, 0) / bruns.length;

                if (!rf.stats || !bf.stats || !rs.stats || !bs.stats) continue;

                const faster = ravg >= bavg;
                const sfaster = rs.stats.avg >= bs.stats.avg;
                const ffaster = rf.stats.avg >= bf.stats.avg;

                const sdiff = !sfaster
                  ? Number(((1 / rs.stats.avg) * bs.stats.avg).toFixed(2))
                  : Number(((1 / bs.stats.avg) * rs.stats.avg).toFixed(2));

                const fdiff = !ffaster
                  ? Number(((1 / rf.stats.avg) * bf.stats.avg).toFixed(2))
                  : Number(((1 / bf.stats.avg) * rf.stats.avg).toFixed(2));

                if (!opts.colors)
                  print(
                    ' '.repeat(3) +
                      (1 === sdiff ? sdiff : (sfaster ? '+' : '-') + sdiff) +
                      '…' +
                      (1 === fdiff ? fdiff : (ffaster ? '+' : '-') + fdiff) +
                      `x ${faster ? 'faster' : 'slower'} than ${1 === runs.length ? rf.name : bench.alias}`
                  );
                else
                  print(
                    ' '.repeat(3) +
                      (1 === sdiff
                        ? ansi.gray + sdiff + ansi.reset
                        : !sfaster
                          ? ansi.red + '-' + sdiff + ansi.reset
                          : ansi.green + '+' + sdiff + ansi.reset) +
                      '…' +
                      (1 === fdiff
                        ? ansi.gray + fdiff + ansi.reset
                        : !ffaster
                          ? ansi.red + '-' + fdiff + ansi.reset
                          : ansi.green + '+' + fdiff + ansi.reset) +
                      `x ${faster ? 'faster' : 'slower'} than ${ansi.bold + ansi.cyan + (1 === runs.length ? rf.name : bench.alias) + ansi.reset}`
                  );
              }
            }
          }
        }
      }
    }

    let nl = false;

    if (false === $counters) {
      print('');
      nl = true;
      if (!opts.colors) {
        print('! = run with sudo to enable hardware counters');
      } else {
        print(
          ansi.yellow +
            '!' +
            ansi.reset +
            ansi.gray +
            ' = ' +
            ansi.reset +
            'run with sudo to enable hardware counters'
        );
      }
    }

    if (optimized_out_warning) {
      if (!nl) print('');
      const pad = ' '.repeat(k_legend - 13);
      if (!opts.colors) {
        print(pad + 'benchmark was likely optimized out (dead code elimination) = !');
        print(pad + 'https://github.com/evanwashere/mitata#writing-good-benchmarks');
      } else {
        print(
          pad +
            'benchmark was likely optimized out ' +
            ansi.gray +
            '(dead code elimination)' +
            ansi.reset +
            ansi.gray +
            ' = ' +
            ansi.reset +
            ansi.red +
            '!' +
            ansi.reset
        );
        print(
          pad +
            ansi.gray +
            'https://github.com/evanwashere/mitata#writing-good-benchmarks' +
            ansi.reset
        );
      }
    }

    if (noisy_warning) {
      if (!nl) print('');
      const pad = ' '.repeat(k_legend - 13);
      if (!opts.colors) {
        print(pad + '~ = noisy: confidence target not reached before max cpu time');
      } else {
        print(
          pad +
            ansi.yellow +
            '~' +
            ansi.reset +
            ansi.gray +
            ' = ' +
            ansi.reset +
            'noisy: confidence target not reached before max cpu time'
        );
      }
    }
  },
};
