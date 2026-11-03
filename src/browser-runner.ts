import { arch, cpus, platform } from 'node:os';
import type { Browser, Page } from 'playwright-core';
import type { BlockJob, BlockResult, browserHarness } from './browser.ts';
import type { BlockPlan, MeasureOptions, Trial } from './bench/types.ts';
import type { LabsConfig } from './config.ts';
import { chromeGcStats, type ChromeGcWindow } from './bench/lib/chrome-gc.ts';
import { median } from './stats.ts';
import { snapshotsDiffer } from './bench/lib/snapshot.ts';
import { startBrowserServer } from './browser-server.ts';
import { observeChromeGc } from './chrome-trace.ts';
import { observeWebkitGc } from './webkit-gc.ts';
import { observeFirefoxGc, prepareFirefoxGc } from './firefox-gc.ts';
import { RuntimeLaunchError } from './runtime-error.ts';

type BrowserGlobal = typeof globalThis & { __labs: typeof browserHarness };

/** Bundle browser benchmarks once and execute every block in a fresh browser process. */
export async function runBrowser(options: {
  file: string;
  runtime: 'chrome' | 'firefox' | 'webkit';
  tune: MeasureOptions;
  grepTags?: string;
  launch?: LabsConfig['chrome'] & LabsConfig['webkit'];
  snapshotTolerance?: number;
  beforeDiagnostics?: () => Promise<void>;
  execute: (
    jobs: BlockJob[],
    runTrial: (index: number, plans?: BlockPlan[]) => Promise<BlockResult>
  ) => Promise<Map<number, Trial>>;
}) {
  const { chromium, firefox, webkit } = await import('playwright-core');
  const engine = { chrome: chromium, firefox, webkit }[options.runtime];
  const server = await startBrowserServer(options.file);
  const url = server.url;

  const withPage = async <T>(
    use: (page: Page, browser: Browser) => Promise<T>,
    diagnostics = false,
    env?: NodeJS.ProcessEnv
  ): Promise<T> => {
    const launchEnv: NodeJS.ProcessEnv = {
      ...(options.runtime === 'webkit' ? { __XPC_JSC_useDollarVM: '1', JSC_useDollarVM: '1' } : {}),
      ...process.env,
      ...options.launch?.env,
      ...env,
    };
    if (options.runtime === 'webkit' && process.platform === 'darwin') {
      // macOS forwards __XPC_ variables into the WebKit content process.
      for (const [name, value] of Object.entries(options.launch?.env ?? {})) {
        if (name.startsWith('JSC_')) {
          launchEnv[`__XPC_${name}`] = options.launch?.env?.[`__XPC_${name}`] ?? value;
        }
      }
    }
    const browser = await engine
      .launch({
        executablePath: options.launch?.executablePath,
        headless: options.launch?.headless ?? true,
        args: options.launch?.args,
        env: launchEnv,
        ...(options.runtime === 'firefox'
          ? { env: env ?? { ...process.env, MOZ_PROFILER_STARTUP: '0', MOZ_PROFILER_SHUTDOWN: '' } }
          : {}),
        ...(options.runtime === 'chrome'
          ? {
              channel: 'chrome',
              args: [
                '--js-flags=--expose-gc --allow-natives-syntax',
                // Dawn rounds GPU timestamps to 65536 ns against timing attacks, which a benchmark browser does not face.
                '--disable-dawn-features=timestamp_quantization',
                ...(diagnostics && options.tune.heap !== false
                  ? ['--enable-precise-memory-info']
                  : []),
                ...(options.launch?.args ?? []),
              ],
            }
          : {}),
      })
      .catch((error: unknown) => {
        throw new RuntimeLaunchError(options.runtime, error, options.launch?.executablePath);
      });
    let pageError: Error | undefined;
    try {
      const page = await browser.newPage();
      page.on('pageerror', (error) => (pageError ??= error));
      page.on('console', (message) => console.log(message.text()));
      await page.addInitScript((tags) => {
        Object.assign(globalThis, { __LABS_GREP_TAGS: tags });
      }, options.grepTags);
      const result = await use(page, browser);
      if (pageError) throw pageError;
      return result;
    } catch (error) {
      throw pageError ?? error;
    } finally {
      await browser.close();
    }
  };
  const load = async (page: Page) => {
    await page.goto(url);
    await page.waitForFunction(() => !!(globalThis as BrowserGlobal).__labs, undefined, {
      timeout: 15_000,
    });
  };

  try {
    const blocks = new Map<number, BlockResult[]>();
    let indices: number[] = [];
    const result = await withPage(async (page, browser) => {
      await page.exposeFunction('__labsExecute', async (jobs: BlockJob[]) => {
        indices = jobs.map((job) => job.index);
        const results = await options.execute(jobs, (index, plans) => {
          const observe =
            options.tune.sample_gc !== false && jobs.find((job) => job.index === index)!.gc;
          const execute = (env?: NodeJS.ProcessEnv) =>
            withPage(
              async (child) => {
                await load(child);
                const calibration = await child.evaluate(() =>
                  (globalThis as BrowserGlobal).__labs.calibrate()
                );
                if (options.runtime !== 'chrome') await child.requestGC();
                const measure = () =>
                  child.evaluate(
                    ({ index, tune, plans, calibration, observe }) =>
                      (globalThis as BrowserGlobal).__labs.trial(
                        index,
                        tune,
                        plans,
                        calibration,
                        observe
                      ),
                    {
                      index,
                      tune: options.tune,
                      plans,
                      calibration,
                      observe: observe ? options.runtime : (false as const),
                    }
                  );
                let measured: BlockResult;
                if (observe && options.runtime === 'chrome') {
                  const captured = await observeChromeGc(child, measure);
                  measured = captured.result;
                  if (
                    measured.trial.runs.some((run) => run.stats?.gc) &&
                    !captured.events.some(
                      (event) => event.name === 'MajorGC' || event.name === 'MinorGC'
                    )
                  )
                    throw new Error('Chrome GC trace did not capture collector events');
                  for (const run of measured.trial.runs) {
                    if (run.stats?.gc)
                      run.stats.gc = chromeGcStats(captured.events, run.stats.gc as ChromeGcWindow);
                  }
                } else if (observe && options.runtime === 'webkit') {
                  measured = await observeWebkitGc(child, measure);
                } else if (observe) {
                  const finish = await prepareFirefoxGc(child);
                  try {
                    measured = await measure();
                  } finally {
                    await finish();
                  }
                } else measured = await measure();
                let recorded = blocks.get(index);
                if (!recorded) blocks.set(index, (recorded = []));
                recorded.push(measured);
                return measured;
              },
              false,
              env
            );
          return observe && options.runtime === 'firefox' ? observeFirefoxGc(execute) : execute();
        });
        return [...results];
      });
      await load(page);
      const result = await page.evaluate(
        (tune) => (globalThis as BrowserGlobal).__labs.run(tune),
        options.tune
      );
      result.context.runtime = options.runtime;
      result.context.version = browser.version();
      result.context.arch = `${arch()}-${platform()}`;
      result.context.cpu.name = cpus()[0]?.model ?? null;
      return result;
    });
    const replayable = [...blocks].filter(
      ([, parts]) =>
        options.runtime === 'chrome' &&
        parts.every(({ trial }) => trial.runs.every((run) => run.stats?.plan)) &&
        options.tune.heap !== false
    );
    if (replayable.length) await options.beforeDiagnostics?.();
    for (const [index, parts] of replayable) {
      const replays: Trial[] = [];
      let failure: unknown;
      for (const part of parts) {
        try {
          const replay = await withPage(async (page) => {
            await load(page);
            const trial = await page.evaluate(
              ({ index, tune, plans }) =>
                (globalThis as BrowserGlobal).__labs.diagnose(index, tune, plans),
              { index, tune: options.tune, plans: part.trial.runs.map((run) => run.stats!.plan!) }
            );
            for (let i = 0; i < trial.runs.length; i++) {
              const run = trial.runs[i];
              if (run.error !== undefined)
                throw new Error(
                  `Chrome diagnostics replay failed: ${String((run.error as Error).message ?? run.error)}`
                );
              if (
                JSON.stringify(run.stats?.plan) !== JSON.stringify(part.trial.runs[i]?.stats?.plan)
              ) {
                throw new Error('Chrome diagnostics replay did not follow the timing plan');
              }
              const snapshot = run.stats?.snapshot;
              const original = part.trial.runs[i]?.stats?.snapshot;
              if (
                snapshot === undefined || original === undefined
                  ? snapshot !== original
                  : snapshotsDiffer(original, snapshot, options.snapshotTolerance ?? 1e-9)
              ) {
                throw new Error('Chrome diagnostics replay produced different output');
              }
            }
            return trial;
          }, true);
          replays.push(replay);
        } catch (error) {
          failure = error;
          break;
        }
      }
      const trial = result.benchmarks[indices.indexOf(index)];
      for (let i = 0; i < trial.runs.length; i++) {
        const run = trial.runs[i];
        if (failure !== undefined) {
          run.error = failure;
          continue;
        }
        const stats = replays.map((replay) => replay.runs[i].stats!);
        const heaps = stats.map((stats) => stats.heap).filter((heap) => heap !== undefined);
        if (heaps.length === stats.length) {
          run.stats!.heap = {
            min: Math.min(...heaps.map((heap) => heap.min)),
            max: Math.max(...heaps.map((heap) => heap.max)),
            p50: median(heaps.map((heap) => heap.p50)),
            source: 'replay',
          };
        }
      }
    }
    return result;
  } finally {
    await server.close();
  }
}
