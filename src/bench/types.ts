/// <reference lib="dom" preserve="true" />
/// <reference types="@webgpu/types" />
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
  /** Replay target recorded by older pilot-based plans. */
  targetTier?: OptimizationTier;
}

/** GC events during sampling or a diagnostic replay, with durations in nanoseconds. */
export interface GcStats {
  source?: 'replay';
  durationKind?: 'collection';
  clockUncertaintyNs?: number;
  boundaryUncertain?: number;
  total: number;
  max: number;
  maxKind?: 'minor' | 'major' | 'incremental' | 'weak' | 'other';
  count: number;
  minor: number;
  major: number;
  incremental: number;
  weak: number;
  other: number;
  elapsed: number;
  timed: number;
  iterations: number;
  overlap?: { min: number; max: number };
}

/** Forced collection estimates stored by older releases. */
export interface LegacyGcStats {
  min: number;
  max: number;
  p50: number;
}

export type OptimizationTier =
  'Ignition' | 'Sparkplug' | 'Maglev' | 'TurboFan' | 'LLInt' | 'Baseline' | 'DFG' | 'FTL';

export type SamplingDeopt = 'workload' | 'harness' | false;

/** A function the engine compiled and the position of its definition. */
export interface InspectedFunction {
  name: string;
  source: string;
}

/** A call the optimizing compiler replaced with the body of the function it calls. */
export interface InlinedCall extends InspectedFunction {
  at: string;
  bytecodeBytes: number | null;
  calls: InlinedCall[];
}

/**
 * What V8 did with one function up to the end of sampling. Positions read
 * `file:line:column`. `time` is the share of the bench's sampled time spent
 * in the function's own compiled code, which includes what was inlined into
 * it. `tiers` is the path the function took: each tier it rose to and each
 * point where a deopt sent it back down. A deopt lists its own position
 * first, then the call sites it was inlined through. `polymorphic` holds the
 * property accesses that saw more than one object shape, with the layout of
 * each shape. V8 reports where an access is only while its function runs
 * unoptimized, so the shapes of a megamorphic access are the ones seen by
 * then and the count is a lower bound.
 */
export interface Findings {
  time: number | null;
  tiers: Array<OptimizationTier | 'deopt'>;
  inlined: InlinedCall[];
  rejected: Array<InspectedFunction & { bytecodeBytes: number | null; reason: string }>;
  polymorphic: Array<{
    state: 'polymorphic' | 'megamorphic';
    access: string;
    key: string;
    shapes: number;
    layouts: string[];
    at: string;
  }>;
  deopts: Array<{
    phase: 'warmup' | 'sampling';
    tier: OptimizationTier;
    kind: string;
    reason: string;
    at: string[];
  }>;
}

/**
 * What V8 did with a bench: the findings for its workload, and for every
 * other function of the project the workload reached that V8 compiled on its
 * own. `limits` holds the bytecode size the optimizer will inline for one
 * call and for one function in total. A bytecode `listing` is one row per
 * instruction, so a reader that cuts long lines still sees all of it.
 */
export interface Inspection extends Findings {
  engine: string;
  workload: InspectedFunction;
  optimized: 'alone' | 'in-sampling-loop' | null;
  limits: { inlineBytes: number | null; inlineTotalBytes: number | null };
  called: Array<InspectedFunction & Findings & { bytecodeBytes: number | null }>;
  bytecode: Array<InspectedFunction & { listing: string[] }>;
}

/** A stretch of V8's code log that a worker marked for its parent to read. */
export interface DeoptWindow {
  id: number;
  targets: string[];
}

export interface OptimizationSample {
  tier: OptimizationTier;
  time: number;
}

/**
 * Per-block sampling tiers and the pilot's natural compilation probe. A worker
 * reports the `window` it marked in V8's log. Its parent reads the log once
 * the worker has exited, fills in `deoptimized`, and drops the window.
 */
export interface OptimizationStats {
  mode?: 'natural' | 'prepared';
  target?: 'TurboFan';
  natural?: { tier: OptimizationTier | null; time: number };
  benchmark?: Array<OptimizationSample | null>;
  benchmarkEnd?: Array<OptimizationTier | null>;
  /** Per-block TurboFan bailouts observed inside sampling. */
  deoptimized?: Array<SamplingDeopt | null>;
  window?: DeoptWindow;
  workload: Array<OptimizationSample | null>;
  harness?: Array<OptimizationSample | null>;
}

