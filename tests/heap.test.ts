import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadResult } from '../src/store.ts';

describe('configured heap diagnostics', () => {
  it.each([
    { name: 'enabled by default', config: {} },
    { name: 'disabled', config: { heap: false } },
  ])('saves complete timing blocks with heap diagnostics $name', ({ config }) => {
    const project = mkdtempSync(join(tmpdir(), 'labs-heap-'));
    try {
      writeFileSync(join(project, 'package.json'), JSON.stringify({ type: 'module' }));
      writeFileSync(
        join(project, 'labs.config.ts'),
        `import { defineConfig } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
        export default defineConfig(${JSON.stringify({
          benchDir: '.',
          blockTime: 1e-9,
          minSamples: 2,
          blocks: 2,
          ...config,
        })});`
      );
      writeFileSync(
        join(project, 'work.bench.ts'),
        `import { bench } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
        bench('function', () => new Uint8Array(1024));
        bench('generator', function* () { yield () => new Uint8Array(1024); });
        bench('parameterized $size', function* (state) {
          const size = state.get('size');
          yield () => new Uint8Array(size);
        }).args('size', [1024, 2048]);`
      );

      const output = execFileSync(
        process.execPath,
        [
          '--import',
          pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
          fileURLToPath(new URL('../src/cli/cli.ts', import.meta.url)),
          '--json',
          '-n',
          'heap-test',
        ],
        {
          cwd: project,
          stdio: 'pipe',
          encoding: 'utf8',
          timeout: 20_000,
          env: { ...process.env, LABS_HEAP: '0' },
        }
      );

      const result = loadResult(join(project, '.labs'), 'heap-test');
      const report = JSON.parse(output);
      expect(report.saved).toBe(true);
      expect(report.benches).toHaveLength(4);
      for (const bench of report.benches) expect(bench.gc).toHaveProperty('events');
      expect(result.blocks).toBe(2);
      expect(result.files[0].benchmarks).toHaveLength(3);
      const runs = result.files[0].benchmarks.flatMap((trial) => trial.runs);
      expect(runs).toHaveLength(4);
      for (const run of runs) {
        expect(run.error).toBeUndefined();
        expect(run.stats?.samples).toHaveLength(4);
        expect(run.stats?.blocks?.medians).toHaveLength(2);
        if ('heap' in config) expect(run.stats?.heap).toBeUndefined();
        else expect(run.stats?.heap).toHaveProperty('p50');
      }
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
