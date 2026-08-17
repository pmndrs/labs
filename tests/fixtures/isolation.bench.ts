import { bench, group } from '../../src/index.ts';

// The victim observes this state only when both benches share a process.
let polluted = false;

group('isolation', () => {
  bench('polluter', () => {
    polluted = true;
    return 1;
  });

  bench('victim', () => {
    if (polluted) throw new Error('shared process state leaked between benches');
    return 1;
  });
});
