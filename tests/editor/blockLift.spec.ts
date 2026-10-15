import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { BuildingTool, type ToolHost, type ToolView } from '@editor/buildingTool';
import { levelHeight, volumeElevation, volumeLift } from '@world/buildings/geometry';
import { opSetLift, snapLift } from '@world/buildings/splitLevel';
import { buildingHandles } from '@world/buildings/handles';
import { validateBuilding } from '@world/buildings/validate';
import { type Building, MAX_LIFT, cloneBuilding } from '@world/buildings/types';
import { m } from '@world/units';

/** The Construction tool's control of a block's own floor (`Volume.lift`, a split level) */

function setup(): { tool: BuildingTool; doc: RoadDoc; ctx: ReturnType<ToolHost['context']> } {
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
  const ctx = { doc, net, groundAt: () => 0 };
  const host: ToolHost = {
    context: () => ctx,
    commit: (edit) => edit(),
    changed: () => {}, flash: () => {},
  };
  return { tool: new BuildingTool(view, host), doc, ctx };
}

/** A two-block house drawn with the tool, with a third block stacked on the second and a canopy on its front. */
function house(): { tool: BuildingTool; doc: RoadDoc; ctx: ReturnType<ToolHost['context']>; b: Building } {
  const s = setup();
  const start = { x: 20, y: 40 }, end = { x: 50, y: 60 };
  s.tool.beginShapeDrag('rectangle', start, 'new', start);
  s.tool.updateShapeDrag(end, end);
  s.tool.endShapeDrag(false);
  const drawn = [...s.doc.buildings.all()][0]!;
  const b = cloneBuilding(drawn);
  const front = b.volumes[0]!;
  // The back block, behind the first, and a storey stacked on it.
  const back = { ...structuredClone(front), id: b.nextVolumeId++, y: front.y + front.d, d: m(6) };
  const top = { ...structuredClone(front), id: b.nextVolumeId++, y: back.y + m(1), d: m(4), base: back.storeys.length, storeys: [structuredClone(front.storeys[0]!)] };
  b.volumes.push(back, top);
  b.nextElementId = 10;
  // A canopy hung on the back block's back wall, and one on the front block's front wall.
  b.elements = [
    { id: 1, kind: 'canopy', x: back.x + back.w / 2, y: back.y + back.d + m(0.5), facing: 2, w: m(2), d: m(1), z: m(2.4), h: m(0.15) },
    { id: 2, kind: 'canopy', x: front.x + front.w / 2, y: front.y - m(0.5), facing: 0, w: m(2), d: m(1), z: m(2.4), h: m(0.15) },
  ];
  s.doc.buildings.put(b);
  expect(validateBuilding(s.ctx, b, b.id)).toBeNull();
  s.tool.selection = { building: b.id, volume: back.id, bay: null };
  s.tool.setMode('edit');
  return { ...s, b };
}

