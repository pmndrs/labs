import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { firefox, webkit } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { startBrowserServer } from '../src/browser-server.ts';
import { observeWebkitGc } from '../src/webkit-gc.ts';
import { observeFirefoxGc, prepareFirefoxGc } from '../src/firefox-gc.ts';
import type { BlockResult, browserHarness } from '../src/browser.ts';
import type { GcStats } from '../src/bench/types.ts';

describe.each([
  ['firefox', firefox],
  ['webkit', webkit],
] as const)('%s native GC', (runtime, engine) => {
  it.skipIf(!existsSync(engine.executablePath()))(
    'counts the same three forced major collections as Node while excluding setup and teardown',
    { timeout: 60_000 },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'labs-browser-gc-'));
      const file = join(directory, 'forced.bench.ts');
      writeFileSync(
        file,
        `import { bench } from '@pmndrs/labs';
        bench('forced', async function* () {
          await globalThis.__forceGc();
          yield async () => {
            await new Promise(resolve => setTimeout(resolve, 5));
            await globalThis.__forceGc();
            await new Promise(resolve => setTimeout(resolve, 5));
            return 42;
          };
          await globalThis.__forceGc();
        });`
      );
      const server = await startBrowserServer(pathToFileURL(file).href);
      try {
        const run = async (env?: NodeJS.ProcessEnv): Promise<BlockResult> => {
          const browser = await engine.launch({ headless: true, env });
          try {
            const page = await browser.newPage();
            await page.exposeFunction('__forceGc', () => page.requestGC());
            await page.goto(server.url);
            await page.waitForFunction(() => !!(globalThis as any).__labs);
            const measure = () =>
              page.evaluate(
                (runtime) =>
                  (globalThis as typeof globalThis & { __labs: typeof browserHarness }).__labs.trial(
                    0,
                    { heap: false, warmup_samples: 0 },
                    [{ batch: false, batch_samples: 0, batch_unroll: 1, samples: 3 }],
                    undefined,
                    runtime
                  ),
                runtime
              );
            if (runtime === 'webkit') return await observeWebkitGc(page, measure);
            const finish = await prepareFirefoxGc(page);
            try {
              return await measure();
            } finally {
              await finish();
            }
          } finally {
            await browser.close();
          }
        };
        const result = runtime === 'firefox' ? await observeFirefoxGc(run) : await run();
        expect(result.trial.runs[0].error).toBeUndefined();
        const stats = result.trial.runs[0].stats!;
        const gc = stats.gc as GcStats;
        expect(gc).toMatchObject({ major: 3, iterations: 3, maxKind: 'major' });
        expect(gc.total).toBeGreaterThan(0);
        expect(gc.total).toBeLessThanOrEqual(gc.elapsed);
        expect(gc.timed).toBeCloseTo(stats.avg * stats.ticks, 3);
        expect(gc.overlap!.max).toBeLessThanOrEqual(gc.timed);
      } finally {
        await server.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );
});
