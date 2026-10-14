import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { Rng } from '@core/rng';
import { SimWorld } from '@sim/world';

/**
 * A seeded town for the index equivalence specs: a jittered grid of roads of
 * mixed classes, and seeded edits (roads taken away, roads drawn across).
 */
function seededTown(seed: number, n = 5, block = 120, jitter = 8, uniform = false): RoadDoc {
  const rng = new Rng(seed);
  const doc = new RoadDoc();
  const ids: number[][] = [];
  for (let i = 0; i <= n; i++) {
    ids.push([]);
    for (let j = 0; j <= n; j++) {
      const jx = rng.range(-jitter, jitter), jy = rng.range(-jitter, jitter);
      ids[i]!.push(doc.addNode({ x: m(block) * (i - n / 2) + m(jx), y: m(block) * (j - n / 2) + m(jy) }).id);
    }
  }
  const classes = uniform ? [1, 1, 1] as const : [1, 2, 3] as const;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      if (i < n) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, classes[rng.int(0, 2)]!);
      if (j < n) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, classes[rng.int(0, 2)]!);
    }
  }
  // A road off the map at two corners: traffic comes in and leaves.
  const half = m(block) * (n / 2);
  doc.addSegment(ids[0]![0]! as never, doc.addNode({ x: -half - m(150), y: -half }).id as never, 1);
  doc.addSegment(ids[n]![n]! as never, doc.addNode({ x: half + m(150), y: half }).id as never, 1);
  return doc;
}

/**
 * `jitter` 0 and `uniform` (one class of road): a regular grid, whose equal
 * blocks tie (searches that keep the first of equals).
 */
export function seededWorld(seed: number, n = 5, jitter = 8, uniform = false): SimWorld {
  const doc = seededTown(seed, n, 120, jitter, uniform);
  const net = new Network(doc);
  net.rebuild();
  const w = new SimWorld(doc, net, seed);
  w.rebuildTopology();
  return w;
}

/** A seeded edit: a road taken away or one drawn across the town; the topology rebuilt. */
export function seededEdit(w: SimWorld, rng: Rng, n = 5, block = 120): void {
  const doc = w.doc;
  if (rng.bool()) {
    const keys = [...doc.segments.keys()].sort((a, b) => a - b);
    doc.removeSegment(keys[rng.int(0, keys.length - 1)]!);
  } else {
    const y = m(block) * (rng.range(-n / 2, n / 2) + 0.25);
    const x = m(block) * (n / 2);
    doc.addSegment(doc.addNode({ x: -x, y }).id, doc.addNode({ x, y }).id, 1);
  }
  w.net.rebuild();
  w.rebuildTopology();
}
