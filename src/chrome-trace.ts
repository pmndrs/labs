import type { Page } from 'playwright-core';
import type { ChromeTraceEvent } from './bench/lib/chrome-gc.ts';

/** Buffer each sampling window natively and read its trace before the next case warms up. */
export async function observeChromeGc<T>(page: Page, run: () => Promise<T>) {
  const session = await page.context().newCDPSession(page);
  const events: ChromeTraceEvent[] = [];
  let started: Promise<unknown> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (stopping) return stopping;
    if (!started) return Promise.resolve();
    stopping = (async () => {
      try {
        await started;
        const completed = await new Promise<{ stream?: string; dataLossOccurred?: boolean }>(
          (resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error('Chrome GC trace did not finish')),
              15_000
            );
            session.once('Tracing.tracingComplete', (event) => {
              clearTimeout(timeout);
              resolve(event);
            });
            session.send('Tracing.end').catch((error) => {
              clearTimeout(timeout);
              reject(error);
            });
          }
        );
        if (!completed.stream) throw new Error('Chrome GC trace did not return a stream');
        if (completed.dataLossOccurred) {
          await session.send('IO.close', { handle: completed.stream });
          throw new Error('Chrome GC trace buffer overflowed');
        }
        const chunks: Buffer[] = [];
        try {
          for (;;) {
            const chunk = await session.send('IO.read', { handle: completed.stream, size: 1 << 20 });
            chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'));
            if (chunk.eof) break;
          }
        } finally {
          await session.send('IO.close', { handle: completed.stream });
        }
        const trace = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          traceEvents: ChromeTraceEvent[];
        };
        for (const event of trace.traceEvents) {
          if (
            event.name === 'MajorGC' ||
            event.name === 'MinorGC' ||
            event.name.startsWith('labs:gc:')
          ) {
            events.push(event);
          }
        }
      } finally {
        started = undefined;
        stopping = undefined;
      }
    })();
    return stopping;
  };
  try {
    await page.exposeFunction('__labsStartGc', async () => {
      await stop();
      started = session.send('Tracing.start', {
        transferMode: 'ReturnAsStream',
        streamFormat: 'json',
        streamCompression: 'none',
        traceConfig: {
          recordMode: 'recordUntilFull',
          includedCategories: ['v8', 'blink.user_timing'],
          excludedCategories: ['*'],
        },
      });
      await started;
    });
    await page.exposeFunction('__labsFinishGc', stop);
    const outcome = await run().then(
      (result) => ({ result }),
      (error: unknown) => ({ error })
    );
    await stop();
    if ('error' in outcome) throw outcome.error;
    return { result: outcome.result, events };
  } finally {
    await session.detach();
  }
}
