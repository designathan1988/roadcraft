import { describe, expect, it } from 'vitest';
import { PLATE_SIZE, plateOf } from '@world/bounds';
import { farExtent, farNodesFor } from '@render/farGround';
import { WOODS_MOST } from '@render/flatAtlas';

/** THE FAR GROUND CHOSEN BY THE VIEW'S DISTANCE (`farGround.ts`, CDLOD): what is resident does not grow with the map */

const QUADS = 32;
/** The map's plate ring for a map `km` wide (as `flatAtlas.ts` FAR_RING from `wholeMap.ts` MAP_HALF). */
const ringOf = (km: number): number => Math.round((km * 512) / PLATE_SIZE - 0.5);
/** The nodes asked from a grid of places over the whole map. */
function over(km: number, each: (nodes: ReturnType<typeof farNodesFor>, x: number, y: number) => void): void {
  const ring = ringOf(km), e = farExtent(ring);
  for (let x = -e; x <= e; x += e / 8) for (let y = -e; y <= e; y += e / 8) each(farNodesFor(x, y, ring, QUADS), x, y);
}

describe('the far ground by distance', () => {
  it('keeps a 10 km map\'s every plate a plate\'s patch, wherever the view stands (the ground seen as before)', () => {
    over(10, (nodes) => {
      const plates = nodes.filter((n) => n.k === 0).map((n) => n.plate).sort((a, b) => a! - b!);
      expect(plates.length).toBe(25);
      expect(new Set(plates).size).toBe(25);
    });
    // The plates by their own keys, those of the 5 x 5 round the origin's.
    const keys = new Set(farNodesFor(0, 0, 2, QUADS).map((n) => n.plate));
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) expect(keys.has(plateOf(i * PLATE_SIZE, j * PLATE_SIZE))).toBe(true);
  });

  it('holds what the view asks, not the map: the nodes grow with the map\'s levels, never its area', () => {
    const most = (km: number): { nodes: number; plates: number } => {
      let nodes = 0, plates = 0;
      over(km, (n) => { nodes = Math.max(nodes, n.length); plates = Math.max(plates, n.filter((x) => x.k === 0).length); });
      return { nodes, plates };
    };
    const small = most(20), large = most(50), huge = most(200);
    // Every plate resident would be 121, 625 and 10,201.
    expect(large.nodes).toBeLessThan(260);
    expect(huge.nodes).toBeLessThan(400);
    // A level more each time the map doubles: some sixty nodes, not four times as many (50 -> 200 km: two levels).
    expect(huge.nodes - large.nodes).toBeLessThan(2 * 70);
    // The plates' patches (and their woods) the same whatever the map past 20 km, under the woods' room.
    expect(large.plates).toBe(huge.plates);
    expect(huge.plates).toBeLessThanOrEqual(WOODS_MOST);
    expect(small.nodes).toBeLessThanOrEqual(121);
  });

  it('covers the map once, nothing past its edge, coarser away from the view', () => {
    const ring = ringOf(50), e = farExtent(ring);
    const nodes = farNodesFor(1000, -3000, ring, QUADS);
    let area = 0;
    for (const n of nodes) {
      area += n.quadsX * n.quadsY * n.step * n.step;
      expect(n.x0 + n.quadsX * n.step).toBeLessThanOrEqual(e + 1e-6);
      expect(n.y0 + n.quadsY * n.step).toBeLessThanOrEqual(e + 1e-6);
      const cx = n.x0 + (n.quadsX * n.step) / 2, cy = n.y0 + (n.quadsY * n.step) / 2;
      // Far from the view, never a plate's patch: the levels go up with the distance.
      if (Math.hypot(cx - 1000, cy + 3000) > 30_000) expect(n.k).toBeGreaterThan(1);
    }
    expect(area).toBeCloseTo((2 * e) ** 2, -3);
    // The rims: on the map's edge only.
    for (const n of nodes) if (n.rim[2]) expect(n.x0).toBeCloseTo(-e, 6);
  });
});
