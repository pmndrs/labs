import type { LabsConfig } from './config.ts';
import { renderDistributions } from './histogram.ts';
import { type ClassifyOptions, type Verdict, classify, median } from './stats.ts';
import { type FreqSample, type SavedResult, isEnvironmentStable } from './store.ts';
import { BOLD, CYAN, DARK_GRAY, DIM, GRAY, GREEN, RED, RESET, WHITE, YELLOW } from './utils/ansi.ts';
import { formatDelta, formatP, formatTime } from './utils/format.ts';

// ─── Check infrastructure ────────────────────────────────────────────────────

type CheckResult = { ok: true } | { ok: false; reason: string };

type EnvironmentCheck = (baseline: SavedResult, candidate: SavedResult) => CheckResult;

interface BenchData {
  samples: number[];
  noisy: boolean;
}

type BenchCheck = (baseline: BenchData, candidate: BenchData) => CheckResult;

// ─── Environment checks ──────────────────────────────────────────────────────

/** Max relative difference between the two runs' median clock speeds to consider them comparable. */
const CLOCK_COMPARE_THRESHOLD = 0.05;

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

export const ENVIRONMENT_WARNINGS: EnvironmentWarning[] = [warnClockDrift];

/** All environment checks in order. Any failure blocks the entire comparison. */
export const ENVIRONMENT_CHECKS: EnvironmentCheck[] = [checkHardwareMatch];

// ─── Per-bench checks ────────────────────────────────────────────────────────

export const checkNotNoisy: BenchCheck = (baseline, candidate) => {
  if (baseline.noisy && candidate.noisy)
    return { ok: false, reason: 'noisy — insufficient or unconverged samples in both runs' };
  if (baseline.noisy)
    return { ok: false, reason: 'noisy — baseline did not collect enough stable samples' };
  if (candidate.noisy)
    return { ok: false, reason: 'noisy — candidate did not collect enough stable samples' };
  return { ok: true };
};

/** MW-U normal approximation is unreliable below this threshold. */
const MW_U_MIN_SAMPLES = 14;

export const checkMinSamples: BenchCheck = (baseline, candidate) => {
  const bN = baseline.samples.length;
  const cN = candidate.samples.length;
  if (bN < MW_U_MIN_SAMPLES && cN < MW_U_MIN_SAMPLES)
    return {
      ok: false,
      reason: `too few samples for MW-U (baseline: ${bN}, candidate: ${cN}; need ≥${MW_U_MIN_SAMPLES})`,
    };
  if (bN < MW_U_MIN_SAMPLES)
    return {
      ok: false,
      reason: `baseline has too few samples for MW-U (${bN}; need ≥${MW_U_MIN_SAMPLES})`,
    };
  if (cN < MW_U_MIN_SAMPLES)
    return {
      ok: false,
      reason: `candidate has too few samples for MW-U (${cN}; need ≥${MW_U_MIN_SAMPLES})`,
    };
  return { ok: true };
};

/** All per-bench checks in order. Any failure skips that bench with a reason. */
export const BENCH_CHECKS: BenchCheck[] = [checkNotNoisy, checkMinSamples];

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
  effectiveMinDelta: number;
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
  hardware: SavedResult['hardware'];
  environmentFailures: string[];
  environmentWarnings: string[];
  benches: BenchResult[];
}

// ─── Legacy trial helpers ────────────────────────────────────────────────────

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
  noisy: boolean;
}> {
  const alias = (trial as any).alias ?? 'anonymous';
  const runs = (trial as any).runs as Array<any> | undefined;
  if (Array.isArray(runs) && runs.length > 0) {
    return runs.map((run) => {
      const stats = run?.stats;
      return {
        name: run?.name ?? alias,
        samples: Array.isArray(stats?.samples) ? stats.samples : [],
        p99: typeof stats?.p99 === 'number' ? stats.p99 : 0,
        noisy: !!stats?.noisy,
      };
    });
  }

  const stats = (trial as any).stats;
  return [
    {
      name: alias,
      samples: Array.isArray(stats?.samples) ? stats.samples : [],
      p99: typeof stats?.p99 === 'number' ? stats.p99 : 0,
      noisy: !!stats?.noisy,
    },
  ];
}

// ─── Index helpers ───────────────────────────────────────────────────────────

interface IndexEntry {
  median: number;
  p99: number;
  samples: number[];
  noisy: boolean;
}

