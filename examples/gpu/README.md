# GPU example

Blur-like compute dispatches timed on the GPU, the CPU cost of encoding and compiling them, and a render pass drawing one triangle offscreen.

```sh
cd examples/gpu
pnpm bench
pnpm bench --runtime webkit
```

Chrome and WebKit expose the machine's GPU headlessly. Headless Firefox has no WebGPU adapter.
