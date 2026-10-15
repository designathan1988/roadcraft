import { describe, expect, it } from 'vitest';

import { Rng } from '@core/rng';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { crossingAccessesAt } from '@world/landscape';
import type { NodeId, SegmentId } from '@world/ids';
import { m } from '@world/units';

/**
 * THE CROSSING LANDINGS KEPT BY NODE (`landscape.ts` crossingAccessesAt): a
 * node's landings, worked out once for the network as it stands, are at every
 * step of random edits - roads drawn, demolished, bent, their junctions'
 * control changed - the landings a network built from nothing gives for the
 * same document, node by node and in the order asked.
 */
describe('the crossing landings kept by node', () => {
  it('are the landings worked out from nothing after every edit', () => {
    const rng = new Rng(0xc055);
    const doc = new RoadDoc();
    const net = new Network(doc);
    const span = m(500);
    const road = (): void => {
      const nodes = [...doc.nodes.values()];
      const a = nodes.length && rng.float() < 0.7 ? nodes[Math.floor(rng.float() * nodes.length)]!
        : doc.addNode({ x: rng.float() * span, y: rng.float() * span });
      const b = doc.addNode({ x: a.x + (rng.float() - 0.5) * m(200), y: a.y + (rng.float() - 0.5) * m(200) });
      doc.addSegment(a.id as NodeId, b.id, Math.floor(rng.float() * 4));
    };
    for (let i = 0; i < 20; i++) road();
    let compared = 0;
    for (let step = 0; step < 60; step++) {
      const roll = rng.float();
      const segs = [...doc.segments.keys()];
      if (roll < 0.45) road();
      else if (roll < 0.65 && segs.length > 4) doc.removeSegment(segs[Math.floor(rng.float() * segs.length)]! as SegmentId);
      else if (roll < 0.8) {
        const nodes = [...doc.nodes.values()];
        const controls = ['auto', 'priority', 'none', 'signal'] as const;
        doc.setNodeControl(nodes[Math.floor(rng.float() * nodes.length)]!.id, controls[Math.floor(rng.float() * controls.length)]!);
      } else {
        const nodes = [...doc.nodes.values()];
        const node = nodes[Math.floor(rng.float() * nodes.length)]!;
        doc.moveNode(node.id, { x: node.x + (rng.float() - 0.5) * m(30), y: node.y + (rng.float() - 0.5) * m(30) });
      }
      net.rebuild();
      // Asked by part, as the furniture asks (the nodes round one item), and whole.
      const ids = [...doc.nodes.keys()];
      const some = ids.filter(() => rng.float() < 0.3);
      const kept = crossingAccessesAt(net, some);
      const keptAll = crossingAccessesAt(net, ids);
      const fresh = new Network(doc);
      fresh.rebuild();
      expect(kept, `step ${step}: some`).toEqual(crossingAccessesAt(fresh, some));
      expect(keptAll, `step ${step}: all`).toEqual(crossingAccessesAt(fresh, ids));
      compared += keptAll.length;
    }
    expect(compared).toBeGreaterThan(100);
  });
});
