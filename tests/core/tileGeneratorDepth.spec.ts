import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToJob } from '@/jobs/jobScope';
import { tileKey } from '@world/tiles';

/** While the map is made a tile lane holds the next tile too: its worker goes on to it without waiting for the page to hear the last one */
class FakeWorker {
  static made: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly asked: ToJob[] = [];
  constructor() { FakeWorker.made.push(this); }
  postMessage(message: ToJob): void { this.asked.push(message); }
  terminate(): void { /* the pool's workers outlive a lane */ }
}

const tilesOn = (w: FakeWorker): ToJob[] => w.asked.filter((m) => (m.data as { stream?: boolean } | undefined)?.stream === true);

describe("a tile lane's depth", () => {
  beforeEach(() => {
    FakeWorker.made = [];
    vi.resetModules();
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('navigator', { hardwareConcurrency: 6 });
    vi.stubGlobal('document', {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is two tiles in the rush, the second posted before the page hears the first, and one once the map is made', async () => {
    const { TileGenerator, tileLanes } = await import('@/tileGenerator');
    const generator = new TileGenerator({} as never);
    generator.setAside(true);
    for (let k = 0; k < 4 * tileLanes(); k++) void generator.makeStored(k, 'map', 0, false).catch(() => {});
    const lanes = (generator as unknown as { lanes: { aside: boolean; port: { worker: FakeWorker }; inFlight: { key: number }[] }[] }).lanes;
    const own = lanes.filter((l) => !l.aside);
    expect(own).toHaveLength(tileLanes());
    // No answer heard yet: each of the generator's own workers holds two tiles.
    for (const lane of own) expect(tilesOn(lane.port.worker)).toHaveLength(2);
    // The map made: an answer makes room for one, never two again.
    generator.setAside(false);
    const lane = own[0]!, first = tilesOn(lane.port.worker)[0]!, at = first.data as { i: number; j: number };
    lane.port.worker.onmessage!({ data: { port: first.port, data: { key: tileKey(at.i, at.j), stored: 1 } } });
    expect(lane.inFlight).toHaveLength(1);
    expect(tilesOn(lane.port.worker)).toHaveLength(2);
    generator.dispose();
  });
});
