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
    { runtime: 'node', available: true, tier: 'TurboFan', extra: {} },
    {
      runtime: 'chrome',
      available: !!chrome,
      tier: 'TurboFan',
      extra: { chrome: { executablePath: chrome } },
    },
    {
      runtime: 'bun',
      available: bun.status === 0,
      tier: 'FTL',
      extra: { bun: { executablePath: bun.stdout.trim() } },
    },
    { runtime: 'webkit', available: existsSync(webkit.executablePath()), tier: 'FTL', extra: {} },
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
    return loadResult(join(project, '.labs'), 'tiers').files[0].benchmarks[0].runs[0].stats!;
  }

  it.each(runtimes.filter((runtime) => runtime.available))(
    'records time to the observed workload and harness tier on $runtime',
    { timeout: 70_000 },
    ({ runtime, extra, tier }) => {
      const stats = run(runtime, extra);
      expect(stats.optimization?.workload).toHaveLength(3);
      expect(stats.optimization?.harness).toHaveLength(3);
      for (const sample of stats.optimization!.workload) {
        expect(sample?.tier).toBeTruthy();
        expect(sample?.time).toBeGreaterThanOrEqual(0);
      }
      for (const sample of stats.optimization!.harness!) {
        expect(sample?.tier).toBe(tier);
        expect(sample?.time).toBeGreaterThan(0);
      }
    }
  );

  it('reports a lower V8 tier when optimizing compilers are disabled', () => {
    const stats = run('node', {
      nodeFlags: ['--allow-natives-syntax', '--expose-gc', '--no-turbofan', '--no-maglev'],
    });
    expect(stats.optimization!.harness).toHaveLength(3);
    for (const sample of stats.optimization!.harness!) {
      expect(['Ignition', 'Sparkplug']).toContain(sample?.tier);
      expect(sample?.time).toBeGreaterThanOrEqual(0);
    }
  });

  it.skipIf(bun.status !== 0)('reports DFG when FTL is disabled in Bun', () => {
    const stats = run('bun', {
      bun: { executablePath: bun.stdout.trim(), env: { BUN_JSC_useFTLJIT: 'false' } },
    });
    expect(stats.optimization!.harness).toHaveLength(3);
    for (const sample of stats.optimization!.harness!) expect(sample?.tier).toBe('DFG');
  });

  it('keeps unavailable tiers distinct from successful optimization', () => {
    const stats = run('node', { nodeFlags: ['--expose-gc'] });
    expect(stats.optimization).toEqual({ workload: [null, null, null], harness: [null, null, null] });
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
    ({ runtime, extra, callable, tier }) => {
      const stats = run(
        runtime,
        extra,
        `import { bench } from '@pmndrs/labs'; bench('work', ${callable});`
      );
      expect(stats.optimization!.workload).toEqual([null, null, null]);
      for (const sample of stats.optimization!.harness!) expect(sample?.tier).toBe(tier);
    }
  );

  it.skipIf(bun.status !== 0)('respects disabled JSC introspection', () => {
    const stats = run('bun', {
      bun: { executablePath: bun.stdout.trim(), env: { BUN_JSC_useDollarVM: '0' } },
    });
    expect(stats.optimization).toEqual({ workload: [null, null, null], harness: [null, null, null] });
  });
});
