import type { PerformanceEntry, PerformanceNodeEntry } from 'node:perf_hooks';
import type { GcStats } from '../types.ts';

export interface GcObserver {
  start(): void;
  finish(timed: number, iterations: number, comparable?: boolean): Promise<GcStats>;
  cancel(): void;
}

/** Observe one sampling block without adding hooks around individual samples. */
export class GcObservation {
  private entries: PerformanceEntry[] = [];
  private startTime = 0;
  private observer: import('node:perf_hooks').PerformanceObserver;
  private immediate: typeof import('node:timers/promises').setImmediate;
  private constants: typeof import('node:perf_hooks').constants;

  private constructor(
    hooks: typeof import('node:perf_hooks'),
    immediate: typeof import('node:timers/promises').setImmediate
  ) {
    this.immediate = immediate;
    this.constants = hooks.constants;
    this.observer = new hooks.PerformanceObserver((list) => {
      for (const entry of list.getEntries()) this.entries.push(entry);
    });
  }

  static async create(): Promise<GcObserver | undefined> {
    if (!(globalThis as any).process?.versions?.node) {
      return (globalThis as any).__LABS_GC_OBSERVER?.();
    }
    const [hooks, timers] = await Promise.all([
      import('node:perf_hooks'),
      import('node:timers/promises'),
    ]);
    return new GcObservation(hooks, timers.setImmediate);
  }

  start(): void {
    this.observer.observe({ entryTypes: ['gc'] });
    this.startTime = performance.now();
  }

  async finish(timed: number, iterations: number, comparable = false): Promise<GcStats> {
    const endTime = performance.now();
    try {
      // Native GC notifications and observer delivery use separate event loop turns.
      await this.immediate();
      await this.immediate();
      for (const entry of this.observer.takeRecords()) this.entries.push(entry);
      const stats: GcStats = {
        total: 0,
        max: 0,
        count: 0,
        minor: 0,
        major: 0,
        incremental: 0,
        weak: 0,
        other: 0,
        elapsed: (endTime - this.startTime) * 1e6,
        timed,
        iterations,
      };
      let coveredUntil = this.startTime;
      this.entries.sort((a, b) => a.startTime - b.startTime);
      for (const entry of this.entries) {
        const start = Math.max(this.startTime, entry.startTime);
        const end = Math.min(endTime, entry.startTime + entry.duration);
        if (end <= start) continue;
        const duration = (end - start) * 1e6;
        stats.total += Math.max(0, end - Math.max(start, coveredUntil)) * 1e6;
        coveredUntil = Math.max(coveredUntil, end);
        stats.count++;
        let eventKind: NonNullable<GcStats['maxKind']>;
        switch ((entry as PerformanceNodeEntry).detail.kind) {
          case this.constants.NODE_PERFORMANCE_GC_MINOR:
            stats.minor++;
            eventKind = 'minor';
            break;
          case this.constants.NODE_PERFORMANCE_GC_MAJOR:
            stats.major++;
            eventKind = 'major';
            break;
          case this.constants.NODE_PERFORMANCE_GC_INCREMENTAL:
            stats.incremental++;
            eventKind = 'incremental';
            break;
          case this.constants.NODE_PERFORMANCE_GC_WEAKCB:
            stats.weak++;
            eventKind = 'weak';
            break;
          default:
            stats.other++;
            eventKind = 'other';
        }
        if (duration > stats.max) {
          stats.max = duration;
          stats.maxKind = eventKind;
        }
      }
      if (comparable) {
        // GC outside timed windows cannot exceed the total time in sampling gaps.
        stats.overlap = {
          min: Math.max(0, stats.total - Math.max(0, stats.elapsed - timed)),
          max: Math.min(stats.total, timed),
        };
      }
      return stats;
    } finally {
      this.cancel();
    }
  }

  cancel(): void {
    this.observer.disconnect();
    this.entries = [];
  }
}

/** Pool GC totals across fresh process blocks. */
export function mergeGc(list: GcStats[]): GcStats {
  return list.reduce((total, stats) => ({
    ...(total.source === 'replay' && stats.source === 'replay' ? { source: 'replay' as const } : {}),
    total: total.total + stats.total,
    max: Math.max(total.max, stats.max),
    maxKind: stats.max > total.max ? stats.maxKind : total.maxKind,
    count: total.count + stats.count,
    minor: total.minor + stats.minor,
    major: total.major + stats.major,
    incremental: total.incremental + stats.incremental,
    weak: total.weak + stats.weak,
    other: total.other + stats.other,
    elapsed: total.elapsed + stats.elapsed,
    timed: total.timed + stats.timed,
    iterations: total.iterations + stats.iterations,
    ...(total.overlap && stats.overlap
      ? {
          overlap: {
            min: total.overlap.min + stats.overlap.min,
            max: total.overlap.max + stats.overlap.max,
          },
        }
      : {}),
  }));
}
