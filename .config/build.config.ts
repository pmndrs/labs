import { defineBuildConfig } from 'unbuild';

export default defineBuildConfig({
  entries: ['./src/index', './src/cli', './src/worker'],
  declaration: true,
  clean: true,
  externals: ['@mitata/counters', 'bun:jsc'],
  rollup: {
    emitCJS: true,
  },
});
