import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { BuildingTool, type ToolHost, type ToolView } from '@editor/buildingTool';

/** PRD-09: a hover tells the screen (`hovered`), never the panel (`changed`): nothing the panel shows reads what the pointer is over. */
describe("the Builder's hover", () => {
  it('moves the ghost without telling the panel', () => {
    const doc = new RoadDoc();
    const net = new Network(doc);
    const view: ToolView = {
      project: (x, y, z) => ({ x, y: y - z }),
      planeAt: (s) => s,
      ray: () => ({ ox: -1000, oy: -1000, oz: 100, dx: 0, dy: 0, dz: -1 }),
      groundAt: () => 0, pickPixels: 5,
    };
    let changed = 0, hovered = 0;
    const host: ToolHost = { context: () => ({ doc, net, groundAt: () => 0 }), commit: (edit) => edit(), changed: () => { changed++; }, hovered: () => { hovered++; }, flash: () => {} };
    const tool = new BuildingTool(view, host);
    tool.mode = 'edit';
    tool.armPrimitive('box');
    changed = 0;
    expect(tool.hoversOnly()).toBe(true);
    for (let k = 0; k < 5; k++) tool.pointerMove({ x: 40 + k, y: 60 }, { x: 40 + k, y: 60 }, false);
    expect(tool.preview).not.toBeNull();
    expect([changed, hovered]).toEqual([0, 5]);
  });
});
