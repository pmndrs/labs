import { defineConfig } from 'vitest/config';

// Tests measure real timing and spawn CPU-saturating bench workers, so test
// files must not compete for cores. Serial execution keeps timings stable.
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
