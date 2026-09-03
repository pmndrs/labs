import type { LabsConfig } from './config.ts';
import { renderMitata, type RenderedCollection } from './bench/render.ts';
import { isAssertionError, type Context, type Stats, type Trial } from './bench/types.ts';
import {
  calibrationExplainedFraction,
  comparisonResolution,
  median,
  minDetectableEffect,
  relativeSpread,
} from './stats.ts';
import type { SavedBenchmarkTrial, SavedFile, SavedResult, FreqSample } from './store.ts';
import { BLUE, BOLD, DIM, GREEN, RED, RESET, YELLOW } from './utils/ansi.ts';
import { visibleLength } from './utils/format.ts';

export interface ReportBench {
  name: string;
  /** Relative spread shown next to the name. */
  spread: number;
}

/** Per-bench signals gathered from a run's block summaries. */
export interface BenchDiagnostics {
  failedChecks: string[];
  /** Between-block spread of medians, one per bench. */
  medianSpreads: number[];
  /** Fraction of between-block spread explained by calibration-rate differences, one per bench. */
  calibrationExplainedFractions: number[];
  /** Benches whose between-block resolution is coarser than minDelta. */
  inconsistent: ReportBench[];
  /** Benches whose samples vary widely inside a single process. */
  noisy: ReportBench[];
}

export function emptyDiagnostics(): BenchDiagnostics {
  return {
    failedChecks: [],
    medianSpreads: [],
    calibrationExplainedFractions: [],
    inconsistent: [],
    noisy: [],
  };
}

type DiagnosableTrial = {
  alias: string;
  groupName?: string;
  runs: Array<{ name: string; error?: unknown; stats?: Pick<Stats, 'blocks'> }>;
};

/** `group › bench`, trimming the group first so the bench name stays readable. */
function benchLabel(groupName: string | undefined, name: string): string {
  if (!groupName) return name;
  const room = Math.max(8, 36 - name.length - 3);
  const group = groupName.length > room ? groupName.slice(0, room - 1) + '…' : groupName;
  return `${group} › ${name}`;
}

/**
 * Folds one file's trials into `into`. Between-block spread decides whether a
 * comparison could resolve minDelta. Within-block spread is a separate signal:
 * a bench whose own samples disagree is nondeterministic or being interfered
 * with, whichever way its blocks line up.
 */
export function collectDiagnostics(
  trials: DiagnosableTrial[],
  minDelta: number,
  into: BenchDiagnostics = emptyDiagnostics()
): BenchDiagnostics {
  for (const trial of trials) {
    for (const run of trial.runs) {
      const name = benchLabel(trial.groupName, run.name || trial.alias);
      if (isAssertionError(run.error)) into.failedChecks.push(name);
      const blocks = run.stats?.blocks;
      if (!blocks) continue;

      const spread = relativeSpread(blocks.medians);
      into.medianSpreads.push(spread);
      into.calibrationExplainedFractions.push(
        calibrationExplainedFraction(blocks.medians, blocks.freqs)
      );
      if (comparisonResolution(blocks.medians) > minDelta) into.inconsistent.push({ name, spread });

      // A robust spread this wide inside one process means the timed work
      // itself is not settling, not that processes differ.
      const within = median(blocks.spreads ?? []);
      if (within > 0.1) into.noisy.push({ name, spread: within });
    }
  }
  return into;
}

export interface ReportInput {
  envData: FreqSample[];
  cpu?: string | null;
  saveMsg?: string;
  blocks: number;
  minDelta: number;
  diagnostics: BenchDiagnostics;
}

