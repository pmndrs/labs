import type { GcStats } from '../types.ts';
import type { GcObserver } from './gc.ts';
import { gc, now } from './runtime.ts';

/** Connect an isolated Bun measurement process to its external recorder. */
export async function prepareBunGc(): Promise<() => Promise<void>> {
  let sequence = 0;
  const pending = new Map<number, (value: any) => void>();
  const receive = (message: any) => {
    if (message?.type !== 'labs:bun-gc:reply') return;
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve?.(message.value);
  };
  const request = <T>(message: Record<string, unknown>) =>
    new Promise<T>((resolve) => {
      const id = sequence++;
      pending.set(id, resolve);
      process.send!({ ...message, id });
    });
  process.on('message', receive);
  try {
    await request({ type: 'labs:bun-gc:ready' });
    const probes = [];
    for (let i = 0; i < 16; i++) {
      const before = now();
      gc();
      probes.push({ before, after: now() });
    }
    await request({ type: 'labs:bun-gc:clock', probes });
    (globalThis as any).__LABS_GC_OBSERVER = (): GcObserver => {
      let start = 0;
      return {
        start() {
          start = now();
        },
        finish(timed, iterations, comparable = false) {
          const end = now();
          return request<GcStats>({
            type: 'labs:bun-gc:window',
            window: { start, end, timed, iterations, comparable },
          });
        },
        cancel() {},
      };
    };
  } catch (error) {
    process.off('message', receive);
    throw error;
  }
  return async () => {
    await request({ type: 'labs:bun-gc:done' });
    delete (globalThis as any).__LABS_GC_OBSERVER;
    process.off('message', receive);
    process.disconnect?.();
  };
}
