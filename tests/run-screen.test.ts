import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'fast-string-width';
import { describe, expect, it, vi } from 'vitest';
import { defineConfig } from '../src/config.ts';
import { replayReport } from '../src/report.ts';
import type { SavedResult } from '../src/store.ts';
import { CYAN, MAGENTA, YELLOW } from '../src/utils/ansi.ts';
import { showRunReport } from '../src/cli/run-screen.ts';
import { renderRunView } from '../src/cli/run-view.ts';
import { openReportScreen } from '../src/cli/screen.ts';

function fixture(): SavedResult {
  return {
    name: 'relations-v2',
    timestamp: '2026-01-01T00:00:00.000Z',
    hardware: { cpu: 'test cpu', arch: 'arm64', runtime: 'node', freq: 4 },
    blocks: 8,
    files: [
      {
        file: 'entities.bench.ts',
        benchmarks: [
          {
            alias: 'create entities',
            group: 0,
            baseline: false,
            gcMode: true,
            kind: 'static',
            style: { compact: false, highlight: false },
            runs: [
              {
                name: 'create entities',
                args: {},
                stats: {
                  kind: 'fn',
                  samples: [400, 450, 500, 550, 600, 650, 700, 750],
                  min: 400,
                  max: 750,
                  avg: 575,
                  p25: 450,
                  p75: 650,
                  p99: 750,
                  blocks: {
                    medians: [570, 574, 575, 576, 580, 570, 580, 575],
                    freqs: Array(8).fill(4),
                    spreads: Array(8).fill(0.2),
                  },
                  gc: { min: 10, max: 20, p50: 15 },
                  heap: { min: 1024, max: 2048, p50: 1536 },
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

function render(result = fixture(), columns = 100, detailOffset = 0) {
  return renderRunView(result, defineConfig({ benchDir: '.' }), {
    columns,
    rows: 30,
    selected: 0,
    detailOffset,
    colors: false,
  });
}

describe('run report', () => {
  it.each([
    ['fn', false, 'fn'],
    ['fn', true, 'fn_gc'],
    ['fn', 'inner', 'fn_gc'],
    ['iter', true, 'iter'],
  ] as const)('preserves optimization warnings for %s timings with GC %s', (kind, gcMode, mode) => {
    const result = fixture();
    const trial = result.files[0].benchmarks[0];
    trial.gcMode = gcMode;
    trial.runs[0].stats!.kind = kind;
    trial.runs[0].stats!.blocks!.spreads = Array(8).fill(0);
    result.context = { noop: { fn: { avg: 0 }, iter: { avg: 0 }, fn_gc: { avg: 0 } } };
    result.context.noop![mode].avg = 1000;

    const text = render(result).lines.join('\n');
    expect(text).toContain('⚠ create entities');
    expect(text).toContain('likely optimized out');
    expect(text).toContain('1 warning');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      replayReport(result, defineConfig({ benchDir: '.' }));
      expect(log.mock.calls.flat().join('\n')).toContain('likely optimized out');
    } finally {
      log.mockRestore();
    }

    result.files[0].context = {
      cpu: { freq: 4, name: 'test cpu' },
      arch: 'arm64',
      runtime: 'node',
      noop: { fn: { avg: 100 }, iter: { avg: 100 }, fn_gc: { avg: 100 } },
    };
    const calibrated = render(result).lines.join('\n');
    expect(calibrated).toContain('✓ create entities');
    expect(calibrated).not.toContain('likely optimized out');
    expect(calibrated).not.toContain('warning');
  });

  it('keeps unstable clock readings visible across selections and counts the run warning once', () => {
    const result = fixture();
    const trial = result.files[0].benchmarks[0];
    trial.runs[0].stats!.blocks!.spreads = Array(8).fill(0);
    trial.runs.push({ ...trial.runs[0], name: 'remove entities' });
    result.environment = { freqs: [{ file: 'entities.bench.ts', runFreq: 4, postFreq: 2 }] };
    for (const selected of [0, 1]) {
      const frame = renderRunView(result, defineConfig({ benchDir: '.' }), {
        columns: 100,
        rows: 30,
        selected,
        colors: false,
      });
      const text = frame.lines.join('\n');
      expect(text).toContain('⚠ Unstable clock: 2.00–4.00 GHz (66.7% drift)');
      expect(text).toContain('1 warning');
      expect(frame.lines).toHaveLength(30);
    }
    const narrow = render(result, 40);
    expect(narrow.lines.join('\n')).toContain('Unstable clock');
    expect(narrow.lines.every((line) => stringWidth(line) < 40)).toBe(true);

    result.environment.freqs[0].postFreq = 3.99;
    const stable = render(result).lines.join('\n');
    expect(stable).not.toContain('Unstable clock');
    expect(stable).not.toContain('warning');
  });

  it('shows real measurements with timings, distribution, and memory in aligned columns', () => {
    const result = fixture();
    const frame = render(result);
    const text = frame.lines.join('\n');
    expect(text).toContain('noisy samples ✦ runs agree');
    expect(text).toContain('consistency ✦ 8 runs');
    expect(text).toContain('10.00–20.00 ns');
    expect(text).toContain('1.00–2.00 KiB');
    expect(text).toContain('1 warning');
    expect(text).not.toContain('min–max');
    const avg = frame.lines.find((line) => line.includes('avg') && line.includes('575.00 ns'))!;
    const p75 = frame.lines.find((line) => line.includes('p75') && line.includes('650.00 ns'))!;
    expect(avg).toContain('avg  575.00 ns');
    expect(avg).toContain('gc');
    expect(avg).toContain('heap');
    expect(p75).toContain('15.00 ns');
    expect(p75).toContain('1.50 KiB');
    const consistency = frame.lines.find((line) => line.includes('consistency'))!;
    const p99 = frame.lines.find((line) => line.includes('p99') && line.includes('750.00 ns'))!;
    expect(p75).toMatch(/[▁▂▃▄▅▆▇█]/);
    const header = frame.lines[1];
    expect(consistency.indexOf('consistency')).toBe(1);
    expect(frame.lines[frame.lines.indexOf(consistency) + 1].trim()).toBe('');
    const dots = frame.lines[frame.lines.indexOf(consistency) + 2];
    expect(dots.indexOf('╞')).toBe(1);
    expect(dots.indexOf('╡')).toBe(47);
    expect(avg.indexOf('gc') + 2).toBe(header.indexOf('avg') + 3);
    expect(avg.indexOf('heap') + 4).toBe(header.indexOf('heap') + 4);
    expect(avg.indexOf('gc') + 2).toBe(p75.indexOf('15.00 ns') + 8);
    expect(avg.indexOf('heap') + 4).toBe(p75.indexOf('1.50 KiB') + 8);
    expect(avg.indexOf('575.00 ns')).toBe(p75.indexOf('650.00 ns'));
    expect(p99.indexOf('400.00 ns')).toBeLessThan(avg.indexOf('gc'));
    const colored = renderRunView(result, defineConfig({ benchDir: '.' }), {
      columns: 100,
      rows: 30,
      selected: 0,
    }).lines.join('\n');
    for (const color of [CYAN, MAGENTA, YELLOW]) expect(colored).toContain(color);
    expect(stripVTControlCharacters(colored)).toBe(text);
  });

  it.each([80, 90, 100])(
    'keeps measurements together and consistency visible at %i columns',
    (columns) => {
      const result = fixture();
      const stats = result.files[0].benchmarks[0].runs[0].stats!;
      stats.gc = { min: 1.58e6, max: 1.58e6, p50: 1.58e6 };
      stats.heap = { min: 45.39 * 1024 ** 2, max: 45.39 * 1024 ** 2, p50: 45.39 * 1024 ** 2 };
      const frame = render(result, columns);
      const avg = frame.lines.find((line) => line.includes('avg') && line.includes('575.00 ns'))!;
      const p75 = frame.lines.find((line) => line.includes('p75') && line.includes('650.00 ns'))!;
      const p99 = frame.lines.find((line) => line.includes('p99') && line.includes('750.00 ns'))!;
      expect(avg).toContain('avg  575.00 ns');
      expect(avg).toContain('gc');
      expect(avg).toContain('heap');
      expect(p75).toMatch(/[▁▂▃▄▅▆▇█]/);
      expect(p75).toContain('1.58 ms');
      expect(p75).toContain('45.39 MiB');
      expect(p99).toContain('400.00 ns');
      expect(p99).toContain('750.00 ns');
      expect(p99).toContain('1.58–1.58 ms');
      expect(p99).toContain('45.39–45.39 MiB');
      expect(p99.indexOf('1.58–1.58 ms')).toBeGreaterThan(p99.lastIndexOf('750.00 ns') + 9);
      const graph = frame.lines.findIndex((line) => line.includes('consistency'));
      expect(frame.lines[graph + 2]).toMatch(/╞.*[●⬤].*╡/);
      expect(frame.lines[graph + 3]).toContain('372.00 ns');
      expect(frame.lines[graph + 3]).toContain('778.00 ns');
      expect(frame.maxDetailOffset).toBe(0);
      expect(frame.lines.every((line) => stringWidth(line) < columns)).toBe(true);
    }
  );

  it.each([40, 55, 70, 75])(
    'stacks memory values without ranges in the narrow %i-column layout',
    (columns) => {
      const frame = render(fixture(), columns);
      const text = frame.lines.join('\n');
      expect(frame.lines[1]).toContain('avg');
      expect(frame.lines[1]).toContain('p99');
      const selected = frame.lines.find((line) => line.includes('›') && line.includes('575.00 ns'))!;
      expect(selected).toContain('750.00 ns');
      const avg = frame.lines.find((line) => line.includes('avg') && line.includes('575.00 ns'))!;
      expect(avg).toContain('avg  575.00 ns');
      const gc = frame.lines.findIndex((line) => line.includes('gc') && line.includes('15.00 ns'));
      expect(gc).toBeGreaterThan(0);
      expect(frame.lines[gc + 1]).toContain('heap');
      expect(frame.lines[gc + 1]).not.toContain('heap / iter');
      expect(frame.lines[gc + 1]).toContain('1.50 KiB');
      if (columns >= 70) expect(frame.lines[gc]).toBe(avg);
      expect(text).not.toContain('10.00–20.00 ns');
      expect(text).not.toContain('1.00–2.00 KiB');
      expect(text).toContain('400.00 ns');
      expect(text).toContain('750.00 ns');
      const graph = frame.lines.findIndex((line) => line.includes('consistency'));
      expect(frame.lines[graph + 2]).toMatch(/╞.*[●⬤].*╡/);
      expect(frame.lines[graph + 3]).toContain('372.00 ns');
      expect(frame.lines[graph + 3]).toContain('778.00 ns');
      expect(frame.maxDetailOffset).toBe(0);
      expect(frame.lines.every((line) => stringWidth(line) < columns)).toBe(true);
    }
  );

  it('uses regular and large cyan dots for single runs and overlaps', () => {
    const result = fixture();
    result.files[0].benchmarks[0].runs[0].stats!.blocks!.medians = [
      420, 480, 480, 550, 550, 550, 700, 700,
    ];
    const frame = renderRunView(result, defineConfig({ benchDir: '.' }), {
      columns: 100,
      rows: 30,
      selected: 0,
    });
    const dots = frame.lines[frame.lines.findIndex((line) => line.includes('consistency')) + 2];
    expect(dots).toContain(`${CYAN}●`);
    expect(dots).toContain(`${CYAN}⬤`);
    expect(dots.split('⬤')).toHaveLength(4);
    expect(dots.split('●')).toHaveLength(2);
    expect(dots).not.toContain(YELLOW);
    expect(dots).not.toContain('\x1b[2m');
    expect(dots).not.toContain('\x1b[1m');
    expect(dots).not.toContain('38;2;');
  });

  it.each([40, 55, 75, 100])('fits %i columns and exposes details by scrolling', (columns) => {
    const result = fixture();
    result.files[0].benchmarks[0].runs[0].name = '世界 🏆 é '.repeat(12);
    const stats = result.files[0].benchmarks[0].runs[0].stats!;
    stats.metrics = { retainedObjects: { min: 10, max: 20, p50: 15 } };
    const first = render(result, columns);
    const last = render(result, columns, 999);
    for (const frame of [first, last]) {
      expect(frame.lines).toHaveLength(30);
      expect(frame.lines.every((line) => stringWidth(line) < columns)).toBe(true);
      expect(frame.lines.at(-1)).toContain('q exit');
      expect(frame.lines.join('\n')).not.toContain('\x1b');
    }
    expect(last.lines.join('\n')).toContain('retainedObjects');
    expect(last.lines.join('\n')).toContain('consistency ✦ 8 runs');
  });

  it('handles failed checks, older results, disabled GC, and identical samples honestly', () => {
    const result = fixture();
    const trial = result.files[0].benchmarks[0];
    const run = trial.runs[0];
    run.error = { name: 'AssertionError', message: 'expected 2, received 1\x1b[2J' };
    let text = render(result).lines.join('\n');
    expect(text).toContain('expected 2, received 1');
    expect(text).toContain('1 failed');
    expect(text).not.toContain('consistency');
    expect(text).not.toContain('575.00 ns');
    delete run.error;
    delete run.stats!.blocks;
    delete run.stats!.gc;
    delete run.stats!.heap;
    trial.gcMode = false;
    Object.assign(run.stats!, {
      samples: [100, 100],
      min: 100,
      max: 100,
      avg: 100,
      p75: 100,
      p99: 100,
    });
    text = render(result).lines.join('\n');
    expect(text).toContain('disabled');
    expect(text).toContain('Run medians unavailable');
    expect(text).toContain('█');
    expect(text).not.toContain('NaN');
  });

  it('navigates the run report, resizes, and restores terminal state on exit', async () => {
    const result = fixture();
    const trial = result.files[0].benchmarks[0];
    trial.runs.push({ ...trial.runs[0], name: 'remove entities' });
    const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode: vi.fn() });
    const output = Object.assign(new PassThrough(), { columns: 100, rows: 30 });
    let written = '';
    output.on('data', (chunk) => {
      written += String(chunk);
    });
    const closed = openReportScreen(
      (state) => renderRunView(result, defineConfig({ benchDir: '.' }), state),
      2,
      input as unknown as ReadStream,
      output as unknown as WriteStream
    );
    input.emit('keypress', '', { name: 'down' });
    expect(stripVTControlCharacters(written)).toContain('2/2');
    output.columns = 40;
    output.emit('resize');
    input.emit('keypress', ']', {});
    input.emit('keypress', 'q', {});
    await closed;
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(written).toContain('\x1b[?1049l');
    expect(input.listenerCount('keypress')).toBe(0);
    expect(output.listenerCount('resize')).toBe(0);
  });

  it('keeps the static report in CI', async () => {
    vi.stubEnv('CI', 'true');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await showRunReport(fixture(), defineConfig({ benchDir: '.' }));
      const text = log.mock.calls.flat().join('\n');
      expect(text).toContain('create entities');
      expect(text).toContain('Noisy samples');
      expect(text).not.toContain('\x1b[?1049h');
    } finally {
      log.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
