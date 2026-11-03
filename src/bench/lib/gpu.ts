/// <reference types="@webgpu/types" />

let shared: Promise<GPUDevice> | undefined;

/** The WebGPU device GPU benches share, created once with timestamp queries. */
export function gpuDevice(): Promise<GPUDevice> {
  return (shared ??= (async () => {
    const adapter = await (globalThis as any).navigator?.gpu?.requestAdapter();
    if (!adapter) {
      throw new Error('WebGPU is unavailable here. GPU benches run with --runtime chrome or webkit.');
    }
    if (!adapter.features.has('timestamp-query')) {
      throw new Error('This WebGPU adapter has no timestamp queries, which GPU timing needs.');
    }
    return adapter.requestDevice({ requiredFeatures: ['timestamp-query'] });
  })());
}

let fresh = 0;

/** Appends a unique comment so the pipeline cache cannot serve an earlier compile. */
export function freshShader(code: string): string {
  return `${code}\n// labs ${++fresh} ${Date.now()}`;
}

/**
 * Times passes on the GPU. `encode` records one pass between the given
 * timestamp writes. The returned function resolves to a pass's GPU time in
 * nanoseconds. Four passes stay in flight, since the GPU clock climbs only
 * under continuous load and falls as soon as the queue runs dry, so each call
 * returns the time of the oldest pass and submits a new one.
 */
export function timedPass(
  device: GPUDevice,
  encode: (encoder: GPUCommandEncoder, timestampWrites: GPUComputePassTimestampWrites) => void
): () => Promise<number> {
  const slots = Array.from({ length: 4 }, () => ({
    query: device.createQuerySet({ type: 'timestamp', count: 2 }),
    resolve: device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    }),
    read: device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
  }));
  let next = 0;
  const submit = async () => {
    const { query, resolve, read } = slots[next++ % slots.length];
    const encoder = device.createCommandEncoder();
    encode(encoder, { querySet: query, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 });
    encoder.resolveQuerySet(query, 0, 2, resolve, 0);
    encoder.copyBufferToBuffer(resolve, 0, read, 0, 16);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const stamps = new BigInt64Array(read.getMappedRange());
    const time = Number(stamps[1] - stamps[0]);
    read.unmap();
    return time;
  };
  const inflight: Array<Promise<number>> = [];
  return async () => {
    while (inflight.length < slots.length) inflight.push(submit());
    const time = await inflight.shift()!;
    inflight.push(submit());
    return time;
  };
}

export function computePass(
  device: GPUDevice,
  fill: (pass: GPUComputePassEncoder) => void
): () => Promise<number> {
  return timedPass(device, (encoder, timestampWrites) => {
    const pass = encoder.beginComputePass({ timestampWrites });
    fill(pass);
    pass.end();
  });
}

export function renderPass(
  device: GPUDevice,
  descriptor: GPURenderPassDescriptor,
  draw: (pass: GPURenderPassEncoder) => void
): () => Promise<number> {
  return timedPass(device, (encoder, timestampWrites) => {
    const pass = encoder.beginRenderPass({ ...descriptor, timestampWrites });
    draw(pass);
    pass.end();
  });
}

/**
 * The GPU's current speed as a rate, the way the calibration probe reads the
 * CPU's. A fixed dispatch of about 100 µs, well above Chrome's 65 µs timestamp
 * quantum, runs until its timings settle, since the clock climbs under load,
 * and the median of the settled passes is the reading.
 */
export async function probeGpuRate(device: GPUDevice): Promise<number> {
  const module = device.createShaderModule({
    code: `@group(0) @binding(0) var<storage, read_write> data: array<f32>;
      @compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        var v = data[id.x];
        for (var i = 0u; i < 32u; i++) { v = sin(v) * 1.0001 + 0.5; }
        data[id.x] = v;
      }`,
  });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module } });
  const buffer = device.createBuffer({ size: (1 << 20) * 4, usage: GPUBufferUsage.STORAGE });
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer } }],
  });
  const pass = computePass(device, (pass) => {
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(4096);
  });
  const times: number[] = [];
  for (let i = 0; i < 64; i++) times.push(await pass());
  const settled = times.slice(32).sort((a, b) => a - b);
  buffer.destroy();
  return 1 / settled[settled.length >> 1];
}
