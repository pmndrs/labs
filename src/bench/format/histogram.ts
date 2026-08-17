/**
 * Histogram renderer for benchmark sample distributions.
 *
 * Produces compact sparkline-style histograms using Unicode block characters,
 * with optional ANSI coloring (cyan < avg, yellow = avg, magenta > avg).
 */

import { clamp, max } from '../../utils/math.ts';
import { ansi } from '../../utils/ansi.ts';

/** Block elements used for bar height at sub-character resolution. */
export const SYMBOLS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** Binned distribution from {@link bins}, ready for rendering. */
export interface BinnedHistogram {
  min: number;
  max: number;
  step: number;
  bins: number[];
  steps: number[];
  peak: number;
  outliers: number;
  /** Bin index of the average. */
  avg: number;
}

/**
 * Bin sorted benchmark samples into a fixed number of buckets.
 *
 * @param stats  - Must contain sorted `samples`, `min`, `max`, and `avg`.
 * @param size   - Number of bins (default 6).
 * @param percentile - Upper percentile cutoff (default 1 = 100%). Samples beyond
 *                     this are counted as outliers.
 */
export function bins(
  stats: { samples: number[]; min: number; max: number; avg: number },
  size = 6,
  percentile = 1
): BinnedHistogram {
  const offset = (percentile * (stats.samples.length - 1)) | 0;

  let min = stats.min;
  const maxVal = stats.samples[offset] || stats.max || 1;

  const steps = Array.from({ length: size }, () => 0);
  const b = Array.from({ length: size }, () => 0);
  const step = (maxVal - min) / (size - 1);

  if (0 === step) {
    min = 0;
    for (let o = 0; o < size; o++) steps[o] = o * step;
    b[clamp(0, Math.round((stats.avg - min) / step), size - 1)] = 1;
  } else {
    for (let o = 0; o < size; o++) steps[o] = min + o * step;
    for (let o = 0; o <= offset; o++) b[Math.round((stats.samples[o] - min) / step)]++;
  }

  return {
    min,
    max: maxVal,
    step,
    bins: b,
    steps,
    peak: max(b),
    outliers: stats.samples.length - 1 - offset,
    avg: clamp(0, Math.round((stats.avg - min) / step), size - 1),
  };
}

/**
 * Render a binned histogram as an array of sparkline strings.
 *
 * @param binned  - Output of {@link bins}.
 * @param height  - Number of text rows (default 1).
 * @param opts.colors  - Enable ANSI coloring (default true).
 * @param opts.symbols - Block characters to use (default {@link SYMBOLS}).
 * @returns Array of strings, bottom row first (reversed so index 0 = bottom).
 */
export function ascii(
  binned: BinnedHistogram,
  height = 1,
  { colors = true as any, symbols = SYMBOLS }: { colors?: any; symbols?: string[] } = {}
): string[] {
  const canvas = Array.from({ length: height }, () => '');
  const { avg, peak, bins: b } = binned;
  const scale = (height * symbols.length - 1) / peak;

  for (let y = 0; y < height; y++) {
    let l = '';

    if (0 !== avg) {
      if (colors) l += ansi.cyan;

      for (let o = 0; o < avg; o++) {
        const v = b[o];
        if (y === 0) l += symbols[clamp(0, Math.round(v * scale), symbols.length - 1)];
        else {
          const lo = y * symbols.length;
          const hi = (y + 1) * symbols.length;
          const off = Math.round(v * scale) | 0;

          if (lo >= off) l += ' ';
          else if (hi <= off) l += symbols[symbols.length - 1];
          else l += symbols[clamp(lo, off, hi) % symbols.length];
        }
      }

      if (colors) l += ansi.reset;
    }

    {
      if (colors) l += ansi.yellow;

      const v = b[avg];
      if (y === 0) l += symbols[clamp(0, Math.round(v * scale), symbols.length - 1)];
      else {
        const lo = y * symbols.length;
        const hi = (y + 1) * symbols.length;
        const off = Math.round(v * scale) | 0;

        if (lo >= off) l += ' ';
        else if (hi <= off) l += symbols[symbols.length - 1];
        else l += symbols[clamp(lo, off, hi) % symbols.length];
      }

      if (colors) l += ansi.reset;
    }

    if (avg != b.length - 1) {
      if (colors) l += ansi.magenta;

      for (let o = 1 + avg; o < b.length; o++) {
        const v = b[o];
        if (y === 0) l += symbols[clamp(0, Math.round(v * scale), symbols.length - 1)];
        else {
          const lo = y * symbols.length;
          const hi = (y + 1) * symbols.length;
          const off = Math.round(v * scale) | 0;

          if (lo >= off) l += ' ';
          else if (hi <= off) l += symbols[symbols.length - 1];
          else l += symbols[clamp(lo, off, hi) % symbols.length];
        }
      }

      if (colors) l += ansi.reset;
    }

    canvas[y] = l;
  }

  return canvas.reverse();
}
