import * as module from 'node:module';
import * as labs from './index.ts';

// Benchmarks and the worker must register trials in the same Labs instance.
if (process.env.LABS_BENCH_FILE) {
  const entry = new URL(
    import.meta.url.endsWith('.ts') ? './index.ts' : './index.mjs',
    import.meta.url
  ).href;
  if (typeof module.registerHooks === 'function') {
    module.registerHooks({
      resolve(specifier, context, nextResolve) {
        return nextResolve(
          specifier === '@pmndrs/labs' && !context.conditions.includes('require') ? entry : specifier,
          context
        );
      },
    });
  } else {
    module.register(
      `data:text/javascript,${encodeURIComponent(`
      let entry;
      export function initialize(url) { entry = url; }
      export function resolve(specifier, context, nextResolve) {
        return nextResolve(specifier === '@pmndrs/labs' ? entry : specifier, context);
      }
    `)}`,
      { data: entry }
    );
  }

  // CommonJS benchmarks loaded by tsx use Node's require cache.
  const require = module.createRequire(process.env.LABS_BENCH_FILE);
  try {
    const entry = require.resolve('@pmndrs/labs');
    const cached = new module.Module(entry);
    cached.exports = labs;
    cached.loaded = true;
    require.cache[entry] = cached;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
  }
}

void import('./bench/worker.ts');
