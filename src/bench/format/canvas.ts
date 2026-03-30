/**
 * Braille-dot canvas for drawing line charts in the terminal.
 *
 * Each character cell maps to a 2×4 grid of virtual pixels, using Unicode
 * braille patterns (U+2800–U+28FF) to render sub-character resolution.
 */

const BRAILLE_BASE = 0x2800;
const BRAILLE_DOTS = [0x2801, 0x2802, 0x2804, 0x2840, 0x2808, 0x2810, 0x2820, 0x2880];

/** Create a braille-dot canvas with the given character dimensions. */
export function braille(width: number, height: number) {
  const vwidth = 2 * width;
  const vheight = 4 * height;
  const buffer = new Uint8Array(vwidth * vheight);

  return {
    buffer,
    width,
    height,
    vwidth,
    vheight,

    /** Set a single virtual pixel. `tag` identifies the series (≥1). */
    set(x: number, y: number, tag = 1) {
      buffer[x + y * vwidth] = tag;
    },

    /** Draw a line between two points using Bresenham's algorithm. */
    line(s: { x: number; y: number }, e: { x: number; y: number }, tag = 1) {
      s.x = Math.round(s.x);
      s.y = Math.round(s.y);
      e.x = Math.round(e.x);
      e.y = Math.round(e.y);
      const dx = Math.abs(e.x - s.x);
      const dy = Math.abs(e.y - s.y);

      let err = dx - dy;
      let x = s.x;
      let y = s.y;
      const sx = s.x < e.x ? 1 : -1;
      const sy = s.y < e.y ? 1 : -1;

      while (true) {
        buffer[x + y * vwidth] = tag;
        if (x === e.x && y === e.y) break;

        const e2 = 2 * err;

        if (e2 < dx) {
          y += sy;
          err += dx;
        }

        if (e2 > -dy) {
          x += sx;
          err -= dy;
        }
      }
    },

    /**
     * Render the buffer to an array of strings (one per row).
     * @param opts.background - If true, render empty cells as blank braille instead of spaces.
     * @param opts.format - Optional callback to colorize each character by position and tag.
     */
    toString({
      background = false,
      format = (_x: number, _y: number, s: string, _tag: number, _bg: boolean) => s,
    }: {
      background?: boolean;
      format?: (x: number, y: number, s: string, tag: number, bg: boolean) => string;
    } = {}): string[] {
      const canvas = Array.from({ length: height }, () => '');

      for (let y = 0; y < vheight; y += 4) {
        const y0 = y * vwidth;
        const y1 = y0 + vwidth;
        const y2 = y1 + vwidth;
        const y3 = y2 + vwidth;

        for (let x = 0; x < vwidth; x += 2) {
          let c = BRAILLE_BASE;

          if (buffer[x + y0]) c |= BRAILLE_DOTS[0];
          if (buffer[1 + x + y0]) c |= BRAILLE_DOTS[4];
          if (buffer[x + y1]) c |= BRAILLE_DOTS[1];
          if (buffer[1 + x + y1]) c |= BRAILLE_DOTS[5];
          if (buffer[x + y2]) c |= BRAILLE_DOTS[2];
          if (buffer[1 + x + y2]) c |= BRAILLE_DOTS[6];
          if (buffer[x + y3]) c |= BRAILLE_DOTS[3];
          if (buffer[1 + x + y3]) c |= BRAILLE_DOTS[7];

          if (c === BRAILLE_BASE && !background) canvas[y / 4] += ' ';
          else
            canvas[y / 4] += format(
              x / (vwidth - 1),
              y / (vheight - 1),
              String.fromCharCode(c),
              buffer[x + y0] ||
                buffer[1 + x + y0] ||
                buffer[x + y1] ||
                buffer[1 + x + y1] ||
                buffer[x + y2] ||
                buffer[1 + x + y2] ||
                buffer[x + y3] ||
                buffer[1 + x + y3],
              c === BRAILLE_BASE
            );
        }
      }

      return canvas;
    },
  };
}
