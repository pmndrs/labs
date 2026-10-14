import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { openReportScreen, type TerminalViewState } from '../src/cli/screen.ts';
import { terminalText } from '../src/cli/terminal.ts';

function terminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn(function (this: { isRaw: boolean }, mode: boolean) {
      this.isRaw = mode;
      return this;
    }),
  });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
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

/** Open a screen that renders the selected row as `n/count`. */
function open(term: ReturnType<typeof terminal>, count: number, fail = () => {}) {
  return openReportScreen(
    (state: TerminalViewState) => {
      fail();
      const selected = Math.max(0, Math.min(count - 1, state.selected));
      return {
        lines: [`${selected + 1}/${count}`],
        selected,
        listOffset: 0,
        detailOffset: 0,
        maxDetailOffset: 0,
        pageSize: 10,
      };
    },
    count,
    term.input as unknown as ReadStream,
    term.output as unknown as WriteStream
  );
}

describe('report screen', () => {
  it('navigates, redraws on resize, and restores the terminal on exit', async () => {
    const term = terminal();
    const signals = process.listenerCount('SIGTERM');
    const done = open(term, 30);
    expect(term.input.isRaw).toBe(true);
    expect(term.text()).toContain('\x1b[?1049h');

    term.clear();
    term.input.write('\x1b[F');
    expect(stripVTControlCharacters(term.text())).toContain('30/30');
    term.clear();
    term.input.write('\x1b[H');
    term.input.write('\x1b[B');
    expect(stripVTControlCharacters(term.text())).toContain('2/30');
    term.clear();
    term.output.emit('resize');
    expect(stripVTControlCharacters(term.text())).toContain('2/30');

    term.input.write('q');
    await done;
    expect(term.text()).toContain('\x1b[?25h\x1b[?1049l');
    expect(term.input.isRaw).toBe(false);
    expect(term.input.isPaused()).toBe(true);
    expect(term.output.listenerCount('resize')).toBe(0);
    expect(term.input.listenerCount('keypress')).toBe(0);
    expect(process.listenerCount('SIGTERM')).toBe(signals);
  });

  it('restores the terminal and reports the error when a redraw throws', async () => {
    const term = terminal();
    let calls = 0;
    const done = open(term, 1, () => {
      if (calls++) throw new Error('render failed');
    });
    term.output.emit('resize');
    await expect(done).rejects.toThrow('render failed');
    expect(term.input.isRaw).toBe(false);
    expect(term.output.listenerCount('resize')).toBe(0);
    expect(term.text()).toContain('\x1b[?1049l');
  });

  it('restores the terminal on Ctrl+C and keeps the interrupt exit code', async () => {
    const term = terminal();
    const previousCode = process.exitCode;
    try {
      const done = open(term, 1);
      term.input.write('\x03');
      await done;
      expect(process.exitCode).toBe(130);
      expect(term.input.isRaw).toBe(false);
      expect(term.text()).toContain('\x1b[?1049l');
    } finally {
      process.exitCode = previousCode;
    }
  });
});

describe('terminal text', () => {
  it('strips escapes and control characters from saved names', () => {
    for (const value of ['\x1b[2Jbad\nname', '\x1b]0;injected\x07unsafe\rtitle']) {
      const text = terminalText(value);
      expect(text).not.toContain('\x1b');
      for (const control of ['\r', '\n', '\x07']) expect(text).not.toContain(control);
    }
    expect(terminalText('\x1b]0;injected\x07unsafe')).toContain('unsafe');
  });

  it('keeps emoji joined', () => {
    expect(terminalText('👩‍💻')).toBe('👩‍💻');
  });
});
