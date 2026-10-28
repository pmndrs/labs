import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as resolveModule } from 'import-meta-resolve';
import { compare } from '../compare.ts';
import type { LabsConfig } from '../config.ts';
import { collectDiagnostics, emptyDiagnostics, printReportBox, printRunSummary } from '../report.ts';
import {
  type FreqSample,
  type GitInfo,
  type SavedContext,
  type SavedFile,
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
import { BLUE, CYAN, DIM, GREEN, RED, RESET, YELLOW } from '../utils/ansi.ts';
import { runBaselineCommand } from './commands/baseline.ts';
import { runCompareCommand } from './commands/compare.ts';
import { runDeleteCommand } from './commands/delete.ts';
import { runListCommand } from './commands/list.ts';
import { runPruneCommand } from './commands/prune.ts';
import { showCompareReport } from './compare-screen.ts';
import {
  type BenchStatus,
  type ProgressEvent,
  LiveView,
  applyEvent,
  createProgress,
  finishFile,
  renderProgress,
  startFile,
} from './progress.ts';
import { compareJson, comparisonExitCode, runJson } from './json.ts';
import { showRunReport } from './run-screen.ts';
import { runStatus } from './run-view.ts';
import { isInteractiveTerminal } from './screen.ts';
import { error, fileHasAnyTag, gitHint } from './utils.ts';
import { type WorkerSpec, runWorkers } from './workers.ts';
import { type Checkout, captureGitInfo, openSide, repoRoot } from './worktree.ts';

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

/** Resolve the counters module from the config file so the project's own install is used. */
function resolveCounters(specifier: string, configPath: string): string {
  try {
    return resolveModule(specifier, pathToFileURL(configPath).href);
  } catch {
    return specifier;
  }
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

type WorkerTune = Pick<
  Partial<LabsConfig>,
  'blockTime' | 'minSamples' | 'heap' | 'blocks' | 'counters'
>;

function workerEnv(
  file: string,
  tune: WorkerTune,
  tagFilter?: string,
  resultFile?: string
): NodeJS.ProcessEnv {
  // Worker behavior is determined only by the current run configuration.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('LABS_')) delete env[key];
  }
  return {
    ...env,
    LABS_BENCH_FILE: pathToFileURL(file).href,
    LABS_BLOCKS: String(tune.blocks ?? 8),
    ...(tune.blockTime !== undefined ? { LABS_BLOCK_TIME: String(tune.blockTime * 1e9) } : {}),
    ...(tune.minSamples !== undefined ? { LABS_MIN_SAMPLES: String(tune.minSamples) } : {}),
    ...(tune.heap === false ? { LABS_HEAP: '0' } : {}),
    ...(tune.counters ? { LABS_COUNTERS: tune.counters } : {}),
    ...(tagFilter ? { LABS_GREP_TAGS: tagFilter } : {}),
    ...(resultFile ? { LABS_RESULT_FILE: resultFile } : {}),
  };
}

/** Accumulates the per file worker outputs of one tree into a saved result. */
class Collection {
  hardware = {
    cpu: null as string | null,
    arch: null as string | null,
    runtime: null as string | null,
    freq: 0,
  };
  files: SavedFile[] = [];
  envData: FreqSample[] = [];
  diagnostics = emptyDiagnostics();
  noop: SavedResult['context'];
  minDelta: number;

  constructor(minDelta: number) {
    this.minDelta = minDelta;
  }

  collect(file: string, resultFile: string): SavedFile | undefined {
    if (!existsSync(resultFile)) return;
    const workerResult: WorkerResult = JSON.parse(readFileSync(resultFile, 'utf-8'));
    rmSync(resultFile);
    if (this.files.length === 0) {
      this.hardware = {
        cpu: workerResult.context.cpu.name,
        arch: workerResult.context.arch,
        runtime: workerResult.context.runtime,
        freq: workerResult.context.cpu.freq,
      };
      if (workerResult.context.noop) {
        this.noop = {
          version: workerResult.context.version,
          noop: {
            fn: { avg: workerResult.context.noop.fn?.avg ?? 0 },
            iter: { avg: workerResult.context.noop.iter?.avg ?? 0 },
            fn_gc: { avg: workerResult.context.noop.fn_gc?.avg ?? 0 },
          },
        };
      }
    }

    this.envData.push(freqSample(workerResult, basename(file)));
    collectDiagnostics(workerResult.benchmarks, this.minDelta, this.diagnostics);

    this.files.push({
      file: basename(file),
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
    return this.files.at(-1);
  }

  get benchCount(): number {
    return this.files.reduce((n, f) => n + f.benchmarks.length, 0);
  }
}

/**
 * One tree a run measures. The candidate is the working checkout unless
 * `--candidate` names another tree. With `--against` a second side is the
 * reference tree, and the two run interleaved so their blocks share the same
 * minutes of machine state.
 */
interface Side {
  benchDir: string;
  cwd: string;
  git: GitInfo | undefined;
  collected: Collection;
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
    await runCompareCommand(ctx, args.slice(1));
    return;
  }

  // `bench` and `bench run` are the same command. Every run saves unless
  // asked not to.
  const benchArgs = subcmd === 'run' ? args.slice(1) : args;
  const shouldSave = !benchArgs.includes('--no-save');
  const json = benchArgs.includes('--json');
  const failOnSlower = benchArgs.includes('--fail-on-slower');
  // In JSON mode stdout carries only the JSON document, so messages go to stderr
  if (json) console.log = console.error;
  const interactive = !json && isInteractiveTerminal();
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
    const flagTakesValue = new Set([
      '-n',
      '--name',
      '-m',
      '--message',
      '--blocks',
      '--against',
      '--candidate',
    ]);
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
    if (!interactive) console.log(`${CYAN}labs${RESET}`);
  }

  const blocksFlag = flagValue(benchArgs, '--blocks');
  if (blocksFlag !== undefined && (!Number.isInteger(Number(blocksFlag)) || Number(blocksFlag) < 2)) {
    error(`Invalid --blocks value "${blocksFlag}" — expected an integer ≥ 2`);
  }
  const blocks = blocksFlag !== undefined ? Number(blocksFlag) : (config.blocks ?? 8);

  const benchTune = {
    blockTime: config.blockTime,
    minSamples: config.minSamples,
    heap: config.heap,
    blocks,
    counters: config.counters && resolveCounters(config.counters, configPath),
  };

  const description = flagValue(benchArgs, '-m') ?? flagValue(benchArgs, '--message');
  const setAsBaseline = benchArgs.includes('--baseline') || benchArgs.includes('-b');
  const shouldCompare = benchArgs.includes('--compare') || benchArgs.includes('-c');

  // `--against <rev|dir>` runs the candidate and the reference tree
  // interleaved, then compares the reference to the candidate. It is a self
  // contained A/B, so the baseline pointer is neither read nor set.
  // `--candidate <rev|dir>` measures that tree in place of the working checkout.
  const againstSpec = flagValue(benchArgs, '--against');
  const candidateSpec = flagValue(benchArgs, '--candidate');
  if (againstSpec === '') error('--against needs a git revision or directory, e.g. --against main');
  if (candidateSpec === '') error('--candidate needs a git revision or directory');
  if (againstSpec && (setAsBaseline || shouldCompare)) {
    error('--against compares the two runs directly; drop --baseline/--compare');
  }
  if ((againstSpec || candidateSpec) && !captureGitInfo(dirname(configPath))) {
    error('--against and --candidate need a git repository');
  }

  // Trees are released on every exit path, including `error()` and interrupts.
  const checkouts: Checkout[] = [];
  process.once('exit', () => {
    for (const c of checkouts) c.dispose();
  });
  const open = (spec: string) => {
    try {
      const checkout = openSide(dirname(configPath), spec, benchDir);
      checkouts.push(checkout);
      return checkout;
    } catch (e: any) {
      error(e.message);
    }
  };
  const side = (checkout: Checkout): Side => ({
    benchDir: join(checkout.dir, relative(repoRoot(dirname(configPath)), benchDir)),
    cwd: join(checkout.dir, relative(repoRoot(dirname(configPath)), cwd)),
    git: checkout.git,
    collected: new Collection(config.minDelta),
  });

  const candidate: Side = candidateSpec
    ? side(open(candidateSpec))
    : {
        benchDir,
        cwd,
        git: captureGitInfo(dirname(configPath)),
        collected: new Collection(config.minDelta),
      };
  const reference = againstSpec ? side(open(againstSpec)) : undefined;
  const sides = reference ? [candidate, reference] : [candidate];
  const git = candidate.git;

  // Default names come from the commit when in a repo (abc1234, abc1234-dirty,
  // abc1234-2, ...), falling back to a timestamp otherwise.
  const defaultName = (info = git) => {
    if (info) {
      return uniqueResultName(labsDir, `${info.commit.slice(0, 7)}${info.dirty ? '-dirty' : ''}`);
    }
    return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  };
  const suppliedName = flagValue(benchArgs, '-n') ?? flagValue(benchArgs, '--name');
  const saveName = suppliedName ?? defaultName();

  const forceOverwrite = benchArgs.includes('--force') || benchArgs.includes('-f');
  if (shouldSave && !forceOverwrite && resultExists(labsDir, saveName)) {
    if (!interactive)
      error(
        `A result named "${saveName}" already exists. Pass --force to overwrite it or -n to pick a name`
      );
    const { confirm, isCancel } = await import('@clack/prompts');
    const overwrite = await confirm({
      message: `A result named "${saveName}" already exists. Overwrite?`,
    });
    if (isCancel(overwrite) || !overwrite) {
      console.log(`${DIM}Cancelled${RESET}`);
      return;
    }
  }

  const tmpDir = join(cwd, 'node_modules', '.cache', 'labs-tmp');
  mkdirSync(tmpDir, { recursive: true });

  const crashes: Array<{ file: string; error: string }> = [];
  // The live view lists one entry per file and side
  const entryName = (f: string, s: Side) =>
    reference ? `${suiteName(f)} ${gitHint(s.git!)}` : suiteName(f);
  const progress = createProgress(
    saveName,
    selected.flatMap((f) => sides.map((s) => entryName(f, s))),
    Date.now()
  );
  const view = interactive
    ? new LiveView(process.stdout, (columns, rows) =>
        renderProgress(progress, { columns, rows, now: Date.now() })
      )
    : undefined;
  const live =
    view || json
      ? (entry: number) => ({
          onEvent: (event: ProgressEvent) => view && applyEvent(progress, entry, event),
          onOutput: (line: string) => (view ? view.log(line) : process.stderr.write(line + '\n')),
        })
      : undefined;
  view?.start();
  if (checkouts.length) process.once('SIGINT', () => process.exit(130));
  for (const [index, f] of selected.entries()) {
    const specs: WorkerSpec[] = [];
    const absent: string[] = [];
    const ran: Array<{ side: Side; entry: number; file: string; resultFile: string }> = [];
    for (const [i, s] of sides.entries()) {
      const file = join(s.benchDir, relative(benchDir, f));
      const entry = index * sides.length + i;
      if (!existsSync(file)) {
        absent.push(gitHint(s.git!));
        if (view) finishFile(progress, entry, Date.now(), { error: 'not present in this tree' });
        continue;
      }
      const resultFile = join(tmpDir, `${basename(f, '.ts')}-${i}-${Date.now()}.json`);
      ran.push({ side: s, entry, file, resultFile });
      if (view) startFile(progress, entry, Date.now());
      specs.push({
        args: ['--import', TSX_LOADER, ...config.nodeFlags, WORKER],
        cwd: s.cwd,
        env: {
          ...workerEnv(file, benchTune, tagEnv, resultFile),
          ...(reference ? { LABS_LABEL: `${DIM}${gitHint(s.git!)}${RESET}` } : {}),
        },
        ...(reference ? { name: gitHint(s.git!) } : {}),
        ...(live ? { live: live(entry) } : {}),
      });
    }
    if (!live) {
      const pairing = reference ? ` ${DIM}${gitHint(git!)} ⇄ ${gitHint(reference.git!)}${RESET}` : '';
      console.log(`\n${BLUE}▶ ${suiteName(f)}${RESET}${pairing}`);
    }
    if (!view) {
      for (const at of absent) {
        console.log(`${YELLOW}⚠${RESET} not present at ${at}, skipped there`);
      }
    }
    let crash: string | undefined;
    try {
      if (specs.length) await runWorkers(specs);
    } catch (err) {
      process.exitCode = 1;
      crash = (err as Error).message;
      crashes.push({ file: suiteName(f), error: crash });
    }
    for (const { side: s, entry, file, resultFile } of ran) {
      const saved = s.collected.collect(file, resultFile);
      if (!view) continue;
      if (!saved) {
        finishFile(progress, entry, Date.now(), { error: crash ?? 'no result' });
        continue;
      }
      const noop = (saved.context ?? s.collected.noop)?.noop;
      const statuses = saved.benchmarks.map((trial): BenchStatus => {
        const runs = trial.runs.map((run) => runStatus(trial, run, noop, config.minDelta));
        return (
          runs.find((run) => run.symbol === '✗') ?? runs.find((run) => run.symbol === '⚠') ?? runs[0]
        );
      });
      finishFile(progress, entry, Date.now(), { statuses });
    }
  }
  view?.stop();
  for (const c of checkouts.splice(0)) c.dispose();

  // A run that selected no benches has nothing worth keeping and would only
  // clutter later compares, so it is reported but never saved.
  if (candidate.collected.benchCount === 0) {
    const filterNote = tagEnv ? ` for ${tagEnv.split(',').join(' ')}` : '';
    console.log(`\n${YELLOW}⚠${RESET} No benches ran${filterNote}, nothing to save`);
    if (json) emit({ name: saveName, saved: false, benches: [], crashes });
    return;
  }

  const buildResult = (s: Side, name: string, description?: string): SavedResult => ({
    name,
    ...(description ? { description } : {}),
    timestamp: new Date().toISOString(),
    ...(s.git ? { git: s.git } : {}),
    hardware: s.collected.hardware,
    blocks,
    context: s.collected.noop,
    files: s.collected.files,
    environment: { freqs: s.collected.envData },
  });
  const result = buildResult(candidate, saveName, description);

  // Interactive runs keep details in the report view and close with a short summary
  const report = (s: Side, saveMsg?: string) => {
    if (json) return;
    const { files, hardware, envData, diagnostics, noop } = s.collected;
    const input = {
      envData,
      cpu: hardware.cpu,
      saveMsg,
      blocks,
      minDelta: config.minDelta,
      diagnostics,
    };
    if (!interactive) return printReportBox(input);
    const counts = { passed: 0, warned: 0, failed: 0 };
    for (const file of files)
      for (const trial of file.benchmarks)
        for (const run of trial.runs) {
          const { symbol } = runStatus(trial, run, (file.context ?? noop)?.noop, config.minDelta);
          if (symbol === '✗') counts.failed++;
          else if (symbol === '✓') counts.passed++;
          else counts.warned++;
        }
    printRunSummary({ ...input, counts });
  };

  if (reference) {
    if (sides.some((s) => s.collected.diagnostics.failedChecks.length > 0)) process.exitCode = 1;
    if (shouldSave) saveResult(labsDir, result);
    // Named after its commit like any default run, once the candidate holds its name.
    const refResult = buildResult(reference, defaultName(reference.git));
    if (shouldSave) {
      saveResult(labsDir, refResult);
      setLastComparison(labsDir, refResult.name, saveName);
    }
    const compared = compare(refResult, result, config);
    const code = comparisonExitCode(compared, config, result, failOnSlower);
    if (code && process.exitCode !== 1) process.exitCode = code;

    const savedLine = (r: SavedResult) => {
      if (!shouldSave) return undefined;
      const hint = r.git ? ` ${DIM}${gitHint(r.git)}${RESET}` : '';
      const details = `${r.files.length} file${r.files.length !== 1 ? 's' : ''}`;
      return interactive
        ? `${r.name}${hint}  ${DIM}${details}${RESET}`
        : `${GREEN}✔${RESET} Saved "${r.name}"${hint} (${details})`;
    };
    const reports = () => {
      report(reference, savedLine(refResult));
      report(candidate, savedLine(result));
    };
    if (!interactive) reports();
    if (json) {
      emit({
        ...runJson(result, config, shouldSave),
        reference: runJson(refResult, config, shouldSave),
        comparison: compareJson(compared, config),
        crashes,
      });
      return;
    }
    await showCompareReport(compared, config);
    if (interactive) reports();
    return;
  }

  const { files, diagnostics } = candidate.collected;
  if (!shouldSave) {
    if (diagnostics.failedChecks.length > 0) process.exitCode = 1;
    if (interactive) await showRunReport(result, config, false);
    report(candidate);
    if (json) emit({ ...runJson(result, config, false), crashes });
    return;
  }

  saveResult(labsDir, result);
  const isFirstSave = !getBaseline(labsDir);
  let markedBaseline = false;
  const checksFailed = diagnostics.failedChecks.length > 0 || crashes.length > 0;

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
  if (!interactive) report(candidate, `${GREEN}✔${RESET} Saved "${saveName}"${gitNote} (${details})`);
  if (!shouldCompare && interactive) await showRunReport(result, config);

  let comparison: ReturnType<typeof compareJson> | null = null;
  if (shouldCompare) {
    const baselineName = getBaseline(labsDir);
    if (!baselineName) {
      console.log(`\n${DIM}No baseline set - skipping compare. Run: bench baseline <name>${RESET}`);
    } else if (baselineName === saveName) {
      console.log(`\n${DIM}Saved result is the baseline - nothing to compare${RESET}`);
    } else {
      try {
        const baselineResult = loadResult(labsDir, baselineName);
        const compared = compare(baselineResult, result, config);
        setLastComparison(labsDir, baselineName, saveName);
        const code = comparisonExitCode(compared, config, result, failOnSlower);
        if (code && process.exitCode !== 1) process.exitCode = code;
        if (json) comparison = compareJson(compared, config);
        else await showCompareReport(compared, config);
      } catch (e: any) {
        console.log(`\n${RED}✖${RESET} Compare failed: ${e.message}`);
      }
    }
  }
  if (interactive) report(candidate, `${saveName}${gitNote}  ${DIM}${details}${RESET}`);
  if (json) emit({ ...runJson(result, config, true), baseline: markedBaseline, comparison, crashes });
}

function emit(output: unknown): void {
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
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
