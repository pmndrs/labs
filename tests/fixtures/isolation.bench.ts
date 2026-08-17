import { bench, group } from '../../src/index.ts';

// Module state acts as a contamination detector: in a shared process the
// polluter's writes are visible to the victim; in per-bench isolation each
// bench imports this module fresh and the flag is always false.
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
