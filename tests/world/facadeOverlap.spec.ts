import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { facadeBays, isMass } from '@world/buildings/geometry';
import type { Building } from '@world/buildings/types';
import type { ZoneUse } from '@world/zones';
import { growOnLot } from '@editor/zoning';
import { FOOTWAY_RISE, Level, halfWidth, roadType } from '@world/roadTypes';

/**
 * ONE WALL IS BUILT ONCE (docs/PLANO.md, 5e).
 *
 * A wing overlapping the main block shared its wall face with it: both built
 * a facade there, with their own bays, and every window got two panes in one
 * place - one lit, one dark - fighting in the depth buffer (the player's
 * striped windows, 2026-10-09). A face on another mass's surface, or inside
 * it, is not built (CityEngine's `inside`); of two blocks sharing one wall
 * face, the one of the lower id builds it.
 */

const flat = (): number => 0;
const hill = (_x: number, y: number): number => -y * 0.18;

function grow(groundAt: (x: number, y: number) => number, use: ZoneUse, seed: number): Building[] {
  const paved = (x: number, y: number): number =>
    Math.abs(y) <= halfWidth(roadType(1), Level.Sidewalk) && Math.abs(x) <= m(160) ? groundAt(x, 0) + FOOTWAY_RISE : NaN;
  const doc = new RoadDoc();
  const a = doc.addNode({ x: m(-160), y: 0 }).id, b = doc.addNode({ x: m(160), y: 0 }).id;
  doc.addSegment(a, b, 1);
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  zoneLots(doc, doc.lots.map((l) => l.id), { use, density: use === 'residential' ? 'low' : 'medium' });
  const refused = new Set<number>();
  for (let k = 0; k < doc.lots.length * 3; k++) {
    if (growOnLot({ doc, net, groundAt, pavedAt: paved }, refused, seed) === null && refused.size >= doc.lots.length) break;
  }
  return [...doc.buildings.all()] as Building[];
}

describe('facades: no wall built twice', () => {
  it('builds no two bays of different blocks on one wall plane, level and stretch', () => {
    let buildings = 0, multiBlock = 0;
    const twice: string[] = [];
    for (const [ground, use] of [[flat, 'residential'], [hill, 'residential'], [flat, 'commercial']] as const) {
      for (const seed of [0x5eed, 0xbeef, 0xc0de]) {
        for (const b of grow(ground, use, seed)) {
          buildings++;
          if (b.volumes.filter((v) => !v.open).length > 1) multiBlock++;
          // Walls only: an open lot (paving, a lawn) lists bays but builds no facade.
          const walls = new Set(b.volumes.filter((v) => !v.open && isMass(v)).map((v) => v.id));
          const bays = facadeBays(b).filter((bay) => walls.has(bay.volume));
          for (let i = 0; i < bays.length; i++) {
            const p = bays[i]!;
            for (let j = i + 1; j < bays.length; j++) {
              const q = bays[j]!;
              // Different blocks, overlapping in height (a split level's
              // storeys stand at their own heights: the level index alone
              // does not say they meet).
              if (p.volume === q.volume || p.z >= q.z + q.height - m(0.05) || q.z >= p.z + p.height - m(0.05)) continue;
              if (p.nx * q.nx + p.ny * q.ny < 0.999) continue;
              // The same wall plane.
              if (Math.abs((q.x - p.x) * p.nx + (q.y - p.y) * p.ny) > m(0.05)) continue;
              // Overlapping along it.
              const along = (q.x - p.x) * -p.ny + (q.y - p.y) * p.nx;
              if (Math.abs(along) < (p.width + q.width) / 2 - m(0.05)) {
                twice.push(`building ${b.id}: blocks ${p.volume} and ${q.volume}, level ${p.level}`);
              }
            }
          }
        }
      }
    }
    // Buildings of more than one block were grown, or nothing was tested.
    expect(buildings).toBeGreaterThan(20);
    expect(multiBlock).toBeGreaterThan(0);
    expect([...new Set(twice)]).toEqual([]);
  });
});
