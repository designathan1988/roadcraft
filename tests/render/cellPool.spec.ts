import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, type WebGLRenderer } from 'three';

import { CellPool } from '@render/buildings/cellPool';
import type { KitBoxes } from '@render/buildings/cellArrays';
import { cancelWarm, drainWarm, warmLooseAhead } from '@render/uploads';

/**
 * A CELL NOBODY WANTS IS LET GO, NOT WORKED THROUGH (`cellPool.ts`, `uploads.ts`):
 * a job cancelled while it waits never starts; one cancelled while a worker
 * works on it is dropped by that worker, and the next job of its lane starts;
 * a mesh let go while it waits for the GPU is never drawn to send it.
 */
type Sent = { readonly type: string; readonly job?: number | { readonly id: number } };

/** A stand-in for a module worker: what the page posts to it, kept. */
class FakeWorker {
  static made: FakeWorker[] = [];
  readonly posted: Sent[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  constructor() { FakeWorker.made.push(this); }
  postMessage(message: Sent): void { this.posted.push(message); }
  terminate(): void {}
}

const boxes = { parts: {}, furniture: {} } as unknown as KitBoxes;
const env = { groundAt: () => 0, naturalAt: () => 0 };
const started = (w: FakeWorker): number[] => w.posted.filter((m) => m.type === 'start').map((m) => (m.job as { id: number }).id);

const realWorker = (globalThis as { Worker?: unknown }).Worker;
afterEach(() => {
  (globalThis as { Worker?: unknown }).Worker = realWorker;
  FakeWorker.made = [];
});

describe('a cell job no longer wanted', () => {
  it('waiting, never starts; begun, is dropped by its worker and the next one starts', () => {
    (globalThis as { Worker?: unknown }).Worker = FakeWorker;
    const pool = new CellPool(() => boxes, () => () => '{}');
    const done: number[] = [];
    // The same cell: the same lane, one job at a time on it.
    const a = pool.run('cell', '0,0', [], env, () => done.push(a));
    const b = pool.run('cell', '0,0', [], env, () => done.push(b));
    const c = pool.run('cell', '0,0', [], env, () => done.push(c));
    const lane = FakeWorker.made.find((w) => started(w).length > 0)!;
    expect(started(lane)).toEqual([a]);
    pool.cancel(b);
    expect(pool.isRunning(b)).toBe(false);
    pool.cancel(a);
    expect(lane.posted).toContainEqual({ type: 'cancel', job: a });
    expect(started(lane)).toEqual([a, c]);
    expect(pool.isRunning(a)).toBe(false);
    expect(pool.isRunning(c)).toBe(true);
    // A reply the worker had already sent for the cancelled job changes nothing.
    lane.onmessage!({ data: { kind: 'done', job: a, result: { batch: null, details: [], summaries: [] } } } as MessageEvent);
    expect(done).toEqual([]);
  });
});

describe('a mesh let go while it waits for the GPU', () => {
  it('is taken out of the queue and never drawn to send it', async () => {
    let draws = 0;
    const renderer = {
      render: () => { draws++; },
      getRenderTarget: () => null,
      setRenderTarget: () => {},
      autoClear: true,
    } as unknown as WebGLRenderer;
    const camera = new PerspectiveCamera();
    const scene = new Scene();
    drainWarm(renderer, camera, scene, null); // the frame loop is warming from now on
    const mesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    const sent = warmLooseAhead([mesh]);
    expect(sent).not.toBeNull();
    cancelWarm([mesh]);
    await sent;
    drainWarm(renderer, camera, scene, null);
    expect(draws).toBe(0);
  });
});
