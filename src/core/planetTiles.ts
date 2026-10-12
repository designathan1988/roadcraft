import { FACES, FACE_HALF, PLANET_RADIUS, faceOfDirection, faceToSphereInto, sphereToFaceInto, type FacePoint, type Vec3 } from './cubeSphere';

/**
 * THE PLANET'S MAPS: the sphere cut into small pieces, each a flat x, y map.
 *
 * No flat map covers a sphere without stretching it (Gauss's Theorema
 * Egregium): one map a cube face drew a right angle 28 degrees out near the
 * cube's corners. Surveying meets the same wall and answers it with zones -
 * the 60 zones of UTM, each a flat x, y map nearly true inside it. So does
 * the planet: every face of the cube is cut into `TILES_PER_SIDE` squared
 * pieces (by its equiangular coordinates, `cubeSphere.ts`), and each piece is
 * a flat map in the AZIMUTHAL EQUIDISTANT projection about its own centre
 * (Snyder, "Map Projections - A Working Manual", USGS PP 1395, 1987, pp.
 * 191-202): distances from the centre and the bearings there are exact, and
 * across a piece a right angle stays within a degree and a length within
 * 1.3% (the specs measure it).
 *
 * A piece's map, x east and y north about its centre, goes on past its border
 * (the projection covers all but the far pole of the sphere): what a piece
 * owns may reach over the border and is drawn exactly where it stands.
 *
 * Pure: no three, no randomness, no allocation in the `*Into` calls.
 */

/**
 * Pieces along each side of a cube face: 12, so 864 on the planet, each about
 * 500 m across. A piece's map is a chart of an atlas of OVERLAPPING charts
 * (`world/planet/atlas.ts`): what lies on it and within `TILE_REACH` round it
 * is worked out on it, so its size bounds the map's error on anything it
 * owns - an arc over `d` from its centre is drawn `d/R / sin(d/R)` long
 * across, 0.34% at the farthest corner of a piece with 150 m reach past it
 * (measured 2026-10-10 against 1.8% for the 96 pieces of 4 a side).
 */
export const TILES_PER_SIDE = 12;
/** Pieces on the whole planet. */
export const TILE_COUNT = 6 * TILES_PER_SIDE * TILES_PER_SIDE;

/** A piece's centre (unit, outward), its east and north there (unit, east x north = centre). */
export interface TileFrame {
  readonly face: number;
  readonly i: number;
  readonly j: number;
  readonly centre: Readonly<Vec3>;
  readonly east: Readonly<Vec3>;
  readonly north: Readonly<Vec3>;
}

/** A face's equiangular metres of a piece's middle, along one axis. */
const middle = (k: number): number => -FACE_HALF + ((k + 0.5) * 2 * FACE_HALF) / TILES_PER_SIDE;

const dot = (a: Readonly<Vec3>, b: Readonly<Vec3>): number => a.x * b.x + a.y * b.y + a.z * b.z;

/** Every piece's frame, by id: face * 16 + j * 4 + i. */
export const TILES: readonly TileFrame[] = Object.freeze(Array.from({ length: TILE_COUNT }, (_, id) => {
  const face = Math.floor(id / (TILES_PER_SIDE * TILES_PER_SIDE));
  const k = id % (TILES_PER_SIDE * TILES_PER_SIDE);
  const i = k % TILES_PER_SIDE, j = Math.floor(k / TILES_PER_SIDE);
  const centre = faceToSphereInto(face, middle(i), middle(j), { x: 0, y: 0, z: 0 });
  const fe = FACES[face]!.east;
  const d = dot(fe, centre);
  const ex = fe.x - d * centre.x, ey = fe.y - d * centre.y, ez = fe.z - d * centre.z;
  const l = Math.hypot(ex, ey, ez);
  const east = { x: ex / l, y: ey / l, z: ez / l };
  // north = centre x east, so east x north = centre.
  const north = {
    x: centre.y * east.z - centre.z * east.y,
    y: centre.z * east.x - centre.x * east.z,
    z: centre.x * east.y - centre.y * east.x,
  };
  return Object.freeze({ face, i, j, centre: Object.freeze(centre), east: Object.freeze(east), north: Object.freeze(north) });
}));

const tileFrame = (id: number): TileFrame => TILES[id] as TileFrame;

/** The unit direction of a point of a piece's map (x east, y north about its centre), into `out`. */
export function tileToSphereInto(id: number, x: number, y: number, out: Vec3): Vec3 {
  const t = tileFrame(id);
  const r = Math.hypot(x, y);
  if (r < 1e-9) {
    out.x = t.centre.x; out.y = t.centre.y; out.z = t.centre.z;
    return out;
  }
  // Out along the great circle at bearing (x, y) by the arc r.
  const theta = r / PLANET_RADIUS;
  const c = Math.cos(theta), s = Math.sin(theta) / r;
  out.x = c * t.centre.x + s * (x * t.east.x + y * t.north.x);
  out.y = c * t.centre.y + s * (x * t.east.y + y * t.north.y);
  out.z = c * t.centre.z + s * (x * t.east.z + y * t.north.z);
  return out;
}

