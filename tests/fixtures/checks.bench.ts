import { assert, bench, group } from '../../src/index.ts';

group('checks', () => {
  bench('passes', function* () {
    const input = [3, 1, 2];
    const out = yield () => input.toSorted((a, b) => a - b);
    assert.equal(out, [1, 2, 3]);
    return out;
  });

  bench('fails', function* () {
    const out = yield () => 1 + 1;
    assert.equal(out, 3);
  });

  bench('mutates', function* () {
    const state = { count: 0 };
    yield {
      bench: () => {
        state.count++;
      },
      snapshot: () => state.count,
    };
  });
});
