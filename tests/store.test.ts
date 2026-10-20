import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type SavedResult,
  deleteResult,
  listResults,
  loadResult,
  resultExists,
  saveResult,
  uniqueResultName,
} from '../src/store.ts';

function result(name: string): SavedResult {
  return {
    name,
    timestamp: new Date().toISOString(),
    git: { commit: 'a'.repeat(40), branch: 'main', dirty: true },
    hardware: { cpu: 'test', arch: 'arm64', runtime: 'node', freq: 3.2 },
    files: [],
  };
}

describe('saved benchmark results', () => {
  let labsDir: string;

  beforeEach(() => {
    labsDir = mkdtempSync(join(tmpdir(), 'labs-test-'));
  });

  afterEach(() => {
    rmSync(labsDir, { recursive: true, force: true });
  });

  it('supports the save, discover, load, and delete lifecycle', () => {
    const saved = result('main');

    expect(resultExists(labsDir, saved.name)).toBe(false);
    saveResult(labsDir, saved);

    expect(resultExists(labsDir, saved.name)).toBe(true);
    expect(listResults(labsDir).map((item) => item.name)).toEqual(['main']);
    expect(loadResult(labsDir, saved.name)).toEqual(saved);

    deleteResult(labsDir, saved.name);
    expect(resultExists(labsDir, saved.name)).toBe(false);
    expect(listResults(labsDir)).toEqual([]);
  });

  it('replaces an existing result when saving under the same name', () => {
    saveResult(labsDir, result('main'));

    const replacement = result('main');
    replacement.hardware.cpu = 'new cpu';
    saveResult(labsDir, replacement);

    expect(listResults(labsDir)).toHaveLength(1);
    expect(loadResult(labsDir, 'main').hardware.cpu).toBe('new cpu');
  });

  it.each([
    {
      name: 'observed GC',
      gc: {
        total: 6,
        max: 4,
        count: 2,
        minor: 1,
        major: 1,
        incremental: 0,
        weak: 0,
        other: 0,
        elapsed: 1000,
        timed: 900,
        iterations: 20,
        overlap: { min: 0, max: 6 },
      },
    },
    { name: 'legacy forced GC', gc: { min: 1, max: 3, p50: 2 } },
  ])('preserves $name data when reopening a saved result', ({ gc }) => {
    const saved = result('gc');
    saved.files.push({
      file: 'work.bench.ts',
      benchmarks: [
        {
          alias: 'work',
          group: 0,
          baseline: false,
          gcMode: true,
          kind: 'static',
          style: { compact: false, highlight: false },
          runs: [
            {
              name: 'work',
              args: {},
              stats: {
                kind: 'fn',
                samples: [10],
                min: 10,
                max: 10,
                avg: 10,
                p25: 10,
                p75: 10,
                p99: 10,
                gc,
              },
            },
          ],
        },
      ],
    });

    saveResult(labsDir, saved);

    expect(loadResult(labsDir, 'gc').files[0].benchmarks[0].runs[0].stats?.gc).toEqual(gc);
  });

  it('chooses a readable unique name for repeated runs', () => {
    saveResult(labsDir, result('main'));
    expect(uniqueResultName(labsDir, 'main')).toBe('main-2');

    saveResult(labsDir, result('main-2'));
    expect(uniqueResultName(labsDir, 'main')).toBe('main-3');
  });
});
