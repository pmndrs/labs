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

/** Largest combined sample size where the exact Mann-Whitney distribution is used. */
const MW_U_EXACT_MAX_TOTAL = 50;

/**
 * Exact two-sided Mann-Whitney p-value from the conditional permutation
 * distribution of the observed ranks. Doubled integer ranks keep tied
 * midranks exact, while treating equal-valued observations as distinct
 * assignments gives every allocation of group labels its proper weight.
 */
function exactMannWhitneyP(ranks: Float64Array, n1: number, observedRankSum: number): number {
  const doubledRanks = Array.from(ranks, (rank) => Math.round(rank * 2));
  const maxRankSum = doubledRanks
    .slice()
    .sort((a, b) => b - a)
    .slice(0, n1)
    .reduce((sum, rank) => sum + rank, 0);
  const counts = Array.from({ length: n1 + 1 }, () => new Float64Array(maxRankSum + 1));
  counts[0][0] = 1;

  let seen = 0;
  for (const rank of doubledRanks) {
    seen++;
    for (let selected = Math.min(n1, seen); selected >= 1; selected--) {
      const row = counts[selected];
      const previous = counts[selected - 1];
      for (let sum = maxRankSum; sum >= rank; sum--) {
        row[sum] += previous[sum - rank];
      }
    }
  }

  const observed = Math.round(observedRankSum * 2);
  let lower = 0;
  let upper = 0;
  let total = 0;
  for (let sum = 0; sum <= maxRankSum; sum++) {
    const count = counts[n1][sum];
    total += count;
    if (sum <= observed) lower += count;
    if (sum >= observed) upper += count;
  }

  return total === 0 ? 1 : Math.min(1, (2 * Math.min(lower, upper)) / total);
}

/**
 * Mann-Whitney U test (two-tailed).
 * Ranks all combined samples and sums ranks for group A. Samples with at most
 * 50 values combined get the exact conditional permutation distribution,
 * including ties. Larger samples use the tie-corrected normal approximation.
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

  let tieTerm = 0;
  const ranks = new Float64Array(combined.length);
  let i = 0;
  while (i < combined.length) {
    let j = i;
    while (j < combined.length - 1 && combined[j + 1].v === combined[i].v) j++;
    const tieSize = j - i + 1;
    tieTerm += tieSize ** 3 - tieSize;
    const avgRank = (i + j) / 2 + 1; // 1-indexed
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    i = j + 1;
  }

  let R1 = 0;
  for (let k = 0; k < combined.length; k++) {
    if (combined[k].group === 0) R1 += ranks[k];
  }

  const U1 = R1 - (n1 * (n1 + 1)) / 2;
  const mean = (n1 * n2) / 2;
  const total = n1 + n2;
  const variance = (n1 * n2 * (total + 1 - (total > 1 ? tieTerm / (total * (total - 1)) : 0))) / 12;
  const sd = Math.sqrt(Math.max(0, variance));
  const centered = U1 - mean;
  const continuityCorrected = Math.sign(centered) * Math.max(0, Math.abs(centered) - 0.5);
  const z = sd === 0 ? 0 : continuityCorrected / sd;

  if (total <= MW_U_EXACT_MAX_TOTAL) {
    return { U: U1, z, p: exactMannWhitneyP(ranks, n1, R1) };
  }

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

/** Exact tie-free null distribution of the Mann-Whitney U statistic, P(U = u). */
function mannWhitneyNullDistribution(n1: number, n2: number): Float64Array {
  const width = n1 * n2 + 1;
  // table[m][u] = P(U = u) for m group-one values among m + n combined
  let table: Float64Array[] = Array.from({ length: n1 + 1 }, () => {
    const row = new Float64Array(width);
    row[0] = 1;
    return row;
  });

  for (let n = 1; n <= n2; n++) {
    const next: Float64Array[] = [];
    for (let m = 0; m <= n1; m++) {
      const row = new Float64Array(width);
      if (m === 0) {
        row[0] = 1;
      } else {
        // Largest remaining value is from group one with probability m/(m+n),
        // contributing n to U, otherwise from group two contributing nothing
        const pm = m / (m + n);
        const fromOne = next[m - 1];
        const fromTwo = table[m];
        for (let u = 0; u < width; u++) {
          row[u] = pm * (u >= n ? fromOne[u - n] : 0) + (1 - pm) * fromTwo[u];
        }
      }
      next.push(row);
    }
    table = next;
  }

  return table[n1];
}

/** Largest u with P(U ≤ u) ≤ alpha/2 under the exact null, or -1 if none. */
function mannWhitneyCriticalU(n1: number, n2: number, alpha: number): number {
  const dist = mannWhitneyNullDistribution(n1, n2);
  let cumulative = 0;
  let critical = -1;
  for (let u = 0; u < dist.length; u++) {
    cumulative += dist[u];
    if (cumulative <= alpha / 2 + 1e-12) critical = u;
    else break;
  }
  return critical;
}

/**
 * Hodges-Lehmann relative shift between two positive samples, with a
 * confidence interval from inverting the exact Mann-Whitney test: the
 * estimate is the median of all pairwise candidate/baseline ratios and the
 * interval endpoints are the ratios at the exact critical ranks. Critical
 * values assume no ties, so ties make the interval slightly conservative.
 *
 * Returns relative deltas (ratio − 1); positive means candidate is larger.
 */
