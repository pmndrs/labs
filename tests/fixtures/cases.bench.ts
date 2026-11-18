import { bench } from '../../src/index.ts';

// A case observes an earlier setup only when both cases share a process.
let setups = 0;

bench('case $n', function* () {
  if (setups++) throw new Error('shared process state leaked between cases');
  yield () => 1;
}).args('n', [1, 2]);
