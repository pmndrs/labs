import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readNodeInspection } from '../src/bench/node-inspect.ts';
import { renderInspectView } from '../src/cli/inspect-view.ts';

describe('bench inspect', () => {
  let project: string;

  afterEach(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  function inspect(input: string | { source: string; preload: string }, ...args: string[]) {
    project = mkdtempSync(join(tmpdir(), 'labs-inspect-'));
    const { source, preload } = typeof input === 'string' ? { source: input, preload: '' } : input;
    const env = { ...process.env };
    if (preload) {
      writeFileSync(join(project, 'preload.cjs'), preload);
      env.NODE_OPTIONS = [env.NODE_OPTIONS, '--require ./preload.cjs'].filter(Boolean).join(' ');
    }
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
      { cwd: project, env, encoding: 'utf8', timeout: 60_000 }
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
    'attributes samples and bytecode to generated walks and honors a workload sourceURL',
    { timeout: 70_000 },
    () => {
      const output = inspect(
        `import { bench } from '@pmndrs/labs';
function compileWalk() {
  return new Function(\`return function walk(page) {
    let sum = 0;
    for (let i = 0; i < page.count; i++) sum += page.rows[i].value;
    return sum;
  }\`)();
}
globalThis.walk = compileWalk();
globalThis.page = {
  count: 4096,
  rows: Array.from({ length: 4096 }, (_, i) => i % 2 ? { value: i } : { extra: 0, value: i }),
};
new Function('fn', '%NeverOptimizeFunction(fn)')(globalThis.walk);
bench('record cursor', new Function('return globalThis.walk(globalThis.page)\\n//# sourceURL=controls/record-cursor.js'));`,
        '--json',
        '--bytecode'
      );
      expect(output.status, output.stderr).toBe(0);
      const { inspection } = JSON.parse(output.stdout).benches[0];
      expect(inspection.workload.source).toMatch(/^controls\/record-cursor\.js:\d+:\d+$/);
      expect(inspection.called).toMatchObject([
        {
          name: 'walk',
          source: expect.stringMatching(/^<generated compileWalk#[\da-f]+>:3:\d+$/),
          tiers: expect.arrayContaining(['Ignition']),
          polymorphic: [expect.objectContaining({ key: 'value', shapes: 2 })],
        },
      ]);
      const [walk] = inspection.called;
      expect(walk.time).toBeGreaterThan(0);
      expect(walk.polymorphic[0].at).toBe(walk.source.replace(/:3:\d+$/, ':5:62'));
      expect(inspection.bytecode).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ...inspection.workload, listing: expect.any(Array) }),
          expect.objectContaining({
            name: 'walk',
            source: walk.source,
            listing: expect.arrayContaining([expect.stringMatching(/5:\d+ [SE]>/)]),
          }),
        ])
      );
    }
  );

  it(
    'reports a preloaded function that runs both inline and as a separate call',
    { timeout: 70_000 },
    () => {
      const output = inspect(
        {
          preload: `globalThis.transform = new Function('n', \`let value = n;
          for (let i = 0; i < 32; i++) value = Math.imul(value + i, n);
          return value;
          //# sourceURL=transform.js\`);
//# sourceURL=virtual-preload.js`,
          source: `import { bench } from '@pmndrs/labs';
const transform = globalThis.transform;
function batch(n) {
  let sum = 0;
  for (let i = 0; i < 128; i++) sum += transform(n + i);
  return sum;
}
new Function('fn', '%NeverOptimizeFunction(fn)')(batch);
let n = 0;
bench('two paths', () => transform(++n) + batch(n));`,
        },
        '--json'
      );
      expect(output.status, output.stderr).toBe(0);
      const { inspection } = JSON.parse(output.stdout).benches[0];
      const inlined = inspection.inlined.find((fn: { source: string }) =>
        fn.source.startsWith('transform.js:')
      );
      expect(inlined).toBeDefined();
      const called = inspection.called.find((fn: { source: string }) => fn.source === inlined.source);
      expect(called?.time).toBeGreaterThan(0);
    }
  );

  it(
    'locates a deopt inside an inlined generated function and lists its bytecode',
    { timeout: 70_000 },
    () => {
      const output = inspect(
        `import { bench } from '@pmndrs/labs';
let input: { n: number } = { n: 1 };
const read = new Function('input', 'return input.n + 1;\\n//# sourceURL=read.js');
function work() {
  return read(input);
}
const native = (call: string) => new Function('fn', '%' + call + '(fn)')(work);
native('PrepareFunctionForOptimization');
for (let i = 0; i < 64; i++) work();
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
      expect(output.stdout).toMatch(/function\s+work\s+\S*work\.bench\.ts:4:14/);
      expect(output.stdout).toMatch(
        /warmup\s+TurboFan\s+deopt-eager\s+\S*wrong map\S*\s+read\.js:3:14 ← work\.bench\.ts:5:10/
      );
      // Bytecode is listed by source position without addresses that change per run.
      expect(output.stdout).toMatch(/5:3 S>\s+0 : /);
      expect(output.stdout).toMatch(/: Return/);
      expect(output.stdout).not.toMatch(/0x[0-9a-f]{6,}/);
    }
  );

  it('keeps bytecode with each generated script when V8 reuses both heap addresses', () => {
    project = mkdtempSync(join(tmpdir(), 'labs-inspect-'));
    writeFileSync(
      join(project, 'scripts.json'),
      JSON.stringify({
        2: { caller: '1', label: 'first.js' },
        3: { caller: '1', label: 'second.js' },
      })
    );
    writeFileSync(
      join(project, 'isolate-code.log'),
      [
        `script-source,1,${pathToFileURL(join(project, 'work.bench.ts')).href},`,
        ...[2, 3].flatMap((script) => [
          `script-source,${script},<unknown>,`,
          'code-creation,JS,10,0,0x200,2,walk :1:20,0x100,~',
          `code-source-info,0x200,${script},19,21,,,`,
        ]),
        'code-creation,JS,10,0,0x300,1,labsDeoptStart0 :1:1,0x310,~',
      ].join('\n')
    );
    writeFileSync(
      join(project, 'traces.txt'),
      ['LdaTrue', 'LdaFalse']
        .map(
          (op) =>
            `[generated bytecode for function: walk (0x101 <SharedFunctionInfo walk>)]
Bytecode length: 2
0x200 @    0 : 11 ${op}
Handler Table (size = 0)`
        )
        .join('\n')
    );
    for (const [script, source, op] of [
      [2, 'first.js', 'LdaTrue'],
      [3, 'second.js', 'LdaFalse'],
    ]) {
      const result = readNodeInspection(project, { id: 0, targets: [`${script},19`] });
      expect(result?.bytecode).toMatchObject([
        {
          source: `${source}:1:20`,
          listing: ['Bytecode length: 2', expect.stringContaining(`0 : ${op}`)],
        },
      ]);
    }
  });

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

  it('inspects only the benches a name filter selects', { timeout: 70_000 }, () => {
    const output = inspect(
      `import { bench, group } from '@pmndrs/labs';
group('vectors', () => {
  bench('dot product', () => 1 + 1);
  bench('cross product', () => 2 + 2);
});
bench('path length', () => 3 + 3);`,
      '--json',
      '--filter',
      'vectors'
    );
    expect(output.status, output.stderr).toBe(0);
    const names = JSON.parse(output.stdout).benches.map((bench: { name: string }) => bench.name);
    expect(names).toEqual(['dot product', 'cross product']);
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
