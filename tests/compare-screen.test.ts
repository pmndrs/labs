import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'fast-string-width';
import { describe, expect, it, vi } from 'vitest';
import { compare, type CompareResult, type EligibleBench } from '../src/compare.ts';
import { defineConfig } from '../src/config.ts';
import { CYAN, MAGENTA } from '../src/utils/ansi.ts';
import type { SavedResult } from '../src/store.ts';
import { openCompareScreen, showCompareReport } from '../src/cli/compare-screen.ts';
import { renderCompareView } from '../src/cli/compare-view.ts';

function fixture(): { result: CompareResult; config: ReturnType<typeof defineConfig> } {
  const config = defineConfig({ benchDir: '.' });
  const saved = (name: string, scale: number): SavedResult => {
    const medians = [100, 101, 99, 100, 102, 98, 100, 101].map((value) => value * scale);
    return {
      name,
      timestamp: '2026-01-01T00:00:00.000Z',
      hardware: { cpu: 'test cpu', arch: 'arm64', runtime: 'node', freq: 4 },
      blocks: 8,
      files: [
        {
          file: 'entities.bench.ts',
          benchmarks: [
            {
              alias: 'rebuild entities',
              group: 0,
              baseline: false,
              gcMode: true,
              kind: 'static',
              style: { compact: false, highlight: false },
              runs: [
                {
                  name: 'rebuild entities',
                  args: {},
                  stats: {
                    kind: 'fn',
                    samples: medians,
                    min: Math.min(...medians),
                    max: Math.max(...medians),
                    avg: 100 * scale,
                    p25: 99 * scale,
                    p75: 101 * scale,
                    p99: 102 * scale,
                    blocks: { medians, freqs: medians.map(() => 4) },
                    gc: { min: 10 * scale, max: 10 * scale, p50: 10 * scale },
                    heap: { min: 1024 * scale, max: 1024 * scale, p50: 1024 * scale },
                  },
                },
              ],
            },
          ],
        },
      ],
    };
  };
  return { result: compare(saved('baseline', 1), saved('candidate', 0.8), config), config };
}

function terminal(columns = 100, rows = 30) {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn(function (this: { isRaw: boolean }, mode: boolean) {
      this.isRaw = mode;
      return this;
    }),
  });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns, rows });
  let written = '';
  output.on('data', (chunk) => {
    written += String(chunk);
  });
  return {
    input,
    output,
    text: () => written,
    clear: () => {
      written = '';
    },
  };
}

