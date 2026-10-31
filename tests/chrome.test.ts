import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { toSnapshot } from '../src/bench/lib/snapshot.ts';
import { loadResult } from '../src/store.ts';

describe('Chrome benchmarks', () => {
  const executablePath = [
    process.env.LABS_CHROME_EXECUTABLE,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    process.env.PROGRAMFILES &&
      join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
  ].find((path) => path && existsSync(path));
  let project: string;

  afterEach(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  function setup(source: string, config: Record<string, unknown> = {}) {
    project = mkdtempSync(join(tmpdir(), 'labs-chrome-'));
    writeFileSync(join(project, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(
      join(project, 'labs.config.ts'),
      `import { defineConfig } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
      export default defineConfig(${JSON.stringify({
        benchDir: '.',
        blockTime: 1e-9,
        minSamples: 2,
        blocks: 2,
        chrome: { executablePath },
        ...config,
      })});`
    );
    writeFileSync(join(project, 'dom.bench.ts'), source);
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
        'chrome-test',
        ...args,
      ],
      { cwd: project, encoding: 'utf8', timeout: 60_000 }
    );
  }

  it.skipIf(!executablePath)(
    'runs filtered DOM benchmarks in isolated blocks and saves plans and snapshots',
    { timeout: 60_000 },
    () => {
      setup(`import { assert, bench, group } from '@pmndrs/labs';
        group('dom @browser', () => {
          bench('polluter', function* () {
            yield () => { document.body.dataset.polluted = 'yes'; return 1; };
          });
          bench('element $text', function* (state) {
            assert(!document.body.dataset.polluted, 'blocks must have fresh documents');
            assert(globalThis.crossOriginIsolated, 'timers need cross-origin isolation');
            const element = document.createElement('div');
            element.textContent = state.get('text');
            document.body.append(element);
            const text = yield () => element.textContent.toUpperCase();
            assert.equal(text, state.get('text').toUpperCase());
            return { text };
          }).args('text', ['one', 'two']);
        });
        bench('filtered @other', () => { throw new Error('tag was not filtered'); });`);

      const output = run('--runtime', 'chrome', '@browser');
      expect(output.stderr, output.error?.message).not.toContain('Error:');
      expect(output.status, output.stderr).toBe(0);
      expect(JSON.parse(output.stdout).benches).toHaveLength(3);
      const saved = loadResult(join(project, '.labs'), 'chrome-test');
      expect(saved.hardware.runtime).toBe('chrome');
      expect(saved.hardware.cpu).toBeTruthy();
      expect(saved.files[0].context?.version).toMatch(/^\d+\./);
      const trials = saved.files[0].benchmarks;
      expect(trials).toHaveLength(2);
      expect(trials.map((trial) => trial.groupName)).toEqual(['dom', 'dom']);
      for (const trial of trials) {
        for (const run of trial.runs) {
          expect(run.error).toBeUndefined();
          expect(run.stats?.blocks?.medians).toHaveLength(2);
          expect(run.stats?.samples).toHaveLength(run.stats!.plan!.samples * 2);
          expect(run.stats?.gc).toMatchObject({ count: expect.any(Number) });
          expect(run.stats?.gc).not.toHaveProperty('source');
          expect(run.stats?.heap).toMatchObject({ source: 'replay' });
        }
      }
      expect(trials[1].runs.map((run) => run.stats?.snapshot)).toEqual([
        toSnapshot({ text: 'ONE' }),
        toSnapshot({ text: 'TWO' }),
      ]);
    }
  );

  it.skipIf(!executablePath)(
    'counts actual sampling GC and measures ArrayBuffer allocations after timing',
    { timeout: 60_000 },
    () => {
      setup(
        `import { bench } from '@pmndrs/labs';
        bench('collections', function* () {
          gc();
          yield () => { gc(); return 1; };
          gc();
        });
        bench('buffer', function* () {
          let buffer = new Uint8Array(0);
          yield {
            budget: 'manual',
            manual: () => { buffer = new Uint8Array(65536); return 1; },
          };
          return buffer.byteLength;
        }).gc(false);
        bench('manual', function* () {
          yield { budget: 'manual', manual: () => typeof globalThis.__LABS_GC_OBSERVER === 'function' ? 5 : 1000 };
        });`,
        { runtime: 'chrome', minSamples: 12 }
      );
      const output = run();
      expect(output.status, output.stderr).toBe(0);
      const saved = loadResult(join(project, '.labs'), 'chrome-test');
      const [collections, buffer, manual] = saved.files[0].benchmarks.map(
        (trial) => trial.runs[0].stats!
      );
      const iterations =
        collections.samples.length * (collections.plan!.batch ? collections.plan!.batch_samples : 1);
      expect(collections.gc).toMatchObject({
        count: iterations,
        major: iterations,
        iterations,
        maxKind: 'major',
      });
      expect((collections.gc as { total: number }).total).toBeGreaterThan(0);
      expect(buffer.gc).toBeUndefined();
      expect(buffer.heap?.p50).toBeGreaterThanOrEqual(65536);
      expect(buffer.heap?.p50).toBeLessThan(66560);
      expect(manual.samples.every((sample) => sample === 5)).toBe(true);
      expect(manual.avg).toBe(5);
      expect((manual.gc as { timed: number }).timed).toBe(manual.plan!.samples * 5 * 2);
      const report = JSON.parse(output.stdout);
      expect(report.benches[0].gc.source).toBeUndefined();
      expect(report.benches[1].heapBytes.source).toBe('replay');
    }
  );

  it.skipIf(!executablePath).each([
    { name: 'by default', gc: undefined },
    { name: 'with a Chrome override', gc: { node: false, chrome: true } },
    { name: 'with no Chrome override', gc: { node: false } },
  ])('observes GC without heap diagnostics $name', { timeout: 60_000 }, ({ gc }) => {
    setup(
      `import { bench } from '@pmndrs/labs';
        bench('iterator', (state) => { for (const _ of state) gc(); });`,
      { runtime: 'node', heap: false, gc }
    );
    const output = run('--runtime', 'chrome');
    expect(output.status, output.stderr).toBe(0);
    const saved = loadResult(join(project, '.labs'), 'chrome-test');
    const stats = saved.files[0].benchmarks[0].runs[0].stats!;
    expect(stats.heap).toBeUndefined();
    const iterations = stats.samples.length * (stats.plan!.batch ? stats.plan!.batch_samples : 1);
    expect(stats.gc).toMatchObject({
      count: iterations,
      major: iterations,
      iterations,
    });
  });

  it.skipIf(!executablePath).each([
    { name: 'per benchmark', gc: undefined, disableBench: true },
    { name: 'globally', gc: false, disableBench: false },
    { name: 'for Chrome', gc: { node: true, chrome: false }, disableBench: false },
  ])('disables GC observation $name', { timeout: 60_000 }, ({ gc, disableBench }) => {
    setup(
      `import { assert, bench } from '@pmndrs/labs';
        bench('plain', function* () {
          assert(typeof globalThis.__LABS_GC_OBSERVER !== 'function', 'unexpected sampling observation');
          yield () => 1;
        })${disableBench ? '.gc(false)' : ''};`,
      { runtime: 'node', heap: false, gc }
    );
    const output = run('--runtime', 'chrome');
    expect(output.status, output.stderr).toBe(0);
    const saved = loadResult(join(project, '.labs'), 'chrome-test');
    const trial = saved.files[0].benchmarks[0];
    expect(trial.gcMode).toBe(false);
    const stats = trial.runs[0].stats!;
    expect(stats.heap).toBeUndefined();
    expect(stats.gc).toBeUndefined();
  });

  it.skipIf(!executablePath)(
    'fails changed diagnostic output while keeping the original timing samples',
    { timeout: 60_000 },
    () => {
      setup(
        `import { bench } from '@pmndrs/labs';
        bench('changed replay', function* () {
          const result = yield () => typeof globalThis.__LABS_GC_OBSERVER === 'function' ? 1 : 2;
          return result;
        });`,
        { runtime: 'chrome' }
      );
      const output = run();
      expect(output.status, output.stderr).toBe(1);
      expect(JSON.parse(output.stdout).benches[0].status).toBe('failed');
      const saved = loadResult(join(project, '.labs'), 'chrome-test');
      const savedRun = saved.files[0].benchmarks[0].runs[0];
      expect(savedRun.stats?.samples.length).toBeGreaterThan(0);
      expect(savedRun.stats?.snapshot).toBe(1);
      expect(savedRun.stats?.gc).toMatchObject({ count: expect.any(Number) });
      expect(savedRun.error).toMatchObject({
        message: 'Chrome diagnostics replay produced different output',
      });
    }
  );

  it.skipIf(!executablePath)(
    'batches workloads that are too short for browser timer resolution',
    { timeout: 60_000 },
    () => {
      setup(
        `import { bench } from '@pmndrs/labs';
        bench('70 us', () => {
          const end = performance.now() + 0.07;
          let count = 0;
          while (performance.now() < end) count++;
          return count;
        }).gc(false);`,
        { runtime: 'chrome', heap: false }
      );
      const output = run();
      expect(output.status, output.stderr).toBe(0);
      const stats = loadResult(join(project, '.labs'), 'chrome-test').files[0].benchmarks[0].runs[0]
        .stats!;
      expect(stats.plan?.batch).toBe(true);
      expect(stats.plan!.batch_samples).toBeGreaterThan(1);
    }
  );

  it.skipIf(!executablePath).each([
    { tolerance: 1e-6, status: 0 },
    { tolerance: 1e-12, status: 1 },
  ])(
    'uses configured replay snapshot tolerance $tolerance',
    { timeout: 60_000 },
    ({ tolerance, status }) => {
      setup(
        `import { bench } from '@pmndrs/labs';
      bench('numeric replay', function* () {
        const result = yield () => 1 + (typeof globalThis.__LABS_GC_OBSERVER === 'function' ? 0 : 1e-8);
        return [result, [result * 2]];
      });`,
        { runtime: 'chrome', snapshotTolerance: tolerance }
      );
      const output = run();
      expect(output.status, output.stderr).toBe(status);
      const stats = loadResult(join(project, '.labs'), 'chrome-test').files[0].benchmarks[0].runs[0]
        .stats!;
      expect(stats.snapshot).toEqual([1, [2]]);
      if (status === 0) expect(stats.gc).toMatchObject({ count: expect.any(Number) });
      else expect(JSON.parse(output.stdout).benches[0].status).toBe('failed');
    }
  );

  it.skipIf(!executablePath)(
    'loads module-relative fixtures, imported images, CSS, WASM, and TypeScript workers',
    { timeout: 60_000 },
    () => {
      setup(
        `import { assert, bench } from '@pmndrs/labs';
        import { readFixture } from './assets/helper.ts';
        import image from './assets/image.svg';
        import './assets/style.css';
        bench('assets', async function* () {
          const fixture = await readFixture();
          const imageResponse = await fetch(image);
          assert(imageResponse.ok);
          const { instance } = await WebAssembly.instantiateStreaming(fetch(new URL('./assets/empty.wasm', import.meta.url)));
          assert(instance.exports !== undefined);
          const worker = new Worker(new URL('./assets/worker.ts', import.meta.url), { type: 'module' });
          try {
            const value = await new Promise((resolve, reject) => {
              worker.onmessage = (event) => resolve(event.data);
              worker.onerror = reject;
              worker.postMessage(fixture);
            });
            assert.equal(value, 42);
            assert.equal(getComputedStyle(document.body).getPropertyValue('--fixture').trim(), 'loaded');
            yield () => value;
          } finally { worker.terminate(); }
        }).gc(false);`,
        { runtime: 'chrome', heap: false }
      );
      mkdirSync(join(project, 'assets'));
      writeFileSync(
        join(project, 'assets', 'helper.ts'),
        `export async function readFixture(): Promise<number> {
        const literal = "import.meta.url";
        if (literal !== "import.meta.url") throw new Error('string changed');
        const response = await fetch(new URL('./fixture data.json', import.meta.url));
        if (!response.ok) throw new Error('fixture HTTP ' + response.status);
        return (await response.json()).value;
      }`
      );
      writeFileSync(join(project, 'assets', 'fixture data.json'), '{"value":21}');
      writeFileSync(
        join(project, 'assets', 'image.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg"/>'
      );
      writeFileSync(join(project, 'assets', 'style.css'), 'body { --fixture: loaded; }');
      writeFileSync(
        join(project, 'assets', 'empty.wasm'),
        new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])
      );
      writeFileSync(
        join(project, 'assets', 'worker.ts'),
        `import { twice } from './worker-helper.ts';
        self.onmessage = async (event: MessageEvent<number>) => {
          const response = await fetch(new URL('./fixture data.json', import.meta.url));
          if (!response.ok) throw new Error('worker fixture HTTP ' + response.status);
          self.postMessage(twice(event.data));
        };`
      );
      writeFileSync(
        join(project, 'assets', 'worker-helper.ts'),
        'export const twice = (value: number): number => value * 2;'
      );
      const output = run();
      expect(output.status, output.stderr).toBe(0);
      expect(JSON.parse(output.stdout).benches[0].timeNs).not.toBeNull();
    }
  );

  it.skipIf(!executablePath)(
    'selects Chrome from config and reports a failed correctness check',
    { timeout: 60_000 },
    () => {
      setup(
        `import { assert, bench } from '@pmndrs/labs';
        bench('wrong', function* () {
          const result = yield () => document.createElement('div').tagName;
          assert.equal(result, 'SPAN');
        });
        bench('setup failure', function* () {
          assert(false, 'failed before sampling');
          yield () => 1;
        });`,
        { runtime: 'chrome' }
      );
      const output = run();
      expect(output.status, output.stderr).toBe(1);
      expect(JSON.parse(output.stdout).benches[0]).toMatchObject({
        name: 'wrong',
        status: 'failed',
      });
      const saved = loadResult(join(project, '.labs'), 'chrome-test');
      expect(saved.files[0].benchmarks[0].runs[0].error).toMatchObject({ name: 'AssertionError' });
      expect(saved.files[0].benchmarks[1].runs[0].error).toMatchObject({
        name: 'AssertionError',
        message: 'failed before sampling',
      });
    }
  );

  it.skipIf(!executablePath).each([
    {
      name: 'timer error with GC',
      schedule: "setTimeout(() => { throw new Error('ASYNC_FAILURE'); }, 0)",
      gc: true,
    },
    {
      name: 'timer error without GC',
      schedule: "setTimeout(() => { throw new Error('ASYNC_FAILURE'); }, 0)",
      gc: false,
    },
    {
      name: 'unhandled rejection with GC',
      schedule: "void Promise.reject(new Error('ASYNC_FAILURE'))",
      gc: true,
    },
    {
      name: 'unhandled rejection without GC',
      schedule: "void Promise.reject(new Error('ASYNC_FAILURE'))",
      gc: false,
    },
  ])(
    'fails an uncaught $name instead of accepting measurements',
    { timeout: 60_000 },
    ({ schedule, gc }) => {
      setup(
        `import { bench } from '@pmndrs/labs';
      bench('background failure', async function* () {
        ${schedule};
        yield async () => { await new Promise(resolve => setTimeout(resolve, 5)); return 42; };
      });`,
        { runtime: 'chrome', heap: false, gc }
      );
      const output = run();
      expect(output.status, output.stderr).toBe(1);
      expect(output.stderr).toContain('ASYNC_FAILURE');
      const report = JSON.parse(output.stdout);
      expect(report.benches).toHaveLength(0);
      expect(report.crashes).toHaveLength(1);
    }
  );

  it.skipIf(!executablePath)(
    'accepts handled errors and diagnostic console output',
    { timeout: 60_000 },
    () => {
      setup(
        `import { bench } from '@pmndrs/labs';
        bench('handled errors', async function* () {
          console.error('EXPECTED_DIAGNOSTIC');
          await Promise.reject(new Error('handled rejection')).catch(() => undefined);
          yield () => 42;
        });`,
        { runtime: 'chrome', heap: false }
      );
      const output = run();
      expect(output.status, output.stderr).toBe(0);
      expect(output.stderr).toContain('EXPECTED_DIAGNOSTIC');
      const report = JSON.parse(output.stdout);
      expect(report.crashes).toEqual([]);
      expect(report.benches[0].timeNs).not.toBeNull();
    }
  );

  it.skipIf(!executablePath)(
    'preserves an iterator assertion after sampling and continues the other benchmarks',
    { timeout: 60_000 },
    () => {
      setup(
        `import { assert, bench } from '@pmndrs/labs';
        bench('checked iterator', state => {
          for (const _ of state) gc();
          assert(false, 'POST_LOOP_ASSERT');
        });
        bench('good', () => 42).gc(false);`,
        { runtime: 'chrome', heap: false }
      );
      const output = run();
      expect(output.status, output.stderr).toBe(1);
      expect(output.stderr).not.toContain('Unexpected end of JSON input');
      const report = JSON.parse(output.stdout);
      expect(report.crashes).toEqual([]);
      expect(report.benches).toHaveLength(2);
      expect(report.benches[0]).toMatchObject({ status: 'failed', message: 'POST_LOOP_ASSERT' });
      expect(report.benches[1].timeNs).not.toBeNull();
      const saved = loadResult(join(project, '.labs'), 'chrome-test');
      expect(saved.files[0].benchmarks[0].runs[0].error).toMatchObject({
        name: 'AssertionError',
        message: 'POST_LOOP_ASSERT',
      });
    }
  );

  it('rejects an unsupported runtime before starting workers', () => {
    setup(`import { bench } from '@pmndrs/labs'; bench('test', () => 1);`);
    const output = run('--runtime', 'firefox');
    expect(output.status).toBe(1);
    expect(output.stderr).toContain('Invalid runtime "firefox"');
  });
});
