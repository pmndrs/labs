import { bench } from '../../src/index.ts';

bench('collect during sampling', function* () {
  globalThis.gc!();
  yield () => globalThis.gc!();
  globalThis.gc!();
});
