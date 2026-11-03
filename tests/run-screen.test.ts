import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'fast-string-width';
import { describe, expect, it, vi } from 'vitest';
import { defineConfig } from '../src/config.ts';
import { replayReport } from '../src/report.ts';
import type { SavedResult } from '../src/store.ts';
import { runJson } from '../src/cli/json.ts';
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

function render(result = fixture(), columns = 100, detailOffset = 0, rows = 30) {
  return renderRunView(result, defineConfig({ benchDir: '.' }), {
    columns,
    rows,
    selected: 0,
    detailOffset,
    colors: false,
  });
}

describe('run report', () => {
  it('shows time to native tiers separately from settled timings and preserves mixed blocks', () => {
    const result = fixture();
    const stats = result.files[0].benchmarks[0].runs[0].stats!;
    stats.warmup = { time: 20e6 };
    stats.optimization = {
      workload: [{ tier: 'DFG', time: 2e6 }, { tier: 'DFG', time: 4e6 }, null],
      harness: [
        { tier: 'FTL', time: 10e6 },
        { tier: 'FTL', time: 14e6 },
        { tier: 'DFG', time: 5e6 },
      ],
    };
    const text = render(result, 120, 0, 40).lines.join('\n');
    expect(text).toContain('fn entry');
    expect(text).toContain('3.00 ms → DFG (2/3)');
    expect(text).toContain('unavailable (1/3)');
    expect(text).toContain('harness');
    expect(text).toContain('12.00 ms → FTL (2/3)');
    expect(text).toContain('5.00 ms → DFG (1/3)');
    expect(text).toMatch(/settled\s+20.00 ms \(workload timings\)/);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      replayReport(result, defineConfig({ benchDir: '.' }));
      const report = stripVTControlCharacters(log.mock.calls.flat().join('\n'));
      expect(report).toContain('12.00 ms → FTL (2/3)');
      expect(report).toContain('unavailable (1/3)');
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    {
      name: 'top-tier function and batched harness',
      batch: true,
      workload: 'TurboFan',
      harness: 'TurboFan',
      benchmark: 'TurboFan',
      sampling: 'batched · 12.00 ms → TurboFan',
    },
    {
      name: 'lower function tier inside a top-tier harness',
      batch: true,
      workload: 'Maglev',
      harness: 'TurboFan',
      benchmark: null,
      sampling: 'batched · tier unverified',
    },
    {
      name: 'top-tier function inside a lower-tier harness',
      batch: true,
      workload: 'TurboFan',
      harness: 'Maglev',
      benchmark: null,
      sampling: 'batched · tier unverified',
    },
    {
      name: 'unbatched function below the top tier',
      batch: false,
      workload: 'Sparkplug',
      harness: null,
      benchmark: 'Sparkplug',
      sampling: 'unbatched · 12.00 ms → Sparkplug',
    },
    {
      name: 'runtime without tier diagnostics',
      batch: true,
      workload: null,
      harness: null,
      benchmark: null,
      sampling: 'batched · tier unavailable',
    },
  ] as const)(
    'explains the benchmark tier for a $name',
    ({ batch, workload, harness, benchmark, sampling }) => {
      const result = fixture();
      const stats = result.files[0].benchmarks[0].runs[0].stats!;
      stats.plan = { batch, batch_samples: batch ? 1024 : 1, batch_unroll: 4, samples: 8 };
      stats.optimization = {
        mode: 'natural',
        benchmark: [benchmark ? { tier: benchmark, time: 12e6 } : null],
        workload: [workload ? { tier: workload, time: 3e6 } : null],
        ...(batch ? { harness: [harness ? { tier: harness, time: 10e6 } : null] } : {}),
      };
      stats.warmup = { time: 20e6, phase: batch ? 'sampling' : 'workload' };
      const text = render(result, 120, 0, 40).lines.join('\n');
      expect(text).toContain(sampling);
      expect(text).toContain('✓ create entities');
      expect(text).not.toContain('fn entry');
      expect(text).not.toContain('harness');
      expect(text).toContain(batch ? '(sampling timings)' : '(workload timings)');
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        replayReport(result, defineConfig({ benchDir: '.' }));
        const report = stripVTControlCharacters(log.mock.calls.flat().join('\n'));
        expect(report).toContain(sampling);
      } finally {
        log.mockRestore();
      }
    }
  );

  it('warns only for a verified promotion within the same block', () => {
    const result = fixture();
    const stats = result.files[0].benchmarks[0].runs[0].stats!;
    stats.optimization = {
      mode: 'natural',
      benchmark: [{ tier: 'Maglev', time: 2e6 }, { tier: 'TurboFan', time: 3e6 }, null],
      benchmarkEnd: ['TurboFan', 'Maglev', 'TurboFan'],
      workload: [null, null, null],
    };
    const warning = 'tier rose during sampling · Maglev → TurboFan (1/3 blocks)';
    expect(render(result, 120, 0, 40).lines.join('\n')).toContain(warning);
    expect(runJson(result, defineConfig({ benchDir: '.' }), true).benches[0]).toMatchObject({
      status: 'warning',
      problem: 'late-optimization',
      message: warning,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      replayReport(result, defineConfig({ benchDir: '.' }));
      expect(stripVTControlCharacters(log.mock.calls.flat().join('\n'))).toContain('⚠ ' + warning);
    } finally {
      log.mockRestore();
    }
    stats.optimization.benchmarkEnd = ['Maglev', 'Maglev', 'TurboFan'];
    expect(runJson(result, defineConfig({ benchDir: '.' }), true).benches[0].status).toBe('passed');
  });

  it('does not infer unbatched sampling from missing data in older results', () => {
    const result = fixture();
    result.files[0].benchmarks[0].runs[0].stats!.optimization = {
      workload: [{ tier: 'Sparkplug', time: 3e6 }],
    };
    const text = render(result, 120, 0, 40).lines.join('\n');
    expect(text).toContain('fn entry');
    expect(text).toMatch(/harness\s+not recorded/);
    expect(text).not.toContain('unbatched');
  });

  it('shows when natural warmup did not settle within its budget', () => {
    const result = fixture();
    result.files[0].benchmarks[0].runs[0].stats!.optimization = {
      mode: 'natural',
      benchmark: [null],
      workload: [{ tier: 'Maglev', time: 3e6 }],
      harness: [{ tier: 'TurboFan', time: 10e6 }],
    };
    const text = render(result, 120, 0, 40).lines.join('\n');
    expect(text).toContain('tier unverified');
    expect(text).toContain('not observed within warmup budget');
    result.files[0].benchmarks[0].runs[0].stats!.warmup = {
      time: 20e6,
      phase: 'sampling',
      blocks: { settled: 1, total: 3 },
    };
    expect(render(result, 120, 0, 40).lines.join('\n')).toContain('(1/3 blocks)');
  });

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

  it('flags an unstable machine in the header', () => {
    const result = fixture();
    result.environment = { freqs: [{ file: 'entities.bench.ts', runFreq: 4, postFreq: 2 }] };
    expect(render(result).lines[0]).toContain('UNSTABLE');
    result.environment.freqs[0].postFreq = 3.99;
    expect(render(result).lines[0]).not.toContain('UNSTABLE');
  });

  it.each([
    { name: 'precise', change: {}, line: '' },
    {
      name: 'noisy on its own',
      change: { medians: [400, 700, 500, 800, 450, 750, 600, 650] },
      line: /min detectable change ±\d+% ✦ add blocks/,
    },
    {
      name: 'noisy with the machine',
      change: {
        medians: [400, 700, 500, 800, 450, 750, 600, 650],
        freqs: [5, 2.9, 4, 2.5, 4.4, 2.7, 3.3, 3.1],
      },
      line: /min detectable change ±\d+% ✦ rerun on an idle machine/,
    },
    {
      name: 'unsettled',
      change: { unsettled: true },
      line: 'results change between runs ✦ make the work deterministic',
    },
  ])('gives one line of feedback for a $name bench', ({ change, line }) => {
    const result = fixture();
    const stats = result.files[0].benchmarks[0].runs[0].stats!;
    const { unsettled, ...blocks } = change as { unsettled?: boolean };
    Object.assign(stats, { unsettled, blocks: { ...stats.blocks!, spreads: [0], ...blocks } });
    const text = render(result).lines.join('\n');

    expect(text).toContain(line ? '⚠ create entities' : '✓ create entities');
    if (line) expect(text).toMatch(line);
  });

  it('shows measured values and labels the plotted percentile range', () => {
    const result = fixture();
    const stats = result.files[0].benchmarks[0].runs[0].stats!;
    let text = render(result).lines.join('\n');
    for (const value of ['575.00 ns', '650.00 ns', '750.00 ns', '15.00 ns', '10.00–20.00 ns'])
      expect(text).toContain(value);
    for (const value of ['1.50 KiB', '1.00–2.00 KiB', 'consistency ✦ 8 runs'])
      expect(text).toContain(value);

    // The histogram trims outliers above p99, so its range must not show the raw max
    stats.samples = [
      ...Array<number>(10).fill(0),
      ...Array<number>(1000).fill(100),
      ...Array<number>(100).fill(200),
      1000,
      1100,
      2000,
      2300,
    ];
    stats.min = 0;
    stats.max = 2300;
    stats.p99 = 200;
    text = render(result).lines.join('\n');
    expect(text).toContain('0.00 ns');
    expect(text).toContain('200.00 ns');
    expect(text).not.toContain('2.30 µs');
  });

  it.each([
    { name: 'minor spike' },
    { name: 'major spike', maxKind: 'major' as const },
    { name: 'no events', zero: true },
    { name: 'short timed windows', timed: 100e6 },
  ])('reports observed GC values for $name', ({ zero, maxKind, timed }) => {
    const result = fixture();
    result.files[0].benchmarks[0].runs[0].stats!.gc = {
      total: zero ? 0 : 16.8e6,
      max: zero ? 0 : 900e3,
      maxKind: maxKind ?? 'minor',
      count: zero ? 0 : 280,
      minor: zero ? 0 : 272,
      major: zero ? 0 : 8,
      incremental: 0,
      weak: 0,
      other: 0,
      elapsed: 4.1e9,
      timed: timed ?? 4e9,
      iterations: 1e7,
    };
    // Share is measured against sampling wall time, so timed windows do not change it
    const cost = zero ? '0% 0 ns' : '0.41% 1.68 ns';
    const spike = zero ? '0 ns' : `${maxKind === 'major' ? 'major ' : ''}900.00 µs`;
    const frequency = zero ? '—' : '1 gc / 35,714 iter';
    const major = `${zero ? 0 : 8} major`;
    const text = render(result, 100, 0, 40).lines.join('\n');
    for (const value of [cost, spike, frequency, major]) expect(text).toContain(value);
    if (maxKind !== 'major') expect(text).not.toMatch(/\bminor \d/);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      replayReport(result, defineConfig({ benchDir: '.' }));
      const printed = stripVTControlCharacters(log.mock.calls.flat().join('\n'));
      expect(printed).toContain(`gc(${frequency}) ${cost}`);
      expect(printed).toContain(`gc max(${major}) ${spike}`);
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    [41, 1440, '1 gc / 35 iter'],
    [6, 3, '2 gc / iter'],
  ] as const)('normalizes %i events across %i iterations clearly', (count, iterations, frequency) => {
    const result = fixture();
    result.files[0].benchmarks[0].runs[0].stats!.gc = {
      total: count * 1000,
      max: 1000,
      maxKind: 'minor',
      count,
      minor: count,
      major: 0,
      incremental: 0,
      weak: 0,
      other: 0,
      elapsed: 10e6,
      timed: 9e6,
      iterations,
    };
    const frame = render(result);
    expect(frame.lines.some((line) => line.includes(frequency))).toBe(true);
    expect(frame.lines.join('\n')).not.toContain('/M iter');
  });

  it.each([40, 55, 75, 100])('fits %i columns and exposes details by scrolling', (columns) => {
    const result = fixture();
    result.files[0].benchmarks[0].runs[0].name = '世界 🏆 é '.repeat(12);
    const first = render(result, columns, 0, 16);
    const last = render(result, columns, 999, 16);
    for (const frame of [first, last]) {
      expect(frame.lines).toHaveLength(16);
      expect(frame.lines.every((line) => stringWidth(line) < columns)).toBe(true);
      expect(frame.lines.at(-1)).toContain('q exit');
      expect(frame.lines.join('\n')).not.toContain('\x1b');
    }
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
