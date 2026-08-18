import type { LabsConfig } from './config.ts';
import { renderDistributions } from './histogram.ts';
import {
  type ClassifyOptions,
  type Verdict,
  benchResolution,
  classify,
  median,
  minMannWhitneyP,
} from './stats.ts';
import { type FreqSample, type GitInfo, type SavedResult, isEnvironmentStable } from './store.ts';
import { gitHint } from './cli/utils.ts';
import { BOLD, CYAN, DARK_GRAY, DIM, GRAY, GREEN, RED, RESET, WHITE, YELLOW } from './utils/ansi.ts';
import { formatDelta, formatP, formatTime } from './utils/format.ts';

// ─── Check infrastructure ────────────────────────────────────────────────────

type CheckResult = { ok: true } | { ok: false; reason: string };

type EnvironmentCheck = (baseline: SavedResult, candidate: SavedResult) => CheckResult;

interface BenchData {
  samples: number[];
  /** Per-block medians, the independent experimental units. */
  blocks?: number[];
  /** Isolation mode of the run this bench came from, for actionable skip reasons. */
  isolation?: 'bench' | 'file';
}

type BenchCheck = (baseline: BenchData, candidate: BenchData, config: LabsConfig) => CheckResult;

// ─── Environment checks ──────────────────────────────────────────────────────

/** Max relative difference between the two runs' median clock speeds to consider them comparable. */
const CLOCK_COMPARE_THRESHOLD = 0.05;

// Run-level clock signals use only the two long calibrated readings
// (runFreq/postFreq). The cheap 50ms per-block probes estimate the clock with
// a different warmup and budget, so they are only ever compared against each
// other (block-level: clock attribution and the clock-confounded gate) —
// pooling them here would read the calibration offset as drift.
function medianFreq(freqs: FreqSample[]): number {
  if (freqs.length === 0) return 0;
  const all = freqs.flatMap((s) => [s.runFreq, s.postFreq]);
  return median(all);
}

export const checkHardwareMatch: EnvironmentCheck = (baseline, candidate) => {
  const hw1 = baseline.hardware;
  const hw2 = candidate.hardware;
  const mismatches: string[] = [];
  if (hw1.cpu !== hw2.cpu) mismatches.push(`CPU: "${hw1.cpu}" vs "${hw2.cpu}"`);
  if (hw1.arch !== hw2.arch) mismatches.push(`arch: ${hw1.arch} vs ${hw2.arch}`);
  if (hw1.runtime !== hw2.runtime) mismatches.push(`runtime: ${hw1.runtime} vs ${hw2.runtime}`);
  if (mismatches.length > 0) return { ok: false, reason: mismatches.join(', ') };
  return { ok: true };
};

function freqDrift(freqs: FreqSample[]): number {
  if (freqs.length === 0) return 0;
  const all = freqs.flatMap((s) => [s.runFreq, s.postFreq]);
  const min = Math.min(...all);
  const max = Math.max(...all);
  return (max - min) / ((max + min) / 2);
}

// ─── Environment warnings (non-blocking) ─────────────────────────────────────

type EnvironmentWarning = (baseline: SavedResult, candidate: SavedResult) => string[];

export const warnClockDrift: EnvironmentWarning = (baseline, candidate) => {
  const warnings: string[] = [];
  const bFreqs = baseline.environment?.freqs ?? [];
  const cFreqs = candidate.environment?.freqs ?? [];

  if (!isEnvironmentStable(baseline)) {
    const drift = freqDrift(bFreqs);
    warnings.push(`baseline CPU clock drifted ${(drift * 100).toFixed(1)}% during its run`);
  }
  if (!isEnvironmentStable(candidate)) {
    const drift = freqDrift(cFreqs);
    warnings.push(`candidate CPU clock drifted ${(drift * 100).toFixed(1)}% during its run`);
  }

  let bFreq = 0;
  let cFreq = 0;
  if (bFreqs.length > 0 && cFreqs.length > 0) {
    bFreq = medianFreq(bFreqs);
    cFreq = medianFreq(cFreqs);
  } else {
    bFreq = baseline.hardware.freq;
    cFreq = candidate.hardware.freq;
  }

  if (bFreq > 0 && cFreq > 0) {
    const diff = Math.abs(bFreq - cFreq) / ((bFreq + cFreq) / 2);
    if (diff > CLOCK_COMPARE_THRESHOLD) {
      warnings.push(
        `CPU clock speeds differ between runs (${bFreq.toFixed(2)} GHz vs ${cFreq.toFixed(2)} GHz — ${(diff * 100).toFixed(1)}% apart)`
      );
    }
  }

  return warnings;
};

