import { bench } from '../../src/index.ts';

const observe = (globalThis as any).__LABS_OBSERVE ?? process.env.LABS_OBSERVE === '1';

bench('arithmetic', function* () {
  let value = 1;
  yield () => {
    for (let i = 0; i < 64; i++) value = Math.imul(value ^ (value >>> 13), 1597334677);
    return value;
  };
}).gc(observe);

bench('short-lived objects', function* () {
  const history = Array.from({ length: 8 });
  let cursor = 0;
  yield () => {
    const values = Array.from({ length: 128 }, (_, i) => ({ x: i, y: i + cursor, z: i * 2 }));
    history[cursor++ % history.length] = values;
    return values;
  };
}).gc(observe);

bench('retained objects', function* () {
  const history = Array.from({ length: 128 });
  let cursor = 0;
  yield () => {
    const values = Array.from({ length: 1024 }, (_, i) => ({ x: i, y: i + cursor, z: i * 2 }));
    history[cursor++ % history.length] = values;
    return values;
  };
}).gc(observe);

bench('forced major GC', () => {
  (globalThis as any).gc();
  return 1;
}).gc(observe);
