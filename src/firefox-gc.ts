import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import type { BlockResult } from './browser.ts';
import type { ChromeGcWindow } from './bench/lib/chrome-gc.ts';
import { firefoxGcStats, type FirefoxProfile } from './bench/lib/firefox-gc.ts';

/** Drain native collections outside each sampling window. */
export async function prepareFirefoxGc(page: Page): Promise<() => Promise<void>> {
  let pending = Promise.resolve();
  const collect = () => (pending = pending.then(() => page.requestGC()));
  await page.exposeFunction('__labsFinishGc', collect);
  return () => pending;
}

/** Record native markers without periodic stack sampling and decode after browser shutdown. */
export async function observeFirefoxGc(
  run: (env: NodeJS.ProcessEnv) => Promise<BlockResult>
): Promise<BlockResult> {
  const directory = await mkdtemp(join(tmpdir(), 'labs-firefox-gc-'));
  const file = join(directory, 'profile.json');
  try {
    const result = await run({
      ...process.env,
      MOZ_PROFILER_STARTUP: '1',
      MOZ_PROFILER_STARTUP_FEATURES: 'nostacksampling',
      MOZ_PROFILER_STARTUP_FILTERS: 'GeckoMain',
      MOZ_PROFILER_STARTUP_ENTRIES: '1000000',
      MOZ_PROFILER_SHUTDOWN: file,
    });
    const profile = JSON.parse(await readFile(file, 'utf8')) as FirefoxProfile;
    const features = profile.meta.configuration?.features;
    if (features?.length !== 1 || features[0] !== 'nostacksampling')
      throw new Error('Firefox GC profile unexpectedly enabled stack sampling');
    for (const run of result.trial.runs) {
      if (run.stats?.gc) run.stats.gc = firefoxGcStats(profile, run.stats.gc as ChromeGcWindow);
    }
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