export const warnIsolationMismatch: EnvironmentWarning = (baseline, candidate) => {
  const b = baseline.isolation ?? 'file';
  const c = candidate.isolation ?? 'file';
  if (b === c) return [];
  return [
    `runs used different bench isolation (baseline: per-${b}, candidate: per-${c}) — ` +
      `benches sharing a process inherit each other's JIT/heap state, so absolute numbers may not be comparable`,
  ];
};

export const warnBlocksMismatch: EnvironmentWarning = (baseline, candidate) => {
  const b = baseline.blocks ?? 1;
  const c = candidate.blocks ?? 1;
  if (b === c) return [];
  return [
    `runs used different block counts (baseline: ${b}, candidate: ${c}) — ` +
      `eligibility uses the actual counts and configured significance level`,
  ];
};

export const ENVIRONMENT_WARNINGS: EnvironmentWarning[] = [
  warnClockDrift,
  warnIsolationMismatch,
  warnBlocksMismatch,
];

/** All environment checks in order. Any failure blocks the entire comparison. */
export const ENVIRONMENT_CHECKS: EnvironmentCheck[] = [checkHardwareMatch];

// ─── Per-bench checks ────────────────────────────────────────────────────────

/**
 * Samples within one process are correlated, so fresh-process blocks are the
 * independent experimental units and verdicts require block replication on
 * both sides. Eligibility also requires enough combined allocations for the
 * exact test to reach the configured alpha.
 *
 * There is deliberately no noisiness gate: the exact test on block medians is
 * already spread-aware (high spread widens the CI and lifts p), so noisy
 * benches keep their verdicts and are annotated with their resolution in the
 * report instead of being hidden.
 */
const MIN_REPLICATED_BLOCKS = 2;

export const checkBlockReplication: BenchCheck = (baseline, candidate, config) => {
  const bN = baseline.blocks?.length ?? 1;
  const cN = candidate.blocks?.length ?? 1;
  if (bN < MIN_REPLICATED_BLOCKS || cN < MIN_REPLICATED_BLOCKS) {
    // With isolation off the runner forces single-block runs, so "re-save"
    // would be a dead end — say what actually has to change.
    const fix =
      baseline.isolation === 'file' || candidate.isolation === 'file'
        ? 'blocked sampling requires isolation; enable isolate and re-save'
        : 're-save with blocked sampling';
    return {
      ok: false,
      reason:
        `insufficient block replication (baseline: ${bN}, candidate: ${cN}; ` +
        `need ≥${MIN_REPLICATED_BLOCKS} per side) — ${fix}`,
    };
  }

  const alpha = config.alpha ?? 0.05;
  const minP = minMannWhitneyP(bN, cN);
  if (minP <= alpha) return { ok: true };
  return {
    ok: false,
    reason:
      `block counts cannot reach α=${alpha} ` +
      `(baseline: ${bN}, candidate: ${cN}; smallest attainable p=${minP.toPrecision(2)}) — ` +
      `add blocks`,
  };
};

/** All per-bench checks in order. Any failure skips that bench with a reason. */
export const BENCH_CHECKS: BenchCheck[] = [checkBlockReplication];

// ─── Data types ──────────────────────────────────────────────────────────────

