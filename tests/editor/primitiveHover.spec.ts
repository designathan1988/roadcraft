import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { BuildingTool, type ToolHost, type ToolView } from '@editor/buildingTool';

/** THE BASIC SHAPE IN HAND (`BuildingTool.hoverPrimitive`): its ghost given again only when it changed */

function setup(): BuildingTool {
  const doc = new RoadDoc();
  const net = new Network(doc);
  const view: ToolView = {
    project: (x, y, z) => ({ x, y: y - z }),
    planeAt: (s) => s,
    ray: () => ({ ox: -1000, oy: -1000, oz: 100, dx: 0, dy: 0, dz: -1 }),
    groundAt: () => 0, pickPixels: 5,
  };
  const host: ToolHost = { context: () => ({ doc, net, groundAt: () => 0 }), commit: (edit) => edit(), changed: () => {}, flash: () => {} };
  return new BuildingTool(view, host);
}

describe('a basic shape in hand', () => {
  it('keeps its ghost (and serial) while the pointer stays over the same spot', () => {
    const tool = setup();
    tool.mode = 'edit';
    tool.armPrimitive('box');
    const at = { x: 40, y: 60 };
    tool.pointerMove(at, at, false);
    const first = tool.preview;
    expect(first).not.toBeNull();
    // The same spot again: nothing for the renderer to emit again.
    tool.pointerMove(at, { ...at }, false);
    expect(tool.preview).toBe(first);
    // Elsewhere: a new ghost.
    tool.pointerMove({ x: 50, y: 60 }, { x: 50, y: 60 }, false);
    expect(tool.preview!.serial).toBeGreaterThan(first!.serial);
    expect(tool.preview!.building.x).not.toBe(first!.building.x);
  });
});
