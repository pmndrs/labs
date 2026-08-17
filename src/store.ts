import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GcMode, Stats } from './bench/types.ts';

export interface GitInfo {
  /** Full sha of HEAD when the run was saved. */
  commit: string;
  /** Branch name, or null when HEAD is detached. */
  branch: string | null;
  /** True when the working tree had uncommitted changes. */
  dirty: boolean;
}

export interface HardwareInfo {
  cpu: string | null;
  arch: string | null;
  runtime: string | null;
  freq: number;
}

export interface SavedStats {
  kind: Stats['kind'];
  samples: number[];
  counters?: any;
  min: number;
  max: number;
  avg: number;
  p25: number;
  p75: number;
  p99: number;
  noisy?: boolean;
  gc?: { avg: number; min: number; max: number };
  heap?: { avg: number; min: number; max: number };
}

export interface WorkerBenchmarkRun {
  stats?: Stats;
  name: string;
  args: Record<string, any>;
  error?: unknown;
}

export interface WorkerBenchmarkTrial {
  alias: string;
  group: number;
  baseline: boolean;
  gcMode?: GcMode;
  runs: WorkerBenchmarkRun[];
  groupName?: string;
  kind?: 'args' | 'static' | 'multi-args';
  style?: {
    compact: boolean;
    highlight: false | string;
  };
}

export interface SavedBenchmarkRun {
  stats?: SavedStats;
  name: string;
  args: Record<string, any>;
  error?: unknown;
}

export interface SavedBenchmarkTrial {
  alias: string;
  group: number;
  baseline: boolean;
  gcMode: GcMode;
  groupName?: string;
  kind: 'args' | 'static' | 'multi-args';
  style: {
    compact: boolean;
    highlight: false | string;
  };
  runs: SavedBenchmarkRun[];
}

export interface WorkerResult {
  context: {
    cpu: { freq: number; name: string | null };
    arch: string | null;
    runtime: string | null;
    version?: string | null;
    noop?: {
      fn?: { avg: number };
      iter?: { avg: number };
      fn_gc?: { avg: number };
    };
  };
  layout?: Array<{ name: string | null; types: string[] }>;
  benchmarks: WorkerBenchmarkTrial[];
  environment?: { preFreq?: number; postFreq: number };
}

export interface SavedContext {
  cpu: { freq: number; name: string | null };
  arch: string | null;
  runtime: string | null;
  version?: string | null;
  noop?: {
    fn?: { avg: number };
    iter?: { avg: number };
    fn_gc?: { avg: number };
  };
}

export interface SavedFile {
  file: string;
  layout?: Array<{ name: string | null; types: string[] }>;
  context?: SavedContext;
  benchmarks: SavedBenchmarkTrial[];
}

export interface FreqSample {
  file: string;
  /** @deprecated Use `runFreq` or `postFreq`. */
  preFreq?: number;
  runFreq: number;
  postFreq: number;
}

export interface SavedResult {
  name: string;
  description?: string;
  timestamp: string;
  git?: GitInfo;
  hardware: HardwareInfo;
  /**
   * Worker isolation used for the run. An omitted value means one worker per
   * file.
   */
  isolation?: 'bench' | 'file';
  context?: {
    version?: string | null;
    noop?: {
      fn: { avg: number };
      iter: { avg: number };
      fn_gc: { avg: number };
    };
  };
  files: SavedFile[];
  environment?: { freqs: FreqSample[] };
}

export interface LastComparison {
  baselineName: string;
  candidateName: string;
}

function freqReadings(freqs: FreqSample[]): number[] {
  return freqs.flatMap((s) => [s.runFreq, s.postFreq]);
}

/** Returns true if the CPU clock was stable during the run (drift ≤ threshold). */
export function isEnvironmentStable(result: SavedResult, threshold = 0.05): boolean {
  const freqs = result.environment?.freqs ?? [];
  if (freqs.length === 0) return true;
  const all = freqReadings(freqs);
  const min = Math.min(...all);
  const max = Math.max(...all);
  return (max - min) / ((max + min) / 2) <= threshold;
}