/** A sphere direction (need not be unit) on a piece's map, into `out`. */
export function sphereToTileInto(id: number, d: Readonly<Vec3>, out: FacePoint): FacePoint {
  const t = tileFrame(id);
  const along = dot(d, t.centre);
  const e = dot(d, t.east), n = dot(d, t.north);
  const across = Math.hypot(e, n);
  if (across < 1e-15) {
    out.x = 0; out.y = 0;
    return out;
  }
  // The arc from the centre (atan2 holds its precision near the centre and the far pole).
  const k = (Math.atan2(across, along) * PLANET_RADIUS) / across;
  out.x = e * k;
  out.y = n * k;
  return out;
}

const fp: FacePoint = { x: 0, y: 0 };

/** The piece a sphere direction lies on. */
export function tileOfDirection(d: Readonly<Vec3>): number {
  const face = faceOfDirection(d);
  sphereToFaceInto(face, d, fp);
  const step = (2 * FACE_HALF) / TILES_PER_SIDE;
  const i = Math.min(TILES_PER_SIDE - 1, Math.max(0, Math.floor((fp.x + FACE_HALF) / step)));
  const j = Math.min(TILES_PER_SIDE - 1, Math.max(0, Math.floor((fp.y + FACE_HALF) / step)));
  return face * TILES_PER_SIDE * TILES_PER_SIDE + j * TILES_PER_SIDE + i;
}

const probe: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Half the side of the square about a piece's centre that holds all of it on
 * its own map: the widest piece's (those in a face's middle are the widest).
 */
export const TILE_HALF: number = (() => {
  let widest = 0;
  const step = (2 * FACE_HALF) / TILES_PER_SIDE;
  for (let id = 0; id < TILE_COUNT; id++) {
    const t = tileFrame(id);
    // Along the piece's border, on its face's equiangular coordinates.
    for (let k = 0; k <= 32; k++) {
      const a = -FACE_HALF + t.i * step + (k / 32) * step;
      const b = -FACE_HALF + t.j * step + (k / 32) * step;
      for (const [x, y] of [[a, -FACE_HALF + t.j * step], [a, -FACE_HALF + (t.j + 1) * step], [-FACE_HALF + t.i * step, b], [-FACE_HALF + (t.i + 1) * step, b]] as const) {
        faceToSphereInto(t.face, x, y, probe);
        sphereToTileInto(id, probe, fp);
        widest = Math.max(widest, Math.abs(fp.x), Math.abs(fp.y));
      }
    }
  }
  return widest;
})();

/**
 * Half the side of a square about a piece's centre that lies inside EVERY
 * piece on its own map (the narrowest piece's, a little in from its border):
 * a point of a piece's map within it is on that piece, with no trigonometry.
 * Each piece's ground being star-shaped about its centre, a square of half h
 * fits inside when every point of its border lies at least h out along x or y.
 */
export const TILE_INNER: number = (() => {
  let narrowest = Infinity;
  const step = (2 * FACE_HALF) / TILES_PER_SIDE;
  for (let id = 0; id < TILE_COUNT; id++) {
    const t = tileFrame(id);
    for (let k = 0; k <= 32; k++) {
      const a = -FACE_HALF + t.i * step + (k / 32) * step;
      const b = -FACE_HALF + t.j * step + (k / 32) * step;
      for (const [x, y] of [[a, -FACE_HALF + t.j * step], [a, -FACE_HALF + (t.j + 1) * step], [-FACE_HALF + t.i * step, b], [-FACE_HALF + (t.i + 1) * step, b]] as const) {
        faceToSphereInto(t.face, x, y, probe);
        sphereToTileInto(id, probe, fp);
        narrowest = Math.min(narrowest, Math.max(Math.abs(fp.x), Math.abs(fp.y)));
      }
    }
  }
  // Between the samples the border bows by far less than this.
  return narrowest * 0.98;
})();

/** Whether a point of a piece's map lies on that piece (not on a neighbour reached past its border). */
export function onTile(id: number, x: number, y: number): boolean {
  if (Math.abs(x) <= TILE_INNER && Math.abs(y) <= TILE_INNER) return true;
  return tileOfDirection(tileToSphereInto(id, x, y, probe)) === id;
}

/** A point and a direction of one piece's map on another's: the same ground, the same heading on the sphere. */
export interface TileTransfer {
  x: number;
  y: number;
  /** The direction, unit, on the target's map. */
  dx: number;
  dy: number;
}

const a3: Vec3 = { x: 0, y: 0, z: 0 };
const b3: Vec3 = { x: 0, y: 0, z: 0 };
const pA: FacePoint = { x: 0, y: 0 };
const pB: FacePoint = { x: 0, y: 0 };

/** A point of piece `from`'s map, with a heading, on piece `to`'s map, into `out`. */
export function tileTransferInto(from: number, x: number, y: number, dx: number, dy: number, to: number, out: TileTransfer): TileTransfer {
  const l = Math.hypot(dx, dy) || 1;
  const h = 0.05;
  tileToSphereInto(from, x, y, a3);
  tileToSphereInto(from, x + (dx / l) * h, y + (dy / l) * h, b3);
  sphereToTileInto(to, a3, pA);
  sphereToTileInto(to, b3, pB);
  const ex = pB.x - pA.x, ey = pB.y - pA.y;
  const m = Math.hypot(ex, ey) || 1;
  out.x = pA.x;
  out.y = pA.y;
  out.dx = ex / m;
  out.dy = ey / m;
  return out;
}
