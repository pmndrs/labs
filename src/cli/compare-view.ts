import { createRequire } from 'node:module';
import type { BenchResult, CompareResult, EligibleBench } from '../compare.ts';
import type { LabsConfig } from '../config.ts';
import { renderDistributions } from '../histogram.ts';
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
import { formatDelta } from '../utils/format.ts';
import { formatAmount, formatBytes, formatNs } from '../utils/units.ts';
import type {
  TerminalViewState as CompareViewState,
  TerminalFrame as CompareFrame,
} from './screen.ts';
import { TerminalCanvas, terminalText, textWidth, wrapText } from './terminal.ts';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

function style(bench: BenchResult): { symbol: string; color: string; label: string } {
  if (bench.kind === 'eligible') {
    if (bench.verdict === 'faster') return { symbol: '▲', color: GREEN, label: 'faster' };
    if (bench.verdict === 'slower') return { symbol: '▼', color: RED, label: 'slower' };
    return { symbol: '■', color: GRAY, label: 'neutral' };
  }
  if (bench.kind === 'changed') return { symbol: '✗', color: RED, label: 'output changed' };
  if (bench.kind === 'failed') return { symbol: '✗', color: RED, label: 'failed' };
  if (bench.kind === 'skipped') return { symbol: '·', color: YELLOW, label: 'skipped' };
  return { symbol: '·', color: GRAY, label: bench.presentIn === 'candidate' ? 'new' : 'removed' };
}

function name(bench: BenchResult): string {
  return bench.key.name || bench.key.group || 'anonymous';
}

function pValue(p: number): string {
  return p < 0.001 ? '< 0.001' : p.toFixed(3);
}

function change(delta: number | null | undefined, symbol?: string): string {
  if (delta == null || !Number.isFinite(delta)) return '—';
  if (delta === 0 && !symbol) return '—';
  return `${symbol ?? (delta < 0 ? '▲' : '▼')} ${formatDelta(delta)}`;
}

function bytes(value: number): string {
  return formatBytes(value, false).replace(/\b([kmgtp]?)b\b/g, (_, unit: string) =>
    unit ? unit.toUpperCase() + 'iB' : 'B'
  );
}

function consistency(
  canvas: TerminalCanvas,
  bench: EligibleBench,
  y: number,
  x: number,
  width: number
): void {
  const base = bench.baselineRunMedians;
  const cand = bench.candidateRunMedians;
  const count =
    base.length === cand.length ? `${base.length} runs` : `${base.length}/${cand.length} runs`;
  canvas.put(y, x, `consistency ✦ ${count}`, GRAY, width);
  const values = [...base, ...cand].filter(Number.isFinite);
  if (!values.length) return;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.abs(max) * 0.1 || 1;
  const step = 10 ** Math.floor(Math.log10(span));
  const low = Math.max(0, Math.floor((min - span * 0.06) / step) * step);
  const high = Math.ceil((max + span * 0.06) / step) * step;
  const divisor = high >= 1e9 ? 1e9 : high >= 1e6 ? 1e6 : high >= 1e3 ? 1e3 : 1;
  const unit = divisor === 1e9 ? 's' : divisor === 1e6 ? 'ms' : divisor === 1e3 ? 'µs' : 'ns';
  const label = (value: number) => `${Number((value / divisor).toPrecision(3))} ${unit}`;
  [base, cand].forEach((medians, side) => {
    const bins = Array<number>(Math.max(1, width - 2)).fill(0);
    for (const value of medians) {
      if (!Number.isFinite(value)) continue;
      const column = Math.max(
        0,
        Math.min(bins.length - 1, Math.round(((value - low) / (high - low)) * (bins.length - 1)))
      );
      bins[column]++;
    }
    bins.forEach((runs, column) => {
      if (runs)
        canvas.put(y + 1 + side, x + 1 + column, runs === 1 ? '●' : '⬤', side ? MAGENTA : CYAN);
    });
  });
  canvas.put(y + 2, x, '╞', DARK_GRAY);
  canvas.put(y + 2, x + width - 1, '╡', DARK_GRAY);
  canvas.put(y + 3, x, label(low), GRAY, Math.floor(width / 2));
  canvas.put(y + 3, x + Math.ceil(width / 2), label(high), GRAY, Math.floor(width / 2), true);
}

