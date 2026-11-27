export interface Vec {
  x: number;
  y: number;
}

export type Mat4 = Float64Array;

export function lengthSq(v: Vec): number {
  return v.x * v.x + v.y * v.y;
}

export function distance(a: Vec, b: Vec): number {
  return Math.sqrt(lengthSq({ x: a.x - b.x, y: a.y - b.y }));
}

export function pathLength(points: Vec[]): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += distance(points[i - 1], points[i]);
  return sum;
}

export class Circle {
  sides = () => 0;
}
export class Triangle {
  sides = () => 3;
}
export class Square {
  sides = () => 4;
}
export class Hexagon {
  sides = () => 6;
}
export class Octagon {
  sides = () => 8;
}

export function trace(m: Mat4): number {
  return m[0] + m[5] + m[10] + m[15];
}

/** Written out in full, which makes it too large for the optimizer to inline. */
export function multiply(out: Mat4, a: Mat4, b: Mat4): Mat4 {
  out[0] = a[0] * b[0] + a[4] * b[1] + a[8] * b[2] + a[12] * b[3];
  out[1] = a[1] * b[0] + a[5] * b[1] + a[9] * b[2] + a[13] * b[3];
  out[2] = a[2] * b[0] + a[6] * b[1] + a[10] * b[2] + a[14] * b[3];
  out[3] = a[3] * b[0] + a[7] * b[1] + a[11] * b[2] + a[15] * b[3];
  out[4] = a[0] * b[4] + a[4] * b[5] + a[8] * b[6] + a[12] * b[7];
  out[5] = a[1] * b[4] + a[5] * b[5] + a[9] * b[6] + a[13] * b[7];
  out[6] = a[2] * b[4] + a[6] * b[5] + a[10] * b[6] + a[14] * b[7];
  out[7] = a[3] * b[4] + a[7] * b[5] + a[11] * b[6] + a[15] * b[7];
  out[8] = a[0] * b[8] + a[4] * b[9] + a[8] * b[10] + a[12] * b[11];
  out[9] = a[1] * b[8] + a[5] * b[9] + a[9] * b[10] + a[13] * b[11];
  out[10] = a[2] * b[8] + a[6] * b[9] + a[10] * b[10] + a[14] * b[11];
  out[11] = a[3] * b[8] + a[7] * b[9] + a[11] * b[10] + a[15] * b[11];
  out[12] = a[0] * b[12] + a[4] * b[13] + a[8] * b[14] + a[12] * b[15];
  out[13] = a[1] * b[12] + a[5] * b[13] + a[9] * b[14] + a[13] * b[15];
  out[14] = a[2] * b[12] + a[6] * b[13] + a[10] * b[14] + a[14] * b[15];
  out[15] = a[3] * b[12] + a[7] * b[13] + a[11] * b[14] + a[15] * b[15];
  return out;
}
