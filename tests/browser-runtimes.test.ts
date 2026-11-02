import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { firefox, webkit } from 'playwright-core';
import { afterEach, describe, expect, it } from 'vitest';
import { defineConfig } from '../src/config.ts';
import { renderRunView } from '../src/cli/run-view.ts';
import { loadResult } from '../src/store.ts';
import { toSnapshot } from '../src/bench/lib/snapshot.ts';

describe.each([
  ['firefox', 'Firefox', firefox],
  ['webkit', 'WebKit', webkit],
] as const)('%s benchmarks', (runtime, label, engine) => {
  let project: string;

  afterEach(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  function setup(source: string, config: Record<string, unknown> = {}) {
    project = mkdtempSync(join(tmpdir(), `labs-${runtime}-`));
    writeFileSync(join(project, 'package.json'), '{"type":"module"}');
    writeFileSync(
      join(project, 'labs.config.ts'),
      `import { defineConfig } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
      export default defineConfig(${JSON.stringify({
        benchDir: '.',
        runtime,
        blockTime: 1e-9,
        minSamples: 3,
        blocks: 2,
        ...config,
      })});`
    );
    writeFileSync(join(project, 'work.bench.ts'), source);
  }

  function run(...args: string[]) {
    return spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
        fileURLToPath(new URL('../src/cli/cli.ts', import.meta.url)),
        '--json',
        '-n',
        'browser-test',
        ...args,
      ],
      { cwd: project, encoding: 'utf8', timeout: 60_000 }
    );
  }

  it.skipIf(!existsSync(engine.executablePath()))(
    'runs DOM benchmarks in fresh processes with frozen plans and native GC diagnostics',
    { timeout: 60_000 },
    () => {
      setup(
        `import { assert, bench, group } from '@pmndrs/labs';
        globalThis.Uint8Array = new Proxy(Uint8Array, {
          construct(target, args) {
            assert(typeof args[0] !== 'number' || args[0] < 64 * 1024 * 1024, 'unexpected large harness allocation');
            return Reflect.construct(target, args);
          },
        });
        group('dom @browser', () => {
          bench('polluter', () => { document.body.dataset.polluted = 'yes'; return 1; });
          bench('element $text', async function* (state) {
            assert(!document.body.dataset.polluted);
            assert(globalThis.crossOriginIsolated);
            assert(typeof globalThis.__LABS_GC_OBSERVER === 'function');
            const element = document.createElement('div');
            element.textContent = state.get('text');
            document.body.append(element);
            const result = yield async () => element.textContent.toUpperCase();
            assert.equal(result, state.get('text').toUpperCase());
            return result;
          }).args('text', ['one', 'two']);
          bench('iterator', state => { for (const _ of state) document.body.tagName; }).gc(false);
        });
        bench('filtered @other', () => { throw new Error('unexpected benchmark'); });`,
        { runtime: 'node' }
      );
      const output = run('--runtime', runtime, '@browser');
      expect(output.status, output.stderr || output.error?.message).toBe(0);
      const report = JSON.parse(output.stdout);
      expect(report.crashes).toEqual([]);
      expect(report.benches).toHaveLength(4);
      for (const row of report.benches) {
        expect(row.timeNs.avg).toBeGreaterThan(0);
        if (row.name === 'iterator') expect(row.gc).toBeNull();
        else expect(row.gc).toHaveProperty('events', expect.any(Number));
        expect(row.heapBytes).toBeNull();
      }
      const saved = loadResult(join(project, '.labs'), 'browser-test');
      expect(saved.hardware.runtime).toBe(runtime);
      expect(saved.files[0].context?.version).toMatch(/^\d+\./);
      const trials = saved.files[0].benchmarks;
      expect(trials[1].runs.map((run) => run.stats?.snapshot)).toEqual(
        ['ONE', 'TWO'].map(toSnapshot)
      );
      expect(trials[0].gcMode).toBe(true);
      expect(trials[2].gcMode).toBe(false);
      for (const trial of trials) {
        expect(trial.groupName).toBe('dom');
        for (const run of trial.runs) {
          expect(run.error).toBeUndefined();
          expect(run.stats?.blocks?.medians).toHaveLength(2);
          expect(run.stats?.samples).toHaveLength(run.stats!.plan!.samples * 2);
          expect(run.stats!.plan!.batch_samples).toBeGreaterThan(1);
          if (trial.gcMode) {
            expect(run.stats?.gc).toHaveProperty('count');
            if (runtime === 'webkit')
              expect(run.stats?.gc).toHaveProperty('durationKind', 'collection');
            else expect(run.stats?.gc).not.toHaveProperty('durationKind');
          } else expect(run.stats?.gc).toBeUndefined();
        }
      }
      expect(
        renderRunView(saved, defineConfig({ benchDir: '.' }), {
          columns: 100,
          rows: 30,
          selected: 0,
          detailOffset: 0,
          colors: false,
        }).lines.join('\n')
      ).toContain(label);
    }
  );

  it.skipIf(!existsSync(engine.executablePath()))(
    'selects the runtime from config and preserves correctness failures',
    { timeout: 60_000 },
    () => {
      setup(
        `import { assert, bench } from '@pmndrs/labs';
        bench('wrong', function* () { yield () => 42; assert(false, 'BROWSER_ASSERT'); });
        bench('iterator', state => { for (const _ of state) Math.sqrt(2); assert(false, 'BROWSER_ITERATOR_ASSERT'); });
        bench('good', () => document.createElement('div').tagName);`,
        {}
      );
      const output = run();
      expect(output.status, output.stderr).toBe(1);
      const report = JSON.parse(output.stdout);
      expect(report.crashes).toEqual([]);
      expect(report.benches[0]).toMatchObject({ status: 'failed', message: 'BROWSER_ASSERT' });
      expect(report.benches[1]).toMatchObject({
        status: 'failed',
        message: 'BROWSER_ITERATOR_ASSERT',
      });
      expect(report.benches[2].timeNs.avg).toBeGreaterThan(0);
    }
  );

  it.skipIf(!existsSync(engine.executablePath()))(
    'observes natural minor collections from allocating workloads',
    { timeout: 60_000 },
    () => {
      setup(
        `import { bench } from '@pmndrs/labs';
        bench('allocations', function* () {
          const history = Array(64);
          let cursor = 0;
          yield () => {
            history[cursor++ % history.length] = Array.from({ length: 2048 }, (_, i) => ({ x: i, y: cursor, z: i * 2 }));
            return 2048;
          };
        });`,
        { heap: false, blockTime: 0.1, minSamples: 30 }
      );
      const output = run();
      expect(output.status, output.stderr).toBe(0);
      const gc = JSON.parse(output.stdout).benches[0].gc;
      expect(gc.events).toBeGreaterThan(0);
      expect(gc.perIterationNs).toBeGreaterThan(0);
      const saved = loadResult(join(project, '.labs'), 'browser-test');
      expect(saved.files[0].benchmarks[0].runs[0].stats?.gc).toHaveProperty(
        'minor',
        expect.any(Number)
      );
      expect(
        (saved.files[0].benchmarks[0].runs[0].stats!.gc as { minor: number }).minor
      ).toBeGreaterThan(0);
    }
  );

  it.skipIf(!existsSync(engine.executablePath()))(
    'disables native observation for the configured runtime',
    { timeout: 60_000 },
    () => {
      setup(
        `import { assert, bench } from '@pmndrs/labs';
        bench('disabled', function* () {
          assert(typeof globalThis.__LABS_GC_OBSERVER === 'undefined');
          yield () => document.body.tagName;
        });`,
        { gc: { [runtime]: false } }
      );
      const output = run();
      expect(output.status, output.stderr).toBe(0);
      expect(JSON.parse(output.stdout).benches[0].gc).toBeNull();
      const saved = loadResult(join(project, '.labs'), 'browser-test');
      expect(saved.files[0].benchmarks[0].gcMode).toBe(false);
    }
  );

  it.skipIf(!existsSync(engine.executablePath()))(
    'fails uncaught asynchronous errors instead of accepting measurements',
    { timeout: 60_000 },
    () => {
      setup(`import { bench } from '@pmndrs/labs';
        bench('background failure', async function* () {
          setTimeout(() => { throw new Error('BROWSER_ASYNC'); }, 0);
          yield async () => { await new Promise(resolve => setTimeout(resolve, 5)); return 42; };
        });`);
      const output = run();
      expect(output.status, output.stderr).toBe(1);
      expect(output.stderr).toContain('BROWSER_ASYNC');
      const report = JSON.parse(output.stdout);
      expect(report.benches).toEqual([]);
      expect(report.crashes).toHaveLength(1);
    }
  );
});
