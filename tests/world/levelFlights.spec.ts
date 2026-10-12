import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { floorHeight } from '@world/buildings/foundation';
import { levelHeight, localToWorld, volumeLift } from '@world/buildings/geometry';
import { cutOpen, interiorAt, levelFlights } from '@world/buildings/interior';
import type { Building } from '@world/buildings/types';
import { emitChunk } from '@render/buildings/buildingMesh';
import { growOnLot } from '@editor/zoning';
import { FOOTWAY_RISE, Level, halfWidth, roadType } from '@world/roadTypes';

/**
 * Inside a split-level house, cut open, a flight of stairs joins its levels:
 * in the lower block, square to the line the blocks meet at, from the lower
 * floor up to the higher (`interior.ts` `levelFlights`). Before, the step
 * between them showed only as the higher block's plinth - a wall of stone
 * in the middle of the house with no way up it (docs/ZONEAMENTO.md).
 */

const hill = (_x: number, y: number): number => -y * 0.18;
const paved = (x: number, y: number): number =>
  Math.abs(y) <= halfWidth(roadType(1), Level.Sidewalk) && Math.abs(x) <= m(160) ? hill(x, 0) + FOOTWAY_RISE : NaN;

describe('a flight of stairs between the half levels', () => {
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
  const split = ([...doc.buildings.all()] as Building[]).filter((h) => h.volumes.some((v) => !v.open && v.base === 0 && Math.abs(volumeLift(v)) > 1e-6 && Math.abs(volumeLift(v)) < levelHeight(h, 0) * 0.75));

  it('joins every half-level house\'s levels with a flight of easy steps, inside its lower block', () => {
    expect(split.length).toBeGreaterThan(3);
    let flights = 0;
    for (const h of split) {
      const found = levelFlights(h, 0);
      expect(found.length, `house ${h.id}`).toBeGreaterThan(0);
      for (const f of found) {
        flights++;
        const rise = f.z1 - f.z0;
        const run = Math.hypot(f.top.x - f.foot.x, f.top.y - f.foot.y);
        expect(rise / f.risers).toBeLessThanOrEqual(m(0.18) + 1e-9);
        expect(run / f.risers).toBeGreaterThanOrEqual(m(0.24) - 1e-9);
        expect(f.width).toBeGreaterThanOrEqual(m(0.8));
        // Its foot on a block's floor at its lower height, inside that block.
        const low = h.volumes.find((v) => !v.open && f.foot.x >= v.x - 1e-6 && f.foot.x <= v.x + v.w + 1e-6 && f.foot.y >= v.y - 1e-6 && f.foot.y <= v.y + v.d + 1e-6 && Math.abs(volumeLift(v) - f.z0) < 1e-6);
        expect(low, `house ${h.id}: the flight's foot in its lower block`).toBeDefined();
      }
    }
    console.log(`LANCES: ${flights} em ${split.length} casas em meio-nível`);
  });

  it('keeps the furniture off the flight', () => {
    let crossing = 0;
    for (const h of split) {
      for (const f of levelFlights(h, 0)) {
        const across = f.foot.y === f.top.y ? 'y' : 'x';
        const x0 = across === 'x' ? f.foot.x - f.width / 2 : Math.min(f.foot.x, f.top.x), x1 = across === 'x' ? f.foot.x + f.width / 2 : Math.max(f.foot.x, f.top.x);
        const y0 = across === 'y' ? f.foot.y - f.width / 2 : Math.min(f.foot.y, f.top.y), y1 = across === 'y' ? f.foot.y + f.width / 2 : Math.max(f.foot.y, f.top.y);
        for (const p of interiorAt(h, 0).furniture) {
          if (p.kind === 'ceilingLamp') continue;
          if (p.x + p.w / 2 > x0 && p.x - p.w / 2 < x1 && p.y + p.d / 2 > y0 && p.y - p.d / 2 < y1) crossing++;
        }
      }
    }
    // Before: 15 pieces (tables, desks, shelves) across 15 flights.
    expect(crossing).toBe(0);
  });

  it('draws the flight in the house cut open: its top step at the higher floor', () => {
    for (const h of split.slice(0, 6)) {
      const floor = floorHeight(h, hill, paved);
      const chunk = emitChunk(cutOpen(h, 0, { x: 0, y: 1 }), hill, paved);
      const stone = chunk.shells.stone!;
      for (const f of levelFlights(h, 0)) {
        // Over the last tread, the highest stone is the higher floor.
        const t = 1 - 0.5 / f.risers;
        const p = localToWorld(h, f.foot.x + (f.top.x - f.foot.x) * t, f.foot.y + (f.top.y - f.foot.y) * t);
        // A tread there at the higher floor's height, and one a riser lower at the tread before.
        const foot = localToWorld(h, f.foot.x, f.foot.y), head = localToWorld(h, f.top.x, f.top.y);
        const len = Math.hypot(head.x - foot.x, head.y - foot.y);
        const treadAt = (tt: number, z: number): boolean => {
          // A corner of a tread: along the flight within a tread of `tt`, across within its width.
          for (let i = 0; i < stone.position.length; i += 3) {
            const x = stone.position[i]!, zz = stone.position[i + 1]!, y = -stone.position[i + 2]!;
            const along = ((x - foot.x) * (head.x - foot.x) + (y - foot.y) * (head.y - foot.y)) / (len * len);
            const across = Math.abs((x - foot.x) * (head.y - foot.y) - (y - foot.y) * (head.x - foot.x)) / len;
            if (Math.abs(along - tt) <= 0.5 / f.risers + 1e-6 && across <= f.width / 2 + m(0.05) && Math.abs(zz - z) < 1e-3) return true;
          }
          return false;
        };
        void p;
        expect(treadAt(t, floor + f.z1), `house ${h.id}: the top step at the higher floor`).toBe(true);
        expect(treadAt(t - 1 / f.risers, floor + f.z1 - (f.z1 - f.z0) / f.risers), `house ${h.id}: the step below it`).toBe(true);
      }
    }
  });
});
