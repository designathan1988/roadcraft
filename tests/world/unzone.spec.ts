import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { growOnLot } from '@editor/zoning';
import { FOOTWAY_RISE, Level, halfWidth, roadType } from '@world/roadTypes';
import type { BuildingId } from '@world/buildings/types';

/** Taking a lot's zone off takes what grew on it (the player, 2026-10-09). */
describe('taking the zone off', () => {
  it('removes the building that grew on the lot', () => {
    const groundAt = (): number => 0;
    const paved = (x: number, y: number): number =>
      Math.abs(y) <= halfWidth(roadType(1), Level.Sidewalk) && Math.abs(x) <= m(160) ? FOOTWAY_RISE : NaN;
    const doc = new RoadDoc();
    const a = doc.addNode({ x: m(-160), y: 0 }).id, b = doc.addNode({ x: m(160), y: 0 }).id;
    doc.addSegment(a, b, 1);
    const net = new Network(doc);
    net.rebuild();
    applyLots(doc, planLots(doc, net));
    zoneLots(doc, doc.lots.map((l) => l.id), { use: 'residential', density: 'low' });
    growOnLot({ doc, net, groundAt, pavedAt: paved }, new Set(), 0x5eed);
    const built = doc.lots.find((l) => l.building !== undefined)!;
    expect(built).toBeDefined();
    const id = built.building as BuildingId;
    expect(doc.buildings.has(id)).toBe(true);
    expect(zoneLots(doc, [built.id], null)).toBe(true);
    expect(doc.buildings.has(id)).toBe(false);
    const after = doc.lots.find((l) => l.id === built.id)!;
    expect(after.use).toBeUndefined();
    expect(after.building).toBeUndefined();
  });
});
