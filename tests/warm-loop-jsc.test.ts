import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { webkit } from 'playwright-core';
import { afterEach, describe, expect, it } from 'vitest';
import { loadResult } from '../src/store.ts';

/** Separate sink slots keep JSC from dropping earlier calls in an unrolled batch. */
describe('sampling loop warm-up on JavaScriptCore', () => {
  const bun = spawnSync(process.env.LABS_BUN_EXECUTABLE ?? 'bun', ['-p', 'process.execPath'], {
    encoding: 'utf8',
  });
  const runtimes = [
    ['bun', bun.status === 0, { bun: { executablePath: bun.stdout?.trim() } }],
    ['webkit', existsSync(webkit.executablePath()), {}],
  ] as const;
  let project: string;

  afterEach(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  it.each(runtimes.filter(([, available]) => available))(
    'keeps every block of a short %s run at the optimized speed',
    { timeout: 180_000 },
    (runtime, _available, extra) => {
      project = mkdtempSync(join(tmpdir(), `labs-warm-loop-${runtime}-`));
      writeFileSync(join(project, 'package.json'), '{"type":"module"}');
      writeFileSync(
        join(project, 'labs.config.ts'),
        `import { defineConfig } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
        export default defineConfig(${JSON.stringify({
          benchDir: '.',
          runtime,
          blocks: 4,
          blockTime: 0.2,
          heap: false,
          ...extra,
        })});`
      );
      // Sub-microsecond batched work, the shape most exposed to the loop's tier,
      // plus the same loop a hundred times longer. The closures share one source
      // so the engine sees the shape the fixture in warm-loop.test.ts exercises.
      writeFileSync(
        join(project, 'work.bench.ts'),
        `import { bench } from '@pmndrs/labs';
        for (const [name, n] of [['fast', 300], ['fast scaled', 330], ['long', 30_000]] as const) {
          bench(name, () => {
            let s = 0;
            for (let i = 0; i < n; i++) s += Math.sqrt(i);
            return s;
          });
        }`
      );
      const output = spawnSync(
        process.execPath,
        [
          '--import',
          pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
          fileURLToPath(new URL('../src/cli/cli.ts', import.meta.url)),
          '--json',
          '-n',
          'warm-loop',
        ],
        { cwd: project, encoding: 'utf8', timeout: 170_000 }
      );
      expect(output.status, output.stderr || output.error?.message).toBe(0);
      const stats = Object.fromEntries(
        loadResult(join(project, '.labs'), 'warm-loop').files[0].benchmarks.map((trial) => [
          trial.alias,
          trial.runs[0].stats!,
        ])
      );
      for (const name of ['fast', 'fast scaled']) {
        const bench = stats[name];
        expect(
          bench.optimization?.harness?.every((sample) => sample?.tier === 'FTL'),
          name
        ).toBe(true);
      }
      // The same loop body costs the same per iteration whether or not the
      // engine inlined it. Dropped work shows as a fast tier over twice as cheap.
      const perIteration = (name: string, n: number) =>
        [...stats[name].samples].sort((a, b) => a - b)[stats[name].samples.length >> 1] / n;
      const ratio = perIteration('fast', 300) / perIteration('long', 30_000);
      const scaled = (perIteration('fast scaled', 330) * 330) / (perIteration('fast', 300) * 300);
      expect(ratio).toBeGreaterThan(0.7);
      expect(ratio).toBeLessThan(1.3);
      expect(scaled).toBeGreaterThan(1.05);
      expect(scaled).toBeLessThan(1.15);
    }
  );
});
