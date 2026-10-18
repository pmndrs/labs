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
