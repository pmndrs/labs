/**
 * Box-and-whisker plot renderer for terminal output.
 *
 * Draws min/p25/avg/p75/max whisker diagrams using Unicode box-drawing
 * characters, with optional ANSI coloring.
 */

import { ansi } from '../../utils/ansi.ts';
import { truncate, formatNs } from '../../utils/units.ts';

/** Box-drawing symbols for the whisker diagram. */
export const SYMBOLS = {
  v: '│',
  h: '─',
  tl: '┌',
  tr: '┐',
  bl: '└',
  br: '┘',
  avg: { top: '┬', middle: '│', bottom: '┴' },
  tail: { top: '╷', bottom: '╵', middle: ['├', '┤'] },
};

/**
 * Render a box-and-whisker chart as an array of strings.
 *
 * Each entry in `map` should have `min`, `avg`, `p25`, `p75`, and either
 * `p99` or `max` fields.
 *
 * @param map     - `{ name: stats }` data to plot.
 * @param key     - Label column width in characters (default 8).
 * @param size    - Plot area width in characters (default 14).
 * @param opts.fmt     - Value formatter for the axis labels (default {@link formatNs}).
 * @param opts.colors  - ANSI color map per name, or falsy to disable color.
 * @param opts.symbols - Override box-drawing symbols.
 */
export function ascii(
  map: Record<string, any>,
  key = 8,
  size = 14,
  {
    fmt = formatNs,
    colors = true as any,
    symbols = SYMBOLS,
  }: { fmt?: (n: number) => string; colors?: any; symbols?: any } = {}
): string[] {
  let tmin = Infinity;
  let tmax = -Infinity;
  const keys = Object.keys(map);
  const canvas = Array.from({ length: 3 + 3 * keys.length }, () => '');

  for (const name of keys) {
    const stats = map[name];
    if (tmin > stats.min) tmin = stats.min;
    const mx = stats.p99 || stats.max || 1;
    if (mx > tmax) tmax = mx;
  }

  const steps = 2 + size;
  const step = (tmax - tmin) / (steps - 1);

  canvas[0] += ' '.repeat(1 + key);
  canvas[0] += symbols.tl + ' '.repeat(size) + symbols.tr;

  keys.forEach((name, o) => {
    o *= 3;
    const stats = map[name];

    const mn = stats.min;
    const avg = stats.avg;
    const p25 = stats.p25;
    const p75 = stats.p75;
    const mx = stats.p99 || stats.max || 1;

    const min_offset = 1 + Math.min(steps - 1, Math.round((mn - tmin) / step));
    const max_offset = 1 + Math.min(steps - 1, Math.round((mx - tmin) / step));
    const avg_offset = 1 + Math.min(steps - 1, Math.round((avg - tmin) / step));
    const p25_offset = 1 + Math.min(steps - 1, Math.round((p25 - tmin) / step));
    const p75_offset = 1 + Math.min(steps - 1, Math.round((p75 - tmin) / step));

    const u = Array.from({ length: 2 + steps }, () => ' ');
    const m = Array.from({ length: 2 + steps }, () => ' ');
    const l = Array.from({ length: 2 + steps }, () => ' ');

    u[0] = !colors ? '' : ansi.cyan;
    m[0] = !colors ? '' : ansi.cyan;
    l[0] = !colors ? '' : ansi.cyan;

    if (min_offset < p25_offset) {
      u[min_offset] = symbols.tail.top;
      l[min_offset] = symbols.tail.bottom;
      m[min_offset] = symbols.tail.middle[0];
      for (let o = 1 + min_offset; o < p25_offset; o++) m[o] = symbols.h;
    }

    if (avg_offset > p25_offset) {
      u[p25_offset] = symbols.tl;
      l[p25_offset] = symbols.bl;
      m[p25_offset] = min_offset === p25_offset ? symbols.v : symbols.tail.middle[1];
      for (let o = 1 + p25_offset; o < avg_offset; o++) u[o] = l[o] = symbols.h;
    }

    u[avg_offset] = !colors
      ? symbols.avg.top
      : ansi.reset + ansi.yellow + symbols.avg.top + ansi.reset + ansi.magenta;
    l[avg_offset] = !colors
      ? symbols.avg.bottom
      : ansi.reset + ansi.yellow + symbols.avg.bottom + ansi.reset + ansi.magenta;
    m[avg_offset] = !colors
      ? symbols.avg.middle
      : ansi.reset + ansi.yellow + symbols.avg.middle + ansi.reset + ansi.magenta;

    if (avg_offset < p75_offset) {
      u[p75_offset] = symbols.tr;
      l[p75_offset] = symbols.br;
      m[p75_offset] = max_offset === p75_offset ? symbols.v : symbols.tail.middle[0];
      for (let o = 1 + avg_offset; o < p75_offset; o++) u[o] = l[o] = symbols.h;
    }

    if (max_offset > p75_offset) {
      u[max_offset] = symbols.tail.top;
      l[max_offset] = symbols.tail.bottom;
      m[max_offset] = symbols.tail.middle[1];
      for (let o = 1 + Math.max(avg_offset, p75_offset); o < max_offset; o++) m[o] = symbols.h;
    }

    canvas[o + 1] = ' '.repeat(1 + key) + u.join('').trimEnd() + (!colors ? '' : ansi.reset);
    if (colors?.[name]) canvas[o + 2] += colors[name];
    canvas[o + 2] += truncate(name, key).padStart(key);

    if (colors?.[name]) canvas[o + 2] += ansi.reset;
    canvas[o + 2] += ' ' + m.join('').trimEnd() + (!colors ? '' : ansi.reset);
    canvas[o + 3] = ' '.repeat(1 + key) + l.join('').trimEnd() + (!colors ? '' : ansi.reset);
  });

  canvas[canvas.length - 2] += ' '.repeat(1 + key);
  canvas[canvas.length - 2] += symbols.bl + ' '.repeat(size) + symbols.br;

  const rmin = fmt(tmin);
  const rmax = fmt(tmax);
  const rmid = fmt((tmin + tmax) / 2);
  const gap = (size - rmin.length - rmid.length - rmax.length) / 2;

  canvas[canvas.length - 1] += ' '.repeat(1 + key);
  canvas[canvas.length - 1] += !colors ? rmin : ansi.cyan + rmin + ansi.reset;

  canvas[canvas.length - 1] += ' '.repeat((1 + gap) | 0);
  canvas[canvas.length - 1] += !colors ? rmid : ansi.gray + rmid + ansi.reset;

  canvas[canvas.length - 1] += ' '.repeat(1 + Math.ceil(gap));
  canvas[canvas.length - 1] += !colors ? rmax : ansi.magenta + rmax + ansi.reset;
  return canvas;
}
