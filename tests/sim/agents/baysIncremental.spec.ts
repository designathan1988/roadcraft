import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import type { BuildingId } from '@world/buildings/types';
import { growOnLot } from '@editor/zoning';
import { SimWorld } from '@sim/world';
import { type Bay, collectBays } from '@sim/agents/parking';

/**
 * The bays after a building grows are worked out only for the lots its change
 * reaches (audit M3a, `parking.ts` `buildingChangesSince`): they must be the
 * very bays a fresh pass over the whole town finds.
 */
const strip = (bays: readonly Bay[]): unknown[] => bays.map(({ id, building, x, y, ox, oy, depth, lane, via }) =>
  ({ id, building, x: x.toFixed(4), y: y.toFixed(4), ox: ox.toFixed(4), oy: oy.toFixed(4), depth, lane: lane ? `${lane.lanelet}:${lane.at.toFixed(3)}@${lane.x.toFixed(3)},${lane.y.toFixed(3)}` : null,
    via: via.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(' ') }));

describe('bays kept by the diary', () => {
  it('a town growing building by building has the bays a fresh pass finds', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: m(-260), y: 0 }).id, b = doc.addNode({ x: m(260), y: 0 }).id;
    const c = doc.addNode({ x: 0, y: m(-200) }).id, d = doc.addNode({ x: 0, y: m(200) }).id;
    doc.addSegment(a, b, 1);
    doc.addSegment(c, d, 1);
    const net = new Network(doc);
    net.rebuild();
    applyLots(doc, planLots(doc, net));
    const zones = [{ use: 'commercial', density: 'low' }, { use: 'residential', density: 'medium' }, { use: 'industrial', density: 'medium' }] as const;
    doc.lots.forEach((l, i) => zoneLots(doc, [l.id], zones[i % zones.length]!));
    const w = new SimWorld(doc, net, 7);
    const refused = new Set<number>();
    let checks = 0;
    for (let k = 0; k < 40; k++) {
      const id = growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed);
      if (id === null) { if (refused.size >= doc.lots.length) break; continue; }
      // Every few buildings, one taken away again: a removal is a change too.
      if (k % 7 === 6) doc.buildings.remove(id as BuildingId);
      const kept = collectBays(w);
      const fresh = collectBays(new SimWorld(doc, net, 7));
      expect(strip(kept)).toEqual(strip(fresh));
      checks++;
    }
    expect(checks).toBeGreaterThan(8);
    expect(collectBays(w).filter((bay) => !bay.kerb).length).toBeGreaterThan(10);
  });
});
