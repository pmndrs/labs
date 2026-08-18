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
  noisy?: boolean;
  /** Decisions this measurement made, usable to freeze later blocks. */
  plan?: BlockPlan;
  /** Per-block summaries when the bench ran as multiple isolated blocks. */
  blocks?: { medians: number[]; freqs: number[] };
}

export interface MeasureOptions {
  now?: () => number;
  sample_gc?: boolean;
  heap?: (() => number) | null | false;
  concurrency?: number;
  min_samples?: number;
  max_samples?: number;
  min_cpu_time?: number;
  max_cpu_time?: number;
  batch_unroll?: number;
  batch_samples?: number;
  /** Forces the batching decision instead of probing for it. */
  batch?: boolean;
  warmup_samples?: number;
  batch_threshold?: number;
  warmup_threshold?: number;
  samples_threshold?: number;
  gc?: boolean | ((() => void) & { fallback?: boolean });
  adaptive?: boolean | number;
  target_rel_ci?: number;
  $counters?: any;
  params?: Record<string | number, (...args: any[]) => any>;
  manual?: string | false;
  args?: Record<string, any>;
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
