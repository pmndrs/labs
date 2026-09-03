import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bench, group, runTrialAt } from '../src/bench/main.ts';

const fast = { min_cpu_time: 1, min_samples: 12 } as const;

describe('runTrialAt', () => {
  it('addresses trials by global registration order across groups', async () => {
    let plainRan = 0;
    let groupedRan = 0;

    bench('plain', () => plainRan++);
    void group('a group', () => {
      bench('grouped first', () => 1);
      bench('grouped second', () => groupedRan++);
    });

    const trial = await runTrialAt(2, fast);

    expect(trial.alias).toBe('grouped second');
    expect(groupedRan).toBeGreaterThan(0);
    expect(plainRan).toBe(0);
    expect(trial.runs[0].stats?.samples.length).toBeGreaterThan(0);

    await expect(runTrialAt(3, fast)).rejects.toThrow(RangeError);
  });
});

describe('worker bench isolation', () => {
  const WORKER = fileURLToPath(new URL('../src/worker.ts', import.meta.url));
  const FIXTURE = fileURLToPath(new URL('./fixtures/isolation.bench.ts', import.meta.url));
  const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  let spawnCount = 0;

  function runWorker(env: Record<string, string>) {
    const resultFile = join(tmpdir(), `labs-isolation-test-${process.pid}-${spawnCount++}.json`);
    try {
      execFileSync(process.execPath, ['--import', TSX, WORKER], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          LABS_BENCH_FILE: pathToFileURL(FIXTURE).href,
          LABS_RESULT_FILE: resultFile,
          LABS_BLOCK_TIME: '1',
          LABS_MIN_SAMPLES: '12',
          ...env,
        },
      });
      return JSON.parse(readFileSync(resultFile, 'utf-8'));
    } finally {
      rmSync(resultFile, { force: true });
    }
  }

  it("keeps benches from observing each other's process state", { timeout: 60_000 }, () => {
    const result = runWorker({});
    const [polluter, victim] = result.benchmarks;

    expect(result.benchmarks).toHaveLength(2);
    expect(polluter.runs[0].stats.samples.length).toBeGreaterThan(0);
    expect(victim.runs[0].error).toBeUndefined();
    expect(victim.runs[0].stats.samples.length).toBeGreaterThan(0);
    expect(victim.groupName).toBe('isolation');
  });
});
