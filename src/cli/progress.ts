import { createRequire } from 'node:module';
import type { WriteStream } from 'node:tty';
import { median } from '../stats.ts';
import { CYAN, DARK_GRAY, GRAY, GREEN, RED, YELLOW } from '../utils/ansi.ts';
import { formatNs } from '../utils/units.ts';
import { TerminalCanvas, textWidth, wrapText } from './terminal.ts';
import { runtimeLabel } from './utils.ts';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

/** Events a worker writes as JSON lines while it runs one bench file. */
export type ProgressEvent =
  | {
      type: 'start';
      blocks: number;
      benches: Array<{ index: number; name: string; group: string; cases: number }>;
    }
  | { type: 'bench'; index: number; block: number }
  | {
      type: 'block';
      index: number;
      block: number;
      duration: number;
      median?: number;
      error?: string;
    };

export interface BenchStatus {
  symbol: string;
  message: string;
}

interface BenchProgress {
  index: number;
  name: string;
  group: string;
  cases: number;
  running: boolean;
  medians: number[];
  durations: number[];
  error?: string;
  status?: BenchStatus;
}

interface FileProgress {
  name: string;
  state: 'waiting' | 'running' | 'done';
  blocks: number;
  benches: BenchProgress[];
  started?: number;
  ended?: number;
  error?: string;
}

export interface RunProgress {
  name: string;
  runtime: 'node' | 'chrome';
  started: number;
  files: FileProgress[];
}

export function createProgress(
  name: string,
  files: string[],
  now: number,
  runtime: RunProgress['runtime'] = 'node'
): RunProgress {
  return {
    name,
    runtime,
    started: now,
    files: files.map((file) => ({ name: file, state: 'waiting', blocks: 0, benches: [] })),
  };
}

export function startFile(progress: RunProgress, file: number, now: number): void {
  Object.assign(progress.files[file], { state: 'running', started: now });
}

export function applyEvent(progress: RunProgress, file: number, event: ProgressEvent): void {
  const target = progress.files[file];
  if (event.type === 'start') {
    target.blocks = event.blocks;
    target.benches = event.benches.map((bench) => ({
      ...bench,
      running: false,
      medians: [],
      durations: [],
    }));
    return;
  }
  const bench = target.benches.find((bench) => bench.index === event.index);
  if (!bench) return;
  if (event.type === 'bench') {
    bench.running = true;
    return;
  }
  bench.running = false;
  bench.durations.push(event.duration);
  if (event.median !== undefined) bench.medians.push(event.median);
  if (event.error !== undefined) bench.error = event.error;
}

/** Final statuses in bench order, or the reason the worker failed. */
export function finishFile(
  progress: RunProgress,
  file: number,
  now: number,
  outcome: { statuses: BenchStatus[] } | { error: string }
): void {
  const target = progress.files[file];
  Object.assign(target, { state: 'done', ended: now });
  for (const bench of target.benches) bench.running = false;
  if ('error' in outcome) target.error = outcome.error;
  else outcome.statuses.forEach((status, index) => (target.benches[index].status = status));
}

/** A failed pilot has no plan to replay, so its bench runs no further blocks. */
function blocksLeft(bench: BenchProgress, blocks: number): number {
  return bench.error === undefined ? blocks - bench.durations.length : 0;
}

/**
 * Later blocks replay the pilot's sample count, so once every bench has run its
 * pilot the remaining time follows from each bench's average block duration.
 */
export function remainingTime(file: FileProgress): number | undefined {
  if (file.state !== 'running' || !file.benches.length) return;
  if (file.benches.some((bench) => !bench.durations.length)) return;
  return file.benches.reduce(
    (total, bench) => total + median(bench.durations) * blocksLeft(bench, file.blocks),
    0
  );
}

function seconds(ms: number): string {
  return ms < 60e3
    ? `${(ms / 1e3).toFixed(1)}s`
    : `${Math.floor(ms / 60e3)}m ${Math.round((ms % 60e3) / 1e3)}s`;
}

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

