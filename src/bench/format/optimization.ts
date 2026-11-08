import type { OptimizationSample, Stats } from '../types.ts';
import { samplingTiers } from '../diagnostics.ts';
import { median } from '../../stats.ts';
import { formatNs } from '../../utils/units.ts';

/** Keep times for different entry tiers separate when fresh processes disagree. */
export function formatOptimization(
  samples: Array<OptimizationSample | null>,
  unavailable = 'unavailable'
): string {
  const groups = new Map<string, Array<OptimizationSample | null>>();
  for (const sample of samples) {
    const key = sample?.tier ?? unavailable;
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

/** Describe verified sampling outcomes and available entry-tier diagnostics. */
export function optimizationRows(
  stats: Pick<Stats, 'kind' | 'optimization' | 'plan' | 'warmup'>
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const tiers = samplingTiers(stats.optimization);
  if (stats.optimization?.mode === 'prepared' || tiers.length > 1) {
    const tier = tiers.length > 1 ? 'Mixed' : tiers[0];
    return tier ? [{ label: 'warmup', value: tier }] : [];
  }
  if (stats.optimization?.mode === 'natural') {
    const { benchmark, workload, harness } = stats.optimization;
    const mode =
      stats.plan?.batch === true
        ? 'batched'
        : stats.plan?.batch === false
          ? 'unbatched'
          : 'mode not recorded';
    const missing =
      workload.some(Boolean) || harness?.some(Boolean) ? 'tier unverified' : 'tier unavailable';
    rows.push({
      label: 'sampling',
      value: `${mode} · ${formatOptimization(benchmark ?? workload.map(() => null), missing)} at start`,
    });
  } else if (stats.optimization) {
    const { workload, harness } = stats.optimization;
    rows.push(
      { label: 'fn entry', value: formatOptimization(workload) },
      {
        label: 'harness',
        value: harness
          ? `${formatOptimization(harness)} (batched)`
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
      value: `${formatNs(stats.warmup.time)} (${stats.warmup.phase ?? 'workload'} timings)${stats.warmup.blocks ? ` (${stats.warmup.blocks.settled}/${stats.warmup.blocks.total} blocks)` : ''}`,
    });
  else if (stats.optimization?.mode === 'natural')
    rows.push({ label: 'settled', value: 'not observed within warmup budget' });
  return rows;
}
