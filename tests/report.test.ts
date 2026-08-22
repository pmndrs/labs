import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { renderMitata } from '../src/bench/render.ts';
import { printReportBox } from '../src/report.ts';

function captureReport(run: () => void): string[] {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    run();
    return log.mock.calls.map(([line]) => stripVTControlCharacters(String(line)));
  } finally {
    log.mockRestore();
  }
}

describe('measurement report', () => {
  it('explains unstable samples and lists the affected benchmarks', () => {
    const lines = captureReport(() => printReportBox([], [{ name: 'random work' }], 5));

    expect(lines).toContain(
      '│  ⚠ Unstable samples: Timings did not settle suggesting non-deterministic work or runtime interference.  │'
    );
    expect(lines.some((line) => line.includes('Time limit: 5s.'))).toBe(true);
    expect(lines.some((line) => line.includes('Affected benchmarks (1):'))).toBe(true);
    expect(lines.some((line) => line.includes('⚠ random work'))).toBe(true);
  });

  it('explains inconsistent runs and reports their comparison resolution', () => {
    const lines = captureReport(() =>
      printReportBox([], [{ name: 'variable work', runMedianSpread: 0.1 }], 5, undefined, undefined, {
        freshRuns: 8,
        medianSpreads: [0.1],
        minDelta: 0.05,
      })
    );

    expect(
      lines.some((line) =>
        line.includes(
          '⚠ Inconsistent runs: Median timings changed across fresh runs suggesting an unstable machine.'
        )
      )
    ).toBe(true);
    expect(lines.some((line) => line.includes('Median spread: ±10.0% across 8 fresh runs.'))).toBe(
      true
    );
    expect(lines.some((line) => line.includes('Comparison resolution: ~±14.0%.'))).toBe(true);
    expect(lines.some((line) => line.includes('Affected benchmarks (1):'))).toBe(true);
  });

  it('uses matching positive status labels for stable measurements', () => {
    const sampleLines = captureReport(() => printReportBox([], [], 5));
    const blockLines = captureReport(() =>
      printReportBox([], [], 5, undefined, undefined, {
        freshRuns: 8,
        medianSpreads: [0.01],
        minDelta: 0.05,
      })
    );

    expect(sampleLines.some((line) => line.includes('✔ Stable samples:'))).toBe(true);
    expect(blockLines.some((line) => line.includes('✔ Consistent runs:'))).toBe(true);
  });

  it('marks unstable rows without using the legacy terminology', () => {
    const lines: string[] = [];
    const noop = { avg: 0 };
    const stats = {
      kind: 'fn',
      samples: [98, 99, 100, 101, 102],
      min: 98,
      max: 102,
      avg: 100,
      p25: 99,
      p50: 100,
      p75: 101,
      p99: 102,
      p999: 102,
      ticks: 5,
      debug: '',
      samplesUnstable: true,
    };

    renderMitata(
      {
        cpu: { freq: 4, name: 'test-cpu' },
        runtime: 'node',
        version: 'test',
        arch: 'test',
        now: 0,
        noop: { fn: noop, iter: noop, fn_gc: noop },
      } as any,
      { print: (line) => lines.push(line), colors: false },
      [
        {
          name: null,
          types: [],
          trials: [
            {
              highlight: false,
              compact: true,
              gcMode: false,
              bench: {
                alias: 'random work',
                runs: [{ name: 'random work', args: {}, stats }],
              } as any,
            },
          ],
        },
      ]
    );

    expect(lines.some((line) => line.startsWith('⚠ random work'))).toBe(true);
    expect(lines.some((line) => line.includes('noisy'))).toBe(false);
    expect(lines.some((line) => line.startsWith('~'))).toBe(false);
  });
});
