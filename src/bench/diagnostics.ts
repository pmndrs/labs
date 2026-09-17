import type { GcMode, Stats } from './types.ts';

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
