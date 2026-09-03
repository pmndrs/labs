/**
 * Measurement decisions made once by a pilot block and replayed verbatim by
 * every later block, so all blocks of a bench do identical work.
 */
export interface BlockPlan {
  batch: boolean;
  batch_samples: number;
  batch_unroll: number;
  /** Untrimmed sample count the pilot collected and each block replays. */
  samples: number;
}

export interface Stats {
  debug: string;
  ticks: number;
  samples: number[];
  counters?: any;
  kind: 'fn' | 'iter' | 'yield';
  min: number;
  max: number;
  avg: number;
  p25: number;
  p50: number;
  p75: number;
  p99: number;
  p999: number;
  gc?: { avg: number; min: number; max: number; total: number };
  heap?: { avg: number; min: number; max: number; total: number };
  /** Decisions this measurement made, usable to freeze later blocks. */
  plan?: BlockPlan;
  /** Output compared with the baseline. */
  snapshot?: Snapshot;
  /** Per-block summaries when the benchmark ran in multiple fresh processes. */
  blocks?: {
    medians: number[];
    /** Software calibration rates. The `freqs` name is retained for saved-result compatibility. */
    freqs: number[];
    /** Relative spread of each block's own samples, the within-process noise. */
    spreads?: number[];
  };
}

/**
 * Numeric output kept as values so compare can apply a tolerance, with
 * non-finite numbers spelled out for JSON. Any other output is a digest.
 */
export type Snapshot = string | number | Snapshot[];

/** Recognizes assertion errors from Labs and other assertion libraries. */
export function isAssertionError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as any).name === 'AssertionError';
}

export type GeneratorBench = (state: any) => Generator<any, any, any>;

export interface MeasureOptions {
  now?: () => number;
  sample_gc?: boolean;
  heap?: (() => number) | null | false;
  concurrency?: number;
  min_samples?: number;
  max_samples?: number;
  /** Time budget in ns a run must reach, together with `min_samples`, before it stops. */
  min_cpu_time?: number;
  batch_unroll?: number;
  /** Iterations per batched sample. Derived from `batch_duration` when omitted. */
  batch_samples?: number;
  /** Target ns per batched sample. */
  batch_duration?: number;
  batch_max?: number;
  /** Forces the batching decision instead of probing for it. */
  batch?: boolean;
  warmup_samples?: number;
  batch_threshold?: number;
  warmup_threshold?: number;
  samples_threshold?: number;
  gc?: boolean | ((() => void) & { fallback?: boolean });
  $counters?: any;
  params?: Record<string | number, (...args: any[]) => any>;
  manual?: string | false;
  args?: Record<string, any>;
  /** Receives the first untimed result before warmup. */
  $first?: (value: unknown) => void | Promise<void>;
}

export type FnKind = 'fn' | 'iter' | 'yield';
export type GcMode = boolean | 'once' | 'inner';

export type Color =
  'red' | 'cyan' | 'blue' | 'green' | 'yellow' | 'magenta' | 'gray' | 'white' | 'black';

export interface Run {
  stats?: Stats;
  error?: unknown;
  name: string;
  args: Record<string, any>;
}

export interface Trial {
  runs: Run[];
  alias: string;
  group: number;
  gcMode: GcMode;
  baseline: boolean;
  args: Record<string, any[]>;
  kind: 'args' | 'static' | 'multi-args';
  style: {
    compact: boolean;
    highlight: false | string;
  };
}

export interface Context {
  now: number;
  arch: string | null;
  version: string | null;
  runtime: string | null;
  cpu: { freq: number; name: string | null };
  noop: { fn: Stats; iter: Stats; fn_gc: Stats };
}

export interface RunOptions {
  throw?: boolean;
  filter?: RegExp;
  colors?: boolean;
  print?: (s: string) => void;
  observe?: (t: Trial) => Trial;
  tune?: MeasureOptions;
  calibrate?: MeasureOptions;
  format?: string | Record<string, any>;
  /** Executes one registered trial. The default runs it in-process. */
  run_trial?: (trial: any, index: number) => Trial | Promise<Trial>;
  /**
   * Executes all filtered trials up front, keyed by registration index.
   * Overrides run_trial and lets the executor control scheduling order,
   * e.g. round robin block interleaving across benches.
   */
  execute?: (jobs: Array<{ trial: any; index: number }>) => Promise<Map<number, Trial>>;
}

export interface Collection {
  id: number;
  name: string | null;
  types: string[];
  trials: any[];
}
