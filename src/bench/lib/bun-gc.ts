import type { GCProfiler } from 'node:v8';
import type { GcStats } from '../types.ts';
import type { GcObserver } from './gc.ts';
import { now } from './runtime.ts';

/** Collect native JSC events during sampling and materialize them after timing. */
export class BunGcObservation implements GcObserver {
  private startTime = 0;
  private profiler: GCProfiler;

  constructor(profiler: GCProfiler) {
    this.profiler = profiler;
  }

  start(): void {
    this.profiler.start();
    this.startTime = now();
  }

  async finish(timed: number, iterations: number, comparable = false): Promise<GcStats> {
    const endTime = now();
    const profile = this.profiler.stop();
    const stats: GcStats = {
      total: 0,
      max: 0,
      count: 0,
      minor: 0,
      major: 0,
      incremental: 0,
      weak: 0,
      other: 0,
      elapsed: endTime - this.startTime,
      timed,
      iterations,
    };
    for (const event of profile.statistics) {
      const duration = event.cost * 1000;
      const kind =
        event.gcType === 'MarkSweepCompact'
          ? 'major'
          : event.gcType === 'Scavenge'
            ? 'minor'
            : 'other';
      stats.count++;
      stats[kind]++;
      stats.total += duration;
      if (duration > stats.max) {
        stats.max = duration;
        stats.maxKind = kind;
      }
    }
    if (comparable) {
      stats.overlap = {
        min: Math.max(0, stats.total - Math.max(0, stats.elapsed - timed)),
        max: Math.min(stats.total, timed),
      };
    }
    return stats;
  }

  cancel(): void {
    this.profiler.stop();
  }
}
