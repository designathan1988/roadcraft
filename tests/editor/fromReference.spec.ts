import { describe, expect, it } from 'vitest';
import { type Triangle, blocksFromTriangles, buildFromReference } from '@editor/fromReference';
import { validateBuilding } from '@world/buildings/validate';
import { RoadDoc } from '@world/doc';
import { type Building, componentAt } from '@world/buildings/types';

/** A closed box's twelve triangles, metres, z up. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Triangle[] {
  const p = (x: number, y: number, z: number) => [x, y, z] as const;
  const quad = (a: readonly [number, number, number], b: typeof a, c: typeof a, d: typeof a): Triangle[] => [[a, b, c], [a, c, d]];
  return [
    ...quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)),
    ...quad(p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), p(x1, y0, z0)),
    ...quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)),
    ...quad(p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1)),
    ...quad(p(x1, y1, z0), p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1)),
    ...quad(p(x0, y1, z0), p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1)),
  ];
}

// A podium 30 x 20 m, 9.1 m tall; a tower 12 x 12 m on it to 41.8 m; a mast 1 m wide to 55 m.
const model = [...box(-15, -10, 0, 15, 10, 9.1), ...box(-6, -6, 9.1, 6, 6, 41.8), ...box(-0.5, -0.5, 41.8, 0.5, 0.5, 55)];

describe('build from reference', () => {
  it('reads the blocks from the upward faces, each on the one below', () => {
    const blocks = blocksFromTriangles(model);
    const big = blocks.filter((b) => b.x1 - b.x0 >= 2);
    expect(big.map((b) => [b.z0, b.z1])).toEqual([[0, 9.1], [9.1, 41.8]]);
  });

  it('builds a valid building: podium, tower on it, lantern for the mast, windows where the model is dark', () => {
    // Dark on the podium's front ground floor (a portal), dark bands on the tower, light elsewhere.
    const body = buildFromReference(model, (x, _y, z, nx, ny) => {
      if (nx === 0 && ny === 0) return [0.6, 0.3, 0.25];
      if (z < 4.5 && ny < 0 && Math.abs(x) < 3) return [0.05, 0.05, 0.05];
      if (z > 9.1 && (z % 3.3) > 1.2 && (z % 3.3) < 2.6) return [0.1, 0.12, 0.15];
      return [0.85, 0.82, 0.76];
    })!;
    expect(body).not.toBeNull();
    const [podium, tower] = body.volumes;
    expect(podium!.base).toBe(0);
    expect(tower!.base).toBe(podium!.base + podium!.storeys.length);
    expect(tower!.roofDetails?.[0]?.kind).toBe('lantern');
    expect(tower!.materials?.roof?.colour).toBe(0x994d40);
    const b = { ...body, id: 1, x: 0, y: 0, rotation: 0 } as Building;
    expect(validateBuilding({ doc: new RoadDoc(), net: null, groundAt: null }, b)).toBeNull();
    // The portal: some bays of the podium's front ground floor read as doors.
    const ground = podium!.storeys[0]!.facade;
    expect(Array.from({ length: 10 }, (_, i) => componentAt(ground, 0, i))).toContain('doubleDoor');
    // The tower has windows and plain wall both.
    const comps = new Set(tower!.storeys.flatMap((s) => Object.values(s.facade.bays ?? {})));
    expect(comps.has('wall')).toBe(true);
    expect([...comps].some((c) => c !== 'wall')).toBe(true);
  });

  it('builds nothing from a model without rooms', () => {
    expect(buildFromReference(box(0, 0, 0, 1, 1, 1), () => null)).toBeNull();
  });
});
