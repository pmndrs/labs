import type { OptimizationSample, OptimizationTier } from '../types.ts';
import { dollar_vm } from './runtime.ts';

/** Workload entry tiers and probes for the executing sampling frame. */
export const optimization:
  | {
      tier(fn: Function): OptimizationTier | undefined;
      frame?: string;
    }
  | undefined = (() => {
  const scripts = new WeakMap<Function, boolean>();
  // oxlint-disable-next-line typescript/unbound-method
  const stringify = Function.prototype.toString;
  function isScript(fn: Function) {
    let script = scripts.get(fn);
    if (script === undefined) {
      const source = stringify.call(fn);
      // Async JSC handles identify the wrapper rather than the executing body.
      script =
        !/\{\s*\[native code\]\s*\}$/.test(source) && (!dollar_vm || !/^\s*async\b/.test(source));
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
      frame: `$vm.ftlTrue() ? 'FTL' : $vm.dfgTrue() ? 'DFG' : $vm.baselineJITTrue() ? 'Baseline' : $vm.llintTrue() ? 'LLInt' : $vm.codeBlockFor($vm.codeBlockForFrame(0))?.match(/, (FTL|DFG|Baseline|LLInt)Function(?:Call|Construct),/)?.[1]`,
    };
  }
  try {
    const source = `%ActiveTierIsTurbofan(fn) ? 'TurboFan' : %ActiveTierIsMaglev(fn) ? 'Maglev' : %ActiveTierIsSparkplug(fn) ? 'Sparkplug' : %ActiveTierIsIgnition(fn) ? 'Ignition' : undefined`;
    // oxlint-disable-next-line typescript/no-implied-eval
    const tier = new Function('fn', `return ${source}`) as (
      fn: Function
    ) => OptimizationTier | undefined;
    let frame: string | undefined;
    try {
      // Derive frame masks from a non-looping probe rather than fixed enum values.
      // oxlint-disable-next-line typescript/no-implied-eval
      const status = new Function('fn', 'return %GetOptimizationStatus(fn)');
      // oxlint-disable-next-line typescript/no-implied-eval
      const probe = new Function(
        'return function probe() { return %GetOptimizationStatus(probe); }'
      )();
      const masks = new Map<OptimizationTier, number>();
      for (let i = 0; i < 512; i++) {
        const before = tier(probe);
        const active = probe();
        const after = tier(probe);
        const mask = active & ~status(probe);
        if (before && before === after && mask) masks.set(before, mask);
      }
      frame = `%CurrentFrameIsTurbofan() ? 'TurboFan' : ${[...masks]
        .filter(([name]) => name !== 'TurboFan')
        .map(
          ([name, mask]) =>
            `(%GetOptimizationStatus(%GetFunctionForCurrentFrame()) & ${mask}) === ${mask} ? '${name}' : `
        )
        .join('')}undefined`;
      // oxlint-disable-next-line typescript/no-implied-eval
      new Function(`return ${frame}`);
    } catch {
      frame = undefined;
    }
    return {
      frame,
      tier(fn) {
        return isScript(fn) ? tier(fn) : undefined;
      },
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
