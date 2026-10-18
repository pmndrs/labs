import { isLikelyOptimizedOut } from '../bench/diagnostics.ts';
import * as histogramFmt from '../bench/format/histogram.ts';
import { formatGcColumns } from '../bench/format/gc.ts';
import type { LabsConfig } from '../config.ts';
import { calibrationExplainedFraction, comparisonResolution } from '../stats.ts';
import {
  isEnvironmentStable,
  type SavedBenchmarkRun,
  type SavedBenchmarkTrial,
  type SavedContext,
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
import { formatBytes, formatNs } from '../utils/units.ts';
import type { TerminalFrame, TerminalViewState } from './screen.ts';
import { TerminalCanvas, textWidth, wrapText } from './terminal.ts';

type RunEntry = {
  file: string;
  group: string;
  name: string;
  run: SavedBenchmarkRun;
  gcMode: SavedBenchmarkTrial['gcMode'];
  symbol: string;
  color: string;
  message: string;
  advice: string;
};

/**
 * Report status for one run, shared by the report and the live progress view.
 * Only the most serious problem is reported, with advice on what to do about it.
 */
export function runStatus(
  trial: SavedBenchmarkTrial,
  run: SavedBenchmarkRun,
  noop: SavedContext['noop'],
  minDelta: number
): { symbol: string; message: string; advice: string } {
  const failed = run.error !== undefined;
  if (failed) {
    const error = run.error as { message?: unknown } | null;
    return { symbol: '✗', message: String(error?.message ?? run.error), advice: '' };
  }
  const stats = run.stats;
  if (!stats) return { symbol: '·', message: 'No measurements available', advice: '' };
  if (isLikelyOptimizedOut(stats, trial.gcMode, noop))
    return { symbol: '⚠', message: 'likely optimized out', advice: 'return the result' };
  if (stats.unsettled || stats.varyingOutput)
    return {
      symbol: '⚠',
      message: 'results change between runs',
      advice: 'make the work deterministic',
    };
  const medians = stats.blocks?.medians ?? [];
  const resolution = comparisonResolution(medians);
  if (medians.length >= 2 && resolution > minDelta) {
    // Probe readings that track the run medians point at the machine, not the bench
    const machine = calibrationExplainedFraction(medians, stats.blocks!.freqs) >= 0.5;
    return {
      symbol: '⚠',
      message: `min detectable change ±${Math.round(resolution * 100)}%`,
      advice: machine ? 'rerun on an idle machine' : 'add blocks',
    };
  }
  return { symbol: '✓', message: '', advice: '' };
}

function entries(result: SavedResult, config: LabsConfig): RunEntry[] {
  return result.files.flatMap((file) =>
    file.benchmarks.flatMap((trial) =>
      trial.runs.map((run) => {
        const { symbol, message, advice } = runStatus(
          trial,
          run,
          (file.context ?? result.context)?.noop,
          config.minDelta
        );
        return {
          file: file.file,
          group: trial.groupName ?? '',
          name: run.name || trial.alias || 'anonymous',
          run,
          gcMode: trial.gcMode,
          symbol,
          color: symbol === '✗' ? RED : symbol === '⚠' ? YELLOW : GREEN,
          message,
          advice,
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
  const binned = histogramFmt.bins(stats, width, 0.99);
  const histogram = histogramFmt.ascii(binned, 2, { colors: false });
  histogram.forEach((line, row) => {
    for (let index = 0; index < line.length; index++)
      canvas.put(
        y + row,
        x + index,
        line[index],
        index < binned.avg ? CYAN : index === binned.avg ? YELLOW : MAGENTA
      );
  });
  const half = Math.floor(width / 2);
  canvas.put(y + 2, x, duration(stats.min), CYAN, half);
  canvas.put(y + 2, x + half, duration(binned.max), MAGENTA, width - half, true);
}

function consistency(
  canvas: TerminalCanvas,
  entry: RunEntry,
  x: number,
  y: number,
  width: number
): void {
  width = Math.min(width, 48);
  const values = entry.run.stats?.blocks?.medians.filter(Number.isFinite) ?? [];
  canvas.put(y, x, `consistency ✦ ${values.length} runs`, GRAY, width);
  if (!values.length) {
    canvas.put(y + 2, x, 'Run medians unavailable', GRAY, width);
    return;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
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

function details(entry: RunEntry | undefined, width: number, state: TerminalViewState): string[] {
  const colors = state.colors !== false;
  const canvas = new TerminalCanvas(width);
  if (!entry) {
    canvas.put(0, 0, 'No benchmarks', GRAY);
    return canvas.lines(colors);
  }
  canvas.put(0, 0, `${entry.symbol} ${entry.name}`, BOLD);
  canvas.put(0, 0, entry.symbol, entry.color, 1);
  let y = 1;
  const advice = entry.advice ? ` ✦ ${entry.advice}` : '';
  if (textWidth(entry.message + advice) <= width) {
    canvas.put(y, 0, entry.message, entry.color);
    canvas.put(y++, textWidth(entry.message), advice, GRAY);
  } else {
    for (const message of wrapText(entry.message, width)) canvas.put(y++, 0, message, entry.color);
    for (const line of wrapText(advice.trim(), width)) canvas.put(y++, 0, line, GRAY);
  }
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
  const gc = stats.gc;
  const columns: Array<{ heading: string; qualifier?: string; value: string; detail: string }> = [
    ...(gc && 'total' in gc
      ? formatGcColumns(gc).map((column) => ({
          ...column,
          value: column.qualifier ? `${column.qualifier} ${column.value}` : column.value,
        }))
      : [
          {
            heading: 'gc',
            value: gc ? duration(gc.p50) : entry.gcMode === false ? 'disabled' : '—',
            detail: range(gc, duration),
          },
        ]),
    {
      heading: 'heap',
      value: stats.heap ? bytes(stats.heap.p50) : '—',
      detail: range(stats.heap, bytes),
    },
  ];
  const columnWidths = columns.map((column) =>
    Math.max(textWidth(column.heading), textWidth(column.value), textWidth(column.detail))
  );
  // Right align a row of columns with an even gap between them
  const place = (row: number[]) => {
    const xs = new Map<number, number>();
    let right = width;
    for (const index of row.toReversed()) {
      xs.set(index, right - columnWidths[index]);
      right -= columnWidths[index] + 3;
    }
    return xs;
  };
  // Each column stacks heading, value, and detail so its rows line up with avg, p75, and p99
  const putColumns = (y: number, xs: Map<number, number>) => {
    for (const [index, x] of xs) {
      const { heading, qualifier, value, detail } = columns[index];
      canvas.put(y, x, heading, GRAY, columnWidths[index], true);
      canvas.put(y + 1, x, value, '', columnWidths[index], true);
      // Qualifiers sit darker than the heading so the value stands out
      if (qualifier)
        canvas.put(
          y + 1,
          x + columnWidths[index] - textWidth(value),
          qualifier,
          DARK_GRAY,
          textWidth(qualifier)
        );
      canvas.put(y + 2, x, detail, GRAY, columnWidths[index], true);
    }
  };
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
  const graphWidth = Math.max(
    16,
    textWidth(duration(stats.min)) + textWidth(duration(stats.max)) + 2
  );
  const all = columns.map((_, index) => index);
  const inline = place(all);
  if (inline.get(0)! >= 18 + graphWidth + 3) {
    distribution(canvas, entry, 18, y, Math.min(21, inline.get(0)! - 3 - 18));
    putColumns(y, inline);
    y += 3;
  } else {
    const graphX = width >= 18 + graphWidth ? 18 : 0;
    const graphY = graphX ? y : y + 4;
    distribution(canvas, entry, graphX, graphY, graphWidth);
    y = graphY + 3;
    // Wrap columns onto as few rows as fit below the graph
    const rows: number[][] = [];
    let used = width;
    for (const index of all) {
      if (used + 3 + columnWidths[index] > width) rows.push([]);
      used = rows.at(-1)!.length ? used + 3 + columnWidths[index] : columnWidths[index];
      rows.at(-1)!.push(index);
    }
    for (const row of rows) {
      putColumns(y, place(row));
      y += 3;
    }
  }
  canvas.put(y++, 0, '─'.repeat(width), DARK_GRAY);
  consistency(canvas, entry, 0, y, width >= 53 ? Math.floor((width - 3) / 2) : width);
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
  const detailLines = details(benches[selected], innerWidth, state);
  const detailHeight = Math.min(detailLines.length + 1, innerWidth >= 71 ? 17 : 24, height - 8);
  const detailTop = height - detailHeight - 1;
  const pageSize = detailTop - 3;
  const maxDetailOffset = Math.max(0, detailLines.length - detailHeight + 1);
  const detailOffset = Math.max(0, Math.min(maxDetailOffset, state.detailOffset ?? 0));
  canvas.fill(0, '\x1b[42m' + BLACK, 1, 5);
  canvas.put(0, 1, ' RUN ', '', 5);
  const unstable = !isEnvironmentStable(result);
  if (unstable) {
    canvas.fill(0, '\x1b[43m' + BLACK, 7, 12);
    canvas.put(0, 7, ' ⚠ UNSTABLE ', '', 12);
  }
  const nameX = unstable ? 21 : 8;
  canvas.put(0, nameX, result.name, CYAN, width - nameX - (saved ? 8 : 1));
  if (saved) canvas.put(0, width - 6, 'saved', GREEN, 5);
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
  const rows: Array<{ text: string; index?: number; style?: string }> = [];
  let previousFile = '';
  let previousGroup = '';
  benches.forEach((bench, index) => {
    if (bench.file !== previousFile) {
      rows.push({ text: `› ${bench.file}` });
      previousFile = bench.file;
      previousGroup = '';
    }
    if (bench.group && bench.group !== previousGroup)
      rows.push({ text: `  ${bench.group}`, style: BOLD + DARK_GRAY });
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
    if (row.index === undefined) canvas.put(y, 1, row.text, row.style ?? BOLD, innerWidth);
    else {
      const bench = benches[row.index];
      const active = selected === row.index;
      if (active) canvas.fill(y, '\x1b[48;5;236m' + WHITE);
      listRow(y, `${active ? '›' : ' '} ${bench.symbol} ${row.text}`, bench);
      canvas.put(y, 3, bench.symbol, bench.color, 1);
    }
  });
  canvas.put(detailTop - 1, 1, '━'.repeat(innerWidth), DARK_GRAY);
  const warnings = benches.filter((bench) => bench.symbol === '⚠').length;
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
