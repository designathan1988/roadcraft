import { describe, expect, it } from 'vitest';
import { Network } from '@world/network';
import { LaneletGraph } from '@world/lanelets';
import { buildRoadElevation } from '@world/elevation';
import { isRaised } from '@world/structures';
import { sampleTerrainHeight } from '@world/terrain';
import { m } from '@world/units';
import { buildInspectionMap } from '../fixtures/inspectionMap';

/** NO HARD GRADE BREAKS. */
const WINDOW = m(3);
const GROUND_LIMIT = 0.06;
/** Ramps: the crest is as long as the 100-unit ramp rule allows. */
const RAMP_LIMIT = 0.1;

describe('vertical curves', () => {
  it('bends every grade line over a curve, never at a corner', () => {
    const map = buildInspectionMap();
    const net = new Network(map.doc);
    net.rebuild();
    const elevation = buildRoadElevation(net, (x, y) => sampleTerrainHeight(map.doc.terrainStamps, x, y));
    const graph = new LaneletGraph();
    graph.build(map.doc, net);
    const bad: string[] = [];
    let checked = 0;
    for (const lane of graph.lanelets.values()) {
      if (lane.kind !== 'link' || lane.segment === undefined) continue;
      const seg = lane.segment;
      const raised = isRaised(map.doc.segment(seg)!.structure);
      const h = (s: number): number => {
        const p = lane.centre.sampleAt(s).p;
        return elevation.onSegment(seg, p.x, p.y);
      };
      for (let s = WINDOW; s + WINDOW < lane.length; s += m(0.2)) {
        const change = Math.abs((h(s + WINDOW) - h(s)) / WINDOW - (h(s) - h(s - WINDOW)) / WINDOW);
        checked++;
        if (change > (raised ? RAMP_LIMIT : GROUND_LIMIT)) bad.push(`${lane.id} s ${s} ${change.toFixed(3)}`);
      }
    }
    expect(checked).toBeGreaterThan(5000);
    expect(bad.slice(0, 10)).toEqual([]);
  });
});
