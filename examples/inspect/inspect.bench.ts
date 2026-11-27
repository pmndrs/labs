import { bench, group } from '../../src/index.ts';
import {
  Circle,
  Hexagon,
  type Mat4,
  Octagon,
  Square,
  Triangle,
  type Vec,
  multiply,
  pathLength,
  trace,
} from './geometry.ts';

const line = (): Vec[] => Array.from({ length: 64 }, (_, i) => ({ x: i, y: i * 2 }));
const matrix = (): Mat4 => Float64Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 1 : 0.01 * i));

group('inlining', () => {
  // pathLength calls distance, which calls lengthSq. All three are small.
  bench('inlined calls', function* () {
    const points = line();
    yield () => pathLength(points);
  });

  // multiply is too large to inline and pinned is barred from optimization.
  bench('refused calls', function* () {
    const a = matrix();
    const b = matrix();
    const out = matrix();
    const pinned = (m: Mat4) => trace(m) * 0.5;
    // oxlint-disable-next-line typescript/no-implied-eval
    new Function('fn', '%NeverOptimizeFunction(fn)')(pinned);
    yield () => pinned(multiply(out, a, b));
  });
});

group('deopts', () => {
  // Every point starts with the same shape, so the optimizer assumes it. A
  // point with an extra field then arrives a few times while the bench runs.
  bench('shape change', function* () {
    const points = line();
    const started = performance.now();
    let calls = 0;
    let next = 100;
    yield () => {
      if ((++calls & 255) === 0 && next <= 400 && performance.now() - started > next) {
        points[next % points.length] = { x: 1, y: 2, ['tag' + next]: true } as Vec;
        next += 150;
      }
      return pathLength(points);
    };
  });
});

group('shapes', () => {
  // The same two lines of code see three kinds of point and five kinds of
  // shape. The first access stays polymorphic and the second turns megamorphic.
  bench('mixed shapes', function* () {
    const points = [{ x: 1 }, { x: 2, y: 0 }, { x: 3, z: 0 }];
    const shapes = [new Square(), new Circle(), new Triangle(), new Hexagon(), new Octagon()];
    yield () => {
      let sum = 0;
      for (const point of points) sum += point.x;
      for (const shape of shapes) sum += shape.sides();
      return sum;
    };
  });
});

group('tiers', () => {
  // Too slow to batch, so it is called once per sample and optimized alone.
  bench('slow work', function* () {
    const unsorted = Array.from({ length: 4096 }, (_, i) => (i * 7919) % 4096);
    yield () => unsorted.slice().sort((x, y) => x - y);
  });
});
