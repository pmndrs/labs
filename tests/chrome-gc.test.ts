import { describe, expect, it } from 'vitest';
import {
  chromeGcStats,
  type ChromeGcWindow,
  type ChromeTraceEvent,
} from '../src/bench/lib/chrome-gc.ts';

function window(): ChromeGcWindow {
  return {
    traceId: 0,
    total: 0,
    max: 0,
    count: 0,
    minor: 0,
    major: 0,
    incremental: 0,
    weak: 0,
    other: 0,
    elapsed: 0,
    timed: 60_000,
    iterations: 4,
    overlap: { min: 0, max: 0 },
  };
}

function event(name: string, ts: number, dur?: number): ChromeTraceEvent {
  return { name, ts, dur, ph: dur === undefined ? 'I' : 'X', pid: 1, tid: 2 };
}

describe('Chrome GC trace accounting', () => {
  it('clips pauses to sampling, ignores other threads and nested phases, and unions overlapping pauses', () => {
    const stats = chromeGcStats(
      [
        event('labs:gc:start:0', 100),
        event('MinorGC', 80, 30),
        event('MajorGC', 150, 30),
        event('V8.GCCompactor', 150, 30),
        event('MajorGC', 175, 40),
        { ...event('MajorGC', 110, 80), tid: 3 },
        { ...event('MajorGC', 110, 80), pid: 3 },
        event('MinorGC', 200, 30),
        event('labs:gc:end:0', 200),
      ],
      window()
    );
    expect(stats).toEqual({
      total: 60_000,
      max: 30_000,
      maxKind: 'major',
      count: 3,
      minor: 1,
      major: 2,
      incremental: 0,
      weak: 0,
      other: 0,
      elapsed: 100_000,
      timed: 60_000,
      iterations: 4,
      overlap: { min: 20_000, max: 60_000 },
    });
  });

  it('accepts begin/end events and distinguishes no collections from a missing trace', () => {
    const boundaries = [event('labs:gc:start:0', 100), event('labs:gc:end:0', 200)];
    expect(chromeGcStats(boundaries, window())).toMatchObject({ count: 0, total: 0 });
    expect(
      chromeGcStats(
        [...boundaries, { ...event('MinorGC', 120), ph: 'B' }, { ...event('MinorGC', 150), ph: 'E' }],
        window()
      )
    ).toMatchObject({ count: 1, minor: 1, total: 30_000, max: 30_000 });
    expect(() => chromeGcStats([], window())).toThrow('missing sampling boundaries');
    expect(() =>
      chromeGcStats([...boundaries, { ...event('MinorGC', 120), ph: 'B' }], window())
    ).toThrow('incomplete pause');
  });
});
