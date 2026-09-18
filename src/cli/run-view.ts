import { createRequire } from 'node:module';
import { isLikelyOptimizedOut } from '../bench/diagnostics.ts';
import type { LabsConfig } from '../config.ts';
import { collectDiagnostics } from '../report.ts';
import {
  isEnvironmentStable,
  type SavedBenchmarkRun,
  type SavedBenchmarkTrial,
  type SavedResult,
} from '../store.ts';
import {
  BOLD,
  BLACK,
  CYAN,
  DARK_GRAY,
  GRAY,
  GREEN,
  MAGENTA,
  RED,
  WHITE,
  YELLOW,
} from '../utils/ansi.ts';
import { formatAmount, formatBytes, formatNs } from '../utils/units.ts';
import type { TerminalFrame, TerminalViewState } from './screen.ts';
import { TerminalCanvas, textWidth, wrapText } from './terminal.ts';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

type RunEntry = {
  file: string;
  group: string;
  name: string;
  run: SavedBenchmarkRun;
  gcMode: SavedBenchmarkTrial['gcMode'];
  symbol: string;
  color: string;
  message: string;
};

function entries(result: SavedResult, config: LabsConfig): RunEntry[] {
  return result.files.flatMap((file) =>
    file.benchmarks.flatMap((trial) =>
      trial.runs.map((run) => {
        const diagnostics = collectDiagnostics([{ ...trial, runs: [run] }], config.minDelta);
        const failed = run.error !== undefined;
        const messages: string[] = [];
        if (failed) {
          const error = run.error as { message?: unknown } | null;
          messages.push(String(error?.message ?? run.error));
        } else if (!run.stats) messages.push('No measurements available');
        else {
          if (isLikelyOptimizedOut(run.stats, trial.gcMode, (file.context ?? result.context)?.noop))
            messages.push('likely optimized out');
          if (diagnostics.noisy.length) messages.push('noisy samples');
          if (diagnostics.inconsistent.length) messages.push('run medians vary');
          else if (diagnostics.noisy.length && (run.stats.blocks?.medians.length ?? 0) >= 2)
            messages.push('runs agree');
        }
        return {
          file: file.file,
          group: trial.groupName ?? '',
          name: run.name || trial.alias || 'anonymous',
          run,
          gcMode: trial.gcMode,
          symbol: failed ? '✗' : !run.stats ? '·' : messages.length ? '⚠' : '✓',
          color: failed ? RED : messages.length ? YELLOW : GREEN,
          message: messages.join(' ✦ '),
        };
      })
    )
  );
}

function bytes(value: number): string {
  return formatBytes(value, false).replace(/\b([kmgtp]?)b\b/g, (_, unit: string) =>
    unit ? unit.toUpperCase() + 'iB' : 'B'
  );
}

function duration(value: number): string {
  return value === 0 ? '0.00 ns' : formatNs(value);
}

/** Draw the sample distribution without changing the statistics used by the report. */
function distribution(
  canvas: TerminalCanvas,
  entry: RunEntry,
  x: number,
  y: number,
  width: number
): void {
  const stats = entry.run.stats!;
  const bins = Array<number>(width).fill(0);
  const column = (value: number) =>
    stats.max === stats.min
      ? Math.floor(width / 2)
      : Math.max(
          0,
          Math.min(
            width - 1,
            Math.round(((value - stats.min) / (stats.max - stats.min)) * (width - 1))
          )
        );
  for (const value of stats.samples) if (Number.isFinite(value)) bins[column(value)]++;
  const peak = Math.max(1, ...bins);
  const average = column(stats.avg);
  bins.forEach((count, index) => {
    const height = count ? Math.max(1, Math.round((count / peak) * 16)) : 0;
    for (let row = 0; row < 2; row++)
      canvas.put(
        y + row,
        x + index,
        ' ▁▂▃▄▅▆▇█'[Math.max(0, Math.min(8, height - (1 - row) * 8))],
        index < average ? CYAN : index === average ? YELLOW : MAGENTA
      );
  });
  const half = Math.floor(width / 2);
  canvas.put(y + 2, x, duration(stats.min), CYAN, half);
  canvas.put(y + 2, x + half, duration(stats.max), MAGENTA, width - half, true);
}

