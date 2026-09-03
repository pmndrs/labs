import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compare, compareFailed, printCompareReport } from '../compare.ts';
import type { LabsConfig } from '../config.ts';
import { collectDiagnostics, emptyDiagnostics, printReportBox } from '../report.ts';
import {
  type FreqSample,
  type GitInfo,
  type SavedContext,
  type SavedResult,
  type WorkerResult,
  clearResults,
  getBaseline,
  getLabsDir,
  loadResult,
  resultExists,
  saveResult,
  setBaseline,
  setLastComparison,
  trimStats,
  uniqueResultName,
} from '../store.ts';
import { BLUE, CYAN, DIM, GREEN, RED, RESET } from '../utils/ansi.ts';
import { runBaselineCommand } from './commands/baseline.ts';
import { runCompareCommand } from './commands/compare.ts';
import { runDeleteCommand } from './commands/delete.ts';
import { runListCommand } from './commands/list.ts';
import { runPruneCommand } from './commands/prune.ts';
import { error, fileHasAnyTag, gitHint } from './utils.ts';

function freqSample(workerResult: WorkerResult, file: string): FreqSample {
  const runFreq = workerResult.context.cpu.freq;
  return { file, runFreq, postFreq: workerResult.environment?.postFreq ?? runFreq };
}

const WORKER_EXT = import.meta.url.endsWith('.ts') ? 'ts' : 'mjs';
const WORKER = fileURLToPath(new URL(`../worker.${WORKER_EXT}`, import.meta.url));
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

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
  tune: Pick<Partial<LabsConfig>, 'blockTime' | 'minSamples' | 'blocks'>,
  tagFilter?: string,
  resultFile?: string
): void {
  console.log(`\n${BLUE}▶ ${label}${RESET}`);

  // Worker behavior is determined only by the current run configuration.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('LABS_')) delete env[key];
  }

  execFileSync(process.execPath, ['--import', TSX_LOADER, ...nodeFlags, WORKER], {
    stdio: 'inherit',
    env: {
      ...env,
      LABS_BENCH_FILE: pathToFileURL(file).href,
      LABS_BLOCKS: String(tune.blocks ?? 8),
      ...(tune.blockTime !== undefined ? { LABS_BLOCK_TIME: String(tune.blockTime * 1e9) } : {}),
      ...(tune.minSamples !== undefined ? { LABS_MIN_SAMPLES: String(tune.minSamples) } : {}),
      ...(tagFilter ? { LABS_GREP_TAGS: tagFilter } : {}),
      ...(resultFile ? { LABS_RESULT_FILE: resultFile } : {}),
    },
  });
}