function buildIndex(result: SavedResult): Map<string, IndexEntry> {
  const map = new Map<string, IndexEntry>();
  for (const f of result.files) {
    for (const trial of f.benchmarks) {
      for (const run of trialRuns(trial)) {
        const key = `${f.file}\0${trial.groupName ?? ''}\0${run.name}`;
        map.set(key, {
          median: run.samples.length > 0 ? median(run.samples) : 0,
          p99: run.p99,
          samples: run.samples,
          noisy: run.noisy,
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

// ─── Core comparison ─────────────────────────────────────────────────────────

export function compare(
  baseline: SavedResult,
  candidate: SavedResult,
  config: LabsConfig
): CompareResult {
  const opts: ClassifyOptions = {
    alpha: config.alpha,
    minDelta: config.minDelta,
    minEffect: config.minEffect,
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
          baseline: { samples: base.samples, noisy: base.noisy },
          candidate: { samples: run.samples, noisy: run.noisy },
        };

        let skipReason: string | undefined;
        for (const check of BENCH_CHECKS) {
          const result = check(benchData.baseline, benchData.candidate);
          if (!result.ok) {
            skipReason = result.reason;
            break;
          }
        }

        if (skipReason !== undefined) {
          benches.push({ kind: 'skipped', key: key_, reason: skipReason });
          continue;
        }

        const candidateMedian = median(run.samples);
        const deltaP50 = base.median > 0 ? (candidateMedian - base.median) / base.median : 0;
        const deltaP99 = base.p99 > 0 ? (run.p99 - base.p99) / base.p99 : 0;
        const { verdict, p, d, effectiveMinDelta } = classify(base.samples, run.samples, opts);

        benches.push({
          kind: 'eligible',
          key: key_,
          baselineP50: base.median,
          candidateP50: candidateMedian,
          baselineSamples: base.samples,
          candidateSamples: run.samples,
          deltaP50,
          deltaP99,
          p,
          d,
          verdict,
          effectiveMinDelta,
        });
      }
    }
  }

  return {
    baselineName: baseline.name,
    candidateName: candidate.name,
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
  console.log(
    `\n${BOLD}${CYAN}━━ compare${RESET} ${DIM}${result.baselineName} -> ${result.candidateName}${RESET}`
  );
  console.log(`${DIM}${result.hardware.cpu ?? 'unknown CPU'}${RESET}`);
  console.log(
    `${DIM}Mann-Whitney U  α=${config.alpha}  minΔ=${(config.minDelta * 100).toFixed(0)}%  cliff's d≥${config.minEffect}${RESET}\n`
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
  const THRESH_COL = 5;

  const truncate = (s: string) =>
    s.length > nameCol ? s.slice(0, nameCol - 1) + '…' : s.padEnd(nameCol);

  const formatThreshold = (v: number) => `±${(v * 100).toFixed(0)}%`;

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
      THRESH_COL;
    const header =
      `${GRAY}${'  ' + 'bench'.padEnd(nameCol + 2)}` +
      ` ${'baseline'.padStart(TIME_COL)}` +
      ` ${'candidate'.padStart(TIME_COL)}` +
      ` ${'Δp50'.padStart(DELTA_COL)}` +
      ` ${'Δp99'.padStart(DELTA_COL)}` +
      ` ${'p'.padStart(P_COL)}` +
      ` ${'±Δ'.padStart(THRESH_COL)}` +
      `${RESET}`;
    const divider = `${GRAY}${'-'.repeat(totalWidth)}${RESET}`;

    let lastFile = '';
    let lastGroup = '';

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

      console.log(
        `  ${color}${symbol}${RESET} ${WHITE}${name}${RESET}` +
          ` ${GRAY}${formatTime(bench.baselineP50).padStart(TIME_COL)}${RESET}` +
          ` ${GRAY}${formatTime(bench.candidateP50).padStart(TIME_COL)}${RESET}` +
          ` ${dp50Color}${formatDelta(bench.deltaP50).padStart(DELTA_COL)}${RESET}` +
          ` ${dp99Color}${formatDelta(bench.deltaP99).padStart(DELTA_COL)}${RESET}` +
          ` ${pColor}${formatP(bench.p).padStart(P_COL)}${RESET}` +
          ` ${DIM}${formatThreshold(bench.effectiveMinDelta).padStart(THRESH_COL)}${RESET}`
      );

      const dist = renderDistributions(bench.baselineSamples, bench.candidateSamples, TIME_COL);
      console.log(`${' '.repeat(4 + nameCol)} ${dist.baseline} ${dist.candidate}`);
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

export function renderCompareMarkdown(result: CompareResult, config: LabsConfig): string {
  return renderCompareMarkdownWithAssets(result, config);
}

export function renderCompareMarkdownWithAssets(
  result: CompareResult,
  config: LabsConfig,
  assets: { chartImages?: string[] } = {}
): string {
  const lines: string[] = [];
  lines.push(`# Comparison Report: ${result.baselineName} -> ${result.candidateName}`);
  lines.push('');
  lines.push('## Metadata');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('| --- | --- |');
  lines.push(`| CPU | ${result.hardware.cpu ?? 'unknown'} |`);
  lines.push(`| Test | Mann-Whitney U |`);
  lines.push(`| Alpha | ${config.alpha} |`);
  lines.push(`| Min Delta | ${(config.minDelta * 100).toFixed(0)}% |`);
  lines.push(`| Min Effect | ${config.minEffect} |`);
  lines.push('');

  lines.push(...renderCompareMarkdownSections(result, assets));

  return lines.join('\n').trimEnd() + '\n';
}

function renderCompareMarkdownSections(
  result: CompareResult,
  assets: { chartImages?: string[] }
): string[] {
  const lines: string[] = [];

  if (result.environmentWarnings.length > 0) {
    lines.push('## Environment Warnings');
    lines.push('');
    for (const reason of result.environmentWarnings) lines.push(`- ${reason}`);
    lines.push('');
  }

  if (result.environmentFailures.length > 0) {
    lines.push('## Environment Failure');
    lines.push('');
    lines.push(`Comparison blocked by environment checks.`);
    lines.push('');
    for (const reason of result.environmentFailures) lines.push(`- ${reason}`);
    lines.push('');
    return lines;
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
    lines.push('## Results');
    lines.push('');
    lines.push(`No benchmarks to compare.`);
    lines.push('');
    return lines;
  }

  if (assets.chartImages && assets.chartImages.length > 0 && eligible.length > 0) {
    lines.push('## Chart');
    lines.push('');
    assets.chartImages.forEach((chartImage, index) => {
      lines.push(`### Batch ${index + 1}`);
      lines.push('');
      lines.push(`![p50 dumbbell chart batch ${index + 1}](${chartImage})`);
      lines.push('');
    });
    lines.push('');
  }

  lines.push('## Results');
  lines.push('');
  lines.push('| File | Bench | Baseline | Candidate | Δp50 | Δp99 | p | ±Δ | Verdict |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |');

  const NAME_MAX = 36;
  const nameCol =
    eligible.length > 0
      ? Math.min(
          NAME_MAX,
          Math.max(16, ...eligible.map((b) => (b.key.name || b.key.group || 'anonymous').length))
        )
      : 16;
  const TIME_COL = 10;
  const truncate = (s: string) =>
    s.length > nameCol ? s.slice(0, nameCol - 1) + '…' : s.padEnd(nameCol);
  const formatThreshold = (v: number) => `±${(v * 100).toFixed(0)}%`;
  const sparkBlocks: string[] = [];

  if (eligible.length > 0) {
    for (const bench of eligible) {
      const { symbol } = verdictStyle(bench.verdict);
      const label = formatBenchLabel(bench.key.group, bench.key.name);
      lines.push(
        `| ${bench.key.file} | ${label} | ${formatTime(bench.baselineP50)} | ${formatTime(bench.candidateP50)} | ${formatDelta(bench.deltaP50)} | ${formatDelta(bench.deltaP99)} | ${formatP(bench.p)} | ${formatThreshold(bench.effectiveMinDelta)} | ${symbol} ${bench.verdict} |`
      );

      const dist = renderDistributions(bench.baselineSamples, bench.candidateSamples, TIME_COL);
      sparkBlocks.push(`${bench.key.file} :: ${label}`);
      sparkBlocks.push(
        `${truncate(bench.key.name || bench.key.group || 'anonymous')} ${stripAnsi(dist.baseline)} ${stripAnsi(dist.candidate)}`
      );
      sparkBlocks.push('');
    }
    lines.push('');
    lines.push('### Distributions');
    lines.push('');
    lines.push('```text');
    lines.push(...sparkBlocks);
    lines.push('```');
    lines.push('');
  }

  if (skipped.length > 0) {
    lines.push('## Skipped');
    lines.push('');
    for (const b of skipped)
      lines.push(`- ${formatBenchLabel(b.key.group, b.key.name)}: ${b.reason}`);
    lines.push('');
  }

  if (candidateOnly.length > 0) {
    lines.push('## New In Candidate');
    lines.push('');
    for (const b of candidateOnly) lines.push(`- ${formatBenchLabel(b.key.group, b.key.name)}`);
    lines.push('');
  }

  if (baselineOnly.length > 0) {
    lines.push('## Removed From Candidate');
    lines.push('');
    for (const b of baselineOnly) lines.push(`- ${formatBenchLabel(b.key.group, b.key.name)}`);
    lines.push('');
  }

  const faster = eligible.filter((b) => b.verdict === 'faster').length;
  const slower = eligible.filter((b) => b.verdict === 'slower').length;
  const neutral = eligible.length - faster - slower;
  const parts: string[] = [];
  if (faster > 0) parts.push(`${faster} faster`);
  if (slower > 0) parts.push(`${slower} slower`);
  if (neutral > 0) parts.push(`${neutral} neutral`);
  if (skipped.length > 0) parts.push(`${skipped.length} skipped`);
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Verdicts: ${parts.join(', ') || 'none'}`);
  lines.push(`- Compared: ${eligible.length}`);
  lines.push(`- Matched: ${result.benches.length}`);
  lines.push('');
  return lines;
}

function formatBenchLabel(group: string, name: string): string {
  return group && group !== name ? `${group} > ${name || 'anonymous'}` : name || 'anonymous';
}

function stripAnsi(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
}

export function eligibleBenches(result: CompareResult): EligibleBench[] {
  return result.benches.filter((b): b is EligibleBench => b.kind === 'eligible');
}