describe('the lift of a block (a split level) in the Construction tool', () => {
  it('moves the block, what stands on it and what hangs on it, and nothing else', () => {
    const { b } = house();
    const draft = cloneBuilding(b);
    const [front, back, top] = draft.volumes as [typeof draft.volumes[0], typeof draft.volumes[0], typeof draft.volumes[0]];
    const half = levelHeight(draft, 0) / 2;
    expect(opSetLift(draft, back.id, half)).toBe(true);
    expect(volumeLift(back)).toBeCloseTo(half, 9);
    // The block on its roof goes with it, still on it.
    expect(volumeLift(top)).toBeCloseTo(half, 9);
    expect(volumeElevation(draft, top, top.base)).toBeCloseTo(volumeElevation(draft, back, back.base + back.storeys.length), 9);
    // The front block stays at the street's floor.
    expect(front.lift).toBeUndefined();
    // The canopy on the back wall rises with it; the one on the front does not.
    expect(draft.elements!.find((e) => e.id === 1)!.z).toBeCloseTo(m(2.4) + half, 9);
    expect(draft.elements!.find((e) => e.id === 2)!.z).toBeCloseTo(m(2.4), 9);
    // Set back to the ground floor, the lift is gone from the record.
    expect(opSetLift(draft, back.id, 0)).toBe(true);
    expect(back.lift).toBeUndefined();
    expect(top.lift).toBeUndefined();
    expect(opSetLift(draft, back.id, 0)).toBe(false);
  });

  it('holds the lift within MAX_LIFT and refuses an open lot', () => {
    const { b } = house();
    const draft = cloneBuilding(b);
    const back = draft.volumes[1]!;
    opSetLift(draft, back.id, m(40));
    expect(volumeLift(back)).toBeCloseTo(MAX_LIFT, 9);
    opSetLift(draft, back.id, -m(40));
    expect(volumeLift(back)).toBeCloseTo(-MAX_LIFT, 9);
    const lot = { ...structuredClone(back), id: draft.nextVolumeId++, y: back.y + back.d, d: m(5), open: 'grass' as const };
    delete lot.lift;
    draft.volumes.push(lot);
    expect(opSetLift(draft, lot.id, m(1))).toBe(false);
  });

  it('snaps a dragged lift to half storeys', () => {
    const { b } = house();
    const half = levelHeight(b, 0) / 2;
    expect(snapLift(b, half * 0.6)).toBeCloseTo(half, 9);
    expect(snapLift(b, -half * 1.4)).toBeCloseTo(-half, 9);
    expect(Math.abs(snapLift(b, m(40)))).toBeLessThanOrEqual(MAX_LIFT + 1e-9);
  });

  it('types a lift in the panel, as one validated edit', () => {
    const { tool, doc, ctx, b } = house();
    const back = b.volumes[1]!;
    tool.setBlockLift(m(1.2));
    const after = doc.buildings.get(b.id)!;
    expect(volumeLift(after.volumes.find((v) => v.id === back.id)!)).toBeCloseTo(m(1.2), 9);
    expect(tool.blockLift()).toBeCloseTo(m(1.2), 9);
    expect(validateBuilding(ctx, after, after.id)).toBeNull();
  });

  it('drags the block up and down by its own arrow', () => {
    const { tool, doc, b } = house();
    const back = b.volumes[1]!;
    const half = levelHeight(b, 0) / 2;
    const handle = tool.handles().find((h) => h.kind === 'lift');
    expect(handle, 'the selected ground block has a lift arrow').toBeDefined();
    // Off the block's corner, halfway up its bottom storey.
    const floor = tool.floorOf(doc.buildings.get(b.id)!);
    expect(handle!.z).toBeCloseTo(floor + levelHeight(b, 0) / 2, 6);
    const at = { x: handle!.x, y: handle!.y - handle!.z };
    tool.pointerDown(at, { x: handle!.x, y: handle!.y }, false);
    // Up the screen by a little more than half a storey: snapped to half a storey.
    tool.pointerMove({ x: at.x, y: at.y - half * 1.2 }, { x: handle!.x, y: handle!.y }, false);
    expect(tool.measure?.kind).toBe('depth');
    expect(tool.measure?.value).toBeCloseTo(half, 6);
    tool.pointerUp(false);
    let after = doc.buildings.get(b.id)!;
    expect(volumeLift(after.volumes.find((v) => v.id === back.id)!)).toBeCloseTo(half, 6);
    // The arrow now stands at the raised floor; dragged down a whole storey, the block goes below the street's floor.
    const raised = tool.handles().find((h) => h.kind === 'lift')!;
    expect(raised.z).toBeCloseTo(floor + half + levelHeight(b, 0) / 2, 6);
    const from = { x: raised.x, y: raised.y - raised.z };
    tool.pointerDown(from, { x: raised.x, y: raised.y }, false);
    tool.pointerMove({ x: from.x, y: from.y + half * 2.1 }, { x: raised.x, y: raised.y }, false);
    tool.pointerUp(false);
    after = doc.buildings.get(b.id)!;
    expect(volumeLift(after.volumes.find((v) => v.id === back.id)!)).toBeCloseTo(-half, 6);
  });

  it('keeps the move, turn and scale handles on the lowered block, not in the air', () => {
    const { tool, doc } = setup();
    const start = { x: 20, y: 40 }, end = { x: 50, y: 60 };
    tool.beginShapeDrag('rectangle', start, 'new', start);
    tool.updateShapeDrag(end, end);
    tool.endShapeDrag(false);
    const b = [...doc.buildings.all()][0]!;
    tool.selection = { building: b.id, volume: b.volumes[0]!.id, bay: null };
    tool.setMode('edit');
    const before = new Map(tool.handles().map((h) => [h.kind, h.z]));
    tool.setBlockLift(-m(3));
    const after = new Map(tool.handles().map((h) => [h.kind, h.z]));
    // The building's one block went down a storey: its handles with it.
    for (const kind of ['move', 'rotate', 'scale', 'storeys', 'lift'] as const) {
      expect(after.get(kind)! - before.get(kind)!, kind).toBeCloseTo(-m(3), 6);
    }
    // The lift arrow never on the move handle: half a storey over it.
    expect(after.get('lift')! - after.get('move')!).toBeCloseTo(levelHeight(b, 0) / 2, 6);
  });

  it('stands the move handle on the block beside an open corner of an L', () => {
    const { b } = house();
    const draft = cloneBuilding(b);
    const [front, back] = draft.volumes as [typeof draft.volumes[0], typeof draft.volumes[0]];
    // An L: the back block narrower than the front, on its right.
    back.x = front.x + front.w / 2; back.w = front.w / 2; back.d = front.w;
    draft.volumes.splice(2);
    opSetLift(draft, back.id, -m(3));
    // The box's back-left corner is open ground
    const handles = buildingHandles(draft, back.id, 0, () => [3, 2]);
    expect(handles.find((h) => h.kind === 'move')!.z).toBeCloseTo(-m(3), 6);
  });

  it('gives a block standing on another no arrow of its own', () => {
    const { tool, b } = house();
    tool.selection = { building: b.id, volume: b.volumes[2]!.id, bay: null };
    expect(tool.handles().some((h) => h.kind === 'lift')).toBe(false);
  });
});
