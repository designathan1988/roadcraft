import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { streetDoors } from '@world/buildings/streetDoors';
import type { Building } from '@world/buildings/types';
import { growOnLot } from '@editor/zoning';
import { FOOTWAY_RISE, Level, halfWidth, roadType } from '@world/roadTypes';

/**
 * A shop built up to the footway (no front garden, no forecourt: the lot's
 * front is the street) has no people's gate - its front door IS the way in.
 * `streetDoors` gives that door, on the facade, opening onto the footway, so
 * the people's way to the lot (`sim/agents/lotDoors.ts`) can start there
 * (docs/source/ZONEAMENTO.md: "a porta dele não é usada pelas pessoas").
 */

const flat = (): number => 0;
const paved = (x: number, y: number): number =>
  Math.abs(y) <= halfWidth(roadType(1), Level.Sidewalk) && Math.abs(x) <= m(160) ? FOOTWAY_RISE : NaN;

describe('a shop on the footway opens its door onto the street', () => {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: m(-160), y: 0 }).id, b = doc.addNode({ x: m(160), y: 0 }).id;
  doc.addSegment(a, b, 1);
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  zoneLots(doc, doc.lots.map((l) => l.id), { use: 'commercial', density: 'low' });
  const refused = new Set<number>();
  for (let k = 0; k < doc.lots.length * 3; k++) {
    if (growOnLot({ doc, net, groundAt: flat, pavedAt: paved }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
  }
  const all = [...doc.buildings.all()] as Building[];
  /** A people's gate: a gate narrower than a car's (2.2 m, `sim/agents/parking.ts` CAR_GATE). */
  const gated = (h: Building): boolean => (h.elements ?? []).some((e) => e.kind === 'gate' && e.w < m(2.2));
  const onFootway = all.filter((h) => !gated(h));

  it('finds the shops with no people\'s gate, and gives each its door on the footway', () => {
    console.log(`LOJAS NA CALÇADA: ${onFootway.length} de ${all.length} sem portão de pedestre`);
    expect(onFootway.length).toBeGreaterThan(2);
    for (const h of onFootway) {
      const doors = streetDoors(h);
      expect(doors.length, `shop ${h.id} has its door onto the street`).toBeGreaterThan(0);
      for (const d of doors) {
        // A step out of it is on the footway.
        expect(Number.isFinite(paved(d.x + d.nx * m(0.6), d.y + d.ny * m(0.6))), `shop ${h.id}: the door opens on the footway`).toBe(true);
        expect(d.width).toBeGreaterThan(m(0.8));
      }
    }
  });

  it('gives no street door to a building behind a garden or a forecourt: its gate is the way in', () => {
    for (const h of all.filter(gated)) expect(streetDoors(h), `building ${h.id}`).toEqual([]);
  });
});
