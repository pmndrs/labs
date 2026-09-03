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
  max_samples: 1e9,
  /** Warm-up iterations before timing begins. */
  warmup_samples: 2,
  /** Target duration (ns) of one batched sample. Batch size is derived from it. */
  batch_duration: 1e6,
  /** Upper bound on iterations per batched sample. */
  batch_max: 1 << 20,
  /** Sample count above which outlier trimming kicks in. */
  samples_threshold: 12,
  /** Single-iteration ns threshold below which batching activates. */
  batch_threshold: 65536,
  /** Time budget (ns) a run must reach before it may stop. */
  min_cpu_time: 500 * 1e6,
  /** Single-iteration ns threshold below which warm-up is skipped. */
  warmup_threshold: 500_000,
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
  opts.max_samples ??= tuning.max_samples;
  opts.min_cpu_time ??= tuning.min_cpu_time;
  opts.batch_unroll ??= tuning.batch_unroll;
  opts.batch_duration ??= tuning.batch_duration;
  opts.batch_max ??= tuning.batch_max;
  opts.warmup_samples ??= tuning.warmup_samples;
  opts.batch_threshold ??= tuning.batch_threshold;
  opts.warmup_threshold ??= tuning.warmup_threshold;
  opts.samples_threshold ??= tuning.samples_threshold;
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
