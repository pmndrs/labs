import type { GcStats } from '../types.ts';
import type { GcObserver } from './gc.ts';
import { gc, now } from './runtime.ts';

export interface BunGcEvent {
  type: 'full' | 'partial';
  startTime: number;
  endTime: number;
}

export interface BunGcClock {
  min: number;
  max: number;
}

export interface BunGcWindow {
  start: number;
  end: number;
  timed: number;
  iterations: number;
  comparable: boolean;
}

/** Match the inspector clock to bounded synchronous collections before warmup. */
export function bunGcClock(
  probes: Array<{ before: number; after: number }>,
  events: BunGcEvent[]
): BunGcClock {
  const full = events.filter((event) => event.type === 'full');
  if (!probes.length || full.length !== probes.length) {
    throw new Error('Bun GC clock calibration did not receive every forced collection');
  }
  let min = -Infinity;
  let max = Infinity;
  for (let i = 0; i < probes.length; i++) {
    min = Math.max(min, probes[i].before - full[i].startTime * 1e9);
    max = Math.min(max, probes[i].after - full[i].endTime * 1e9);
  }
  if (min > max || !Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error('Bun GC clock calibration has no consistent offset');
  }
  return { min, max };
}

/** Clip native collection activity to the actual sampling window. */
export function bunGcStats(events: BunGcEvent[], window: BunGcWindow, clock: BunGcClock): GcStats {
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

/** Connect an isolated Bun measurement process to its external recorder. */
export async function prepareBunGc(): Promise<() => Promise<void>> {
  let sequence = 0;
  const pending = new Map<number, (value: any) => void>();
  const receive = (message: any) => {
    if (message?.type !== 'labs:bun-gc:reply') return;
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve?.(message.value);
  };
  const request = <T>(message: Record<string, unknown>) =>
    new Promise<T>((resolve) => {
      const id = sequence++;
      pending.set(id, resolve);
      process.send!({ ...message, id });
    });
  process.on('message', receive);
  try {
    await request({ type: 'labs:bun-gc:ready' });
    const probes = [];
    for (let i = 0; i < 16; i++) {
      const before = now();
      gc();
      probes.push({ before, after: now() });
    }
    await request({ type: 'labs:bun-gc:clock', probes });
    (globalThis as any).__LABS_GC_OBSERVER = (): GcObserver => {
      let start = 0;
      return {
        start() {
          start = now();
        },
        finish(timed, iterations, comparable = false) {
          const end = now();
          return request<GcStats>({
            type: 'labs:bun-gc:window',
            window: { start, end, timed, iterations, comparable },
          });
        },
        cancel() {},
      };
    };
  } catch (error) {
    process.off('message', receive);
    throw error;
  }
  return async () => {
    await request({ type: 'labs:bun-gc:done' });
    delete (globalThis as any).__LABS_GC_OBSERVER;
    process.off('message', receive);
    process.disconnect?.();
  };
}
