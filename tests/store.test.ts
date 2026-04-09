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
} from '../src/store.ts';

function stubResult(name: string): SavedResult {
  return {
    name,
    timestamp: new Date().toISOString(),
    hardware: { cpu: 'test', arch: 'arm64', runtime: 'node', freq: 3.2 },
    files: [],
  };
}

describe('resultExists', () => {
  let labsDir: string;

  beforeEach(() => {
    labsDir = mkdtempSync(join(tmpdir(), 'labs-test-'));
  });

  afterEach(() => {
    rmSync(labsDir, { recursive: true, force: true });
  });

  it('returns false when no result exists', () => {
    expect(resultExists(labsDir, 'nope')).toBe(false);
  });

  it('returns true after saving a result', () => {
    saveResult(labsDir, stubResult('my-run'));
    expect(resultExists(labsDir, 'my-run')).toBe(true);
  });

  it('returns false for a different name', () => {
    saveResult(labsDir, stubResult('my-run'));
    expect(resultExists(labsDir, 'other')).toBe(false);
  });

  it('returns false after deleting a result', () => {
    saveResult(labsDir, stubResult('my-run'));
    deleteResult(labsDir, 'my-run');
    expect(resultExists(labsDir, 'my-run')).toBe(false);
  });

  it('overwrite: saveResult replaces existing data', () => {
    const original = stubResult('my-run');
    original.hardware.cpu = 'cpu-v1';
    saveResult(labsDir, original);

    const updated = stubResult('my-run');
    updated.hardware.cpu = 'cpu-v2';
    saveResult(labsDir, updated);

    expect(resultExists(labsDir, 'my-run')).toBe(true);
    const loaded = loadResult(labsDir, 'my-run');
    expect(loaded.hardware.cpu).toBe('cpu-v2');
    expect(listResults(labsDir)).toHaveLength(1);
  });
});