function spread(
  canvas: TerminalCanvas,
  bench: EligibleBench,
  result: CompareResult,
  config: LabsConfig,
  y: number,
  x: number,
  width: number
): void {
  canvas.put(y, x, `spread ✦ ${Number(((1 - config.alpha) * 100).toFixed(1))}% ci`, GRAY, width);
  const extents = result.benches
    .flatMap((item) => (item.kind === 'eligible' ? [item.ciLow, item.ciHigh, item.hl] : []))
    .filter(Number.isFinite);
  const limit = Math.ceil(Math.max(0.05, config.minDelta, ...extents.map(Math.abs)) / 0.05) * 0.05;
  const column = (value: number) =>
    Math.max(0, Math.min(width - 1, Math.round(((value + limit) / (limit * 2)) * (width - 1))));
  const low = column(bench.ciLow);
  const high = column(bench.ciHigh);
  const { color } = style(bench);
  for (let i = 0; i < width; i++) {
    const shaded = i >= column(-config.minDelta) && i <= column(config.minDelta);
    const background = shaded ? '\x1b[48;5;236m' : '';
    let char =
      i === column(0)
        ? '┼'
        : i === column(-config.minDelta) || i === column(config.minDelta)
          ? '┊'
          : '─';
    let foreground = i === column(0) ? WHITE : DARK_GRAY;
    if (i >= low && i <= high) {
      char = i === low ? '╞' : i === high ? '╡' : '━';
      foreground = color;
    }
    if (i === column(bench.hl)) {
      char = '●';
      foreground = color;
    }
    canvas.put(y + 2, x + i, char, background + foreground);
  }
  const lowLabel = formatDelta(bench.ciLow);
  const highLabel = formatDelta(bench.ciHigh);
  const lowX = Math.max(
    0,
    Math.min(low - textWidth(lowLabel), width - textWidth(lowLabel) - textWidth(highLabel) - 1)
  );
  const highX = Math.min(
    width - textWidth(highLabel),
    Math.max(high, lowX + textWidth(lowLabel) + 1)
  );
  canvas.put(y + 3, x + lowX, lowLabel, color, textWidth(lowLabel));
  canvas.put(y + 3, x + highX, highLabel, color, textWidth(highLabel));
}

function measurements(canvas: TerminalCanvas, bench: EligibleBench, y: number): number {
  const width = canvas.width;
  const { symbol, color } = style(bench);
  const values = [
    {
      label: 'median',
      base: formatNs(bench.baselineP50),
      cand: formatNs(bench.candidateP50),
      delta: change(bench.deltaP50, symbol),
    },
    {
      label: 'p99',
      base: formatNs(bench.baselineP99),
      cand: formatNs(bench.candidateP99),
      delta: change(bench.deltaP99),
    },
    {
      label: 'gc',
      base: bench.gc ? formatNs(bench.gc.baseline) : '—',
      cand: bench.gc ? formatNs(bench.gc.candidate) : '—',
      delta: change(bench.gc?.delta),
    },
    {
      label: 'heap',
      base: bench.heap ? bytes(bench.heap.baseline) : '—',
      cand: bench.heap ? bytes(bench.heap.candidate) : '—',
      delta: change(bench.heap?.delta),
    },
  ];
  const total = '\x1b[48;5;236m' + WHITE;
  if (width >= 71) {
    const graphWidth = Math.min(24, Math.floor((width - 3) / 2) - 23, width - 65);
    const columns = [
      { x: 10, width: 11 },
      { x: width - 40, width: 11 },
      { x: width - 28, width: 11 },
      { x: width - 16, width: 16 },
    ];
    const graphs = renderDistributions(bench.baselineSamples, bench.candidateSamples, graphWidth);
    canvas.fill(y + 3, total);
    values.forEach((value, index) => {
      const col = columns[index];
      canvas.put(y, col.x, value.label, GRAY, col.width, true);
      canvas.put(y + 1, col.x, value.base, '', col.width, true);
      canvas.put(y + 2, col.x, value.cand, '', col.width, true);
      canvas.put(y + 3, col.x, value.delta, index === 0 ? color : WHITE, col.width, true);
    });
    canvas.put(y + 1, 0, 'baseline', CYAN, 9);
    canvas.put(y + 2, 0, 'candidate', MAGENTA, 9);
    canvas.put(y + 1, 23, terminalText(graphs.baseline), CYAN, graphWidth);
    canvas.put(y + 2, 23, terminalText(graphs.candidate), MAGENTA, graphWidth);
    return y + 4;
  }
  const graphs = renderDistributions(
    bench.baselineSamples,
    bench.candidateSamples,
    Math.min(24, Math.max(3, width - 24))
  );
  for (const [side, label, color, graph] of [
    ['base', 'baseline', CYAN, graphs.baseline],
    ['cand', 'candidate', MAGENTA, graphs.candidate],
  ] as const) {
    canvas.put(y, 0, label, color, 9);
    canvas.put(y, 10, values[0][side], '', 12, true);
    canvas.put(y, 24, terminalText(graph), color);
    values.slice(1).forEach((value, index) => {
      const cellWidth = Math.floor(width / 3);
      const x = index * cellWidth;
      canvas.put(y + 1, x, value.label, GRAY, cellWidth - 1, true);
      canvas.put(y + 2, x, value[side], '', cellWidth - 1, true);
    });
    y += 3;
  }
  canvas.fill(y, total);
  canvas.fill(y + 1, total);
  canvas.put(y, 10, values[0].delta, color, 12, true);
  values.slice(1).forEach((value, index) => {
    const cellWidth = Math.floor(width / 3);
    canvas.put(y + 1, index * cellWidth, value.delta, WHITE, cellWidth - 1, true);
  });
  return y + 2;
}

