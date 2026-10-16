import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { worldToLocal } from '@world/buildings/geometry';
import type { Building } from '@world/buildings/types';
import { pointInPolygon } from '@core/polygon';
import { growOnLot } from '@world/growth/zoning';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { createAgentWalkEngine } from '@sim/agents/walk';
import { collectBays } from '@sim/agents/parking';
import type { Vehicle } from '@sim/vehicles/state';

/** A CAR PARKED IN A LOT STANDS IN THE LOT */
const ZONES = [
  { use: 'commercial', density: 'low' }, { use: 'industrial', density: 'medium' }, { use: 'residential', density: 'high' },
  { use: 'commercial', density: 'high' }, { use: 'residential', density: 'medium' },
] as const;
const SOLID = new Set([
  'wall', 'fence', 'hedge', 'railing', 'gate', 'pillar', 'stair', 'ramp', 'tree', 'bench', 'planter', 'rocks',
  'clock', 'shrub', 'bin', 'lamp', 'bollard',
]);

function town(): RoadDoc {
  const doc = new RoadDoc();
  const n = 2, block = 120, ids: number[][] = [];
  for (let i = 0; i <= n; i++) {
    ids.push([]);
    for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: m(block) * (i - n / 2), y: m(block) * (j - n / 2) }).id);
  }
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      if (i < n) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, 1);
      if (j < n) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, 1);
    }
  }
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  doc.lots.forEach((l, k) => zoneLots(doc, [l.id], ZONES[k % ZONES.length]!));
  const refused = new Set<number>();
  for (let k = 0; k < doc.lots.length * 3; k++) {
    if (growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
  }
  return doc;
}

/** The solid part of the building a local point lies in (its box, shrunk by 1 mm: touching is not crossing), if any. */
function partAt(b: Building, p: { x: number; y: number }): string | null {
  for (const el of b.elements ?? []) {
    if (!SOLID.has(el.kind) || el.z >= m(2.1)) continue;
    const alongY = el.facing === 0 || el.facing === 2;
    const hx = (alongY ? el.w : el.d) / 2 - m(0.001), hy = (alongY ? el.d : el.w) / 2 - m(0.001);
    const c = Math.cos(-(el.angle ?? 0)), s = Math.sin(-(el.angle ?? 0));
    const dx = p.x - el.x, dy = p.y - el.y;
    const lx = dx * c - dy * s, ly = dx * s + dy * c;
    if (Math.abs(lx) < hx && Math.abs(ly) < hy) return el.kind;
  }
  return null;
}

describe('a car parked in a lot', () => {
  it('stands inside the lot and in none of its solid parts', () => {
    const doc = town();
    const net = new Network(doc);
    net.rebuild();
    const w = new SimWorld(doc, net, 0x0be9);
    w.rebuildTopology();
    w.usePedestrianEngine(createAgentWalkEngine());
    w.driveModel = 'v2';
    w.trafficCount = 40;
    w.pedestrianCount = 20;
    w.ambient.enabled = true;
    w.ambient.source = 'edges';
    for (let i = 0; i < Math.round(10 / DT); i++) step(w, { traffic: true, pedestrians: true });

    const stalls = collectBays(w).filter((bay) => !bay.kerb);
    let checked = 0;
    const wrong: string[] = [];
    for (const car of w.ambient.parked) {
      const f = car.free;
      // The scenery's rows stand; a vehicle of the lots' may be moving.
      if (!f || f.lot === null || ((car as Partial<Vehicle>).v ?? 0) > 0) continue;
      if (!stalls.some((bay) => Math.hypot(bay.x - f.x, bay.y - f.y) < m(0.05))) continue;
      const b = doc.buildings.get(f.lot as Building['id']);
      const lot = doc.lots.find((l) => l.building === f.lot);
      if (!b || !lot) continue;
      checked++;
      const c = Math.cos(f.angle), s = Math.sin(f.angle);
      const L = car.archetype.length / 2, W = car.archetype.width / 2;
      // The body's footprint, every 10 cm.
      const nx = Math.ceil((2 * L) / m(0.1)), ny = Math.ceil((2 * W) / m(0.1));
      for (let i = 0; i <= nx; i++) {
        for (let j = 0; j <= ny; j++) {
          const a = -L + (2 * L * i) / nx, k = -W + (2 * W * j) / ny;
          const p = { x: f.x + c * a - s * k, y: f.y + s * a + c * k };
          if (!pointInPolygon(p, lot.corners)) wrong.push(`${car.archetype.id} ${car.id} out of lot ${lot.id}`);
          const part = partAt(b, worldToLocal(b, p));
          if (part) wrong.push(`${car.archetype.id} ${car.id} through a ${part} of ${b.id}`);
        }
      }
    }
    console.log(`parkedInLot: ${checked} parked cars checked`);
    expect(checked).toBeGreaterThan(10);
    expect([...new Set(wrong)]).toEqual([]);
  });
});
