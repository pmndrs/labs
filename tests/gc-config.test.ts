import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadResult } from '../src/store.ts';

describe('configured GC observation', () => {
  it.each([
    { name: 'enabled by default', config: {}, observed: true },
    {
      name: 'disabled globally while keeping heap diagnostics',
      config: { gc: false, heap: true },
      observed: false,
    },
    {
      name: 'disabled for Node',
      config: { runtime: 'chrome', gc: { node: false, chrome: true } },
      observed: false,
    },
    {
      name: 'enabled for Node',
      config: { runtime: 'chrome', gc: { node: true, chrome: false } },
      observed: true,
    },
    { name: 'enabled when Node is unspecified', config: { gc: { chrome: false } }, observed: true },
  ])('$name', ({ config, observed }) => {
    const project = mkdtempSync(join(tmpdir(), 'labs-gc-config-'));
    try {
      writeFileSync(join(project, 'package.json'), '{"type":"module"}');
      writeFileSync(
        join(project, 'labs.config.ts'),
        `import { defineConfig } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
        export default defineConfig(${JSON.stringify({
          benchDir: '.',
          blocks: 2,
          blockTime: 1e-9,
          minSamples: 2,
          heap: false,
          ...config,
        })});`
      );
      writeFileSync(
        join(project, 'work.bench.ts'),
        `import { bench } from '@pmndrs/labs';
        bench('function', () => { gc(); return 1; });
        bench('argument $value', function* (state) {
          const value = state.get('value');
          yield () => { gc(); return value; };
        }).args('value', [1, 2]);
        bench('disabled', () => { gc(); return 1; }).gc(false);`
      );
      const output = execFileSync(
        process.execPath,
        [
          '--import',
          pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
          fileURLToPath(new URL('../src/cli/cli.ts', import.meta.url)),
          '--runtime',
          'node',
          '--json',
          '-n',
          'gc-config',
        ],
        {
          cwd: project,
          stdio: 'pipe',
          encoding: 'utf8',
          timeout: 20_000,
          env: { ...process.env, LABS_GC: '0' },
        }
      );
      const saved = loadResult(join(project, '.labs'), 'gc-config');
      expect(saved.hardware.runtime).toBe('node');
      const report = JSON.parse(output);
      expect(report.benches).toHaveLength(4);
      for (const trial of saved.files[0].benchmarks) {
        const enabled = observed && trial.alias !== 'disabled';
        expect(trial.gcMode).toBe(enabled);
        for (const run of trial.runs) {
          expect(run.error).toBeUndefined();
          expect(run.stats?.blocks?.medians).toHaveLength(2);
          expect(run.stats?.samples.length).toBeGreaterThan(0);
          if (enabled) expect(run.stats?.gc).toMatchObject({ major: expect.any(Number) });
          else expect(run.stats?.gc).toBeUndefined();
          if ('heap' in config && config.heap) expect(run.stats?.heap).toHaveProperty('p50');
        }
      }
      for (const bench of report.benches) {
        if (observed && bench.name !== 'disabled') expect(bench.gc.major).toBeGreaterThan(0);
        else expect(bench.gc).toBeNull();
      }
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
