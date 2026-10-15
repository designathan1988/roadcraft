import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { commitDraft } from '@editor/commit';
import { TUNED_UNIT } from '@world/units';

/** The 0.4 m unit these scenes were laid out in: lengths below in it, times U. */
const U = TUNED_UNIT;

/** A STRAIGHT CROSS STREET STAYS STRAIGHT (the player, 2026-10-09). */

const ROAD = 1;

function build(): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  const net = new Network(doc);
  net.rebuild();
  return { doc, net };
}

/** The node at (x, y) in U (0.4 m), within `tol` U. */
const nodeAt = (doc: RoadDoc, x: number, y: number, tol = 0.5) =>
  [...doc.nodes.values()].find((n) => Math.abs(n.x - x * U) < tol * U && Math.abs(n.y - y * U) < tol * U);

/** Every node the cross street from (x, -120) to (x, 120) runs through stands on its line. */
function crossIsStraight(doc: RoadDoc, x: number): boolean {
  const top = nodeAt(doc, x, -120), bottom = nodeAt(doc, x, 120);
  if (!top || !bottom) return false;
  // Walk from the top along the roads of the cross street (those leaving each node most nearly along y).
  let at = top;
  const seen = new Set<number>([at.id]);
  for (let guard = 0; guard < 10 && at.id !== bottom.id; guard++) {
    let next: typeof at | undefined;
    let best = -Infinity;
    for (const id of at.incident) {
      const seg = doc.segment(id)!;
      const other = doc.node(seg.a === at.id ? seg.b : seg.a)!;
      if (seen.has(other.id)) continue;
      const dy = other.y - at.y, len = Math.hypot(other.x - at.x, dy);
      if (dy / len > best) { best = dy / len; next = other; }
    }
    if (!next) return false;
    if (Math.abs(next.x - x * U) > 0.5 * U) return false;
    seen.add(next.id);
    at = next;
  }
  return at.id === bottom.id;
}

describe('a straight cross street stays straight', () => {
  it('through the joint left by lengthening a road', () => {
    const { doc, net } = build();
    expect(commitDraft(doc, net, { kind: 'free', at: { x: 0, y: 0 } }, { kind: 'free', at: { x: 200 * U, y: 0 } }, ROAD).committed).toBe(true);
    const joint = nodeAt(doc, 200, 0)!;
    expect(commitDraft(doc, net, { kind: 'node', node: joint.id, at: { x: 200 * U, y: 0 } }, { kind: 'free', at: { x: 400 * U, y: 0 } }, ROAD).committed).toBe(true);
    expect(commitDraft(doc, net, { kind: 'free', at: { x: 215 * U, y: -120 * U } }, { kind: 'free', at: { x: 215 * U, y: 120 * U } }, ROAD).committed).toBe(true);
    expect(crossIsStraight(doc, 215)).toBe(true);
    expect(nodeAt(doc, 215, 0)?.incident.length).toBe(4);
    expect(nodeAt(doc, 200, 0)).toBeUndefined();
  });

  it('over a road just short of its dead end: a T, the stub gone', () => {
    const { doc, net } = build();
    expect(commitDraft(doc, net, { kind: 'free', at: { x: 0, y: 0 } }, { kind: 'free', at: { x: 200 * U, y: 0 } }, ROAD).committed).toBe(true);
    expect(commitDraft(doc, net, { kind: 'free', at: { x: 188 * U, y: -120 * U } }, { kind: 'free', at: { x: 188 * U, y: 120 * U } }, ROAD).committed).toBe(true);
    expect(crossIsStraight(doc, 188)).toBe(true);
    expect(nodeAt(doc, 188, 0)?.incident.length).toBe(3);
    expect(nodeAt(doc, 200, 0)).toBeUndefined();
  });

  it('still joins through a real junction near the crossing', () => {
    const { doc, net } = build();
    commitDraft(doc, net, { kind: 'free', at: { x: 0, y: 0 } }, { kind: 'free', at: { x: 400 * U, y: 0 } }, ROAD);
    commitDraft(doc, net, { kind: 'free', at: { x: 200 * U, y: -200 * U } }, { kind: 'free', at: { x: 200 * U, y: 200 * U } }, ROAD);
    const junction = nodeAt(doc, 200, 0)!;
    expect(junction.incident.length).toBe(4);
    commitDraft(doc, net, { kind: 'free', at: { x: 212 * U, y: -120 * U } }, { kind: 'free', at: { x: 212 * U, y: 60 * U } }, ROAD);
    // The junction stays where it is.
    expect(nodeAt(doc, 200, 0)?.id).toBe(junction.id);
  });
});