function consistency(
  canvas: TerminalCanvas,
  entry: RunEntry,
  x: number,
  y: number,
  width: number
): void {
  const values = entry.run.stats?.blocks?.medians.filter(Number.isFinite) ?? [];
  canvas.put(y, x, `consistency ✦ ${values.length} runs`, GRAY, width);
  if (!values.length) {
    canvas.put(y + 2, x, 'Run medians unavailable', GRAY, width);
    return;
  }
  const min = Math.min(entry.run.stats!.min, ...values);
  const max = Math.max(entry.run.stats!.max, ...values);
  const padding = (max - min || Math.abs(max) * 0.1 || 1) * 0.08;
  const low = Math.max(0, min - padding);
  const high = max + padding;
  const bins = Array<number>(width - 2).fill(0);
  for (const value of values) bins[Math.round(((value - low) / (high - low)) * (bins.length - 1))]++;
  canvas.put(y + 2, x, '╞', DARK_GRAY);
  canvas.put(y + 2, x + width - 1, '╡', DARK_GRAY);
  bins.forEach((count, index) => {
    if (count) canvas.put(y + 2, x + index + 1, count === 1 ? '●' : '⬤', CYAN);
  });
  const half = Math.floor(width / 2);
  canvas.put(y + 3, x, duration(low), GRAY, half);
  canvas.put(y + 3, x + half, duration(high), GRAY, width - half, true);
}

function details(
  entry: RunEntry | undefined,
  width: number,
  state: TerminalViewState,
  clockWarning: string
): string[] {
  const colors = state.colors !== false;
  const canvas = new TerminalCanvas(width);
  if (!entry) {
    canvas.put(0, 0, 'No benchmarks', GRAY);
    return canvas.lines(colors);
  }
  canvas.put(0, 0, `${entry.symbol} ${entry.name}`, BOLD);
  canvas.put(0, 0, entry.symbol, entry.color, 1);
  let y = 1;
  for (const message of wrapText(clockWarning, width)) canvas.put(y++, 0, message, YELLOW);
  for (const message of wrapText(entry.message, width)) canvas.put(y++, 0, message, entry.color);
  const stats = entry.run.stats;
  if (!stats || entry.run.error !== undefined) return canvas.lines(colors);
  y++;
  const range = (
    value: { min: number; max: number } | undefined,
    format: (value: number) => string
  ) => {
    if (!value) return '—';
    const min = format(value.min);
    const max = format(value.max);
    return min.slice(min.lastIndexOf(' ')) === max.slice(max.lastIndexOf(' '))
      ? `${min.slice(0, min.lastIndexOf(' '))}–${max}`
      : `${min}–${max}`;
  };
  const gcValue = stats.gc ? duration(stats.gc.p50) : entry.gcMode === false ? 'disabled' : '—';
  const heapValue = stats.heap ? bytes(stats.heap.p50) : '—';
  const gcLabel = range(stats.gc, duration);
  const heapLabel = range(stats.heap, bytes);
  const compactGcWidth = Math.max(2, textWidth(gcValue), textWidth(gcLabel));
  const compactHeapWidth = Math.max(4, textWidth(heapValue), textWidth(heapLabel));
  const compact = width < 96 && width >= 49 + compactGcWidth + compactHeapWidth;
  const narrow = width < 96 && !compact;
  ['avg', 'p75', 'p99'].forEach((label, index) => {
    canvas.put(y + index, 0, label, GRAY, 3);
    canvas.put(
      y + index,
      5,
      duration([stats.avg, stats.p75, stats.p99][index]),
      index === 0 ? YELLOW + BOLD : GRAY,
      11
    );
  });
  if (narrow) {
    const graphWidth = Math.max(
      16,
      textWidth(duration(stats.min)) + textWidth(duration(stats.max)) + 2
    );
    const graphX = width >= 18 + graphWidth ? 18 : 0;
    const graphY = graphX ? y : y + 4;
    distribution(canvas, entry, graphX, graphY, graphWidth);
    const memoryWidth = 5 + Math.max(textWidth(gcValue), textWidth(heapValue));
    const memoryX =
      graphX && width >= graphX + graphWidth + 2 + memoryWidth ? width - memoryWidth : 0;
    const memoryY = memoryX ? y : graphY + 3;
    [
      ['gc', gcValue],
      ['heap', heapValue],
    ].forEach(([label, value], index) => {
      canvas.put(memoryY + index, memoryX, label, GRAY, 4);
      canvas.put(memoryY + index, memoryX + 5, value, '', memoryWidth - 5, true);
    });
    y = Math.max(graphY + 3, memoryY + 2);
  } else {
    const gcWidth = compact ? compactGcWidth : 14;
    const gcX = compact ? width - compactHeapWidth - 2 - gcWidth : width - 41;
    const heapX = gcX + gcWidth + 2;
    const heapWidth = width - heapX;
    const graphX = 18;
    const graphWidth = compact ? Math.min(24, gcX - graphX - 2) : 24;
    distribution(canvas, entry, graphX, y, graphWidth);
    canvas.put(y, gcX, 'gc', GRAY, gcWidth, true);
    canvas.put(y + 1, gcX, gcValue, '', gcWidth, true);
    const gcRange = wrapText(gcLabel, gcWidth);
    const heapRange = wrapText(heapLabel, heapWidth);
    gcRange.forEach((line, index) => canvas.put(y + 2 + index, gcX, line, GRAY, gcWidth, true));
    canvas.put(y, heapX, 'heap', GRAY, heapWidth, true);
    canvas.put(y + 1, heapX, heapValue, '', heapWidth, true);
    heapRange.forEach((line, index) => canvas.put(y + 2 + index, heapX, line, GRAY, heapWidth, true));
    y += 2 + Math.max(gcRange.length, heapRange.length);
  }
  canvas.put(y++, 0, '─'.repeat(width), DARK_GRAY);
  consistency(canvas, entry, 0, y, width >= 53 ? Math.floor((width - 3) / 2) : width);
  y += 4;
  for (const [name, metric] of Object.entries(stats.metrics ?? {})) {
    y++;
    for (const line of wrapText(
      `${name}  ${formatAmount(metric.p50)} (${formatAmount(metric.min)} … ${formatAmount(metric.max)})`,
      width
    )) {
      canvas.put(y++, 0, line);
    }
  }
  return canvas.lines(colors);
}

