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
  const full = () => events.filter((event) => event.type === 'full').length;
  // WebKit sends a collection's event on a timer after the reply to the command
  // that forced it. Replies to later commands are awaited until `count` full
  // collections have arrived.
  const arrive = async (count: number) => {
    do await session.send('Console.enable');
    while (full() < count);
  };
  const collect = async () => {
    const seen = full();
    await session.send('Heap.gc');
    await arrive(seen + 1);
  };
  try {
    await collect();
    events.length = 0;
    const probes = [];
    for (let i = 0; i < 16; i++) {
      const before = await page.evaluate(() => performance.now() * 1e6);
      await session.send('Heap.gc');
      const after = await page.evaluate(() => performance.now() * 1e6);
      probes.push({ before, after });
    }
    await arrive(probes.length);
    const clock = jscGcClock(probes, events);
    events.length = 0;
    await page.exposeFunction(
      '__labsFinishGc',
      (window: JscGcWindow) =>
        (pending = (async () => {
          await collect();
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
