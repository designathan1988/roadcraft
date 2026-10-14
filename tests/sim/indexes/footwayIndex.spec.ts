import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import type { SidewalkEdge } from '@sim/peds/sidewalk';
import type { SimWorld } from '@sim/world';
import { seededEdit, seededWorld } from './support';

/**
 * The footways beside a road (`SidewalkGraph.walksBeside`, read by the kerb
 * stops' `footwayBeside`) are exactly what the old scan of every edge of the
 * map found for that road, in the same order - so the nearest footway, and
 * the first of two at the same distance, is the same one. Through edits.
 */
function oracle(w: SimWorld, segment: number): SidewalkEdge[] {
  const out: SidewalkEdge[] = [];
  for (const edge of w.sidewalks.edges.values()) {
    if (edge.kind !== 'walk' || edge.segment !== segment) continue;
    out.push(edge);
  }
  return out;
}

function compare(w: SimWorld): number {
  let walks = 0;
  // Every road of the document, and ids no road has (taken away, never made).
  const ids = new Set<number>([...w.doc.segments.keys(), -1, 0, 99999]);
  for (const lane of w.graph.lanelets.values()) if (lane.segment !== undefined) ids.add(lane.segment);
  for (const id of ids) {
    const want = oracle(w, id);
    const got = w.sidewalks.walksBeside(id as never);
    expect(got.map((e) => e.id)).toEqual(want.map((e) => e.id));
    got.forEach((e, i) => expect(e).toBe(want[i]));
    walks += got.length;
  }
  return walks;
}

describe('footways beside a road, indexed', () => {
  for (const seed of [11, 0xbeef, 4242]) {
    it(`matches the scan of every edge (seed ${seed}), through edits`, () => {
      const w = seededWorld(seed);
      const rng = new Rng(seed ^ 0x55);
      expect(compare(w)).toBeGreaterThan(20);
      for (let k = 0; k < 6; k++) {
        seededEdit(w, rng);
        compare(w);
      }
    });
  }
});
