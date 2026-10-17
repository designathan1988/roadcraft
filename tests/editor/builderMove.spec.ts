import { describe, expect, it, vi } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { BuildingTool, type ToolHost, type ToolView } from '@editor/buildingTool';
import { placeBuilding, weldInto } from '@editor/buildings';
import { blueprintByKey } from '@world/buildings/blueprints';
import { type BuildingId, cloneBuilding } from '@world/buildings/types';
import { neighbourOf } from '@world/buildings/neighbours';
import { m } from '@world/units';

/** THE BUILDER'S POINTER MOVE (plan E1): a ghost landing where it was is not judged again, a neighbour's rings are not made again */
function setup(): { tool: BuildingTool; doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: m(-240), y: 0 });
  const b = doc.addNode({ x: m(240), y: 0 });
  doc.addSegment(a.id, b.id, 1);
  const net = new Network(doc);
  net.rebuild();
  const view: ToolView = {
    project: (x, y, z) => ({ x, y: y - z }),
    planeAt: (s) => s,
    ray: () => ({ ox: -1000, oy: -1000, oz: 100, dx: 0, dy: 0, dz: -1 }),
    groundAt: () => 0, pickPixels: 5,
  };
  const host: ToolHost = { context: () => ({ doc, net, groundAt: () => 0 }), commit: (edit) => edit(), changed: () => {}, flash: () => {} };
  return { tool: new BuildingTool(view, host), doc, net };
}

describe('the builder under a moving pointer', () => {
  it('keeps the ghost and its verdict while the pointer lands it where it was, and judges again after the buildings changed', () => {
    const { tool, doc, net } = setup();
    const at = { x: m(30), y: m(24) };
    const near = vi.spyOn(doc.buildings, 'near');
    tool.hoverPlace(at);
    const ghost = tool.preview;
    const first = near.mock.calls.length;
    expect(ghost).not.toBeNull();
    tool.hoverPlace({ x: at.x + 1e-4, y: at.y });
    tool.hoverPlace(at);
    // The same ghost (not redrawn) and no neighbour asked again: no validation, no weld.
    expect(tool.preview).toBe(ghost);
    expect(near.mock.calls.length - first).toBeLessThan(first * 2);
    const settled = near.mock.calls.length;
    tool.hoverPlace(at);
    expect(near.mock.calls.length - settled).toBeLessThan(first);
    // A building put down elsewhere: the next verdict is asked again.
    expect(placeBuilding({ doc, net, groundAt: () => 0 }, blueprintByKey('house')!.body, { x: m(-150), y: m(24) }, 0, 'house').ok).toBe(true);
    const before = near.mock.calls.length;
    tool.hoverPlace(at);
    expect(near.mock.calls.length - before).toBe(first);
  });

  it('welds by the neighbour rings kept per record, the same as before', () => {
    const { doc, net } = setup();
    const ctx = { doc, net, groundAt: () => 0 };
    const result = placeBuilding(ctx, blueprintByKey('house')!.body, { x: 0, y: m(24) }, 0, 'house');
    const first = doc.buildings.get(result.id as BuildingId)!;
    const kept = neighbourOf(first).obstacles;
    const draft = { ...cloneBuilding(first), id: 999 as BuildingId };
    draft.x += m(4);
    expect(weldInto(ctx, draft)).toEqual([first.id]);
    expect(neighbourOf(first).obstacles).toBe(kept);
    const far = { ...cloneBuilding(first), id: 998 as BuildingId };
    far.x += m(80);
    expect(weldInto(ctx, far)).toEqual([]);
  });
});