describe('comparison screen', () => {
  it('shows both real metric values, fresh-run medians, and statistical evidence', () => {
    const { result, config } = fixture();
    const bench = result.benches[0] as EligibleBench;
    expect(bench.baselineRunMedians).toEqual([100, 101, 99, 100, 102, 98, 100, 101]);
    expect(bench.candidateP99).toBeCloseTo(81.6);
    const view = renderCompareView(result, config, {
      columns: 110,
      rows: 30,
      selected: 0,
      colors: false,
    });
    const text = view.lines.join('\n');
    expect(text).toContain('100.00 ns');
    expect(text).toContain('80.00 ns');
    expect(text).toContain('10.00 ns');
    expect(text).toContain('8.00 ns');
    expect(text).toContain('1.00 KiB');
    expect(text).toContain('819.20 B');
    expect(text).toContain('consistency ✦ 8 runs');
    expect(text).toContain('spread ✦ 95% ci');
    expect(text).toContain('p < 0.001');
    expect(text).not.toContain('p-value');
    expect(text).toContain('╞');
    expect(view.lines).toHaveLength(30);
  });

  it('uses dot size for overlap while keeping each series in its own color', () => {
    const { result, config } = fixture();
    const bench = result.benches[0] as EligibleBench;
    bench.baselineRunMedians = [100, 100, 105, 110, 110, 110, 115, 120];
    bench.candidateRunMedians = [80, 80, 85, 90, 90, 90, 95, 97];
    const frame = renderCompareView(result, config, { columns: 110, rows: 30, selected: 0 });
    const y = frame.lines.findIndex((line) => line.includes('consistency'));
    [CYAN, MAGENTA].forEach((color, side) => {
      const dots = frame.lines[y + 1 + side];
      expect(dots).toContain(color);
      expect(dots).toContain('●');
      expect(dots).toContain('⬤');
      expect(dots).not.toContain('\x1b[2m');
    });
  });

  it.each([40, 60, 75, 80, 110])(
    'keeps a fixed inspector and bounded rows at %i columns',
    (columns) => {
      const { result, config } = fixture();
      const bench = result.benches[0] as EligibleBench;
      result.benches.push({
        ...bench,
        key: { ...bench.key, name: '世界 🏆 é '.repeat(20) },
        baselineRunMedians: Array<number>(24).fill(100),
        candidateRunMedians: Array<number>(24).fill(80),
      });
      const frames = [0, 1].map((selected) =>
        renderCompareView(result, config, { columns, rows: 36, selected, colors: false })
      );
      expect(frames[0].lines.findIndex((line) => line.includes('consistency'))).toBe(
        frames[1].lines.findIndex((line) => line.includes('consistency'))
      );
      for (const frame of frames) {
        expect(frame.lines).toHaveLength(36);
        expect(frame.lines.every((line) => stringWidth(line) < columns)).toBe(true);
        expect(frame.lines.at(-1)).toContain('q exit');
        const graphRow = frame.lines.findIndex((line) => line.includes('consistency'));
        expect(frame.lines[graphRow + 1]).toMatch(/[●⬤]/);
        expect(frame.lines[graphRow + 2]).toMatch(/[●⬤]/);
        expect(frame.lines[graphRow + 3]).not.toMatch(/[●⬤]/);
      }
    }
  );

  it('keeps missing, changed, failed, and skipped results navigable without stale statistics', () => {
    const { result, config } = fixture();
    const key = result.benches[0].key;
    result.benches.push(
      { kind: 'changed', key, baselineP50: 100, candidateP50: 80 },
      { kind: 'failed', key, check: true, message: 'wrong output' },
      { kind: 'skipped', key, reason: 'insufficient block replication' },
      { kind: 'missing', key, presentIn: 'candidate' },
      { kind: 'missing', key, presentIn: 'baseline' }
    );
    for (let selected = 1; selected < result.benches.length; selected++) {
      const text = renderCompareView(result, config, {
        columns: 100,
        rows: 30,
        selected,
        colors: false,
      }).lines.join('\n');
      expect(text).not.toContain('consistency');
      expect(text).not.toContain('spread ✦');
      expect(text).not.toContain('p <');
      expect(text).toContain(`${selected + 1}/6`);
    }
  });

  it('exposes custom metrics and full warnings through inspector scrolling', () => {
    const { result, config } = fixture();
    const bench = result.benches[0] as EligibleBench;
    bench.metrics = { retainedBytes: { baseline: 100, candidate: 200, delta: 1 } };
    result.environmentWarnings = ['different block counts, verify the session'];
    const first = renderCompareView(result, config, {
      columns: 100,
      rows: 24,
      selected: 0,
      colors: false,
    });
    expect(first.maxDetailOffset).toBeGreaterThan(0);
    const last = renderCompareView(result, config, {
      columns: 100,
      rows: 24,
      selected: 0,
      detailOffset: 999,
      colors: false,
    });
    expect(last.lines.join('\n')).toContain('retainedBytes');
    expect(last.lines.join('\n')).toContain('different block counts');
    expect(last.lines.join('\n')).toContain('[ ] details');
  });

  it('sanitizes saved terminal escapes and keeps a tiny screen usable', () => {
    const { result, config } = fixture();
    result.baselineName = '\x1b[2Jbad\nname';
    result.benches[0].key.name = '\x1b]0;injected\x07unsafe\rtitle';
    const view = renderCompareView(result, config, {
      columns: 80,
      rows: 24,
      selected: 0,
      colors: false,
    });
    expect(view.lines.join('\n')).not.toContain('\x1b');
    expect(view.lines.some((line) => line.includes('\r'))).toBe(false);
    expect(
      renderCompareView(result, config, { columns: 30, rows: 5, selected: 0, colors: false }).lines
    ).toHaveLength(5);
  });

  it('supports navigation, resize, and exit while restoring terminal ownership', async () => {
    const { result, config } = fixture();
    const bench = result.benches[0];
    result.benches = Array.from({ length: 30 }, (_, i) => ({
      ...bench,
      key: { ...bench.key, name: `entity ${i + 1}` },
    }));
    const term = terminal();
    const listeners = process.listenerCount('SIGTERM');
    const done = openCompareScreen(
      result,
      config,
      term.input as unknown as ReadStream,
      term.output as unknown as WriteStream
    );
    expect(term.input.isRaw).toBe(true);
    expect(term.text()).toContain('\x1b[?1049h');
    term.clear();
    term.input.write('\x1b[F');
    expect(stripVTControlCharacters(term.text())).toContain('30/30');
    term.clear();
    term.input.write('\x1b[H');
    term.input.write('\x1b[B');
    expect(stripVTControlCharacters(term.text())).toContain('2/30');
    term.output.columns = 60;
    term.output.rows = 22;
    term.clear();
    term.output.emit('resize');
    expect(
      stripVTControlCharacters(term.text())
        .split('\r\n')
        .every((line) => stringWidth(line) <= 59)
    ).toBe(true);
    term.input.write('q');
    await done;
    expect(term.text()).toContain('\x1b[?25h\x1b[?1049l');
    expect(term.input.isRaw).toBe(false);
    expect(term.input.isPaused()).toBe(true);
    expect(term.output.listenerCount('resize')).toBe(0);
    expect(term.input.listenerCount('keypress')).toBe(0);
    expect(process.listenerCount('SIGTERM')).toBe(listeners);
  });

  it('cleans up if a redraw throws', async () => {
    const { result, config } = fixture();
    const term = terminal();
    const done = openCompareScreen(
      result,
      config,
      term.input as unknown as ReadStream,
      term.output as unknown as WriteStream
    );
    const write = vi.spyOn(term.output, 'write').mockImplementationOnce(() => {
      throw new Error('write failed');
    });
    term.output.emit('resize');
    await expect(done).rejects.toThrow('write failed');
    expect(term.input.isRaw).toBe(false);
    expect(term.output.listenerCount('resize')).toBe(0);
    expect(term.text()).toContain('\x1b[?1049l');
    write.mockRestore();
  });

  it('restores the terminal on Ctrl+C without replacing its interrupt status', async () => {
    const { result, config } = fixture();
    const term = terminal();
    const previousCode = process.exitCode;
    try {
      const done = openCompareScreen(
        result,
        config,
        term.input as unknown as ReadStream,
        term.output as unknown as WriteStream
      );
      term.input.write('\x03');
      await done;
      expect(process.exitCode).toBe(130);
      expect(term.input.isRaw).toBe(false);
      expect(term.text()).toContain('\x1b[?1049l');
    } finally {
      process.exitCode = previousCode;
    }
  });

  it('keeps the printable report when output is redirected', async () => {
    const { result, config } = fixture();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tty = process.stdout.isTTY;
    process.stdout.isTTY = false;
    try {
      await showCompareReport(result, config);
      const text = spy.mock.calls.flat().join('\n');
      expect(text).toContain('summary');
      expect(text).not.toContain('\x1b[?1049h');
    } finally {
      process.stdout.isTTY = tty;
      spy.mockRestore();
    }
  });
});
