import { m } from './units';
/**
 * THE PLANET'S GEOMETRY: six flat square maps on a cube, drawn as a sphere.
 *
 * Every face is a flat map, the game's own plane: x east, y north, metres from
 * the face's centre, `FACE_HALF` to each border. The sphere is only how the
 * faces are DRAWN, through the EQUIANGULAR cube-sphere chart of Ronchi,
 * Iacono and Paolucci ("The Cubed Sphere", J. Comp. Phys. 124, 1996): a face
 * point's metres become two angles linearly,
 *
 *   xi = (pi/4) * x / FACE_HALF,   eta = (pi/4) * y / FACE_HALF,
 *
 * the cube point is `centre + tan(xi) east + tan(eta) north`, and the sphere
 * point is that, normalised (https://www.redblobgames.com/x/1938-square-tiling-of-sphere/).
 * The angles being linear in the metres, the chart's scale is exactly 1 along
 * a face's two axes when the radius is `4 FACE_HALF / pi` (`PLANET_RADIUS`),
 * and the grid lines of one face carry on smoothly into the next: two faces
 * give a border point the SAME sphere point, and a direction crossing it
 * keeps its heading (the specs measure both).
 *
 * A face's chart also works PAST its border (`|xi|, |eta| < pi/2`), still a
 * true chart of the sphere: what a face owns may reach over its border, a
 * junction's plate, a building, and is drawn exactly where the neighbour's own
 * chart puts that ground, corners included. `transfer` takes a point and a
 * direction from one face's chart to another's.
 *
 * Faces are numbered 0..5, centred on +X, +Y, +Z, -X, -Y, -Z of the planet's
 * frame. Pure: no three, no randomness, no allocation in the `*Into` calls.
 */

/**
 * Half a face's side: 3 km, so the faces are 6 km square (the player,
 * 2026-10-10). Written in metres (`m`): it was 3 000 world units, 1.2 km at
 * 0.4 m a unit, and the planet was 2.5 times too small for its towns - the
 * horizon and the air pressed close round them (docs/ESCALA.md).
 */
export const FACE_HALF = m(3000);

/** The sphere's radius: a face's axes keep their length on it (`4 FACE_HALF / pi`). */
export const PLANET_RADIUS = (4 * FACE_HALF) / Math.PI;

/** How many faces. */
export const FACE_COUNT = 6;

export type FaceId = 0 | 1 | 2 | 3 | 4 | 5;

/** A point on (or over) the sphere, or a direction: the planet's frame. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A face's frame: its centre (outward), east and north, unit, east x north = centre. */
export interface FaceFrame {
  readonly centre: Readonly<Vec3>;
  readonly east: Readonly<Vec3>;
  readonly north: Readonly<Vec3>;
}

const v = (x: number, y: number, z: number): Readonly<Vec3> => Object.freeze({ x, y, z });

/** The six faces' frames, right-handed (east x north = centre, so up is out). */
export const FACES: readonly FaceFrame[] = Object.freeze([
  { centre: v(1, 0, 0), east: v(0, 1, 0), north: v(0, 0, 1) },
  { centre: v(0, 1, 0), east: v(0, 0, 1), north: v(1, 0, 0) },
  { centre: v(0, 0, 1), east: v(1, 0, 0), north: v(0, 1, 0) },
  { centre: v(-1, 0, 0), east: v(0, 0, 1), north: v(0, 1, 0) },
  { centre: v(0, -1, 0), east: v(1, 0, 0), north: v(0, 0, 1) },
  { centre: v(0, 0, -1), east: v(0, 1, 0), north: v(1, 0, 0) },
]);

/** Metres of a face to the chart's angle. */
const ANGLE_PER_METRE = Math.PI / 4 / FACE_HALF;

const frameOf = (face: number): FaceFrame => FACES[face] as FaceFrame;

/**
 * The unit sphere direction of a face point (metres, x east, y north), into
 * `out`. Valid on the face and past it, `|x|, |y| < 2 FACE_HALF`.
 */