export interface BenchKey {
  file: string;
  group: string;
  name: string;
}

export interface EligibleBench {
  kind: 'eligible';
  key: BenchKey;
  baselineP50: number;
  candidateP50: number;
  baselineSamples: number[];
  candidateSamples: number[];
  deltaP50: number;
  deltaP99: number;
  p: number;
  d: number;
  verdict: Verdict;
  /** Hodges-Lehmann relative delta on block medians; positive means slower. */
  hl: number;
  ciLow: number;
  ciHigh: number;
  /**
   * Worse of the two sides' between-run resolutions (minimum detectable
   * effect from between-block spread). Above minDelta the row is annotated
   * noisy: verdicts still stand, but a neutral means "could not tell", not
   * "no change".
   */
  resolution: number;
}

export interface SkippedBench {
  kind: 'skipped';
  key: BenchKey;
  reason: string;
}

export interface MissingBench {
  kind: 'missing';
  key: BenchKey;
  presentIn: 'baseline' | 'candidate';
}

export type BenchResult = EligibleBench | SkippedBench | MissingBench;

export interface CompareResult {
  baselineName: string;
  candidateName: string;
  baselineGit?: GitInfo;
  candidateGit?: GitInfo;
  hardware: SavedResult['hardware'];
  environmentFailures: string[];
  environmentWarnings: string[];
  benches: BenchResult[];
}

// ─── Trial normalization ────────────────────────────────────────────────────

type LegacyTrial = {
  alias?: string;
  groupName?: string;
  stats?: { samples?: number[]; noisy?: boolean; p99?: number };
  runs?: Array<{ name?: string; stats?: { samples?: number[]; noisy?: boolean; p99?: number } }>;
};

type ComparableTrial = SavedResult['files'][number]['benchmarks'][number] | LegacyTrial;

function trialRuns(trial: ComparableTrial): Array<{
  name: string;
  samples: number[];
  p99: number;
  blocks?: number[];
  freqs?: number[];
}> {
  const alias = (trial as any).alias ?? 'anonymous';
  const runs = (trial as any).runs as Array<any> | undefined;
  const fromStats = (name: string, stats: any) => ({
    name,
    samples: Array.isArray(stats?.samples) ? stats.samples : [],
    p99: typeof stats?.p99 === 'number' ? stats.p99 : 0,
    ...(Array.isArray(stats?.blocks?.medians) ? { blocks: stats.blocks.medians } : {}),
    ...(Array.isArray(stats?.blocks?.freqs) ? { freqs: stats.blocks.freqs } : {}),
  });

  if (Array.isArray(runs) && runs.length > 0) {
    return runs.map((run) => fromStats(run?.name ?? alias, run?.stats));
  }

  return [fromStats(alias, (trial as any).stats)];
}

// ─── Index helpers ───────────────────────────────────────────────────────────

interface IndexEntry {
  p99: number;
  samples: number[];
  blocks?: number[];
  freqs?: number[];
}

function buildIndex(result: SavedResult): Map<string, IndexEntry> {
  const map = new Map<string, IndexEntry>();
  for (const f of result.files) {
    for (const trial of f.benchmarks) {
      for (const run of trialRuns(trial)) {
        const key = `${f.file}\0${trial.groupName ?? ''}\0${run.name}`;
        map.set(key, {
          p99: run.p99,
          samples: run.samples,
          ...(run.blocks ? { blocks: run.blocks } : {}),
          ...(run.freqs ? { freqs: run.freqs } : {}),
        });
      }
    }
  }
  return map;
}

function trialKey(
  file: string,
  trial: SavedResult['files'][number]['benchmarks'][number],
  runName: string
): string {
  return `${file}\0${trial.groupName ?? ''}\0${runName}`;
}

function benchKey(
  file: string,
  trial: SavedResult['files'][number]['benchmarks'][number],
  runName: string
): BenchKey {
  return { file, group: trial.groupName ?? trial.alias, name: runName };
}

