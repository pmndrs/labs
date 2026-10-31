import { describe, expect, it } from 'vitest';
import { compareJson, comparisonExitCode, runJson } from '../src/cli/json.ts';
import { compare } from '../src/compare.ts';
import { defineConfig } from '../src/config.ts';
import type { SavedResult } from '../src/store.ts';

const config = defineConfig({ benchDir: '.' });

function result(name: string, medians: number[], drift = 0): SavedResult {
  const samples = medians.flatMap((m) => [m * 0.99, m, m * 1.01]).sort((a, b) => a - b);
  return {
    name,
    timestamp: '2026-01-01T00:00:00.000Z',
    hardware: { cpu: 'test cpu', arch: 'arm64', runtime: 'node', freq: 4 },
    blocks: medians.length,
    environment: { freqs: [{ file: 'a.bench.ts', runFreq: 4, postFreq: 4 * (1 - drift) }] },
    files: [
      {
        file: 'a.bench.ts',
        benchmarks: [
          {
            alias: 'parse',
            group: 0,
            baseline: false,
            gcMode: true,
            kind: 'static',
            style: { compact: false, highlight: false },
            runs: [
              {
                name: 'parse',
                args: {},
                stats: {
                  kind: 'fn',
                  samples,
                  min: samples[0],
                  max: samples.at(-1)!,
                  avg: medians.reduce((a, b) => a + b, 0) / medians.length,
                  p25: samples[0],
                  p75: samples.at(-1)!,
                  p99: samples.at(-1)!,
                  blocks: { medians, freqs: medians.map(() => 4), spreads: medians.map(() => 0) },
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

const steady = [100, 100.4, 99.7, 100.2, 99.9, 100.1, 99.8, 100.3];
const scattered = [80, 130, 95, 120, 70, 110, 100, 90];

describe('agent output', () => {
  it('labels replay diagnostics and keeps performance verdicts independent of their cost', () => {
    const baseline = result('a', steady);
    const candidate = result('b', steady);
    for (const [i, run] of [baseline, candidate].entries()) {
      const stats = run.files[0].benchmarks[0].runs[0].stats!;
      stats.gc = {
        source: 'replay',
        total: 1000 * (i + 1),
        max: 1000,
        count: 1,
        minor: 0,
        major: 1,
        incremental: 0,
        weak: 0,
        other: 0,
        elapsed: 10000,
        timed: 10000,
        iterations: 10,
      };
      stats.heap = { min: 32, max: 64, p50: 32 * (i + 1), source: 'replay' };
    }
    expect(runJson(candidate, config, true).benches[0]).toMatchObject({
      gc: { source: 'replay' },
      heapBytes: { source: 'replay' },
    });
    const compared = compare(baseline, candidate, config);
    expect(compared.benches[0]).toMatchObject({
      kind: 'eligible',
      verdict: 'neutral',
      gc: { candidateStats: { source: 'replay' } },
      heap: { source: 'replay' },
    });
    const baselineGc = baseline.files[0].benchmarks[0].runs[0].stats!.gc!;
    if ('total' in baselineGc) delete baselineGc.source;
    delete baseline.files[0].benchmarks[0].runs[0].stats!.heap!.source;
    expect(compare(baseline, candidate, config).benches[0]).toMatchObject({
      kind: 'skipped',
      reason: 'GC observation during sampling differs between runs',
    });
    delete baseline.files[0].benchmarks[0].runs[0].stats!.gc;
    const mixed = compare(baseline, candidate, config).benches[0];
    expect(mixed.kind).toBe('eligible');
    if (mixed.kind === 'eligible') {
      expect(mixed.gc).toBeUndefined();
      expect(mixed.heap).toBeUndefined();
    }
  });

  it('refuses mixed sampling observation modes even when no collections occurred', () => {
    const baseline = result('a', steady);
    const candidate = result('b', steady);
    baseline.hardware.runtime = candidate.hardware.runtime = 'chrome';
    candidate.files[0].benchmarks[0].runs[0].stats!.gc = {
      total: 0,
      max: 0,
      count: 0,
      minor: 0,
      major: 0,
      incremental: 0,
      weak: 0,
      other: 0,
      elapsed: 10000,
      timed: 10000,
      iterations: 10,
    };
    for (const [a, b] of [
      [baseline, candidate],
      [candidate, baseline],
    ]) {
      expect(compare(a, b, config).benches[0]).toMatchObject({
        kind: 'skipped',
        reason: 'GC observation during sampling differs between runs',
      });
    }
    baseline.files[0].benchmarks[0].runs[0].stats!.gc = {
      ...candidate.files[0].benchmarks[0].runs[0].stats!.gc!,
    };
    expect(compare(baseline, candidate, config).benches[0]).toMatchObject({
      kind: 'eligible',
      verdict: 'neutral',
    });
  });

  it('reports each bench with the same judgment as the report screen', () => {
    const passed = runJson(result('a', steady), config, true);
    expect(passed).toMatchObject({ name: 'a', saved: true, environment: { stable: true } });
    expect(passed.benches[0]).toMatchObject({ name: 'parse', status: 'passed', problem: null });

    const noisy = runJson(result('b', scattered, 0.2), config, false);
    expect(noisy.environment.stable).toBe(false);
    expect(noisy.benches[0]).toMatchObject({
      status: 'warning',
      problem: 'imprecise',
      advice: 'add blocks',
    });
    expect(noisy.benches[0].minDetectableChange).toBeGreaterThan(config.minDelta);
  });

  it('calls a neutral comparison inconclusive when it could have missed a minDelta change', () => {
    const verdict = (candidate: number[]) =>
      compareJson(compare(result('a', steady), result('b', candidate), config), config)
        .benches[0] as { verdict: string };

    expect(verdict(steady).verdict).toBe('neutral');
    expect(verdict(scattered).verdict).toBe('inconclusive');
    expect(verdict(steady.map((m) => m * 1.2)).verdict).toBe('slower');
  });

  it.each([
    { name: 'no change', candidate: steady, flag: true, code: 0 },
    { name: 'slower without the flag', candidate: steady.map((m) => m * 1.2), flag: false, code: 0 },
    { name: 'slower', candidate: steady.map((m) => m * 1.2), flag: true, code: 1 },
    { name: 'inconclusive', candidate: scattered, flag: true, code: 2 },
    { name: 'unstable candidate', candidate: steady, drift: 0.2, flag: true, code: 2 },
  ])('exits $code for $name', ({ candidate, drift, flag, code }) => {
    const run = result('b', candidate, drift);
    const compared = compare(result('a', steady), run, config);
    expect(comparisonExitCode(compared, config, run, flag)).toBe(code);
  });
});
