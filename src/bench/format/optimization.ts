import type { OptimizationSample } from '../types.ts';
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
