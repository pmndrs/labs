import type { FnKind } from '../types.ts';

/**
 * Async/generator function constructors obtained from runtime instances.
 * Used for `instanceof` checks in {@link kind} and for codegen in the
 * benchmark loops ({@link benchFn}, {@link benchIter}).
 */
export const AsyncFunction = (async () => {}).constructor as any;
export const GeneratorFunction = function* () {}.constructor as any;
export const AsyncGeneratorFunction = async function* () {}.constructor as any;

const _sink: { _: any; __(): void } = {
  _: null,
  __() {
    _print(_sink._);
  },
};

/**
 * Stores `v` in a side-effecting sink so the engine cannot dead-code-eliminate
 * the computation that produced it.
 */
export function do_not_optimize(v: any): void {
  _sink._ = v;
}

/** Resolved `console.log` (or runtime-specific equivalent). */
export const _print: (s: any) => void = (() => {
  if (globalThis.console?.log) return globalThis.console.log;
  if ((globalThis as any).print && !globalThis.document) return (globalThis as any).print;

  return () => {
    throw new Error('no print function available');
  };
})();

/**
 * Best-effort garbage-collection trigger for the current JS runtime.
 * Falls back to a large allocation on Graal or V8 without `--expose-gc`.
 * `gc.fallback` is `true` when no native GC hook was found.
 */
export const gc: (() => void) & { fallback?: boolean } = (() => {
  const g = globalThis as any;
  try {
    return (g.Bun.gc(true), () => g.Bun.gc(true));
  } catch {}
  try {
    return (g.gc(), () => g.gc());
  } catch {}
  try {
    return (g.__gc(), () => g.__gc());
  } catch {}
  try {
    return (g.std.gc(), () => g.std.gc());
  } catch {}
  try {
    return (g.$262.gc(), () => g.$262.gc());
  } catch {}
  try {
    return (g.tjs.engine.gc.run(), () => g.tjs.engine.gc.run());
  } catch {}
  return Object.assign(g.Graal ? () => new Uint8Array(2 ** 29) : () => new Uint8Array(2 ** 30), {
    fallback: true,
  });
})();

/**
 * High-resolution nanosecond timer for the current JS runtime.
 * Resolves Bun, test262 agent, `performance.now`, or `Date.now` (last resort).
 */
export const now: () => number = (() => {
  const g = globalThis as any;
  try {
    g.Bun.nanoseconds();
    return g.Bun.nanoseconds;
  } catch {}
  try {
    (_sink as any).agent.monotonicNow();
    return () => 1e6 * (_sink as any).agent.monotonicNow();
  } catch {}
  try {
    g.$262.agent.monotonicNow();
    return () => 1e6 * g.$262.agent.monotonicNow();
  } catch {}
  try {
    const _now = performance.now.bind(performance);
    _now();
    return () => 1e6 * _now();
  } catch {
    return () => 1e6 * Date.now();
  }
})();

/**
 * Classifies a callable as `'fn'` (zero-arg), `'iter'` (takes an iterator
 * context), or `'yield'` (generator/async-generator).  Returns `undefined`
 * for non-functions.
 *
 * @param fn - The value to classify.
 * @param _ - When `true`, skip the zero-arg check (allows parameterised fns).
 */
export function kind(fn: any, _: boolean = false): FnKind | undefined {
  if (
    !(
      fn instanceof Function ||
      fn instanceof AsyncFunction ||
      fn instanceof GeneratorFunction ||
      fn instanceof AsyncGeneratorFunction
    )
  )
    return;

  if (fn instanceof GeneratorFunction || fn instanceof AsyncGeneratorFunction) return 'yield';

  if ((_ ? true : 0 === fn.length) && (fn instanceof Function || fn instanceof AsyncFunction))
    return 'fn';

  if (0 !== fn.length && (fn instanceof Function || fn instanceof AsyncFunction)) return 'iter';
}
