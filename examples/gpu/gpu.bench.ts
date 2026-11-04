import { bench, group } from '../../src/index.ts';

// A blur-like pass over 1M floats. The loop count sets how much the GPU works per element.
const blur = (taps: number) => `
  @group(0) @binding(0) var<storage, read_write> data: array<f32>;
  @compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    var v = data[id.x];
    for (var i = 0u; i < ${taps}u; i++) { v = sin(v) * 1.0001 + 0.5; }
    data[id.x] = v;
  }`;

function build(device: GPUDevice, code: string) {
  const module = device.createShaderModule({ code });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module } });
  const buffer = device.createBuffer({ size: (1 << 20) * 4, usage: GPUBufferUsage.STORAGE });
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer } }],
  });
  return { pipeline, bind };
}

group('blur', () => {
  // GPU time of one dispatch, from timestamp queries
  for (const taps of [16, 64]) {
    bench.gpu(`dispatch ${taps} taps`, function* ({ device }) {
      const { pipeline, bind } = build(device, blur(taps));
      yield {
        compute: (pass) => {
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bind);
          pass.dispatchWorkgroups(4096);
        },
      };
    });
  }

  // CPU time to encode and submit the same dispatch
  bench.gpu('encode', function* ({ device }) {
    const { pipeline, bind } = build(device, blur(16));
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

  // CPU time to compile the shader, with fresh source so the driver cache cannot serve it
  bench.gpu('compile', function* ({ device, fresh }) {
    yield async () => {
      const module = device.createShaderModule({ code: fresh(blur(16)) });
      await device.createComputePipelineAsync({ layout: 'auto', compute: { module } });
    };
  });
});

group('triangle', () => {
  // GPU time of a render pass drawing one triangle to an offscreen target
  bench.gpu('draw', function* ({ device }) {
    const module = device.createShaderModule({
      code: `
        @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
          let p = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
          return vec4f(p[i], 0, 1);
        }
        @fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
          return vec4f(sin(p.x * 0.01), cos(p.y * 0.01), 0.5, 1);
        }`,
    });
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    });
    const target = device.createTexture({
      size: [2048, 2048],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const view = target.createView();
    yield {
      render: { colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }] },
      draw: (pass) => {
        pass.setPipeline(pipeline);
        pass.draw(3);
      },
    };
  });
});
