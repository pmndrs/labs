/**
 * Human-readable unit formatters for benchmark output.
 *
 * These cover the full range of magnitudes the benchmark engine can produce
 * (picoseconds → hours, bytes → petabytes, raw counts → peta-scale).
 */

/**
 * Format a duration in nanoseconds to the most appropriate human-readable unit.
 * Covers ps → ns → µs → ms → s → m → h.
 */
export function formatNs(ns: number): string {
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
}

/**
 * Format a byte count to the most appropriate human-readable unit (binary, 1024-based).
 * @param pad - If true (default), pads the smallest unit with an extra space for alignment.
 */
export function formatBytes(b: number, pad = true): string {
  if (Number.isNaN(b)) return 'NaN';
  if (b < 1e3) return `${b.toFixed(2)} ${pad ? ' ' : ''}b`;
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
}

/**
 * Format a numeric count with SI suffixes (k, M, G, T, P).
 */
export function formatAmount(n: number): string {
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
}

/**
 * Truncate a string to `len` characters, appending `..` if it overflows.
 */
export function truncate(s: string, len = 3): string {
  if (len >= s.length) return s;
  return `${s.slice(0, len - 2)}..`;
}
