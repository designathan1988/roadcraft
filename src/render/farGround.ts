import { PLATE_SIZE, plateOf } from '@world/bounds';

/**
 * THE FAR GROUND AS A QUADTREE BY DISTANCE (CDLOD, Strugar 2009: a quadtree of regular grids, each node drawn while the observer stands
 * past its level's range, the ranges growing with the level): level 0 a plate's patch, each level above a 2 x 2 of the one below drawn with
 * the same grid of quads, twice as coarse. DO NOT keep every plate of the map resident and drawn (25 plates of 10 km, 121 of 20 km, 625 of
 * 50 km): what is resident is what the view's distance asks, a few levels of rings round it, whatever the map's size.
 */

/** A node is split while the view is nearer its box than this many times its side: level 1's (from 2 x 2 plates down to the plates), and above it. DO NOT lower `SPLIT_PLATES` under 2 sqrt 2 (a 10 km map's farthest 2 x 2 from its corner): within it every plate of a 10 km map stays a plate's patch wherever the view stands (the ground seen as before). */
export const SPLIT_PLATES = 3;
export const SPLIT_ABOVE = 2;

/** One node of the far ground chosen for the view: its level, its key, its square (world units; clipped to the map's ring where it passes it), its quads' step and how many of its quads lie on the map each way. */
export interface FarNode {
  readonly key: string;
  readonly k: number;
  readonly x0: number;
  readonly y0: number;
  readonly step: number;
  readonly quadsX: number;
  readonly quadsY: number;
  /** Level 0: the plate it is (`world/bounds.ts` `plateOf`); above: none. */
  readonly plate: number | null;
  /** Its edges (south, north, west, east) on the map ring's edge: no skirt there (the cut side stands there). */
  readonly rim: readonly [boolean, boolean, boolean, boolean];
}

/** The map's plates: `ring` plates each way round the origin's plate (`flatAtlas.ts` FAR_RING), its edge half a plate past the last ones' centres. */
export function farExtent(ring: number): number {
  return (ring + 0.5) * PLATE_SIZE;
}

/**
 * The nodes the far ground draws for a view standing over (x, y), each with `quads` quads a side: from the root (the smallest square of
 * plates holding the map, from its south-west corner) down while the view is nearer than its split. Never more than the levels of the map
 * times a ring of nodes each: the same count for any map the view stands in the middle of.
 */
export function farNodesFor(x: number, y: number, ring: number, quads: number): FarNode[] {
  const extent = farExtent(ring);
  const across = 2 * ring + 1;
  let top = 0;
  while (1 << top < across) top++;
  const out: FarNode[] = [];
  const visit = (k: number, a: number, b: number): void => {
    const side = PLATE_SIZE * (1 << k);
    const x0 = -extent + a * side, y0 = -extent + b * side;
    if (x0 >= extent - 1e-6 || y0 >= extent - 1e-6) return;
    const x1 = Math.min(x0 + side, extent), y1 = Math.min(y0 + side, extent);
    const dx = Math.max(x0 - x, 0, x - x1), dy = Math.max(y0 - y, 0, y - y1);
    if (k > 0 && Math.hypot(dx, dy) < (k === 1 ? SPLIT_PLATES : SPLIT_ABOVE) * side) {
      for (let q = 0; q < 4; q++) visit(k - 1, a * 2 + (q & 1), b * 2 + (q >> 1));
      return;
    }
    const step = side / quads;
    out.push({
      key: `${k}:${a}:${b}`, k, x0, y0, step,
      quadsX: Math.round((x1 - x0) / step), quadsY: Math.round((y1 - y0) / step),
      plate: k === 0 ? plateOf(x0 + side / 2, y0 + side / 2) : null,
      rim: [y0 <= -extent + 1e-6, y1 >= extent - 1e-6, x0 <= -extent + 1e-6, x1 >= extent - 1e-6],
    });
  };
  visit(top, 0, 0);
  return out;
}
