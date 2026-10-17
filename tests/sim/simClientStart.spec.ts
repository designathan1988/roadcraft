import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimClient } from '@sim/host/simClient';
import { RoadDoc } from '@world/doc';

/** THE SIMULATION'S WORKER FAILING BEFORE IT IS READY DOES NOT HOLD THE OPENING (`SimClient.start`, awaited by `main.ts`) */

/** A worker that never answers, its handlers kept for the test to fire. */
class SilentWorker {
  static last: SilentWorker | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  constructor() { SilentWorker.last = this; }
  postMessage(): void {}
  terminate(): void {}
}

afterEach(() => { vi.unstubAllGlobals(); SilentWorker.last = null; });

describe('the simulation worker starting', () => {
  for (const [what, fire] of [
    ['cannot be loaded', (w: SilentWorker) => w.onerror!({ message: '', preventDefault: () => {} } as unknown as ErrorEvent)],
    ['sends a message that cannot be read', (w: SilentWorker) => w.onmessageerror!({} as MessageEvent)],
    ['fails in its init', (w: SilentWorker) => w.onmessage!({ data: { type: 'failed', message: 'init threw' } } as MessageEvent)],
  ] as const) {
    it(`lets the opening go on, the failure told, when it ${what}`, async () => {
      vi.stubGlobal('Worker', SilentWorker);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const client = new SimClient(new RoadDoc());
      let opened = false;
      const ready = client.start(1, new Map(), null, 'edges').then(() => { opened = true; });
      await Promise.resolve();
      expect(opened).toBe(false);
      fire(SilentWorker.last!);
      await ready;
      expect(opened).toBe(true);
      expect(client.failure).not.toBeNull();
      errors.mockRestore();
    });
  }
});
