/**
 * Horizontal bar-chart renderer for terminal output.
 *
 * Renders a named set of values as horizontal bars with box-drawing borders
 * and optional ANSI coloring.
 */

import { ansi } from '../../utils/ansi.ts';
import { min, max } from '../../utils/math.ts';
import { truncate, formatNs } from '../../utils/units.ts';

/** Box-drawing symbols used for the bar chart frame. */
export const SYMBOLS = {
  bar: '■',
  legend: '┤',
  tl: '┌',
  tr: '┐',
  bl: '└',
  br: '┘',
};

/**
 * Render a horizontal bar chart as an array of strings.
 *
 * @param map     - `{ name: value }` data to plot.
 * @param key     - Label column width in characters (default 8).
 * @param size    - Bar area width in characters (default 14).
 * @param opts.steps   - Extra steps beyond `size` for scale resolution (default 0).
 * @param opts.fmt     - Value formatter (default {@link formatNs}).
 * @param opts.colors  - ANSI color map per name, or falsy to disable color.
 * @param opts.symbols - Override box-drawing symbols.
 */
export function ascii(
  map: Record<string, number>,
  key = 8,
  size = 14,
  {
    steps = 0,
    fmt = formatNs,
    colors = true as any,
    symbols = SYMBOLS,
  }: { steps?: number; fmt?: (n: number) => string; colors?: any; symbols?: any } = {}
): string[] {
  const values = Object.values(map);
  const canvas = Array.from({ length: 2 + values.length }, () => '');

  steps += size;
  const lo = min(values);
  const hi = max(values);
  const step = (hi - lo) / steps;

  canvas[0] += ' '.repeat(1 + key);
  canvas[0] += symbols.tl + ' '.repeat(size) + symbols.tr;

  Object.keys(map).forEach((name, o) => {
    const value = map[name];
    const bars = Math.round((value - lo) / step);
    if (colors?.[name]) canvas[o + 1] += colors[name];

    canvas[o + 1] += truncate(name, key).padStart(key);
    if (colors?.[name]) canvas[o + 1] += ansi.reset;
    canvas[o + 1] += ' ' + symbols.legend;

    if (colors) canvas[o + 1] += ansi.gray;
    canvas[o + 1] += symbols.bar.repeat(bars);
    if (colors) canvas[o + 1] += ansi.reset;

    canvas[o + 1] += ' ';
    if (colors) canvas[o + 1] += ansi.yellow;
    canvas[o + 1] += fmt(value);
    if (colors) canvas[o + 1] += ansi.reset;
  });

  canvas[canvas.length - 1] += ' '.repeat(1 + key);
  canvas[canvas.length - 1] += symbols.bl + ' '.repeat(size) + symbols.br;

  return canvas;
}
