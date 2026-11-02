import { describe, expect, it } from 'vitest';
import { bunGcStats, type BunGcEvent, type BunGcWindow } from '../src/bench/lib/bun-gc.ts';
import { formatGcColumns, formatGcEvents } from '../src/bench/format/gc.ts';

function window(): BunGcWindow {
  return { start: 100, end: 200, timed: 60, iterations: 4, comparable: true };
}

function event(type: 'full' | 'partial', start: number, end: number): BunGcEvent {
  return { type, startTime: start / 1e9, endTime: end / 1e9 };
}

describe('Bun GC activity', () => {
  it('counts collections crossing either sampling boundary and clips their durations', () => {
    const stats = bunGcStats(
      [
        event('full', 10, 50),
        event('partial', 80, 130),
        event('full', 150, 230),
        event('full', 250, 300),
      ],
      window(),
      { min: 0, max: 0 }
    );
    expect(stats).toMatchObject({
      durationKind: 'collection',
      count: 2,
      minor: 1,
      major: 1,
      total: 80,
      max: 50,
      maxKind: 'major',
      elapsed: 100,
      overlap: { min: 40, max: 60 },
    });
    expect(formatGcColumns(stats).map((column) => column.heading)).toEqual([
      'gc activity',
      'gc activity max',
    ]);
  });

  it('reports ambiguous boundary events without losing short collections wholly inside sampling', () => {
    const stats = bunGcStats(
      [event('full', 70, 95), event('partial', 130, 135), event('full', 205, 240)],
      window(),
      { min: -10, max: 10 }
    );
    expect(stats).toMatchObject({ count: 1, minor: 1, major: 0, total: 5, boundaryUncertain: 2 });
    expect(stats.overlap).toEqual({ min: 0, max: 15 });
    expect(formatGcEvents(stats)).toContain('2 boundary uncertain');
    const uncertain = bunGcStats([event('full', 70, 95)], window(), { min: -10, max: 10 });
    expect(formatGcColumns(uncertain)[0].value).toBe('—');
    expect(formatGcEvents(uncertain)).toBe('1 boundary uncertain');
  });
});
