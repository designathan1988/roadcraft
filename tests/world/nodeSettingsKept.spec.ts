import { describe, expect, it } from 'vitest';

import type { NodeId, SegmentId } from '@world/ids';
import { RoadDoc } from '@world/doc';
import { layoutDoc } from '../sim/support/bodies';

/**
 * WHAT THE PLAYER SET AT A JUNCTION SURVIVES THE DOCUMENT BEING REPLACED.
 * Every road drawn commits an edited clone (`replaceWith`), and undo and redo
 * restore a snapshot the same way: a node's lane connections, leg rules and
 * signal settings, and a road's retaining walls, must come through it, and
 * an undo of one of them alone must count as a change of the roads.
 */
function junction(): { doc: RoadDoc; centre: NodeId; legs: SegmentId[] } {
  const { doc, centre } = layoutDoc({ name: 'av', bearings: [0, 90, 180, 270], types: [3, 1, 3, 1] });
  const legs = [...doc.segments.keys()].sort((a, b) => a - b) as SegmentId[];
  return { doc, centre: centre as NodeId, legs };
}

describe('junction settings through replaceWith', () => {
  it('a clone committed keeps the signal, the leg rules, the lane links and the cut walls', () => {
    const { doc, centre, legs } = junction();
    doc.setNodeControl(centre, 'priority');
    doc.setNodeApproachRules(centre, [{ segment: legs[1]!, rule: 'stop' }]);
    doc.setNodeSignal(centre, { busPriority: true });
    doc.setNodeLaneLinks(centre, [{ from: legs[0]!, fromLane: 0, to: legs[2]!, toLane: 0 }]);
    doc.setSegmentCutWalls(legs[0]!, true);
    const before = JSON.stringify(doc.toJSON().nodes.find((n) => n.id === centre));
    doc.replaceWith(doc.clone());
    expect(JSON.stringify(doc.toJSON().nodes.find((n) => n.id === centre))).toBe(before);
    expect(doc.segment(legs[0]!)?.cutWalls).toBe(true);
  });

  it('undoing a signal setting alone puts the old one back and moves the road revision', () => {
    const { doc, centre } = junction();
    const snapshot = doc.clone();
    doc.setNodeSignal(centre, { busPriority: true });
    const revision = doc.revision;
    doc.replaceWith(snapshot);
    expect(doc.node(centre)?.signal).toBeUndefined();
    expect(doc.revision).not.toBe(revision);
  });

  it('undoing the cut walls alone takes them off and moves the road revision', () => {
    const { doc, legs } = junction();
    const snapshot = doc.clone();
    doc.setSegmentCutWalls(legs[0]!, true);
    const revision = doc.revision;
    doc.replaceWith(snapshot);
    expect(doc.segment(legs[0]!)?.cutWalls).toBeUndefined();
    expect(doc.revision).not.toBe(revision);
  });
});
