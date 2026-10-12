import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m, METERS_PER_UNIT } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { PLINTH_MIN, floorHeight, foundationOf } from '@world/buildings/foundation';
import {
  clashes, facadeBays, isSupported, levelHeight, localToWorld, volumeElevation, volumeHeight, volumeLift, worldToLocal,
} from '@world/buildings/geometry';
import { buildingPads } from '@world/buildings/pads';
import { cutOpen } from '@world/buildings/interior';
import { validateBuilding } from '@world/buildings/validate';
import { type Building, type Volume, volumeTop } from '@world/buildings/types';
import { emitChunk } from '@render/buildings/buildingMesh';
import { growOnLot } from '@editor/zoning';
import { FOOTWAY_RISE, Level, halfWidth, roadType } from '@world/roadTypes';

/**
 * Buildings follow their hillside as in real life (the player, 2026-10-09):
 * on a slope the back of a house stands a half storey (a split level) or a
 * whole storey (a lower ground floor on the garden) from its street floor,
 * each part on its own platform, instead of the whole building on one floor
 * with the land cut and filled under it (`world/buildings/splitLevel.ts`).
 */

const WINDOWS = new Set(['window', 'sashWindow', 'frenchWindow', 'bayWindow', 'ribbon', 'wideWindow', 'balcony', 'shopfront']);

/** The street along y = 0: its paving level with the ground on its line, as a road at grade is laid. */
const street = (ground: (x: number, y: number) => number) => (x: number, y: number): number =>
  Math.abs(y) <= halfWidth(roadType(1), Level.Sidewalk) && Math.abs(x) <= m(160) ? ground(x, 0) + FOOTWAY_RISE : NaN;

function grow(ground: (x: number, y: number) => number): { doc: RoadDoc; net: Network; houses: Building[] } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: m(-160), y: 0 }).id, b = doc.addNode({ x: m(160), y: 0 }).id;
  doc.addSegment(a, b, 1);
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  zoneLots(doc, doc.lots.map((l) => l.id), { use: 'residential', density: 'low' });
  const refused = new Set<number>();
  for (let k = 0; k < doc.lots.length * 3; k++) {
    if (growOnLot({ doc, net, groundAt: ground, pavedAt: street(ground) }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
  }
  return { doc, net, houses: [...doc.buildings.all()] as Building[] };
}

/** Mean |natural ground - platform| under a block, metres, for its floor lifted `lift`. */
function earth(b: Building, v: Volume, floor: number, ground: (x: number, y: number) => number, lift: number): number {
  let sum = 0, n = 0;
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
    const p = localToWorld(b, v.x + (v.w * i) / 4, v.y + (v.d * j) / 4);
    sum += Math.abs(ground(p.x, p.y) - (floor + lift - PLINTH_MIN));
    n++;
  }
  return (sum / n) * METERS_PER_UNIT;
}

