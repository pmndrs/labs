import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { renderInspectView } from '../src/cli/inspect-view.ts';

describe('bench inspect', () => {
  let project: string;

  afterEach(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  function inspect(source: string, ...args: string[]) {
    project = mkdtempSync(join(tmpdir(), 'labs-inspect-'));
    writeFileSync(join(project, 'package.json'), '{"type":"module"}');
    writeFileSync(
      join(project, 'labs.config.ts'),
      `import { defineConfig } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
      export default defineConfig({ benchDir: '.', blockTime: 0.02 });`
    );
    mkdirSync(join(project, 'lib'));
    writeFileSync(
      join(project, 'lib', 'vector.ts'),
      `export interface Vec { x: number; y: number }
export function lengthSq(v: Vec): number { return v.x * v.x + v.y * v.y; }
export function dist(a: Vec, b: Vec): number { return Math.sqrt(lengthSq({ x: a.x - b.x, y: a.y - b.y })); }
// Long enough that the optimizer refuses to inline it.
export function big(v: Vec): number {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    ${Array.from({ length: 40 }, (_, n) => `s += Math.hypot(v.x + ${n}, v.y) % (i + ${n + 1});`).join('\n    ')}
  }
  return s;
}`
    );
    writeFileSync(join(project, 'work.bench.ts'), source);
    return spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../src/cli/cli.ts', import.meta.url)), 'inspect', ...args],
      { cwd: project, encoding: 'utf8', timeout: 60_000 }
    );
  }

  it('reports the tiers, inlined calls, and refused calls of a workload', { timeout: 70_000 }, () => {
    const output = inspect(
      `import { bench } from '@pmndrs/labs';
import { big, dist, type Vec } from './lib/vector.ts';
const points: Vec[] = Array.from({ length: 64 }, (_, i) => ({ x: i, y: i * 2 }));
bench('path length', () => {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += dist(points[i - 1], points[i]) + big(points[i]);
  return sum;
});`,
      '--json',
      '--bytecode'
    );
    expect(output.status, output.stderr).toBe(0);
    const [bench] = JSON.parse(output.stdout).benches;
    expect(bench).toMatchObject({
      file: 'work.bench.ts',
      group: '',
      name: 'path length',
      status: 'passed',
      problem: null,
    });
    const { inspection } = bench;
    expect(inspection.engine).toMatch(/^V8 \d+\./);
    const vector = join('lib', 'vector.ts');
    expect(inspection.workload).toEqual({ name: '', source: 'work.bench.ts:4:22' });
    expect(inspection.tiers.at(-1)).toBe('TurboFan');
    expect(inspection.tiers).not.toContain('deopt');
    expect(inspection.inlined).toMatchObject([
      {
        name: 'dist',
        source: `${vector}:3:21`,
        at: 'work.bench.ts:6:50',
        calls: [{ name: 'lengthSq', at: `${vector}:3:65`, calls: [] }],
      },
    ]);
    expect(inspection.rejected).toEqual([
      {
        name: 'big',
        source: `${vector}:5:20`,
        bytecodeBytes: expect.any(Number),
        reason: 'exceeds bytecode limit',
      },
    ]);
    // The refused call is larger than the size the engine says it will inline.
    expect(inspection.rejected[0].bytecodeBytes).toBeGreaterThan(inspection.limits.inlineBytes);
    // It runs as code of its own, so it has findings and a share of the time of its own.
    expect(inspection.called).toMatchObject([{ name: 'big', source: `${vector}:5:20`, deopts: [] }]);
    expect(inspection.called[0].tiers.at(-1)).toBe('TurboFan');
    expect(inspection.called[0].time).toBeGreaterThan(0);
    expect(inspection.time + inspection.called[0].time).toBeLessThanOrEqual(1);
    expect(inspection.deopts).toEqual([]);
    expect(['alone', 'in-sampling-loop']).toContain(inspection.optimized);
    // The bench comes first, then what it calls, each by source position and without addresses.
    expect(inspection.bytecode.map((fn: { name: string }) => fn.name)).toEqual([
      '',
      'dist',
      'lengthSq',
      'big',
    ]);
    expect(inspection.bytecode[2].source).toBe(`${vector}:2:25`);
    expect(inspection.bytecode[2].listing[0]).toMatch(/^Bytecode length: \d+$/);
    expect(inspection.bytecode[2].listing.join('\n')).toMatch(/2:\d+ S>\s+0 : /);
    expect(inspection.bytecode[2].listing.join('\n')).toMatch(/: Return/);
    expect(JSON.stringify(inspection.bytecode)).not.toMatch(/0x[0-9a-f]{6,}/);
  });

  it(
    'names the reason and position of a deopt and lists bytecode on request',
    { timeout: 70_000 },
    () => {
      const output = inspect(
        `import { bench } from '@pmndrs/labs';
let input: { n: number } = { n: 1 };
function work() {
  return input.n + 1;
}
const native = (call: string) => new Function('fn', '%' + call + '(fn)')(work);
native('PrepareFunctionForOptimization');
work();
native('OptimizeFunctionOnNextCall');
work();
// A new shape invalidates the optimized code before the bench starts.
input = { extra: 0, n: 1 } as { n: number };
work();
bench('add one', work);`,
        '--bytecode'
      );
      expect(output.status, output.stderr).toBe(0);
      expect(output.stdout).toContain('add one');
      expect(output.stdout).toMatch(/function\s+work\s+\S*work\.bench\.ts:3:14/);
      expect(output.stdout).toMatch(
        /warmup\s+TurboFan\s+deopt-eager\s+\S*wrong map\S*\s+\S*work\.bench\.ts:4:16/
      );
      // Bytecode is listed by source position without addresses that change per run.
      expect(output.stdout).toMatch(/4:3 S>\s+0 : /);
      expect(output.stdout).toMatch(/: Return/);
      expect(output.stdout).not.toMatch(/0x[0-9a-f]{6,}/);
    }
  );

  it('reports property accesses that saw several object shapes', { timeout: 70_000 }, () => {
    const output = inspect(
      `import { bench } from '@pmndrs/labs';
const points = [{ x: 1 }, { x: 2, y: 0 }, { x: 3, z: 0 }];
const boxes = [{ w: 1 }, { w: 1, a: 0 }, { w: 1, b: 0 }, { w: 1, c: 0 }, { w: 1, d: 0 }, { w: 1, e: 0 }];
bench('mixed shapes', () => {
  let sum = 0;
  for (const point of points) sum += point.x;
  for (const box of boxes) sum += box.w;
  return sum;
});`,
      '--json'
    );
    expect(output.status, output.stderr).toBe(0);
    const { inspection } = JSON.parse(output.stdout).benches[0];
    expect(inspection.polymorphic).toEqual([
      {
        state: 'polymorphic',
        access: 'load',
        key: 'x',
        shapes: 3,
        layouts: ['{ x }', '{ x, y }', '{ x, z }'],
        at: 'work.bench.ts:6:44',
      },
      {
        state: 'megamorphic',
        access: 'load',
        key: 'w',
        shapes: 6,
        layouts: ['{ w }', '{ w, a }', '{ w, b }', '{ w, c }', '{ w, d }', '{ w, e }'],
        at: 'work.bench.ts:7:39',
      },
    ]);
    expect(inspection.bytecode).toBeNull();
  });

  it('follows functions, code, and shapes that a collection moves', { timeout: 70_000 }, () => {
    const output = inspect(
      `import { setFlagsFromString } from 'node:v8';
import { bench } from '@pmndrs/labs';
// Every full collection now moves what it can, including the function below,
// its bytecode, and the shapes it reads.
setFlagsFromString('--compact-on-every-full-gc');
const boxes = [{ w: 1 }, { w: 1, a: 0 }, { w: 1, b: 0 }, { w: 1, c: 0 }, { w: 1, d: 0 }, { w: 1, e: 0 }];
let calls = 0;
const work = () => {
  if (calls++ === 1) globalThis.gc();
  let sum = 0;
  for (const box of boxes) sum += box.w;
  return sum;
};
// Unoptimized code keeps reporting where its accesses are after the move.
new Function('fn', '%NeverOptimizeFunction(fn)')(work);
bench('across a collection', work);`,
      '--json'
    );
    expect(output.status, output.stderr).toBe(0);
    const { inspection } = JSON.parse(output.stdout).benches[0];
    expect(inspection.workload).toEqual({ name: 'work', source: 'work.bench.ts:8:14' });
    expect(inspection.tiers[0]).toBe('Ignition');
    expect(inspection.polymorphic).toEqual([
      {
        state: 'megamorphic',
        access: 'load',
        key: 'w',
        shapes: 6,
        layouts: ['{ w }', '{ w, a }', '{ w, b }', '{ w, c }', '{ w, d }', '{ w, e }'],
        at: 'work.bench.ts:11:39',
      },
    ]);
  });

  it('shows the benches as a list with the findings of the selected one below', () => {
    const passed = { status: 'passed', problem: null, message: '', advice: '' } as const;
    const { lines } = renderInspectView(
      [
        {
          file: 'work.bench.ts',
          group: 'paths',
          name: 'path length',
          ...passed,
          inspection: {
            engine: 'V8 13.6.233.17',
            workload: { name: '', source: 'work.bench.ts:4:22' },
            tiers: ['Ignition', 'TurboFan', 'deopt', 'TurboFan'],
            optimized: 'alone',
            limits: { inlineBytes: 460, inlineTotalBytes: 920 },
            time: 0.25,
            inlined: [
              {
                name: 'dist',
                source: 'lib/vector.ts:3:21',
                at: 'work.bench.ts:6:50',
                bytecodeBytes: 61,
                calls: [],
              },
            ],
            rejected: [
              {
                name: 'big',
                source: 'lib/vector.ts:5:20',
                bytecodeBytes: 612,
                reason: 'exceeds bytecode limit',
              },
            ],
            polymorphic: [
              {
                state: 'megamorphic',
                access: 'load',
                key: 'area',
                shapes: 5,
                layouts: ['Square { side }', 'Circle { radius }'],
                at: 'shapes.ts:2:37',
              },
            ],
            deopts: [
              {
                phase: 'sampling',
                tier: 'TurboFan',
                kind: 'deopt-eager',
                reason: 'wrong map',
                at: ['lib/vector.ts:3:87', 'work.bench.ts:6:50'],
              },
            ],
            called: [
              {
                name: 'big',
                source: 'lib/vector.ts:5:20',
                bytecodeBytes: 612,
                time: 0.75,
                tiers: ['Ignition', 'TurboFan'],
                inlined: [],
                rejected: [],
                polymorphic: [],
                deopts: [],
              },
            ],
            bytecode: null,
          },
        },
        {
          file: 'work.bench.ts',
          group: 'paths',
          name: 'broken',
          status: 'failed',
          problem: 'failed',
          message: 'BOOM',
          advice: '',
          inspection: null,
        },
      ],
      { columns: 100, rows: 44, selected: 0, colors: false }
    );
    const screen = lines.join('\n');
    expect(lines).toHaveLength(44);
    expect(screen).toContain('INSPECT');
    expect(screen).toMatch(/› ✓ path length\s+1\s+1/);
    expect(screen).toMatch(/✗ broken\s+—\s+—/);
    expect(screen).toMatch(/dist\s+lib\/vector\.ts:3:21\s+work\.bench\.ts:6:50\s+61 B/);
    expect(screen).toMatch(/big\s+lib\/vector\.ts:5:20\s+612 B\s+exceeds bytecode limit/);
    expect(screen).toContain('460 B of bytecode per call, 920 B in total');
    expect(screen).toContain('Ignition → TurboFan → deopt → TurboFan');
    expect(screen).toMatch(
      /megamorphic\s+load area\s+5\+\s+shapes\.ts:2:37\s+Square \{ side \} · Circle \{ radius \}/
    );
    expect(screen).toMatch(/time\s+25% of the sampled time/);
    expect(screen).toMatch(/called ✦ 1\s+defined\s+time\s+bytecode\s+tier\s+deopts/);
    expect(screen).toMatch(/big\s+lib\/vector\.ts:5:20\s+75%\s+612 B\s+TurboFan\s+0/);
    expect(screen).toMatch(/wrong map\s+lib\/vector\.ts:3:87 ← work\.bench\.ts:6:50/);
    expect(screen).toContain('1 inspected  1 failed');
  });

  it('explains that only the node runtime can be inspected', () => {
    const output = inspect(
      `import { bench } from '@pmndrs/labs'; bench('work', () => 1);`,
      '--runtime',
      'bun'
    );
    expect(output.status).toBe(1);
    expect(output.stderr).toContain('only supports the node runtime');
  });
});
