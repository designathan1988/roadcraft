import { describe, expect, it } from 'vitest';

import { layCity } from '@editor/cityGenerator';
import { growOnLot } from '@world/growth/zoning';
import type { GroundSince, Rect } from '@world/buildings/cameraSolids';
import { buildingFloors } from '@world/buildings/floors';
import { FLOOR_READ_REACH, floorHeight } from '@world/buildings/foundation';
import { storedBounds } from '@world/buildings/geometry';
import { padOf } from '@world/buildings/pads';
import type { Building } from '@world/buildings/types';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import { buildRoadElevation } from '@world/elevation';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { Network } from '@world/network';
import { m } from '@world/units';

/** EACH BUILDING'S FLOOR WORKED OUT ONCE (`floors.ts`) */
const base = (x: number, y: number): number => m(6) * Math.sin(x / m(170)) + m(4) * Math.cos(y / m(130)) + x * 0.01;

describe('the floors kept for every reader', () => {
  const doc = layCity(planCity({ ...DEFAULT_CITY, seed: 2, size: 'small' }));
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  doc.lots.forEach((l, k) => zoneLots(doc, [l.id], { use: (['residential', 'commercial', 'industrial'] as const)[k % 3]!, density: 'medium' }));
  const refused = new Set<number>();
  for (let k = 0; k < 1500; k++) if (growOnLot({ doc, net, groundAt: base }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
  net.rebuild();
  const elevation = buildRoadElevation(net, base);
  const pavedAt = (x: number, y: number): number => {
    const road = elevation.roadAt(x, y);
    return road.type >= 0 && Math.abs(road.across) <= road.half ? elevation.at(x, y) : NaN;
  };
  /** The ground the floors read, swapped below; every read counted. */
  let land = base;
  let reads = 0;
  const groundAt = (x: number, y: number): number => { reads++; return land(x, y); };
  const box = (b: Building): Rect => {
    const r = storedBounds(b, FLOOR_READ_REACH);
    return [r.minX, r.minY, r.maxX, r.maxY];
  };
  const town = [...doc.buildings.all()];
  const floors = buildingFloors(groundAt, pavedAt, box, FLOOR_READ_REACH);
  const same = (): void => {
    for (const b of town) {
      const fresh = floorHeight(b, land, pavedAt);
      if (!Object.is(floors.floorOf(b), fresh)) expect.fail(`building ${b.id}: ${floors.floorOf(b)} against ${fresh}`);
    }
  };

  it('gives every reader the floor worked out, each once', () => {
    expect(town.length).toBeGreaterThan(150);
    const diary: GroundSince = { version: 0, rectsSince: () => [] };
    floors.follow(doc.buildings, diary);
    same();
    reads = 0;
    for (const b of town) floors.floorOf(b);
    expect(reads).toBe(0);
    // A platform made with the kept floor is the platform made without it.
    for (const b of town.slice(0, 60)) {
      expect(padOf(b, land, pavedAt, m(9.6), (r) => floors.floorOf(r))).toEqual(padOf(b, land, pavedAt, m(9.6)));
    }
  });

  it('works out again only the floors a change of the ground reaches, to the same numbers', () => {
    const b0 = town[Math.floor(town.length / 2)]!;
    const r0 = storedBounds(b0, 0);
    const rect: Rect = [r0.minX - m(10), r0.minY - m(10), r0.maxX + m(10), r0.maxY + m(10)];
    land = (x, y) => base(x, y) + (x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3] ? m(1.5) : 0);
    floors.follow(doc.buildings, { version: 1, rectsSince: (since) => (since === 0 ? [rect] : []) });
    reads = 0;
    same();
    const again = reads;
    reads = 0;
    for (const b of town) floorHeight(b, groundAt, pavedAt);
    // `same` read the fresh floors itself (on `land`, uncounted) and the kept ones: only those the change reached.
    expect(again).toBeGreaterThan(0);
    expect(again * 10).toBeLessThan(reads);
  });
});
