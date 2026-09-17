import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'fast-string-width';

/** Keep saved names and errors from moving the cursor or changing terminal modes. */
export function terminalText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
    character === '\u200d' ? character : ' '
  );
}

export function textWidth(value: string): number {
  return stringWidth(terminalText(value));
}

function fitText(value: string, width: number): string {
  const text = terminalText(value);
  if (width <= 0) return '';
  if (stringWidth(text) <= width) return text;
  let fitted = '';
  let used = 0;
  for (const { segment } of new Intl.Segmenter().segment(text)) {
    const size = stringWidth(segment);
    if (used + size > width - 1) break;
    fitted += segment;
    used += size;
  }
  return fitted + '…';
}

export function wrapText(value: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  let used = 0;
  for (const { segment } of new Intl.Segmenter().segment(terminalText(value))) {
    const size = stringWidth(segment);
    if (used + size > width && line) {
      lines.push(line);
      line = '';
      used = 0;
    }
    line += segment;
    used += size;
  }
  if (line) lines.push(line);
  return lines;
}

type Cell = { text: string; style: string };

/** A terminal-cell grid keeps wide names and ANSI styles inside their columns. */
export class TerminalCanvas {
  private rows: Cell[][] = [];
  readonly width: number;

  constructor(width: number) {
    this.width = width;
  }

  private row(y: number): Cell[] {
    while (this.rows.length <= y) {
      this.rows.push(Array.from({ length: this.width }, () => ({ text: ' ', style: '' })));
    }
    return this.rows[y];
  }

  fill(y: number, style: string, x = 0, width = this.width - x): void {
    const row = this.row(y);
    for (let i = Math.max(0, x); i < Math.min(this.width, x + width); i++) {
      row[i] = { text: ' ', style };
    }
  }

  put(y: number, x: number, value: string, style = '', width = this.width - x, right = false): void {
    if (y < 0 || x < 0 || width <= 0) return;
    const text = fitText(value, Math.min(width, this.width - x));
    const row = this.row(y);
    let column = x + (right ? width - stringWidth(text) : 0);
    for (const { segment } of new Intl.Segmenter().segment(text)) {
      const size = stringWidth(segment);
      if (size === 0 || column + size > this.width) continue;
      row[column] = { text: segment, style: row[column].style + style };
      for (let i = 1; i < size; i++) row[column + i] = { text: '', style };
      column += size;
    }
  }

  lines(colors = true): string[] {
    return this.rows.map((row) => {
      let line = '';
      let active = '';
      for (const cell of row) {
        if (colors && cell.style !== active) {
          line += '\x1b[0m' + cell.style;
          active = cell.style;
        }
        line += cell.text;
      }
      return line + (colors && active ? '\x1b[0m' : '');
    });
  }
}