/** Render a completed run from the same saved data used by comparisons and replay. */
export function renderRunView(
  result: SavedResult,
  config: LabsConfig,
  state: TerminalViewState,
  saved = true
): TerminalFrame {
  const benches = entries(result, config);
  const width = Math.max(1, Math.floor(state.columns) - 1);
  const height = Math.max(1, Math.floor(state.rows));
  const canvas = new TerminalCanvas(width);
  const selected = Math.max(0, Math.min(benches.length - 1, state.selected));
  const colors = state.colors !== false;
  if (width < 39 || height < 12) {
    canvas.put(0, 0, 'resize to 40×12 · q exit', GRAY);
    return {
      lines: [...canvas.lines(colors), ...Array<string>(height - 1).fill('')],
      selected,
      listOffset: 0,
      detailOffset: 0,
      maxDetailOffset: 0,
      pageSize: 1,
    };
  }
  const innerWidth = width - 2;
  let clockWarning = '';
  if (!isEnvironmentStable(result)) {
    const freqs = result.environment!.freqs.flatMap(({ runFreq, postFreq }) => [runFreq, postFreq]);
    const min = Math.min(...freqs);
    const max = Math.max(...freqs);
    const drift = (max - min) / ((max + min) / 2);
    clockWarning = `⚠ Unstable clock: ${min.toFixed(2)}–${max.toFixed(2)} GHz (${(drift * 100).toFixed(1)}% drift)`;
  }
  const detailLines = details(benches[selected], innerWidth, state, clockWarning);
  const detailHeight = Math.min(detailLines.length + 1, innerWidth >= 71 ? 13 : 21, height - 8);
  const detailTop = height - detailHeight - 1;
  const pageSize = detailTop - 3;
  const maxDetailOffset = Math.max(0, detailLines.length - detailHeight + 1);
  const detailOffset = Math.max(0, Math.min(maxDetailOffset, state.detailOffset ?? 0));
  canvas.fill(0, '\x1b[42m' + BLACK, 1, 5);
  canvas.put(0, 1, ' RUN ', '', 5);
  canvas.put(0, 8, 'labs');
  if (innerWidth >= 71) canvas.put(0, 14, `v${version}`, GRAY);
  const nameX = innerWidth >= 71 ? 22 : 14;
  canvas.put(0, nameX, result.name, CYAN, width - nameX - 10);
  canvas.put(0, width - 9, saved ? 'saved' : 'complete', GREEN, 8, true);
  const nameWidth = innerWidth >= 71 ? innerWidth - 40 : innerWidth - 26;
  const listRow = (y: number, label: string, bench?: RunEntry) => {
    const stats = bench?.run.error === undefined ? bench?.run.stats : undefined;
    canvas.put(y, 1, label, bench ? '' : GRAY, nameWidth);
    canvas.put(y, nameWidth + 3, bench ? (stats ? duration(stats.avg) : '—') : 'avg', GRAY, 11, true);
    canvas.put(
      y,
      nameWidth + 16,
      bench ? (stats ? duration(stats.p99) : '—') : 'p99',
      GRAY,
      11,
      true
    );
    if (innerWidth >= 71) {
      canvas.put(
        y,
        nameWidth + 29,
        bench ? (stats?.heap ? bytes(stats.heap.p50) : '—') : 'heap',
        GRAY,
        12,
        true
      );
    }
  };
  listRow(1, 'benchmark');
  const rows: Array<{ text: string; index?: number }> = [];
  let previousFile = '';
  let previousGroup = '';
  benches.forEach((bench, index) => {
    if (bench.file !== previousFile) {
      rows.push({ text: `› ${bench.file}` });
      previousFile = bench.file;
      previousGroup = '';
    }
    if (bench.group && bench.group !== previousGroup) rows.push({ text: `  ${bench.group}` });
    previousGroup = bench.group;
    rows.push({ text: bench.name, index });
  });
  const activeRow = Math.max(
    0,
    rows.findIndex((row) => row.index === selected)
  );
  let listOffset = Math.max(0, Math.min(state.listOffset ?? 0, rows.length - pageSize));
  if (activeRow < listOffset) listOffset = activeRow;
  if (activeRow >= listOffset + pageSize) listOffset = activeRow - pageSize + 1;
  rows.slice(listOffset, listOffset + pageSize).forEach((row, index) => {
    const y = index + 2;
    if (row.index === undefined) canvas.put(y, 1, row.text, BOLD, innerWidth);
    else {
      const bench = benches[row.index];
      const active = selected === row.index;
      if (active) canvas.fill(y, '\x1b[48;5;236m' + WHITE);
      listRow(y, `${active ? '›' : ' '} ${bench.symbol} ${row.text}`, bench);
      canvas.put(y, 3, bench.symbol, bench.color, 1);
    }
  });
  canvas.put(detailTop - 1, 1, '━'.repeat(innerWidth), DARK_GRAY);
  const warnings = benches.filter((bench) => bench.symbol === '⚠').length + (clockWarning ? 1 : 0);
  const failed = benches.filter((bench) => bench.run.error !== undefined).length;
  const complete = benches.filter((bench) => bench.run.stats && bench.run.error === undefined).length;
  const counts = [
    [`${complete} complete`, GREEN],
    ...(warnings ? [[`${warnings} warning${warnings === 1 ? '' : 's'}`, YELLOW]] : []),
    ...(failed ? [[`${failed} failed`, RED]] : []),
  ];
  let controls = `↑↓ select  ${maxDetailOffset ? '[ ] details' : 'pgup pgdn page'}  esc / q exit  ${benches.length ? selected + 1 : 0}/${benches.length}`;
  if (textWidth(controls) + counts.reduce((sum, [text]) => sum + textWidth(text) + 2, 0) > innerWidth)
    controls = `↑↓${maxDetailOffset ? ' [ ]' : ''}  q exit  ${benches.length ? selected + 1 : 0}/${benches.length}`;
  const controlsX = width - textWidth(controls);
  let x = 1;
  for (const [label, color] of counts) {
    canvas.put(height - 1, x, label, color, controlsX - x - 2);
    x += textWidth(label) + 2;
  }
  canvas.put(height - 1, controlsX, controls, GRAY);
  const lines = canvas.lines(colors);
  for (let i = 0; i < detailHeight - 1; i++)
    lines[detailTop + i] = ' ' + (detailLines[detailOffset + i] ?? ' '.repeat(innerWidth));
  return { lines, selected, listOffset, detailOffset, maxDetailOffset, pageSize };
}
