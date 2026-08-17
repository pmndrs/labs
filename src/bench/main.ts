export { measure } from './lib/measure.ts';
export { do_not_optimize } from './lib/runtime.ts';
import { COLOR_NAMES } from '../utils/ansi.ts';
import { formatNs } from '../utils/units.ts';
import { arch, colors, cpu, runtime, version } from './env.ts';
import { measure } from './lib/measure.ts';
import { _print, kind } from './lib/runtime.ts';
import { renderMitata, type RenderedCollection } from './render.ts';
import type { Collection, Context, Stats, Trial } from './types.ts';

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
  _gc = true;
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

  gc(gc = true): this {
    if ('boolean' !== typeof gc) throw new TypeError('expected gc to be a boolean');
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
      ..._tune,
      sample_gc: this._gc,
      // Always request initial collection; custom GC hooks remain supported.
      gc: 'function' === typeof _tune.gc ? _tune.gc : undefined,

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
        gcMode: this._gc,
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
        gcMode: this._gc,
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
  opts.run_trial ??= (trial: B, _index: number) => trial.run(opts.throw, opts.tune);
}

/** Initialize process-local hardware counters when supported. */
async function initCounters(arch: string | null, runtime: string | null): Promise<void> {
  if ($counters || !['bun', 'node', 'deno'].includes(runtime as string)) return;

  if (arch?.includes?.('darwin')) {
    try {
      const _c = '@mitata/counters';
      $counters = await import(_c);
      if (0 !== (globalThis as any).process.getuid()) throw (($counters = false), 1);
    } catch {}
  }

  if (!$counters && arch?.includes?.('linux')) {
    try {
      const _c = '@mitata/counters';
      $counters = await import(_c);
    } catch (err: any) {
      if (err?.message?.includes?.('PermissionDenied')) $counters = false;
    }
  }
}

/** Run one registered trial by its global registration index. */
export async function runTrialAt(index: number, tune: any = {}): Promise<Trial> {
  const trials = COLLECTIONS.flatMap((c) => c.trials) as B[];
  const trial = trials[index];
  if (!trial) {
    throw new RangeError(`no bench registered at index ${index} (${trials.length} registered)`);
  }
  await initCounters(await arch(), runtime());
  return await trial.run(false, tune);
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
  const noop_sample_gc = await measure(() => {}, { ...cal, sample_gc: true });
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
      fn_gc: noop_sample_gc,
    },
  };

  await initCounters(context.arch, context.runtime);

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
    let index = 0;
    for (const collection of COLLECTIONS) {
      for (const trial of collection.trials) {
        const i = index++;
        if (opts.filter.test(trial._name))
          benchmarks.push(opts.observe(await opts.run_trial(trial, i)));
      }
    }
  },

  async json(ctx: any, opts: any, benchmarks: Trial[], layout: any[]) {
    const print = opts.print;
    const debug = opts.format?.debug ?? true;
    const samples = opts.format?.samples ?? true;

    let index = 0;
    for (const collection of COLLECTIONS) {
      for (const trial of collection.trials) {
        const i = index++;
        if (opts.filter.test(trial._name))
          benchmarks.push(opts.observe(await opts.run_trial(trial, i)));
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

    let index = 0;
    for (const collection of COLLECTIONS) {
      const trials: Trial[] = [];
      if (!collection.trials.length) continue;

      for (const trial of collection.trials) {
        const i = index++;
        if (opts.filter.test(trial._name)) {
          let bench = await opts.run_trial(trial, i);

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
    const renderedCollections: RenderedCollection[] = [];

    let index = 0;
    for (const collection of COLLECTIONS) {
      const renderedTrials: RenderedCollection['trials'] = [];
      for (const trial of collection.trials) {
        const i = index++;
        if (!opts.filter.test(trial._name)) continue;
        let bench = await opts.run_trial(trial, i);
        bench = opts.observe(bench);
        benchmarks.push(bench);
        renderedTrials.push({
          highlight: -1 === COLOR_NAMES.indexOf(trial._highlight) ? null : trial._highlight,
          compact: !!(trial.flags & flags.compact),
          gcMode: trial._gc,
          bench,
        });
      }
      if (renderedTrials.length > 0) {
        renderedCollections.push({
          name: collection.name,
          types: collection.types,
          trials: renderedTrials,
        });
      }
    }

    renderMitata(
      ctx,
      {
        print: opts.print,
        colors: opts.colors,
        format: opts.format,
        countersAvailable: $counters,
      },
      renderedCollections
    );
  },
};
