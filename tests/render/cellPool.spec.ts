import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, type WebGLRenderer } from 'three';

import type { KitBoxes } from '@render/buildings/cellArrays';
import type { CellJob } from '@render/buildings/cellWork';
import { GroundShare } from '@render/sharedGround';
import { cancelWarm, drainWarm, warmLooseAhead } from '@render/uploads';
import type { ToJob } from '@/jobs/jobScope';

/** A CELL NOBODY WANTS IS LET GO, NOT WORKED THROUGH (`cellPool.ts`, `jobPool.ts`, `uploads.ts`) */

/** A stand-in for a module worker: what the page posts to it, kept. */
class FakeWorker {
  static made: FakeWorker[] = [];
  readonly posted: ToJob[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  constructor() { FakeWorker.made.push(this); }
  postMessage(message: ToJob): void { this.posted.push(message); }
  terminate(): void {}
}

const boxes = { parts: {}, furniture: {} } as unknown as KitBoxes;
/** The ground as the atlas hands it: shared (no plate made: the relief everywhere). */
const env = { groundAt: Object.assign(() => 0, { share: new GroundShare(3, 1, 1, 0) }), naturalAt: () => 0 };
/** The cell jobs a worker was given, by id. */
const started = (w: FakeWorker): number[] => w.posted.map((m) => (m.data as CellJob).id);
/** The worker answers its last job. */
const answer = (w: FakeWorker, data: unknown): void => {
  const last = w.posted[w.posted.length - 1]!;
  w.onmessage!({ data: { port: last.port, data, seq: last.seq } });
};
const empty = (job: number): unknown => ({ kind: 'done', job, result: { batch: null, details: [], summaries: [] } });

describe('a cell job no longer wanted', () => {
  beforeEach(() => {
    FakeWorker.made = [];
    vi.resetModules();
    vi.stubGlobal('Worker', FakeWorker);
    // One worker in the pool: one job at a time, the others wait in the queue.
    vi.stubGlobal('navigator', { hardwareConcurrency: 3 });
    vi.stubGlobal('document', {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('waiting, never starts; begun, its answer is dropped and the next one starts', async () => {
    const { CellPool } = await import('@render/buildings/cellPool');
    const pool = new CellPool(() => boxes, () => () => ({ buffer: new SharedArrayBuffer(0), row: 0 }));
    const done: number[] = [];
    const a = pool.run('cell', '0,0', [], env, () => done.push(a));
    const b = pool.run('cell', '0,0', [], env, () => done.push(b));
    const c = pool.run('cell', '0,0', [], env, () => done.push(c));
    expect(FakeWorker.made).toHaveLength(1);
    const worker = FakeWorker.made[0]!;
    expect(started(worker)).toEqual([a]);
    // The ground went with it, shared (no plate made: only the relief, the world has no list of plates), and no page round trip is ever asked.
    expect((worker.posted[0]!.data as CellJob).ground?.plates.size).toBe(0);
    pool.cancel(b);
    expect(pool.isRunning(b)).toBe(false);
    pool.cancel(a);
    expect(pool.isRunning(a)).toBe(false);
    // A worker runs its job through: the next one goes once it answers, and that answer changes nothing.
    expect(started(worker)).toEqual([a]);
    answer(worker, empty(a));
    expect(done).toEqual([]);
    expect(started(worker)).toEqual([a, c]);
    expect(pool.isRunning(c)).toBe(true);
    answer(worker, empty(c));
    expect(done).toEqual([c]);
    expect(pool.running).toBe(0);
  });

  it('is replaced by a newer one of its key, nearest the eye first', async () => {
    const { CellPool } = await import('@render/buildings/cellPool');
    const { setJobFocus } = await import('@/jobs/jobPool');
    const written: string[] = [];
    const pool = new CellPool(() => boxes, (e) => () => { written.push(e.key); return { buffer: new SharedArrayBuffer(0), row: 0 }; });
    setJobFocus(0, 0);
    const busy = pool.run('cell', '9,9', [], env, () => {});
    const far = pool.run('cell', '40,40', [{ key: 'far', sig: 0, digest: 0 }], env, () => {}, 'cell|40,40');
    const old = pool.run('cell', '1,1', [{ key: 'old', sig: 0, digest: 0 }], env, () => {}, 'cell|1,1');
    const near = pool.run('cell', '1,1', [{ key: 'new', sig: 0, digest: 0 }], env, () => {}, 'cell|1,1');
    expect(pool.isRunning(old)).toBe(false);
    const worker = FakeWorker.made[0]!;
    answer(worker, empty(busy));
    answer(worker, empty(near));
    expect(started(worker)).toEqual([busy, near, far]);
    // The replaced job's record was never written.
    expect(written).toEqual(['new', 'far']);
  });

  it('read past the roads handed over is asked again over wider ones', async () => {
    const { CellPool } = await import('@render/buildings/cellPool');
    const rects: (readonly number[])[] = [];
    const pavedAt = Object.assign(() => NaN, {
      pack: (rect: readonly [number, number, number, number]) => { rects.push(rect); return { data: { rect, field: null, flush: null }, transfer: [] }; },
    });
    const pool = new CellPool(() => boxes, () => () => ({ buffer: new SharedArrayBuffer(0), row: 0 }));
    let landed = 0;
    const id = pool.run('cell', '0,0', [], { ...env, pavedAt }, () => landed++);
    const worker = FakeWorker.made[0]!;
    answer(worker, { kind: 'wider', job: id, rect: [-500, -500, 500, 500] });
    expect(rects).toEqual([[-64, -64, 320, 320], [-500, -500, 500, 500]]);
    expect(started(worker)).toEqual([id, id]);
    answer(worker, empty(id));
    expect(landed).toBe(1);
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
