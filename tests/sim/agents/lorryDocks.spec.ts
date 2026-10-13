import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { worldToLocal } from '@world/buildings/geometry';
import type { BuildingId } from '@world/buildings/types';
import { growOnLot } from '@editor/zoning';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { vehiclePose } from '@sim/pose';
import { createAgentWalkEngine } from '@sim/agents/walk';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import { bodyClearExact } from '@sim/agents/hybridAStar';
import { lorryOf, yardOf } from '@sim/agents/lorryDocks';

/**
 * LORRIES TO THE DOCKS (coordinator's item B, 2026-10-11). A works' yard is
 * planned with hybrid-state A* (`sim/agents/lorryDocks.ts`): the lorry turns
 * no tighter than an SU-30 (9.7 m at the rear axle), shunts forward and back,
 * and backs onto the dock; a dock with no way takes no lorry.
 *
 * A lorry sent to a dock stops before the gate, swings in with the street
 * closed to the traffic both ways, backs onto the dock, unloads and leaves by
 * the same gate onto the lane: its body never on a solid cell of the yard
 * (walls, fences, posts, the car stalls) and never through another vehicle.
 */
function works(): RoadDoc {
  const doc = new RoadDoc();
  const n = 1, block = 120, ids: number[][] = [];
  for (let i = 0; i <= n; i++) { ids.push([]); for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: m(block) * (i - n / 2), y: m(block) * (j - n / 2) }).id); }
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      if (i < n) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, 1);
      if (j < n) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, 1);
    }
  }
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  doc.lots.forEach((l) => zoneLots(doc, [l.id], { use: 'industrial', density: 'medium' }));
  const refused = new Set<number>();
  for (let k = 0; k < doc.lots.length * 3; k++) {
    if (growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
  }
  return doc;
}

const LORRY = lorryOf(ARCHETYPES.find((a) => a.id === 'truck')!);

describe('lorries to the works docks', () => {

  it('backs a lorry onto a dock and takes it out again, through nothing', () => {
    const doc = works();
    const net = new Network(doc);
    net.rebuild();
    const w = new SimWorld(doc, net, 0x0be9);
    w.rebuildTopology();
    w.usePedestrianEngine(createAgentWalkEngine());
    w.driveModel = 'v2';
    w.trafficCount = 20;
    w.pedestrianCount = 10;
    w.ambient.enabled = true;
    w.ambient.source = 'edges';
    let target: { b: BuildingId; d: number } | null = null;
    for (const b of doc.buildings.all()) {
      if (target) break;
      const yard = yardOf(w, b, LORRY);
      if (!yard) continue;
      for (let i = 0; i < yard.docks.length && !target; i++) {
        while (!yard.planned(i)) yard.plan(i, 1e6);
        if (yard.docks[i]!.gate >= 0) target = { b: b.id, d: i };
      }
    }
    expect(target).not.toBeNull();
    for (let i = 0; i < Math.round(5 / DT); i++) step(w, { traffic: true, pedestrians: true });
    const lorries = w.city.lots.lorries;
    expect(lorries.sendNow(w, target!.b, target!.d)).toBe(true);
    const b = doc.buildings.get(target!.b)!;
    const yard = yardOf(w, b, LORRY)!;
    const dock = yard.docks[target!.d]!;
    const wrong: string[] = [];
    let atDoor = Infinity;
    let ticks = 0;
    for (let i = 0; i < Math.round(600 / DT) && lorries.left === 0; i++) {
      ticks = i;
      step(w, { traffic: true, pedestrians: true });
      const view = lorries.view()[0];
      if (!view || !Number.isFinite(view.x)) continue;
      // The rear axle in the yard's frame, the body tested cell by cell.
      const centre = worldToLocal(b, { x: view.x, y: view.y });
      const angle = view.angle - b.rotation;
      const ax = centre.x - Math.cos(angle) * LORRY.rear, ay = centre.y - Math.sin(angle) * LORRY.rear;
      if (!bodyClearExact(yard.solid, LORRY, ax, ay, angle)) wrong.push(`${(i * DT).toFixed(1)} s ${view.phase}: body on a solid cell`);
      if (view.phase === 'docked') atDoor = Math.min(atDoor, Math.hypot(ax - dock.docked.x, ay - dock.docked.y));
      // No vehicle of the traffic through it.
      const c = Math.cos(view.angle), s = Math.sin(view.angle);
      for (const v of w.vehicles.values()) {
        const p = vehiclePose(w, v, 1);
        if (!p) continue;
        const dx = p.p.x - view.x, dy = p.p.y - view.y;
        const along = Math.abs(dx * c + dy * s), across = Math.abs(-dx * s + dy * c);
        // Its centre inside the lorry's rectangle grown by half the other's width.
        if (along < LORRY.length / 2 + v.archetype.width / 2 - m(0.2) && across < LORRY.width / 2 + v.archetype.width / 2 - m(0.2)) {
          wrong.push(`${(i * DT).toFixed(1)} s ${view.phase}: ${v.archetype.id} ${v.id} through the lorry`);
        }
      }
    }
    console.log(`lorry: docked and left in ${(ticks * DT).toFixed(0)} s`);
    expect([...new Set(wrong)].slice(0, 10)).toEqual([]);
    expect(lorries.docked).toBe(1);
    expect(atDoor).toBeLessThan(m(0.05));
    expect(lorries.left).toBe(1);
  }, 900_000);
});