function detailLines(
  result: CompareResult,
  config: LabsConfig,
  selected: number,
  width: number,
  colors: boolean
): string[] {
  const bench = result.benches[selected];
  const canvas = new TerminalCanvas(width);
  if (!bench) {
    canvas.put(0, 0, 'no benchmarks to compare', GRAY);
    return canvas.lines(colors);
  }
  const { symbol, color } = style(bench);
  const badge = bench.kind === 'eligible' ? ` p ${pValue(bench.p)} ` : '';
  const title =
    bench.key.group && bench.key.group !== name(bench)
      ? `${bench.key.group} › ${name(bench)}`
      : name(bench);
  canvas.put(0, 0, symbol, color);
  canvas.put(0, 2, title, BOLD, width - textWidth(badge) - 3);
  if (badge) {
    canvas.fill(0, '\x1b[48;5;236m' + GRAY, width - textWidth(badge));
    canvas.put(0, width - textWidth(badge), badge);
  }
  let y = 2;
  const note = (text: string, color = GRAY) => {
    for (const line of wrapText(text, width)) canvas.put(y++, 0, line, color);
  };
  if (bench.kind === 'eligible') {
    y = measurements(canvas, bench, y);
    canvas.put(y, 0, '─'.repeat(width), DARK_GRAY);
    y++;
    if (width >= 71) {
      const panelWidth = Math.floor((width - 3) / 2);
      consistency(canvas, bench, y, 0, panelWidth);
      spread(canvas, bench, result, config, y, panelWidth + 3, width - panelWidth - 3);
      y += 4;
    } else {
      consistency(canvas, bench, y, 0, width);
      y += 5;
      spread(canvas, bench, result, config, y, 0, width);
      y += 4;
    }
    if (Object.keys(bench.metrics ?? {}).length) {
      y++;
      if (width >= 71) {
        const metricWidth = 13;
        const labelWidth = width - 3 * metricWidth;
        canvas.put(y, labelWidth, 'baseline', CYAN, metricWidth, true);
        canvas.put(y++, labelWidth + metricWidth, 'candidate', MAGENTA, metricWidth, true);
        for (const [label, metric] of Object.entries(bench.metrics!)) {
          const labelLines = wrapText(label, labelWidth - 1);
          labelLines.forEach((line, index) => canvas.put(y + index, 0, line, GRAY, labelWidth - 1));
          canvas.put(y, labelWidth, formatAmount(metric.baseline), '', metricWidth, true);
          canvas.put(
            y,
            labelWidth + metricWidth,
            formatAmount(metric.candidate),
            '',
            metricWidth,
            true
          );
          canvas.put(
            y,
            labelWidth + 2 * metricWidth,
            metric.delta === null ? '—' : formatDelta(metric.delta),
            '',
            metricWidth,
            true
          );
          y += Math.max(1, labelLines.length);
        }
      } else {
        for (const [label, metric] of Object.entries(bench.metrics!)) {
          note(label);
          note(`baseline ${formatAmount(metric.baseline)}`, CYAN);
          note(
            `candidate ${formatAmount(metric.candidate)}  ${metric.delta === null ? '—' : formatDelta(metric.delta)}`,
            MAGENTA
          );
        }
      }
    }
    if (bench.comparisonResolution > config.minDelta) {
      y++;
      note(
        `⚠ limited resolution ~±${(bench.comparisonResolution * 100).toFixed(0)}%${bench.verdict === 'neutral' ? ' · inconclusive' : ''}`,
        YELLOW
      );
    }
  } else if (bench.kind === 'changed') {
    note('output changed', RED);
    note(`baseline ${formatNs(bench.baselineP50)} → candidate ${formatNs(bench.candidateP50)}`);
  } else if (bench.kind === 'failed') {
    note(`${bench.check ? 'check failed' : 'error'}: ${bench.message}`, RED);
  } else if (bench.kind === 'skipped') {
    note(bench.reason, YELLOW);
  } else {
    note(
      bench.presentIn === 'candidate'
        ? 'new in candidate · no baseline result'
        : 'removed from candidate · baseline only'
    );
  }
  if (textWidth(title) > width - textWidth(badge) - 3) {
    y++;
    note(title);
  }
  for (const warning of result.environmentWarnings) {
    y++;
    note(`⚠ ${warning}`, YELLOW);
  }
  return canvas.lines(colors);
}

