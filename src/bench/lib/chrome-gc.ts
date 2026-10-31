import type { GcObserver } from './gc.ts';
import type { GcStats } from '../types.ts';

export interface ChromeTraceEvent {
  name: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
}

export interface ChromeGcWindow extends GcStats {
  traceId: number;
}

/** Mark the actual sampling window without adding hooks around individual samples. */
export class ChromeGcObservation implements GcObserver {
  private traceId: number;

  constructor(traceId: number) {
    this.traceId = traceId;
  }

  start(): void {
    performance.mark(`labs:gc:start:${this.traceId}`);
  }

  async finish(timed: number, iterations: number, comparable = false): Promise<ChromeGcWindow> {
    performance.mark(`labs:gc:end:${this.traceId}`);
    await (globalThis as any).__labsFinishGc();
    return {
      traceId: this.traceId,
      total: 0,
      max: 0,
      count: 0,
      minor: 0,
      major: 0,
      incremental: 0,
      weak: 0,
      other: 0,
      elapsed: 0,
      timed,
      iterations,
      ...(comparable ? { overlap: { min: 0, max: 0 } } : {}),
    };
  }

  cancel(): void {
    performance.clearMarks(`labs:gc:start:${this.traceId}`);
    performance.clearMarks(`labs:gc:end:${this.traceId}`);
  }
}

/** Count renderer GC pauses inside one block's sampling window. */
export function chromeGcStats(events: ChromeTraceEvent[], window: ChromeGcWindow): GcStats {
  const starts = events.filter((event) => event.name === `labs:gc:start:${window.traceId}`);
  const ends = events.filter((event) => event.name === `labs:gc:end:${window.traceId}`);
  const start = starts[0];
  const end = ends[0];
  if (
    starts.length !== 1 ||
    ends.length !== 1 ||
    start.pid !== end.pid ||
    start.tid !== end.tid ||
    end.ts < start.ts
  )
    throw new Error('Chrome GC trace is missing sampling boundaries');

  const { traceId: _traceId, ...stats } = window;
  stats.elapsed = (end.ts - start.ts) * 1e3;
  let coveredUntil = start.ts;
  const pending = new Map<string, ChromeTraceEvent[]>();
  const pauses: ChromeTraceEvent[] = [];
  for (const event of events.toSorted((a, b) => a.ts - b.ts)) {
    if (event.pid !== start.pid || event.tid !== start.tid) continue;
    if (event.name !== 'MajorGC' && event.name !== 'MinorGC') continue;
    if (event.ph === 'X' && event.dur !== undefined) pauses.push(event);
    else if (event.ph === 'B') {
      let stack = pending.get(event.name);
      if (!stack) pending.set(event.name, (stack = []));
      stack.push(event);
    } else if (event.ph === 'E') {
      const begin = pending.get(event.name)?.pop();
      if (begin) pauses.push({ ...begin, dur: event.ts - begin.ts });
      else if (event.ts > start.ts && event.ts <= end.ts) {
        throw new Error('Chrome GC trace contains an incomplete pause');
      }
    }
  }
  if ([...pending.values()].some((stack) => stack.some((event) => event.ts < end.ts))) {
    throw new Error('Chrome GC trace contains an incomplete pause');
  }
  for (const event of pauses.sort((a, b) => a.ts - b.ts)) {
    const from = Math.max(start.ts, event.ts);
    const to = Math.min(end.ts, event.ts + event.dur!);
    if (to <= from) continue;
    const duration = (to - from) * 1e3;
    stats.total += Math.max(0, to - Math.max(from, coveredUntil)) * 1e3;
    coveredUntil = Math.max(coveredUntil, to);
    stats.count++;
    const kind = event.name === 'MajorGC' ? 'major' : 'minor';
    stats[kind]++;
    if (duration > stats.max) {
      stats.max = duration;
      stats.maxKind = kind;
    }
  }
  if (stats.overlap) {
    stats.overlap = {
      min: Math.max(0, stats.total - Math.max(0, stats.elapsed - stats.timed)),
      max: Math.min(stats.total, stats.timed),
    };
  }
  return stats;
}
