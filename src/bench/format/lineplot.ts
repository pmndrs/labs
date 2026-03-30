/**
 * Line-chart renderer for terminal output using braille-dot canvas.
 *
 * Plots one or more named data series onto a braille canvas, with optional
 * ANSI coloring and axis labels.
 */

import { ansi, COLOR_NAMES } from '../../utils/ansi.ts';
import { truncate } from '../../utils/units.ts';
import { braille } from './canvas.ts';

/** Box-drawing corner symbols for the chart frame. */
export const SYMBOLS = { tl: '┌', tr: '┐', bl: '└', br: '┘' };

/**
 * Render a multi-series line chart as an array of strings.
 *
 * @param map  - `{ name: { x: number[], y: number[], format?: fn } }` series data.
 * @param opts - Chart dimensions, axis bounds, labels, and colors.
 * @returns Array of strings (one per output row, including frame).
 */
export function ascii(
  map: Record<string, any>,
  {
    colors = true as any,
    xmin = 0,
    xmax = 1,
    ymin = 0,
    ymax = 1,
    symbols = SYMBOLS,
    key = 8,
    width = 12,
    height = 12,
    labels = { xmin: null, xmax: null, ymin: null, ymax: null } as any,
  }: any = {}
): string[] {
  const keys = Object.keys(map);
  const _canvas = braille(width, height);
  const xs = (_canvas.vwidth - 1) / (xmax - xmin);
  const ys = (_canvas.vheight - 1) / (ymax - ymin);

  const colorsv = Object.entries(colors)
    .filter(([n]) => !Object.keys(labels).includes(n))
    .map(([_, v]) => v);

  const acolors = COLOR_NAMES.filter((n) => !colorsv.includes(ansi[n]));

  keys.forEach((name, k) => {
    const { x: xp, y: yp } = map[name];

    for (let o = 0; o < xp.length - 1; o++) {
      if (null == xp[o] || null == xp[o + 1]) continue;
      if (null == yp[o] || null == yp[o + 1]) continue;
      const s = {
        x: Math.round(xs * (xp[o] - xmin)),
        y: _canvas.vheight - 1 - Math.round(ys * (yp[o] - ymin)),
      };
      const e = {
        x: Math.round(xs * (xp[o + 1] - xmin)),
        y: _canvas.vheight - 1 - Math.round(ys * (yp[o + 1] - ymin)),
      };

      _canvas.line(s, e, 1 + k);
    }
  });

  const canvas = Array.from({ length: 2 + _canvas.height }, () => '');

  canvas[0] += ' '.repeat(1 + key);
  canvas[0] += symbols.tl + ' '.repeat(width) + symbols.tr;

  const lines = _canvas.toString({
    format(x: number, y: number, s: string, tag: number) {
      const name = keys[tag - 1];
      if (map[name].format) return map[name].format(x, y, s);
      else if (colors?.[name]) return colors[name] + s + ansi.reset;
      else return ansi[acolors[(tag - 1) % acolors.length]] + s + ansi.reset;
    },
  });

  const plabels: Record<number, string> = {
    0: !colors?.ymax ? labels.ymax || '' : colors.ymax + (labels.ymax || '') + ansi.reset,
    [lines.length - 1]: !colors?.ymin
      ? labels.ymin || ''
      : colors.ymin + (labels.ymin || '') + ansi.reset,
  };

  const legends = keys.map((name, k) => {
    if (colors?.[name]) return colors[name] + truncate(name, key).padStart(key) + ansi.reset;
    else return ansi[acolors[k % acolors.length]] + truncate(name, key).padStart(key) + ansi.reset;
  });

  lines.forEach((l, o) => {
    canvas[o + 1] += legends[o] ?? ' '.repeat(key);
    canvas[o + 1] += ' '.repeat(2) + l + (!plabels[o] ? '' : ' ' + plabels[o]);
  });

  canvas[canvas.length - 1] += ' '.repeat(1 + key);
  canvas[canvas.length - 1] += symbols.bl + ' '.repeat(width) + symbols.br;

  if (labels.xmin || labels.xmax) {
    const xminL: string = labels.xmin || '';
    const xmaxL: string = labels.xmax || '';
    const gap = 2 + width - xminL.length;

    canvas.push(
      ' '.repeat(key) +
        ' ' +
        (!colors?.xmin ? xminL : colors.xmin + xminL + ansi.reset) +
        (!colors?.xmax ? xmaxL.padStart(gap) : colors.xmax + xmaxL.padStart(gap) + ansi.reset)
    );
  }

  return canvas;
}
