import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { bayWidth, baysOn, levelHeight, localToWorld, volumeLift } from '@world/buildings/geometry';
import { floorHeight } from '@world/buildings/foundation';
import { lotSurfaces } from '@world/buildings/lots';
import { validateBuilding } from '@world/buildings/validate';
import { type Building, componentAt } from '@world/buildings/types';
import { growOnLot } from '@editor/zoning';
import { GARAGE_GRADE } from '@editor/lotPlan';
import { FOOTWAY_RISE, Level, halfWidth, roadType } from '@world/roadTypes';

/** A house on a lot falling away from its street, stepped a whole storey down at the back */

/** Ground rising to the north (-y) at 18 %: the lots south of the street fall away from it. */
const hill = (_x: number, y: number): number => -y * 0.18;
const paved = (x: number, y: number): number =>
  Math.abs(y) <= halfWidth(roadType(1), Level.Sidewalk) && Math.abs(x) <= m(160) ? hill(x, 0) + FOOTWAY_RISE : NaN;

function grow(): { doc: RoadDoc; net: Network; houses: Building[] } {
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
  return { doc, net, houses: [...doc.buildings.all()] as Building[] };
}

describe('a garage in the lower ground floor, on the downhill side', () => {
  const { doc, net, houses } = grow();
  const garaged = houses.filter((h) => h.volumes.some((v) => !v.open && volumeLift(v) < 0 && Object.values(v.storeys[0]?.facade.bays ?? {}).includes('garageDoor')));

  it('gives the houses a whole storey down with a drive a garage under their back', () => {
    const lowered = houses.filter((h) => h.volumes.some((v) => !v.open && Math.abs(volumeLift(v) + levelHeight(h, 0)) < 1e-6));
    console.log(`GARAGEM EMBAIXO: ${garaged.length} de ${lowered.length} casas com o fundo um andar abaixo (${houses.length} casas)`);
    expect(garaged.length).toBeGreaterThan(0);
    for (const h of garaged) expect(validateBuilding({ doc, net, groundAt: hill }, h, h.id), `house ${h.id}`).toBeNull();
  });

  it('sets the door in the lower floor, on the downhill face, a car wide', () => {
    for (const h of garaged) {
      const v = h.volumes.find((q) => !q.open && volumeLift(q) < 0 && Object.values(q.storeys[0]?.facade.bays ?? {}).includes('garageDoor'))!;
      expect(volumeLift(v)).toBeCloseTo(-levelHeight(h, 0), 6);
      const key = Object.entries(v.storeys[0]!.facade.bays!).find(([, c]) => c === 'garageDoor')![0];
      expect(key.startsWith('2:'), `house ${h.id}: the door on the back, downhill face`).toBe(true);
      expect(componentAt(v.storeys[0]!.facade, 2, Number(key.split(':')[1]))).toBe('garageDoor');
      expect(bayWidth(h, v, 2)).toBeGreaterThanOrEqual(m(2.6) - 1e-6);
      expect(baysOn(h, v, 2)).toBeGreaterThan(0);
    }
  });

  it('runs the drive down to it as a ramp no steeper than 1 in 4, ending in an apron at the door', () => {
    for (const h of garaged) {
      const v = h.volumes.find((q) => !q.open && volumeLift(q) < 0 && Object.values(q.storeys[0]?.facade.bays ?? {}).includes('garageDoor'))!;
      const lift = volumeLift(v);
      const ramp = h.volumes.find((q) => q.open && q.ramp !== undefined);
      expect(ramp, `house ${h.id} has its drive's ramp`).toBeDefined();
      expect(ramp!.ramp).toBeCloseTo(0, 6);
      expect(ramp!.terrace).toBeCloseTo(lift, 6);
      expect(Math.abs(lift) / ramp!.d).toBeLessThanOrEqual(GARAGE_GRADE + 1e-6);
      // The apron: paved at the lower floor's level, against the back face, in front of the door.
      const key = Object.entries(v.storeys[0]!.facade.bays!).find(([, c]) => c === 'garageDoor')![0];
      const doorX = v.x + (Number(key.split(':')[1]) + 0.5) * bayWidth(h, v, 2);
      const apron = h.volumes.find((q) => q.open === 'concrete' && q.ramp === undefined && Math.abs((q.terrace ?? 0) - lift) < 1e-6 &&
        doorX > q.x && doorX < q.x + q.w && q.y <= v.y + v.d + m(0.05) && q.y + q.d >= v.y + v.d + m(4));
      expect(apron, `house ${h.id}: an apron before its garage door`).toBeDefined();
      // The ramp meets the apron: its foot on it, over its width.
      const foot = ramp!.y + ramp!.d;
      expect(foot).toBeGreaterThanOrEqual(apron!.y - m(0.2));
      expect(foot).toBeLessThanOrEqual(apron!.y + apron!.d);
      expect(ramp!.x).toBeGreaterThanOrEqual(apron!.x - 1e-6);
      expect(ramp!.x + ramp!.w).toBeLessThanOrEqual(apron!.x + apron!.w + 1e-6);
    }
  });

  it('walls the ramp on its outer side wherever it runs in a cut or on a fill', () => {
    let walled = 0, off = 0;
    for (const h of garaged) {
      const floor = floorHeight(h, hill, paved);
      const ramp = h.volumes.find((q) => q.open && q.ramp !== undefined)!;
      const surface = lotSurfaces(h, floor, paved).find((s) => s.volume.id === ramp.id)!;
      const walls = (h.elements ?? []).filter((e) => e.kind === 'slab' && e.material?.finish === 'stone' && e.facing === 1 &&
        e.x > ramp.x - m(0.1) && e.x < ramp.x + ramp.w + m(0.1));
      for (let t = 0.1; t < 0.95; t += 0.2) {
        const y = ramp.y + ramp.d * t;
        // The outer side: the lot's edge the drive runs along.
        const x = ramp.x < 0 ? ramp.x + m(0.35) : ramp.x + ramp.w - m(0.35);
        const p = localToWorld(h, x, y);
        if (Math.abs(surface.heightAt(p.x, p.y) - hill(p.x, p.y)) < m(0.5)) continue;
        off++;
        if (walls.some((e) => Math.abs(e.y - y) <= e.w / 2 + m(0.05))) walled++;
      }
    }
    console.log(`RAMPA: ${walled} de ${off} trechos fora do chão com muro de arrimo`);
    expect(off).toBeGreaterThan(0);
    expect(walled).toBe(off);
  });
});
