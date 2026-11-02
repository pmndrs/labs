import type { GcObserver } from './gc.ts';
import type { GcStats } from '../types.ts';

/** Bound one sampling phase in the calibrated page clock. */
export class WebkitGcObservation implements GcObserver {
  private startTime = 0;

  start(): void {
    this.startTime = performance.now() * 1e6;
  }

  finish(timed: number, iterations: number, comparable = false): Promise<GcStats> {
    const end = performance.now() * 1e6;
    return (globalThis as any).__labsFinishGc({
      start: this.startTime,
      end,
      timed,
      iterations,
      comparable,
    });
  }

  cancel(): void {}
}
