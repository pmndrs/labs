import type { ChildProcess } from 'node:child_process';
import { bunGcClock, bunGcStats, type BunGcClock, type BunGcEvent } from './bench/lib/bun-gc.ts';
import type { GcStats } from './bench/types.ts';

/** Record an isolated Bun process externally, keeping event decoding outside sampling. */
export async function observeBunGc(child: ChildProcess): Promise<void> {
  const address = Promise.withResolvers<string>();
  const ready = Promise.withResolvers<void>();
  let failure: Error | undefined;
  let finished = false;
  let socket: WebSocket | undefined;
  let clock: BunGcClock | undefined;
  let sequence = 0;
  let chain = Promise.resolve();
  const frames: string[] = [];
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
  const rejectPending = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
  };
  const fail = (error: Error) => {
    failure ??= error;
    address.reject(error);
    ready.reject(error);
    rejectPending(error);
    if (!finished) child.kill();
  };
  const timeout = setTimeout(() => fail(new Error('Bun GC inspector did not initialize')), 15_000);
  const send = async (method: string) => {
    if (socket?.readyState !== WebSocket.OPEN) throw new Error('Bun GC inspector disconnected');
    const id = sequence++;
    const request = Promise.withResolvers<void>();
    pending.set(id, request);
    const timeout = setTimeout(
      () => request.reject(new Error(`Bun GC inspector timed out: ${method}`)),
      15_000
    );
    try {
      socket.send(JSON.stringify({ id, method }));
      await request.promise;
    } finally {
      clearTimeout(timeout);
      pending.delete(id);
    }
  };
  const readEvents = () =>
    frames.splice(0).map((frame) => JSON.parse(frame).params.collection as BunGcEvent);
  let stderr = '';
  let banner = false;
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    const lines = (stderr + chunk).split('\n');
    stderr = lines.pop()!;
    for (const line of lines) {
      if (!clock && /^-+ Bun Inspector -+$/.test(line)) {
        banner = !banner;
        continue;
      }
      const url = line.match(/ws:\/\/[^\s]+/)?.[0];
      if (url) address.resolve(url);
      if (!banner) process.stderr.write(line + '\n');
    }
  });
  const session = Promise.all([address.promise, ready.promise]).then(async ([url]) => {
    socket = new WebSocket(url);
    socket.addEventListener('message', (event) => {
      const frame = String(event.data);
      if (frame.includes('Heap.garbageCollected')) {
        frames.push(frame);
        return;
      }
      const reply = JSON.parse(frame);
      const request = pending.get(reply.id);
      if (!request) return;
      if (reply.error) request.reject(new Error(JSON.stringify(reply.error)));
      else request.resolve();
    });
    socket.addEventListener('close', () => rejectPending(new Error('Bun GC inspector disconnected')));
    await new Promise<void>((resolve, reject) => {
      socket!.addEventListener('open', () => resolve(), { once: true });
      socket!.addEventListener(
        'error',
        () => reject(new Error('Bun GC inspector connection failed')),
        { once: true }
      );
    });
    await send('Heap.enable');
    await send('Heap.gc');
    frames.length = 0;
  });
  session.catch(fail);
  child.on('message', (message: any) => {
    if (typeof message?.type !== 'string' || !message.type.startsWith('labs:bun-gc:')) return;
    if (message.type === 'labs:bun-gc:ready') ready.resolve();
    chain = chain
      .then(async () => {
        await session;
        let value: GcStats | undefined;
        if (message.type === 'labs:bun-gc:clock') {
          await send('Console.disable');
          clock = bunGcClock(message.probes, readEvents());
          clearTimeout(timeout);
        } else if (message.type === 'labs:bun-gc:window') {
          if (!clock) throw new Error('Bun GC inspector clock is unavailable');
          // Complete concurrent work after the end marker, then drain its notifications.
          await send('Heap.gc');
          await send('Console.disable');
          value = bunGcStats(readEvents(), message.window, clock);
        } else if (message.type === 'labs:bun-gc:done') {
          socket?.close();
        }
        child.send({ type: 'labs:bun-gc:reply', id: message.id, value });
      })
      .catch(fail);
  });
  await new Promise<void>((resolve) => {
    child.on('error', fail);
    child.once('close', (code, signal) => {
      finished = true;
      clearTimeout(timeout);
      if (stderr && !banner) process.stderr.write(stderr);
      const error = new Error(`Bun benchmark worker exited with ${signal ?? `code ${code}`}`);
      if (code !== 0) failure ??= error;
      address.reject(error);
      ready.reject(error);
      rejectPending(error);
      resolve();
    });
  });
  await chain;
  socket?.close();
  if (failure) throw failure;
}
