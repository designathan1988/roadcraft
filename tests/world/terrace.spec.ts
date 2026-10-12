import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m, METERS_PER_UNIT } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { lotSurfaces } from '@world/buildings/lots';
import { floorHeight } from '@world/buildings/foundation';
import { localToWorld } from '@world/buildings/geometry';
import { validateBuilding } from '@world/buildings/validate';
import type { Building } from '@world/buildings/types';
import { growOnLot } from '@editor/zoning';
import { FOOTWAY_RISE, Level, halfWidth, roadType } from '@world/roadTypes';

/**
 * Houses on a hillside follow the land (the player, 2026-10-09: "buildings
 * must follow the shape of the terrain as in real life"): the back garden is
 * a terrace of its own near the natural ground, up or down the slope, held
 * by a retaining wall with a flight of steps - not the whole yard cut down
 * or filled up to the floor.
 */

/** Ground rising to the north (-y) at 18 %: 6 m over a 32 m lot. */
const hill = (_x: number, y: number): number => -y * 0.18;
/** The street along y = 0, its paving level with the ground on its line: the floor the houses take. */
const paved = (x: number, y: number): number =>
  Math.abs(y) <= halfWidth(roadType(1), Level.Sidewalk) && Math.abs(x) <= m(160) ? hill(x, 0) + FOOTWAY_RISE : NaN;

describe('terraced yards on a hillside', () => {
  it('lays each back garden near its natural ground, with a retaining wall and steps', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: m(-160), y: 0 }).id, b = doc.addNode({ x: m(160), y: 0 }).id;
    doc.addSegment(a, b, 1);
    const net = new Network(doc);
    net.rebuild();
    applyLots(doc, planLots(doc, net));
    zoneLots(doc, doc.lots.map((l) => l.id), { use: 'residential', density: 'low' });
    const refused = new Set<number>();
    for (let k = 0; k < doc.lots.length * 3; k++) {
      if (growOnLot({ doc, net, groundAt: hill, pavedAt: paved }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
    }
    const houses = [...doc.buildings.all()] as Building[];
    expect(houses.length).toBeGreaterThan(10);
    let terraced = 0, up = 0, down = 0;
    let cutBefore = 0, cutAfter = 0;
    for (const h of houses) {
      expect(validateBuilding({ doc, net, groundAt: hill }, h, h.id)).toBeNull();
      const yard = h.volumes.filter((v) => v.open && v.terrace !== undefined);
      if (!yard.length) continue;
      terraced++;
      if (yard[0]!.terrace! > 0) up++; else down++;
      const els = h.elements ?? [];
      expect(els.some((e) => e.kind === 'stair'), `house ${h.id} has steps`).toBe(true);
      expect(els.some((e) => e.kind === 'slab' && e.material?.finish === 'stone'), `house ${h.id} has its retaining wall`).toBe(true);
      // Earth moved at the garden's middle: to the floor before, to the terrace now.
      const floor = floorHeight(h, hill, paved);
      for (const s of lotSurfaces(h, floor, paved)) {
        if (s.volume.terrace === undefined) continue;
        const c = localToWorld(h, s.volume.x + s.volume.w / 2, s.volume.y + s.volume.d / 2);
        cutBefore += Math.abs(hill(c.x, c.y) - floor);
        cutAfter += Math.abs(hill(c.x, c.y) - s.heightAt(c.x, c.y));
      }
    }
    // Both sides of the street: gardens up the hill and down it.
    expect(up).toBeGreaterThan(2);
    expect(down).toBeGreaterThan(2);
    expect(terraced / houses.length).toBeGreaterThan(0.5);
    console.log(`TERRAÇOS ${terraced}/${houses.length} (${up} acima, ${down} abaixo); corte e aterro no meio do jardim ${(cutBefore * METERS_PER_UNIT).toFixed(1)} m -> ${(cutAfter * METERS_PER_UNIT).toFixed(1)} m`);
    expect(cutAfter).toBeLessThan(cutBefore * 0.5);
  }, 120_000);
});
