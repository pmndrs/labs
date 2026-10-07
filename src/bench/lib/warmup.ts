import type { MeasureOptions } from '../types.ts';

type Options = Required<
  Pick<MeasureOptions, 'warmup_samples' | 'warmup_window' | 'warmup_tolerance' | 'batch_max'>
>;

export type WarmupState = Readonly<{
  iterations: number;
  single: number;
  deadline: number;
  samples: readonly number[];
  resolvedWindows: number;
  stable: boolean;
}>;

export function createWarmup(deadline: number): WarmupState {
  return { iterations: 1, single: 0, deadline, samples: [], resolvedWindows: 0, stable: false };
}

export function isWarmupDone(
  state: WarmupState,
  opts: Pick<Options, 'warmup_samples'>,
  now: number
): boolean {
  return opts.warmup_samples <= 0 || state.stable || now >= state.deadline;
}

/** Grow timing windows until recent per-call costs agree or the budget expires. */
export function recordWarmup(
  state: WarmupState,
  duration: number,
  iterations: number,
  opts: Options
): WarmupState {
  const single = duration / iterations;
  if (opts.warmup_samples <= 0) return { ...state, single };

  const samples = [...state.samples, single];
  if (samples.length > opts.warmup_samples) samples.shift();
  const sorted = samples.toSorted((a, b) => a - b);
  const median = sorted[(sorted.length / 2) | 0];

  // Short windows can appear stable just because of clock resolution.
  const resolvedWindows = duration >= opts.warmup_window / 2 ? state.resolvedWindows + 1 : 0;
  return {
    ...state,
    samples,
    single: median,
    resolvedWindows,
    stable:
      resolvedWindows >= opts.warmup_samples &&
      sorted[sorted.length - 1] - sorted[0] <= median * opts.warmup_tolerance,
    iterations: Math.max(
      1,
      Math.min(
        state.iterations * 2,
        Math.ceil(opts.warmup_window / Math.max(single, 1)),
        opts.batch_max
      )
    ),
  };
}
