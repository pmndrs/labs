import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { chromium } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runBrowser } from '../src/browser-runner.ts';
import type { Runtime } from '../src/config.ts';

describe('runtime startup feedback', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'labs-runtime-error-'));
    writeFileSync(join(project, 'package.json'), '{"type":"module"}');
    writeFileSync(
      join(project, 'work.bench.ts'),
      `import { bench } from '@pmndrs/labs'; bench('work', () => 42);`
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(project, { recursive: true, force: true });
  });

  function run(
    runtime: Runtime,
    mode: 'text' | 'json' | 'tui',
    launch: { executablePath?: string } = {},
    env: NodeJS.ProcessEnv = {}
  ) {
    writeFileSync(
      join(project, 'labs.config.ts'),
      `import { defineConfig } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
      export default defineConfig(${JSON.stringify({ benchDir: '.', runtime, [runtime]: launch })});`
    );
    const args = ['--no-save', '-n', 'runtime-error'];
    if (mode === 'json') args.push('--json');
    return spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
        ...(mode === 'tui'
          ? [
              '--input-type=module',
              '--eval',
              `process.stdin.isTTY = process.stdout.isTTY = true;
              process.stdout.columns = 100;
              process.stdout.rows = 40;
              const { runCLI } = await import(${JSON.stringify(new URL('../src/cli/runner.ts', import.meta.url).href)});
              await runCLI(${JSON.stringify(args)});`,
            ]
          : [fileURLToPath(new URL('../src/cli/cli.ts', import.meta.url)), ...args]),
      ],
      {
        cwd: project,
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, CI: 'false', TERM: 'xterm-256color', ...env },
      }
    );
  }

  it.each([
    ['bun', 'json'],
    ['chrome', 'text'],
    ['firefox', 'json'],
    ['webkit', 'text'],
  ] as const)('reports an invalid %s executable in %s output', (runtime, mode) => {
    const executablePath = join(project, 'missing-runtime');
    const output = run(runtime, mode, { executablePath });
    expect(output.status, output.stderr || output.error?.message).toBe(1);
    expect(output.stderr).toContain(`${runtime}.executablePath in labs.config.ts`);
    expect(output.stderr).toContain(executablePath);
    if (mode === 'json') {
      const report = JSON.parse(output.stdout);
      expect(report.saved).toBe(false);
      expect(report.benches).toEqual([]);
      expect(report.crashes[0].error).toContain(`${runtime}.executablePath in labs.config.ts`);
      expect(report.crashes[0].error).toContain(executablePath);
    }
  });

  it.each(['firefox', 'webkit'] as const)(
    'gives the install command for a missing %s browser download',
    (runtime) => {
      const output = run(
        runtime,
        'json',
        {},
        { PLAYWRIGHT_BROWSERS_PATH: join(project, 'browsers') }
      );
      expect(output.status, output.stderr || output.error?.message).toBe(1);
      const report = JSON.parse(output.stdout);
      const command = `pnpm dlx playwright-core@${createRequire(import.meta.url)('playwright-core/package.json').version} install ${runtime}`;
      expect(report.crashes[0].error).toContain(command);
      expect(output.stderr).toContain(command);
      expect(output.stderr).not.toContain('npx playwright install');
    }
  );

  it.each(['bun', 'firefox'] as const)(
    'shows installation advice for missing %s in live progress',
    (runtime) => {
      const output = run(
        runtime,
        'tui',
        {},
        {
          PATH: project,
          PLAYWRIGHT_BROWSERS_PATH: join(project, 'browsers'),
        }
      );
      expect(output.status, output.stderr || output.error?.message).toBe(1);
      const screen = stripVTControlCharacters(output.stdout);
      expect(screen).toContain('crashed');
      expect(screen).toContain(runtime === 'bun' ? 'Bun failed to start' : 'Firefox failed to start');
      expect(screen).toContain(runtime === 'bun' ? 'Install Bun' : 'pnpm dlx playwright-core@');
      if (runtime === 'firefox') expect(screen).toContain('install firefox');
      expect(screen).not.toMatch(/Node\.js v\d/);
    }
  );

  it.each([
    {
      name: 'missing Chrome installation',
      reason:
        "browserType.launch: Chromium distribution 'chrome' is not found at /missing/chrome\nRun npx playwright install chrome",
      advice: 'Install Google Chrome or set chrome.executablePath in labs.config.ts.',
    },
    {
      name: 'another Chrome launch failure',
      reason:
        'browserType.launch: Target page, context or browser has been closed\nBrowser log details',
      advice: 'Check the chrome options in labs.config.ts and the launch error below.',
    },
  ])('explains a $name without hiding the cause', async ({ reason, advice }) => {
    vi.spyOn(chromium, 'launch').mockRejectedValue(new Error(reason));
    const failure = await runBrowser({
      file: pathToFileURL(join(project, 'work.bench.ts')).href,
      runtime: 'chrome',
      tune: {},
      execute: async () => new Map(),
    }).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('Chrome failed to start.');
    expect((failure as Error).message).toContain(advice);
    expect((failure as Error).message).toContain(reason.split('\n')[0]);
    expect((failure as Error).message).not.toContain('npx playwright install');
    if (reason.includes('Browser log details')) {
      expect((failure as Error).message).toContain('Browser log details');
    }
  });
});
