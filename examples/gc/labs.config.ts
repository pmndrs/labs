import { defineConfig } from '../../src/config.ts';

export default defineConfig({
  benchDir: '.',
  benchMatch: '**/*.bench.ts',
  blocks: 3,
  blockTime: 0.15,
});