/** Snapshot of the git state a run was produced from. Undefined outside a repo. */
function captureGitInfo(dir: string): GitInfo | undefined {
  const git = (cmd: string) =>
    execSync(`git ${cmd}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  try {
    const commit = git('rev-parse HEAD');
    const ref = git('rev-parse --abbrev-ref HEAD');
    const dirty = git('status --porcelain').length > 0;
    return { commit, branch: ref === 'HEAD' ? null : ref, dirty };
  } catch {
    return undefined;
  }
}

/** Parse a named flag value: --flag value -> value, or undefined if flag absent. */
function flagValue(args: string[], flag: string): string | undefined {
  const joined = args.find((a) => a.startsWith(`${flag}=`));
  if (joined !== undefined) return joined.slice(flag.length + 1);
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
    error(`Failed to load config: ${configPath}\n${String(err)}`);
  }

  const labsDir = getLabsDir(dirname(configPath), config.resultsDir);
  const ctx = { config, configPath, labsDir };

  // Subcommands: first arg is a known keyword - no bench run occurs.
  const subcmd = args[0];
  const subcmdArg = args[1];

  if (subcmd === 'list') {
    await runListCommand(ctx);
    return;
  }

  if (subcmd === 'clear') {
    clearResults(labsDir);
    console.log(`${GREEN}✔${RESET} Cleared all saved results`);
    return;
  }

  if (subcmd === 'delete') {
    await runDeleteCommand(ctx, subcmdArg);
    return;
  }

  if (subcmd === 'prune') {
    runPruneCommand(ctx);
    return;
  }

  if (subcmd === 'baseline') {
    await runBaselineCommand(ctx, subcmdArg);
    return;
  }

  if (subcmd === 'compare') {
    await runCompareCommand(ctx, subcmdArg);
    return;
  }

  // `bench` and `bench run` are the same command. Every run saves unless
  // asked not to.
  const benchArgs = subcmd === 'run' ? args.slice(1) : args;
  const shouldSave = !benchArgs.includes('--no-save');
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
    const flagTakesValue = new Set(['-n', '--name', '-m', '--message', '--blocks']);
    let filterArg: string | undefined;
    for (let i = 0; i < benchArgs.length; i++) {
      const a = benchArgs[i];
      if (a.startsWith('-')) {
        if (flagTakesValue.has(a)) i++;
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
      selected = selected.filter((file) => fileHasAnyTag(readFileSync(file, 'utf-8'), tagFilters));
    }
    if (selected.length === 0) {
      error(
        `No bench files matched the provided filters. Available: ${allFiles.map(label).join(', ')}`
      );
    }

    saveSelection(selected);
    console.log(`${CYAN}labs${RESET}`);
  }

  const blocksFlag = flagValue(benchArgs, '--blocks');
  if (blocksFlag !== undefined && (!Number.isInteger(Number(blocksFlag)) || Number(blocksFlag) < 2)) {
    error(`Invalid --blocks value "${blocksFlag}" — expected an integer ≥ 2`);
  }
  const blocks = blocksFlag !== undefined ? Number(blocksFlag) : (config.blocks ?? 8);

  const benchTune = { blockTime: config.blockTime, minSamples: config.minSamples, blocks };

  const git = captureGitInfo(dirname(configPath));

  // Default names come from the commit when in a repo (abc1234, abc1234-dirty,
  // abc1234-2, ...), falling back to a timestamp otherwise.
  const defaultName = () => {
    if (git) {
      return uniqueResultName(labsDir, `${git.commit.slice(0, 7)}${git.dirty ? '-dirty' : ''}`);
    }
    return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  };
  const suppliedName = flagValue(benchArgs, '-n') ?? flagValue(benchArgs, '--name');
  const saveName = suppliedName ?? defaultName();

  const forceOverwrite = benchArgs.includes('--force') || benchArgs.includes('-f');
  if (shouldSave && !forceOverwrite && resultExists(labsDir, saveName)) {
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
    runBench(f, config.nodeFlags, suiteName(f), benchTune, tagEnv, resultFile);
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
  const saveDiagnostics = emptyDiagnostics();
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

    saveEnvData.push(freqSample(workerResult, suiteName(file)));
    collectDiagnostics(workerResult.benchmarks, config.minDelta, saveDiagnostics);

    files.push({
      file: suiteName(file),
      layout: workerResult.layout,
      context: trimContext(workerResult.context),
      benchmarks: workerResult.benchmarks.map((trial) => ({
        alias: trial.alias,
        group: trial.group,
        baseline: trial.baseline,
        gcMode: trial.gcMode ?? true,
        groupName: trial.groupName,
        kind: trial.kind ?? 'static',
        style: trial.style ?? { compact: false, highlight: false },
        runs: trial.runs.map((run) => ({
          name: run.name,
          args: run.args,
          ...(run.stats ? { stats: trimStats(run.stats) } : {}),
          ...(run.error !== undefined ? { error: run.error } : {}),
        })),
      })),
    });
  }

  if (!shouldSave) {
    printReportBox({
      envData: saveEnvData,
      cpu: hardware.cpu,
      blocks,
      minDelta: config.minDelta,
      diagnostics: saveDiagnostics,
    });
    if (saveDiagnostics.failedChecks.length > 0) process.exitCode = 1;
    return;
  }

  const result: SavedResult = {
    name: saveName,
    ...(description ? { description } : {}),
    timestamp: new Date().toISOString(),
    ...(git ? { git } : {}),
    hardware,
    blocks,
    context: savedNoop,
    files,
    environment: { freqs: saveEnvData },
  };

  saveResult(labsDir, result);
  const isFirstSave = !getBaseline(labsDir);
  let markedBaseline = false;
  const checksFailed = saveDiagnostics.failedChecks.length > 0;

  // Failed checks cannot establish a baseline.
  if ((setAsBaseline || isFirstSave) && !checksFailed) {
    setBaseline(labsDir, saveName);
    markedBaseline = true;
  }
  if (checksFailed) process.exitCode = 1;

  const gitNote = git && suppliedName ? ` ${DIM}${gitHint(git)}${RESET}` : '';
  const details = [
    markedBaseline ? `${CYAN}baseline${RESET}` : '',
    `${files.length} file${files.length !== 1 ? 's' : ''}`,
    checksFailed && (setAsBaseline || isFirstSave) ? `${RED}not set as baseline${RESET}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const saveMsg = `${GREEN}✔${RESET} Saved "${saveName}"${gitNote} (${details})`;

  printReportBox({
    envData: saveEnvData,
    cpu: hardware.cpu,
    saveMsg,
    blocks,
    minDelta: config.minDelta,
    diagnostics: saveDiagnostics,
  });

  if (shouldCompare) {
    const baselineName = getBaseline(labsDir);
    if (!baselineName) {
      console.log(`\n${DIM}No baseline set - skipping compare. Run: bench baseline <name>${RESET}`);
    } else if (baselineName === saveName) {
      console.log(`\n${DIM}Saved result is the baseline - nothing to compare${RESET}`);
    } else {
      try {
        const baselineResult = loadResult(labsDir, baselineName);
        const comparison = compare(baselineResult, result, config);
        printCompareReport(comparison, config);
        setLastComparison(labsDir, baselineName, saveName);
        if (compareFailed(comparison)) process.exitCode = 1;
      } catch (e: any) {
        console.log(`\n${RED}✖${RESET} Compare failed: ${e.message}`);
      }
    }
  }
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