/** Median CPU frequency across all freq samples, falling back to the hardware snapshot. */
export function resultMedianFreq(result: SavedResult): number {
  const freqs = result.environment?.freqs ?? [];
  if (freqs.length > 0) {
    const all = freqReadings(freqs).sort((a, b) => a - b);
    return all[all.length >> 1];
  }
  return result.hardware.freq;
}

/** Relative clock drift (0–1) within a single run. 0 when no freq data. */
export function resultFreqDrift(result: SavedResult): number {
  const freqs = result.environment?.freqs ?? [];
  if (freqs.length === 0) return 0;
  const all = freqReadings(freqs);
  const min = Math.min(...all);
  const max = Math.max(...all);
  return (max - min) / ((max + min) / 2);
}

export function getLabsDir(configDir: string, resultsDir: string): string {
  return join(configDir, resultsDir);
}

export function getResultsDir(labsDir: string): string {
  return join(labsDir, 'results');
}

export function resultExists(labsDir: string, name: string): boolean {
  return existsSync(join(getResultsDir(labsDir), `${name}.json`));
}

/** First free name among `base`, `base-2`, `base-3`, ... */
export function uniqueResultName(labsDir: string, base: string): string {
  if (!resultExists(labsDir, base)) return base;
  for (let i = 2; ; i++) {
    const name = `${base}-${i}`;
    if (!resultExists(labsDir, name)) return name;
  }
}

