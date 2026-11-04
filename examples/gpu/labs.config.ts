import { defineConfig } from '../../src/config.ts';

export default defineConfig({
  benchDir: '.',
  benchMatch: '**/*.bench.ts',
  runtime: 'chrome',
  blocks: 6,
  heap: false,
});
