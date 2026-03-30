/** Clamp `v` to the range [`lo`, `hi`]. */
export function clamp(lo: number, v: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Minimum value in `arr`, starting from `initial` (default `Infinity`). */
export function min(arr: number[], initial = Infinity): number {
  return arr.reduce((x, v) => Math.min(x, v), initial);
}

/** Maximum value in `arr`, starting from `initial` (default `-Infinity`). */
export function max(arr: number[], initial = -Infinity): number {
  return arr.reduce((x, v) => Math.max(x, v), initial);
}
