/**
 * Non-parametric benchmark sample comparison.
 * Mann-Whitney U test that is robust to GC-induced outliers and
 * non-normal distributions. No external dependencies.
 */

export function median(a: number[]): number {
  if (a.length === 0) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median absolute deviation, a robust spread metric paired with median. */
export function mad(a: number[]): number {
  if (a.length < 2) return 0;
  const m = median(a);
  return median(a.map((v) => Math.abs(v - m)));
}

/**
 * Mann-Whitney U test (two-tailed).
 * Ranks all combined samples, sums ranks for group A, derives U and p-value
 * via normal approximation. Accurate for n > ~20 (the engine yields 50+ samples).
 *
 * Returns { U, z, p } where p is the two-tailed p-value.
 */
export function mannWhitneyU(a: number[], b: number[]): { U: number; z: number; p: number } {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 === 0 || n2 === 0) return { U: 0, z: 0, p: 1 };

  // Merge and rank (average ranks for ties)
  const combined = [...a.map((v) => ({ v, group: 0 })), ...b.map((v) => ({ v, group: 1 }))].sort(
    (x, y) => x.v - y.v
  );

  const ranks = new Float64Array(combined.length);
  let i = 0;
  while (i < combined.length) {
    let j = i;
    while (j < combined.length - 1 && combined[j + 1].v === combined[i].v) j++;
    const avgRank = (i + j) / 2 + 1; // 1-indexed
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    i = j + 1;
  }

  let R1 = 0;
  for (let k = 0; k < combined.length; k++) {
    if (combined[k].group === 0) R1 += ranks[k];
  }

  const U1 = R1 - (n1 * (n1 + 1)) / 2;
  const U = Math.min(U1, n1 * n2 - U1); // use smaller U for the approximation

  const mean = (n1 * n2) / 2;
  const sd = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  const z = sd === 0 ? 0 : (U - mean) / sd;

  // Two-tailed p-value via erfc: p = erfc(|z| / sqrt(2))
  const p = erfc(Math.abs(z) / Math.SQRT2);

  return { U: U1, z, p };
}

/** Complementary error function approximation (Abramowitz & Stegun 7.1.26). */
function erfc(x: number): number {
  if (x < 0) return 2 - erfc(-x);
  const t = 1 / (1 + 0.3275911 * x);
  const poly =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return poly * Math.exp(-(x * x));
}

/**
 * Cliff's delta is a non-parametric effect size measuring how separated two
 * distributions are. Returns a value in [-1, +1]: 0 = perfect overlap,
 * ±1 = no overlap. Positive when `a` tends to be larger than `b`.
 *
 * Standard interpretation (Romano et al. 2006):
 *   |d| < 0.147  negligible
 *   |d| < 0.33   small
 *   |d| < 0.474  medium
 *   |d| ≥ 0.474  large
 */
export function cliffsD(a: number[], b: number[]): number {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 === 0 || n2 === 0) return 0;
  let more = 0;
  let less = 0;
  for (let i = 0; i < n1; i++) {
    for (let j = 0; j < n2; j++) {
      if (a[i] > b[j]) more++;
      else if (a[i] < b[j]) less++;
    }
  }
  return (more - less) / (n1 * n2);
}

/**
 * Smallest relative Δp50 worth believing, given how noisy the samples are.
 *
 * Guards against between-run environmental drift (clock speed, thermal state,
 * background load): offsets that shift every sample equally, so they don't
 * shrink with sample count and the MW-U test can't detect them. Per-sample
 * jitter (MAD/median of the noisier run) is used as a proxy for that drift,
 * scaled by a heuristic 3×. Never returns less than `floor`.
 *
 * Stable system (pinned freq): MAD/median ≈ 0.5% → max(floor, 1.5%)
 * Noisy system (Apple Silicon): MAD/median ≈ 2%   → 6%
 */
const NOISE_SCALE = 3;

export function minMeaningfulDelta(a: number[], b: number[], floor: number): number {
  const medA = median(a);
  const medB = median(b);
  const relA = medA > 0 ? mad(a) / medA : 0;
  const relB = medB > 0 ? mad(b) / medB : 0;
  return Math.max(floor, NOISE_SCALE * Math.max(relA, relB));
}

/**
 * Relative spread of per-block medians: MAD scaled to sigma equivalent, over
 * the median. Captures how much fresh-process runs of the same bench differ,
 * which is the variance a single process cannot observe.
 */
export function blockSpread(medians: number[]): number {
  if (medians.length < 2) return 0;
  const m = median(medians);
  if (m <= 0) return 0;
  return (1.4826 * mad(medians)) / m;
}

/**
 * Smallest relative delta a comparison of two runs with this between-block
 * spread can reliably detect (roughly alpha 0.05 at 0.8 power, comparing
 * means of `blocks` block medians per side).
 */
export function minDetectableEffect(spread: number, blocks: number): number {
  if (blocks < 2 || spread <= 0) return 0;
  return 2.8 * spread * Math.sqrt(2 / blocks);
}

export type Verdict = 'faster' | 'slower' | 'neutral';

export interface ClassifyOptions {
  /** Mann-Whitney U two-tailed significance level. @default 0.05 */
  alpha?: number;
  /** Minimum absolute Δp50 ratio to flag a verdict (floor for noise-adjusted threshold). @default 0.05 */
  minDelta?: number;
  /** Minimum |Cliff's d| to flag a verdict. Filters noise on high-variance benches. @default 0.474 */
  minEffect?: number;
}

/**
 * Three-gate classification:
 *   1. p ≤ alpha: statistical significance (Mann-Whitney U)
 *   2. |Δp50| ≥ effectiveMinDelta: practical magnitude, noise-adjusted
 *   3. |cliff's d| ≥ minEffect: effect size ("are the distributions actually separated?")
 * All three must hold to declare faster or slower.
 */
export function classify(
  baselineSamples: number[],
  candidateSamples: number[],
  opts?: ClassifyOptions
): {
  verdict: Verdict;
  p: number;
  d: number;
  effectiveMinDelta: number;
} {
  const alpha = opts?.alpha ?? 0.05;
  const minDelta = opts?.minDelta ?? 0.05;
  const minEffect = opts?.minEffect ?? 0.474;
  const effectiveMinDelta = minMeaningfulDelta(baselineSamples, candidateSamples, minDelta);
  const { p } = mannWhitneyU(baselineSamples, candidateSamples);
  const d = cliffsD(baselineSamples, candidateSamples);

  let verdict: Verdict = 'neutral';
  if (p <= alpha && Math.abs(d) >= minEffect) {
    const bMed = median(baselineSamples);
    const cMed = median(candidateSamples);
    const ratio = bMed > 0 ? Math.abs(cMed - bMed) / bMed : 0;
    if (ratio >= effectiveMinDelta) {
      verdict = cMed > bMed ? 'slower' : 'faster';
    }
  }

  return { verdict, p, d, effectiveMinDelta };
}
