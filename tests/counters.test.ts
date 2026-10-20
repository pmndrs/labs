import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('configured hardware counters', () => {
  it.skipIf(!['darwin', 'linux'].includes(process.platform)).each([
    { name: 'ESM-only', exports: { import: './index.mjs' } },
    { name: 'conditional', exports: { import: './index.mjs', require: './index.cjs' } },
  ])('loads a project-local $name provider from the config directory', ({ exports }) => {
    const project = mkdtempSync(join(tmpdir(), 'labs-counters-'));
    try {
      writeFileSync(join(project, 'package.json'), JSON.stringify({ type: 'module' }));
      const configDir = join(project, 'benches');
      const providerDir = join(configDir, 'node_modules', 'labs-test-counters');
      mkdirSync(providerDir, { recursive: true });
      writeFileSync(
        join(providerDir, 'package.json'),
        JSON.stringify({ name: 'labs-test-counters', exports })
      );
      writeFileSync(
        join(providerDir, 'index.mjs'),
        `import { appendFileSync } from 'node:fs';
        appendFileSync(${JSON.stringify(join(project, 'loaded.txt'))}, process.pid + '\\n');
        export function init() { throw new Error('Counters unavailable in this fixture'); }`
      );
      writeFileSync(join(providerDir, 'index.cjs'), 'throw new Error("Wrong export condition");');
      writeFileSync(
        join(configDir, 'labs.config.ts'),
        `import { defineConfig } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
        export default defineConfig({
          benchDir: '.', blockTime: 1e-9, minSamples: 2, blocks: 2,
          counters: 'labs-test-counters'
        });`
      );
      writeFileSync(
        join(configDir, 'work.bench.ts'),
        `import { bench } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
        bench('work', () => 42);`
      );

      const output = execFileSync(
        process.execPath,
        [
          '--import',
          pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
          fileURLToPath(new URL('../src/cli/cli.ts', import.meta.url)),
          '--no-save',
          '--json',
        ],
        { cwd: project, stdio: 'pipe', encoding: 'utf8', timeout: 20_000 }
      );

      expect(JSON.parse(output).benches).toEqual([expect.objectContaining({ name: 'work' })]);
      expect(new Set(readFileSync(join(project, 'loaded.txt'), 'utf8').trim().split('\n')).size).toBe(
        3
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