export interface Stats {
  debug: string;
  ticks: number;
  samples: number[];
  /** Hardware counters supplied by the runtime backend. */
  counters?: any;
  kind: 'fn' | 'yield' | 'gpu';
  min: number;
  max: number;
  avg: number;
  p25: number;
  p50: number;
  p75: number;
  p99: number;
  p999: number;
  gc?: GcStats | LegacyGcStats;
  heap?: { min: number; max: number; p50: number; source?: 'replay' };
  vram?: { resident: number; perPass: number };
  /** Decisions this measurement made, usable to freeze later blocks. */
  plan?: BlockPlan;
  /** Output compared with the baseline. */
  snapshot?: Snapshot;
  unsettled?: boolean;
  varyingOutput?: boolean;
  optimization?: OptimizationStats;
  /** Elapsed ns until optimization was verified or warmup timings agreed. */
  warmup?: {
    time: number;
    phase?: 'workload' | 'sampling';
    blocks?: { settled: number; total: number };
  };
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

/** What a generator bench receives: its arguments, the GPU device as a promise, and a shader cache buster. */
export interface BenchState {
  get(name: string): any;
  gpu: Promise<GPUDevice>;
  fresh: (code: string) => string;
}
export type GeneratorBench = (
  state: BenchState
) => Generator<any, any, any> | AsyncGenerator<any, any, any>;

/** What a GPU bench's generator receives: the shared device and a shader cache buster. */
export interface GpuState {
  device: GPUDevice;
  fresh: (code: string) => string;
  get(name: string): any;
}
/** A GPU bench yields a pass timed on the GPU or a self-timed duration. */
export type GpuYield =
  | ({ compute: (pass: GPUComputePassEncoder) => void } & Record<string, unknown>)
  | ({ render: GPURenderPassDescriptor; draw: (pass: GPURenderPassEncoder) => void } & Record<
      string,
      unknown
    >)
  | ({ time: () => number | Promise<number> } & Record<string, unknown>);
export type GpuGeneratorBench = (
  state: GpuState
) => Generator<GpuYield, any, any> | AsyncGenerator<GpuYield, any, any>;

export interface MeasureOptions {
  now?: () => number;
  sample_gc?: boolean;
  heap?: (() => number) | null | false;
  concurrency?: number;
  min_samples?: number;
  /** Sample ceiling and timing buffer capacity. Defaults to at least 2 ** 20 and min_samples. */
  max_samples?: number;
  min_cpu_time?: number;
  batch_unroll?: number;
  /** Iterations per batched sample. Derived from `batch_duration` when omitted. */
  batch_samples?: number;
  /** Target ns per batched sample. */
  batch_duration?: number;
  batch_max?: number;
  /** Shortest batched sample in ns the clock can time. A pilot falling short resizes its batch. */
  batch_floor?: number;
  /** Forces the batching decision instead of probing for it. */
  batch?: boolean;
  /** Consecutive stable warm-up windows. Zero disables warm-up after the first call. */
  warmup_samples?: number;
  /** Wall-time budget in ns for warm-up, including parameter and after hooks. */
  warmup_time?: number;
  warmup_settle?: number;
  /** Target measured duration in ns of each warm-up window. */
  warmup_window?: number;
  /** Maximum relative range of the recent per-call window timings. */
  warmup_tolerance?: number;
  batch_threshold?: number;
  gc?: boolean | ((() => void) & { fallback?: boolean });
  $counters?: any;
  params?: Record<string | number, (...args: any[]) => any>;
  manual?: string | false;
  args?: Record<string, any>;
  /** Receives the first untimed result before warmup. */
  $first?: (value: unknown) => void | Promise<void>;
  $deopts?: (functions: Function[]) => { start(): void; finish(): void; observed(): DeoptWindow };
}

export type FnKind = 'fn' | 'yield';
export type GcMode = boolean | 'once' | 'inner';

export type Color =
  'red' | 'cyan' | 'blue' | 'green' | 'yellow' | 'magenta' | 'gray' | 'white' | 'black';

export interface Run {
  stats?: Stats;
  inspection?: Inspection;
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
  noop: { fn?: Stats; fn_gc?: Stats };
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
