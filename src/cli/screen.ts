import { emitKeypressEvents, type Key } from 'node:readline';
import type { ReadStream, WriteStream } from 'node:tty';

export interface TerminalViewState {
  columns: number;
  rows: number;
  selected: number;
  listOffset?: number;
  detailOffset?: number;
  colors?: boolean;
}

export interface TerminalFrame {
  lines: string[];
  selected: number;
  listOffset: number;
  detailOffset: number;
  maxDetailOffset: number;
  pageSize: number;
}

export function isInteractiveTerminal(): boolean {
  return Boolean(
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    process.env.TERM !== 'dumb' &&
    (!process.env.CI || process.env.CI === 'false')
  );
}

/** Own input and terminal state for the lifetime of a report. */
export function openReportScreen(
  render: (state: TerminalViewState) => TerminalFrame,
  count: number,
  input: ReadStream = process.stdin,
  output: WriteStream = process.stdout
): Promise<void> {
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw;
    const wasFlowing = input.readableFlowing;
    let selected = 0;
    let listOffset = 0;
    let detailOffset = 0;
    let frame: TerminalFrame;
    let active = true;
    let entered = false;

    function cleanup() {
      if (!active) return;
      active = false;
      input.removeListener('keypress', onKey);
      input.removeListener('end', onEnd);
      input.removeListener('close', onEnd);
      input.removeListener('error', onError);
      output.removeListener('error', onError);
      output.removeListener('resize', draw);
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
      process.removeListener('SIGHUP', onHangup);
      process.removeListener('exit', cleanup);
      try {
        input.setRawMode(wasRaw);
      } finally {
        if (wasFlowing !== true) input.pause();
        if (entered && !output.destroyed) output.write('\x1b[0m\x1b[?25h\x1b[?1049l');
      }
    }

    function finish(error?: Error) {
      if (!active) return;
      try {
        cleanup();
      } catch (cleanupError) {
        error ??= cleanupError as Error;
      }
      if (error) reject(error);
      else resolve();
    }

    function onEnd() {
      finish();
    }
    function onError(error: Error) {
      finish(error);
    }
    function onInterrupt() {
      process.exitCode = 130;
      finish();
    }
    function onTerminate() {
      process.exitCode = 143;
      finish();
    }
    function onHangup() {
      process.exitCode = 129;
      finish();
    }

    function draw() {
      if (!active) return;
      try {
        frame = render({
          columns: output.columns || 80,
          rows: output.rows || 24,
          selected,
          listOffset,
          detailOffset,
          colors: process.env.NO_COLOR === undefined,
        });
        selected = frame.selected;
        listOffset = frame.listOffset;
        detailOffset = frame.detailOffset;
        output.write('\x1b[H' + frame.lines.map((line) => line + '\x1b[0m\x1b[K').join('\r\n'));
      } catch (error) {
        finish(error as Error);
      }
    }

    function onKey(text: string, key: Key) {
      if (key.ctrl && key.name === 'c') return onInterrupt();
      if (key.name === 'escape' || text === 'q' || (key.ctrl && key.name === 'd')) return finish();
      const previous = selected;
      if (key.name === 'up') selected--;
      else if (key.name === 'down') selected++;
      else if (key.name === 'pageup') selected -= frame.pageSize;
      else if (key.name === 'pagedown') selected += frame.pageSize;
      else if (key.name === 'home') {
        selected = 0;
        listOffset = 0;
      } else if (key.name === 'end') selected = count - 1;
      else if (text === '[' || key.name === 'left') detailOffset--;
      else if (text === ']' || key.name === 'right') detailOffset++;
      else return;
      selected = Math.max(0, Math.min(count - 1, selected));
      if (selected !== previous) detailOffset = 0;
      draw();
    }

    try {
      emitKeypressEvents(input);
      input.on('keypress', onKey);
      input.on('end', onEnd);
      input.on('close', onEnd);
      input.on('error', onError);
      output.on('error', onError);
      output.on('resize', draw);
      process.on('SIGINT', onInterrupt);
      process.on('SIGTERM', onTerminate);
      process.on('SIGHUP', onHangup);
      process.on('exit', cleanup);
      input.setRawMode(true);
      input.resume();
      entered = true;
      output.write('\x1b[?1049h\x1b[?25l\x1b[2J');
      draw();
    } catch (error) {
      finish(error as Error);
    }
  });
}
