import type { Polyline } from '@core/polyline';
import type { Ring } from '@core/ring';
import type { Vec2 } from '@core/vec2';
import type { NodeId, SegmentId } from './ids';
import type { Network } from './network';
import { Level, halfWidth } from './roadTypes';

/** A strip a curved road's drawn surface lays across one of its mouths (`junction/mouthOverlap.ts`), still to be laid: its full centreline, its half width, where the mouth is cut. */
interface MouthStrip {
  readonly full: Polyline;
  readonly half: number;
  readonly mouth: number;
}

/**
 * What the drivable surface round a node is made of, in the order `turnPaths.ts` `JunctionSurface` adds
 * them: the rings as the network keeps them (a worker's: their points) and the mouth strips still to lay.
 * The page makes the surface from it, and a worker the same surface from the same numbers (`junctionBuild.ts`).
 */
export interface SurfaceSource {
  readonly centre: Vec2;
  readonly parts: readonly (Ring | readonly Vec2[] | MouthStrip)[];
}

/**
 * The pieces of the drivable surface round `node` - its junction plate and its legs - read off the network,
 * nothing made: the strips are laid where the surface is made (`JunctionSurface`), here or in a worker.
 */
export function surfaceParts(net: Network, node: NodeId): SurfaceSource {
  const at = net.doc.node(node);
  const parts: (Ring | MouthStrip)[] = [];
  // A road's own outline and, on a curved road, the strips the drawn surface
  // lays across its mouths (`junction/mouthOverlap.ts`).
  const road = (segment: SegmentId, level: Level.Asphalt | Level.Curb, mouths: readonly NodeId[]): void => {
    const ribbon = net.ribbons.get(segment);
    if (!ribbon) return;
    const ring = ribbon.rings[level];
    if (ring && !ring.isEmpty) parts.push(ring);
    const seg = net.doc.segments.get(segment);
    const trims = net.trims.get(segment);
    if (!seg?.curve || !trims) return;
    for (const end of mouths) {
      if (net.doc.degree(end) < 2) continue;
      const trim = (seg.a === end ? trims.a[level] : trims.b[level]) ?? 0;
      if (trim <= 0) continue;
      parts.push({ full: ribbon.full, half: halfWidth(ribbon.road, level), mouth: seg.a === end ? trim : ribbon.full.length - trim });
    }
  };
  for (const level of [Level.Asphalt, Level.Curb] as const) {
    const junction = net.junctions.get(node)?.get(level);
    for (const ring of junction?.rings ?? []) if (!ring.isEmpty) parts.push(ring);
    for (const segment of at?.incident ?? []) {
      // And the plate at the leg's far end: a body sweeps on past the
      // start of its exit lane, and where the leg is shorter than that it is
      // already crossing the next junction - drivable ground the sweep must
      // see (a swept path is checked over the whole manoeuvre). Left out,
      // a movement onto a short leg fitted no vehicle (fuzz
      // `turnOffSurface`, a 0.5-unit leg between two junctions).
      const seg = net.doc.segments.get(segment);
      const far = seg ? (seg.a === node ? seg.b : seg.a) : undefined;
      road(segment, level, far === undefined || far === node ? [node] : [node, far]);
      if (far === undefined || far === node) continue;
      for (const farRing of net.junctions.get(far)?.get(level)?.rings ?? []) if (!farRing.isEmpty) parts.push(farRing);
      // And the roads on beyond it: past a node with no plate (one road
      // bending on, a chain) the approach of a short leg is already the next
      // road's, and a body a length behind the stop line stands on it (fuzz
      // `turnOffSurface`, seed 36 of 60 operations: a 1.6-unit lane).
      for (const next of net.doc.node(far)?.incident ?? []) {
        if (next !== segment) road(next, level, [far]);
      }
    }
  }
  return { centre: { x: at?.x ?? 0, y: at?.y ?? 0 }, parts };
}
