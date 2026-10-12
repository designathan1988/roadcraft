import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { m } from '@world/units';
import { roadProfile, sectionFromProfile } from '@world/roadTypes';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { commitUturn } from '@editor/streetObjects';
import { Network } from '@world/network';
import { simOf } from './support/bodies';

/**
 * TRAFFIC TURNS ROUND AT A U-TURN (docs/VIAS.md V8). A boulevard with a 5 m
 * median between two map edges and a U-turn in the middle: some of the cars
 * that come in turn round there, and no body ever stands in another.
 */
describe('a U-turn through the median', () => {
  it('is driven by the cars that want to go back', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: m(-300), y: 0 }).id, b = doc.addNode({ x: m(300), y: 0 }).id;
    const seg = doc.addSegment(a, b, 3)!;
    doc.setSegmentSection(seg.id, { ...sectionFromProfile(roadProfile(3)), median: m(5) });
    const net = new Network(doc);
    net.rebuild();
    const result = commitUturn(doc, net, seg.id, 'b');
    expect(result.committed).toBe(true);
    const sim = simOf(doc, 23, 2);
    const turning = new Set([...sim.graph.connectors.values()].filter((c) => c.turn === 'uturn').map((c) => c.lanelet));
    const turned = new Set<number>();
    sim.clock.run(Math.round(240 / DT), () => {
      step(sim, { traffic: true, pedestrians: false });
      for (const v of sim.vehiclesInIdOrder()) if (turning.has(v.lanelet)) turned.add(v.id);
    });
    expect(turned.size).toBeGreaterThan(0);
  });
});
