import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { m } from '@world/units';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { HEAVY } from '@world/conflictPoints';
import { simOf } from './support/bodies';

/**
 * TRAFFIC TURNS ROUND IN A TURNING CIRCLE (docs/VIAS.md V8). A road from the
 * map's edge to an end marked as a circle: cars come in at the edge, the only
 * way out is back where they came from, so every one of them turns round in
 * the circle - none leaves the map there, none is made there.
 */
function cul(): { doc: RoadDoc; edge: number; end: number } {
  const doc = new RoadDoc();
  const edge = doc.addNode({ x: m(-300), y: 0 }).id, end = doc.addNode({ x: m(60), y: 0 }).id;
  doc.addSegment(edge, end, 1);
  doc.setNodeEnd(end, 'bulb');
  return { doc, edge, end };
}

describe('a turning circle', () => {
  // A car or a van turns round; a bus or a lorry fits the circle on its own,
  // but a second one following it round at the closest gap would stand in it
  // (the sweep's fold-back check), so none is routed into a street it cannot leave.
  it('turns cars and vans round, and keeps buses and lorries out', () => {
    const { doc, end } = cul();
    const sim = simOf(doc, 11, 2);
    const turns = [...sim.graph.connectors.values()].filter((c) => c.node === end);
    expect(turns.length).toBeGreaterThan(0);
    for (const c of turns) {
      expect(c.turn).toBe('uturn');
      expect(c.maxBodyClass).toBe(HEAVY - 1);
    }
  });

  it('sends the cars that come in round it and back out at the edge', () => {
    const { doc, end } = cul();
    const sim = simOf(doc, 11, 2);
    const turning = new Set([...sim.graph.connectors.values()].filter((c) => c.node === end).map((c) => c.lanelet));
    const roundIt = new Set<number>();
    const goneAtEnd: number[] = [];
    let before = new Map<number, string>();
    sim.clock.run(Math.round(180 / DT), () => {
      step(sim, { traffic: true, pedestrians: false });
      const now = new Map<number, string>();
      for (const v of sim.vehiclesInIdOrder()) {
        now.set(v.id, v.lanelet);
        if (turning.has(v.lanelet)) roundIt.add(v.id);
      }
      // A car gone from a lane ending at the circle left the map there.
      for (const [id, lane] of before) {
        if (now.has(id)) continue;
        const l = sim.lanelet(lane);
        if (l?.to === end) goneAtEnd.push(id);
      }
      before = now;
    });
    expect(roundIt.size).toBeGreaterThan(3);
    expect(goneAtEnd).toEqual([]);
  });
});
