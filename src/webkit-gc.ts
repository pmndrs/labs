import type { Page } from 'playwright-core';
import { jscGcClock, jscGcStats, type JscGcEvent, type JscGcWindow } from './bench/lib/jsc-gc.ts';

/** Access the native WebKit session provided by the pinned in-process Playwright build. */
export function webkitSession(page: Page): {
  send(method: string, params?: object): Promise<any>;
  on(event: string, listener: (value: any) => void): void;
  off(event: string, listener: (value: any) => void): void;
} {
  const session = (page as any)._connection?.toImpl?.(page)?.delegate?._session;
  if (!session?.send || !session?.on || !session?.off)
    throw new Error('WebKit GC requires the supported in-process Playwright protocol bridge');
  return session;
}

/** Observe native JavaScriptCore activity without sending commands during sampling. */
export async function observeWebkitGc<T>(page: Page, run: () => Promise<T>): Promise<T> {
  const session = webkitSession(page);
  const events: JscGcEvent[] = [];
  const receive = ({ collection }: { collection: JscGcEvent }) => events.push(collection);
  session.on('Heap.garbageCollected', receive);
  await session.send('Heap.enable');
  let pending: Promise<unknown> = Promise.resolve();
  try {
    await session.send('Heap.gc');
    await session.send('Console.enable');
    events.length = 0;
    const probes = [];
    for (let i = 0; i < 16; i++) {
      const before = await page.evaluate(() => performance.now() * 1e6);
      await session.send('Heap.gc');
      const after = await page.evaluate(() => performance.now() * 1e6);
      probes.push({ before, after });
    }
    await session.send('Console.enable');
    const clock = jscGcClock(probes, events);
    events.length = 0;
    await page.exposeFunction(
      '__labsFinishGc',
      (window: JscGcWindow) =>
        (pending = (async () => {
          await session.send('Heap.gc');
          await session.send('Console.enable');
          return jscGcStats(events.splice(0), window, clock);
        })())
    );
    return await run();
  } finally {
    await pending;
    session.off('Heap.garbageCollected', receive);
    await session.send('Heap.disable');
  }
}
