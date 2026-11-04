import type { OptimizationSample, OptimizationTier } from '../types.ts';
import { dollar_vm } from './runtime.ts';

/** Workload entry tiers and probes for the executing sampling frame. */
export const optimization:
  | {
      tier(fn: Function): OptimizationTier | undefined;
      turboFan?: { prepare(fn: Function): boolean; compile(fn: Function): boolean };
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
    function request(source: string) {
      try {
        // oxlint-disable-next-line typescript/no-implied-eval
        const invoke = new Function('fn', source) as (fn: Function) => boolean | undefined;
        return (fn: Function) => {
          if (!isScript(fn)) return false;
          try {
            return invoke(fn) !== false;
          } catch {
            return false;
          }
        };
      } catch {
        return undefined;
      }
    }
    // Chrome's V8 has dropped the asm.js probe, and a source naming a missing
    // runtime function fails to parse, so that guard is used only where it exists
    const prepare =
      request(
        'if (!%IsTurbofanEnabled() || %IsAsmWasmCode(fn)) return false; %EnsureFeedbackVectorForFunction(fn);'
      ) ?? request('if (!%IsTurbofanEnabled()) return false; %EnsureFeedbackVectorForFunction(fn);');
    // The synchronous compiler can decline a function with optimization disabled.
    const compile = request('if (!%ActiveTierIsTurbofan(fn)) %BenchTurbofan(fn, 1);');
    let frame: string | undefined;
    try {
      // Separate frame markers from temporary compiler state.
      // oxlint-disable-next-line typescript/no-implied-eval
      const status = new Function('fn', 'return %GetOptimizationStatus(fn)');
      const masks = new Map<OptimizationTier, number>();
      for (const [name, body, setup] of [
        ['Ignition', '', '%NeverOptimizeFunction(fn);'],
        ['Sparkplug', '%BaselineOsr();', '%NeverOptimizeFunction(fn);'],
        [
          'Maglev',
          '',
          'if (%IsMaglevEnabled()) { %PrepareFunctionForOptimization(fn); fn(); %OptimizeMaglevOnNextCall(fn); }',
        ],
        ['Natural', '', ''],
      ]) {
        if (name === 'Natural' && masks.has('Sparkplug')) continue;
        try {
          // oxlint-disable-next-line typescript/no-implied-eval
          const probe = new Function(
            `return function probe${name}() { ${body} return %GetOptimizationStatus(probe${name}); }`
          )();
          // oxlint-disable-next-line typescript/no-implied-eval
          new Function('fn', setup)(probe);
          probe();
          for (let i = 0; i < (name === 'Natural' ? 512 : 8); i++) {
            const before = tier(probe);
            const inactive = status(probe);
            const active = probe();
            const after = status(probe);
            const mask = active & ~(inactive | after);
            if (before && before === tier(probe) && mask)
              masks.set(before, (masks.get(before) ?? mask) & mask);
          }
        } catch {}
      }
      frame = `%CurrentFrameIsTurbofan() ? 'TurboFan' : ${[...masks]
        .filter(([name]) => name !== 'TurboFan')
        .map(([name, mask]) => {
          for (const [other, bits] of masks) if (other !== name) mask &= ~bits;
          return mask
            ? `(%GetOptimizationStatus(%GetFunctionForCurrentFrame()) & ${mask}) === ${mask} ? '${name}' : `
            : '';
        })
        .join('')}undefined`;
      // oxlint-disable-next-line typescript/no-implied-eval
      new Function(`return ${frame}`);
    } catch {
      frame = undefined;
    }
    return {
      frame,
      turboFan: prepare && compile ? { prepare, compile } : undefined,
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
