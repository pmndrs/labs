import type { OptimizationSample, OptimizationTier } from '../types.ts';
import { dollar_vm } from './runtime.ts';

/** The native entry tier installed for the function's next invocation. */
export const optimization:
  | {
      tier(fn: Function): OptimizationTier | undefined;
      highest: OptimizationTier;
    }
  | undefined = (() => {
  const scripts = new WeakMap<Function, boolean>();
  // oxlint-disable-next-line typescript/unbound-method
  const stringify = Function.prototype.toString;
  function isScript(fn: Function) {
    let script = scripts.get(fn);
    if (script === undefined) {
      // Native tier queries require ordinary JavaScript functions.
      script = !/\{\s*\[native code\]\s*\}$/.test(stringify.call(fn));
      scripts.set(fn, script);
    }
    return script;
  }
  if (dollar_vm) {
    const vm = dollar_vm;
    return {
      tier(fn) {
        if (!isScript(fn)) return undefined;
        return vm
          .codeBlockFor(fn)
          ?.match(/, (FTL|DFG|Baseline|LLInt)Function(?:Call|Construct),/)?.[1] as
          OptimizationTier | undefined;
      },
      highest: 'FTL',
    };
  }
  try {
    const source = `%ActiveTierIsTurbofan(fn) ? 'TurboFan' : %ActiveTierIsMaglev(fn) ? 'Maglev' : %ActiveTierIsSparkplug(fn) ? 'Sparkplug' : %ActiveTierIsIgnition(fn) ? 'Ignition' : undefined`;
    // oxlint-disable-next-line typescript/no-implied-eval
    const tier = new Function('fn', `return ${source}`) as (
      fn: Function
    ) => OptimizationTier | undefined;
    return {
      tier(fn) {
        return isScript(fn) ? tier(fn) : undefined;
      },
      highest: 'TurboFan',
    };
  } catch {
    return undefined;
  }
})();

/** Remember when each entry tier was first observed during one warmup phase. */
export function optimizationClock(started: number) {
  const reached = new Map<OptimizationTier, number>();
  return (tier: OptimizationTier | undefined, at: number): OptimizationSample | null => {
    if (!tier) return null;
    if (!reached.has(tier)) reached.set(tier, at - started);
    return { tier, time: reached.get(tier)! };
  };
}
