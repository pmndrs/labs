import { bench, group } from '../../src/index.ts';

bench('sum', function* () {
  let s = 0;
  yield {
    bench: () => {
      s = 0;
      for (let i = 0; i < 1000; i++) s += i;
      return s;
    },
    metrics: () => ({
      retainedBytes: process.env.LABS_BLOCK_PLANS ? 4096 : 1024,
      ...(process.env.LABS_BLOCK_PLANS ? {} : { pilotOnly: 1 }),
    }),
  };
  return s;
});

group('blocked', () => {
  bench('concat', () => {
    let s = '';
    for (let i = 0; i < 50; i++) s += i;
    return s;
  });
});
