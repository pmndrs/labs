import { bench } from '../../src/index.ts';

// Sub-microsecond batched work, the shape most exposed to a sampling loop
// that is still tiering up, plus the same loop a hundred times longer.
for (const [name, n] of [
  ['fast', 300],
  ['fast scaled', 330],
  ['long', 30_000],
] as const) {
  bench(name, () => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Math.sqrt(i);
    return s;
  });
}
