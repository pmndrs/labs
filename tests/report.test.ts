import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { renderMitata } from '../src/bench/render.ts';
import {
  type BenchDiagnostics,
  collectDiagnostics,
  emptyDiagnostics,
  printReportBox,
} from '../src/report.ts';

function captureReport(run: () => void): string[] {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    run();
    return log.mock.calls.map(([line]) => stripVTControlCharacters(String(line)));
  } finally {
    log.mockRestore();
  }
}

function report(blocks: number, diagnostics: Partial<BenchDiagnostics>): string[] {
  return captureReport(() =>
    printReportBox({
      envData: [],
      blocks,
      minDelta: 0.05,
      diagnostics: { ...emptyDiagnostics(), ...diagnostics },
    })
  );
}

function trial(name: string, medians: number[], spreads: number[]) {
  return {
    alias: name,
    runs: [
      {
        name,
        stats: { blocks: { medians, freqs: medians.map(() => 4), spreads } },
      },
    ],
  };
}

describe('measurement report', () => {
  it('separates noisy samples from inconsistent runs', () => {
    const steady = [100, 101, 99, 100, 100, 101, 99, 100];
    const diagnostics = collectDiagnostics(
      [
        trial(
          'steady work',
          steady,
          steady.map(() => 0.02)
        ),
        trial(
          'random work',
          steady,
          steady.map(() => 0.3)
        ),
        trial(
          'variable work',
          [100, 92, 108, 95, 105, 90, 110, 99],
          steady.map(() => 0.02)
        ),
      ],
      0.05
    );

    expect(diagnostics.noisy.map((b) => b.name)).toEqual(['random work']);
    expect(diagnostics.inconsistent.map((b) => b.name)).toEqual(['variable work']);
    expect(diagnostics.medianSpreads).toHaveLength(3);
  });

  it('explains noisy samples and lists the affected benchmarks', () => {
    const lines = report(3, {
      medianSpreads: [0.01],
      calibrationExplainedFractions: [0],
      noisy: [{ name: 'random work', spread: 0.3 }],
    });

    expect(
      lines.some((line) =>
        line.includes(
          '⚠ Noisy samples: Timings varied widely within a process suggesting non-deterministic work or runtime interference.'
        )
      )
    ).toBe(true);
    expect(lines.some((line) => line.includes('⚠ random work  ±30.0%'))).toBe(true);
  });

  it('explains inconsistent runs and reports their comparison resolution', () => {
    const lines = report(8, {
      medianSpreads: [0.1],
      calibrationExplainedFractions: [0],
      inconsistent: [{ name: 'variable work', spread: 0.1 }],
    });

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
    expect(lines.some((line) => line.includes('Noisy samples'))).toBe(false);
  });

  it('uses a positive status label for consistent runs', () => {
    const lines = report(8, { medianSpreads: [0.01], calibrationExplainedFractions: [0] });

    expect(lines.some((line) => line.includes('✔ Consistent runs:'))).toBe(true);
    expect(lines.some((line) => line.includes('Affected benchmarks'))).toBe(false);
  });

  it('renders rows without stability markers', () => {
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

    expect(lines.some((line) => line.startsWith('random work'))).toBe(true);
    expect(lines.some((line) => line.startsWith('⚠'))).toBe(false);
  });
});
