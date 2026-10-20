import type { MeasureOptions } from '../types.ts';

type Options = Required<
  Pick<MeasureOptions, 'warmup_samples' | 'warmup_window' | 'warmup_tolerance' | 'batch_max'>
>;

/**
 * Warm-up state owned by the caller and updated in place. `samples` is a ring
 * of the most recent per-call window costs and `sorted` is scratch for ranking
 * them, both sized once to `warmup_samples`.
 */
export function createWarmup(deadline: number, capacity: number) {
  return {
    iterations: 1,
    single: 0,
    deadline,
    samples: new Float64Array(Math.max(1, capacity)),
    sorted: new Float64Array(Math.max(1, capacity)),
    count: 0,
    head: 0,
    resolvedWindows: 0,
    stable: false,
  };
}

export type WarmupState = ReturnType<typeof createWarmup>;

export function isWarmupDone(
  state: WarmupState,
  opts: Pick<Options, 'warmup_samples'>,
  now: number
): boolean {
  return opts.warmup_samples <= 0 || state.stable || now >= state.deadline;
}

/** Enough full windows ran within the budget, yet their per-call costs never agreed. */
export function isWarmupUnsettled(
  state: WarmupState,
  opts: Pick<Options, 'warmup_samples'>
): boolean {
  return opts.warmup_samples > 0 && !state.stable && state.resolvedWindows >= opts.warmup_samples;
}

/** Grow timing windows until recent per-call costs agree or the budget expires. */
export function recordWarmup(
  state: WarmupState,
  duration: number,
  iterations: number,
  opts: Options
): WarmupState {
  const single = duration / iterations;
  if (opts.warmup_samples <= 0) {
    state.single = single;
    return state;
  }

  const capacity = state.samples.length;
  state.samples[state.head] = single;
  state.head = (state.head + 1) % capacity;
  if (state.count < capacity) state.count++;

  // Insertion sort, the window holds only a handful of values.
  const count = state.count;
  const sorted = state.sorted;
  for (let i = 0; i < count; i++) {
    const value = state.samples[i];
    let j = i - 1;
    while (j >= 0 && sorted[j] > value) {
      sorted[j + 1] = sorted[j];
      j--;
    }
    sorted[j + 1] = value;
  }
  const median = sorted[(count / 2) | 0];

  // Short windows can appear stable just because of clock resolution.
  state.resolvedWindows = duration >= opts.warmup_window / 2 ? state.resolvedWindows + 1 : 0;
  state.single = median;
  state.stable =
    state.resolvedWindows >= opts.warmup_samples &&
    sorted[count - 1] - sorted[0] <= median * opts.warmup_tolerance;
  state.iterations = Math.max(
    1,
    Math.min(
      state.iterations * 2,
      Math.ceil(opts.warmup_window / Math.max(single, 1)),
      opts.batch_max
    )
  );
  return state;
}
