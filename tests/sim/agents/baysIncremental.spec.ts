import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import type { BuildingId } from '@world/buildings/types';
import { growOnLot } from '@world/growth/zoning';
import { SimWorld } from '@sim/world';
import { type Bay, collectBays } from '@sim/agents/parking';

/** The bays after a building grows are worked out only for the lots its change reaches */
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

  it('roads drawn, moved and taken away beside the lots leave the bays a fresh pass finds', () => {
    // Bays are worked out again only within reach of the lanes an edit of the roads changed
    const doc = new RoadDoc();
    const a = doc.addNode({ x: m(-260), y: 0 }).id, b = doc.addNode({ x: m(260), y: 0 }).id;
    const c = doc.addNode({ x: 0, y: m(-200) }).id, d = doc.addNode({ x: 0, y: m(200) }).id;
    const parked = { left: 'parallel', right: 'parallel' } as const;
    doc.addSegment(a, b, 1, null, 0, 'both', null, 'ground', undefined, parked);
    doc.addSegment(c, d, 1, null, 0, 'both', null, 'ground', undefined, parked);
    const net = new Network(doc);
    net.rebuild();
    applyLots(doc, planLots(doc, net));
    doc.lots.forEach((l) => zoneLots(doc, [l.id], { use: 'commercial', density: 'low' }));
    const refused = new Set<number>();
    for (let k = 0; k < 24; k++) if (growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
    const w = new SimWorld(doc, net, 7);
    w.rebuildTopology();
    const fresh = (): unknown[] => {
      const other = new SimWorld(doc, net, 7);
      other.rebuildTopology();
      return strip(collectBays(other));
    };
    expect(strip(collectBays(w))).toEqual(fresh());
    const edits: (() => void)[] = [
      () => { const e = doc.addNode({ x: m(-120), y: m(140) }).id, g = doc.addNode({ x: m(120), y: m(140) }).id; doc.addSegment(e, g, 1, null, 0, 'both', null, 'ground', undefined, parked); },
      () => { doc.moveNode(b, { x: m(280), y: m(30) }); },
      () => { const far = doc.addNode({ x: m(900), y: m(900) }).id, far2 = doc.addNode({ x: m(1000), y: m(900) }).id; doc.addSegment(far, far2, 1); },
      () => { const seg = [...doc.segments.values()].find((x) => x.a === c || x.b === c); if (seg) doc.removeSegment(seg.id); },
    ];
    let kerbs = 0;
    for (const edit of edits) {
      edit();
      net.rebuild();
      w.rebuildTopology();
      const kept = collectBays(w);
      kerbs = Math.max(kerbs, kept.filter((bay) => bay.kerb).length);
      expect(strip(kept)).toEqual(fresh());
    }
    expect(kerbs, 'kerb bays along the streets that park').toBeGreaterThan(0);
  });
});
