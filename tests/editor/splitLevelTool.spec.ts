import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { BuildingTool, type ToolHost, type ToolView } from '@editor/buildingTool';
import { localToWorld } from '@world/buildings/geometry';
import { m } from '@world/units';
import { localFootprint } from '@world/buildings/footprints';
import type { Building } from '@world/buildings/types';

/**
 * A block standing at a floor of its own (a split level, `Volume.lift`) is
 * worked on at its own height: a mass stacked on its roof is drawn on that
 * roof, not half a storey above or below it.
 *
 * The view is oblique: a point drawn at height z lands z further up the
 * screen (screen y = world y - z), so a drag read at the wrong height lands
 * displaced by exactly the height it was wrong by.
 */

function setup(): { tool: BuildingTool; doc: RoadDoc } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: -600, y: 0 });
  const b = doc.addNode({ x: 600, y: 0 });
  doc.addSegment(a.id, b.id, 1);
  const net = new Network(doc);
  const view: ToolView = {
    project: (x, y, z) => ({ x, y: y - z }),
    planeAt: (s, z) => ({ x: s.x, y: s.y + z }),
    ray: () => ({ ox: -1000, oy: -1000, oz: 100, dx: 0, dy: 0, dz: -1 }),
    groundAt: () => 0, pickPixels: 5,
  };
  const host: ToolHost = {
    context: () => ({ doc, net, groundAt: () => 0 }),
    groundKey: () => '0',
    commit: (edit) => edit(),
    changed: () => {}, flash: () => {},
  };
  return { tool: new BuildingTool(view, host), doc };
}

/** Builds a block, lifts it by `lift`, stacks a rectangle drawn at the same screen points on its roof: the stacked block's near y. */
function stackedOn(lift: number): number {
  const { tool, doc } = setup();
  const start = { x: 20, y: 40 }, end = { x: 70, y: 80 };
  tool.beginShapeDrag('rectangle', start, 'new', start);
  tool.updateShapeDrag(end, end);
  tool.endShapeDrag(false);
  const b = [...doc.buildings.all()][0]!;
  const lifted: Building = { ...b, volumes: b.volumes.map((v) => ({ ...v, lift })) };
  doc.buildings.put(lifted);
  tool.selection = { building: b.id, volume: b.volumes[0]!.id, bay: null };
  // The same screen rectangle, a little inside the roof, stacked on top.
  const s0 = { x: 30, y: 50 }, s1 = { x: 50, y: 65 };
  tool.beginShapeDrag('rectangle', s0, 'top', s0);
  tool.updateShapeDrag(s1, s1);
  tool.endShapeDrag(false);
  const after = doc.buildings.get(b.id)!;
  const top = after.volumes[after.volumes.length - 1]!;
  const ring = localFootprint(top).map((p) => localToWorld(after, p.x, p.y));
  return Math.min(...ring.map((p) => p.y));
}

describe('a split-level block in the building tool', () => {
  it('stacks a mass on the roof of the block at the block\'s own height', () => {
    // Half a storey up, as a split level stands.
    const half = m(1.5);
    const level = stackedOn(0);
    const lifted = stackedOn(half);
    // Read at the lifted roof, the rectangle lands `half` further along y.
    expect(lifted - level).toBeCloseTo(half, 6);
  });
});
