import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineConfig } from '../src/config.ts';
import { renderRunView } from '../src/cli/run-view.ts';
import { runWorkers } from '../src/cli/workers.ts';
import { loadResult } from '../src/store.ts';
import type { GcStats } from '../src/bench/types.ts';

describe('Bun benchmarks', () => {
  const executable = process.env.LABS_BUN_EXECUTABLE ?? 'bun';
  const probe = spawnSync(executable, ['-p', 'process.execPath'], { encoding: 'utf8' });
  const available = probe.status === 0;
  const executablePath = probe.stdout?.trim() || executable;
  let project: string;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (project) rmSync(project, { recursive: true, force: true });
  });

  function setup(source: string, config: Record<string, unknown> = {}, type = 'module') {
    project = mkdtempSync(join(tmpdir(), 'labs-bun-'));
    writeFileSync(join(project, 'package.json'), JSON.stringify({ type }));
    writeFileSync(
      join(project, 'labs.config.ts'),
      `import { defineConfig } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
      export default defineConfig(${JSON.stringify({
        benchDir: '.',
        runtime: 'bun',
        bun: { executablePath },
        blocks: 2,
        minSamples: 2,
        blockTime: 1e-9,
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
        'bun-test',
        ...args,
      ],
      { cwd: project, encoding: 'utf8', timeout: 60_000 }
    );
  }

  it.skipIf(!available).each(['module', 'commonjs'])(
    'runs native TypeScript in a %s project with isolated blocks and frozen plans',
    { timeout: 60_000 },
    (type) => {
      setup(
        `${
          type === 'module'
            ? `import { assert, bench, group } from '@pmndrs/labs'; import { value } from '@fixture/value';`
            : `const { assert, bench, group } = require('@pmndrs/labs'); const { value } = require('@fixture/value');`
        }
        let polluted = false;
        group('native @bun', () => {
          bench('polluter', () => { polluted = true; Bun.gc(true); return 1; });
          bench('work $input', async function* (state) {
            assert(Bun.version);
            assert(!polluted, 'blocks must have fresh process state');
            const input: number = state.get('input');
            const result = yield async () => input + value;
            assert.equal(result, input + value);
            return result;
          }).args('input', [1, 2]);
          bench('plain', () => Math.sqrt(value));
          bench('manual', function* () { yield { budget: 'manual', manual: () => 50 }; }).gc(false);
        });
        bench('filtered @other', () => { throw new Error('tag was not filtered'); });`,
        {
          runtime: 'node',
          nodeFlags: ['--not-a-bun-flag'],
          ...(type === 'commonjs' ? { gc: { node: true, bun: false } } : {}),
        },
        type
      );
      mkdirSync(join(project, 'config'));
      mkdirSync(join(project, 'helpers'));
      writeFileSync(
        join(project, 'config/base.json'),
        JSON.stringify({ compilerOptions: { paths: { '@fixture/*': ['../helpers/*'] } } })
      );
      writeFileSync(join(project, 'tsconfig.json'), '{"extends":"./config/base.json"}');
      writeFileSync(join(project, 'helpers/value.ts'), 'export const value: number = 40;');

      const output = run('--runtime', 'bun', '@bun');
      expect(output.status, output.stderr || output.error?.message).toBe(0);
      const report = JSON.parse(output.stdout);
      expect(report.crashes).toEqual([]);
      expect(report.benches).toHaveLength(5);
      for (const bench of report.benches) {
        expect(bench.timeNs).not.toBeNull();
        if (type === 'module' && bench.name !== 'manual') {
          expect(bench.gc).toHaveProperty('perIterationNs');
          expect(bench.gc.durationKind).toBe('collection');
        } else expect(bench.gc).toBeNull();
        expect(bench.heapBytes).toBeNull();
      }
      const saved = loadResult(join(project, '.labs'), 'bun-test');
      expect(saved.hardware.runtime).toBe('bun');
      expect(saved.hardware.cpu).toBeTruthy();
      expect(saved.files[0].context?.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(saved.files[0].benchmarks).toHaveLength(4);
      for (const trial of saved.files[0].benchmarks) {
        expect(trial.groupName).toBe('native');
        expect(trial.gcMode).toBe(type === 'module' && trial.alias !== 'manual');
        for (const run of trial.runs) {
          expect(run.error).toBeUndefined();
          expect(run.stats?.blocks?.medians).toHaveLength(2);
          expect(run.stats?.samples).toHaveLength(run.stats!.plan!.samples * 2);
          if (trial.gcMode) expect(run.stats?.gc).toHaveProperty('count');
          else expect(run.stats?.gc).toBeUndefined();
          expect(run.stats?.heap).toBeUndefined();
        }
      }
      expect(saved.files[0].benchmarks[1].runs.map((run) => run.stats?.snapshot)).toEqual([41, 42]);
      expect(saved.files[0].benchmarks[3].runs[0].stats?.avg).toBe(50);
      expect(
        renderRunView(saved, defineConfig({ benchDir: '.' }), {
          columns: 100,
          rows: 30,
          selected: 0,
          detailOffset: 0,
          colors: false,
        }).lines.join('\n')
      ).toContain('Bun');
    }
  );

  it.skipIf(!available)('passes launch arguments and JSC settings to every block', () => {
    vi.stubEnv('BUN_JSC_useDollarVM', '0');
    vi.stubEnv('BENCH_LAUNCH_VALUE', 'inherited');
    setup(
      `import { assert, bench } from '@pmndrs/labs';
        assert.equal(globalThis.launchValue, 'preloaded');
        assert.equal(process.env.BENCH_LAUNCH_VALUE, 'configured');
        assert.equal(typeof globalThis.$vm.ftlTrue, 'function');
        bench('launch options', () => { Bun.gc(true); return globalThis.launchValue; });`,
      {
        bun: {
          executablePath,
          args: ['--preload', './preload.ts'],
          env: { BUN_JSC_useDollarVM: '1', BENCH_LAUNCH_VALUE: 'configured' },
        },
      }
    );
    writeFileSync(join(project, 'preload.ts'), `globalThis.launchValue = 'preloaded';`);
    const output = run();
    expect(output.status, output.stderr).toBe(0);
    const report = JSON.parse(output.stdout);
    expect(report.crashes).toEqual([]);
    expect(report.benches).toHaveLength(1);
    expect(report.benches[0].gc).not.toBeNull();
    const saved = loadResult(join(project, '.labs'), 'bun-test');
    expect(saved.files[0].benchmarks[0].runs[0].stats!.blocks!.medians).toHaveLength(2);
  });

  it.skipIf(!available)(
    'counts major and minor collections only during sampling',
    { timeout: 60_000 },
    () => {
      setup(`import { bench } from '@pmndrs/labs';
        import { edenGC } from 'bun:jsc';
        bench('generator', function* () {
          Bun.gc(true);
          yield () => { Bun.gc(true); return 42; };
          Bun.gc(true);
        });
        bench('plain', () => { Bun.gc(true); return 42; });
        bench('minor', () => { edenGC(); return 42; });`);
      const output = run();
      expect(output.status, output.stderr).toBe(0);
      const saved = loadResult(join(project, '.labs'), 'bun-test');
      for (const trial of saved.files[0].benchmarks) {
        const stats = trial.runs[0].stats!;
        const gc = stats.gc as GcStats;
        const iterations = stats.samples.length * (stats.plan!.batch ? stats.plan!.batch_samples : 1);
        expect(gc).not.toHaveProperty('source');
        expect(gc).toMatchObject({
          durationKind: 'collection',
          count: iterations,
          iterations,
          ...(trial.alias === 'minor'
            ? { minor: iterations, major: 0, maxKind: 'minor' }
            : { minor: 0, major: iterations, maxKind: 'major' }),
        });
        expect(gc.total).toBeGreaterThan(0);
        expect(gc.max).toBeGreaterThan(0);
        expect(gc.total).toBeLessThanOrEqual(gc.elapsed);
        expect(gc.timed).toBeCloseTo(stats.avg * iterations, 3);
        expect(gc.overlap!.min).toBeGreaterThan(0);
        expect(gc.overlap!.max).toBeLessThanOrEqual(gc.timed);
        expect(gc.overlap!.min).toBeLessThanOrEqual(gc.overlap!.max);
      }
    }
  );

  it.skipIf(!available)(
    'observes natural collections from allocating work',
    { timeout: 60_000 },
    () => {
      setup(
        `import { bench } from '@pmndrs/labs';
        bench('allocations', function* () {
          const history = Array(32);
          let cursor = 0;
          yield () => {
            const values = Array.from({length: 1024}, (_, i) => ({x: i, y: cursor}));
            history[cursor++ % history.length] = values;
            return values.length;
          };
        });`,
        { blockTime: 0.05 }
      );
      const observed = run();
      expect(observed.status, observed.stderr).toBe(0);
      const saved = loadResult(join(project, '.labs'), 'bun-test');
      expect((saved.files[0].benchmarks[0].runs[0].stats!.gc as GcStats).count).toBeGreaterThan(0);
    }
  );

  it.skipIf(!available)(
    'preserves correctness failures and continues other benchmarks',
    { timeout: 60_000 },
    () => {
      setup(`import { assert, bench } from '@pmndrs/labs';
        bench('wrong', function* () { yield () => 42; assert(false, 'BUN_ASSERT'); });
        bench('async teardown', async function* () {
          yield async () => 42;
          assert(false, 'BUN_TEARDOWN_ASSERT');
        });
        bench('good', () => 42);`);
      const output = run();
      expect(output.status, output.stderr).toBe(1);
      const report = JSON.parse(output.stdout);
      expect(report.crashes).toEqual([]);
      expect(report.benches[0]).toMatchObject({ status: 'failed', message: 'BUN_ASSERT' });
      expect(report.benches[1]).toMatchObject({ status: 'failed', message: 'BUN_TEARDOWN_ASSERT' });
      expect(report.benches[2].timeNs).not.toBeNull();
    }
  );

  it.skipIf(!available)(
    'fails uncaught asynchronous errors instead of accepting measurements',
    { timeout: 60_000 },
    () => {
      setup(`import { bench } from '@pmndrs/labs';
        bench('background error', async function* () {
          setTimeout(() => { throw new Error('BUN_BACKGROUND'); }, 0);
          yield async () => { await new Promise(resolve => setTimeout(resolve, 5)); return 42; };
        });`);
      const output = run();
      expect(output.status, output.stderr).toBe(1);
      expect(output.stderr).toContain('BUN_BACKGROUND');
      const report = JSON.parse(output.stdout);
      expect(report.benches).toEqual([]);
      expect(report.crashes).toHaveLength(1);
    }
  );

  it.skipIf(!available)('interleaves Bun and Node workers under the turn protocol', async () => {
    project = mkdtempSync(join(tmpdir(), 'labs-bun-turns-'));
    const log = join(project, 'turns');
    const worker = fileURLToPath(new URL('./fixtures/turns.worker.ts', import.meta.url));
    await runWorkers([
      {
        execPath: executablePath,
        args: [worker],
        env: { ...process.env, LOG: log, TURNS: '3', ID: 'a' },
      },
      {
        args: ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, worker],
        env: { ...process.env, LOG: log, TURNS: '3', ID: 'b' },
      },
    ]);
    expect(readFileSync(log, 'utf8')).toMatch(/^(ababab|bababa)$/);
  });

  it('rejects hardware counters that require Node', () => {
    setup(`import { bench } from '@pmndrs/labs'; bench('work', () => 42);`, {
      counters: './counter.js',
    });
    const output = run();
    expect(output.status).toBe(1);
    expect(output.stderr).toContain('Hardware counters are only supported with the node runtime');
  });
});