export function faceToSphereInto(face: number, x: number, y: number, out: Vec3): Vec3 {
  const f = frameOf(face);
  const a = Math.tan(x * ANGLE_PER_METRE);
  const b = Math.tan(y * ANGLE_PER_METRE);
  const px = f.centre.x + a * f.east.x + b * f.north.x;
  const py = f.centre.y + a * f.east.y + b * f.north.y;
  const pz = f.centre.z + a * f.east.z + b * f.north.z;
  const k = 1 / Math.hypot(px, py, pz);
  out.x = px * k;
  out.y = py * k;
  out.z = pz * k;
  return out;
}

/** A face point at height `h` (metres over the sphere), in the planet's frame: centre at the origin. */
export function facePointInto(face: number, x: number, y: number, h: number, out: Vec3): Vec3 {
  faceToSphereInto(face, x, y, out);
  const r = PLANET_RADIUS + h;
  out.x *= r;
  out.y *= r;
  out.z *= r;
  return out;
}

/** A face point, metres. */
export interface FacePoint {
  x: number;
  y: number;
}

/**
 * A sphere direction (need not be unit) in a face's chart, into `out`; null
 * when the direction is not in front of that face (`s . centre <= 0`), where
 * the chart does not reach.
 */
export function sphereToFaceInto(face: number, s: Readonly<Vec3>, out: FacePoint): FacePoint | null {
  const f = frameOf(face);
  const d = s.x * f.centre.x + s.y * f.centre.y + s.z * f.centre.z;
  if (d <= 1e-12) return null;
  const ta = (s.x * f.east.x + s.y * f.east.y + s.z * f.east.z) / d;
  const tb = (s.x * f.north.x + s.y * f.north.y + s.z * f.north.z) / d;
  out.x = Math.atan(ta) / ANGLE_PER_METRE;
  out.y = Math.atan(tb) / ANGLE_PER_METRE;
  return out;
}

/** The face a sphere direction belongs to: the cube face it crosses (its largest component). */
export function faceOfDirection(s: Readonly<Vec3>): FaceId {
  const ax = Math.abs(s.x), ay = Math.abs(s.y), az = Math.abs(s.z);
  if (ax >= ay && ax >= az) return s.x >= 0 ? 0 : 3;
  if (ay >= az) return s.y >= 0 ? 1 : 4;
  return s.z >= 0 ? 2 : 5;
}

/** A face point with a direction (unit, map axes) and the scale the move put on it. */
export interface Transfer {
  x: number;
  y: number;
  /** The direction, unit, in the target face's axes. */
  dx: number;
  dy: number;
  /** Metres in the target chart per metre in the source chart, along the direction. */
  stretch: number;
}

const tmpS = { x: 0, y: 0, z: 0 };
const tmpT = { x: 0, y: 0, z: 0 };

/**
 * The tangent on the unit sphere of a face's chart moved along (dx, dy)
 * metres, at (x, y): the chart's derivative applied to the direction, into
 * `out` (unit sphere units per metre).
 */
function chartTangentInto(face: number, x: number, y: number, dx: number, dy: number, out: Vec3): Vec3 {
  const f = frameOf(face);
  const a = Math.tan(x * ANGLE_PER_METRE);
  const b = Math.tan(y * ANGLE_PER_METRE);
  const da = (1 + a * a) * ANGLE_PER_METRE * dx;
  const db = (1 + b * b) * ANGLE_PER_METRE * dy;
  const px = f.centre.x + a * f.east.x + b * f.north.x;
  const py = f.centre.y + a * f.east.y + b * f.north.y;
  const pz = f.centre.z + a * f.east.z + b * f.north.z;
  const len = Math.hypot(px, py, pz);
  const sx = px / len, sy = py / len, sz = pz / len;
  // dp, then the part of it across the radius, over |p|.
  const qx = da * f.east.x + db * f.north.x;
  const qy = da * f.east.y + db * f.north.y;
  const qz = da * f.east.z + db * f.north.z;
  const along = qx * sx + qy * sy + qz * sz;
  out.x = (qx - along * sx) / len;
  out.y = (qy - along * sy) / len;
  out.z = (qz - along * sz) / len;
  return out;
}

