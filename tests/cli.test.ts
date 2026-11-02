import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(
      join(cwd, 'labs.config.ts'),
      `import { defineConfig } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
      export default defineConfig({ benchDir: '.', blockTime: 1e-9, minSamples: 2, blocks: 1 });`
    );
    for (const [name, tag] of [
      ['alpha', '@fast'],
      ['beta', '@fast'],
      ['gamma', '@slow'],
    ])
      writeFileSync(
        join(cwd, `${name}.bench.ts`),
        `import { bench } from '@pmndrs/labs'; bench('${name} ${tag}', () => 1);`
      );
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

  it('takes every positional as a filter token', () => {
    const output = run('--no-save', '--json', 'alpha', 'beta @fast');
    expect(output.status, output.stderr).toBe(0);
    const files = JSON.parse(output.stdout).benches.map((bench: { file: string }) => bench.file);
    expect(files).toEqual(['alpha.bench.ts', 'beta.bench.ts']);
  });

  it('rejects run options on subcommands', () => {
    const output = run('compare', 'v1', '--blocks=4');
    expect(output.status).toBe(1);
    expect(output.stderr).toContain('Unknown option "--blocks" for bench compare');
  });
});
