import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Stats } from '../src/bench/types.ts';
import {
  type SavedResult,
  deleteResult,
  listResults,
  loadResult,
  resultExists,
  saveResult,
  trimStats,
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

  it('chooses a readable unique name for repeated runs', () => {
    saveResult(labsDir, result('main'));
    expect(uniqueResultName(labsDir, 'main')).toBe('main-2');

    saveResult(labsDir, result('main-2'));
    expect(uniqueResultName(labsDir, 'main')).toBe('main-3');
  });

  it('saves the explicit sample stability field with its legacy alias', () => {
    const stats = {
      kind: 'fn',
      samples: [100],
      min: 100,
      max: 100,
      avg: 100,
      p25: 100,
      p50: 100,
      p75: 100,
      p99: 100,
      p999: 100,
      ticks: 1,
      debug: '',
      samplesUnstable: true,
    } satisfies Stats;

    expect(trimStats(stats)).toMatchObject({ samplesUnstable: true, noisy: true });
  });
});
