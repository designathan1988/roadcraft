import { Digest } from '@core/digest';
import type { Ring } from '@core/ring';
import type { MultiPoly } from '@core/clipper';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { LaneletGraph } from '@world/lanelets';
import { bands, surfaces } from '@world/surfaces';
import { buildWalkways } from '@world/walkways';
import { streetFurniture } from '@world/streetFurniture';
import { junctionDetail, segmentMarkings } from '@world/markings';
import { sectionOf } from '@world/section';

/**
 * Everything the road network derives, one line per piece, so two builds
 * that differ say WHICH piece differs: the network (ribbons, trims, junction
 * rings, plates, marks), the lanelets, the surface bands, the walkways, the
 * street furniture, the markings and each road's cross-section. Shared by
 * the incremental oracle and the "old maps identical" lock of the road system
 * (docs/VIAS.md).
 */
const ringDigest = (ring: Ring): number => {
  const d = new Digest();
  for (const p of ring.flatten()) d.add(p.x).add(p.y);
  return d.value();
};

export function networkLines(net: Network): string[] {
  const out: string[] = [];
  const segs = [...net.ribbons.keys()].sort((a, b) => a - b);
  for (const id of segs) {
    const r = net.ribbons.get(id)!;
    const d = new Digest().add(r.typeIndex).addText(r.direction).add(r.dashOrigin).addAll(r.full.xy)
      .addText(JSON.stringify(r.road));
    for (const level of Object.keys(r.centre).map(Number).sort((a, b) => a - b)) {
      d.add(level).addAll(r.centre[level]!.xy).add(ringDigest(r.rings[level]!));
    }
    out.push(`ribbon ${id} ${d.value()}`);
    out.push(`trims ${id} ${JSON.stringify(net.trims.get(id) ?? null)}`);
  }
  for (const node of [...net.junctions.keys()].sort((a, b) => a - b)) {
    for (const [level, j] of [...net.junctions.get(node)!].sort((a, b) => a[0] - b[0])) {
      const d = new Digest().add(ringDigest(j.ring)).addAll(j.trims).add(j.transition ? 1 : 0);
      for (const t of j.tongues) d.add(ringDigest(t));
      for (const r of j.rings) d.add(ringDigest(r));
      for (const leg of j.legs) d.add(leg.seg).add(leg.hw).add(leg.origin.x).add(leg.origin.y).add(leg.dir.x).add(leg.dir.y);
      out.push(`junction ${node}/${level} ${d.value()}`);
    }
  }
  out.push(`plates ${JSON.stringify([...net.plateReach].sort())}`);
  out.push(`transitions ${[...net.transitions].sort((a, b) => a - b).join(',')}`);
  out.push(`impossible ${JSON.stringify([...net.impossible].sort((a, b) => a[0] - b[0]))}`);
  out.push(`squeezed ${JSON.stringify([...net.squeezed].sort((a, b) => a[0] - b[0]))}`);
  return out;
}

export function laneletLines(doc: RoadDoc, net: Network): string[] {
  const graph = new LaneletGraph();
  graph.build(doc, net);
  return [...graph.lanelets.values()].map((l) => {
    const d = new Digest().addText(l.kind).addAll(l.centre.xy).add(l.length).add(l.speedLimit).add(l.controlled ? 1 : 0);
    return `lanelet ${l.id} ${l.segment ?? '-'} ${l.node ?? '-'} ${d.value()}`;
  }).sort();
}

const polyDigest = (poly: MultiPoly): number => {
  const d = new Digest();
  for (const p of poly) for (const ring of p) { for (const q of ring) d.add(q[0]!).add(q[1]!); d.add(-1); }
  return d.value();
};

/** The surface bands, the walkways, the furniture, the markings and every road's cross-section. */
export function derivedLines(net: Network): string[] {
  const out: string[] = [];
  const b = bands(surfaces(net));
  out.push(`bands ${polyDigest(b.casing)} ${polyDigest(b.footway)} ${polyDigest(b.kerb)} ${polyDigest(b.carriageway)}`);
  const walks = buildWalkways(net);
  for (const w of walks.ways) {
    out.push(`walk ${w.id} ${w.kind} ${new Digest().addAll(w.path.xy).add(w.width).add(w.lo).add(w.hi).value()}`);
  }
  for (const f of streetFurniture(net)) out.push(`furniture ${f.kind} ${f.segment} ${f.x} ${f.y}`);
  for (const [id, ribbon] of [...net.ribbons].sort((p, q) => p[0] - q[0])) {
    const marks = segmentMarkings(ribbon, 0);
    const d = new Digest();
    for (const m of marks) { d.addAll(m.points.flatMap((p) => [p.x, p.y])).add(m.width).addText(m.color); }
    out.push(`marks ${id} ${d.value()}`);
    // The fields every map had before the road system: an old map's two sides are `side`.
    const s = sectionOf(ribbon.road, ribbon.direction);
    out.push(`section ${id} ${JSON.stringify({ carriageway: s.carriageway, median: s.median, lanes: s.lanes, side: s.side, walkable: s.walkable })}`);
    if (JSON.stringify(s.left) !== JSON.stringify(s.side)) out.push(`section-left ${id} ${JSON.stringify(s.left)}`);
  }
  const detail = junctionDetail(net);
  out.push(`detail ${detail.stops.length} ${detail.zebras.length} ${new Digest().addText(JSON.stringify(detail)).value()}`);
  return out;
}
