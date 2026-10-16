import { describe, expect, it } from 'vitest';

import { portParts, takeStoreSetup, workerParts } from '@editor/workerParts';

/** A worker's store through a port of its own to the desktop's saves writer (`workerParts.ts`, `desktop/saves.cjs`) */

/** The writer's side of a port: its files in a map, answering 'get' and 'write' by id as `saves.cjs` does. */
function writer(): { readonly port: MessagePort; readonly files: Map<string, Uint8Array>; readonly asked: string[] } {
  const channel = new MessageChannel();
  const files = new Map<string, Uint8Array>();
  const asked: string[] = [];
  channel.port1.onmessage = (event: MessageEvent<{ id: number; op: string; keys?: string[]; put?: [string, Uint8Array][]; remove?: string[] }>) => {
    const { id, op } = event.data;
    asked.push(op);
    if (op === 'get') { channel.port1.postMessage({ id, ok: true, result: event.data.keys!.map((k) => files.get(k) ?? null) }); return; }
    for (const [key, bytes] of event.data.put!) files.set(key, bytes);
    for (const key of event.data.remove!) files.delete(key);
    channel.port1.postMessage({ id, ok: true, result: true });
  };
  return { port: channel.port2, files, asked };
}

describe("a worker's store on the desktop", () => {
  it('writes and reads the files through its port', async () => {
    const w = writer();
    const parts = portParts(w.port);
    expect(await parts.write([['a', new Blob(['tile a'])]], [])).toBe(true);
    const [a, b] = await parts.get(['a', 'b']);
    expect(await a!.text()).toBe('tile a');
    expect(b).toBeNull();
    expect(w.asked).toEqual(['write', 'get']);
    parts.drop();
  });

  it('told its store comes by a port, waits for it and never opens IndexedDB', async () => {
    takeStoreSetup({ storeSetup: true, byPort: true });
    const parts = workerParts();
    const reading = parts.get(['x']);
    const w = writer();
    w.files.set('x', new TextEncoder().encode('from the port'));
    takeStoreSetup({ storeSetup: true, port: w.port });
    const [x] = await reading;
    expect(await x!.text()).toBe('from the port');
  });

  it('a new port replaces the old: what waited on the old one is given up, not left waiting', async () => {
    const silent = new MessageChannel();
    takeStoreSetup({ storeSetup: true, port: silent.port2 });
    const waiting = workerParts().get(['y']);
    // Let the request reach the silent port before the writer starts again.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const w = writer();
    takeStoreSetup({ storeSetup: true, port: w.port });
    expect(await waiting).toEqual([null]);
    w.files.set('y', new TextEncoder().encode('y'));
    const [y] = await workerParts().get(['y']);
    expect(await y!.text()).toBe('y');
    silent.port1.close();
  });
});
