import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, arch } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright-core';
import type { browserHarness, BrowserCalibration, BlockResult } from '../src/browser.ts';
import type { BlockPlan, MeasureOptions, Stats } from '../src/bench/types.ts';
import { chromeGcStats, type ChromeGcWindow } from '../src/bench/lib/chrome-gc.ts';
import { measure } from '../src/bench/index.ts';
import { runTrialAt } from '../src/bench/main.ts';
import { startBrowserServer } from '../src/browser-server.ts';
import { observeChromeGc } from '../src/chrome-trace.ts';
import { observeWebkitGc } from '../src/webkit-gc.ts';
import { observeFirefoxGc, prepareFirefoxGc } from '../src/firefox-gc.ts';
import { median } from '../src/stats.ts';

type BrowserGlobal = typeof globalThis & { __labs: typeof browserHarness };
type Measurement = Pick<Stats, 'p50' | 'avg' | 'gc' | 'plan'> & { sourceHash: string };
interface Input {
  index: number;
  observe: boolean;
  plan?: BlockPlan;
  tune: MeasureOptions;
}
interface Pair {
  runtime: 'node' | 'chrome' | 'bun' | 'firefox' | 'webkit';
  index: number;
  order: boolean[];
  on: Measurement;
  off: Measurement;
}

// Run with pnpm exec tsx tests/observe-gc.experiment.ts [pairs] [output.json] [plan-source.json] [runtimes].
if (process.argv[2] === 'bun-host') {
  const input = JSON.parse(process.argv[3]) as Input;
  const args = ['--no-install', fileURLToPath(import.meta.url), 'worker', process.argv[3]];
  if (input.observe) {
    const { observeBunGc } = await import('../src/bun-inspector.ts');
    const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', ...args], {
      stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
      env: { ...process.env, LABS_BUN_GC: '1' },
    });
    await observeBunGc(child);
  } else {
    execFileSync(process.execPath, args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, LABS_BUN_GC: '0' },
    });
  }
} else if (process.argv[2] === 'worker') {
  const input = JSON.parse(process.argv[3]) as Input;
  const dispose =
    process.env.LABS_BUN_GC === '1'
      ? await (await import('../src/bench/lib/bun-gc.ts')).prepareBunGc()
      : undefined;
  try {
    process.env.LABS_OBSERVE = input.observe ? '1' : '0';
    await import('./fixtures/observe-gc.bench.ts');
    await measure(() => {}, { batch_unroll: 1, min_cpu_time: 5e7 });
    const trial = await runTrialAt(input.index, input.tune, input.plan ? [input.plan] : undefined);
    const run = trial.runs[0];
    if (run.error) throw run.error;
    const { p50, avg, gc, plan, debug } = run.stats!;
    console.log(
      JSON.stringify({
        p50,
        avg,
        gc,
        plan,
        sourceHash: createHash('sha256').update(debug).digest('hex'),
      })
    );
  } finally {
    await dispose?.();
  }
} else {
  const count = Number(process.argv[2] ?? 24);
  if (!Number.isSafeInteger(count) || count < 2 || count % 2) {
    throw new Error('Pair count must be a positive even integer of at least two');
  }
  const output = process.argv[3] ?? '/tmp/labs-gc-overhead.json';
  const names = process.argv[5]?.split(',') ?? ['node', 'chrome'];
  if (names.some((name) => !['node', 'chrome', 'bun', 'firefox', 'webkit'].includes(name))) {
    throw new Error(
      'Runtimes must be a comma-separated list of node, chrome, bun, firefox, or webkit'
    );
  }
  const runtimes = names as Pair['runtime'][];
  const tune: MeasureOptions = { heap: false, min_cpu_time: 2.5e8, min_samples: 30 };
  const server = runtimes.some((runtime) => ['chrome', 'firefox', 'webkit'].includes(runtime))
    ? await startBrowserServer(new URL('./fixtures/observe-gc.bench.ts', import.meta.url).href)
    : undefined;
  const pairs: Pair[] = [];
  const plans = new Map<string, BlockPlan>();
  if (process.argv[4]) {
    const previous = JSON.parse(await readFile(process.argv[4], 'utf8')) as { pairs: Pair[] };
    for (const pair of previous.pairs) {
      plans.set(`${pair.runtime}:${pair.index}`, pair.off.plan!);
    }
  }
  const browserVersions: Partial<Record<'chrome' | 'firefox' | 'webkit', string>> = {};
  let seed = 314159;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const local = (runtime: 'node' | 'bun', input: Input) =>
    new Promise<Measurement>((resolve, reject) => {
      const child = spawn(
        runtime === 'bun' ? (process.env.LABS_BUN_EXECUTABLE ?? 'bun') : process.execPath,
        [
          ...(runtime === 'bun'
            ? ['--no-install']
            : ['--expose-gc', '--allow-natives-syntax', '--import', import.meta.resolve('tsx')]),
          fileURLToPath(import.meta.url),
          runtime === 'bun' ? 'bun-host' : 'worker',
          JSON.stringify(input),
        ],
        { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data) => (stdout += data));
      child.stderr.on('data', (data) => (stderr += data));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(stderr || `${runtime} exited ${code}`));
        else {
          try {
            resolve(JSON.parse(stdout));
          } catch (error) {
            reject(error);
          }
        }
      });
    });
  const browser = async (
    runtime: 'chrome' | 'firefox' | 'webkit',
    input: Input
  ): Promise<Measurement> => {
    const take = async (env?: NodeJS.ProcessEnv): Promise<BlockResult> => {
      const engine = { chrome: chromium, firefox, webkit }[runtime];
      const instance = await engine.launch({
        headless: true,
        ...(runtime === 'chrome'
          ? {
              channel: 'chrome',
              executablePath: process.env.LABS_CHROME_EXECUTABLE,
              args: ['--js-flags=--expose-gc --allow-natives-syntax'],
            }
          : {}),
        ...(runtime === 'firefox'
          ? {
              env: env ?? { ...process.env, MOZ_PROFILER_STARTUP: '0', MOZ_PROFILER_SHUTDOWN: '' },
            }
          : {}),
      });
      try {
        browserVersions[runtime] = instance.version();
        const page = await instance.newPage();
        await page.addInitScript(
          (observe) => Object.assign(globalThis, { __LABS_OBSERVE: observe }),
          input.observe
        );
        await page.goto(server!.url);
        await page.waitForFunction(() => !!(globalThis as BrowserGlobal).__labs);
        const calibration: BrowserCalibration = await page.evaluate(() =>
          (globalThis as BrowserGlobal).__labs.calibrate()
        );
        if (runtime !== 'chrome') await page.requestGC();
        const measure = () =>
          page.evaluate(
            ({ input, calibration, runtime }) =>
              (globalThis as BrowserGlobal).__labs.trial(
                input.index,
                input.tune,
                input.plan ? [input.plan] : undefined,
                calibration,
                input.observe ? runtime : false
              ),
            { input, calibration, runtime }
          );
        if (!input.observe) return await measure();
        if (runtime === 'webkit') return await observeWebkitGc(page, measure);
        if (runtime === 'firefox') {
          const finish = await prepareFirefoxGc(page);
          try {
            return await measure();
          } finally {
            await finish();
          }
        }
        const captured = await observeChromeGc(page, measure);
        for (const run of captured.result.trial.runs) {
          if (run.stats?.gc)
            run.stats.gc = chromeGcStats(captured.events, run.stats.gc as ChromeGcWindow);
        }
        return captured.result;
      } finally {
        await instance.close();
      }
    };
    const measured =
      runtime === 'firefox' && input.observe ? await observeFirefoxGc(take) : await take();
    const run = measured.trial.runs[0];
    if (run.error) throw run.error;
    const { p50, avg, plan, gc, debug } = run.stats!;
    return { p50, avg, plan, gc, sourceHash: createHash('sha256').update(debug).digest('hex') };
  };
  const run = (runtime: Pair['runtime'], input: Input) =>
    runtime === 'node' || runtime === 'bun' ? local(runtime, input) : browser(runtime, input);
  const tasks: Array<{ runtime: Pair['runtime']; index: number }> = [];
  for (const runtime of runtimes) {
    for (let index = 0; index < (runtime === 'firefox' || runtime === 'webkit' ? 3 : 4); index++)
      tasks.push({ runtime, index });
  }
  const shuffled = <T>(items: T[]) => {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  };
  const orders = new Map(
    tasks.map(({ runtime, index }) => [
      `${runtime}:${index}`,
      shuffled(Array.from({ length: count }, (_, i) => i % 2 === 0)),
    ])
  );
  try {
    for (const task of shuffled(tasks)) {
      if (plans.has(`${task.runtime}:${task.index}`)) continue;
      const pilot = await run(task.runtime, { index: task.index, observe: false, tune });
      plans.set(`${task.runtime}:${task.index}`, pilot.plan!);
    }
    for (let round = 0; round < count; round++) {
      for (const task of shuffled(tasks)) {
        const key = `${task.runtime}:${task.index}`;
        const first = orders.get(key)![round];
        const pair = { ...task, order: [first, !first] } as Pair;
        for (const observe of pair.order) {
          const value = await run(task.runtime, {
            index: task.index,
            observe,
            plan: plans.get(key),
            tune,
          });
          if (JSON.stringify(value.plan) !== JSON.stringify(plans.get(key)))
            throw new Error('Plan changed');
          pair[observe ? 'on' : 'off'] = value;
        }
        if (pair.on.sourceHash !== pair.off.sourceHash)
          throw new Error('Observation changed the generated sampling code');
        if (pair.on.gc === undefined || pair.off.gc !== undefined)
          throw new Error('GC observation did not follow the requested configuration');
        pairs.push(pair);
      }
      await writeFile(output, JSON.stringify({ count, tune, pairs }, null, 2));
      console.log(`Completed ${round + 1}/${count} rounds`);
    }
    const summaries = tasks.map((task) => {
      const values = pairs.filter(
        (pair) => pair.runtime === task.runtime && pair.index === task.index
      );
      const effect = (value: number) => Math.expm1(value) * 100;
      const mean = (values: number[]) =>
        values.reduce((sum, value) => sum + value, 0) / values.length;
      const estimate = (metric: 'p50' | 'avg') => {
        const ratios = values.map(({ on, off }) => Math.log(on[metric] / off[metric]));
        const boot = Array.from({ length: 20_000 }, () =>
          mean(ratios.map(() => ratios[Math.floor(random() * ratios.length)]))
        ).sort((a, b) => a - b);
        const ci95Percent = [effect(boot[500]), effect(boot[19499])];
        return {
          effectPercent: effect(mean(ratios)),
          ci95Percent,
          withinOnePercent: ci95Percent[0] >= -1 && ci95Percent[1] <= 1,
        };
      };
      return {
        ...task,
        name: ['arithmetic', 'short-lived objects', 'retained objects', 'forced major GC'][
          task.index
        ],
        median: estimate('p50'),
        average: estimate('avg'),
        offMedianNs: median(values.map((pair) => pair.off.p50)),
        onMedianNs: median(values.map((pair) => pair.on.p50)),
        observedCollections: values.reduce(
          (sum, pair) => sum + (pair.on.gc && 'count' in pair.on.gc ? pair.on.gc.count : 0),
          0
        ),
      };
    });
    await writeFile(
      output,
      JSON.stringify(
        {
          count,
          tune,
          method: {
            sampling: 'identical generated sampling code with observation on or off',
            order: 'balanced randomized adjacent pairs, fresh process per measurement',
            estimate: 'geometric mean of paired on/off ratios with 20000 paired bootstrap resamples',
            planSource: process.argv[4] || 'unobserved pilots',
            seed: 314159,
          },
          versions: {
            node: process.version,
            ...browserVersions,
            ...(runtimes.includes('bun')
              ? {
                  bun: execFileSync(process.env.LABS_BUN_EXECUTABLE ?? 'bun', ['--version'], {
                    encoding: 'utf8',
                  }).trim(),
                }
              : {}),
          },
          hardware: { cpu: cpus()[0]?.model, platform: platform(), arch: arch() },
          summaries,
          pairs,
        },
        null,
        2
      )
    );
    console.table(
      summaries.map(({ name, runtime, median, average, observedCollections }) => ({
        runtime,
        name,
        medianEffect: median.effectPercent.toFixed(2) + '%',
        medianCi95: median.ci95Percent.map((value) => value.toFixed(2) + '%').join(' to '),
        averageEffect: average.effectPercent.toFixed(2) + '%',
        averageCi95: average.ci95Percent.map((value) => value.toFixed(2) + '%').join(' to '),
        observedCollections,
      }))
    );
    console.log(output);
  } finally {
    await server?.close();
  }
}
