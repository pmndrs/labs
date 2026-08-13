import { fileURLToPath } from 'node:url';

import { defineConfig } from 'tsdown';

const cwd = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  cwd,
  entry: {
    index: './src/index.ts',
    'cli/cli': './src/cli/cli.ts',
    worker: './src/worker.ts',
  },
  format: ['esm', 'cjs'],
  outExtensions({ format }) {
    return {
      js: format === 'es' ? '.mjs' : '.cjs',
      dts: format === 'es' ? '.d.ts' : '.d.cts',
    };
  },
  tsconfig: './tsconfig.build.json',
  dts: {
    generator: 'tsgo',
  },
  clean: true,
  deps: {
    neverBundle: ['@mitata/counters', 'bun:jsc'],
  },
});