export function printReportBox(input: ReportInput): void {
  const { envData, cpu, saveMsg, blocks, minDelta, diagnostics } = input;
  const lines: string[] = [];

  if (saveMsg) {
    lines.push(saveMsg);
    lines.push('');
  }
  if (diagnostics.failedChecks.length > 0) {
    lines.push(
      `${RED}✖ Failed checks:${RESET} ${DIM}Assertions did not hold, so these benchmarks have no results.${RESET}`
    );
    lines.push(`  ${DIM}Affected benchmarks (${diagnostics.failedChecks.length}):${RESET}`);
    for (const name of diagnostics.failedChecks)
      lines.push(`    ${RED}✖${RESET} ${DIM}${name}${RESET}`);
    lines.push('');
  }
  if (envData.length > 0) {
    const allFreqs = envData.flatMap((e) => [e.runFreq, e.postFreq]);
    const min = Math.min(...allFreqs);
    const max = Math.max(...allFreqs);
    const drift = (max - min) / ((max + min) / 2);
    const rangeStr = `${min.toFixed(2)}–${max.toFixed(2)} GHz`;

    if (drift > 0.05) {
      lines.push(
        `${YELLOW}⚠ Unstable clock:${RESET} ${DIM}Readings ranged ${rangeStr} (${(drift * 100).toFixed(1)}% drift).${RESET}`
      );
      if (cpu && /apple/i.test(cpu)) {
        lines.push(`  ${DIM}Apple Silicon does not support CPU controls.${RESET}`);
        lines.push(`  ${DIM}Drift is expected and may not affect results.${RESET}`);
      } else {
        lines.push(
          `  ${DIM}Disable turbo and fix the CPU governor for a stable benchmark environment.${RESET}`
        );
      }
    } else {
      lines.push(`${GREEN}✔ Stable clock:${RESET} ${DIM}Readings ranged ${rangeStr}.${RESET}`);
    }
    lines.push('');
  }

  const affected = (benches: ReportBench[]) => {
    lines.push(`  ${DIM}Affected benchmarks (${benches.length}):${RESET}`);
    for (const bench of benches) {
      lines.push(
        `    ${YELLOW}⚠${RESET} ${DIM}${bench.name}${RESET}  ${YELLOW}±${(bench.spread * 100).toFixed(1)}%${RESET}`
      );
    }
  };

  if (diagnostics.medianSpreads.length > 0) {
    const spread = median(diagnostics.medianSpreads);
    const resolution = minDetectableEffect(spread, blocks);
    // Same resolution rule as per-bench classification
    if (resolution > minDelta) {
      lines.push(
        `${YELLOW}⚠ Inconsistent runs:${RESET} ${DIM}Median timings changed across fresh runs.${RESET}`
      );
      lines.push(`  ${DIM}Suggests an unstable machine.${RESET}`);
    } else {
      lines.push(
        `${GREEN}✔ Consistent runs:${RESET} ${DIM}Median timings remained stable across fresh runs.${RESET}`
      );
    }
    lines.push(
      `  ${DIM}Median spread: ±${(spread * 100).toFixed(1)}% across ${blocks} fresh runs.${RESET}`
    );
    lines.push(`  ${DIM}Comparison resolution: ~±${(resolution * 100).toFixed(1)}%.${RESET}`);
    const explained = median(diagnostics.calibrationExplainedFractions);
    lines.push(
      `  ${DIM}Clock estimate explains ~${(explained * 100).toFixed(0)}% of run-to-run spread.${RESET}`
    );
    if (diagnostics.inconsistent.length > 0) affected(diagnostics.inconsistent);
  }

  if (diagnostics.noisy.length > 0) {
    lines.push('');
    lines.push(
      `${YELLOW}⚠ Noisy samples:${RESET} ${DIM}Timings varied widely within a process.${RESET}`
    );
    lines.push(`  ${DIM}Suggests non-deterministic work or runtime interference.${RESET}`);
    affected(diagnostics.noisy);
  }

  const PAD = 2;
  const contentWidth = Math.max(40, ...lines.map((l) => visibleLength(l)));
  const innerWidth = contentWidth + PAD * 2;

  const top = `┌ ${BOLD}report${RESET} ${'─'.repeat(innerWidth - 8)}┐`;
  const bot = `└${'─'.repeat(innerWidth)}┘`;
  const blank = `│${' '.repeat(innerWidth)}│`;
  const pad = ' '.repeat(PAD);

  console.log(`\n${top}`);
  console.log(blank);
  for (const line of lines) {
    if (line === '') {
      console.log(blank);
    } else {
      const fill = innerWidth - PAD * 2 - visibleLength(line);
      console.log(`│${pad}${line}${' '.repeat(Math.max(0, fill))}${pad}│`);
    }
  }
  console.log(blank);
  console.log(bot);
  console.log('');
}

export function replayReport(result: SavedResult, config: LabsConfig): void {
  for (const file of result.files) {
    console.log(`\n${BLUE}▶ ${file.file}${RESET}`);
    renderMitata(
      replayContext(file, result),
      {
        print: console.log,
        colors: true,
        format: { name: 'longest' },
        countersAvailable: undefined,
      },
      replayCollections(file)
    );
  }

  const diagnostics = emptyDiagnostics();
  for (const file of result.files) collectDiagnostics(file.benchmarks, config.minDelta, diagnostics);
  printReportBox({
    envData: result.environment?.freqs ?? [],
    cpu: result.hardware.cpu,
    blocks: result.blocks ?? 1,
    minDelta: config.minDelta,
    diagnostics,
  });
}

function replayCollections(file: SavedFile): RenderedCollection[] {
  const collections = (file.layout ?? [{ name: null, types: [] }]).map((entry) => ({
    name: entry.name,
    types: entry.types,
    trials: [],
  })) as RenderedCollection[];

  for (const trial of file.benchmarks) {
    const group = trial.group ?? 0;
    const target =
      collections[group] ??
      (collections[group] = {
        name: trial.groupName ?? null,
        types: [],
        trials: [],
      });
    target.trials.push({
      highlight: trial.style.highlight,
      compact: trial.style.compact,
      gcMode: trial.gcMode,
      bench: replayTrial(trial),
    });
  }

  return collections.filter((collection) => collection && collection.trials.length > 0);
}

function replayTrial(trial: SavedBenchmarkTrial): Trial {
  return {
    alias: trial.alias,
    group: trial.group,
    gcMode: trial.gcMode,
    baseline: trial.baseline,
    args: {},
    kind: trial.kind,
    style: trial.style,
    runs: trial.runs.map((run) => ({
      name: run.name,
      args: run.args,
      stats: run.stats as Stats | undefined,
      error: run.error,
    })),
  };
}

function replayContext(file: SavedFile, result: SavedResult): Context {
  const context = file.context ?? {
    cpu: { freq: result.hardware.freq, name: result.hardware.cpu },
    arch: result.hardware.arch,
    runtime: result.hardware.runtime,
    version: result.context?.version,
    noop: result.context?.noop,
  };

  return {
    now: 0,
    arch: context.arch ?? '',
    runtime: context.runtime ?? '',
    version: context.version ?? null,
    cpu: {
      freq: context.cpu.freq,
      name: context.cpu.name,
    },
    noop: {
      fn: noopStats(context.noop?.fn?.avg ?? 0),
      iter: noopStats(context.noop?.iter?.avg ?? 0),
      fn_gc: noopStats(context.noop?.fn_gc?.avg ?? 0),
    },
  };
}

function noopStats(avg: number): Stats {
  return { avg } as Stats;
}
