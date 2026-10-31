import { getBenchRegistry } from './index.ts';
import { measure, run } from './bench/index.ts';
import { runTrialAt } from './bench/main.ts';
import type { BlockPlan, MeasureOptions, Trial } from './bench/types.ts';
import { ChromeGcObservation } from './bench/lib/chrome-gc.ts';
import { calibrateClock } from './bench/lib/clock.ts';

export { assert, AssertionError, bench, defineConfig, getBenchRegistry, group } from './index.ts';

export interface BlockJob {
  index: number;
  name: string;
  group: string;
  cases: number;
  gc: boolean;
}

export interface BlockResult {
  trial: Trial;
  calibrationRate: number;
}

export interface BrowserCalibration {
  clock: MeasureOptions;
  calibrationRate: number;
}

/** Preserve errors when results cross the browser connection. */
function jsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_, value) =>
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value
    )
  );
}

export const browserHarness = {
  async run(tune: MeasureOptions) {
    const clock = calibrateClock();
    const result = await run({
      format: 'quiet',
      calibrate: clock,
      tune: { ...clock, ...tune, heap: false },
      execute: async (jobs: Array<{ trial: any; index: number }>) => {
        const registry = getBenchRegistry();
        return new Map(
          await (globalThis as any).__labsExecute(
            jobs.map(({ trial, index }): BlockJob => ({
              index,
              name: trial._name || 'anonymous',
              group: registry[index]?.groupName ?? '',
              cases: [...trial._names()].length,
              gc: trial._gc !== false,
            }))
          )
        );
      },
    });
    const registry = getBenchRegistry();
    result.benchmarks.forEach((trial, index) => {
      Object.assign(trial, { groupName: registry[index]?.groupName ?? '' });
    });
    const calibration = await measure(() => {}, { ...clock, batch_unroll: 1 });
    return jsonSafe({ ...result, environment: { postFreq: 1 / calibration.avg } });
  },

  async calibrate(): Promise<BrowserCalibration> {
    const clock = calibrateClock();
    const calibration = await measure(() => {}, { ...clock, batch_unroll: 1, min_cpu_time: 5e7 });
    return { clock, calibrationRate: 1 / calibration.avg };
  },

  async trial(
    index: number,
    tune: MeasureOptions,
    plans?: BlockPlan[],
    calibration?: BrowserCalibration,
    observe = false
  ): Promise<BlockResult> {
    const prepared = calibration ?? (await browserHarness.calibrate());
    let sequence = 0;
    if (observe) {
      Object.assign(globalThis, {
        __LABS_GC_OBSERVER: async () => {
          await (globalThis as any).__labsStartGc();
          return new ChromeGcObservation(sequence++);
        },
      });
    }
    try {
      const trial = await runTrialAt(index, { ...prepared.clock, ...tune, heap: false }, plans);
      if (!observe) trial.gcMode = false;
      return jsonSafe({ trial, calibrationRate: prepared.calibrationRate });
    } finally {
      delete (globalThis as any).__LABS_GC_OBSERVER;
    }
  },

  async diagnose(index: number, tune: MeasureOptions, plans: BlockPlan[]): Promise<Trial> {
    return jsonSafe(await runTrialAt(index, { ...calibrateClock(), ...tune }, plans));
  },
};