describe('split-level buildings on a hillside', () => {
  // Rising to the north (-y) at 18 %, as the terraced yards were measured on.
  const hill = (_x: number, y: number): number => -y * 0.18;
  const paved = street(hill);
  const { doc, net, houses } = grow(hill);
  const stepped = houses.filter((h) => h.volumes.some((v) => volumeLift(v) !== 0));

  it('steps the back of most houses on an 18 % slope, up the hill and down it', () => {
    expect(houses.length).toBeGreaterThan(10);
    let up = 0, down = 0;
    for (const h of stepped) {
      const lifts = h.volumes.filter((v) => !v.open).map(volumeLift);
      if (Math.max(...lifts) > 0) up++;
      if (Math.min(...lifts) < 0) down++;
    }
    console.log(`MEIO-NÍVEL ${stepped.length}/${houses.length} (${up} acima, ${down} abaixo)`);
    expect(stepped.length / houses.length).toBeGreaterThan(0.4);
    expect(up).toBeGreaterThan(1);
    expect(down).toBeGreaterThan(1);
  });

  it('keeps every stepped house valid: no block in another, every block borne', () => {
    for (const h of stepped) {
      expect(validateBuilding({ doc, net, groundAt: hill }, h, h.id), `house ${h.id}`).toBeNull();
      // Among the built blocks (a lot may lie under a block: that is no clash).
      const built = new Set(h.volumes.filter((v) => !v.open).map((v) => v.id));
      expect(clashes(h).filter(([a, b]) => built.has(a) && built.has(b))).toEqual([]);
      for (const v of h.volumes) expect(isSupported(h, v)).toBe(true);
    }
  });

  it('steps by half storeys or whole ones, and less earth is moved under the back', () => {
    let before = 0, after = 0;
    for (const h of stepped) {
      const floor = floorHeight(h, hill, paved);
      const H = levelHeight(h, 0);
      for (const v of h.volumes) {
        if (v.open || v.base !== 0) continue;
        const lift = volumeLift(v);
        if (lift === 0) continue;
        const halves = Math.abs(lift) / (H / 2);
        expect(Math.abs(halves - Math.round(halves)), `lift ${lift} of house ${h.id}`).toBeLessThan(1e-6);
        before += earth(h, v, floor, hill, 0);
        after += earth(h, v, floor, hill, lift);
      }
    }
    console.log(`TERRA SOB OS FUNDOS: ${before.toFixed(1)} m -> ${after.toFixed(1)} m`);
    expect(after).toBeLessThan(before * 0.6);
  });

  it('opens no window into a block at another floor', () => {
    for (const h of stepped) {
      for (const bay of facadeBays(h)) {
        if (!WINDOWS.has(bay.component)) continue;
        // A point just outside the window, at its middle height, in the building's frame.
        const out = worldToLocal(h, { x: bay.x + bay.nx * m(0.3), y: bay.y + bay.ny * m(0.3) });
        const z = bay.z + bay.height / 2;
        for (const o of h.volumes) {
          if (o.open || o.id === bay.volume) continue;
          if (out.x <= o.x || out.x >= o.x + o.w || out.y <= o.y || out.y >= o.y + o.d) continue;
          const bottom = o.base === 0 ? -Infinity : volumeElevation(h, o, o.base);
          expect(z < bottom || z > volumeHeight(h, o), `house ${h.id}: window of block ${bay.volume} into block ${o.id}`).toBe(true);
        }
      }
    }
  });

  it('lays each block on its own platform, and its doors open from its own floor', () => {
    for (const h of stepped) {
      const floor = floorHeight(h, hill, paved);
      // The game's own apron: one and a half terrain cells (`render/renderer.ts`).
      const apron = 16 * 1.5;
      const pads = buildingPads([h], hill, paved, apron);
      const solid = h.volumes.filter((v) => !v.open && v.base === 0);
      const lowest = Math.min(...solid.map(volumeLift));
      for (const v of solid) {
        const c = localToWorld(h, v.x + v.w / 2, v.y + v.d / 2);
        const s = pads.shapeAt(c.x, c.y, hill(c.x, c.y));
        const graded = s.weight ? s.height : hill(c.x, c.y);
        // Never above the block's own platform: within a terrain cell of a
        // lower block, the lower one's excavation runs on under it (hidden
        // under its floor), so no bank of earth rises inside the lower room.
        expect(graded, `house ${h.id} block ${v.id}`).toBeLessThanOrEqual(floor + volumeLift(v) - PLINTH_MIN + 1e-6);
        // A pool's basin is cut deeper still round it (`pads.ts`).
        if (volumeLift(v) === lowest && !h.volumes.some((o) => o.open === 'water')) expect(graded, `house ${h.id} block ${v.id}`).toBeCloseTo(floor + lowest - PLINTH_MIN, 4);
      }
      const byId = new Map(h.volumes.map((v) => [v.id, v]));
      for (const x of foundationOf(h, hill, undefined, paved).entrances) expect(x.floor).toBeCloseTo(floor + volumeLift(byId.get(x.volume)!), 6);
    }
  });

  it('draws each block from its own floor, its roof at its own eaves', () => {
    for (const h of stepped.slice(0, 6)) {
      const chunk = emitChunk(h, hill, paved);
      let top = -Infinity;
      for (const part of Object.values(chunk.shells)) {
        for (let i = 1; i < part!.position.length; i += 3) {
          expect(Number.isFinite(part!.position[i]!)).toBe(true);
          top = Math.max(top, part!.position[i]!);
        }
      }
      const floor = floorHeight(h, hill, paved);
      const eaves = Math.max(...h.volumes.filter((v) => !v.open).map((v) => floor + volumeHeight(h, v)));
      expect(top).toBeGreaterThanOrEqual(eaves - 1e-3);
    }
  });

  it('cut open, shows each block\'s floor at its own height', () => {
    for (const h of stepped.slice(0, 6)) {
      const floor = floorHeight(h, hill, paved);
      const chunk = emitChunk(cutOpen(h, 0, { x: 0, y: 1 }), hill, paved);
      const heights = new Set<number>();
      for (const part of Object.values(chunk.shells)) for (let i = 1; i < part!.position.length; i += 3) heights.add(Math.round(part!.position[i]! * 100));
      for (const v of h.volumes) {
        if (v.open || v.base !== 0) continue;
        // The floor slab, 4 cm over the block's own floor (`emitInterior`).
        expect(heights.has(Math.round((floor + volumeLift(v) + 0.04) * 100)), `house ${h.id} block ${v.id}`).toBe(true);
      }
    }
  });

  it('keeps a lower ground floor under a back a whole storey down, the floor above it at the street floor', () => {
    const lower = stepped.filter((h) => h.volumes.some((v) => !v.open && volumeLift(v) < -levelHeight(h, 0) * 0.75));
    for (const h of lower) {
      for (const v of h.volumes) {
        if (v.open || volumeLift(v) >= -levelHeight(h, 0) * 0.75) continue;
        expect(volumeElevation(h, v, v.base + 1)).toBeCloseTo(0, 6);
        expect(volumeTop(v)).toBeGreaterThan(1);
      }
    }
  });
});

describe('a building on level ground', () => {
  it('is not stepped', () => {
    const { houses } = grow(() => 0);
    expect(houses.length).toBeGreaterThan(10);
    expect(houses.filter((h) => h.volumes.some((v) => volumeLift(v) !== 0)).length).toBe(0);
  });
});