// ─── Clock gate ──────────────────────────────────────────────────────────────

/**
 * Median block clocks must differ by more than this before the cycles
 * cross-check can veto a verdict. The per-block probes carry a percent or two
 * of jitter; below this threshold a time/cycles disagreement says more about
 * probe noise than about the clock, and skipping would eat real verdicts.
 */
const CLOCK_GATE_MIN_DIFF = 0.02;

/**
 * Re-judges a bench in cycles instead of time and returns a skip reason when
 * the two verdicts disagree. Only applies when both sides carry a valid clock
 * probe for every block and the runs' median block clocks actually differ
 * (beyond CLOCK_GATE_MIN_DIFF); with equal clocks the cycles data is just
 * time scaled by probe jitter, so the gate stays inert.
 */
function clockConfounded(
  base: IndexEntry,
  candidate: IndexEntry,
  timeVerdict: Verdict,
  opts: ClassifyOptions
): string | undefined {
  const bFreqs = base.freqs;
  const cFreqs = candidate.freqs;
  const usable = (blocks?: number[], freqs?: number[]) =>
    blocks && freqs && freqs.length === blocks.length && freqs.every((f) => f > 0);
  if (!usable(base.blocks, bFreqs) || !usable(candidate.blocks, cFreqs)) return undefined;

  const bClock = median(bFreqs!);
  const cClock = median(cFreqs!);
  const clockDiff = Math.abs(bClock - cClock) / ((bClock + cClock) / 2);
  if (clockDiff <= CLOCK_GATE_MIN_DIFF) return undefined;

  const cycles = (blocks: number[], freqs: number[]) => blocks.map((m, i) => m * freqs[i]);
  const cyclesVerdict = classify(
    cycles(base.blocks!, bFreqs!),
    cycles(candidate.blocks!, cFreqs!),
    opts
  ).verdict;
  if (cyclesVerdict === timeVerdict) return undefined;

  return (
    `clock-confounded — time-based verdict "${timeVerdict}" but cycles-based "${cyclesVerdict}" ` +
    `(median clocks ${bClock.toFixed(2)} vs ${cClock.toFixed(2)} GHz)`
  );
}

// ─── Core comparison ─────────────────────────────────────────────────────────

