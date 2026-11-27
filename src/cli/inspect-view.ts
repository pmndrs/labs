import type { Findings, InlinedCall } from '../bench/types.ts';
import {
  BLACK,
  BLUE,
  BOLD,
  DARK_GRAY,
  GRAY,
  GREEN,
  RED,
  RESET,
  WHITE,
  YELLOW,
} from '../utils/ansi.ts';
import type { inspectJson } from './json.ts';
import {
  type TerminalFrame,
  type TerminalViewState,
  isInteractiveTerminal,
  openReportScreen,
} from './screen.ts';
import { TerminalCanvas, textWidth, wrapText } from './terminal.ts';

type Bench = ReturnType<typeof inspectJson>['benches'][number];

function mark({ status }: Bench): { symbol: string; color: string } {
  return status === 'failed'
    ? { symbol: '✗', color: RED }
    : status === 'warning'
      ? { symbol: '⚠', color: YELLOW }
      : { symbol: '✓', color: GREEN };
}

type Cell = { text: string; style?: string };

function flatten(calls: InlinedCall[], depth = 0): Array<InlinedCall & { depth: number }> {
  return calls.flatMap((call) => [{ ...call, depth }, ...flatten(call.calls, depth + 1)]);
}

/**
 * Lay out the findings of one bench for a pane of the given width. The screen
 * and the printed report both show these lines, so they cannot drift apart.
 */
