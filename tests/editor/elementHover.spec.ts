import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import type { BuildingId } from '@world/buildings/types';
import { blueprintByKey } from '@world/buildings/blueprints';
import { placeBuilding } from '@editor/buildings';
import { BuildingTool, type ToolHost, type ToolView } from '@editor/buildingTool';
import { TUNED_UNIT } from '@world/units';

/** THE ELEMENT IN HAND (`BuildingTool.hoverElement`): its ghost given again only when it changed, as the basic shape's is */

const U = TUNED_UNIT;

function setup(): BuildingTool {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: -600 * U, y: 0 });
  const b = doc.addNode({ x: 600 * U, y: 0 });
  doc.addSegment(a.id, b.id, 1);
  const net = new Network(doc);
  net.rebuild();
  const ctx = { doc, net, groundAt: () => 0 };
  const placed = placeBuilding(ctx, blueprintByKey('house')!.body, { x: 0, y: 60 * U }, 0, 'house');
  expect(placed.ok, String(placed.problem)).toBe(true);
  const view: ToolView = {
    project: (x, y, z) => ({ x, y: y - z }),
    planeAt: (s) => s,
    // The ray misses the house: the element lands beside it, where the pointer is on the ground.
    ray: () => ({ ox: -1000, oy: -1000, oz: 100, dx: 0, dy: 0, dz: -1 }),
    groundAt: () => 0, pickPixels: 5,
  };
  const host: ToolHost = { context: () => ctx, commit: (edit) => edit(), changed: () => {}, flash: () => {} };
  const tool = new BuildingTool(view, host);
  tool.mode = 'edit';
  tool.selectBuilding(placed.id as BuildingId);
  tool.armElement('pillar');
  return tool;
}

describe('an element in hand', () => {
  it('keeps its ghost (and serial) while the pointer stays over the same spot', () => {
    const tool = setup();
    const at = { x: 20 * U, y: 20 * U };
    tool.pointerMove(at, at, false);
    const first = tool.preview;
    expect(first).not.toBeNull();
    // The same spot again: the same ghost, nothing for the renderer to build again.
    tool.pointerMove(at, { ...at }, false);
    expect(tool.preview).toBe(first);
    // Elsewhere: a new ghost.
    const there = { x: -20 * U, y: 20 * U };
    tool.pointerMove(there, there, false);
    expect(tool.preview).not.toBe(first);
    expect(tool.preview!.serial).toBeGreaterThan(first!.serial);
  });
});
