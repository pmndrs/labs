import { defineConfig } from '../../src/config.ts';

export default defineConfig({
  benchDir: '.',
  benchMatch: '**/*.bench.ts',
  runtime: 'chrome',
  blocks: 6,
  // Chrome reads heap by replaying every CPU block, which costs more than the run itself here
  heap: false,
});
