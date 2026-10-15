import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildRoadElevation } from '@world/elevation';
import { m, METERS_PER_UNIT } from '@world/units';
import { applyLots, lotBuildFrame, planLots, zoneLots } from '@world/lots';
import { MAX_PLINTH, floorHeight } from '@world/buildings/foundation';
import { localToWorld } from '@world/buildings/geometry';
import { validateBuilding } from '@world/buildings/validate';
import { type Building, type Volume, asBuildingId } from '@world/buildings/types';
import { generateBody } from '@world/buildings/blueprints';
import { growOnLot } from '@editor/zoning';
import { FOOTWAY_RISE, Level, halfWidth, roadType } from '@world/roadTypes';
import type { ZoneDensity, ZoneUse } from '@world/zones';

/** A building up a hillside street opens onto its footway at the footway's level, its site cut into the hill behind */

/** Ground rising to the north (-y), `grade` a metre. */
const rising = (grade: number) => (_x: number, y: number): number => -y * grade;

function grow(use: ZoneUse, density: ZoneDensity, grade: number) {
  const hill = rising(grade);
  const doc = new RoadDoc();
  const a = doc.addNode({ x: m(-160), y: 0 }).id, b = doc.addNode({ x: m(160), y: 0 }).id;
  doc.addSegment(a, b, 1);
  const net = new Network(doc);
  net.rebuild();
  const elevation = buildRoadElevation(net, hill);
  // The ground as the game shapes it beside a road.
  const ground = (x: number, y: number): number => {
    const g = hill(x, y);
    const s = elevation.shapeAt(x, y, g);
    return g + (s.height - g) * s.weight;
  };
  const rt = roadType(1);
  const paved = (x: number, y: number): number => {
    const across = Math.abs(y);
    if (across > halfWidth(rt, Level.Sidewalk) || Math.abs(x) > m(160)) return NaN;
    return elevation.at(x, 0) + (across > halfWidth(rt, Level.Curb) ? FOOTWAY_RISE : 0);
  };
  applyLots(doc, planLots(doc, net));
  zoneLots(doc, doc.lots.map((l) => l.id), { use, density });
  const refused = new Set<number>();
  for (let k = 0; k < doc.lots.length * 3; k++) {
    if (growOnLot({ doc, net, groundAt: ground, pavedAt: paved }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
  }
  return { doc, net, ground, paved };
}

describe('a building up a hillside street stands at its footway', () => {
  // At 28 % a building on one floor is still refused at the footway and grown set back and smaller (`growOnLot`'s tries)
  const CASES: [string, ZoneUse, ZoneDensity, number][] = [
    ['shops', 'commercial', 'low', 0.18], ['flats', 'residential', 'medium', 0.18], ['shops, steeper', 'commercial', 'low', 0.28],
  ];
  for (const [name, use, density, grade] of CASES) {
    it(`${name} (${Math.round(grade * 100)} %): the ground floor at the footway in front, up the hill and down it; the lot out to the footway`, () => {
      const { doc, ground, paved } = grow(use, density, grade);
      const rows: string[] = [];
      let up = 0, worst = 0, setBack = 0;
      const wrong: string[] = [];
      for (const l of doc.lots) {
        if (l.building === undefined) continue;
        const b = doc.buildings.get(l.building as Parameters<typeof doc.buildings.get>[0]) as Building | undefined;
        if (!b) continue;
        const frame = lotBuildFrame(l);
        // The footway in front of the lot's front middle.
        const n = { x: -Math.sin(frame.rotation), y: Math.cos(frame.rotation) };
        let foot = NaN;
        for (let d = 0; d <= m(3) && !Number.isFinite(foot); d += m(0.1)) foot = paved(frame.anchor.x - n.x * d, frame.anchor.y - n.y * d);
        expect(Number.isFinite(foot), `footway before building ${b.id}`).toBe(true);
        const over = (floorHeight(b, ground, paved) - foot) * METERS_PER_UNIT;
        const uphill = frame.anchor.y < 0;
        if (uphill) { up++; worst = Math.max(worst, over); }
        // Its lot reaches the footway: the plan's front (a surface, or the building itself) at the lot's front.
        const front = Math.min(...b.volumes.filter((v) => v.base === 0).map((v: Volume) => {
          const p = localToWorld(b, v.x + v.w / 2, v.y);
          return (p.x - frame.anchor.x) * n.x + (p.y - frame.anchor.y) * n.y;
        }));
        // How far the plan was set back from the lot's front (a try's margin).
        const margin = ((b.x - frame.anchor.x) * n.x + (b.y - frame.anchor.y) * n.y) * METERS_PER_UNIT;
        if (margin > 0.1) setBack++;
        rows.push(`${b.id} ${b.function} ${uphill ? 'uphill' : 'downhill'}: floor ${over.toFixed(2)} m over the footway, lot front at ${(front * METERS_PER_UNIT).toFixed(1)} m, plan set back ${margin.toFixed(1)} m`);
        // Before: up to 5.6 m over it (in the game, 12 shops of 14 up the street over 30 cm).
        if (!(over >= 0 && over < 0.2) || !(front * METERS_PER_UNIT < 0.1)) wrong.push(rows[rows.length - 1]!);
      }
      console.log(`${name.toUpperCase()}: ${up} uphill, floor at most ${worst.toFixed(2)} m over the footway, ${setBack} with the plan set back\n${rows.join('\n')}`);
      expect(wrong, 'floor at the footway, lot out to it').toEqual([]);
      expect(up).toBeGreaterThan(8);
      // The steeper street grows its shops set back (measured 2026-10-11: 28 of 30), each carried out to its footway.
      if (grade > 0.25) expect(setBack).toBeGreaterThan(10);
    });
  }

  it('measures the slope under a split level from the floor of each block', () => {
    const doc = new RoadDoc();
    // Two blocks of 15 m, one behind the other, on ground rising 22 % back from the front
    const body = generateBody('commercial', m(12), m(30), 2);
    const whole = body.volumes[0]!;
    const front: Volume = { ...structuredClone(whole), id: 1, d: m(15) };
    const back: Volume = { ...structuredClone(whole), id: 2, y: m(15), d: m(15) };
    const b = { ...body, volumes: [front, back], id: asBuildingId(1), x: 0, y: 0, rotation: 0 } as Building;
    const steep = (_x: number, y: number): number => y * 0.22;
    expect(m(30) * 0.22).toBeGreaterThan(MAX_PLINTH);
    expect(validateBuilding({ doc, net: null, groundAt: steep }, b)).toBe('slope');
    // Its back block a storey up the hill: each block on its own ground, 3.3 m across each.
    back.lift = m(3.3);
    expect(validateBuilding({ doc, net: null, groundAt: steep }, b)).toBeNull();
    // Both blocks a storey up together: the same slope under each as on one floor.
    front.lift = m(3.3);
    expect(validateBuilding({ doc, net: null, groundAt: steep }, b)).toBe('slope');
  });
});
