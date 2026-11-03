import { createRequire } from 'node:module';
import type { Runtime } from './config.ts';

export class RuntimeLaunchError extends Error {
  constructor(runtime: Exclude<Runtime, 'node'>, cause: unknown, executablePath?: string) {
    const label = { chrome: 'Chrome', bun: 'Bun', firefox: 'Firefox', webkit: 'WebKit' }[runtime];
    const reason = cause instanceof Error ? cause.message : String(cause);
    const missing = /ENOENT|executable doesn't exist|distribution .* is not found/i.test(reason);
    let advice = `Check the ${runtime} options in labs.config.ts and the launch error below.`;
    if (executablePath) {
      advice = `Check ${runtime}.executablePath in labs.config.ts. It must point to an executable file.`;
    } else if (runtime === 'bun') {
      advice = missing
        ? 'Install Bun and make sure bun is on PATH, or set bun.executablePath in labs.config.ts.'
        : 'Check that bun is executable and on PATH, or set bun.executablePath in labs.config.ts.';
    } else if (missing) {
      advice =
        runtime === 'chrome'
          ? 'Install Google Chrome or set chrome.executablePath in labs.config.ts.'
          : `Run pnpm dlx playwright-core@${createRequire(import.meta.url)('playwright-core/package.json').version} install ${runtime}.`;
    }
    super(`${label} failed to start.\n${advice}\n\n${missing ? reason.split('\n')[0] : reason}`, {
      cause,
    });
    this.name = 'RuntimeLaunchError';
  }
}
