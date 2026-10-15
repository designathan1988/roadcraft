import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { RoadDoc } from '@world/doc';
import { roadValue, segmentCost } from '@world/economy';
import { segmentPolyline } from '@world/geometry';
import type { NodeId, SegmentId } from '@world/ids';
import { m } from '@world/units';

/** THE ROADS' VALUE KEPT FROM THE DIARY (`economy.ts` `roadValue`) */
const fromNothing = (doc: RoadDoc): number => {
  let total = 0;
  for (const s of doc.segments.values()) total += segmentCost(doc, s, segmentPolyline(doc, s).length);
  return total;
};

function edit(doc: RoadDoc, rng: Rng): void {
  const nodes = [...doc.nodes.keys()], segments = [...doc.segments.keys()];
  const pick = <T>(list: readonly T[]): T | undefined => list[Math.floor(rng.float() * list.length)];
  const roll = rng.float();
  if (roll < 0.35 || segments.length < 3) {
    const a = doc.addNode({ x: rng.float() * m(400), y: rng.float() * m(400) });
    const b = pick(nodes) ?? doc.addNode({ x: rng.float() * m(400), y: rng.float() * m(400) }).id;
    doc.addSegment(a.id, b as NodeId, Math.floor(rng.float() * 3));
  } else if (roll < 0.5) {
    const n = pick(nodes);
    if (n !== undefined) doc.moveNode(n as NodeId, { x: rng.float() * m(400), y: rng.float() * m(400) });
  } else if (roll < 0.6) {
    const n = pick(nodes);
    if (n !== undefined) doc.setNodeHeightOffset(n as NodeId, rng.float() * m(8));
  } else if (roll < 0.75) {
    const s = pick(segments);
    if (s !== undefined) doc.setSegmentType(s as SegmentId, Math.floor(rng.float() * 3));
  } else if (roll < 0.85) {
    const s = pick(segments);
    if (s !== undefined) doc.setSegmentCurve(s as SegmentId, { t: 0.5, h: rng.float() * m(20) });
  } else {
    const s = pick(segments);
    if (s !== undefined) { doc.removeSegment(s as SegmentId); doc.pruneOrphanNodes(); }
  }
}

describe('the roads\' value', () => {
  it('kept from the diary is the sum worked out from nothing, after every edit', () => {
    const doc = new RoadDoc();
    const rng = new Rng(0x7a1);
    for (let i = 0; i < 160; i++) {
      edit(doc, rng);
      expect(roadValue(doc)).toBeCloseTo(fromNothing(doc), 3);
    }
  });

  it('of a working copy starts from the original and reads only its own edits', () => {
    const doc = new RoadDoc();
    const rng = new Rng(0x7a2);
    for (let i = 0; i < 40; i++) edit(doc, rng);
    roadValue(doc);
    for (let round = 0; round < 20; round++) {
      const copy = doc.clone();
      for (let i = 0; i < 3; i++) edit(copy, rng);
      expect(roadValue(copy)).toBeCloseTo(fromNothing(copy), 3);
      expect(roadValue(doc)).toBeCloseTo(fromNothing(doc), 3);
      if (round % 2 === 0) doc.replaceWith(copy);
      expect(roadValue(doc)).toBeCloseTo(fromNothing(doc), 3);
    }
  });
});