function fileSummary(file: FileProgress): { symbol: string; color: string; detail: string } {
  if (file.error) return { symbol: '✗', color: RED, detail: 'crashed' };
  const failed = file.benches.filter((bench) => bench.status?.symbol === '✗').length;
  const warned = file.benches.filter((bench) => bench.status?.symbol === '⚠').length;
  const count = `${file.benches.length} bench${file.benches.length === 1 ? '' : 'es'}`;
  const notes = [
    failed ? `${failed} failed` : '',
    warned ? `${warned} warning${warned === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return {
    symbol: failed ? '✗' : warned ? '⚠' : '✓',
    color: failed ? RED : warned ? YELLOW : GREEN,
    detail: [count, ...notes].join('  '),
  };
}

type Line = (canvas: TerminalCanvas, y: number) => void;

/** Draw the live view, keeping the running bench visible when rows run short. */
export function renderProgress(
  progress: RunProgress,
  view: { columns: number; rows: number; now: number; colors?: boolean }
): string[] {
  const width = Math.max(20, view.columns - 1);
  const tick = SPINNER[Math.floor(view.now / 80) % SPINNER.length];
  const body: Line[] = [];
  let focus = 0;

  for (const file of progress.files) {
    if (file.state === 'waiting') {
      body.push((canvas, y) => canvas.put(y, 1, `· ${file.name}`, DARK_GRAY));
      continue;
    }
    const elapsed = seconds((file.ended ?? view.now) - (file.started ?? view.now));
    if (file.state === 'done') {
      const summary = fileSummary(file);
      body.push((canvas, y) => {
        canvas.put(y, 1, summary.symbol, summary.color, 1);
        canvas.put(y, 3, file.name, '', width - 30);
        canvas.put(y, 0, `${summary.detail}  ${elapsed}`, GRAY, width, true);
      });
      if (file.error)
        for (const line of wrapText(file.error, width - 3))
          body.push((canvas, y) => canvas.put(y, 3, line, RED));
      continue;
    }

    focus = body.length;
    const round = Math.min(
      file.blocks,
      1 + Math.min(...file.benches.map((bench) => file.blocks - blocksLeft(bench, file.blocks)))
    );
    const left = remainingTime(file);
    const status = file.blocks
      ? `block ${round}/${file.blocks}${left !== undefined && left >= 1e3 ? `  ~${seconds(left)}` : ''}`
      : 'starting';
    body.push((canvas, y) => {
      canvas.put(y, 1, '❯', CYAN, 1);
      canvas.put(y, 3, file.name, '', width - 30);
      canvas.put(y, 0, status, GRAY, width, true);
    });

    const grouped = file.benches.some((bench) => bench.group);
    const nameWidth = Math.max(0, ...file.benches.map((bench) => textWidth(bench.name)));
    const dotsX = (grouped ? 7 : 5) + Math.min(nameWidth, width - 40) + 2;
    let group: string | undefined;
    for (const bench of file.benches) {
      if (grouped && bench.group !== group) {
        group = bench.group;
        const label = group;
        body.push((canvas, y) => canvas.put(y, 3, label, DARK_GRAY));
      }
      const x = grouped ? 5 : 3;
      if (bench.running) focus = body.length;
      const done = file.blocks - blocksLeft(bench, file.blocks);
      const symbol = bench.error !== undefined ? '✗' : bench.running ? tick : done ? ' ' : '·';
      const color = bench.error !== undefined ? RED : bench.running ? CYAN : DARK_GRAY;
      const value =
        bench.cases > 1
          ? `${bench.cases} cases`
          : bench.medians.length
            ? formatNs(median(bench.medians))
            : '';
      body.push((canvas, y) => {
        canvas.put(y, x, symbol, color, 1);
        canvas.put(
          y,
          x + 2,
          bench.name,
          bench.durations.length || bench.running ? '' : GRAY,
          dotsX - x - 4
        );
        canvas.put(y, dotsX, '●'.repeat(done), CYAN, done);
        canvas.put(y, dotsX + done, '○'.repeat(file.blocks - done), DARK_GRAY, file.blocks - done);
        canvas.put(y, dotsX + file.blocks + 2, value, DARK_GRAY, 10, true);
      });
      if (bench.error !== undefined)
        for (const line of wrapText(bench.error, width - x - 2))
          body.push((canvas, y) => canvas.put(y, x + 2, line, RED));
    }
  }

  const finished = progress.files.flatMap((file) =>
    file.state === 'done' ? file.benches : []
  ).length;
  const current = progress.files.findIndex((file) => file.state === 'running');
  const footer = [
    `${finished} bench${finished === 1 ? '' : 'es'} done`,
    current >= 0 ? `file ${current + 1}/${progress.files.length}` : '',
  ]
    .filter(Boolean)
    .join('  ');

  // Header, blank, body, blank, footer
  const room = Math.max(1, view.rows - 5);
  const start = Math.max(0, Math.min(body.length - room, focus - Math.floor(room / 2)));
  const visible = body.slice(start, start + room);
  const canvas = new TerminalCanvas(width);
  canvas.put(0, 1, 'labs', '', 4);
  const runtimeX = width >= 60 ? 10 + version.length : 7;
  if (width >= 60) canvas.put(0, 7, `v${version}`, GRAY);
  const runtime = runtimeLabel(progress.runtime);
  canvas.put(0, runtimeX, runtime, GRAY, textWidth(runtime));
  const nameX = runtimeX + textWidth(runtime) + 2;
  canvas.put(0, nameX, progress.name, CYAN, width - nameX - 12);
  canvas.put(0, nameX, seconds(view.now - progress.started), GRAY, width - nameX, true);
  visible.forEach((line, index) => line(canvas, index + 2));
  canvas.put(visible.length + 3, 1, footer, GRAY);
  return canvas.lines(view.colors !== false);
}

/** Redraws the view in place below normal output, printing logs above it. */
export class LiveView {
  private height = 0;
  private timer?: ReturnType<typeof setInterval>;
  private readonly output: WriteStream;
  private readonly draw: (columns: number, rows: number) => string[];
  private readonly interrupt = () => {
    this.stop();
    process.exit(130);
  };

  constructor(output: WriteStream, draw: (columns: number, rows: number) => string[]) {
    this.output = output;
    this.draw = draw;
  }

  start(): void {
    this.output.write('\x1b[?25l');
    process.on('SIGINT', this.interrupt);
    this.timer = setInterval(() => this.render(), 80);
    this.render();
  }

  render(): void {
    const lines = this.draw(this.output.columns || 80, this.output.rows || 24);
    this.output.write(this.clear() + lines.join('\n') + '\n');
    this.height = lines.length;
  }

  log(text: string): void {
    this.output.write(this.clear() + text + (text.endsWith('\n') ? '' : '\n'));
    this.height = 0;
    this.render();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    process.removeListener('SIGINT', this.interrupt);
    this.render();
    this.output.write('\x1b[?25h');
  }

  private clear(): string {
    return this.height ? `\x1b[${this.height}F\x1b[0J` : '';
  }
}