export function compare(
  baseline: SavedResult,
  candidate: SavedResult,
  config: LabsConfig
): CompareResult {
  const opts: ClassifyOptions = {
    alpha: config.alpha,
    minDelta: config.minDelta,
  };

  const environmentFailures: string[] = [];
  for (const check of ENVIRONMENT_CHECKS) {
    const result = check(baseline, candidate);
    if (!result.ok) environmentFailures.push(result.reason);
  }

  const environmentWarnings: string[] = [];
  for (const warn of ENVIRONMENT_WARNINGS) {
    environmentWarnings.push(...warn(baseline, candidate));
  }

  const benches: BenchResult[] = [];

  if (environmentFailures.length > 0) {
    return {
      baselineName: baseline.name,
      candidateName: candidate.name,
      ...(baseline.git ? { baselineGit: baseline.git } : {}),
      ...(candidate.git ? { candidateGit: candidate.git } : {}),
      hardware: baseline.hardware,
      environmentFailures,
      environmentWarnings,
      benches,
    };
  }

  const baseIndex = buildIndex(baseline);
  const candidateIndex = buildIndex(candidate);

  for (const [key] of baseIndex) {
    if (!candidateIndex.has(key)) {
      const parts = key.split('\0');
      benches.push({
        kind: 'missing',
        key: { file: parts[0], group: parts[1] || parts[2], name: parts[2] },
        presentIn: 'baseline',
      });
    }
  }

  for (const f of candidate.files) {
    for (const trial of f.benchmarks) {
      for (const run of trialRuns(trial)) {
        const key = trialKey(f.file, trial, run.name);
        const key_ = benchKey(f.file, trial, run.name);
        const base = baseIndex.get(key);

        if (base === undefined) {
          benches.push({ kind: 'missing', key: key_, presentIn: 'candidate' });
          continue;
        }

        const benchData = {
          baseline: { samples: base.samples, blocks: base.blocks, isolation: baseline.isolation },
          candidate: { samples: run.samples, blocks: run.blocks, isolation: candidate.isolation },
        };

        let skipReason: string | undefined;
        for (const check of BENCH_CHECKS) {
          const result = check(benchData.baseline, benchData.candidate, config);
          if (!result.ok) {
            skipReason = result.reason;
            break;
          }
        }

        if (skipReason !== undefined) {
          benches.push({ kind: 'skipped', key: key_, reason: skipReason });
          continue;
        }

        const baselineMedian = median(base.blocks!);
        const candidateMedian = median(run.blocks!);
        const deltaP50 = baselineMedian > 0 ? (candidateMedian - baselineMedian) / baselineMedian : 0;
        const deltaP99 = base.p99 > 0 ? (run.p99 - base.p99) / base.p99 : 0;
        // Verdicts test block medians: samples within a process are correlated,
        // so pooled samples would shrink p arbitrarily without independent
        // replication. Pooled data remains for the display columns only.
        const time = classify(base.blocks!, run.blocks!, opts);

        // A common-mode clock difference between runs shifts every block
        // together, which the block test cannot see. Judging the same data in
        // cycles (median × its block's clock) covers the opposite assumption:
        // the verdict must hold whether the bench is clock-bound or not.
        const clockGate = clockConfounded(base, run, time.verdict, opts);
        if (clockGate !== undefined) {
          benches.push({ kind: 'skipped', key: key_, reason: clockGate });
          continue;
        }

        benches.push({
          kind: 'eligible',
          key: key_,
          baselineP50: baselineMedian,
          candidateP50: candidateMedian,
          baselineSamples: base.samples,
          candidateSamples: run.samples,
          deltaP50,
          deltaP99,
          p: time.p,
          d: time.d,
          verdict: time.verdict,
          hl: time.hl,
          ciLow: time.ciLow,
          ciHigh: time.ciHigh,
          resolution: Math.max(benchResolution(base.blocks!), benchResolution(run.blocks!)),
        });
      }
    }
  }

  return {
    baselineName: baseline.name,
    candidateName: candidate.name,
    ...(baseline.git ? { baselineGit: baseline.git } : {}),
    ...(candidate.git ? { candidateGit: candidate.git } : {}),
    hardware: baseline.hardware,
    environmentFailures,
    environmentWarnings,
    benches,
  };
}

// ─── Report formatting ───────────────────────────────────────────────────────

function deltaColor(delta: number, significant: boolean): string {
  if (!significant) return DIM;
  return delta < 0 ? GREEN : delta > 0 ? RED : DIM;
}

function verdictStyle(verdict: Verdict): { color: string; symbol: string } {
  if (verdict === 'faster') return { color: GREEN, symbol: '▲' };
  if (verdict === 'slower') return { color: RED, symbol: '▼' };
  return { color: GRAY, symbol: '■' };
}

// ─── Report ──────────────────────────────────────────────────────────────────

