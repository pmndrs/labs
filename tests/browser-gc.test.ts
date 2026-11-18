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

describe('WebKit GC clock calibration', () => {
  it.each([
    ['keeps GC stats when one round misses a forced collection', 1, true],
    ['measures without GC stats when every round misses one', Infinity, false],
  ])('%s', async (_, missedRounds, observed) => {
    const listeners = new Set<(value: any) => void>();
    let clock = 0;
    let forced = 0;
    const session = {
      on: (_: string, listener: (value: any) => void) => listeners.add(listener),
      off: (_: string, listener: (value: any) => void) => listeners.delete(listener),
      async send(method: string) {
        if (method !== 'Heap.gc') return;
        // One collection goes unreported in each round of sixteen that misses
        const call = forced++;
        if (call % 16 === 1 && call / 16 < missedRounds) return;
        const collection = { type: 'full', startTime: clock / 1e9, endTime: clock / 1e9 };
        for (const listener of listeners) listener({ collection });
      },
    };
    let finish!: (window: object) => Promise<GcStats | undefined>;
    const page = {
      _connection: { toImpl: () => ({ delegate: { _session: session } }) },
      evaluate: async () => clock++,
      exposeFunction: async (_: string, expose: typeof finish) => void (finish = expose),
    };

    const gc = await observeWebkitGc(page as any, () =>
      finish({ start: clock, end: clock + 10, timed: 5, iterations: 1, comparable: false })
    );

    expect(gc?.iterations).toBe(observed ? 1 : undefined);
  });
});
