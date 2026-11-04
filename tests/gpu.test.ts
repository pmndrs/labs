import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { webkit } from 'playwright-core';
import { afterEach, describe, expect, it } from 'vitest';
import { loadResult } from '../src/store.ts';

const chrome = [
  process.env.LABS_CHROME_EXECUTABLE,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
].find((path) => path && existsSync(path));

// A compute dispatch over 1M floats timed on the GPU, with its encode and compile as CPU benches
const source = `import { bench } from '@pmndrs/labs';
const code = \`@group(0) @binding(0) var<storage, read_write> data: array<f32>;
  @compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    var v = data[id.x] + 1.0;
    for (var i = 0u; i < 16u; i++) { v = sin(v) * 1.0001 + 0.5; }
    data[id.x] = v;
  }\`;
function build(device) {
  const module = device.createShaderModule({ code });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module } });
  const buffer = device.createBuffer({ size: (1 << 20) * 4, usage: GPUBufferUsage.STORAGE });
  const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer } }] });
  return { pipeline, bind };
}
bench.gpu('dispatch', function* ({ device }) {
  const { pipeline, bind } = build(device);
  yield { compute: (pass) => {
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(4096);
  } };
});
bench('encode', async function* ({ gpu }) {
  const device = await gpu;
  const { pipeline, bind } = build(device);
  yield () => {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(4096);
    pass.end();
    device.queue.submit([encoder.finish()]);
  };
});
bench.gpu('alloc', function* ({ device }) {
  const { pipeline, bind } = build(device);
  yield { compute: (pass) => {
    device.createBuffer({ size: 65536, usage: GPUBufferUsage.STORAGE });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(4096);
  } };
});
bench('compile', async function* ({ gpu, fresh }) {
  const device = await gpu;
  yield async () => {
    const module = device.createShaderModule({ code: fresh(code) });
    await device.createComputePipelineAsync({ layout: 'auto', compute: { module } });
  };
});`;

describe('GPU benches', () => {
  let project: string;

  afterEach(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  function setup(runtime: string, config: Record<string, unknown> = {}) {
    project = mkdtempSync(join(tmpdir(), `labs-gpu-${runtime}-`));
    writeFileSync(join(project, 'package.json'), '{"type":"module"}');
    writeFileSync(
      join(project, 'labs.config.ts'),
      `import { defineConfig } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
      export default defineConfig(${JSON.stringify({
        benchDir: '.',
        runtime,
        blocks: 6,
        blockTime: 0.1,
        heap: false,
        ...config,
      })});`
    );
    writeFileSync(join(project, 'gpu.bench.ts'), source);
    return spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
        fileURLToPath(new URL('../src/cli/cli.ts', import.meta.url)),
        '--json',
        '-n',
        'gpu',
      ],
      { cwd: project, encoding: 'utf8', timeout: 110_000 }
    );
  }

  it.each(
    [
      ['chrome', !!chrome, chrome ? { chrome: { executablePath: chrome } } : {}],
      ['webkit', existsSync(webkit.executablePath()), {}],
    ].filter(([, available]) => available) as Array<[string, boolean, Record<string, unknown>]>
  )(
    'times passes on the GPU and the rest on the CPU in %s',
    { timeout: 120_000 },
    (runtime, _, extra) => {
      const output = setup(runtime, extra);
      expect(output.status, output.stderr || output.error?.message).toBe(0);
      const json = JSON.parse(output.stdout);
      const clocks = Object.fromEntries(json.benches.map((b: any) => [b.name, b.clock]));
      expect(clocks).toEqual({ dispatch: 'gpu', encode: 'cpu', alloc: 'gpu', compile: 'cpu' });
      // What a pass allocates is its memory cost, and a pass that allocates nothing reads zero
      const vram = Object.fromEntries(json.benches.map((b: any) => [b.name, b.vramBytes]));
      expect(vram.dispatch).toEqual({ resident: (1 << 20) * 4, perPass: 0 });
      expect(vram.alloc.perPass).toBeGreaterThanOrEqual(65536);
      expect(vram.encode).toBeNull();
      // GPU time has no GC to report, and the environment carries the GPU clock
      expect(json.benches.find((b: any) => b.name === 'dispatch').gc).toBeNull();
      expect(json.environment.gpuSpeedVaried).toEqual(expect.any(Number));
      const stats = Object.fromEntries(
        loadResult(join(project, '.labs'), 'gpu').files[0].benchmarks.map((trial) => [
          trial.alias,
          trial.runs[0].stats!,
        ])
      );
      expect(stats.dispatch.kind).toBe('gpu');
      expect(stats.dispatch.samples.length).toBeGreaterThan(40);
      // The GPU clock settles at one of a few levels per process, so most
      // blocks agree closely while a minority may sit at another level. Each
      // block also records the GPU's speed from the probe for the clock gate.
      const { medians, freqs } = stats.dispatch.blocks!;
      expect(freqs).toHaveLength(6);
      expect(Math.min(...freqs)).toBeGreaterThan(0);
      const cluster = Math.max(
        ...medians.map((m) => medians.filter((x) => Math.abs(x - m) / m < 0.15).length)
      );
      expect(cluster).toBeGreaterThanOrEqual(3);
      // Each compile sees fresh source, so it costs real driver work
      expect(stats.compile.kind).toBe('yield');
      const compile = [...stats.compile.samples].sort((a, b) => a - b);
      expect(compile[compile.length >> 1]).toBeGreaterThan(1e5);
    }
  );

  it('explains that GPU benches need a browser runtime', { timeout: 60_000 }, () => {
    const output = setup('node');
    const benches = JSON.parse(output.stdout).benches;
    expect(benches).toHaveLength(4);
    for (const bench of benches) {
      expect(bench.status).toBe('failed');
      expect(bench.message).toContain('WebGPU');
    }
  });
});