export function printCompareReport(result: CompareResult, config: LabsConfig): void {
  const side = (name: string, git?: GitInfo) => (git ? `${name} (${gitHint(git)})` : name);
  console.log(
    `\n${BOLD}${CYAN}━━ compare${RESET} ${DIM}${side(result.baselineName, result.baselineGit)} -> ${side(result.candidateName, result.candidateGit)}${RESET}`
  );
  console.log(`${DIM}${result.hardware.cpu ?? 'unknown CPU'}${RESET}`);
  console.log(
    `${DIM}Mann-Whitney U on block medians  α=${config.alpha}  minΔ=${(config.minDelta * 100).toFixed(0)}%${RESET}\n`
  );

  if (result.environmentWarnings.length > 0) {
    for (const reason of result.environmentWarnings) {
      console.log(`${YELLOW}⚠ ${reason}${RESET}`);
    }
    console.log('');
  }

  if (result.environmentFailures.length > 0) {
    console.log(`${RED}✖ cannot compare — environment check failed${RESET}`);
    for (const reason of result.environmentFailures) {
      console.log(`  ${DIM}· ${reason}${RESET}`);
    }
    console.log('');
    return;
  }

  const eligible = result.benches.filter((b): b is EligibleBench => b.kind === 'eligible');
  const skipped = result.benches.filter((b): b is SkippedBench => b.kind === 'skipped');
  const baselineOnly = result.benches.filter(
    (b): b is MissingBench => b.kind === 'missing' && b.presentIn === 'baseline'
  );
  const candidateOnly = result.benches.filter(
    (b): b is MissingBench => b.kind === 'missing' && b.presentIn === 'candidate'
  );

  if (eligible.length === 0 && skipped.length === 0 && candidateOnly.length === 0) {
    console.log(`${DIM}No benchmarks to compare${RESET}`);
    return;
  }

  // ── Column widths ────────────────────────────────────────────────────────

  const NAME_MAX = 36;
  const nameCol =
    eligible.length > 0
      ? Math.min(
          NAME_MAX,
          Math.max(16, ...eligible.map((b) => (b.key.name || b.key.group || 'anonymous').length))
        )
      : 16;

  const TIME_COL = 10;
  const DELTA_COL = 7;
  const P_COL = 5;
  const CI_COL = 14;

  const truncate = (s: string) =>
    s.length > nameCol ? s.slice(0, nameCol - 1) + '…' : s.padEnd(nameCol);

  const pct = (v: number) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}`;
  const formatCI = (low: number, high: number) => `${pct(low)}..${pct(high)}%`;

  // ── Eligible bench table ─────────────────────────────────────────────────

  if (eligible.length > 0) {
    const totalWidth =
      4 +
      nameCol +
      1 +
      TIME_COL +
      1 +
      TIME_COL +
      1 +
      DELTA_COL +
      1 +
      DELTA_COL +
      1 +
      P_COL +
      1 +
      CI_COL;
    const header =
      `${GRAY}${'  ' + 'bench'.padEnd(nameCol + 2)}` +
      ` ${'baseline'.padStart(TIME_COL)}` +
      ` ${'candidate'.padStart(TIME_COL)}` +
      ` ${'Δp50'.padStart(DELTA_COL)}` +
      ` ${'Δp99'.padStart(DELTA_COL)}` +
      ` ${'p'.padStart(P_COL)}` +
      ` ${`Δ ${(100 * (1 - config.alpha)).toFixed(0)}% CI`.padStart(CI_COL)}` +
      `${RESET}`;
    const divider = `${GRAY}${'-'.repeat(totalWidth)}${RESET}`;

    let lastFile = '';
    let lastGroup = '';
    let sawNoisy = false;

    for (const bench of eligible) {
      if (bench.key.file !== lastFile) {
        if (lastFile) console.log('');
        lastFile = bench.key.file;
        lastGroup = '';
        console.log(`${BOLD}${CYAN}${bench.key.file}${RESET}`);
        console.log(header);
        console.log(divider);
      }
      if (bench.key.group !== lastGroup) {
        lastGroup = bench.key.group;
        if (lastGroup && lastGroup !== bench.key.name) {
          console.log(`  • ${lastGroup}`);
          console.log(`  ${DARK_GRAY}${'-'.repeat(totalWidth - 2)}${RESET}`);
        }
      }

      const sig = bench.p <= config.alpha;
      const { color, symbol } = verdictStyle(bench.verdict);
      const rawName = bench.key.name || bench.key.group || 'anonymous';
      const name = truncate(rawName);
      const neutral = bench.verdict === 'neutral';
      const dp50Color = neutral ? DIM : bench.verdict === 'faster' ? GREEN : RED;
      const dp99Color = neutral ? DIM : deltaColor(bench.deltaP99, sig);
      const pColor = neutral ? DIM : WHITE;
      const noisy = bench.resolution > config.minDelta;
      if (noisy) sawNoisy = true;
      const noisyMark = noisy ? `  ${YELLOW}⚠ ~±${(bench.resolution * 100).toFixed(0)}%${RESET}` : '';

      console.log(
        `  ${color}${symbol}${RESET} ${WHITE}${name}${RESET}` +
          ` ${GRAY}${formatTime(bench.baselineP50).padStart(TIME_COL)}${RESET}` +
          ` ${GRAY}${formatTime(bench.candidateP50).padStart(TIME_COL)}${RESET}` +
          ` ${dp50Color}${formatDelta(bench.deltaP50).padStart(DELTA_COL)}${RESET}` +
          ` ${dp99Color}${formatDelta(bench.deltaP99).padStart(DELTA_COL)}${RESET}` +
          ` ${pColor}${formatP(bench.p).padStart(P_COL)}${RESET}` +
          ` ${neutral ? DIM : WHITE}${formatCI(bench.ciLow, bench.ciHigh).padStart(CI_COL)}${RESET}` +
          noisyMark
      );

      const dist = renderDistributions(bench.baselineSamples, bench.candidateSamples, TIME_COL);
      console.log(`${' '.repeat(4 + nameCol)} ${dist.baseline} ${dist.candidate}`);
      console.log('');
    }

    if (sawNoisy) {
      console.log(
        `${YELLOW}⚠${RESET} ${DIM}between-block spread limits these benches to the shown ` +
          `resolution (above minΔ=${(config.minDelta * 100).toFixed(0)}%); a neutral there ` +
          `means "could not tell", not "no change"${RESET}`
      );
      console.log('');
    }
  }

  // ── Skipped benches ──────────────────────────────────────────────────────

  if (skipped.length > 0) {
    console.log(`\n${YELLOW}skipped (${skipped.length})${RESET}`);
    for (const b of skipped) {
      const label = truncate(b.key.name || b.key.group || 'anonymous');
      console.log(`  ${DIM}· ${label}${RESET}  ${YELLOW}${b.reason}${RESET}`);
    }
  }

  // ── Missing benches ──────────────────────────────────────────────────────

  if (candidateOnly.length > 0) {
    console.log(`\n${DIM}new in candidate (not in baseline)${RESET}`);
    for (const b of candidateOnly) {
      const label =
        b.key.group && b.key.group !== b.key.name
          ? `${b.key.group} > ${b.key.name || 'anonymous'}`
          : b.key.name || 'anonymous';
      console.log(`  ${DIM}· ${label}${RESET}`);
    }
  }

  if (baselineOnly.length > 0) {
    console.log(`\n${DIM}removed from candidate (only in baseline)${RESET}`);
    for (const b of baselineOnly) {
      const label =
        b.key.group && b.key.group !== b.key.name
          ? `${b.key.group} > ${b.key.name || 'anonymous'}`
          : b.key.name || 'anonymous';
      console.log(`  ${DIM}· ${label}${RESET}`);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────

  const faster = eligible.filter((b) => b.verdict === 'faster').length;
  const slower = eligible.filter((b) => b.verdict === 'slower').length;
  const neutral = eligible.length - faster - slower;

  const parts: string[] = [];
  if (faster > 0) parts.push(`${GREEN}${faster} faster${RESET}`);
  if (slower > 0) parts.push(`${RED}${slower} slower${RESET}`);
  if (neutral > 0) parts.push(`${DIM}${neutral} neutral${RESET}`);
  if (skipped.length > 0) parts.push(`${YELLOW}${skipped.length} skipped${RESET}`);

  console.log(`\n${BOLD}summary${RESET}  ${parts.join('  ')}`);
  console.log(`${DIM}compared: ${eligible.length}  matched: ${result.benches.length}${RESET}`);
  console.log('');
}
