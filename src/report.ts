import type { LabsConfig } from './config.ts';
import { renderMitata, type RenderedCollection } from './bench/render.ts';
import type { Context, Stats, Trial } from './bench/types.ts';
import type { SavedBenchmarkTrial, SavedFile, SavedResult, FreqSample } from './store.ts';
import { BLUE, BOLD, DIM, GREEN, RESET, YELLOW } from './utils/ansi.ts';
import { formatTime } from './utils/format.ts';
import { visibleLength } from './utils/format.ts';

export function printReportBox(
  envData: FreqSample[],
  noisyAliases: string[],
  maxCpuTime: number,
  saveMsg?: string,
  cpu?: string | null
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
        `${YELLOW}⚠ CPU unstable${RESET}  ${rangeStr}  ${DIM}(${(drift * 100).toFixed(1)}% drift)${RESET}`
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
      lines.push(`${GREEN}✔ CPU stable${RESET}  ${DIM}${rangeStr}${RESET}`);
    }
  }

  if (envData.length > 0) lines.push('');

  if (noisyAliases.length > 0) {
    lines.push(`${YELLOW}⚠ (${noisyAliases.length}) noisy benches${RESET}`);
    for (const alias of noisyAliases) lines.push(`  ${DIM}· ${alias}${RESET}`);
    lines.push(
      `  ${DIM}Increase maxCpuTime (currently ${maxCpuTime}s) to allow convergence.${RESET}`
    );
  } else {
    lines.push(`${GREEN}✔ All measurements stable${RESET}`);
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
    console.log(`\n${BLUE}▶ ${file.file}${RESET} ${DIM}(tsx + v8 flags)${RESET}`);
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

  const noisyAliases: string[] = [];
  for (const f of result.files) {
    for (const b of f.benchmarks) {
      for (const run of b.runs) {
        if (run.stats?.noisy) noisyAliases.push(run.name || b.alias);
      }
    }
  }
  printReportBox(
    result.environment?.freqs ?? [],
    noisyAliases,
    config.maxCpuTime!,
    undefined,
    result.hardware.cpu
  );
}

export function renderSavedResultMarkdown(result: SavedResult, config: LabsConfig): string {
  const lines: string[] = [];
  lines.push(`# Bench Report: ${result.name}`);
  lines.push('');

  if (result.description) {
    lines.push(result.description);
    lines.push('');
  }

  lines.push('## Metadata');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Timestamp | ${result.timestamp} |`);
  lines.push(`| CPU | ${result.hardware.cpu ?? 'unknown'} |`);
  lines.push(`| Arch | ${result.hardware.arch ?? 'unknown'} |`);
  lines.push(`| Runtime | ${result.hardware.runtime ?? 'unknown'} |`);
  lines.push(`| Median CPU Clock | ${result.hardware.freq > 0 ? `${result.hardware.freq.toFixed(2)} GHz` : 'unknown'} |`);
  lines.push('');
  lines.push(...renderEnvironmentMarkdown(result, config));

  for (const file of result.files) {
    lines.push(`## ${file.file}`);
    lines.push('');
    lines.push(...renderSavedFileMarkdown(file));
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
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

function collectNoisyAliases(result: SavedResult): string[] {
  const noisyAliases: string[] = [];
  for (const f of result.files) {
    for (const b of f.benchmarks) {
      for (const run of b.runs) {
        if (run.stats?.noisy) noisyAliases.push(run.name || b.alias);
      }
    }
  }
  return noisyAliases;
}

function renderSavedFileMarkdown(file: SavedFile): string[] {
  const lines: string[] = [];

  for (const trial of file.benchmarks) {
    const benchLabel = formatBenchLabel(trial);
    const isMultiRun = trial.runs.length > 1;

    for (const run of trial.runs) {
      if (isMultiRun) {
        if (!lines.at(-1)?.startsWith('### ')) {
          lines.push(`### ${benchLabel}`);
          lines.push('');
        }
        lines.push(`#### ${run.name || trial.alias}`);
        lines.push('');
      } else {
        lines.push(`### ${benchLabel}`);
        lines.push('');
      }

      lines.push('| Avg | Min | Max | p75 | p99 | Samples | Status |');
      lines.push('| ---: | ---: | ---: | ---: | ---: | ---: | --- |');

      if (!run.stats) {
        lines.push(`| - | - | - | - | - | 0 | error |`);
        lines.push('');
        continue;
      }

      lines.push(
        `| ${formatTime(run.stats.avg)} | ${formatTime(run.stats.min)} | ${formatTime(run.stats.max)} | ${formatTime(run.stats.p75)} | ${formatTime(run.stats.p99)} | ${run.stats.samples.length} | ${formatRunStatus(run)} |`
      );
      lines.push('');
    }
  }

  return lines;
}

function formatBenchLabel(trial: SavedBenchmarkTrial): string {
  return trial.groupName && trial.groupName !== trial.alias
    ? `${trial.groupName} > ${trial.alias}`
    : trial.alias;
}

function formatRunStatus(run: SavedBenchmarkTrial['runs'][number]): string {
  if (run.error) return 'error';
  if (run.stats?.noisy) return 'noisy';
  return 'stable';
}

function renderEnvironmentMarkdown(result: SavedResult, config: LabsConfig): string[] {
  const envData = result.environment?.freqs ?? [];
  const noisyAliases = collectNoisyAliases(result);
  const maxCpuTime = config.maxCpuTime!;
  const cpu = result.hardware.cpu;
  const lines: string[] = [];
  lines.push('## Environment');
  lines.push('');

  if (envData.length > 0) {
    const allFreqs = envData.flatMap((e) => [e.runFreq, e.postFreq]);
    const min = Math.min(...allFreqs);
    const max = Math.max(...allFreqs);
    const drift = (max - min) / ((max + min) / 2);
    lines.push('| Metric | Value |');
    lines.push('| --- | --- |');
    lines.push(`| CPU stability | ${drift > 0.05 ? 'unstable' : 'stable'} |`);
    lines.push(`| CPU clock range | ${min.toFixed(2)}-${max.toFixed(2)} GHz |`);
    lines.push(`| CPU clock drift | ${(drift * 100).toFixed(1)}% |`);
    lines.push('');

    if (drift > 0.05) {
      lines.push('**Notes**');
      lines.push('');
      if (cpu && /apple/i.test(cpu)) {
        lines.push(`- Apple Silicon does not support CPU controls.`);
        lines.push(`- Drift is expected and may not affect results.`);
      } else {
        lines.push(`- Disable turbo and fix the CPU governor for a stable benchmark environment.`);
      }
      lines.push('');
    } else {
      lines.push('**Notes**');
      lines.push('');
      lines.push(`- CPU clock remained stable throughout the run.`);
      lines.push('');
    }
  } else {
    lines.push('| Metric | Value |');
    lines.push('| --- | --- |');
    lines.push(`| CPU stability | unknown |`);
    lines.push('');
  }

  lines.push('**Noisy Benches**');
  lines.push('');
  if (noisyAliases.length > 0) {
    for (const alias of noisyAliases) lines.push(`- ${alias}`);
    lines.push('');
    lines.push(`Increase \`maxCpuTime\` beyond ${maxCpuTime}s to allow convergence.`);
  } else {
    lines.push(`- None`);
  }

  lines.push('');
  return lines;
}
