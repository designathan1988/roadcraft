import type { NodeId, SegmentId } from '../ids';
import type { RoadDoc } from '../doc';
import { orientedPolyline } from '../geometry';
import type { RoadProfileSpec } from './profile';
import { m } from '../units';

/**
 * THE WHOLE STREET a segment belongs to (docs/VIAS.md V8, bulk edit): the
 * segments carried straight on through each node (within `STRAIGHT` of
 * straight ahead, the straightest when several are), as a player sees one
 * street running through its junctions. Each with whether it runs against
 * the first (its a -> b the other way), for a profile laid along it.
 */
const STRAIGHT = Math.cos((25 * Math.PI) / 180);
const PROBE = m(4.8);

export interface ChainPiece {
  readonly id: SegmentId;
  /** Drawn the other way round from the first segment. */
  readonly flipped: boolean;
}

export function streetChain(doc: RoadDoc, first: SegmentId): ChainPiece[] {
  const seed = doc.segment(first);
  if (!seed) return [];
  const out: ChainPiece[] = [{ id: first, flipped: false }];
  const seen = new Set<SegmentId>([first]);
  // Leaving `node` along `seg`: the unit direction a few units out.
  const leaving = (seg: SegmentId, node: NodeId): { x: number; y: number } | null => {
    const s = doc.segment(seg), n = doc.node(node);
    if (!s || !n) return null;
    const line = orientedPolyline(doc, s, node);
    const p = line.sampleAt(Math.min(line.length, PROBE)).p;
    const l = Math.hypot(p.x - n.x, p.y - n.y) || 1;
    return { x: (p.x - n.x) / l, y: (p.y - n.y) / l };
  };
  // Walk from the seed's `end` (b when `forward`), carrying the orientation.
  const walk = (forward: boolean): void => {
    let seg = first;
    let node = forward ? seed.b : seed.a;
    for (let guard = 0; guard < 500; guard++) {
      const inbound = leaving(seg, node);
      const n = doc.node(node);
      if (!inbound || !n) return;
      let next: SegmentId | null = null, best = STRAIGHT;
      for (const other of n.incident) {
        if (seen.has(other)) continue;
        const dir = leaving(other, node);
        if (!dir) continue;
        const straight = -(dir.x * inbound.x + dir.y * inbound.y);
        if (straight > best) { best = straight; next = other; }
      }
      if (next === null) return;
      const s = doc.segment(next)!;
      // The seed runs a -> b: past its b, `next` agrees when it starts at
      // `node`; behind its a, when it ends there.
      const agrees = forward ? s.a === node : s.b === node;
      seen.add(next);
      out.push({ id: next, flipped: !agrees });
      node = s.a === node ? s.b : s.a;
      seg = next;
    }
  };
  walk(true);
  walk(false);
  return out;
}

/** A profile seen from the other end: its elements in the other order, each lane's direction swapped. */
export function flipProfile(profile: RoadProfileSpec): RoadProfileSpec {
  return {
    ...profile,
    elements: [...profile.elements].reverse().map((e) => (e.kind === 'lane' ? { ...e, dir: e.dir === 'forward' ? 'backward' as const : 'forward' as const } : e)),
  };
}
