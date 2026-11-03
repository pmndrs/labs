import type { OptimizationSample, Stats } from '../types.ts';
import { median } from '../../stats.ts';
import { formatNs } from '../../utils/units.ts';

/** Keep times for different entry tiers separate when fresh processes disagree. */
export function formatOptimization(samples: Array<OptimizationSample | null>): string {
  const groups = new Map<string, Array<OptimizationSample | null>>();
  for (const sample of samples) {
    const key = sample?.tier ?? 'unavailable';
    const group = groups.get(key);
    if (group) group.push(sample);
    else groups.set(key, [sample]);
  }
  return [...groups]
    .map(([tier, group]) => {
      const times = group.flatMap((sample) => (sample ? [sample.time] : []));
      const value = times.length ? `${formatNs(median(times))} → ${tier}` : tier;
      return groups.size > 1 ? `${value} (${group.length}/${samples.length})` : value;
    })
    .join(' · ');
}

/** Interpret pre-sampling entry tiers without assuming that the workload was inlined. */
export function optimizationRows(
  stats: Pick<Stats, 'kind' | 'optimization' | 'plan' | 'warmup'>
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  if (stats.optimization) {
    const { workload, harness } = stats.optimization;
    const statuses = new Map<string, number>();
    for (const [index, sample] of workload.entries()) {
      let status = 'unavailable';
      if (sample) {
        const highest = ['Ignition', 'Sparkplug', 'Maglev', 'TurboFan'].includes(sample.tier)
          ? 'TurboFan'
          : 'FTL';
        if (stats.plan?.batch === false && stats.kind !== 'iter') {
          status = `${sample.tier} entry${sample.tier === highest ? '' : ` (below ${highest})`}`;
        } else if (sample.tier === highest && harness?.[index]?.tier === highest) {
          status = `${highest} entry`;
        } else {
          status = harness ? 'unverified (inlining not observed)' : 'unverified (entry only)';
        }
      }
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
    }
    rows.push(
      {
        label: 'bench tier',
        value: [...statuses]
          .map(([status, count]) =>
            statuses.size > 1 ? `${status} (${count}/${workload.length})` : status
          )
          .join(' · '),
      },
      { label: 'fn entry', value: formatOptimization(workload) },
      {
        label: 'harness',
        value: harness
          ? `${formatOptimization(harness)} (batched)`
          : stats.kind === 'iter'
            ? 'not used (iterator benchmark)'
            : stats.plan?.batch === false
              ? 'not warmed (unbatched, one call per sample)'
              : stats.plan?.batch === true
                ? 'not observed (batched)'
                : 'not recorded',
      }
    );
  }
  if (stats.warmup)
    rows.push({
      label: 'settled',
      value: `${formatNs(stats.warmup.time)} (workload timings)`,
    });
  return rows;
}
