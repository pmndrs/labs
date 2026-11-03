import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

describe('CLI options', () => {
  let cwd: string;

  afterEach(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  function run(...args: string[]) {
    cwd = mkdtempSync(join(tmpdir(), 'labs-cli-'));
    return spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
        fileURLToPath(new URL('../src/cli/cli.ts', import.meta.url)),
        ...args,
      ],
      { cwd, encoding: 'utf8', timeout: 30_000 }
    );
  }

  it('prints usage for --help without a config', () => {
    const output = run('--help');
    expect(output.status).toBe(0);
    expect(output.stdout).toContain('Usage');
    expect(output.stdout).toContain('--against <rev|dir>');
  });

  it('rejects an unknown option before running', () => {
    const output = run('--blcoks', '4');
    expect(output.status).toBe(1);
    expect(output.stderr).toContain('Unknown option "--blcoks" for bench run');
  });

  it('rejects run options on subcommands', () => {
    const output = run('compare', 'v1', '--blocks=4');
    expect(output.status).toBe(1);
    expect(output.stderr).toContain('Unknown option "--blocks" for bench compare');
  });
});
