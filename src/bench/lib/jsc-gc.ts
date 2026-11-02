import type { GcStats } from '../types.ts';

export interface JscGcEvent {
  type: 'full' | 'partial';
  startTime: number;
  endTime: number;
}

export interface JscGcClock {
  min: number;
  max: number;
}

export interface JscGcWindow {
  start: number;
  end: number;
  timed: number;
  iterations: number;
  comparable: boolean;
}

/** Match the inspector clock to bounded synchronous collections before warmup. */
export function jscGcClock(
  probes: Array<{ before: number; after: number }>,
  events: JscGcEvent[]
): JscGcClock {
  const full = events.filter((event) => event.type === 'full');
  if (!probes.length || full.length !== probes.length) {
    throw new Error('JavaScriptCore GC clock calibration did not receive every forced collection');
  }
  let min = -Infinity;
  let max = Infinity;
  for (let i = 0; i < probes.length; i++) {
    min = Math.max(min, probes[i].before - full[i].startTime * 1e9);
    max = Math.min(max, probes[i].after - full[i].endTime * 1e9);
  }
  if (min > max || !Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error('JavaScriptCore GC clock calibration has no consistent offset');
  }
  return { min, max };
}

/** Clip native collection activity to the actual sampling window. */
export function jscGcStats(events: JscGcEvent[], window: JscGcWindow, clock: JscGcClock): GcStats {
  const stats: GcStats = {
    durationKind: 'collection',
    clockUncertaintyNs: clock.max - clock.min,
    total: 0,
    max: 0,
    count: 0,
    minor: 0,
    major: 0,
    incremental: 0,
    weak: 0,
    other: 0,
    elapsed: window.end - window.start,
    timed: window.timed,
    iterations: window.iterations,
  };
  const shift = (clock.min + clock.max) / 2;
  let coveredUntil = window.start;
  let lower = 0;
  let upper = 0;
  for (const event of events.toSorted((a, b) => a.startTime - b.startTime)) {
    const overlap = (offset: number) =>
      Math.max(
        0,
        Math.min(window.end, event.endTime * 1e9 + offset) -
          Math.max(window.start, event.startTime * 1e9 + offset)
      );
    const least = Math.min(overlap(clock.min), overlap(clock.max));
    const best = Math.max(
      overlap(clock.min),
      overlap(clock.max),
      overlap(Math.max(clock.min, Math.min(clock.max, window.start - event.startTime * 1e9)))
    );
    // Native JSC collections on one heap do not overlap.
    lower += least;
    upper += best;
    if (least <= 0) {
      if (best > 0) stats.boundaryUncertain = (stats.boundaryUncertain ?? 0) + 1;
      continue;
    }
    const start = Math.max(window.start, event.startTime * 1e9 + shift);
    const end = Math.min(window.end, event.endTime * 1e9 + shift);
    const duration = end - start;
    stats.total += Math.max(0, end - Math.max(start, coveredUntil));
    coveredUntil = Math.max(coveredUntil, end);
    stats.count++;
    const kind = event.type === 'full' ? 'major' : 'minor';
    stats[kind]++;
    if (duration > stats.max) {
      stats.max = duration;
      stats.maxKind = kind;
    }
  }
  if (window.comparable) {
    stats.overlap = {
      min: Math.max(0, lower - Math.max(0, stats.elapsed - stats.timed)),
      max: Math.min(upper, stats.timed),
    };
  }
  return stats;
}