export function saveResult(labsDir: string, result: SavedResult): void {
  const dir = getResultsDir(labsDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${result.name}.json`), JSON.stringify(result, null, 2));
}

export function loadResult(labsDir: string, name: string): SavedResult {
  const file = join(getResultsDir(labsDir), `${name}.json`);
  if (!existsSync(file)) throw new Error(`No saved result named "${name}"`);
  return normalizeSavedResult(JSON.parse(readFileSync(file, 'utf-8')) as SavedResult);
}

export function listResults(labsDir: string): SavedResult[] {
  const dir = getResultsDir(labsDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => normalizeSavedResult(JSON.parse(readFileSync(join(dir, f), 'utf-8')) as SavedResult))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

const SHA_PREFIX_RE = /^[0-9a-f]{4,40}$/;

/**
 * Resolve a user-supplied ref to a saved result name. Exact names win;
 * otherwise a hex string of ≥4 chars is treated as a commit sha prefix.
 * When one commit has several runs, the most recent one is returned.
 */
export function resolveResultName(labsDir: string, ref: string): string {
  if (resultExists(labsDir, ref)) return ref;

  const prefix = ref.toLowerCase();
  if (!SHA_PREFIX_RE.test(prefix)) throw new Error(`No saved result named "${ref}"`);

  // listResults sorts by timestamp ascending, so the last match is the newest.
  const matches = listResults(labsDir).filter((r) => r.git?.commit.startsWith(prefix));
  if (matches.length === 0) {
    throw new Error(`No saved result named "${ref}" or from a commit matching ${ref}`);
  }

  const commits = new Set(matches.map((r) => r.git!.commit));
  if (commits.size > 1) {
    const shas = [...commits].map((c) => c.slice(0, 7)).join(', ');
    throw new Error(`Commit prefix ${ref} is ambiguous (matches ${shas})`);
  }

  return matches[matches.length - 1].name;
}

function normalizeSavedResult(result: SavedResult): SavedResult {
  const legacyLayout = (result as any).layout as SavedFile['layout'] | undefined;
  return {
    ...result,
    files: result.files.map((file) => ({
      ...file,
      layout: file.layout ?? legacyLayout,
      context: file.context ?? {
        cpu: { freq: result.hardware.freq, name: result.hardware.cpu },
        arch: result.hardware.arch,
        runtime: result.hardware.runtime,
        version: result.context?.version,
        noop: result.context?.noop,
      },
      benchmarks: file.benchmarks.map((bench) => normalizeTrial(bench as any)),
    })),
  };
}

function normalizeTrial(
  trial: SavedBenchmarkTrial & { stats?: Stats; error?: unknown }
): SavedBenchmarkTrial {
  if (Array.isArray((trial as any).runs)) {
    return {
      ...trial,
      group: (trial as any).group ?? 0,
      gcMode: (trial as any).gcMode ?? 'once',
      kind: trial.kind ?? 'static',
      style: trial.style ?? { compact: false, highlight: false },
      runs: (trial as any).runs,
    };
  }

  return {
    alias: trial.alias,
    group: (trial as any).group ?? 0,
    baseline: trial.baseline,
    gcMode: (trial as any).gcMode ?? 'once',
    groupName: trial.groupName,
    kind: 'static',
    style: { compact: false, highlight: false },
    runs: [
      {
        name: trial.alias,
        args: {},
        ...(trial.stats ? { stats: trimStats(trial.stats) } : {}),
        ...(trial.error !== undefined ? { error: trial.error } : {}),
      },
    ],
  };
}

export function trimStats(stats: Stats): SavedStats {
  return {
    kind: stats.kind,
    samples: stats.samples,
    ...(stats.counters ? { counters: stats.counters } : {}),
    min: stats.min,
    max: stats.max,
    avg: stats.avg,
    p25: stats.p25,
    p75: stats.p75,
    p99: stats.p99,
    ...(stats.noisy !== undefined ? { noisy: stats.noisy } : {}),
    ...(stats.gc
      ? {
          gc: {
            avg: stats.gc.avg,
            min: stats.gc.min,
            max: stats.gc.max,
          },
        }
      : {}),
    ...(stats.heap
      ? {
          heap: {
            avg: stats.heap.avg,
            min: stats.heap.min,
            max: stats.heap.max,
          },
        }
      : {}),
  };
}

export function deleteResult(labsDir: string, name: string): void {
  const file = join(getResultsDir(labsDir), `${name}.json`);
  if (!existsSync(file)) throw new Error(`No saved result named "${name}"`);
  rmSync(file);
  // Clear baseline pointer if it referenced this result.
  const baselineFile = join(labsDir, 'baseline');
  if (existsSync(baselineFile) && readFileSync(baselineFile, 'utf-8').trim() === name) {
    rmSync(baselineFile);
  }
  // Clear last-compare pointer if it referenced this result.
  const lastCompareFile = join(labsDir, 'last-compare.json');
  if (existsSync(lastCompareFile)) {
    try {
      const last = JSON.parse(readFileSync(lastCompareFile, 'utf-8')) as LastComparison;
      if (last.baselineName === name || last.candidateName === name) {
        rmSync(lastCompareFile);
      }
    } catch {
      rmSync(lastCompareFile);
    }
  }
}

export function clearResults(labsDir: string): void {
  if (existsSync(labsDir)) rmSync(labsDir, { recursive: true, force: true });
}

export function setBaseline(labsDir: string, name: string): void {
  const file = join(getResultsDir(labsDir), `${name}.json`);
  if (!existsSync(file)) throw new Error(`No saved result named "${name}"`);
  mkdirSync(labsDir, { recursive: true });
  writeFileSync(join(labsDir, 'baseline'), name);
}

export function getBaseline(labsDir: string): string | undefined {
  const file = join(labsDir, 'baseline');
  if (!existsSync(file)) return undefined;
  return readFileSync(file, 'utf-8').trim() || undefined;
}

export function setLastComparison(
  labsDir: string,
  baselineName: string,
  candidateName: string
): void {
  mkdirSync(labsDir, { recursive: true });
  const file = join(labsDir, 'last-compare.json');
  writeFileSync(file, JSON.stringify({ baselineName, candidateName }, null, 2));
}

export function getLastComparison(labsDir: string): LastComparison | undefined {
  const file = join(labsDir, 'last-compare.json');
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<LastComparison>;
    if (typeof parsed.baselineName !== 'string') return undefined;
    if (typeof parsed.candidateName !== 'string') return undefined;
    return { baselineName: parsed.baselineName, candidateName: parsed.candidateName };
  } catch {
    return undefined;
  }
}