function details(bench: Bench, width: number, colors: boolean): string[] {
  const canvas = new TerminalCanvas(width);
  const { symbol, color } = mark(bench);
  canvas.put(0, 0, `${symbol} ${bench.name}`, BOLD);
  canvas.put(0, 0, symbol, color, 1);
  canvas.put(0, textWidth(bench.name) + 4, bench.group, GRAY);
  let y = 1;
  for (const line of wrapText(bench.message, width)) canvas.put(y++, 0, line, color);
  for (const line of wrapText(bench.advice, width)) canvas.put(y++, 0, line, GRAY);
  const { inspection } = bench;
  if (!inspection) return canvas.lines(colors);

  const percent = (time: number | null) => (time === null ? '—' : `${Math.round(time * 100)}%`);
  // The cells of a labelled row follow each other and continue under the first at the edge.
  const flow = (label: string, cells: Cell[]) => {
    canvas.put(++y, 0, label, GRAY);
    let x = 11;
    for (const { text, style } of cells) {
      if (x > 11 && x + textWidth(text) > width) {
        y++;
        x = 11;
      }
      canvas.put(y, x, text, style);
      x += textWidth(text) + 1;
    }
  };
  flow('function', [
    { text: inspection.workload.name || '(anonymous)' },
    { text: inspection.workload.source, style: GRAY },
  ]);
  flow(
    'tiers',
    inspection.tiers.flatMap((tier, index) => [
      ...(index ? [{ text: '→', style: DARK_GRAY }] : []),
      { text: tier, style: tier === 'deopt' ? YELLOW : '' },
    ])
  );
  flow('time', [
    { text: percent(inspection.time) },
    { text: 'of the sampled time, with what was inlined into it', style: GRAY },
  ]);
  flow('optimized', [
    inspection.optimized
      ? { text: inspection.optimized === 'alone' ? 'alone' : 'in the sampling loop' }
      : { text: 'never by TurboFan while sampling', style: YELLOW },
  ]);

  const { inlineBytes, inlineTotalBytes } = inspection.limits;
  if (inlineBytes && inlineTotalBytes)
    flow('inlining', [
      { text: `${inlineBytes} B`, style: '' },
      { text: 'of bytecode per call,', style: GRAY },
      { text: `${inlineTotalBytes} B`, style: '' },
      { text: 'in total', style: GRAY },
    ]);

  // A table sizes each column to its widest cell. Where the pane is too
  // narrow for that, the last column moves to a line of its own under each row.
  const table = (title: string, headings: string[], rows: Cell[][]) => {
    const heads = [`${title} ✦ ${rows.length}`, ...(rows.length ? headings : [])];
    const widths = heads.map((head, column) =>
      Math.max(textWidth(head), ...rows.map((row) => textWidth(row[column].text)))
    );
    const left = widths.map((_, column) =>
      widths.slice(0, column).reduce((sum, size) => sum + size + 2, 0)
    );
    const last = left.at(-1)! + widths.at(-1)! > width ? heads.length - 1 : -1;
    y += 2;
    heads.forEach((head, column) => column !== last && canvas.put(y, left[column], head, GRAY));
    for (const row of rows) {
      y++;
      row.forEach(
        ({ text, style }, column) =>
          column !== last && canvas.put(y, left[column], text, style, widths[column])
      );
      if (last > 0)
        for (const line of wrapText(row[last].text, width - 4))
          canvas.put(++y, 4, line, row[last].style);
    }
  };
  // The four findings of one function. A called function only shows the ones it has.
  const tables = (found: Findings, all: boolean) => {
    const shown = (title: string, headings: string[], rows: Cell[][]) =>
      (all || rows.length) && table(title, headings, rows);
    shown(
      'inlined',
      ['defined', 'called at', 'bytecode'],
      flatten(found.inlined).map((call) => [
        { text: '  '.repeat(call.depth) + (call.name || '(anonymous)') },
        { text: call.source, style: GRAY },
        { text: call.at, style: GRAY },
        { text: call.bytecodeBytes === null ? '—' : `${call.bytecodeBytes} B`, style: GRAY },
      ])
    );
    shown(
      'not inlined',
      ['defined', 'bytecode', 'reason'],
      found.rejected.map((call) => [
        { text: call.name || '(anonymous)' },
        { text: call.source, style: GRAY },
        { text: call.bytecodeBytes === null ? '—' : `${call.bytecodeBytes} B`, style: GRAY },
        { text: call.reason, style: YELLOW },
      ])
    );
    shown(
      'polymorphic',
      ['access', 'shapes', 'position', 'layouts'],
      found.polymorphic.map(({ state, access, key, shapes, layouts, at }) => [
        { text: state, style: state === 'megamorphic' ? YELLOW : '' },
        { text: `${access} ${key}`.trim() },
        { text: state === 'megamorphic' ? `${shapes}+` : String(shapes), style: GRAY },
        { text: at, style: GRAY },
        { text: layouts.join(' · '), style: GRAY },
      ])
    );
    shown(
      'deopts',
      ['tier', 'kind', 'reason', 'position'],
      found.deopts.map(({ phase, tier, kind, reason, at }) => [
        { text: phase, style: phase === 'sampling' ? YELLOW : GRAY },
        { text: tier, style: GRAY },
        { text: kind, style: DARK_GRAY },
        { text: reason },
        { text: at.join(' ← '), style: GRAY },
      ])
    );
  };
  tables(inspection, true);
  table(
    'called',
    ['defined', 'time', 'bytecode', 'tier', 'deopts'],
    inspection.called.map((fn) => [
      { text: fn.name || '(anonymous)' },
      { text: fn.source, style: GRAY },
      { text: percent(fn.time) },
      { text: fn.bytecodeBytes === null ? '—' : `${fn.bytecodeBytes} B`, style: GRAY },
      { text: fn.tiers.findLast((tier) => tier !== 'deopt') ?? '—', style: GRAY },
      { text: String(fn.deopts.length), style: fn.deopts.length ? YELLOW : GRAY },
    ])
  );
  for (const fn of inspection.called) {
    if (!fn.inlined.length && !fn.rejected.length && !fn.polymorphic.length && !fn.deopts.length)
      continue;
    canvas.put((y += 2), 0, fn.name || '(anonymous)', BOLD);
    canvas.put(y, textWidth(fn.name || '(anonymous)') + 2, fn.source, GRAY);
    y--;
    tables(fn, false);
  }
  for (const { name, source, listing } of inspection.bytecode ?? []) {
    canvas.put((y += 2), 0, `bytecode ✦ ${name || '(anonymous)'}`, GRAY);
    canvas.put(y, textWidth(`bytecode ✦ ${name || '(anonymous)'}`) + 2, source, GRAY);
    for (const row of listing) canvas.put(++y, 0, row, GRAY);
  }
  return canvas.lines(colors);
}

/**
 * Render the judged view of an inspection the way the run report renders a
 * run: the benches as a list with the findings of the selected one below.
 */
