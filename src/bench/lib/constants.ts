import { gc, now } from './runtime.ts';

/** Tuning constants for the benchmark engine. */
export const tuning = {
  /** Default concurrency (sequential). */
  concurrency: 1,
  /** Minimum samples before a run may stop. */
  min_samples: 12,
  /** Unroll factor inside batched loops. */
  batch_unroll: 4,
  /** Hard ceiling on sample count. */
  max_samples: 2 ** 20,
  /** Consecutive timing windows required for warm-up stability. */
  warmup_samples: 5,
  /** Maximum wall time (ns) spent warming up, including setup and cleanup. */
  warmup_time: 100 * 1e6,
  /** Minimum wall time (ns) of warm-up before agreeing windows may end it. */
  warmup_settle: 5 * 1e6,
  /** Target measured duration (ns) of a warm-up window. */
  warmup_window: 50_000,
  /** Maximum relative range of recent per-call window timings. */
  warmup_tolerance: 0.05,
  /** Target duration (ns) of one batched sample. Batch size is derived from it. */
  batch_duration: 1e6,
  /** Upper bound on iterations per batched sample. */
  batch_max: 1 << 20,
  /** Single-iteration ns threshold below which batching activates. */
  batch_threshold: 65536,
  /** Timed work budget (ns), excluding warmup and memory diagnostics. */
  min_cpu_time: 500 * 1e6,
} as const;

/**
 * Fills missing fields on a benchmark options bag with sensible defaults
 * derived from {@link tuning} and the detected runtime's
 * {@link gc} / {@link now} implementations.
 */
export function defaults(opts: any): void {
  opts.gc ??= gc;
  opts.now ??= now;
  opts.heap ??= null;
  opts.params ??= {};
  opts.manual ??= false;
  opts.sample_gc ??= false;
  opts.$counters ??= false;
  opts.concurrency ??= tuning.concurrency;
  opts.min_samples ??= tuning.min_samples;
  opts.max_samples ??= Math.max(tuning.max_samples, opts.min_samples);
  opts.min_cpu_time ??= tuning.min_cpu_time;
  opts.batch_unroll ??= tuning.batch_unroll;
  opts.batch_duration ??= tuning.batch_duration;
  opts.batch_max ??= tuning.batch_max;
  opts.warmup_samples ??= tuning.warmup_samples;
  opts.warmup_time ??= tuning.warmup_time;
  opts.warmup_settle ??= tuning.warmup_settle;
  opts.warmup_window ??= tuning.warmup_window;
  opts.warmup_tolerance ??= tuning.warmup_tolerance;
  opts.batch_threshold ??= tuning.batch_threshold;
  if (!Number.isSafeInteger(opts.batch_unroll) || opts.batch_unroll < 1)
    throw new TypeError('expected batch_unroll to be a positive integer');
  if (
    opts.batch_samples !== undefined &&
    (!Number.isSafeInteger(opts.batch_samples) || opts.batch_samples < 0)
  )
    throw new TypeError('expected batch_samples to be a nonnegative integer');
}

/**
 * Iterations per batched sample so one sample lasts about `batch_duration`,
 * rounded to whole unrolled groups. A pilot decides this once and later
 * blocks replay it through `batch_samples`.
 */
export function batchSize(opts: any, singleIterationNs: number): number {
  const groups = Math.ceil(opts.batch_duration / Math.max(singleIterationNs, 1) / opts.batch_unroll);
  const size = Math.max(1, Math.min(groups, opts.batch_max / opts.batch_unroll)) * opts.batch_unroll;
  return size;
}
