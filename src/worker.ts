import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as module from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as labs from './index.ts';
import { stripTypes } from './utils/strip-types.ts';

if (process.env.LABS_BENCH_FILE && !(globalThis as any).Bun) {
  const entry = new URL(
    import.meta.url.endsWith('.ts') ? './index.ts' : './index.mjs',
    import.meta.url
  ).href;
  const cache = join(tmpdir(), `labs-strip-${userInfo().uid}`);
  mkdirSync(cache, { recursive: true });

  module.registerHooks({
    // Benchmarks and the worker must register trials in the same Labs instance.
    resolve(specifier, context, nextResolve) {
      return nextResolve(specifier === '@pmndrs/labs' ? entry : specifier, context);
    },
    // TypeScript runs as the text Node's own type stripping produces. Reading
    // that text from disk spares every block from loading the stripper.
    load(url, context, nextLoad) {
      if (context.format !== 'module-typescript') return nextLoad(url, context);
      const source = readFileSync(fileURLToPath(url));
      const file = join(
        cache,
        createHash('sha1').update(process.version).update(source).digest('hex') + '.js'
      );
      let code: string;
      try {
        code = readFileSync(file, 'utf8');
      } catch {
        try {
          code = stripTypes(source.toString());
        } catch {
          // Node reports unsupported syntax with the file and position.
          return nextLoad(url, context);
        }
        writeFileSync(`${file}.${process.pid}`, code);
        renameSync(`${file}.${process.pid}`, file);
      }
      return { format: 'module', source: code, shortCircuit: true };
    },
  });

  // A CommonJS benchmark requires Labs through Node's require cache, which
  // would otherwise hand it a second instance.
  const require = module.createRequire(process.env.LABS_BENCH_FILE);
  try {
    const installed = require.resolve('@pmndrs/labs');
    const cached = new module.Module(installed);
    cached.exports = labs;
    cached.loaded = true;
    require.cache[installed] = cached;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
  }
}

void import('./bench/worker.ts');
