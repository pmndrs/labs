import { defineConfig } from 'vitest/config';

// Tests measure real timing and spawn CPU-saturating bench workers, so test
// files must not compete for cores. Serial execution keeps timings stable.
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 20_000,
    // Heap and gc accounting need the real collector, as the CLI provides
    execArgv: ['--expose-gc'],
  },
});
