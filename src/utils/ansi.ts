/**
 * ANSI escape codes for terminal styling.
 *
 * Two naming conventions are exported:
 * - UPPERCASE constants (`BOLD`, `RESET`, …) used by the CLI layer
 * - A lowercase `ansi` record used by the core benchmark formatters
 *
 * Both reference the same underlying escape sequences (standard 16-color SGR).
 */

// ── modifiers ──────────────────────────────────────────────────────

export const RESET = '\x1b[0m';
export const DIM = '\x1b[2m';
export const BOLD = '\x1b[1m';

// ── 16-color foreground ────────────────────────────────────────────

export const RED = '\x1b[31m';
export const GREEN = '\x1b[32m';
export const YELLOW = '\x1b[33m';
export const BLUE = '\x1b[34m';
export const MAGENTA = '\x1b[35m';
export const CYAN = '\x1b[36m';
export const WHITE = '\x1b[37m';
export const BLACK = '\x1b[30m';

/**
 * 256-color light gray — used by the CLI comparison / table layer.
 * Distinct from {@link DARK_GRAY} which is the standard bright-black.
 */
export const GRAY = '\x1b[38;5;248m';

/** Standard bright-black (SGR 90), used by the core benchmark formatters. */
export const DARK_GRAY = '\x1b[90m';

// ── lowercase record for core formatters ───────────────────────────

/** Color names available for benchmark highlight styling. */
export const COLOR_NAMES: readonly string[] = [
  'red',
  'cyan',
  'blue',
  'green',
  'yellow',
  'magenta',
  'gray',
  'white',
  'black',
];

/**
 * Lowercase ANSI code map used by the core benchmark output formatters.
 * `gray` maps to bright-black (`\x1b[90m`), matching the original mitata palette.
 */
export const ansi: Record<string, string> = {
  bold: BOLD,
  reset: RESET,
  red: RED,
  cyan: CYAN,
  blue: BLUE,
  gray: DARK_GRAY,
  white: WHITE,
  black: BLACK,
  green: GREEN,
  yellow: YELLOW,
  magenta: MAGENTA,
};
