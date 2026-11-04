import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { renderReport } from '../src/bench/render.ts';
import { gpuClockShifts, renderRunView, runStatus } from '../src/cli/run-view.ts';
import { defineConfig } from '../src/config.ts';
import type { SavedResult } from '../src/store.ts';
import {
  collectDiagnostics,
  emptyDiagnostics,
  printReportBox,
  printRunSummary,
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

// Six blocks of a GPU bench. The GPU probe reads its speed before each block.
function gpuStats(medians: number[], rates: number[], spreads = medians.map(() => 0.01)) {
  const samples = medians.flatMap((m) => [m * 0.99, m, m * 1.01]).sort((a, b) => a - b);
  return {
    kind: 'gpu' as const,
    samples,
    min: samples[0],
    max: samples[samples.length - 1],
    avg: samples.reduce((a, b) => a + b, 0) / samples.length,
    p25: samples[samples.length >> 2],
    p50: samples[samples.length >> 1],
    p75: samples[(samples.length * 3) >> 2],
    p99: samples[samples.length - 1],
    p999: samples[samples.length - 1],
    ticks: samples.length,
    debug: '',
    blocks: { medians, freqs: rates, spreads },
  };
}

describe('GPU bench reporting', () => {
  const steady = [100e3, 101e3, 100e3, 99e3, 100e3, 101e3];
  const trial = { alias: 'dispatch', gcMode: false as const, args: {}, kind: 'static' as const };

  it('reads GPU time per pass without GC lines', () => {
    const lines: string[] = [];
    renderReport(
      {
        cpu: { freq: 4, name: 'test-cpu' },
        runtime: 'chrome',
        version: 'test',
        arch: 'test',
        now: 0,
        noop: { fn: { avg: 50 }, iter: { avg: 50 }, fn_gc: { avg: 50 } },
      } as any,
      { print: (line) => lines.push(line), colors: false },
      [
        {
          name: null,
          types: [],
          trials: [
            {
              highlight: false,
              compact: false,
              gcMode: false,
              bench: {
                alias: 'dispatch',
                runs: [
                  {
                    name: 'dispatch',
                    args: {},
                    stats: gpuStats(
                      steady,
                      steady.map(() => 1)
                    ),
                  },
                ],
              } as any,
            },
          ],
        },
      ]
    );
    expect(lines.some((line) => /dispatch\s+[\d.]+ µs\/pass/.test(line))).toBe(true);
    expect(lines.some((line) => line.includes('/iter') || line.includes('gc('))).toBe(false);
  });

  it('passes a GPU bench whose blocks ran at one clock', () => {
    const run = {
      name: 'dispatch',
      args: {},
      stats: gpuStats(
        steady,
        steady.map(() => 1)
      ),
    };
    expect(runStatus(trial as any, run as any, undefined, 0.05).symbol).toBe('✓');
    expect(gpuClockShifts(run.stats)).toBe(0);
  });

  it('names the GPU clock when half the blocks ran at another level', () => {
    // Three blocks probed at a quarter of the speed took four times as long
    const medians = [100e3, 400e3, 100e3, 400e3, 100e3, 400e3];
    const rates = [1, 0.25, 1, 0.25, 1, 0.25];
    const run = { name: 'dispatch', args: {}, stats: gpuStats(medians, rates) };
    const status = runStatus(trial as any, run as any, undefined, 0.05);
    expect(status.problem).toBe('gpu-clock');
    expect(status.message).toBe('GPU clock shifted (3/6)');
    expect(status.advice).toBe('free the GPU or lengthen blocks');
  });

  it('counts a block whose samples split between levels as shifted', () => {
    const spreads = [0.01, 0.01, 0.4, 0.01, 0.01, 0.01];
    expect(
      gpuClockShifts(
        gpuStats(
          steady,
          steady.map(() => 1),
          spreads
        )
      )
    ).toBe(1);
  });

  it('shows the GPU clock and vram where CPU benches show gc and heap', () => {
    const stats = {
      ...gpuStats(steady, [1, 1, 1, 1, 0.25, 1]),
      vram: { resident: 4 << 20, perPass: 65536 },
    };
    const result: SavedResult = {
      name: 'gpu',
      timestamp: '2026-01-01T00:00:00.000Z',
      hardware: { cpu: 'test cpu', arch: 'arm64', runtime: 'chrome', freq: 4 },
      blocks: 6,
      files: [
        {
          file: 'gpu.bench.ts',
          benchmarks: [
            {
              ...trial,
              group: 0,
              baseline: false,
              style: { compact: false, highlight: false },
              groupName: '',
              runs: [{ name: 'dispatch', args: {}, stats }],
            },
          ],
        },
      ],
    };
    const view = renderRunView(result, defineConfig({ benchDir: '.' }), {
      columns: 100,
      rows: 30,
      selected: 0,
      detailOffset: 0,
      colors: false,
    }).lines.join('\n');
    expect(view).toMatch(/clock\s+vram/);
    expect(view).toMatch(/5\/6\s+4\.00 MiB/);
    expect(view).toMatch(/120% drift\s+64\.00 KiB\/pass/);
    expect(view).not.toMatch(/\bgc\b/);
  });

  it('reports the GPU clock beside the CPU clock', () => {
    const diagnostics = collectDiagnostics(
      [
        {
          alias: 'dispatch',
          runs: [{ name: 'dispatch', stats: gpuStats(steady, [1, 1.01, 0.99, 1, 1, 1]) }],
        },
      ],
      0.05,
      emptyDiagnostics()
    );
    expect(diagnostics.gpuRates).toHaveLength(6);
    const box = captureReport(() =>
      printReportBox({ envData: [], blocks: 6, minDelta: 0.05, diagnostics })
    );
    expect(box.some((line) => line.includes('✔ Stable GPU clock:'))).toBe(true);
    expect(box.some((line) => line.includes('2.0% drift across 6 blocks.'))).toBe(true);

    const unstable = { ...emptyDiagnostics(), gpuRates: [1, 0.25, 1, 0.25] };
    const warned = captureReport(() =>
      printReportBox({ envData: [], blocks: 4, minDelta: 0.05, diagnostics: unstable })
    );
    expect(warned.some((line) => line.includes('⚠ Unstable GPU clock:'))).toBe(true);
    expect(warned.some((line) => line.includes('Free the GPU or lengthen blocks.'))).toBe(true);

    const summary = captureReport(() =>
      printRunSummary({
        envData: [],
        blocks: 4,
        minDelta: 0.05,
        diagnostics: unstable,
        counts: { passed: 0, warned: 1, failed: 0 },
      })
    );
    expect(summary.join('\n')).toContain('GPU  speed varied 120%  unstable');
  });
});