export type {
  TerminalViewState as CompareViewState,
  TerminalFrame as CompareFrame,
} from './screen.ts';

function summaryItems(result: CompareResult) {
  const counts = new Map<string, { label: string; symbol: string; color: string; count: number }>();
  for (const bench of result.benches) {
    const appearance = style(bench);
    const label = bench.kind === 'changed' ? 'changed' : appearance.label;
    const item = counts.get(label);
    if (item) item.count++;
    else counts.set(label, { ...appearance, label, count: 1 });
  }
  return [...counts.values()];
}

export function comparisonSummary(result: CompareResult): string {
  return (
    summaryItems(result)
      .map(({ label, count }) => `${count} ${label}`)
      .join('  ') || 'no benchmarks'
  );
}

/** Render one screen without writing to the terminal or changing comparison results. */
export function renderCompareView(
  result: CompareResult,
  config: LabsConfig,
  state: CompareViewState
): CompareFrame {
  const width = Math.max(1, Math.floor(state.columns) - 1);
  const height = Math.max(1, Math.floor(state.rows));
  const colors = state.colors !== false;
  const canvas = new TerminalCanvas(width);
  const selected = Math.max(0, Math.min(result.benches.length - 1, state.selected));
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
  const detailHeight = Math.min(innerWidth >= 71 ? 12 : 21, height - 8);
  const detailTop = height - detailHeight - 1;
  const pageSize = detailTop - 3;
  const details = detailLines(result, config, selected, innerWidth, colors);
  const maxDetailOffset = Math.max(0, details.length - detailHeight + 1);
  const detailOffset = Math.max(0, Math.min(maxDetailOffset, state.detailOffset ?? 0));
  canvas.fill(0, '\x1b[42m' + BLACK, 1, 9);
  canvas.put(0, 1, ' COMPARE ', '', 9);
  canvas.put(0, 12, 'labs');
  let contextX = 18;
  if (innerWidth >= 71) {
    canvas.put(0, contextX, `v${version}`, GRAY);
    contextX += textWidth(`v${version}`) + 2;
  }
  const warning = result.environmentWarnings.length ? ` ⚠ ${result.environmentWarnings.length}` : '';
  const namesWidth = width - contextX - textWidth(warning) - 1;
  const baselineWidth = Math.min(
    textWidth(result.baselineName),
    Math.max(Math.floor((namesWidth - 3) / 2), namesWidth - 3 - textWidth(result.candidateName))
  );
  canvas.put(0, contextX, result.baselineName, CYAN, baselineWidth);
  canvas.put(0, contextX + baselineWidth, ' → ', GRAY, 3);
  canvas.put(
    0,
    contextX + baselineWidth + 3,
    result.candidateName,
    MAGENTA,
    namesWidth - baselineWidth - 3
  );
  if (warning) canvas.put(0, width - textWidth(warning) - 1, warning, YELLOW);
  const listColumns = innerWidth >= 71 ? [innerWidth - 41, 11, 11, 7, 8] : [innerWidth - 23, 11, 10];
  const listRow = (row: number, values: string[], styles: string[]) => {
    let x = 1;
    values.forEach((value, index) => {
      canvas.put(row, x, value, styles[index] ?? '', listColumns[index], index > 0);
      x += listColumns[index] + 1;
    });
  };
  listRow(
    1,
    innerWidth >= 71
      ? ['benchmark', 'baseline', 'candidate', 'Δp50', 'p']
      : ['benchmark', 'candidate', 'Δp50'],
    [GRAY, GRAY, GRAY, GRAY, GRAY]
  );
  const entries: Array<{ text?: string; color?: string; index?: number }> = [];
  for (const warning of result.environmentWarnings) {
    entries.push(...wrapText(`⚠ ${warning}`, innerWidth).map((text) => ({ text, color: YELLOW })));
  }
  let file = '';
  let group = '';
  result.benches.forEach((bench, index) => {
    if (bench.key.file !== file) {
      file = bench.key.file;
      group = '';
      entries.push({ text: `› ${file}`, color: BOLD });
    }
    if (bench.key.group !== group) {
      group = bench.key.group;
      if (group && group !== name(bench)) entries.push({ text: `  ${group}`, color: GRAY });
    }
    entries.push({ index });
  });
  const activeRow = Math.max(
    0,
    entries.findIndex((entry) => entry.index === selected)
  );
  let listOffset = Math.max(0, Math.min(state.listOffset ?? 0, entries.length - pageSize));
  if (activeRow < listOffset) listOffset = activeRow;
  if (activeRow >= listOffset + pageSize) listOffset = activeRow - pageSize + 1;
  entries.slice(listOffset, listOffset + pageSize).forEach((entry, index) => {
    const row = index + 2;
    if (entry.index === undefined) {
      canvas.put(row, 1, entry.text ?? '', entry.color, innerWidth);
      return;
    }
    const bench = result.benches[entry.index];
    const { symbol, color, label } = style(bench);
    const active = entry.index === selected;
    if (active) canvas.fill(row, '\x1b[48;5;236m' + WHITE);
    const title = `${active ? '›' : ' '} ${symbol} ${name(bench)}`;
    if (bench.kind === 'eligible' || bench.kind === 'changed') {
      const delta = bench.kind === 'eligible' ? formatDelta(bench.deltaP50) : '—';
      listRow(
        row,
        innerWidth >= 71
          ? [
              title,
              formatNs(bench.baselineP50),
              formatNs(bench.candidateP50),
              delta,
              bench.kind === 'eligible' ? pValue(bench.p) : '—',
            ]
          : [title, formatNs(bench.candidateP50), delta],
        innerWidth >= 71
          ? [active ? WHITE : '', GRAY, '', color, GRAY]
          : [active ? WHITE : '', '', color]
      );
    } else {
      listRow(
        row,
        innerWidth >= 71 ? [title, '—', '—', label, '—'] : [title, '—', label],
        innerWidth >= 71 ? ['', GRAY, GRAY, color, GRAY] : ['', GRAY, color]
      );
    }
    canvas.put(row, 3, symbol, color, 1);
  });
  canvas.put(detailTop - 1, 1, '━'.repeat(innerWidth), DARK_GRAY);
  const position = `${result.benches.length ? selected + 1 : 0}/${result.benches.length}`;
  const summary = summaryItems(result);
  const summaryWidth = textWidth(comparisonSummary(result));
  const keys = maxDetailOffset
    ? `↑↓ select  [ ] details ${detailOffset + 1}/${maxDetailOffset + 1}`
    : '↑↓ select  pgup pgdn page';
  let controls = `${keys}  esc / q exit  ${position}`;
  if (summaryWidth + textWidth(controls) + 3 > innerWidth) {
    controls = `↑↓${maxDetailOffset ? '  [ ] details' : ' select'}  q exit  ${position}`;
  }
  const compact = summaryWidth + textWidth(controls) + 3 > innerWidth;
  if (compact) controls = `↑↓${maxDetailOffset ? ' [ ]' : ''}  q exit  ${position}`;
  const controlsX = width - textWidth(controls);
  let summaryX = 1;
  for (const item of summary) {
    const text = `${item.count} ${compact ? item.symbol : item.label}`;
    canvas.put(height - 1, summaryX, text, item.color, controlsX - summaryX - 2);
    summaryX += textWidth(text) + (compact ? 1 : 2);
  }
  if (!summary.length) canvas.put(height - 1, 1, 'no benchmarks', GRAY, controlsX - 3);
  canvas.put(height - 1, controlsX, controls, GRAY);
  const lines = canvas.lines(colors);
  for (let i = 0; i < detailHeight - 1; i++) {
    lines[detailTop + i] = ' ' + (details[detailOffset + i] ?? ' '.repeat(innerWidth));
  }
  return { lines, selected, listOffset, detailOffset, maxDetailOffset, pageSize };
}
