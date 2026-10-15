import { SimHost } from './host/simHost';
import type { FromSim, ToSim } from './host/protocol';

/** The simulation's worker (`host/simHost.ts`): the page's messages answered in order, one at a time. */
const scope = self as unknown as { onmessage: ((e: MessageEvent<ToSim>) => void) | null; postMessage(message: FromSim): void };
const host = new SimHost((message) => scope.postMessage(message));
let queue: Promise<void> = Promise.resolve();
scope.onmessage = (event) => {
  queue = queue.then(() => host.handle(event.data)).catch((error: unknown) => {
    console.error('[sim worker]', error);
    scope.postMessage({ type: 'failed', message: String((error as Error)?.stack ?? error) });
  });
};
