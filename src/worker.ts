import { createRequire, Module, register } from 'node:module';
import * as labs from './index.ts';

// Benchmarks and the worker must register trials in the same Labs instance.
if (process.env.LABS_BENCH_FILE) {
  register(
    `data:text/javascript,${encodeURIComponent(`
      let entry;
      export function initialize(url) { entry = url; }
      export function resolve(specifier, context, nextResolve) {
        return nextResolve(specifier === '@pmndrs/labs' ? entry : specifier, context);
      }
    `)}`,
    {
      data: new URL(import.meta.url.endsWith('.ts') ? './index.ts' : './index.mjs', import.meta.url)
        .href,
    }
  );

  // CommonJS benchmarks loaded by tsx use Node's require cache.
  const require = createRequire(process.env.LABS_BENCH_FILE);
  try {
    const entry = require.resolve('@pmndrs/labs');
    const module = new Module(entry);
    module.exports = labs;
    module.loaded = true;
    require.cache[entry] = module;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
  }
}

void import('./bench/worker.ts');
