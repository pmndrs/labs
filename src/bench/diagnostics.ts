import type { GcMode, OptimizationStats, OptimizationTier, Stats } from './types.ts';

/** Compare timings with the empty benchmark measured in the same mode. */
export function isLikelyOptimizedOut(
  stats: Pick<Stats, 'kind' | 'avg'>,
  gcMode: GcMode,
  noop?: Partial<Record<'fn' | 'iter' | 'fn_gc', Pick<Stats, 'avg'>>>
): boolean {
  if (stats.kind === 'gpu') return false;
  const mode =
    stats.kind === 'iter' ? 'iter' : gcMode === true || gcMode === 'inner' ? 'fn_gc' : 'fn';
  return stats.avg < 1.42 * (noop?.[mode]?.avg ?? 0);
}

/** Only a verified increase between endpoints is a promotion. */
export function isTierPromotion(
  start: OptimizationTier | null | undefined,
  end: OptimizationTier | null | undefined
): boolean {
  const ranks: Record<OptimizationTier, number> = {
    Ignition: 0,
    Sparkplug: 1,
    Maglev: 2,
    TurboFan: 3,
    LLInt: 0,
    Baseline: 1,
    DFG: 2,
    FTL: 3,
  };
  return !!start && !!end && ranks[end] > ranks[start];
}

export function lateOptimizationWarning(optimization?: OptimizationStats): string | undefined {
  if (!optimization?.benchmarkEnd) return;
  for (const [index, end] of optimization.benchmarkEnd.entries()) {
    const start = optimization.benchmark?.[index]?.tier;
    if (isTierPromotion(start, end)) return `${start} → ${end}`;
  }
}

/** Count verified endpoint pairs. Single observations cannot establish a split. */
export function samplingTiers(optimization: Stats['optimization']) {
  const groups = new Map<string, number>();
  const observed = new Set<string>();
  for (
    let index = 0;
    index < Math.max(optimization?.benchmark?.length ?? 0, optimization?.benchmarkEnd?.length ?? 0);
    index++
  ) {
    const start = optimization?.benchmark?.[index]?.tier;
    const end = optimization?.benchmarkEnd?.[index];
    const tier = start ?? end;
    if (!tier) continue;
    observed.add(tier);
    const deopt = optimization?.deoptimized?.[index];
    if ((!start || !end) && !deopt) continue;
    const pair = start && end && start !== end ? `${start} → ${end}` : tier;
    const label = deopt ? `${pair} (${deopt === 'harness' ? 'loop deopt' : 'deopt'})` : pair;
    groups.set(label, (groups.get(label) ?? 0) + 1);
  }
  if (groups.size > 1)
    return [...groups].sort((a, b) => b[1] - a[1]).map(([label, count]) => `${label} ×${count}`);
  const summary =
    [...groups.keys()].find((label) => label.includes('deopt')) ??
    lateOptimizationWarning(optimization) ??
    [...groups.keys()].find((label) => label.includes(' → ')) ??
    [...observed].join(' / ');
  return summary ? [summary] : [];
}

export function samplingWarning(stats?: Pick<Stats, 'optimization'>) {
  const optimization = stats?.optimization;
  const tiers = samplingTiers(optimization);
  if (tiers.length > 1) return { problem: 'mixed-tiers', message: tiers.join(' · ') } as const;
  if (optimization?.deoptimized?.includes('workload'))
    return { problem: 'deoptimized', message: 'TurboFan deoptimized during sampling' } as const;
  if (optimization?.deoptimized?.includes('harness'))
    return { problem: 'deoptimized', message: 'Sampling loop deoptimized during timing' } as const;
  const promotion = lateOptimizationWarning(optimization);
  if (promotion) return { problem: 'late-optimization', message: promotion } as const;
  if (optimization?.mode !== 'prepared') return;
  for (const [index, end] of (optimization.benchmarkEnd ?? []).entries()) {
    const start = optimization?.benchmark?.[index]?.tier;
    if (isTierPromotion(end, start))
      return { problem: 'tier-drop', message: `${start} → ${end}` } as const;
  }
  if (
    optimization.target === 'TurboFan' &&
    optimization.benchmark?.some((s) => s && s.tier !== 'TurboFan')
  )
    return {
      problem: 'target-not-reached',
      message: 'TurboFan not reached before sampling',
    } as const;
  if (
    optimization.target === 'TurboFan' &&
    optimization.workload.some((s, i) => s && s.tier !== 'TurboFan' && !optimization.benchmark?.[i])
  ) {
    return {
      problem: 'target-not-reached',
      message: 'Workload entry did not reach TurboFan',
    } as const;
  }
}
