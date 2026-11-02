import { formatNs } from '../../utils/units.ts';
import type { GcStats } from '../types.ts';

/** Amortized observed GC time across the complete sampling phase. */
export function observedGcCost(gc: GcStats): number | undefined {
  if (gc.iterations <= 0 || (!gc.count && gc.boundaryUncertain)) return;
  return gc.total / gc.iterations;
}

/** Keep collection activity distinct from other native GC event durations. */
export function gcLabel(gc?: GcStats, variant?: 'max' | 'perIteration'): string {
  let label = gc?.durationKind === 'collection' ? 'gc activity' : 'gc';
  if (variant === 'max') label += ' max';
  else if (variant === 'perIteration' && gc?.source !== 'replay' && gc?.durationKind !== 'collection')
    label += '/iter';
  return gc?.source === 'replay' ? `${label} replay` : label;
}

/** Format observed GC cost and its share of sampling wall time. */
export function formatGcCost(gc: GcStats): { avg: string; share: string } | undefined {
  const average = observedGcCost(gc);
  if (average === undefined || gc.elapsed <= 0) return;
  return {
    avg: average === 0 ? '0 ns' : formatNs(average),
    share: gc.total === 0 ? '0%' : `${((gc.total / gc.elapsed) * 100).toFixed(2)}%`,
  };
}

/** A report column with a heading, a headline value, and supporting detail. */
export interface GcColumn {
  heading: string;
  qualifier?: string;
  value: string;
  detail: string;
}

/** Amortized GC cost and the longest event, each with its supporting detail. */
export function formatGcColumns(gc: GcStats): GcColumn[] {
  const cost = formatGcCost(gc);
  return [
    {
      heading: gcLabel(gc),
      qualifier: cost?.share,
      value: cost?.avg ?? '—',
      detail: gc.count || gc.boundaryUncertain ? formatGcFrequency(gc) : '—',
    },
    {
      heading: gcLabel(gc, 'max'),
      // Only major is labeled since minor is the common case
      qualifier: gc.count && gc.maxKind === 'major' ? 'major' : undefined,
      value: gc.count ? formatNs(gc.max) : gc.boundaryUncertain ? '—' : '0 ns',
      detail: `${gc.major.toLocaleString('en-US')} major${gc.boundaryUncertain ? ` + ${gc.boundaryUncertain} uncertain` : ''}`,
    },
  ];
}

/** Average iterations between observed events, without implying a regular cadence. */
export function formatGcFrequency(gc: GcStats): string {
  if (gc.count === 0)
    return gc.boundaryUncertain ? `${gc.boundaryUncertain} boundary uncertain` : 'none observed';
  if (gc.iterations <= 0) return 'unavailable';
  if (gc.count > gc.iterations)
    return `${(gc.count / gc.iterations).toLocaleString('en-US', { maximumFractionDigits: 2 })} gc / iter`;
  return `1 gc / ${(gc.iterations / gc.count).toLocaleString('en-US', { maximumFractionDigits: 0 })} iter`;
}

/** Largest recorded event and its kind. */
export function formatGcSpike(gc: GcStats): string {
  if (gc.count === 0) return '—';
  return `max ${formatNs(gc.max)}${gc.maxKind ? ` ${gc.maxKind}` : ''}`;
}

/** Major events observed and average event frequency. */
export function formatGcCounts(gc: GcStats): string {
  if (gc.count === 0) return formatGcFrequency(gc);
  return `${gc.major} major ✦ ${formatGcFrequency(gc)}${gc.boundaryUncertain ? ` ✦ ${gc.boundaryUncertain} boundary uncertain` : ''}`;
}

/** Compact GC event summary for printed and comparison reports. */
export function formatGcEvents(gc: GcStats): string {
  if (gc.count === 0) return formatGcFrequency(gc);
  return `${formatGcSpike(gc)} ✦ ${formatGcCounts(gc)}`;
}
