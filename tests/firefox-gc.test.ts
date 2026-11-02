import { describe, expect, it } from 'vitest';
import { firefoxGcStats, type FirefoxProfile } from '../src/bench/lib/firefox-gc.ts';
import type { ChromeGcWindow } from '../src/bench/lib/chrome-gc.ts';

function window(): ChromeGcWindow {
  return {
    traceId: 0,
    total: 0,
    max: 0,
    count: 0,
    major: 0,
    minor: 0,
    incremental: 0,
    weak: 0,
    other: 0,
    elapsed: 0,
    timed: 60e6,
    iterations: 4,
    overlap: { min: 0, max: 0 },
  };
}

function profile(rows: any[][]): FirefoxProfile {
  return {
    meta: {},
    processes: [],
    threads: [
      {
        name: 'GeckoMain',
        stringTable: ['UserTiming', 'GCSlice', 'GCMinor', 'GCMajor'],
        markers: {
          schema: { name: 0, startTime: 1, endTime: 2, phase: 3, data: 4 },
          data: [
            [0, 100, 0, 0, { name: 'labs:gc:start:0' }],
            ...rows,
            [0, 200, 0, 0, { name: 'labs:gc:end:0' }],
          ],
        },
      },
    ],
  };
}

describe('Firefox GC pauses', () => {
  it('counts each major cycle once and unions its clipped slices with minor pauses', () => {
    const stats = firefoxGcStats(
      profile([
        [3, 80, 210, 1, {}],
        [1, 90, 110, 1, { timings: { major_gc_number: 42 } }],
        [2, 100, 105, 1, {}],
        [1, 150, 170, 1, { timings: { major_gc_number: 42 } }],
      ]),
      window()
    );
    expect(stats).toMatchObject({
      major: 1,
      minor: 1,
      count: 2,
      total: 30e6,
      max: 20e6,
      maxKind: 'major',
      elapsed: 100e6,
      overlap: { min: 0, max: 30e6 },
    });
    expect(stats).not.toHaveProperty('durationKind');
  });

  it('does not count a major lifetime with no GC work inside the sampling window', () => {
    expect(
      firefoxGcStats(
        profile([
          [3, 80, 210, 1, {}],
          [1, 80, 90, 1, { timings: { major_gc_number: 42 } }],
          [1, 210, 220, 1, { timings: { major_gc_number: 42 } }],
        ]),
        window()
      )
    ).toMatchObject({ count: 0, major: 0, total: 0 });
  });

  it('fails missing boundaries or collector data instead of reporting zero', () => {
    expect(() => firefoxGcStats(profile([]), window())).toThrow('did not capture collector events');
    const missing = profile([[2, 110, 120, 1, {}]]);
    missing.threads[0].markers.data.pop();
    expect(() => firefoxGcStats(missing, window())).toThrow('missing sampling boundaries');
    expect(() => firefoxGcStats(profile([[1, 150, 0, 2, {}]]), window())).toThrow('incomplete pause');
  });
});
