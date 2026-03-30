export const $ = {
  bold: '\x1b[1m',
  reset: '\x1b[0m',

  red: '\x1b[31m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
  white: '\x1b[37m',
  black: '\x1b[30m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',

  colors: ['red', 'cyan', 'blue', 'green', 'yellow', 'magenta', 'gray', 'white', 'black'] as string[],

  clamp(m: number, v: number, x: number): number {
    return v < m ? m : v > x ? x : v;
  },

  min(arr: number[], s = Infinity): number {
    return arr.reduce((x, v) => Math.min(x, v), s);
  },

  max(arr: number[], s = -Infinity): number {
    return arr.reduce((x, v) => Math.max(x, v), s);
  },

  str(s: string, len = 3): string {
    if (len >= s.length) return s;
    return `${s.slice(0, len - 2)}..`;
  },

  amount(n: number): string {
    if (Number.isNaN(n)) return 'NaN';
    if (n < 1e3) return n.toFixed(2);
    n /= 1000;
    if (n < 1e3) return `${n.toFixed(2)}k`;
    n /= 1000;
    if (n < 1e3) return `${n.toFixed(2)}M`;
    n /= 1000;
    if (n < 1e3) return `${n.toFixed(2)}G`;
    n /= 1000;
    if (n < 1e3) return `${n.toFixed(2)}T`;
    n /= 1000;

    return `${n.toFixed(2)}P`;
  },

  bytes(b: number, pad = true): string {
    if (Number.isNaN(b)) return 'NaN';
    if (b < 1e3) return `${b.toFixed(2)} ${!pad ? '' : ' '}b`;

    b /= 1024;
    if (b < 1e3) return `${b.toFixed(2)} kb`;
    b /= 1024;
    if (b < 1e3) return `${b.toFixed(2)} mb`;
    b /= 1024;
    if (b < 1e3) return `${b.toFixed(2)} gb`;
    b /= 1024;
    if (b < 1e3) return `${b.toFixed(2)} tb`;
    b /= 1024;

    return `${b.toFixed(2)} pb`;
  },

  time(ns: number): string {
    if (ns < 1) return `${(ns * 1e3).toFixed(2)} ps`;
    if (ns < 1e3) return `${ns.toFixed(2)} ns`;
    ns /= 1000;
    if (ns < 1e3) return `${ns.toFixed(2)} µs`;
    ns /= 1000;
    if (ns < 1e3) return `${ns.toFixed(2)} ms`;
    ns /= 1000;

    if (ns < 1e3) return `${ns.toFixed(2)} s`;
    ns /= 60;
    if (ns < 1e3) return `${ns.toFixed(2)} m`;
    ns /= 60;

    return `${ns.toFixed(2)} h`;
  },

  barplot: {
    symbols: {
      bar: '■',
      legend: '┤',
      tl: '┌',
      tr: '┐',
      bl: '└',
      br: '┘',
    },

    ascii(
      map: Record<string, number>,
      key = 8,
      size = 14,
      {
        steps = 0,
        fmt = $.time,
        colors = true as any,
        symbols = $.barplot.symbols,
      }: { steps?: number; fmt?: (n: number) => string; colors?: any; symbols?: any } = {}
    ): string[] {
      const values = Object.values(map);
      const canvas = new Array<string>(2 + values.length).fill('');

      steps += size;
      const min = $.min(values);
      const max = $.max(values);
      const step = (max - min) / steps;

      canvas[0] += ' '.repeat(1 + key);
      canvas[0] += symbols.tl + ' '.repeat(size) + symbols.tr;

      Object.keys(map).forEach((name, o) => {
        const value = map[name];
        const bars = Math.round((value - min) / step);
        if (colors?.[name]) canvas[o + 1] += colors[name];

        canvas[o + 1] += $.str(name, key).padStart(key);
        if (colors?.[name]) canvas[o + 1] += $.reset;
        canvas[o + 1] += ' ' + symbols.legend;

        if (colors) canvas[o + 1] += $.gray;
        canvas[o + 1] += symbols.bar.repeat(bars);
        if (colors) canvas[o + 1] += $.reset;

        canvas[o + 1] += ' ';
        if (colors) canvas[o + 1] += $.yellow;
        canvas[o + 1] += fmt(value);
        if (colors) canvas[o + 1] += $.reset;
      });

      canvas[canvas.length - 1] += ' '.repeat(1 + key);
      canvas[canvas.length - 1] += symbols.bl + ' '.repeat(size) + symbols.br;

      return canvas;
    },
  },

  canvas: {
    braille(width: number, height: number) {
      const vwidth = 2 * width;
      const vheight = 4 * height;
      const buffer = new Uint8Array(vwidth * vheight);

      const symbols = [0x2801, 0x2802, 0x2804, 0x2840, 0x2808, 0x2810, 0x2820, 0x2880];

      return {
        buffer,
        width,
        height,
        vwidth,
        vheight,

        set(x: number, y: number, tag = 1) {
          buffer[x + y * vwidth] = tag;
        },

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
            if (e2 < dx) ((y += sy), (err += dx));
            if (e2 > -dy) ((x += sx), (err -= dy));
          }
        },

        toString({
          background = false,
          format = (_x: number, _y: number, s: string, _tag: number, _bg: boolean) => s,
        }: {
          background?: boolean;
          format?: (x: number, y: number, s: string, tag: number, bg: boolean) => string;
        } = {}): string[] {
          const canvas = new Array<string>(height).fill('');

          for (let y = 0; y < vheight; y += 4) {
            const y0 = y * vwidth;
            const y1 = y0 + vwidth;
            const y2 = y1 + vwidth;
            const y3 = y2 + vwidth;

            for (let x = 0; x < vwidth; x += 2) {
              let c = 0x2800;

              if (buffer[x + y0]) c |= symbols[0];
              if (buffer[1 + x + y0]) c |= symbols[4];
              if (buffer[x + y1]) c |= symbols[1];
              if (buffer[1 + x + y1]) c |= symbols[5];
              if (buffer[x + y2]) c |= symbols[2];
              if (buffer[1 + x + y2]) c |= symbols[6];
              if (buffer[x + y3]) c |= symbols[3];
              if (buffer[1 + x + y3]) c |= symbols[7];

              if (c === 0x2800 && !background) canvas[y / 4] += ' ';
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
                  c === 0x2800
                );
            }
          }

          return canvas;
        },
      };
    },
  },

  lineplot: {
    symbols: { tl: '┌', tr: '┐', bl: '└', br: '┘' },

    ascii(
      map: Record<string, any>,
      {
        colors = true as any,
        xmin = 0,
        xmax = 1,
        ymin = 0,
        ymax = 1,
        symbols = $.lineplot.symbols,
        key = 8,
        width = 12,
        height = 12,
        labels = { xmin: null, xmax: null, ymin: null, ymax: null } as any,
      }: any = {}
    ): string[] {
      const keys = Object.keys(map);
      const _canvas = $.canvas.braille(width, height);
      const xs = (_canvas.vwidth - 1) / (xmax - xmin);
      const ys = (_canvas.vheight - 1) / (ymax - ymin);

      const colorsv = Object.entries(colors)
        .filter(([n]) => !Object.keys(labels).includes(n))
        .map(([_, v]) => v);

      const acolors = $.colors.filter((n) => !colorsv.includes(($ as any)[n]));

      keys.forEach((name, k) => {
        const { x: xp, y: yp } = map[name];

        for (let o = 0; o < xp.length - 1; o++) {
          if (null == xp[o] || null == xp[o + 1]) continue;
          if (null == yp[o] || null == yp[o + 1]) continue;
          const s = {
            x: Math.round(xs * (xp[o] - xmin)),
            y: _canvas.vheight - 1 - Math.round(ys * (yp[o] - ymin)),
          };
          const e = {
            x: Math.round(xs * (xp[o + 1] - xmin)),
            y: _canvas.vheight - 1 - Math.round(ys * (yp[o + 1] - ymin)),
          };

          _canvas.line(s, e, 1 + k);
        }
      });

      const canvas = new Array<string>(2 + _canvas.height).fill('');

      canvas[0] += ' '.repeat(1 + key);
      canvas[0] += symbols.tl + ' '.repeat(width) + symbols.tr;

      const lines = _canvas.toString({
        format(x: number, y: number, s: string, tag: number) {
          const name = keys[tag - 1];
          if (map[name].format) return map[name].format(x, y, s);
          else if (colors?.[name]) return colors[name] + s + $.reset;
          else return ($ as any)[acolors[(tag - 1) % acolors.length]] + s + $.reset;
        },
      });

      const plabels: Record<number, string> = {
        0: !colors?.ymax ? labels.ymax || '' : colors.ymax + (labels.ymax || '') + $.reset,
        [lines.length - 1]: !colors?.ymin
          ? labels.ymin || ''
          : colors.ymin + (labels.ymin || '') + $.reset,
      };

      const legends = keys.map((name, k) => {
        if (colors?.[name]) return colors[name] + $.str(name, key).padStart(key) + $.reset;
        else
          return ($ as any)[acolors[k % acolors.length]] + $.str(name, key).padStart(key) + $.reset;
      });

      lines.forEach((l, o) => {
        canvas[o + 1] += legends[o] ?? ' '.repeat(key);
        canvas[o + 1] += ' '.repeat(2) + l + (!plabels[o] ? '' : ' ' + plabels[o]);
      });

      canvas[canvas.length - 1] += ' '.repeat(1 + key);
      canvas[canvas.length - 1] += symbols.bl + ' '.repeat(width) + symbols.br;

      if (labels.xmin || labels.xmax) {
        const xminL: string = labels.xmin || '';
        const xmaxL: string = labels.xmax || '';
        const gap = 2 + width - xminL.length;

        canvas.push(
          ' '.repeat(key) +
            ' ' +
            (!colors?.xmin ? xminL : colors.xmin + xminL + $.reset) +
            (!colors?.xmax ? xmaxL.padStart(gap) : colors.xmax + xmaxL.padStart(gap) + $.reset)
        );
      }

      return canvas;
    },
  },

  histogram: {
    symbols: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],

    bins(
      stats: { samples: number[]; min: number; max: number; avg: number },
      size = 6,
      percentile = 1
    ) {
      const offset = (percentile * (stats.samples.length - 1)) | 0;

      let min = stats.min;
      const max = stats.samples[offset] || stats.max || 1;

      const steps = new Array<number>(size);
      const bins = new Array<number>(size).fill(0);
      const step = (max - min) / (size - 1);

      if (0 === step) {
        min = 0;
        for (let o = 0; o < size; o++) steps[o] = o * step;
        bins[$.clamp(0, Math.round((stats.avg - min) / step), size - 1)] = 1;
      } else {
        for (let o = 0; o < size; o++) steps[o] = min + o * step;
        for (let o = 0; o <= offset; o++) bins[Math.round((stats.samples[o] - min) / step)]++;
      }

      return {
        min,
        max,
        step,
        bins,
        steps,
        peak: $.max(bins),
        outliers: stats.samples.length - 1 - offset,
        avg: $.clamp(0, Math.round((stats.avg - min) / step), size - 1),
      };
    },

    ascii(
      _bins: { avg: number; peak: number; bins: number[] },
      height = 1,
      {
        colors = true as any,
        symbols = $.histogram.symbols,
      }: { colors?: any; symbols?: string[] } = {}
    ): string[] {
      const canvas = new Array<string>(height);
      const { avg, peak, bins } = _bins;
      const scale = (height * symbols.length - 1) / peak;

      for (let y = 0; y < height; y++) {
        let l = '';

        if (0 !== avg) {
          if (colors) l += $.cyan;

          for (let o = 0; o < avg; o++) {
            const b = bins[o];
            if (y === 0) l += symbols[$.clamp(0, Math.round(b * scale), symbols.length - 1)];
            else {
              const min = y * symbols.length;
              const max = (y + 1) * symbols.length;
              const offset = Math.round(b * scale) | 0;

              if (min >= offset) l += ' ';
              else if (max <= offset) l += symbols[symbols.length - 1];
              else l += symbols[$.clamp(min, offset, max) % symbols.length];
            }
          }

          if (colors) l += $.reset;
        }

        {
          if (colors) l += $.yellow;

          const b = bins[avg];
          if (y === 0) l += symbols[$.clamp(0, Math.round(b * scale), symbols.length - 1)];
          else {
            const min = y * symbols.length;
            const max = (y + 1) * symbols.length;
            const offset = Math.round(b * scale) | 0;

            if (min >= offset) l += ' ';
            else if (max <= offset) l += symbols[symbols.length - 1];
            else l += symbols[$.clamp(min, offset, max) % symbols.length];
          }

          if (colors) l += $.reset;
        }

        if (avg != bins.length - 1) {
          if (colors) l += $.magenta;

          for (let o = 1 + avg; o < bins.length; o++) {
            const b = bins[o];
            if (y === 0) l += symbols[$.clamp(0, Math.round(b * scale), symbols.length - 1)];
            else {
              const min = y * symbols.length;
              const max = (y + 1) * symbols.length;
              const offset = Math.round(b * scale) | 0;

              if (min >= offset) l += ' ';
              else if (max <= offset) l += symbols[symbols.length - 1];
              else l += symbols[$.clamp(min, offset, max) % symbols.length];
            }
          }

          if (colors) l += $.reset;
        }

        canvas[y] = l;
      }

      return canvas.reverse();
    },
  },

  boxplot: {
    symbols: {
      v: '│',
      h: '─',
      tl: '┌',
      tr: '┐',
      bl: '└',
      br: '┘',

      avg: { top: '┬', middle: '│', bottom: '┴' },
      tail: { top: '╷', bottom: '╵', middle: ['├', '┤'] },
    },

    ascii(
      map: Record<string, any>,
      key = 8,
      size = 14,
      {
        fmt = $.time,
        colors = true as any,
        symbols = $.boxplot.symbols,
      }: { fmt?: (n: number) => string; colors?: any; symbols?: any } = {}
    ): string[] {
      let tmin = Infinity;
      let tmax = -Infinity;
      const keys = Object.keys(map);
      const canvas = new Array<string>(3 + 3 * keys.length).fill('');

      for (const name of keys) {
        const stats = map[name];
        if (tmin > stats.min) tmin = stats.min;
        const max = stats.p99 || stats.max || 1;
        if (max > tmax) tmax = max;
      }

      const steps = 2 + size;
      const step = (tmax - tmin) / (steps - 1);

      canvas[0] += ' '.repeat(1 + key);
      canvas[0] += symbols.tl + ' '.repeat(size) + symbols.tr;

      keys.forEach((name, o) => {
        o *= 3;
        const stats = map[name];

        const min = stats.min;
        const avg = stats.avg;
        const p25 = stats.p25;
        const p75 = stats.p75;
        const max = stats.p99 || stats.max || 1;

        const min_offset = 1 + Math.min(steps - 1, Math.round((min - tmin) / step));
        const max_offset = 1 + Math.min(steps - 1, Math.round((max - tmin) / step));
        const avg_offset = 1 + Math.min(steps - 1, Math.round((avg - tmin) / step));
        const p25_offset = 1 + Math.min(steps - 1, Math.round((p25 - tmin) / step));
        const p75_offset = 1 + Math.min(steps - 1, Math.round((p75 - tmin) / step));

        const u = new Array<string>(2 + steps).fill(' ');
        const m = new Array<string>(2 + steps).fill(' ');
        const l = new Array<string>(2 + steps).fill(' ');

        u[0] = !colors ? '' : $.cyan;
        m[0] = !colors ? '' : $.cyan;
        l[0] = !colors ? '' : $.cyan;

        if (min_offset < p25_offset) {
          u[min_offset] = symbols.tail.top;
          l[min_offset] = symbols.tail.bottom;
          m[min_offset] = symbols.tail.middle[0];
          for (let o = 1 + min_offset; o < p25_offset; o++) m[o] = symbols.h;
        }

        if (avg_offset > p25_offset) {
          u[p25_offset] = symbols.tl;
          l[p25_offset] = symbols.bl;
          m[p25_offset] = min_offset === p25_offset ? symbols.v : symbols.tail.middle[1];

          for (let o = 1 + p25_offset; o < avg_offset; o++) u[o] = l[o] = symbols.h;
        }

        u[avg_offset] = !colors
          ? symbols.avg.top
          : $.reset + $.yellow + symbols.avg.top + $.reset + $.magenta;
        l[avg_offset] = !colors
          ? symbols.avg.bottom
          : $.reset + $.yellow + symbols.avg.bottom + $.reset + $.magenta;
        m[avg_offset] = !colors
          ? symbols.avg.middle
          : $.reset + $.yellow + symbols.avg.middle + $.reset + $.magenta;

        if (avg_offset < p75_offset) {
          u[p75_offset] = symbols.tr;
          l[p75_offset] = symbols.br;
          m[p75_offset] = max_offset === p75_offset ? symbols.v : symbols.tail.middle[0];

          for (let o = 1 + avg_offset; o < p75_offset; o++) u[o] = l[o] = symbols.h;
        }

        if (max_offset > p75_offset) {
          u[max_offset] = symbols.tail.top;
          l[max_offset] = symbols.tail.bottom;
          m[max_offset] = symbols.tail.middle[1];
          for (let o = 1 + Math.max(avg_offset, p75_offset); o < max_offset; o++) m[o] = symbols.h;
        }

        canvas[o + 1] = ' '.repeat(1 + key) + u.join('').trimEnd() + (!colors ? '' : $.reset);
        if (colors?.[name]) canvas[o + 2] += colors[name];
        canvas[o + 2] += $.str(name, key).padStart(key);

        if (colors?.[name]) canvas[o + 2] += $.reset;
        canvas[o + 2] += ' ' + m.join('').trimEnd() + (!colors ? '' : $.reset);
        canvas[o + 3] = ' '.repeat(1 + key) + l.join('').trimEnd() + (!colors ? '' : $.reset);
      });

      canvas[canvas.length - 2] += ' '.repeat(1 + key);
      canvas[canvas.length - 2] += symbols.bl + ' '.repeat(size) + symbols.br;

      const rmin = fmt(tmin);
      const rmax = fmt(tmax);
      const rmid = fmt((tmin + tmax) / 2);
      const gap = (size - rmin.length - rmid.length - rmax.length) / 2;

      canvas[canvas.length - 1] += ' '.repeat(1 + key);
      canvas[canvas.length - 1] += !colors ? rmin : $.cyan + rmin + $.reset;

      canvas[canvas.length - 1] += ' '.repeat((1 + gap) | 0);
      canvas[canvas.length - 1] += !colors ? rmid : $.gray + rmid + $.reset;

      canvas[canvas.length - 1] += ' '.repeat(1 + Math.ceil(gap));
      canvas[canvas.length - 1] += !colors ? rmax : $.magenta + rmax + $.reset;
      return canvas;
    },
  },
};