export function hodgesLehmannDelta(
  baseline: number[],
  candidate: number[],
  alpha = 0.05
): { delta: number; low: number; high: number } {
  const ratios: number[] = [];
  for (const c of candidate) {
    for (const b of baseline) {
      if (b > 0) ratios.push(c / b);
    }
  }
  if (ratios.length === 0) return { delta: 0, low: 0, high: 0 };
  ratios.sort((a, b) => a - b);

  const critical = mannWhitneyCriticalU(baseline.length, candidate.length, alpha);
  const lowIndex = Math.max(0, critical);
  const highIndex = Math.min(ratios.length - 1, ratios.length - 1 - Math.max(0, critical));
  return {
    delta: median(ratios) - 1,
    low: ratios[Math.min(lowIndex, highIndex)] - 1,
    high: ratios[Math.max(lowIndex, highIndex)] - 1,
  };
}

/**
 * Fraction of fresh-run median spread explained by calibration-rate
 * differences. Compares raw run medians with calibration-normalized medians.
 * A value of 1 means normalization removes all spread; 0 means it does not
 * help or makes the spread worse.
 */
export function calibrationExplainedFraction(medians: number[], calibrationRates: number[]): number {
  if (medians.length < 2 || medians.length !== calibrationRates.length) return 0;
  if (calibrationRates.some((rate) => !(rate > 0))) return 0;
  const time = runMedianSpread(medians);
  if (time <= 0) return 0;
  const normalized = runMedianSpread(medians.map((median, i) => median * calibrationRates[i]));
  return Math.max(0, Math.min(1, 1 - (normalized / time) ** 2));
}

/**
 * Relative spread of fresh-run medians: MAD scaled to sigma equivalent, over
 * the median. Captures process-to-process variation that one run cannot see.
 */
export function runMedianSpread(medians: number[]): number {
  if (medians.length < 2) return 0;
  const m = median(medians);
  if (m <= 0) return 0;
  return (1.4826 * mad(medians)) / m;
}

/**
 * Rough planning estimate of the smallest relative delta a comparison of two
 * runs with this fresh-run median spread could detect. The 2.8 constant is the
 * normal-theory factor for alpha 0.05 at 0.8 power comparing equal-size
 * means, while actual verdicts use a rank test on run medians, so treat
 * this as an order-of-magnitude guide, not a guarantee.
 */
export function minDetectableEffect(spread: number, freshRuns: number): number {
  if (freshRuns < 2 || spread <= 0) return 0;
  return 2.8 * spread * Math.sqrt(2 / freshRuns);
}

/**
 * A benchmark's comparison resolution: the smallest relative delta its
 * fresh-run median spread could plausibly detect. Derived from saved medians
 * on demand, so it always reflects the data and
 * whatever threshold the current config compares it against.
 */
export function comparisonResolution(medians: number[]): number {
  return minDetectableEffect(runMedianSpread(medians), medians.length);
}

/** Smallest attainable two-sided exact Mann-Whitney p-value for two sample sizes. */
export function minMannWhitneyP(n1: number, n2: number): number {
  if (n1 < 1 || n2 < 1) return 1;
  const total = n1 + n2;
  const selected = Math.min(n1, n2);
  let logCombinations = 0;
  for (let i = 1; i <= selected; i++) {
    logCombinations += Math.log(total - selected + i) - Math.log(i);
  }
  return Math.min(1, 2 * Math.exp(-logCombinations));
}

export type Verdict = 'faster' | 'slower' | 'neutral';

export interface ClassifyOptions {
  /** Mann-Whitney U two-tailed significance level. @default 0.05 */
  alpha?: number;
  /** Minimum |Hodges-Lehmann delta| to flag a verdict (practical significance). @default 0.05 */
  minDelta?: number;
}

/**
 * Two-gate classification on independent units (block medians):
 *   1. p ≤ alpha: statistical significance (exact Mann-Whitney U)
 *   2. |Hodges-Lehmann delta| ≥ minDelta: practical magnitude
 * Both must hold to declare faster or slower. Cliff's d is reported for
 * context but not gated: on the same units it is a linear transform of the
 * U statistic already behind the p-value. The confidence interval comes from
 * inverting the exact test.
 */
export function classify(
  baselineSamples: number[],
  candidateSamples: number[],
  opts?: ClassifyOptions
): {
  verdict: Verdict;
  p: number;
  d: number;
  /** Hodges-Lehmann relative delta; positive means candidate is slower. */
  hl: number;
  ciLow: number;
  ciHigh: number;
  minDelta: number;
} {
  const alpha = opts?.alpha ?? 0.05;
  const minDelta = opts?.minDelta ?? 0.05;
  const { p } = mannWhitneyU(baselineSamples, candidateSamples);
  const d = cliffsD(baselineSamples, candidateSamples);
  const {
    delta: hl,
    low: ciLow,
    high: ciHigh,
  } = hodgesLehmannDelta(baselineSamples, candidateSamples, alpha);

  let verdict: Verdict = 'neutral';
  if (p <= alpha && Math.abs(hl) >= minDelta) {
    verdict = hl > 0 ? 'slower' : 'faster';
  }

  return { verdict, p, d, hl, ciLow, ciHigh, minDelta };
}
