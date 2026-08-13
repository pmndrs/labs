import { ansi } from '../utils/ansi.ts';
import { min as arrMin, max as arrMax } from '../utils/math.ts';
import { truncate, formatNs, formatBytes, formatAmount } from '../utils/units.ts';
import * as histogramFmt from './format/histogram.ts';
import * as boxplotFmt from './format/boxplot.ts';
import * as barplotFmt from './format/barplot.ts';
import * as lineplotFmt from './format/lineplot.ts';
import type { Context, GcMode, Trial } from './types.ts';

export interface RenderedTrial {
  highlight: false | string | null;
  compact: boolean;
  gcMode: GcMode;
  bench: Trial;
}

export interface RenderedCollection {
  name: string | null;
  types: string[];
  trials: RenderedTrial[];
}

export interface RenderMitataOptions {
  print: (s: string) => void;
  colors: boolean;
  format?: { name?: number | string };
  countersAvailable?: unknown;
}

export function renderMitata(
  ctx: Context,
  opts: RenderMitataOptions,
  collections: RenderedCollection[]
): void {
  const print = opts.print;
  let k_legend: number | string = opts.format?.name ?? 'longest';

  if ('fixed' === k_legend) k_legend = 28;
  else if (k_legend === 'longest') {
    k_legend = 28;
    for (const collection of collections) {
      for (const trial of collection.trials) {
        for (const run of trial.bench.runs) {
          k_legend = Math.max(k_legend, run.name.length);
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

  for (const collection of collections) {
    let prev_run_gap = false;
    if (!collection.trials.length) continue;

    if (first) {
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
      const bench = trial.bench;
      const highlight = trial.highlight;
      const _h =
        !opts.colors || !highlight
          ? (x: string) => x
          : (x: string) => (ansi as any)[highlight] + x + ansi.reset;

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
          continue;
        }

        const compact = trial.compact;
        const noop =
          'iter' === r.stats!.kind
            ? ctx.noop.iter
            : trial.gcMode !== true && trial.gcMode !== 'inner'
              ? ctx.noop.fn
              : ctx.noop.fn_gc;
        const optimized_out = r.stats!.avg < 1.42 * noop.avg;
        optimized_out_warning = optimized_out_warning || optimized_out;

        const noisy = !!r.stats!.noisy;
        noisy_warning = noisy_warning || noisy;

        if (compact) {
          let l = '';
          prev_run_gap = false;
          const avg = formatNs(r.stats!.avg).padStart(9);
          const nw = noisy ? k_legend - 2 : k_legend;
          const name = truncate(r.name, nw).padEnd(nw);

          if (noisy) l += !opts.colors ? '~ ' : ansi.yellow + '~' + ansi.reset + ' ';
          l += _h(name) + ' ';
          if (!opts.colors) l += avg + '/iter';
          else l += ansi.bold + ansi.yellow + avg + ansi.reset + ansi.bold + '/iter' + ansi.reset;

          const p75 = formatNs(r.stats!.p75).padStart(9);
          const p99 = formatNs(r.stats!.p99).padStart(9);
          const bins = histogramFmt.bins(r.stats!, 11, 0.99);
          const histogram = histogramFmt.ascii(bins, 1, { colors: opts.colors });

          l += ' ';
          if (!opts.colors) l += p75 + ' ' + p99 + ' ' + histogram[0];
          else l += ansi.gray + p75 + ' ' + p99 + ansi.reset + ' ' + histogram[0];

          if (optimized_out) l += !opts.colors ? ' !' : ansi.red + ' !' + ansi.reset;
          print(l);
        } else {
          let l = '';
          const avg = formatNs(r.stats!.avg).padStart(9);
          const nw = noisy ? k_legend - 2 : k_legend;
          const name = truncate(r.name, nw).padEnd(nw);

          if (noisy) l += !opts.colors ? '~ ' : ansi.yellow + '~' + ansi.reset + ' ';
          l += _h(name) + ' ';
          const p75 = formatNs(r.stats!.p75).padStart(9);
          const bins = histogramFmt.bins(r.stats!, 21, 0.99);
          const histogram = histogramFmt.ascii(bins, 2, { colors: opts.colors });

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

          if (optimized_out) l += !opts.colors ? ' !' : ansi.red + ' !' + ansi.reset;
          print(l);

          l = '';
          const min = formatNs(r.stats!.min);
          const max = formatNs(r.stats!.max);
          const p99 = formatNs(r.stats!.p99).padStart(9);
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

          if (r.stats!.gc) {
            l = '';
            prev_run_gap = true;
            l += ' '.repeat(k_legend - 10);
            const gcm = formatNs(r.stats!.gc.min).padStart(9);
            const gcx = formatNs(r.stats!.gc.max).padStart(9);
            const tail = formatNs(r.stats!.gc.avg).padStart(9);

            if (!opts.colors) l += 'gc(' + gcm + ' … ' + gcx + ') ' + tail;
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
                ') ' +
                ansi.reset +
                ansi.blue +
                tail +
                ansi.reset;

            print(l);
          }

          if (r.stats!.heap) {
            l = '';
            prev_run_gap = true;
            l += ' '.repeat(k_legend - 12);
            const ha = formatBytes(r.stats!.heap.avg).padStart(9);
            const hm = formatBytes(r.stats!.heap.min).padStart(9);
            const hx = formatBytes(r.stats!.heap.max).padStart(9);

            if (!opts.colors) l += 'heap(' + hm + ' … ' + hx + ') ' + ha + '/iter';
            else
              l +=
                ansi.gray +
                'heap(' +
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
                ansi.gray +
                '/iter' +
                ansi.reset;

            print(l);
          }

          if (r.stats!.counters) {
            l = '';
            prev_run_gap = true;

            if (ctx.arch && ctx.arch.includes('linux')) {
              const _bmispred = (r.stats!.counters as any)._bmispred.avg;
              const ipc =
                (r.stats!.counters as any).instructions.avg / (r.stats!.counters as any).cycles.avg;
              const cache =
                100 -
                Math.min(
                  100,
                  (100 * (r.stats!.counters as any).cache.misses.avg) /
                    (r.stats!.counters as any).cache.avg
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

              if (!opts.colors) l += ' ' + formatAmount(_bmispred).padStart(7) + ' branch misses';
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
              l += formatAmount((r.stats!.counters as any).cycles.avg).padStart(7) + ' cycles';
              l +=
                ' ' +
                formatAmount((r.stats!.counters as any).instructions.avg).padStart(7) +
                ' instructions';
              l += ' ' + formatAmount((r.stats!.counters as any).cache.avg).padStart(7) + ' c-refs';
              l +=
                ' ' +
                formatAmount((r.stats!.counters as any).cache.misses.avg).padStart(7) +
                ' c-misses';
              if (opts.colors) l += ansi.reset;
              print(l);
            }

            if (ctx.arch && ctx.arch.includes('darwin')) {
              const ipc =
                (r.stats!.counters as any).instructions.avg / (r.stats!.counters as any).cycles.avg;
              const stalls =
                (100 * (r.stats!.counters as any).cycles.stalls.avg) /
                (r.stats!.counters as any).cycles.avg;
              const ldst =
                (100 * (r.stats!.counters as any).instructions.loads_and_stores.avg) /
                (r.stats!.counters as any).instructions.avg;
              const cache =
                100 -
                Math.min(
                  100,
                  (100 *
                    ((r.stats!.counters as any).l1.miss_loads.avg +
                      (r.stats!.counters as any).l1.miss_stores.avg)) /
                    (r.stats!.counters as any).instructions.loads_and_stores.avg
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
              l += formatAmount((r.stats!.counters as any).cycles.avg).padStart(7) + ' cycles';
              l +=
                ' ' +
                formatAmount((r.stats!.counters as any).instructions.avg).padStart(7) +
                ' instructions';
              l +=
                ' ' +
                ldst.toFixed(2).padStart(6) +
                '%' +
                ' retired LD/ST (' +
                formatAmount((r.stats!.counters as any).instructions.loads_and_stores.avg).padStart(
                  7
                ) +
                ')';
              if (opts.colors) l += ansi.reset;
              print(l);
            }
          }
        }
      }
    }

    if (collection.types.includes('b')) {
      const map: Record<string, number> = {};
      const colors: Record<string, any> = {};
      for (const trial of collection.trials) {
        for (const r of trial.bench.runs) {
          if (r.error) continue;
          map[r.name] = r.stats!.avg;
          colors[r.name] = (ansi as any)[trial.highlight as any];
        }
      }
      if (Object.keys(map).length) {
        print('');
        barplotFmt
          .ascii(map, k_legend, 44, { steps: -10, colors: !opts.colors ? null : colors })
          .forEach((l: string) => print(l));
      }
    }

    if (collection.types.includes('x')) {
      const map: Record<string, any> = {};
      const colors: Record<string, any> = {};
      if (1 === collection.trials.length) {
        for (const trial of collection.trials) {
          for (const r of trial.bench.runs) {
            map[r.name] = r.stats;
            colors[r.name] = (ansi as any)[trial.highlight as any];
          }
        }
      } else {
        for (const trial of collection.trials) {
          const runs = trial.bench.runs.filter((r: any) => r.stats);
          if (!runs.length) continue;
          if (1 === runs.length) {
            map[runs[0].name] = runs[0].stats;
            colors[runs[0].name] = (ansi as any)[trial.highlight as any];
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
            map[trial.bench.alias] = stats;
            stats.avg /= runs.length;
            colors[trial.bench.alias] = (ansi as any)[trial.highlight as any];
          }
        }
      }
      if (Object.keys(map).length) {
        print('');
        boxplotFmt
          .ascii(map, k_legend, 44, { colors: !opts.colors ? null : colors })
          .forEach((l: string) => print(l));
      }
    }

    if (collection.types.includes('l')) {
      const map: Record<string, any> = {};
      const extra: any = {};
      const colors: Record<string, any> = {};
      const labels: any = {};

      if (1 === collection.trials.length) {
        for (const trial of collection.trials) {
          const runs = trial.bench.runs.filter((r: any) => r.stats);
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
            colors[runs[0].name] = (ansi as any)[trial.highlight as any] || ansi.bold;
            map[runs[0].name] = {
              y: bins,
              x: bins.map((_: any, o: number) => o),
              format(x: number, _y: number, s: string) {
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
            colors[trial.bench.alias] = (ansi as any)[trial.highlight as any];
            map[trial.bench.alias] = { y: avgs, x: avgs.map((_: any, o: number) => o) };
          }
        }
      } else {
        if (collection.trials.every((trial) => 'static' === trial.bench.kind)) {
          colors.xmin = ansi.cyan;
          colors.xmax = ansi.magenta;
          for (const trial of collection.trials) {
            for (const r of trial.bench.runs) {
              if (r.error) continue;
              const { bins, peak, steps } = histogramFmt.bins(r.stats!, 44, 0.99);
              const y = bins.map((b: number) => b / peak);
              map[r.name] = { y, x: steps };
              colors[r.name] = (ansi as any)[trial.highlight as any];
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
          for (const trial of collection.trials) {
            for (const r of trial.bench.runs) {
              if (r.error) continue;
              min = Math.min(min, r.stats!.avg);
              max = Math.max(max, r.stats!.avg);
            }
          }

          colors.ymin = ansi.cyan;
          colors.ymax = ansi.magenta;
          labels.ymin = formatNs(min);
          labels.ymax = formatNs(max);

          for (const trial of collection.trials) {
            const runs = trial.bench.runs.filter((r: any) => r.stats);
            if (!runs.length) continue;
            if (1 === runs.length) {
              const y = runs[0].stats!.avg / max;
              colors[runs[0].name] = (ansi as any)[trial.highlight as any];
              map[runs[0].name] = { x: [0, 1], y: [y, y] };
              extra.ymin = Math.min(y, extra.ymin ?? Infinity);
              extra.ymax = Math.max(y, extra.ymax ?? -Infinity);
            } else {
              colors[trial.bench.alias] = (ansi as any)[trial.highlight as any];
              const y = runs.map((r: any) => r.stats.avg / max);
              extra.ymin = Math.min(arrMin(y), extra.ymin ?? Infinity);
              extra.ymax = Math.max(arrMax(y), extra.ymax ?? -Infinity);
              map[trial.bench.alias] = {
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
      const trials = collection.trials.slice().sort((a, b) => {
        const aa = a.bench.runs.filter((r: any) => r.stats);
        const bb = b.bench.runs.filter((r: any) => r.stats);
        if (0 === aa.length) return 1;
        if (0 === bb.length) return -1;
        const a_avg = aa.reduce((sum: number, r: any) => sum + r.stats.avg, 0) / aa.length;
        const b_avg = bb.reduce((sum: number, r: any) => sum + r.stats.avg, 0) / bb.length;
        return a_avg - b_avg;
      });

      if (1 === trials.length) {
        const runs = trials[0].bench.runs
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
          trials.find((trial) => trial.bench.baseline && trial.bench.runs.some((r: any) => r.stats))
            ?.bench || trials[0].bench;
        if (baseline) {
          const bruns = baseline.runs
            .filter((r: any) => !r.error)
            .sort((a: any, b: any) => a.stats.avg - b.stats.avg);
          for (const trial of trials) {
            const bench = trial.bench;
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
              const ravg = runs.reduce((sum: number, r: any) => sum + r.stats.avg, 0) / runs.length;
              const bavg = bruns.reduce((sum: number, r: any) => sum + r.stats.avg, 0) / bruns.length;
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
  if (false === opts.countersAvailable) {
    print('');
    nl = true;
    if (!opts.colors) print('! = run with sudo to enable hardware counters');
    else
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
        pad + ansi.gray + 'https://github.com/evanwashere/mitata#writing-good-benchmarks' + ansi.reset
      );
    }
  }

  if (noisy_warning) {
    if (!nl) print('');
    const pad = ' '.repeat(k_legend - 13);
    if (!opts.colors) print(pad + '~ = noisy: confidence target not reached before max cpu time');
    else
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
