import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  compare,
  eligibleBenches,
  printCompareReport,
  renderCompareMarkdownWithAssets,
} from './compare.ts';
import type { LabsConfig } from './config.ts';
import { renderP50DumbbellChartSvg, splitEligibleBenchesForCharts } from './report-chart.ts';
import { printReportBox, renderSavedResultMarkdown, replayReport } from './report.ts';
import {
  type FreqSample,
  type SavedContext,
  type SavedResult,
  type WorkerResult,
  clearResults,
  deleteResult,
  getBaseline,
  getLastComparison,
  getLabsDir,
  getReportsDir,
  isEnvironmentStable,
  listResults,
  loadResult,
  resultExists,
  resultMedianFreq,
  setLastComparison,
  saveResult,
  setBaseline,
  trimStats,
} from './store.ts';
import { BLUE, CYAN, DIM, GREEN, RED, RESET } from './utils/ansi.ts';

function collectEnvData(
  workerResult: WorkerResult,
  file: string,
  envData: FreqSample[],
  noisyAliases: string[]
): void {
  const runFreq = workerResult.context.cpu.freq;
  envData.push({
    file,
    runFreq,
    postFreq: workerResult.environment?.postFreq ?? runFreq,
  });
  for (const trial of workerResult.benchmarks) {
    for (const run of trial.runs) {
      const stats = run.stats;
      if (stats && (stats as any).noisy) noisyAliases.push(run.name || trial.alias);
    }
  }
}

const WORKER_EXT = import.meta.url.endsWith('.ts') ? 'ts' : 'mjs';
const WORKER = fileURLToPath(new URL(`./worker.${WORKER_EXT}`, import.meta.url));

function globBenchFiles(dir: string, pattern: string): string[] {
  const suffix = pattern.replace(/^\*\*\/\*/, '');
  const results: string[] = [];

  function walk(current: string) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(suffix)) results.push(full);
    }
  }

  walk(dir);
  return results.sort();
}

async function loadConfig(configPath: string): Promise<LabsConfig> {
  const mod = await import(pathToFileURL(configPath).href);
  return (mod.default ?? mod) as LabsConfig;
}

const CACHE_FILE = join(process.cwd(), 'node_modules', '.cache', 'labs-last.json');

