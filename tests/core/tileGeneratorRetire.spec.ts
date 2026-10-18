import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToJob } from '@/jobs/jobScope';
import { tileKey } from '@world/tiles';

/** A TILE WORKER LET GO PAST ITS HEAP: its lane takes no more tiles, its worker settles its writes and is ended, and the next tile goes to a new worker - each tile left the isolate's heap larger, and seven of them filled the V8 cage (hw20, 2026-10-18) */
class FakeWorker {
  static made: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly asked: ToJob[] = [];
  ended = false;
  constructor() { FakeWorker.made.push(this); }
  postMessage(message: ToJob): void { this.asked.push(message); }
  terminate(): void { this.ended = true; }
}

/** The tiles failed when the generator is let go: kept, not asserted. */
const failures: unknown[] = [];
const recordFailure = (error: unknown): void => { failures.push(error); };
const tilesOn = (w: FakeWorker): ToJob[] => w.asked.filter((m) => (m.data as { stream?: boolean } | undefined)?.stream === true);
const settlesOn = (w: FakeWorker): ToJob[] => w.asked.filter((m) => (m.data as { settle?: boolean } | undefined)?.settle === true);
/** The worker's answer to a tile it was given, with its heap. */
const answerTile = (w: FakeWorker, m: ToJob, heap?: number): void => {
  const at = m.data as { i: number; j: number };
  w.onmessage!({ data: { port: m.port, data: { key: tileKey(at.i, at.j), stored: 1, ...(heap ? { heap } : {}) } } });
};

describe('a tile worker past its heap', () => {
  beforeEach(() => {
    FakeWorker.made = [];
    vi.resetModules();
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('navigator', { hardwareConcurrency: 4 });
    vi.stubGlobal('document', {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is let go after its tiles and its writes, and the next tile goes to a new worker', async () => {
    const { TileGenerator, TILE_HEAP_CAP, tileLanes } = await import('@/tileGenerator');
    expect(tileLanes()).toBe(1);
    const generator = new TileGenerator({} as never);
    for (let k = 0; k < 4; k++) void generator.makeStored(k, 'map', 0, false).catch((error: unknown) => recordFailure(error));
    const first = FakeWorker.made.find((w) => tilesOn(w).length > 0)!;
    // Under the cap: the lane goes on.
    answerTile(first, tilesOn(first)[0]!, TILE_HEAP_CAP / 2);
    expect(tilesOn(first)).toHaveLength(2);
    // Past it: no tile more, its writes settled, then the worker ended.
    answerTile(first, tilesOn(first)[1]!, TILE_HEAP_CAP + 1);
    expect(tilesOn(first)).toHaveLength(2);
    const settle = settlesOn(first);
    expect(settle).toHaveLength(1);
    expect(first.ended).toBe(false);
    first.onmessage!({ data: { port: settle[0]!.port, data: { settled: true } } });
    expect(first.ended).toBe(true);
    // The next tile on a new worker.
    const second = FakeWorker.made.find((w) => w !== first && tilesOn(w).length > 0);
    expect(second).toBeDefined();
    expect(second!.ended).toBe(false);
    generator.dispose();
  });

  it('where the heap is not told, is let go after its answers', async () => {
    const { TileGenerator, TILE_WORKER_ANSWERS } = await import('@/tileGenerator');
    const generator = new TileGenerator({} as never);
    for (let k = 0; k < TILE_WORKER_ANSWERS + 2; k++) void generator.makeStored(k, 'map', 0, false).catch((error: unknown) => recordFailure(error));
    const first = FakeWorker.made.find((w) => tilesOn(w).length > 0)!;
    for (let k = 0; k < TILE_WORKER_ANSWERS; k++) answerTile(first, tilesOn(first)[k]!);
    expect(tilesOn(first)).toHaveLength(TILE_WORKER_ANSWERS);
    expect(settlesOn(first)).toHaveLength(1);
    generator.dispose();
  });
});