export function renderInspectView(benches: Bench[], state: TerminalViewState): TerminalFrame {
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
  const list: Array<{ text: string; index?: number; style?: string }> = [];
  let previousFile = '';
  let previousGroup = '';
  benches.forEach((entry, index) => {
    if (entry.file !== previousFile) {
      list.push({ text: `› ${entry.file}` });
      previousFile = entry.file;
      previousGroup = '';
    }
    if (entry.group && entry.group !== previousGroup)
      list.push({ text: `  ${entry.group}`, style: BOLD + DARK_GRAY });
    previousGroup = entry.group;
    list.push({ text: entry.name, index });
  });
  const detailLines = details(benches[selected], innerWidth, colors);
  // The findings are the point of this screen, so they take every row a short
  // list leaves free and all but six rows of a long one.
  const detailHeight = Math.min(detailLines.length + 1, height - 4 - Math.min(list.length, 6));
  const detailTop = height - detailHeight - 1;
  const pageSize = detailTop - 3;
  const maxDetailOffset = Math.max(0, detailLines.length - detailHeight + 1);
  const detailOffset = Math.max(0, Math.min(maxDetailOffset, state.detailOffset ?? 0));

  canvas.fill(0, '\x1b[42m' + BLACK, 1, 9);
  canvas.put(0, 1, ' INSPECT ', '', 9);
  canvas.put(0, 12, benches.find((entry) => entry.inspection)?.inspection?.engine ?? '', GRAY);
  const nameWidth = innerWidth - 26;
  const listRow = (y: number, label: string, calls: string, deopts: string, heading = false) => {
    canvas.put(y, 1, label, heading ? GRAY : '', nameWidth);
    canvas.put(y, nameWidth + 3, calls, GRAY, 11, true);
    canvas.put(y, nameWidth + 16, deopts, GRAY, 11, true);
  };
  listRow(1, 'benchmark', 'inlined', 'deopts', true);
  const activeRow = Math.max(
    0,
    list.findIndex((row) => row.index === selected)
  );
  let listOffset = Math.max(0, Math.min(state.listOffset ?? 0, list.length - pageSize));
  if (activeRow < listOffset) listOffset = activeRow;
  if (activeRow >= listOffset + pageSize) listOffset = activeRow - pageSize + 1;
  list.slice(listOffset, listOffset + pageSize).forEach((row, index) => {
    const y = index + 2;
    if (row.index === undefined) canvas.put(y, 1, row.text, row.style ?? BOLD, innerWidth);
    else {
      const entry = benches[row.index];
      const active = selected === row.index;
      if (active) canvas.fill(y, '\x1b[48;5;236m' + WHITE);
      listRow(
        y,
        `${active ? '›' : ' '} ${mark(entry).symbol} ${row.text}`,
        entry.inspection ? String(flatten(entry.inspection.inlined).length) : '—',
        entry.inspection ? String(entry.inspection.deopts.length) : '—'
      );
      canvas.put(y, 3, mark(entry).symbol, mark(entry).color, 1);
    }
  });
  canvas.put(detailTop - 1, 1, '━'.repeat(innerWidth), DARK_GRAY);
  const count = (status: Bench['status']) =>
    benches.filter((entry) => entry.status === status).length;
  const controls = `↑↓ select  ${maxDetailOffset ? '[ ] details' : 'pgup pgdn page'}  esc / q exit  ${selected + 1}/${benches.length}`;
  const controlsX = width - textWidth(controls);
  let x = 1;
  for (const [label, color] of [
    [`${benches.filter((entry) => entry.inspection).length} inspected`, GREEN],
    ...(count('warning')
      ? [[`${count('warning')} warning${count('warning') === 1 ? '' : 's'}`, YELLOW]]
      : []),
    ...(count('failed') ? [[`${count('failed')} failed`, RED]] : []),
  ]) {
    canvas.put(height - 1, x, label, color, controlsX - x - 2);
    x += textWidth(label) + 2;
  }
  canvas.put(height - 1, controlsX, controls, GRAY);
  const lines = canvas.lines(colors);
  for (let i = 0; i < detailHeight - 1; i++)
    lines[detailTop + i] = ' ' + (detailLines[detailOffset + i] ?? ' '.repeat(innerWidth));
  return { lines, selected, listOffset, detailOffset, maxDetailOffset, pageSize };
}

/** Show an inspection on the report screen, or print it where there is no terminal to own. */
export async function showInspectReport(benches: Bench[]): Promise<void> {
  if (isInteractiveTerminal() && benches.length)
    return openReportScreen((state) => renderInspectView(benches, state), benches.length);
  let file = '';
  for (const bench of benches) {
    if (bench.file !== file)
      console.log(
        `\n${BLUE}▶ ${(file = bench.file)}${RESET}  ${bench.inspection?.engine ?? ''}`.trimEnd()
      );
    console.log();
    // A printed report is read and diffed, so no row is cut to fit a pane.
    for (const line of details(bench, 1000, false)) console.log(line.trimEnd());
  }
}
