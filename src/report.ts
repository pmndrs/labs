import type { LabsConfig } from './config.ts';
import { renderMitata, type RenderedCollection } from './bench/render.ts';
import { hasUnstableSamples, type Context, type Stats, type Trial } from './bench/types.ts';
import {
  calibrationExplainedFraction,
  comparisonResolution,
  median,
  minDetectableEffect,
  runMedianSpread,
} from './stats.ts';
import type { SavedBenchmarkTrial, SavedFile, SavedResult, FreqSample } from './store.ts';
import { BLUE, BOLD, DIM, GREEN, RESET, YELLOW } from './utils/ansi.ts';
import { visibleLength } from './utils/format.ts';

export interface StabilityAffectedBenchmark {
  name: string;
  /** This benchmark's fresh-run median spread, shown inline when available. */
  runMedianSpread?: number;
}

export interface RunConsistencyInfo {
  freshRuns: number;
  /** Per-benchmark relative spread of fresh-run medians. */
  medianSpreads: number[];
  /** Configured verdict threshold used to identify inconsistent runs. */
  minDelta: number;
  /** Per-benchmark fraction of fresh-run spread explained by calibration-rate differences. */
  calibrationExplainedFractions?: number[];
}

export function printReportBox(
  envData: FreqSample[],
  affectedBenchmarks: StabilityAffectedBenchmark[],
  maxCpuTime: number,
  saveMsg?: string,
  cpu?: string | null,
  runConsistency?: RunConsistencyInfo
): void {
  const lines: string[] = [];

  if (saveMsg) {
    lines.push(saveMsg);
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
  }

  if (envData.length > 0) lines.push('');

  let hasRunConsistencySummary = false;
  if (runConsistency && runConsistency.freshRuns > 1 && runConsistency.medianSpreads.length > 0) {
    hasRunConsistencySummary = true;
    const spread = median(runConsistency.medianSpreads);
    const resolution = minDetectableEffect(spread, runConsistency.freshRuns);
    const spreadStr = `±${(spread * 100).toFixed(1)}%`;
    // Use the same resolution rule as individual benchmark classification
    const runsInconsistent = resolution > runConsistency.minDelta;
    lines.push(
      runsInconsistent
        ? `${YELLOW}⚠ Inconsistent runs:${RESET} ${DIM}Median timings changed across fresh runs suggesting an unstable machine.${RESET}`
        : `${GREEN}✔ Consistent runs:${RESET} ${DIM}Median timings remained stable across fresh runs.${RESET}`
    );
    lines.push(
      `  ${DIM}Median spread: ${spreadStr} across ${runConsistency.freshRuns} fresh runs.${RESET}`
    );
    lines.push(`  ${DIM}Comparison resolution: ~±${(resolution * 100).toFixed(1)}%.${RESET}`);
    if (
      runConsistency.calibrationExplainedFractions &&
      runConsistency.calibrationExplainedFractions.length > 0
    ) {
      const explained = median(runConsistency.calibrationExplainedFractions);
      lines.push(
        `  ${DIM}Clock estimate explains ~${(explained * 100).toFixed(0)}% of run-to-run spread.${RESET}`
      );
    }
  }

  if (affectedBenchmarks.length > 0) {
    if (!hasRunConsistencySummary) {
      lines.push(
        `${YELLOW}⚠ Unstable samples:${RESET} ${DIM}Timings did not settle suggesting non-deterministic work or runtime interference.${RESET}`
      );
      lines.push(`  ${DIM}Time limit: ${maxCpuTime}s.${RESET}`);
    }
    lines.push(`  ${DIM}Affected benchmarks (${affectedBenchmarks.length}):${RESET}`);
    for (const benchmark of affectedBenchmarks) {
      const spread =
        benchmark.runMedianSpread !== undefined
          ? `  ${YELLOW}±${(benchmark.runMedianSpread * 100).toFixed(1)}%${RESET}`
          : '';
      lines.push(`    ${YELLOW}⚠${RESET} ${DIM}${benchmark.name}${RESET}${spread}`);
    }
  } else if (!hasRunConsistencySummary) {
    lines.push(
      `${GREEN}✔ Stable samples:${RESET} ${DIM}Timings settled within the ${maxCpuTime}s time limit.${RESET}`
    );
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

  const affectedBenchmarks: StabilityAffectedBenchmark[] = [];
  const runMedianSpreads: number[] = [];
  const calibrationExplainedFractions: number[] = [];
  for (const f of result.files) {
    for (const b of f.benchmarks) {
      for (const run of b.runs) {
        // Fresh runs use comparison resolution; single runs use adaptive
        // sample stability. These are separate signals with separate causes.
        const runsInconsistent = run.stats?.blocks
          ? comparisonResolution(run.stats.blocks.medians) > config.minDelta
          : false;
        const samplesUnstable = !run.stats?.blocks && hasUnstableSamples(run.stats);
        if (runsInconsistent || samplesUnstable) {
          affectedBenchmarks.push({
            name: run.name || b.alias,
            ...(run.stats?.blocks
              ? { runMedianSpread: runMedianSpread(run.stats.blocks.medians) }
              : {}),
          });
        }
        if (run.stats?.blocks) {
          runMedianSpreads.push(runMedianSpread(run.stats.blocks.medians));
          calibrationExplainedFractions.push(
            calibrationExplainedFraction(run.stats.blocks.medians, run.stats.blocks.freqs)
          );
        }
      }
    }
  }
  const freshRuns = result.blocks ?? 1;
  printReportBox(
    result.environment?.freqs ?? [],
    affectedBenchmarks,
    config.maxCpuTime!,
    undefined,
    result.hardware.cpu,
    freshRuns > 1
      ? {
          freshRuns,
          medianSpreads: runMedianSpreads,
          minDelta: config.minDelta,
          calibrationExplainedFractions,
        }
      : undefined
  );
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
