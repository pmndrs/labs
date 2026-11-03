import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { webkit } from 'playwright-core';
import { afterEach, describe, expect, it } from 'vitest';
import { loadResult } from '../src/store.ts';

describe('observed optimization tiers', () => {
  const bun = spawnSync(process.env.LABS_BUN_EXECUTABLE ?? 'bun', ['-p', 'process.execPath'], {
    encoding: 'utf8',
  });
  const chrome = [
    process.env.LABS_CHROME_EXECUTABLE,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].find((path) => path && existsSync(path));
  const runtimes = [
    {
      runtime: 'node',
      available: true,
      tiers: ['Ignition', 'Sparkplug', 'Maglev', 'TurboFan'],
      extra: {},
    },
    {
      runtime: 'chrome',
      available: !!chrome,
      tiers: ['Ignition', 'Sparkplug', 'Maglev', 'TurboFan'],
      extra: { chrome: { executablePath: chrome } },
    },
    {
      runtime: 'bun',
      available: bun.status === 0,
      tiers: ['LLInt', 'Baseline', 'DFG', 'FTL'],
      extra: { bun: { executablePath: bun.stdout.trim() } },
    },
    {
      runtime: 'webkit',
      available: existsSync(webkit.executablePath()),
      tiers: ['LLInt', 'Baseline', 'DFG', 'FTL'],
      extra: {},
    },
  ];
  let project: string;
  afterEach(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  function run(
    runtime: string,
    extra: object,
    source = `import { bench } from '@pmndrs/labs';
    bench('work', () => { let sum = 0; for (let i = 0; i < 300; i++) sum += Math.sqrt(i); return sum; });`
  ) {
    project = mkdtempSync(join(tmpdir(), 'labs-optimization-'));
    writeFileSync(join(project, 'package.json'), '{"type":"module"}');
    writeFileSync(
      join(project, 'labs.config.ts'),
      `import { defineConfig } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
      export default defineConfig(${JSON.stringify({ benchDir: '.', runtime, blocks: 3, blockTime: 0.02, heap: false, ...extra })});`
    );
    writeFileSync(join(project, 'work.bench.ts'), source);
    const output = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
        fileURLToPath(new URL('../src/cli/cli.ts', import.meta.url)),
        '--json',
        '-n',
        'tiers',
      ],
      { cwd: project, encoding: 'utf8', timeout: 60_000 }
    );
    expect(output.status, output.stderr || output.error?.message).toBe(0);
    const stats = loadResult(join(project, '.labs'), 'tiers').files[0].benchmarks[0].runs[0].stats!;
    expect(JSON.parse(output.stdout).benches[0].optimization).toEqual(stats.optimization);
    return stats;
  }

  it.each(runtimes.filter((runtime) => runtime.available))(
    'records time to the observed workload and harness tier on $runtime',
    { timeout: 70_000 },
    ({ runtime, extra, tiers }) => {
      const stats = run(runtime, extra);
      expect(stats.optimization?.mode).toBe('natural');
      expect(stats.optimization?.benchmark).toHaveLength(3);
      expect(stats.optimization?.workload).toHaveLength(3);
      expect(stats.optimization?.harness).toHaveLength(3);
      for (const sample of stats.optimization!.workload) {
        expect(sample?.tier).toBeTruthy();
        expect(sample?.time).toBeGreaterThanOrEqual(0);
      }
      for (const sample of stats.optimization!.harness!) {
        if (sample) {
          expect(tiers).toContain(sample.tier);
          expect(sample.time).toBeGreaterThan(0);
        } else expect(['node', 'chrome']).toContain(runtime);
      }
    }
  );

  it('observes natural tiering thresholds without forcing TurboFan', () => {
    const stats = run('node', {
      nodeFlags: [
        '--allow-natives-syntax',
        '--expose-gc',
        '--no-use-osr',
        '--minimum-invocations-before-optimization=1000000',
      ],
    });
    expect(stats.optimization?.mode).toBe('natural');
    for (const sample of stats.optimization!.harness!) expect(sample?.tier).not.toBe('TurboFan');
    for (const sample of stats.optimization!.benchmark!) expect(sample?.tier).not.toBe('TurboFan');
    for (const sample of stats.optimization!.workload)
      expect(['Ignition', 'Sparkplug']).toContain(sample?.tier);
    expect(stats.warmup?.phase).toBe('sampling');
  });

  it.each(['sampling', 'heap'])(
    'checks the end tier before heap diagnostics when promotion happens in %s',
    (phase) => {
      const output = spawnSync(
        process.execPath,
        [
          '--allow-natives-syntax',
          '--no-concurrent-recompilation',
          '--minimum-invocations-before-optimization=1000000',
          '--import',
          pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
          '--input-type=module',
          '--eval',
          `import { measure } from ${JSON.stringify(new URL('../src/bench/lib/measure.ts', import.meta.url).href)};
      function work() { return 42; }
      %PrepareFunctionForOptimization(work);
      let recording = false, calls = 0, requested = false;
      function promote() {
        if (!requested) { requested = true; %OptimizeFunctionOnNextCall(work); }
      }
      const stats = await measure(work, {
        batch: false, warmup_time: 0, min_samples: 8, max_samples: 8, min_cpu_time: 0,
        gc: () => { recording = true; },
        $consume: () => { if (recording && ++calls === 2 && '${phase}' === 'sampling') promote(); },
        heap: () => { if ('${phase}' === 'heap') promote(); return 0; },
      });
      console.log(JSON.stringify({ start: stats.optimization.benchmark[0].tier,
        end: stats.optimization.benchmarkEnd[0], afterHeap: %ActiveTierIsTurbofan(work) }));`,
        ],
        { encoding: 'utf8', timeout: 30_000 }
      );
      expect(output.status, output.stderr).toBe(0);
      const result = JSON.parse(output.stdout);
      expect(result.start).not.toBe('TurboFan');
      expect(result.afterHeap).toBe(true);
      if (phase === 'sampling') expect(result.end).toBe('TurboFan');
      else expect(result.end).not.toBe('TurboFan');
    }
  );

  it.each([false, true])('matches the executing V8 benchmark with delayed tiering %s', (delayed) => {
    const output = spawnSync(
      process.execPath,
      [
        '--allow-natives-syntax',
        '--expose-gc',
        '--import',
        pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
        ...(delayed
          ? ['--no-use-osr', '--minimum-invocations-before-optimization=1000000']
          : ['--no-maglev', '--no-concurrent-recompilation', '--invocation-count-for-turbofan=2']),
        '--input-type=module',
        '--eval',
        `import { measure } from ${JSON.stringify(new URL('../src/bench/lib/measure.ts', import.meta.url).href)};
      const seen = new Uint8Array(1024);
      const head = new Uint32Array(1);
      const work = new Function('seen', 'head', \`return function work() {
        seen[head[0]++ & 1023] = %CurrentFrameIsTurbofan() ? 1 : 0;
        let sum = 0; for (let i = 0; i < 300; i++) sum += Math.sqrt(i); return sum;
      }\`)(seen, head);
      const stats = await measure(work, {
        batch: true, batch_samples: 1024, min_samples: 1, max_samples: 1, min_cpu_time: 0,
        warmup_settle: 20e6, heap: false, gc: () => { head[0] = 0; globalThis.gc(); },
      });
      console.log(JSON.stringify({ actual: seen[0], calls: head[0], reported: stats.optimization.benchmark[0] }));`,
      ],
      { encoding: 'utf8', timeout: 30_000 }
    );
    expect(output.status, output.stderr || output.error?.message).toBe(0);
    const result = JSON.parse(output.stdout);
    expect(result.calls).toBe(1024);
    expect(result.actual).toBe(delayed ? 0 : 1);
    if (delayed) expect(result.reported?.tier).not.toBe('TurboFan');
    else expect(result.reported?.tier).toBe('TurboFan');
  });

  it.skipIf(bun.status !== 0)('matches the executing unbatched JSC benchmark', () => {
    const output = spawnSync(
      bun.stdout.trim(),
      [
        '--eval',
        `import { measure } from ${JSON.stringify(new URL('../src/bench/lib/measure.ts', import.meta.url).href)};
        let actual;
        function work() {
          actual = $vm.ftlTrue() ? 'FTL' : $vm.dfgTrue() ? 'DFG'
            : $vm.baselineJITTrue() ? 'Baseline' : 'LLInt';
          let sum = 0; for (let i = 0; i < 300; i++) sum += Math.sqrt(i); return sum;
        }
        const stats = await measure(work, {
          batch: false, min_samples: 1, max_samples: 1, min_cpu_time: 0,
          heap: false, gc: () => { actual = undefined; Bun.gc(true); },
        });
        console.log(JSON.stringify({ actual, reported: stats.optimization.benchmark[0] }));`,
      ],
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, BUN_JSC_useDollarVM: '1', BUN_JSC_useConcurrentJIT: 'false' },
      }
    );
    expect(output.status, output.stderr || output.error?.message).toBe(0);
    const result = JSON.parse(output.stdout);
    expect(result.reported?.tier).toBe(result.actual);
  });

  it('reports a lower V8 tier when optimizing compilers are disabled', () => {
    const stats = run('node', {
      nodeFlags: ['--allow-natives-syntax', '--expose-gc', '--no-turbofan', '--no-maglev'],
    });
    expect(stats.optimization!.harness).toHaveLength(3);
    for (const sample of stats.optimization!.harness!) {
      expect(sample?.tier).not.toBe('TurboFan');
      if (sample) expect(sample.time).toBeGreaterThanOrEqual(0);
    }
  });

  it.each(runtimes.filter(({ available }) => available))(
    'observes the sampling body for an async workload on $runtime',
    { timeout: 70_000 },
    ({ runtime, extra, tiers }) => {
      const stats = run(
        runtime,
        extra,
        `import { bench } from '@pmndrs/labs';
        bench('work', async () => { await 0; let sum = 0; for (let i = 0; i < 300; i++) sum += Math.sqrt(i); return sum; });`
      );
      if (runtime === 'bun' || runtime === 'webkit') {
        for (const sample of stats.optimization!.harness!) {
          expect(['LLInt', 'Baseline', 'DFG', 'FTL']).toContain(sample?.tier);
          expect(sample?.time).toBeGreaterThanOrEqual(0);
        }
        expect(stats.optimization!.workload).toEqual([null, null, null]);
      } else {
        for (const sample of stats.optimization!.harness!)
          if (sample) expect(tiers).toContain(sample.tier);
        for (const sample of stats.optimization!.workload) expect(sample?.tier).toBeTruthy();
      }
    }
  );

  it.skipIf(bun.status !== 0)(
    'matches the actual async sampling frame rather than its wrapper',
    () => {
      const output = spawnSync(
        bun.stdout.trim(),
        [
          '--eval',
          `import { measure } from ${JSON.stringify(new URL('../src/bench/lib/measure.ts', import.meta.url).href)};
        const recording = new Uint8Array(1);
        let actual;
        function now() {
          if (recording[0] && !actual) {
            const frame = $vm.codeBlockFor($vm.codeBlockForFrame(1));
            if (frame?.startsWith('anonymous#')) actual = frame.match(/, (FTL|DFG|Baseline|LLInt)FunctionCall,/)?.[1];
          }
          return Bun.nanoseconds();
        }
        $vm.noInline(now);
        const stats = await measure(async () => { await 0; let sum = 0; for (let i = 0; i < 300; i++) sum += Math.sqrt(i); return sum; }, {
          now, gc: () => { recording[0] = 1; }, heap: false,
          batch: true, batch_samples: 2048, min_cpu_time: 0.02e9,
        });
        console.log(JSON.stringify({ actual, reported: stats.optimization.harness[0] }));`,
        ],
        {
          encoding: 'utf8',
          timeout: 30_000,
          env: { ...process.env, BUN_JSC_useDollarVM: '1' },
        }
      );
      expect(output.status, output.stderr || output.error?.message).toBe(0);
      const result = JSON.parse(output.stdout);
      expect(result.actual).toBeTruthy();
      expect(result.reported.tier).toBe(result.actual);
    }
  );

  it.each(
    runtimes.filter(
      ({ available, runtime }) => available && (runtime === 'bun' || runtime === 'webkit')
    )
  )(
    'observes the sampling body for a parameterized workload on $runtime',
    { timeout: 70_000 },
    ({ runtime, extra }) => {
      const stats = run(
        runtime,
        extra,
        `import { bench } from '@pmndrs/labs';
        bench('work', function* () { yield { 0: () => 300, bench: (n) => { let sum = 0; for (let i = 0; i < n; i++) sum += Math.sqrt(i); return sum; } }; });`
      );
      for (const sample of stats.optimization!.harness!)
        expect(['LLInt', 'Baseline', 'DFG', 'FTL']).toContain(sample?.tier);
      for (const sample of stats.optimization!.workload) expect(sample?.tier).toBeTruthy();
    }
  );

  it.skipIf(bun.status !== 0)('respects disabled FTL in Bun', () => {
    const stats = run('bun', {
      bun: { executablePath: bun.stdout.trim(), env: { BUN_JSC_useFTLJIT: 'false' } },
    });
    expect(stats.optimization!.harness).toHaveLength(3);
    for (const sample of stats.optimization!.harness!)
      expect(['LLInt', 'Baseline', 'DFG']).toContain(sample?.tier);
  });

  it('keeps unavailable tiers distinct from successful optimization', () => {
    const stats = run('node', { nodeFlags: ['--expose-gc'] });
    expect(stats.optimization).toEqual({
      mode: 'natural',
      benchmark: [null, null, null],
      workload: [null, null, null],
      harness: [null, null, null],
    });
  });

  it.each(
    runtimes
      .filter(({ available, runtime }) => available && (runtime === 'node' || runtime === 'bun'))
      .flatMap((runtime) =>
        ['Math.random', 'Math.sqrt.bind(null, 2)', 'new Proxy(() => 42, {})'].map((callable) => ({
          ...runtime,
          callable,
        }))
      )
  )(
    'runs $callable without passing native or wrapped functions to $runtime tier queries',
    ({ runtime, extra, callable, tiers }) => {
      const stats = run(
        runtime,
        extra,
        `import { bench } from '@pmndrs/labs'; bench('work', ${callable});`
      );
      expect(stats.optimization!.workload).toEqual([null, null, null]);
      expect(stats.optimization!.benchmark).toEqual([null, null, null]);
      for (const sample of stats.optimization!.harness!)
        if (sample) expect(tiers).toContain(sample.tier);
    }
  );

  it.skipIf(bun.status !== 0)('respects disabled JSC introspection', () => {
    const stats = run('bun', {
      bun: { executablePath: bun.stdout.trim(), env: { BUN_JSC_useDollarVM: '0' } },
    });
    expect(stats.optimization).toEqual({
      mode: 'natural',
      benchmark: [null, null, null],
      workload: [null, null, null],
      harness: [null, null, null],
    });
  });
});
