import type { GcStats } from '../types.ts';
import type { ChromeGcWindow } from './chrome-gc.ts';

export interface FirefoxProfile {
  meta: { configuration?: { features: string[] } };
  threads: Array<{
    name: string;
    stringTable: string[];
    markers: { schema: Record<string, number>; data: any[][] };
  }>;
  processes: FirefoxProfile[];
}

function* threads(profile: FirefoxProfile): Generator<FirefoxProfile['threads'][number]> {
  yield* profile.threads;
  for (const child of profile.processes) yield* threads(child);
}

/** Count collection cycles while timing only their actual GC pauses. */
export function firefoxGcStats(profile: FirefoxProfile, window: ChromeGcWindow): GcStats {
  for (const thread of threads(profile)) {
    const { schema, data } = thread.markers;
    const payload = (row: any[]) => row[schema.data];
    const starts = data.filter((row) => payload(row)?.name === `labs:gc:start:${window.traceId}`);
    const ends = data.filter((row) => payload(row)?.name === `labs:gc:end:${window.traceId}`);
    if (!starts.length && !ends.length) continue;
    if (starts.length !== 1 || ends.length !== 1)
      throw new Error('Firefox GC profile is missing sampling boundaries');
    const start = starts[0][schema.startTime];
    const end = ends[0][schema.startTime];
    if (end < start) throw new Error('Firefox GC profile has reversed sampling boundaries');
    const { traceId: _traceId, ...stats } = window;
    stats.elapsed = (end - start) * 1e6;
    const majors = new Set<number>();
    const pauses: Array<{ start: number; end: number; kind: 'major' | 'minor' }> = [];
    let nativeEvents = 0;
    for (const row of data) {
      const name = thread.stringTable[row[schema.name]];
      if (name !== 'GCMinor' && name !== 'GCSlice') continue;
      nativeEvents++;
      if (row[schema.phase] !== 1) throw new Error('Firefox GC profile contains an incomplete pause');
      const from = Math.max(start, row[schema.startTime]);
      const to = Math.min(end, row[schema.endTime]);
      if (to <= from) continue;
      const kind = name === 'GCSlice' ? 'major' : 'minor';
      pauses.push({ start: from, end: to, kind });
      if (kind === 'minor') stats.minor++;
      else {
        const cycle = payload(row)?.timings?.major_gc_number;
        if (!Number.isSafeInteger(cycle))
          throw new Error('Firefox GC profile is missing a major collection identifier');
        majors.add(cycle);
      }
    }
    if (!nativeEvents) throw new Error('Firefox GC profile did not capture collector events');
    stats.major = majors.size;
    stats.count = stats.major + stats.minor;
    let coveredUntil = start;
    for (const pause of pauses.sort((a, b) => a.start - b.start)) {
      const duration = (pause.end - pause.start) * 1e6;
      stats.total += Math.max(0, pause.end - Math.max(pause.start, coveredUntil)) * 1e6;
      coveredUntil = Math.max(coveredUntil, pause.end);
      if (duration > stats.max) {
        stats.max = duration;
        stats.maxKind = pause.kind;
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
  throw new Error('Firefox GC profile has no sampling thread');
}
