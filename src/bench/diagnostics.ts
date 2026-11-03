import type { GcMode, OptimizationStats, OptimizationTier, Stats } from './types.ts';

/** Compare timings with the empty benchmark measured in the same mode. */
export function isLikelyOptimizedOut(
  stats: Pick<Stats, 'kind' | 'avg'>,
  gcMode: GcMode,
  noop?: Partial<Record<'fn' | 'iter' | 'fn_gc', Pick<Stats, 'avg'>>>
): boolean {
  const mode =
    stats.kind === 'iter' ? 'iter' : gcMode === true || gcMode === 'inner' ? 'fn_gc' : 'fn';
  return stats.avg < 1.42 * (noop?.[mode]?.avg ?? 0);
}

/** Compare the verified endpoints of each block before combining their warnings. */
export function lateOptimizationWarning(optimization?: OptimizationStats): string | undefined {
  if (!optimization?.benchmarkEnd || !optimization.benchmark) return;
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
  const changes = new Map<string, number>();
  for (const [index, end] of optimization.benchmarkEnd.entries()) {
    const start = optimization.benchmark[index]?.tier;
    if (start && end && ranks[end] > ranks[start]) {
      const transition = `${start} → ${end}`;
      changes.set(transition, (changes.get(transition) ?? 0) + 1);
    }
  }
  if (!changes.size) return;
  const total = optimization.benchmark.length;
  const detail = [...changes]
    .map(([transition, count]) =>
      total === 1 ? transition : `${transition} (${count}/${total} blocks)`
    )
    .join(' · ');
  return `tier rose during sampling · ${detail}`;
}