/**
 * A sphere tangent at unit direction `s` in a face's chart: metres along the
 * face's x and y per unit of the tangent, into `out` (x, y as the deltas).
 */
function tangentToFaceInto(face: number, s: Readonly<Vec3>, t: Readonly<Vec3>, out: FacePoint): FacePoint {
  const f = frameOf(face);
  const d = s.x * f.centre.x + s.y * f.centre.y + s.z * f.centre.z;
  const dd = t.x * f.centre.x + t.y * f.centre.y + t.z * f.centre.z;
  const se = s.x * f.east.x + s.y * f.east.y + s.z * f.east.z;
  const sn = s.x * f.north.x + s.y * f.north.y + s.z * f.north.z;
  const te = t.x * f.east.x + t.y * f.east.y + t.z * f.east.z;
  const tn = t.x * f.north.x + t.y * f.north.y + t.z * f.north.z;
  const a = se / d, b = sn / d;
  // d(a) = (te d - se dd) / d^2; d(xi) = d(a) / (1 + a^2).
  const dA = (te * d - se * dd) / (d * d);
  const dB = (tn * d - sn * dd) / (d * d);
  out.x = dA / (1 + a * a) / ANGLE_PER_METRE;
  out.y = dB / (1 + b * b) / ANGLE_PER_METRE;
  return out;
}

const tmpP = { x: 0, y: 0 };

/**
 * A point and direction of face `from`'s chart in face `to`'s chart, into
 * `out`: the same sphere point, the same heading on the sphere. Null when the
 * point is not in front of `to`.
 */
export function transferInto(from: number, x: number, y: number, dx: number, dy: number, to: number, out: Transfer): Transfer | null {
  faceToSphereInto(from, x, y, tmpS);
  if (!sphereToFaceInto(to, tmpS, tmpP)) return null;
  const l = Math.hypot(dx, dy) || 1;
  chartTangentInto(from, x, y, dx / l, dy / l, tmpT);
  const px = tmpP.x, py = tmpP.y;
  tangentToFaceInto(to, tmpS, tmpT, tmpP);
  const m = Math.hypot(tmpP.x, tmpP.y);
  out.x = px;
  out.y = py;
  out.dx = m > 0 ? tmpP.x / m : 0;
  out.dy = m > 0 ? tmpP.y / m : 0;
  out.stretch = m;
  return out;
}

/**
 * The chart's scale at a face point along a direction: metres on the sphere
 * per metre of the map (1 along the axes through the centre).
 */
export function chartScale(face: number, x: number, y: number, dx: number, dy: number): number {
  const l = Math.hypot(dx, dy) || 1;
  chartTangentInto(face, x, y, dx / l, dy / l, tmpT);
  return Math.hypot(tmpT.x, tmpT.y, tmpT.z) * PLANET_RADIUS;
}

/** The side of a face a neighbour lies on. */
export type Side = 'east' | 'west' | 'north' | 'south';

export const SIDES: readonly Side[] = ['east', 'west', 'north', 'south'];

/** The face across one side of another. */
export function neighbourOf(face: number, side: Side): FaceId {
  const x = side === 'east' ? FACE_HALF * 1.01 : side === 'west' ? -FACE_HALF * 1.01 : 0;
  const y = side === 'north' ? FACE_HALF * 1.01 : side === 'south' ? -FACE_HALF * 1.01 : 0;
  return faceOfDirection(faceToSphereInto(face, x, y, { x: 0, y: 0, z: 0 }));
}

/**
 * The face whose own square holds a point of `face`'s (possibly extended)
 * chart: `face` itself inside its square, else the neighbour (or, past a
 * corner, the one across both sides) the sphere point falls on.
 */
export function homeFaceOf(face: number, x: number, y: number): FaceId {
  if (Math.abs(x) <= FACE_HALF && Math.abs(y) <= FACE_HALF) return face as FaceId;
  return faceOfDirection(faceToSphereInto(face, x, y, tmpS));
}
