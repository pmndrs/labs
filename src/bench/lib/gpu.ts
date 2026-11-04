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
 * timestamp writes. The returned function submits passes and resolves to a
 * pass's GPU time in nanoseconds. Four stay in flight, since the GPU clock
 * climbs only under continuous load and falls as soon as the queue runs dry,
 * so each call tops the queue up and returns the oldest pass's time. The
 * function keeps submission in the call path prepared before sampling.
 */
export type TimedPass = (() => Promise<number>) & { calls: number };

export function timedPass(
  device: GPUDevice,
  encode: (encoder: GPUCommandEncoder, timestampWrites: GPUComputePassTimestampWrites) => void
): TimedPass {
  const slots = Array.from({ length: 4 }, () => ({
    query: device.createQuerySet({ type: 'timestamp', count: 2 }),
    resolve: device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    }),
    read: device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
  }));
  let next = 0;
  // Synchronous encoding and submission can inline into the prepared pass.
  // Only the readback waits.
  const enqueue = () => {
    const { query, resolve, read } = slots[next++ % slots.length];
    const encoder = device.createCommandEncoder();
    encode(encoder, { querySet: query, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 });
    encoder.resolveQuerySet(query, 0, 2, resolve, 0);
    encoder.copyBufferToBuffer(resolve, 0, read, 0, 16);
    device.queue.submit([encoder.finish()]);
    return read.mapAsync(GPUMapMode.READ).then(() => {
      const stamps = new BigInt64Array(read.getMappedRange());
      const time = Number(stamps[1] - stamps[0]);
      read.unmap();
      return time;
    });
  };
  const inflight: Array<Promise<number>> = [];
  const pass: TimedPass = Object.assign(
    async () => {
      pass.calls++;
      while (inflight.length < slots.length) inflight.push(enqueue());
      const time = await inflight.shift()!;
      inflight.push(enqueue());
      return time;
    },
    { calls: 0 }
  );
  return pass;
}

/** Bytes a texture occupies from its size, format, mip chain and sample count. */
function textureBytes(descriptor: GPUTextureDescriptor): number {
  const size = descriptor.size as number[] | GPUExtent3DDict;
  const [width, height, depth] = Array.isArray(size)
    ? [size[0], size[1] ?? 1, size[2] ?? 1]
    : [size.width, size.height ?? 1, size.depthOrArrayLayers ?? 1];
  const format = descriptor.format;
  const starts = (...prefixes: string[]) => prefixes.some((prefix) => format.startsWith(prefix));
  const texel = starts('rgba32')
    ? 16
    : starts('rgba16', 'rg32')
      ? 8
      : starts('r16', 'rg8', 'depth16')
        ? 2
        : starts('r8', 'stencil8')
          ? 1
          : 4;
  const levels = descriptor.mipLevelCount ?? 1;
  const chain = (1 - 0.25 ** levels) / 0.75;
  return width * height * depth * texel * chain * (descriptor.sampleCount ?? 1);
}

/**
 * Counts the bytes of buffers and textures created on the device, less those
 * destroyed, until stopped. GPU memory is not readable, so what a pass
 * allocates is the measure of its memory cost, as the heap is on the CPU.
 */
export function meterAllocations(device: GPUDevice): { bytes(): number; stop(): number } {
  let bytes = 0;
  const createBuffer = device.createBuffer.bind(device);
  const createTexture = device.createTexture.bind(device);
  const track = <T extends { destroy(): void }>(resource: T, size: number): T => {
    bytes += size;
    const destroy = resource.destroy.bind(resource);
    resource.destroy = () => {
      bytes -= size;
      size = 0;
      destroy();
    };
    return resource;
  };
  device.createBuffer = (descriptor) => track(createBuffer(descriptor), descriptor.size);
  device.createTexture = (descriptor) => track(createTexture(descriptor), textureBytes(descriptor));
  return {
    bytes: () => bytes,
    stop() {
      device.createBuffer = createBuffer;
      device.createTexture = createTexture;
      return bytes;
    },
  };
}

export function computePass(
  device: GPUDevice,
  fill: (pass: GPUComputePassEncoder) => void
): TimedPass {
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
): TimedPass {
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
