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
  /** Iterations per batch when batching is enabled. */
  batch_samples: 4096,
  /** Sample count above which outlier trimming kicks in. */
  samples_threshold: 12,
  /** Single-iteration ns threshold below which batching activates. */
  batch_threshold: 65536,
  /** Minimum total CPU time (ns) before a run may stop. */
  min_cpu_time: 642 * 1e6,
  /** Single-iteration ns threshold below which warm-up is skipped. */
  warmup_threshold: 500_000,
  /** CPU time rescale factor when heap tracking is enabled. */
  cpu_time_rescale_heap: 1.1,
  /** CPU time rescale factor when inner GC is enabled. */
  cpu_time_rescale_inner_gc: 2,
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
  opts.inner_gc ??= false;
  opts.$counters ??= false;
  opts.concurrency ??= tuning.concurrency;
  opts.min_samples ??= tuning.min_samples;
  opts.max_samples ??= tuning.max_samples;
  opts.min_cpu_time ??= tuning.min_cpu_time;
  opts.batch_unroll ??= tuning.batch_unroll;
  opts.batch_samples ??= tuning.batch_samples;
  opts.warmup_samples ??= tuning.warmup_samples;
  opts.batch_threshold ??= tuning.batch_threshold;
  opts.warmup_threshold ??= tuning.warmup_threshold;
  opts.samples_threshold ??= tuning.samples_threshold;
  opts.adaptive ??= true;
  opts.max_cpu_time ??= 5e9;
  if (opts.target_rel_ci === undefined) {
    opts.target_rel_ci =
      opts.adaptive === false ? 0 : opts.adaptive === true ? 0.025 : +opts.adaptive;
  }

  if (opts.heap) opts.min_cpu_time *= tuning.cpu_time_rescale_heap;
  if (opts.gc && opts.inner_gc) opts.min_cpu_time *= tuning.cpu_time_rescale_inner_gc;
}
