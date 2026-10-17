import { describe, expect, it } from 'vitest';
import { Polyline } from '@core/polyline';
import { WalkGraph, type Walkway } from '@world/walkways';

/** The walk graph's log of changes holds no more walkways than the graph does: a camera walking across tiles leaves none of the tiles behind in it (`WalkGraph.settle`) */

/** A tile's footways at column `t`: `n` short walkways along it. */
function tile(g: WalkGraph, t: number, n: number): number[] {
  const ids: number[] = [];
  for (let k = 0; k < n; k++) {
    const x = t * 1000 + k * 5;
    const a = g.node({ x, y: 0 }), b = g.node({ x: x + 4, y: 0 });
    const way = { kind: 'footway', path: Polyline.fromPoints([{ x, y: 0 }, { x: x + 4, y: 0 }]), width: 2, lo: -1, hi: 1, kerb: 1, a, b, structure: 'ground' } as unknown as Omit<Walkway, 'id'>;
    ids.push(g.add(way).id);
  }
  return ids;
}

describe("the walk graph's log", () => {
  it('holds the same walkways after 2 tiles walked as after 20', () => {
    // The walkways the log's changes hold, removed and added.
    const held = (g: WalkGraph): number => (g as unknown as { log: { change: { removed: unknown[]; added: unknown[] } }[] }).log.reduce((n, e) => n + e.change.removed.length + e.change.added.length, 0);
    const g = new WalkGraph();
    const sizes: number[] = [];
    let previous: number[] = [];
    for (let t = 0; t < 20; t++) {
      // The tile the camera reaches comes in, the one it left goes, in one update each.
      const now = tile(g, t, 300);
      g.settle();
      for (const id of previous) g.drop(id);
      g.settle();
      previous = now;
      sizes.push(held(g));
    }
    expect(sizes[19]).toBe(sizes[1]);
    // A reader one update behind still reads the change, not the graph whole.
    const state = g.state;
    tile(g, 99, 3);
    g.settle();
    expect(g.changesSince(state)).not.toBeNull();
  });
});
