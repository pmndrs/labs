import { bench, group } from '../../src/index.ts';

bench('sum', () => {
  let s = 0;
  for (let i = 0; i < 1000; i++) s += i;
  return s;
});

void group('blocked', () => {
  bench('concat', () => {
    let s = '';
    for (let i = 0; i < 50; i++) s += i;
    return s;
  });
});
