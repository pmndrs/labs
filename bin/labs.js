#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  [
    '--import',
    'tsx',
    new URL('../src/cli/cli.ts', import.meta.url).pathname,
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' }
);

process.exit(result.status ?? 1);
