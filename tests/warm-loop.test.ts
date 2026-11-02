import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Timing guarantees for the batched sampling loop under the worker, which runs
 * every block in a fresh process the way the CLI does. A loop entered cold used
 * to spend its first hundred or so samples a magnitude slower while V8
 * re-tiered it, enough to carry the median of a short block.
 */
describe('sampling loop warm-up', () => {
  const WORKER = fileURLToPath(new URL('../src/worker.ts', import.meta.url));
  const FIXTURE = fileURLToPath(new URL('./fixtures/warm-loop.bench.ts', import.meta.url));
  const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

  it('keeps every block of a short run at the optimized speed', { timeout: 120_000 }, () => {
    const resultFile = join(tmpdir(), `labs-warm-loop-test-${process.pid}.json`);
    try {
      // The CLI runs workers with natives syntax, which the forced compile needs
      execFileSync(
        process.execPath,
        ['--allow-natives-syntax', '--expose-gc', '--import', TSX, WORKER],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
          env: {
            ...process.env,
            LABS_BENCH_FILE: pathToFileURL(FIXTURE).href,
            LABS_RESULT_FILE: resultFile,
            LABS_BLOCKS: '8',
            LABS_BLOCK_TIME: String(0.2e9),
          },
        }
      );
      const result = JSON.parse(readFileSync(resultFile, 'utf-8'));
      const stats = Object.fromEntries(
        result.benchmarks.map((trial: any) => [trial.alias, trial.runs[0].stats])
      );
      for (const [name, bench] of Object.entries<any>(stats)) {
        const medians: number[] = bench.blocks.medians;
        const p50 = [...bench.samples].sort((a: number, b: number) => a - b)[
          bench.samples.length >> 1
        ];
        // A block whose loop re-tiered mid-recording reports a median five or more times higher
        expect(Math.max(...medians) / Math.min(...medians), name).toBeLessThan(2);
        // Samples from a slower tier are a small tail at most
        const slow = bench.samples.filter((x: number) => x > 2 * p50).length;
        expect(slow / bench.samples.length, name).toBeLessThan(0.03);
      }
      // The long loop runs a hundred times the work of the fast one, and a loop left at a
      // lower tier would fall several times short of that
      const scale = stats.long.p50 / stats.fast.p50;
      expect(scale).toBeGreaterThan(70);
      expect(scale).toBeLessThan(130);
    } finally {
      rmSync(resultFile, { force: true });
    }
  });
});
