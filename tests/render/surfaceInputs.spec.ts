import { describe, expect, it } from 'vitest';

import { Network } from '@world/network';
import { planCity, DEFAULT_CITY } from '@world/cityGen/plan';
import { layCity } from '@editor/cityGenerator';
import { m } from '@world/units';
import { SurfaceInputs, surfaceInputWork } from '@render/roadSurfaceInputs';

/** THE ROAD SURFACES' INPUTS COST AN EDIT THE ITEMS IT TOUCHED (`roadSurfaceInputs.ts`) */
function editWork(radius: number): { segments: number; nodes: number; roads: number } {
  const doc = layCity(planCity({ ...DEFAULT_CITY, seed: 2, size: 'small', radius }));
  const net = new Network(doc);
  net.rebuild();
  const inputs = new SurfaceInputs();
  inputs.refresh(net);
  // Far west of the city, alone.
  let west = Infinity, y = 0;
  for (const node of doc.nodes.values()) if (node.x < west) { west = node.x; y = node.y; }
  const a = doc.addNode({ x: west - m(300), y });
  const b = doc.addNode({ x: west - m(200), y: y + m(20) });
  doc.addSegment(a.id, b.id, 1);
  net.rebuild();
  surfaceInputWork.segments = 0;
  surfaceInputWork.nodes = 0;
  inputs.refresh(net);
  return { segments: surfaceInputWork.segments, nodes: surfaceInputWork.nodes, roads: doc.segments.size };
}

describe('road surface inputs', () => {
  it('make the items an edit far away touched, whatever the size of the map', () => {
    const small = editWork(m(300));
    const large = editWork(m(900));
    expect(large.roads).toBeGreaterThan(small.roads * 4);
    // The new street and its two ends.
    expect(small).toMatchObject({ segments: 1, nodes: 2 });
    expect(large).toMatchObject({ segments: 1, nodes: 2 });
  });
});