function loadLastSelection(): string[] {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveSelection(files: string[]) {
  const dir = dirname(CACHE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(files));
}

function runBench(
  file: string,
  nodeFlags: string[],
  label: string,
  tune: Pick<
    Partial<LabsConfig>,
    'minCpuTime' | 'minSamples' | 'maxSamples' | 'adaptive' | 'maxCpuTime'
  >,
  tagFilter?: string,
  resultFile?: string
): void {
  console.log(`\n${BLUE}▶ ${label}${RESET} ${DIM}(tsx + v8 flags)${RESET}`);
  execSync(`pnpm tsx ${nodeFlags.join(' ')} "${WORKER}"`, {
    stdio: 'inherit',
    env: {
      ...process.env,
      LABS_BENCH_FILE: pathToFileURL(file).href,
      ...(tune.minCpuTime !== undefined ? { LABS_MIN_CPU_TIME: String(tune.minCpuTime * 1e9) } : {}),
      ...(tune.minSamples !== undefined ? { LABS_MIN_SAMPLES: String(tune.minSamples) } : {}),
      ...(tune.maxSamples !== undefined ? { LABS_MAX_SAMPLES: String(tune.maxSamples) } : {}),
      ...(tune.adaptive !== undefined ? { LABS_ADAPTIVE: String(tune.adaptive) } : {}),
      ...(tune.maxCpuTime !== undefined ? { LABS_MAX_CPU_TIME: String(tune.maxCpuTime * 1e9) } : {}),
      ...(tagFilter ? { LABS_GREP_TAGS: tagFilter } : {}),
      ...(resultFile ? { LABS_RESULT_FILE: resultFile } : {}),
    },
  });
}

function fileHasAnyTag(file: string, tags: string[]): boolean {
  if (tags.length === 0) return true;
  const content = readFileSync(file, 'utf-8');
  return tags.some((tag) => content.includes(tag));
}

const DEFAULT_NAME_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;

function dateHint(r: { name: string; timestamp: string }): string | undefined {
  if (DEFAULT_NAME_RE.test(r.name)) return undefined;
  const d = new Date(r.timestamp);
  if (isNaN(d.getTime())) return undefined;
  const mon = d.toLocaleDateString('en-US', { month: 'short' });
  return `${mon} ${d.getDate()} ${d.getFullYear()}`;
}

function error(msg: string): never {
  console.error(`${RED}✖${RESET} ${msg}`);
  process.exit(1);
}

/** Parse a named flag value: --flag value → value, or undefined if flag absent. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const next = args[i + 1];
  if (!next || next.startsWith('-')) return '';
  return next;
}

export async function runCLI(args: string[]) {
  const cwd = process.cwd();
  const configCandidates = ['labs.config.ts', 'benches/labs.config.ts'].map((p) => resolve(cwd, p));
  const configPath = configCandidates.find(existsSync);
  if (!configPath) error(`labs.config.ts not found (checked: ${configCandidates.join(', ')})`);

  let config: LabsConfig;
  try {
    config = await loadConfig(configPath);
  } catch (err) {
    error(`Failed to load config: ${configPath}\n${err}`);
  }

  const labsDir = getLabsDir(dirname(configPath), config.resultsDir);

  // Subcommands: first arg is a known keyword — no bench run occurs.
  const subcmd = args[0];
  const subcmdArgs = args.slice(1);
  const subcmdArg = firstPositionalArg(subcmdArgs);
  const wantsReport = subcmdArgs.includes('--report');

  if (subcmd === 'list') {
    const results = listResults(labsDir);
    const baselineName = getBaseline(labsDir);
    if (results.length === 0) {
      console.log(`${DIM}No saved results${RESET}`);
      return;
    }

    const { select, isCancel } = await import('@clack/prompts');
    const chosen = await select({
      message: 'Select a result to view its report',
      options: results.map((r) => {
        const stable = isEnvironmentStable(r);
        const hints: string[] = [];
        const dh = dateHint(r);
        if (dh) hints.push(dh);
        if (r.name === baselineName) hints.push('baseline');
        if (!stable) hints.push('unstable');
        if (r.description) hints.push(r.description);
        const freq = resultMedianFreq(r);
        if (freq > 0) hints.push(`${freq.toFixed(2)} GHz`);
        return {
          value: r.name,
          label: r.name,
          hint: hints.length > 0 ? hints.join(', ') : undefined,
        };
      }),
    });
    if (isCancel(chosen)) {
      console.log(`${DIM}Cancelled${RESET}`);
      return;
    }

    const result = loadResult(labsDir, chosen as string);
    if (wantsReport) {
      const file = writeBenchReportFile(labsDir, result.name, renderSavedResultMarkdown(result, config));
      console.log(`${GREEN}✔${RESET} Wrote report to "${file}"`);
    }
    else replayReport(result, config);
    return;
  }

  if (subcmd === 'clear') {
    clearResults(labsDir);
    console.log(`${GREEN}✔${RESET} Cleared all saved results`);
    return;
  }

  if (subcmd === 'delete') {
    if (subcmdArg) {
      try {
        deleteResult(labsDir, subcmdArg);
        console.log(`${GREEN}✔${RESET} Deleted "${subcmdArg}"`);
      } catch (e: any) {
        error(e.message);
      }
    } else {
      const results = listResults(labsDir);
      if (results.length === 0) {
        console.log(`${DIM}No saved results${RESET}`);
        return;
      }
      const baselineName = getBaseline(labsDir);
      const { multiselect, isCancel } = await import('@clack/prompts');
      const chosen = await multiselect({
        message: 'Select results to delete',
        options: results.map((r) => {
          const hints: string[] = [];
          const dh = dateHint(r);
          if (dh) hints.push(dh);
          if (r.name === baselineName) hints.push('baseline');
          return {
            value: r.name,
            label: r.name,
            hint: hints.length > 0 ? hints.join(', ') : undefined,
          };
        }),
        required: false,
      });
      if (isCancel(chosen)) {
        console.log(`${DIM}Cancelled${RESET}`);
        return;
      }
      const names = chosen as string[];
      if (names.length === 0) {
        console.log(`${DIM}Nothing selected${RESET}`);
        return;
      }
      for (const name of names) {
        deleteResult(labsDir, name);
        console.log(`${GREEN}✔${RESET} Deleted "${name}"`);
      }
    }
    return;
  }

  if (subcmd === 'prune') {
    const results = listResults(labsDir);
    const baseline = getBaseline(labsDir);
    const unstable = results.filter((r) => r.name !== baseline && !isEnvironmentStable(r));
    if (unstable.length === 0) {
      console.log(`${GREEN}✔${RESET} No unstable results to prune`);
    } else {
      for (const r of unstable) deleteResult(labsDir, r.name);
      console.log(
        `${GREEN}✔${RESET} Pruned ${unstable.length} unstable result${unstable.length !== 1 ? 's' : ''}`
      );
      for (const r of unstable) console.log(`  ${DIM}· ${r.name}${RESET}`);
    }
    return;
  }

  if (subcmd === 'baseline') {
    if (!subcmdArg) {
      const results = listResults(labsDir);
      if (results.length === 0) {
        console.log(`${DIM}No saved results${RESET}`);
        return;
      }
      const current = getBaseline(labsDir);
      const { select, isCancel } = await import('@clack/prompts');
      const chosen = await select({
        message: 'Select a baseline',
        options: results.map((r) => {
          const stable = isEnvironmentStable(r);
          const hints: string[] = [];
          const dh = dateHint(r);
          if (dh) hints.push(dh);
          if (r.name === current) hints.push('current');
          if (!stable) hints.push('unstable');
          return {
            value: r.name,
            label: r.name,
            hint: hints.length ? hints.join(', ') : undefined,
          };
        }),
        initialValue: current,
      });
      if (isCancel(chosen)) {
        console.log(`${DIM}Cancelled${RESET}`);
        return;
      }
      try {
        setBaseline(labsDir, chosen as string);
        console.log(`${GREEN}\u2714${RESET} Baseline set to "${chosen}"`);
      } catch (e: any) {
        error(e.message);
      }
    } else {
      try {
        setBaseline(labsDir, subcmdArg);
        console.log(`${GREEN}✔${RESET} Baseline set to "${subcmdArg}"`);
      } catch (e: any) {
        error(e.message);
      }
    }
    return;
  }

  if (subcmd === 'compare') {
    const baselineName = getBaseline(labsDir);
    if (!baselineName) error('No baseline set. Run: bench baseline <name>');
    let compareBaselineName = baselineName;
    let candidateName: string;
    if (subcmdArgs.includes('--last') || subcmdArgs.includes('-l')) {
      const last = getLastComparison(labsDir);
      if (!last) error('No previous comparison found');
      compareBaselineName = last.baselineName;
      candidateName = last.candidateName;
      console.log(
        `${CYAN}labs${RESET} ${DIM}(replaying last compare: ${compareBaselineName} -> ${candidateName})${RESET}`
      );
    } else if (subcmdArg) {
      candidateName = subcmdArg;
    } else {
      const all = listResults(labsDir);
      const candidates = all.filter((r) => r.name !== baselineName);
      if (candidates.length === 0) error('No saved result to compare. Save a result first with -s.');
      const latestCandidate = candidates[candidates.length - 1]!;
      const baselineResult = all.find((r) => r.name === baselineName);
      const baselineFreq = baselineResult ? resultMedianFreq(baselineResult) : 0;
      const { select, isCancel } = await import('@clack/prompts');
      const chosen = await select({
        message: `Select result to compare against baseline "${baselineName}"`,
        options: candidates.map((r) => {
          const hints: string[] = [];
          const dh = dateHint(r);
          if (dh) hints.push(dh);
          if (r.name === latestCandidate.name) hints.push('latest');
          const freq = resultMedianFreq(r);
          if (baselineFreq > 0 && freq > 0) {
            const diff = (freq - baselineFreq) / baselineFreq;
            const sign = diff >= 0 ? '+' : '';
            hints.push(`clk: ${sign}${(diff * 100).toFixed(1)}%`);
          }
          if (!isEnvironmentStable(r)) hints.push('unstable');
          return {
            value: r.name,
            label: r.name,
            hint: hints.length > 0 ? hints.join(', ') : undefined,
          };
        }),
        initialValue: latestCandidate.name,
      });
      if (isCancel(chosen)) {
        console.log(`${DIM}Cancelled${RESET}`);
        return;
      }
      candidateName = chosen as string;
    }
    try {
      const baseline = loadResult(labsDir, compareBaselineName);
      const candidate = loadResult(labsDir, candidateName);
      const result = compare(baseline, candidate, config);
      if (wantsReport) {
        const files = writeCompareReportFiles(
          labsDir,
          compareBaselineName,
          candidateName,
          result,
          config
        );
        console.log(`${GREEN}✔${RESET} Wrote report to "${files.markdownFile}"`);
        for (const chartFile of files.chartFiles) {
          console.log(`${GREEN}✔${RESET} Wrote chart to "${chartFile}"`);
        }
      }
      else printCompareReport(result, config);
      setLastComparison(labsDir, compareBaselineName, candidateName);
    } catch (e: any) {
      error(e.message);
    }
    return;
  }

  // `run` subcommand — execute without saving results.
  const shouldSave = subcmd !== 'run';
  const benchArgs = shouldSave ? args : args.slice(1);
  if (benchArgs.includes('--run') || benchArgs.includes('--runs')) {
    error('`--run`/`--runs` are no longer supported; labs is single-run only');
  }

  const benchDir = resolve(dirname(configPath), config.benchDir);
  if (!existsSync(benchDir)) error(`benchDir not found: ${benchDir}`);

  const allFiles = globBenchFiles(benchDir, config.benchMatch);
  if (allFiles.length === 0)
    error(`No bench files found matching "${config.benchMatch}" in ${benchDir}`);

  const label = (f: string) => relative(benchDir, f).replace(/\\/g, '/');
  const suiteName = (f: string) => basename(f);

  let selected: string[];
  let tagEnv: string | undefined;

  if (benchArgs.includes('--last')) {
    selected = loadLastSelection().filter(existsSync);
    if (selected.length === 0) error('No previous selection found');
    console.log(`${CYAN}labs${RESET} ${DIM}(replaying last)${RESET}`);
  } else {
    // Single positional arg is the filter string (must be quoted on CLI).
    const FLAG_TAKES_VALUE = new Set(['-n', '--name', '-m', '--message']);
    let filterArg: string | undefined;
    for (let i = 0; i < benchArgs.length; i++) {
      const a = benchArgs[i];
      if (a.startsWith('-')) {
        if (FLAG_TAKES_VALUE.has(a)) i++;
        continue;
      }
      filterArg = a;
      break;
    }

    const tokens = filterArg ? filterArg.split(/\s+/).filter(Boolean) : [];
    const tagFilters = tokens.filter((t) => t.startsWith('@'));
    const nameFilters = tokens.filter((t) => !t.startsWith('@'));
    tagEnv = tagFilters.length > 0 ? tagFilters.join(',') : undefined;

    if (nameFilters.length > 0) {
      const normalize = (s: string) => s.toLowerCase().replace(/[-\s_]+/g, '');
      const seen = new Set<string>();
      const missing: string[] = [];
      selected = [];
      for (const token of nameFilters) {
        const norm = normalize(token);
        const match = allFiles.find((f) => normalize(label(f)).includes(norm));
        if (!match) {
          missing.push(token);
          continue;
        }
        if (!seen.has(match)) {
          seen.add(match);
          selected.push(match);
        }
      }
      if (missing.length > 0) {
        error(
          `No file matching: ${missing.join(', ')}. Available: ${allFiles.map(label).join(', ')}`
        );
      }
    } else {
      selected = allFiles;
    }

    if (tagFilters.length > 0) {
      selected = selected.filter((file) => fileHasAnyTag(file, tagFilters));
    }
    if (selected.length === 0) {
      error(
        `No bench files matched the provided filters. Available: ${allFiles.map(label).join(', ')}`
      );
    }

    saveSelection(selected);
    console.log(`${CYAN}labs${RESET}`);
  }

  if (!shouldSave) {
    const tmpDir = join(cwd, 'node_modules', '.cache', 'labs-tmp');
    mkdirSync(tmpDir, { recursive: true });
    const runOutputs: Array<{ file: string; resultFile: string }> = [];
    for (const f of selected) {
      const resultFile = join(tmpDir, `${basename(f, '.ts')}-${Date.now()}.json`);
      runBench(
        f,
        config.nodeFlags,
        suiteName(f),
        {
          minCpuTime: config.minCpuTime,
          minSamples: config.minSamples,
          maxSamples: config.maxSamples,
          adaptive: config.adaptive,
          maxCpuTime: config.maxCpuTime,
        },
        tagEnv,
        resultFile
      );
      runOutputs.push({ file: f, resultFile });
    }
    const runEnvData: FreqSample[] = [];
    const runNoisyAliases: string[] = [];
    let runCpu: string | null = null;
    for (const { file, resultFile } of runOutputs) {
      if (!existsSync(resultFile)) continue;
      const workerResult: WorkerResult = JSON.parse(readFileSync(resultFile, 'utf-8'));
      rmSync(resultFile);
      runCpu ??= workerResult.context.cpu.name;
      collectEnvData(workerResult, suiteName(file), runEnvData, runNoisyAliases);
    }
    printReportBox(runEnvData, runNoisyAliases, config.maxCpuTime!, undefined, runCpu);
    return;
  }

  // Save path: run workers, collect results, persist.
  const defaultName = () =>
    new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const saveName = flagValue(benchArgs, '-n') ?? flagValue(benchArgs, '--name') ?? defaultName();

  const forceOverwrite = benchArgs.includes('--force') || benchArgs.includes('-f');
  if (!forceOverwrite && resultExists(labsDir, saveName)) {
    const { confirm, isCancel } = await import('@clack/prompts');
    const overwrite = await confirm({
      message: `A result named "${saveName}" already exists. Overwrite?`,
    });
    if (isCancel(overwrite) || !overwrite) {
      console.log(`${DIM}Cancelled${RESET}`);
      return;
    }
  }

  const description = flagValue(benchArgs, '-m') ?? flagValue(benchArgs, '--message');
  const setAsBaseline = benchArgs.includes('--baseline') || benchArgs.includes('-b');
  const shouldCompare = benchArgs.includes('--compare') || benchArgs.includes('-c');

  const tmpDir = join(cwd, 'node_modules', '.cache', 'labs-tmp');
  mkdirSync(tmpDir, { recursive: true });

  const workerOutputs: Array<{ file: string; resultFile: string }> = [];
  for (const f of selected) {
    const resultFile = join(tmpDir, `${basename(f, '.ts')}-${Date.now()}.json`);
    runBench(
      f,
      config.nodeFlags,
      suiteName(f),
      {
        minCpuTime: config.minCpuTime,
        minSamples: config.minSamples,
        maxSamples: config.maxSamples,
        adaptive: config.adaptive,
        maxCpuTime: config.maxCpuTime,
      },
      tagEnv,
      resultFile
    );
    workerOutputs.push({ file: f, resultFile });
  }

  let hardware = {
    cpu: null as string | null,
    arch: null as string | null,
    runtime: null as string | null,
    freq: 0,
  };
  const files: SavedResult['files'] = [];
  let hardwareSet = false;
  const saveEnvData: FreqSample[] = [];
  const saveNoisyAliases: string[] = [];
  let savedNoop: SavedResult['context'] | undefined;

  for (const { file, resultFile } of workerOutputs) {
    if (!existsSync(resultFile)) continue;
    const workerResult: WorkerResult = JSON.parse(readFileSync(resultFile, 'utf-8'));
    rmSync(resultFile);
    if (!hardwareSet) {
      hardware = {
        cpu: workerResult.context.cpu.name,
        arch: workerResult.context.arch,
        runtime: workerResult.context.runtime,
        freq: workerResult.context.cpu.freq,
      };
      if (workerResult.context.noop) {
        savedNoop = {
          version: workerResult.context.version,
          noop: {
            fn: { avg: workerResult.context.noop.fn?.avg ?? 0 },
            iter: { avg: workerResult.context.noop.iter?.avg ?? 0 },
            fn_gc: { avg: workerResult.context.noop.fn_gc?.avg ?? 0 },
          },
        };
      }
      hardwareSet = true;
    }

    collectEnvData(workerResult, suiteName(file), saveEnvData, saveNoisyAliases);

    files.push({
      file: suiteName(file),
      layout: workerResult.layout,
      context: trimContext(workerResult.context),
      benchmarks: workerResult.benchmarks.map((trial) => {
        return {
          alias: trial.alias,
          group: trial.group,
          baseline: trial.baseline,
          gcMode: trial.gcMode ?? 'once',
          groupName: trial.groupName,
          kind: trial.kind ?? 'static',
          style: trial.style ?? { compact: false, highlight: false },
          runs: trial.runs.map((run) => ({
            name: run.name,
            args: run.args,
            ...(run.stats ? { stats: trimStats(run.stats) } : {}),
            ...(run.error !== undefined ? { error: run.error } : {}),
          })),
        };
      }),
    });
  }

  const result: SavedResult = {
    name: saveName,
    ...(description ? { description } : {}),
    timestamp: new Date().toISOString(),
    hardware,
    context: savedNoop,
    files,
    environment: { freqs: saveEnvData },
  };

  saveResult(labsDir, result);
  const isFirstSave = !getBaseline(labsDir);
  let markedBaseline = false;

  if (setAsBaseline || isFirstSave) {
    setBaseline(labsDir, saveName);
    markedBaseline = true;
  }

  const baselineNote = markedBaseline ? ` ${CYAN}(baseline)${RESET}` : '';
  const saveMsg = `${GREEN}\u2714${RESET} Saved "${saveName}"${baselineNote} (${files.length} file${files.length !== 1 ? 's' : ''})`;

  printReportBox(saveEnvData, saveNoisyAliases, config.maxCpuTime!, saveMsg, hardware.cpu);

  if (shouldCompare) {
    const baselineName = getBaseline(labsDir);
    if (!baselineName) {
      console.log(`\n${DIM}No baseline set — skipping compare. Run: bench baseline <name>${RESET}`);
    } else if (baselineName === saveName) {
      console.log(`\n${DIM}Saved result is the baseline — nothing to compare${RESET}`);
    } else {
      try {
        const baselineResult = loadResult(labsDir, baselineName);
        printCompareReport(compare(baselineResult, result, config), config);
        setLastComparison(labsDir, baselineName, saveName);
      } catch (e: any) {
        console.log(`\n${RED}✖${RESET} Compare failed: ${e.message}`);
      }
    }
  }
}

function firstPositionalArg(args: string[]): string | undefined {
  for (const arg of args) {
    if (!arg.startsWith('-')) return arg;
  }
  return undefined;
}

export function reportFilename(name: string): string {
  return `${sanitizeReportSegment(name)}.md`;
}

export function compareReportFilename(baselineName: string, candidateName: string): string {
  return `${sanitizeReportSegment(baselineName)}--${sanitizeReportSegment(candidateName)}.md`;
}

export function compareReportChartFilename(baselineName: string, candidateName: string): string {
  return `${sanitizeReportSegment(baselineName)}--${sanitizeReportSegment(candidateName)}-p50-dumbbell.svg`;
}

export function compareReportChartBatchFilename(
  baselineName: string,
  candidateName: string,
  batch: number
): string {
  return `${sanitizeReportSegment(baselineName)}--${sanitizeReportSegment(candidateName)}-p50-dumbbell-${batch}.svg`;
}

function writeBenchReportFile(labsDir: string, name: string, markdown: string): string {
  return writeReportFile(labsDir, reportFilename(name), markdown);
}

function writeCompareReportFile(
  labsDir: string,
  baselineName: string,
  candidateName: string,
  markdown: string
): string {
  return writeReportFile(labsDir, compareReportFilename(baselineName, candidateName), markdown);
}

function writeCompareReportFiles(
  labsDir: string,
  baselineName: string,
  candidateName: string,
  result: ReturnType<typeof compare>,
  config: LabsConfig
): { markdownFile: string; chartFiles: string[] } {
  const eligible = eligibleBenches(result);
  const chartFiles: string[] = [];
  const chartImages: string[] = [];
  const chunks = splitEligibleBenchesForCharts(eligible);

  chunks.forEach((chunk, index) => {
    const batch = index + 1;
    const chartSvg = renderP50DumbbellChartSvg(
      chunk,
      `${baselineName} vs ${candidateName} p50${chunks.length > 1 ? ` (batch ${batch})` : ''}`
    );
    if (!chartSvg) return;
    const chartFilename =
      chunks.length === 1
        ? compareReportChartFilename(baselineName, candidateName)
        : compareReportChartBatchFilename(baselineName, candidateName, batch);
    chartFiles.push(writeReportFile(labsDir, chartFilename, chartSvg));
    chartImages.push(chartFilename);
  });

  const markdown = renderCompareMarkdownWithAssets(result, config, {
    chartImages,
  });
  const markdownFile = writeCompareReportFile(labsDir, baselineName, candidateName, markdown);
  return { markdownFile, chartFiles };
}

function writeReportFile(labsDir: string, filename: string, markdown: string): string {
  const reportsDir = getReportsDir(labsDir);
  mkdirSync(reportsDir, { recursive: true });
  const file = join(reportsDir, filename);
  writeFileSync(file, markdown);
  return file;
}

function sanitizeReportSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'report';
}

function trimContext(context: WorkerResult['context']): SavedContext {
  return {
    cpu: {
      freq: context.cpu.freq,
      name: context.cpu.name,
    },
    arch: context.arch,
    runtime: context.runtime,
    version: context.version,
    ...(context.noop
      ? {
          noop: {
            ...(context.noop.fn ? { fn: { avg: context.noop.fn.avg } } : {}),
            ...(context.noop.iter ? { iter: { avg: context.noop.iter.avg } } : {}),
            ...(context.noop.fn_gc ? { fn_gc: { avg: context.noop.fn_gc.avg } } : {}),
          },
        }
      : {}),
  };
}
