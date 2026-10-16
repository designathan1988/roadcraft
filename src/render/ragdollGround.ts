/** THE GROUND THE BODIES LAND ON: heights at the corners of a fine grid, kept by tiles while something on them moves */

/** Corners a world unit along each axis (a corner every 0.2 units). */
export const CORNERS_PER_UNIT = 5;
/** Corners along a tile's side. */
const TILE = 64;
/** Tile indices are shifted by this much into the key (`key`): maps up to 2^20 tiles across either way. */
const SHIFT = 1 << 20;

export interface GroundCorners {
  /** Height at world (x, y): between its cell's four corners, as a physics engine's heightfield is between its samples. */
  at(x: number, y: number): number;
  /** Lets go of the tiles nobody read since the last sweep (once a frame): what still moves on the ground keeps its own. */
  sweep(): void;
  /** Every height found forgotten: the ground under them changed. */
  forget(): void;
  /** Tiles held now (tests, probes). */
  readonly tiles: number;
}

interface Tile { readonly heights: Float64Array; read: boolean }

/** DO NOT cap it and clear it whole: a cap thrown away mid-fall is found again corner by corner, every body at once */
export function createGroundCorners(corner: (x: number, y: number) => number): GroundCorners {
  const tiles = new Map<number, Tile>();
  // The last tile read: a body's four corners are nearly always on one.
  let lastKey = NaN;
  let last: Tile | null = null;

  const height = (ix: number, iy: number): number => {
    const tx = Math.floor(ix / TILE), ty = Math.floor(iy / TILE);
    const key = (tx + SHIFT) * 2 * SHIFT + (ty + SHIFT);
    let tile = key === lastKey ? last : tiles.get(key);
    if (!tile) {
      // Unknown corners are NaN; one the ground gives as NaN is asked again, and given as NaN again.
      tile = { heights: new Float64Array(TILE * TILE).fill(NaN), read: true };
      tiles.set(key, tile);
    }
    tile.read = true;
    lastKey = key;
    last = tile;
    const at = (iy - ty * TILE) * TILE + (ix - tx * TILE);
    let h = tile.heights[at]!;
    if (Number.isNaN(h)) {
      h = corner(ix / CORNERS_PER_UNIT, iy / CORNERS_PER_UNIT);
      tile.heights[at] = h;
    }
    return h;
  };

  return {
    at(x, y) {
      const gx = x * CORNERS_PER_UNIT, gy = y * CORNERS_PER_UNIT, ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
      const a = height(ix, iy), b = height(ix + 1, iy), c = height(ix, iy + 1), d = height(ix + 1, iy + 1);
      return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    },
    sweep() {
      for (const [key, tile] of tiles) {
        if (tile.read) tile.read = false;
        else tiles.delete(key);
      }
      lastKey = NaN;
      last = null;
    },
    forget() {
      tiles.clear();
      lastKey = NaN;
      last = null;
    },
    get tiles() { return tiles.size; },
  };
}
