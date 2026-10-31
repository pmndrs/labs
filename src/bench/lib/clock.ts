import type { MeasureOptions } from '../types.ts';
import { tuning } from './constants.ts';
import { now } from './runtime.ts';

/** Keep timer quantization below one part in 200 of a sampling window. */
export function calibrateClock(
  read = now
): Pick<MeasureOptions, 'batch_threshold' | 'batch_duration' | 'warmup_window'> {
  const start = read();
  let previous = start;
  let resolution = Infinity;
  for (let i = 0; i < 50_000; i++) {
    const current = read();
    if (current > previous) resolution = Math.min(resolution, current - previous);
    previous = current;
    if (current - start >= 2e6) break;
  }
  if (!Number.isFinite(resolution)) throw new Error('Benchmark clock did not advance');
  const window = Math.max(1, Math.round(resolution)) * 200;
  return {
    batch_threshold: Math.max(tuning.batch_threshold, window),
    batch_duration: Math.max(tuning.batch_duration, window),
    warmup_window: Math.max(tuning.warmup_window, window),
  };
}
